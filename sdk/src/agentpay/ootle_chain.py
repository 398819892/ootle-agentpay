"""Real ChainPort backed by ootle-py.

STATUS: written against ootle-py 0.2.0's public API (verified by reading its source
and README — see docs/00-api-notes.md) but NOT exercised against a live indexer. The
in-memory FakeChain is what the test suite runs against. Before relying on this file:

  1. `pip install ootle-py` and run a LocalNet indexer (see Ootle docs).
  2. Faucet an account and adapt examples/live_smoke_test.py (stub below) to hit it.
  3. Expect to fix field names / method signatures — ootle-py is pre-1.0 and the
     CHANGELOG explicitly says the 0.x API may shift.

Known gaps vs. ChainPort, honestly listed:
  * `is_frozen`: no ootle-py helper returns "is this UTXO frozen" directly. We
    approximate by attempting to fetch the substate and treat certain reject reasons
    as "frozen" -- NOT VERIFIED. You may need a stable-coin-specific indexer query.
  * `payee_can_receive`: for the badge variant this needs a component read-call
    (`get_user_badge` or similar) that isn't in ootle-py's untyped IComponent surface
    by name here -- check the deployed template's actual method name.
"""
from __future__ import annotations

from collections.abc import Sequence

from ootle import (
    AsyncOotleClient, AsyncStealthTransfer, AsyncWalletStealthAuthorizer,
    LocalSigner, Network, OotleSecretKey, OotleWallet, Output, ResourceAddress,
    TransactionRequest,
)

from .chain import ChainPort
from .errors import ChainError
from .models import Identity, OwnedUtxo, ReceivedOutput, StealthOut, TxRef, TxResult


class OotlePyChain:
    def __init__(self, indexer_url: str, network: Network, resource: str):
        self._indexer_url = indexer_url
        self.network = network
        self.resource = ResourceAddress(resource)

    def identity_from_scalars(self, owner_secret: bytes, view_secret: bytes) -> Identity:
        secret = OotleSecretKey(network=self.network, owner_secret=owner_secret, view_secret=view_secret)
        addr = secret.to_address()
        return Identity(addr.bech32m, secret)

    async def send_stealth(
        self, sender: Identity, spend: Sequence[OwnedUtxo], outputs: Sequence[StealthOut], *, fee: int
    ) -> TxResult:
        secret: OotleSecretKey = sender.handle
        wallet = OotleWallet(default=LocalSigner(secret))
        async with AsyncOotleClient.connect(self._indexer_url, wallet=wallet) as client:
            transfer = AsyncStealthTransfer(client, self.resource)
            for u in spend:
                transfer.spend_stealth_input(secret.to_address(), u.commitment)
            for o in outputs:
                transfer.to_stealth_output(
                    Output(destination=_addr(o.destination), amount=o.amount,
                           resource_address=self.resource, memo=o.memo)
                )
            transfer.to_revealed_output(fee)
            transfer.pay_fee_from_revealed(fee)
            try:
                spec = await transfer.prepare()
                authorizer = AsyncWalletStealthAuthorizer(wallet, spec, view_secret=secret.view_secret)
                hydrated = await authorizer.prepare(client)
                auths = await authorizer.create_authorizations(client)
                request = TransactionRequest(transaction=hydrated.unsigned).with_authorizations(auths)
                sealed = client.seal_transaction(request)
                pending = await client.send_transaction(sealed)
                outcome = await pending.watch()   # raises TransactionRejectedError / TimeoutError
            except Exception as e:  # noqa: BLE001 -- surface everything as ChainError at the port boundary
                raise ChainError(str(e)) from e
            if outcome.kind != "commit":
                raise ChainError(f"transaction only partially committed: {outcome.reason}")
            # NOTE: extracting the change UTXO needs the receipt-diff dance shown in
            # ootle-py's examples/stealth/spend_stealth_utxo.py (private _transport
            # access as of 0.2.0 -- a known v1 gap per that file's own docstring).
            return TxResult(TxRef(str(pending.tx_id)), change=None)

    async def read_outputs(self, tx: TxRef, recipient: Identity) -> list[ReceivedOutput]:
        raise NotImplementedError(
            "wire this to AsyncOotleClient.decrypt_owned_utxo over the tx's receipt diff "
            "(see ootle-py examples/stealth/spend_stealth_utxo.py) once you have a live indexer"
        )

    async def is_frozen(self, commitment: bytes) -> bool:
        raise NotImplementedError("verify against a deployed private_stable_coin instance; see module docstring")

    async def payee_can_receive(self, address: str) -> bool:
        raise NotImplementedError("call the deployed coin's user-badge query method; name depends on the template")


def _addr(bech32m: str):
    from ootle import Address
    return Address.parse(bech32m)
