"""Deterministic session-key derivation.

The owner keeps ONE master seed. Every agent session gets its own throw-away Ootle
account derived from it, so:
  * a leaked agent key only exposes that session's funded amount;
  * the owner can re-derive the key at any time and sweep the leftovers (kill switch).

Ootle secrets are 32-byte Ristretto scalars, so we reduce 64 hash bytes mod the group
order L to guarantee a canonical scalar. Verified against ootle-py 0.2.0 (see tests).
"""
from __future__ import annotations

import hashlib
import hmac

# Order of the Ristretto255 / Ed25519 prime-order subgroup.
_L = 2**252 + 27742317777372353535851937790883648493
_SALT = b"ootle-agentpay/v1"


def _expand(seed: bytes, info: bytes, n: int = 64) -> bytes:
    prk = hmac.new(_SALT, seed, hashlib.sha256).digest()
    out, t, i = b"", b"", 1
    while len(out) < n:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        out += t
        i += 1
    return out[:n]


def derive_scalar(seed: bytes, path: str) -> bytes:
    if len(seed) < 16:
        raise ValueError("master seed must be at least 16 bytes")
    k = int.from_bytes(_expand(seed, path.encode()), "little") % _L
    if k == 0:  # astronomically unlikely, but never return the zero scalar
        k = 1
    return k.to_bytes(32, "little")


def derive_scalar_pair(seed: bytes, path: str) -> tuple[bytes, bytes]:
    """(owner_secret, view_secret) for the account at ``path``."""
    return derive_scalar(seed, path + "/owner"), derive_scalar(seed, path + "/view")


def session_path(session_id: str) -> str:
    return f"session/{session_id}"
