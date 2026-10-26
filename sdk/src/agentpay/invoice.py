"""Invoices, the encrypted-memo codec and an x402-style payment challenge.

Wire memo (goes in an Ootle stealth output, encrypted to the merchant only):
    {"Message": "ap1|<invoice_id>|<agent_tag>"}
Ootle memos: Message is UTF-8 up to 253 bytes (docs: Stealth Transfers > Memos).

The challenge is OUR OWN format ("ootle-stealth-v1"), not standard x402: standard x402
clients only understand EVM/Solana settlement. A thin adapter is provided in tools.py.
"""
from __future__ import annotations

import json
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any

from .errors import InvoiceError

MEMO_PREFIX = "ap1"
MAX_MEMO_BYTES = 253
_ID_RE = re.compile(r"^[a-z0-9]{8,32}$")
_TAG_RE = re.compile(r"^[A-Za-z0-9_.-]{0,32}$")
SCHEME = "ootle-stealth-v1"


@dataclass(frozen=True)
class Invoice:
    invoice_id: str
    amount: int              # base units of the coin
    coin: str                # resource address of the stealth coin
    payee: str               # merchant bech32m address
    expires_at: float        # unix seconds
    description: str = ""

    def __post_init__(self) -> None:
        if not _ID_RE.match(self.invoice_id):
            raise InvoiceError("invoice_id must match [a-z0-9]{8,32}")
        if self.amount <= 0:
            raise InvoiceError("amount must be positive")

    def expired(self, now: float | None = None) -> bool:
        return (time.time() if now is None else now) >= self.expires_at


@dataclass(frozen=True)
class ParsedMemo:
    invoice_id: str
    agent_tag: str


def new_invoice_id() -> str:
    return secrets.token_hex(8)      # 16 lowercase hex chars


def encode_memo(invoice_id: str, agent_tag: str = "") -> dict[str, Any]:
    if not _ID_RE.match(invoice_id):
        raise InvoiceError("bad invoice_id")
    if not _TAG_RE.match(agent_tag):
        raise InvoiceError("agent_tag must match [A-Za-z0-9_.-]{0,32}")
    text = f"{MEMO_PREFIX}|{invoice_id}|{agent_tag}"
    if len(text.encode()) > MAX_MEMO_BYTES:
        raise InvoiceError("memo too long")
    return {"Message": text}


def decode_memo(memo: dict[str, Any] | bytes | str | None) -> ParsedMemo | None:
    """Tolerant decoder: returns None for anything that is not one of our memos."""
    if memo is None:
        return None
    if isinstance(memo, (bytes, bytearray)):
        try:
            memo = json.loads(bytes(memo).decode())
        except (ValueError, UnicodeDecodeError):
            return None
    elif isinstance(memo, str):
        try:
            memo = json.loads(memo)
        except ValueError:
            return None
    if not isinstance(memo, dict) or not isinstance(memo.get("Message"), str):
        return None
    parts = memo["Message"].split("|")
    if len(parts) != 3 or parts[0] != MEMO_PREFIX:
        return None
    if not _ID_RE.match(parts[1]) or not _TAG_RE.match(parts[2]):
        return None
    return ParsedMemo(parts[1], parts[2])


def to_challenge(inv: Invoice) -> dict[str, Any]:
    """Body a merchant returns with HTTP 402."""
    return {
        "scheme": SCHEME,
        "invoice_id": inv.invoice_id,
        "amount": inv.amount,
        "coin": inv.coin,
        "payee": inv.payee,
        "expires_at": inv.expires_at,
        "description": inv.description,
        "how_to_pay": "stealth transfer to `payee` with memo Message 'ap1|<invoice_id>|<agent_tag>', "
                      "then retry the request with header X-Ootle-Payment: <tx_id>",
    }


def from_challenge(d: dict[str, Any]) -> Invoice:
    if d.get("scheme") != SCHEME:
        raise InvoiceError(f"unsupported scheme {d.get('scheme')!r}")
    try:
        return Invoice(
            invoice_id=str(d["invoice_id"]), amount=int(d["amount"]), coin=str(d["coin"]),
            payee=str(d["payee"]), expires_at=float(d["expires_at"]),
            description=str(d.get("description", ""))[:200],
        )
    except (KeyError, TypeError, ValueError) as e:
        raise InvoiceError(f"malformed challenge: {e}") from e
