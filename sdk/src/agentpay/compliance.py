"""Compliance guard: fail early, with a readable error, instead of a rejected tx.

The official private stablecoin lets the issuer freeze UTXOs, recall funds and (in the
`issuer` variant) reject deposits to accounts without a user badge. A payment SDK that
ignores this produces confusing chain errors and, worse, wrongly implies the user fully
controls the funds. This guard makes issuer powers visible.
"""
from __future__ import annotations

from .chain import ChainPort
from .errors import FrozenUtxo, PayeeNotRegistered
from .models import OwnedUtxo


class ComplianceGuard:
    def __init__(self, chain: ChainPort):
        self.chain = chain

    async def check_spend(self, utxo: OwnedUtxo, payee: str) -> None:
        if await self.chain.is_frozen(utxo.commitment):
            raise FrozenUtxo(
                "the issuer froze this session's funds; contact the issuer, the owner can not sweep either"
            )
        if not await self.chain.payee_can_receive(payee):
            raise PayeeNotRegistered(f"payee {payee[:18]}... cannot receive this coin (holder registration required)")
