"""In-memory fake chain. Models just enough to test the business logic:
ownership, double-spend, balance conservation, memos, issuer freeze and badge gating.
It does NOT model cryptography or privacy; never use it to reason about privacy.
"""
from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass

from .errors import ChainError
from .models import Identity, OwnedUtxo, ReceivedOutput, StealthOut, TxRef, TxResult


@dataclass
class _Utxo:
    owner: str
    value: int
    spent: bool = False


class FakeChain:
    def __init__(self, *, require_registration: bool = False):
        self.require_registration = require_registration
        self.registered: set[str] = set()
        self._utxos: dict[bytes, _Utxo] = {}
        self._frozen: set[bytes] = set()
        self._tx: dict[str, list[tuple[bytes, str, int, dict | None]]] = {}
        self._n = 0
        self.fees_paid = 0
        self.sent_txs = 0
        self.fail_next = False

    # -- test helpers ---------------------------------------------------------------
    def _commitment(self) -> bytes:
        self._n += 1
        return hashlib.sha256(b"fake-utxo" + self._n.to_bytes(8, "big")).digest()

    def mint(self, to: Identity, value: int) -> OwnedUtxo:
        c = self._commitment()
        self._utxos[c] = _Utxo(to.address, value)
        return OwnedUtxo(c, value)

    def freeze(self, commitment: bytes) -> None:
        self._frozen.add(commitment)

    def register(self, address: str) -> None:
        self.registered.add(address)

    def balance_of(self, address: str) -> int:
        return sum(u.value for u in self._utxos.values() if u.owner == address and not u.spent)

    # -- ChainPort ------------------------------------------------------------------
    def identity_from_scalars(self, owner_secret: bytes, view_secret: bytes) -> Identity:
        addr = "otl_fake_" + hashlib.sha256(owner_secret + view_secret).hexdigest()[:24]
        return Identity(addr, (owner_secret, view_secret))

    async def send_stealth(
        self, sender: Identity, spend: Sequence[OwnedUtxo], outputs: Sequence[StealthOut], *, fee: int
    ) -> TxResult:
        if self.fail_next:
            self.fail_next = False
            raise ChainError("simulated rejection")
        total_in = 0
        for u in spend:
            rec = self._utxos.get(u.commitment)
            if rec is None or rec.owner != sender.address:
                raise ChainError("input not owned by sender")
            if rec.spent:
                raise ChainError("double spend")
            if u.commitment in self._frozen:
                raise ChainError("input frozen by issuer")
            total_in += rec.value
        total_out = sum(o.amount for o in outputs)
        if total_out > total_in:
            raise ChainError("outputs exceed inputs")
        for o in outputs:
            if o.amount <= 0:
                raise ChainError("non-positive output")
            if self.require_registration and o.destination not in self.registered:
                raise ChainError("deposit rejected: destination has no user badge")
        for u in spend:
            self._utxos[u.commitment].spent = True
        self._n += 1
        tx_id = hashlib.sha256(b"tx" + self._n.to_bytes(8, "big")).hexdigest()
        created: list[tuple[bytes, str, int, dict | None]] = []
        for o in outputs:
            c = self._commitment()
            self._utxos[c] = _Utxo(o.destination, o.amount)
            created.append((c, o.destination, o.amount, o.memo))
        change = None
        if total_in > total_out:
            c = self._commitment()
            self._utxos[c] = _Utxo(sender.address, total_in - total_out)
            change = OwnedUtxo(c, total_in - total_out)
            created.append((c, sender.address, total_in - total_out, None))
        self._tx[tx_id] = created
        self.fees_paid += fee
        self.sent_txs += 1
        return TxResult(TxRef(tx_id), change)

    async def read_outputs(self, tx: TxRef, recipient: Identity) -> list[ReceivedOutput]:
        return [
            ReceivedOutput(c, v, m)
            for c, owner, v, m in self._tx.get(tx.tx_id, [])
            if owner == recipient.address
        ]

    async def is_frozen(self, commitment: bytes) -> bool:
        return commitment in self._frozen

    async def payee_can_receive(self, address: str) -> bool:
        return (not self.require_registration) or address in self.registered
