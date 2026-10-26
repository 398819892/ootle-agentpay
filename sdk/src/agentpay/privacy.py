"""Privacy linter: an honest, per-payment statement of what still leaks.

Rationale: an existing Ootle project (ootle-pay) dropped its anonymity claim after
finding the caller's public key is readable straight off the transaction. Privacy
products lose trust the moment they overstate. This module makes "no false privacy
claims" a product feature: every payment/session can produce a report.

Facts used here come from the official Ootle docs (Privacy in Applications, Stealth
Transfers) and the tari-project/stable-coin README. Re-verify when those change.
"""
from __future__ import annotations

from dataclasses import dataclass, field

VARIANTS = ("no_badge", "badge", "custom")


@dataclass(frozen=True)
class Leak:
    severity: str          # "high" | "medium" | "low" | "floor"
    what: str
    mitigation: str


@dataclass
class PrivacyReport:
    leaks: list[Leak] = field(default_factory=list)

    def worst(self) -> str:
        order = ["floor", "low", "medium", "high"]
        return max((l.severity for l in self.leaks), key=order.index, default="low")

    def render(self) -> str:
        return "\n".join(f"[{l.severity.upper():6}] {l.what}\n         -> {l.mitigation}" for l in self.leaks)


def assess(
    *,
    coin_variant: str = "no_badge",
    fee_from_session_account: bool = True,
    fee_reserve_funded_publicly: bool = True,
    outputs_in_tx: int = 2,
    is_mint_or_redeem: bool = False,
    issuer_holds_view_key: bool = True,
) -> PrivacyReport:
    if coin_variant not in VARIANTS:
        raise ValueError(f"coin_variant must be one of {VARIANTS}")
    r = PrivacyReport()
    add = lambda s, w, m: r.leaks.append(Leak(s, w, m))  # noqa: E731

    add("floor", "Transaction fees are public amounts.", "Cannot be avoided; use unique, non-round fee amounts.")
    if fee_from_session_account:
        add("medium", "The session account signs and pays the fee, so the tx is linked to that throw-away account.",
            "Use a fresh session key per session (default) and never reuse it across counterparties.")
    if fee_reserve_funded_publicly:
        add("high", "Funding the session account's TARI fee reserve with a public transfer links owner -> session account.",
            "Roadmap: relayer-sponsored fees (spike S5). Until then, fund the reserve from a separate account and expect it to be linkable.")
    if outputs_in_tx >= 3:
        add("medium", f"One tx creating {outputs_in_tx} outputs reveals a batch (headcount and timing).",
            "Use payout.plan_batch to split batches and jitter their timing.")
    if is_mint_or_redeem:
        add("high", "Mint / redeem amounts are revealed at the issuer boundary when supply is tracked.",
            "Batch deposits into round-robin sizes; expect correlation by amount and time.")
    if coin_variant == "badge":
        add("high", "Badge variant: holders are publicly enumerable and deposits reveal the receiving account.",
            "Amounts stay hidden but participation and counterparties do not. Prefer the no-badge variant if privacy matters.")
    if issuer_holds_view_key:
        add("low", "The issuer holds the resource view key: confidentiality is from the public, not from the issuer.",
            "Disclose this to users. The issuer can also freeze/recall (README of stable-coin).")
    add("low", "Timing and same-magnitude correlation between revealed and private steps.",
        "Insert random delays between funding and spending; avoid round amounts.")
    return r
