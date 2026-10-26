"""The only interface between business logic and the blockchain.

Two implementations:
  * agentpay.testing.FakeChain      in-memory, used by the tests and the offline demo
  * agentpay.ootle_chain.OotlePyChain   real adapter on top of ootle-py (needs a live indexer)

Keeping this surface tiny is deliberate: when ootle-py changes (it is pre-1.0), only the
adapter changes.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from .models import Identity, OwnedUtxo, ReceivedOutput, StealthOut, TxRef, TxResult


class ChainPort(Protocol):
    def identity_from_scalars(self, owner_secret: bytes, view_secret: bytes) -> Identity:
        """Build an account identity from two 32-byte Ristretto scalars."""

    async def send_stealth(
        self,
        sender: Identity,
        spend: Sequence[OwnedUtxo],
        outputs: Sequence[StealthOut],
        *,
        fee: int,
    ) -> TxResult:
        """Spend ``spend`` (stealth inputs owned by sender), create ``outputs`` plus a change
        output back to the sender, pay ``fee`` (TARI) from the sender's account.
        Raises ChainError if the transaction is rejected. Returns only after commit."""

    async def read_outputs(self, tx: TxRef, recipient: Identity) -> list[ReceivedOutput]:
        """Outputs of a committed tx that ``recipient`` can decrypt (value + memo)."""

    async def is_frozen(self, commitment: bytes) -> bool:
        """True if the issuer froze this UTXO."""

    async def payee_can_receive(self, address: str) -> bool:
        """False if the coin variant would reject deposits to ``address`` (e.g. no user badge)."""
