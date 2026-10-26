"""Spending-policy engine (pure logic, no chain access).

IMPORTANT (honesty): in phase 1 these limits are enforced by this SDK, not by the chain.
The hard, on-chain guarantee is the *funded amount* itself: an agent key can never spend
more than the UTXO it was funded with. Per-tx caps, allowlists and expiry become
on-chain rules only in phase 2 (condition-tree outputs, see docs/03).
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from .models import SessionPolicy

DAY = 86_400.0
HOUR = 3_600.0


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reasons: tuple[str, ...] = ()


class PolicyEngine:
    def __init__(
        self,
        policy: SessionPolicy,
        ledger: list[tuple[float, int]],
        clock: Callable[[], float] = time.time,
    ):
        self.policy = policy
        self.ledger = ledger           # shared, mutated by record()
        self.clock = clock

    def evaluate(self, payee: str, amount: int) -> Decision:
        p, now, why = self.policy, self.clock(), []
        if amount <= 0:
            why.append("amount must be positive")
        if p.expires_at is not None and now >= p.expires_at:
            why.append("session expired")
        if amount > p.per_tx_cap:
            why.append(f"amount {amount} exceeds per-tx cap {p.per_tx_cap}")
        spent = sum(a for _, a in self.ledger)
        if spent + amount > p.session_cap:
            why.append(f"session cap {p.session_cap} would be exceeded (spent {spent})")
        if p.daily_cap is not None:
            day = sum(a for t, a in self.ledger if now - t < DAY)
            if day + amount > p.daily_cap:
                why.append(f"daily cap {p.daily_cap} would be exceeded (last 24h: {day})")
        if p.allowlist is not None and payee not in p.allowlist:
            why.append("payee not in allowlist")
        if p.max_tx_per_hour is not None:
            n = sum(1 for t, _ in self.ledger if now - t < HOUR)
            if n >= p.max_tx_per_hour:
                why.append(f"rate limit {p.max_tx_per_hour} tx/hour reached")
        return Decision(not why, tuple(why))

    def record(self, amount: int) -> None:
        self.ledger.append((self.clock(), amount))

    @property
    def spent(self) -> int:
        return sum(a for _, a in self.ledger)
