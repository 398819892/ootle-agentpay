"""Batch payout planning.

Pure function: takes payouts, returns a list of transactions with randomised grouping
and delays. Reason (Ootle docs, Privacy Gotchas): a tx's inputs/outputs are public, so one
tx with N outputs reveals headcount and pay date. We therefore split the batch into
several transactions of random size and spread them in time.

Every executed tx also gets a change output back to the sender (added by the chain
adapter), so a "3 payouts" tx shows 4 outputs on chain.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

from .models import StealthOut


@dataclass(frozen=True)
class PlannedTx:
    outputs: tuple[StealthOut, ...]
    delay_s: float           # seconds after batch start


def plan_batch(
    payouts: list[StealthOut],
    *,
    max_outputs_per_tx: int = 3,
    max_delay_s: float = 6 * 3600,
    rng: random.Random | None = None,
) -> list[PlannedTx]:
    if not payouts:
        return []
    if max_outputs_per_tx < 1:
        raise ValueError("max_outputs_per_tx must be >= 1")
    r = rng or random.SystemRandom()
    items = list(payouts)
    r.shuffle(items)

    groups: list[list[StealthOut]] = []
    i = 0
    while i < len(items):
        size = r.randint(1, max_outputs_per_tx)
        groups.append(items[i:i + size])
        i += size
    # Never let one tx carry the whole batch when we could have split it.
    if len(groups) == 1 and len(items) > 1 and max_outputs_per_tx > 1:
        half = len(items) // 2
        groups = [items[:half], items[half:]]

    delays = sorted(r.uniform(0, max_delay_s) for _ in groups)
    return [PlannedTx(tuple(g), d) for g, d in zip(groups, delays)]


def jitter_fee(base: int, *, spread: float = 0.2, rng: random.Random | None = None) -> int:
    """Non-round fee within +/- spread of base (avoids fingerprinting round fee amounts)."""
    r = rng or random.SystemRandom()
    lo, hi = int(base * (1 - spread)), int(base * (1 + spread))
    return max(1, r.randint(lo, max(lo, hi)))
