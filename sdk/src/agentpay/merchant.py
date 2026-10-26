"""Merchant side: verify a claimed payment against an invoice.

The merchant already knows its own view secret, so it can decrypt any stealth output
addressed to it (this is normal Ootle recipient scanning, not a special power). We match
the decrypted memo's invoice_id, and check amount + expiry ourselves rather than trusting
the payer's claim.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

from .chain import ChainPort
from .errors import VerificationFailed
from .invoice import Invoice, decode_memo
from .models import Identity, TxRef


@dataclass(frozen=True)
class VerifiedPayment:
    tx_id: str
    invoice_id: str
    amount: int
    agent_tag: str


class Merchant:
    def __init__(self, chain: ChainPort, identity: Identity):
        self.chain = chain
        self.identity = identity
        self._seen: set[str] = set()          # invoice_ids already paid (replay guard)

    async def verify(self, tx_id: str, invoice: Invoice, *, now: float | None = None) -> VerifiedPayment:
        if invoice.invoice_id in self._seen:
            raise VerificationFailed("invoice already paid (replay)")
        if invoice.expired(now):
            raise VerificationFailed("invoice expired")
        outs = await self.chain.read_outputs(TxRef(tx_id), self.identity)
        for o in outs:
            parsed = decode_memo(o.memo)
            if parsed is None or parsed.invoice_id != invoice.invoice_id:
                continue
            if o.value != invoice.amount:
                raise VerificationFailed(f"amount mismatch: invoice {invoice.amount}, paid {o.value}")
            self._seen.add(invoice.invoice_id)
            return VerifiedPayment(tx_id, invoice.invoice_id, o.value, parsed.agent_tag)
        raise VerificationFailed("no output in this tx matches the invoice")
