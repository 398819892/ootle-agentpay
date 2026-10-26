"""Deliver-then-pay escrow via hash-lock, phase-1 approximation.

Real design (needs on-chain condition-tree outputs, not yet in ootle-py v1, see docs/03):
  buyer locks funds under HashLock(H) OR BeforeEpoch(t)->refund-to-buyer
  worker reveals preimage k to claim => buyer learns k => decrypts the result

Phase-1 approximation implemented here (works today, weaker guarantee):
  buyer sends payment directly to worker with memo carrying H = sha256(k)
  worker, upon seeing the payment output, reveals k out-of-band (e.g. HTTP response)
  buyer decrypts the result with k

This is NOT trustless yet: the worker could take payment and withhold k. It is still
useful (ties payment to a specific delivery commitment and gives a paper trail) and is
offered as a stepping stone. Do not market it as atomic/trustless until the on-chain
version ships.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

from .errors import InvoiceError, VerificationFailed
from .invoice import Invoice
from .models import ReceivedOutput


def new_preimage() -> bytes:
    return os.urandom(32)


def commitment_of(preimage: bytes) -> str:
    return hashlib.sha256(preimage).hexdigest()


@dataclass(frozen=True)
class DeliveryMemo:
    invoice_id: str
    hash_commitment: str      # hex sha256 of the worker's result-decryption key


def encode_delivery_memo(invoice_id: str, hash_commitment: str) -> dict:
    if len(hash_commitment) != 64:
        raise InvoiceError("hash_commitment must be a 64-char hex sha256 digest")
    return {"Message": f"ap1d|{invoice_id}|{hash_commitment}"}


def decode_delivery_memo(memo: dict | None) -> DeliveryMemo | None:
    if not isinstance(memo, dict) or not isinstance(memo.get("Message"), str):
        return None
    parts = memo["Message"].split("|")
    if len(parts) != 3 or parts[0] != "ap1d":
        return None
    return DeliveryMemo(parts[1], parts[2])


def verify_delivery(output: ReceivedOutput, invoice: Invoice, preimage: bytes) -> None:
    """Buyer side: check the paid output really commits to the key the worker gave us."""
    dm = decode_delivery_memo(output.memo)
    if dm is None or dm.invoice_id != invoice.invoice_id:
        raise VerificationFailed("output has no matching delivery memo")
    if dm.hash_commitment != commitment_of(preimage):
        raise VerificationFailed("preimage does not match the commitment worker published on-chain")
