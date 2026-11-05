"""Thin backend shared by the MCP server and the demo driver.

Wraps the repo's on-chain SDK (`agentpay.onchain.OnChainBudget`) so that:

  * the **owner** side can open a budget and later revoke it (needs the badges), and
  * the **agent** side can *attach* to an already-open budget by address and spend
    through it — without ever holding the owner badge.

Crucially, every agent payment is decided by the chain: `pay_merchant` first asks the
validator (a dry run) whether the pay would be accepted, and only submits it for real
if the validator says yes. A rejection carries the validator's own reason straight back
to the caller, so the agent literally "sees" the limit that stopped it.

Pure glue — no chain logic lives here; it all comes from the SDK. stdlib only.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


def _now_iso() -> str:
    """Local wall-clock time, to the second, when a payment was accepted (the chain's own
    finalize timestamp is not exposed by walletd, so we stamp acceptance here)."""
    return datetime.now().astimezone().isoformat(timespec="seconds")

# Make the repo's SDK (`agentpay.onchain`) importable without a manual PYTHONPATH, however this
# package is launched. We try, in order: an explicit AGENTPAY_SDK_PATH; the repo layout relative
# to this file (works for a source checkout or `pip install -e .`); then fall through to whatever
# is already importable (e.g. the SDK installed as a package). For an *isolated* install
# (pipx / uvx from a copy), set AGENTPAY_SDK_PATH to the repo's `sdk/src`.
def _ensure_sdk_on_path() -> None:
    candidates: list[str] = []
    explicit = os.environ.get("AGENTPAY_SDK_PATH")
    if explicit:
        candidates.append(explicit)
    here = os.path.dirname(os.path.abspath(__file__))
    # integrations/agentpay_mcp/agentpay_mcp -> repo root -> sdk/src
    candidates.append(os.path.join(os.path.abspath(os.path.join(here, "..", "..", "..")), "sdk", "src"))
    for path in candidates:
        if path and os.path.isdir(os.path.join(path, "agentpay")) and path not in sys.path:
            sys.path.insert(0, path)


_ensure_sdk_on_path()

try:
    from agentpay.errors import ChainError, PolicyViolation  # noqa: E402
    from agentpay.onchain import OnChainBudget, WalletdClient  # noqa: E402
except ImportError as exc:  # pragma: no cover - friendly message when the SDK can't be found
    raise ImportError(
        "Could not import the AgentPay SDK (`agentpay.onchain`). Run the server from the repo, "
        "install it editable (`pip install -e integrations/agentpay_mcp`), or set AGENTPAY_SDK_PATH "
        "to the repo's `sdk/src` directory."
    ) from exc

WALLETD_URL = os.environ.get("AGENTPAY_WALLETD_URL", "http://127.0.0.1:12010/json_rpc")
# AGENTPAY_BUDGET_TEMPLATE wins; otherwise the current local-swarm agent_budget from the repo-root
# defaults.json (single source of truth), not a baked-in literal that goes stale after a reset.
from . import _defaults  # noqa: E402

DEFAULT_TEMPLATE = _defaults.template("agent_budget", "AGENTPAY_BUDGET_TEMPLATE")


@dataclass
class PayResult:
    # ok: True = accepted; False = definitively rejected (no funds moved); None = PENDING/UNKNOWN —
    # submitted but the outcome is not yet known (the tx may have landed), so NEVER retry blindly.
    ok: bool | None
    merchant: str
    amount: int
    memo: str = ""
    reason: str | None = None       # the validator's rejection reason, when ok is False
    spent_in_window: int | None = None
    status: str = "accepted"        # "accepted" | "rejected" | "pending"
    tx_id: str | None = None        # set when known, so the agent can call get_payment_status
    # Receipt fields, filled on an accepted pay (best-effort; None if the post-pay chain read failed):
    balance: int | None = None              # the budget's remaining funds (vault balance) after this pay
    remaining_in_window: int | None = None  # how much is still spendable in the current daily window
    paid_at: str | None = None              # local ISO-8601 timestamp of acceptance
    payer: str | None = None                # the paying budget's on-chain component (who paid)


@dataclass
class AgentWallet:
    """The agent's handle on an on-chain budget. Holds only the agent badge — never the
    owner badge — so it can pay but can never raise its own caps or revoke itself."""

    budget: OnChainBudget
    # The policy the owner declared, kept for display only. The real, binding copy of these
    # numbers lives in the on-chain component; this is what we *show* the agent.
    per_tx_cap: int = 0
    daily_cap: int = 0
    whitelist: list[str] = field(default_factory=list)

    @property
    def component(self) -> str:
        return self.budget.component or ""

    def pay_merchant(self, merchant: str, amount: int, memo: str = "") -> PayResult:
        """Attempt an on-chain payment. The validator decides: we dry-run first, and only
        submit for real if the validator accepts. Either way the outcome is the chain's."""
        try:
            amount = int(amount)
        except (TypeError, ValueError):
            return PayResult(False, merchant, 0, memo, reason=f"amount {amount!r} is not an integer",
                             status="rejected")

        # Ask the validator up front. This is a real dry run against the running network.
        try:
            reason = self.budget.would_reject(merchant, amount, memo=memo or "pay")
        except ChainError as e:
            if getattr(e, "transient", False):
                # The preflight dry run could not reach a verdict (indexer/transport hiccup). That is
                # NOT a rejection — the validator never ruled. Skip the preflight and let the REAL
                # submit be the authority: its own transient handling returns `pending` (reconcile by
                # tx id), never a phantom "rejected_by validator". (#3)
                reason = None
            else:
                raise  # a definitive non-reject failure (e.g. auth) — surface it as before
        if reason is not None:
            # A dry-run rejection by the validator: ok=False AND status="rejected". Without the explicit
            # status it would default to "accepted" (PayResult.status), so the MCP tool — which reports
            # `status` — would label a validator-rejected payment "accepted" (N-4).
            return PayResult(False, merchant, amount, memo, reason=reason, status="rejected")

        try:
            res = self.budget.pay(merchant, amount, memo=memo)
        except PolicyViolation as e:
            # A client-side policy precheck refused this BEFORE any submit (e.g. a stale daily-window
            # mirror after the window rolled). No funds moved and it is NOT a chain fault — report it as
            # a definitive rejection with the broken rule, not an "error_type: chain_error". (review)
            return PayResult(False, merchant, amount, memo, reason=str(e), status="rejected")
        except ChainError as e:                      # race: chain state changed between dry-run and submit
            if getattr(e, "pending", False):
                # Submitted, but the on-chain outcome is UNKNOWN (transport blip / timeout). The tx may
                # have landed. Return the THIRD state — never ok=False — so the agent does not blindly
                # re-pay (which would pay the merchant twice). Resolve it with get_payment_status. (D-1)
                return PayResult(None, merchant, amount, memo, reason=str(e),
                                 status="pending", tx_id=getattr(e, "tx_id", None))
            # A definitive failure: a finalized chain Reject, or a pre-submit error — either way no
            # funds moved, so it is safe to report as rejected.
            return PayResult(False, merchant, amount, memo, reason=str(e), status="rejected")
        events = OnChainBudget.pay_events(res)
        spent_in_window = None
        if events:
            spent_in_window = int(events[0].get("spent_in_window", self.budget.spent))
        # Build the receipt figures from the chain AFTER the pay: the vault's remaining balance and
        # how much is left in the current window. Best-effort — the pay already succeeded, so a failed
        # follow-up read must not turn a good payment into an error; those fields just come back None.
        balance = remaining_in_window = None
        try:
            chain = self.budget.read_onchain_state()
            bal = chain.get("balance")
            if isinstance(bal, int) and not isinstance(bal, bool):
                balance = bal
            daily = chain.get("daily_cap")
            spent = chain.get("spent_in_window")
            if isinstance(daily, int) and isinstance(spent, int):
                remaining_in_window = max(daily - spent, 0)
                if spent_in_window is None:
                    spent_in_window = spent
        except Exception:  # noqa: BLE001 — receipt is best-effort; never fail an accepted pay
            pass
        return PayResult(True, merchant, amount, memo, spent_in_window=spent_in_window, status="accepted",
                         balance=balance, remaining_in_window=remaining_in_window, paid_at=_now_iso(),
                         payer=self.component or None)

    def status(self) -> dict[str, Any]:
        """What the agent is allowed to know about its own budget.

        `spent_in_window` and the caps are read AUTHORITATIVELY from the on-chain component state —
        the chain's own running total, which reflects spends by EVERY session of this budget, not
        just this process. If that read fails (walletd unreachable, or an unexpected component
        layout), the spend figures are reported as `unknown` (``spent_source="unknown"``,
        ``spent_in_window=None``) rather than falling back to this process's local estimate: a stale
        cache must never masquerade as a live balance (#16). `revoked` is confirmed against the chain
        both ways — the component flag and a dry-run kill-switch probe."""
        out: dict[str, Any] = {
            "component": self.component,
            "enforced_by": "Tari Ootle validator (AgentBudget on-chain template)",
        }
        try:
            chain = self.budget.read_onchain_state()
        except Exception as e:  # noqa: BLE001 — any failure means we cannot vouch for the numbers
            # Never present a display copy as live state: report the whitelist AND spend as unknown,
            # not the client-configured whitelist (which is usually empty and would read as "no
            # merchants"). A stale/config value must never masquerade as a chain read. (#16)
            out.update({
                "whitelist": None,
                "whitelist_source": "unknown",
                "spent_source": "unknown",
                "spent_in_window": None,
                "remaining_in_window": None,
                "per_tx_cap": self.per_tx_cap,   # the owner-declared policy, for display only
                "daily_cap": self.daily_cap,
                "caps_source": "declared",
                "revoked": False,
                "note": (f"on-chain budget state unavailable ({type(e).__name__}); whitelist and "
                         "spend figures are unknown, not estimated"),
            })
            return out
        whitelist = list(chain["whitelist"])
        spent = chain["spent_in_window"]
        daily = chain["daily_cap"]
        # Kill-switch probe: a revoked budget refuses even a 1-unit dry run with a "revoked" reason.
        # Probe a genuinely on-chain-whitelisted merchant; the component flag is authoritative, the
        # probe is a second confirmation. A transient/transport failure leaves `revoked` as the flag
        # says — an inconclusive probe must never be read as "not revoked" nor crash status(). (#3)
        revoked = bool(chain["revoked"])
        if whitelist and not revoked:
            try:
                probe_reason = self.budget.would_reject(whitelist[0], 1, memo="status-probe")
            except ChainError:
                probe_reason = None
            if probe_reason and "revok" in probe_reason.lower():
                revoked = True
        out.update({
            "whitelist": whitelist,
            "whitelist_source": "chain",
            "spent_source": "chain",
            "spent_in_window": spent,
            "remaining_in_window": max(daily - spent, 0),
            "per_tx_cap": chain["per_tx_cap"],
            "daily_cap": daily,
            "caps_source": "chain",
            "window_start_epoch": chain["window_start_epoch"],
            "epochs_per_window": chain["epochs_per_window"],
            "revoked": revoked,
        })
        return out

    def payment_status(self, tx_id: str) -> dict[str, Any]:
        """Resolve a previously-submitted payment by its tx id — the read-only follow-up to a PENDING
        pay_merchant result, so the agent can learn the outcome instead of retrying (and risk
        double-paying). Returns ``{"status": "accepted"|"rejected"|"pending", "reason": ...}``. (D-1)"""
        kind, reason = self.budget.client.get_result(tx_id)
        status = {"accept": "accepted", "reject": "rejected", "pending": "pending"}[kind]
        return {"status": status, "tx_id": tx_id, "reason": reason}

    def list_merchants(self) -> list[str]:
        """The merchants the chain will actually accept a pay to: the component's on-chain whitelist,
        read live. This is NOT the client-configured `whitelist` (display-only, usually empty) — the
        validator enforces the on-chain list at pay time, so a merchant returned here is payable now.
        Raises ChainError/Exception if the component state can't be read (the caller surfaces it)."""
        return list(self.budget.read_onchain_state()["whitelist"])


def connect(url: str = WALLETD_URL) -> WalletdClient:
    return WalletdClient(url).connect()


def ensure_account(client: WalletdClient, name: str) -> str:
    """Return a swarm account address, creating + funding it on first use."""
    try:
        return client.account_address(name)
    except ChainError:
        addr = client.create_account(name)
        client.fund(name)
        return addr


def open_budget(
    client: WalletdClient,
    owner_account: str,
    *,
    fund: int,
    per_tx_cap: int,
    daily_cap: int,
    whitelist: list[str],
    epochs_per_window: int = 10,
    template: str = DEFAULT_TEMPLATE,
) -> OnChainBudget:
    """Owner action: instantiate a fresh on-chain budget. Returns the opened OnChainBudget
    (which holds both badges). Keep this on the owner side only."""
    return OnChainBudget(client, template, owner_account).open(
        fund=fund, per_tx_cap=per_tx_cap, daily_cap=daily_cap,
        epochs_per_window=epochs_per_window, whitelist=whitelist,
    )


def attach_wallet(
    client: WalletdClient,
    *,
    component: str,
    agent_badge: str | None = None,
    agent_account: str,
    per_tx_cap: int,
    daily_cap: int,
    whitelist: list[str],
    template: str = DEFAULT_TEMPLATE,
) -> AgentWallet:
    """Agent action: attach to an existing on-chain budget using only the agent badge.

    The per_tx_cap / daily_cap / whitelist passed here are for *display*; the binding copy
    is on chain. Note we do NOT pass the owner badge — the agent cannot revoke or withdraw.

    ``agent_badge`` is optional: when omitted it is DERIVED from the component's on-chain state
    (the struct lays its two badge resources out as owner_badge, agent_badge), so an operator need
    only supply the component address — not copy a second 64-hex resource by hand.
    """
    budget = OnChainBudget(
        client, template, owner_account=agent_account, agent_account=agent_account,
        component=component, agent_badge=agent_badge,
        per_tx_cap=per_tx_cap, daily_cap=daily_cap, whitelist=list(whitelist),
    )
    if not agent_badge:
        # Read [owner_badge, agent_badge] authoritatively from the component; take the agent one.
        _owner_badge, budget.agent_badge = budget._read_badges()
    return AgentWallet(budget, per_tx_cap=per_tx_cap, daily_cap=daily_cap, whitelist=list(whitelist))


def provision_wallet(
    client: WalletdClient,
    owner_account: str,
    *,
    fund: int,
    per_tx_cap: int,
    daily_cap: int,
    whitelist: list[str],
    epochs_per_window: int = 10,
    template: str = DEFAULT_TEMPLATE,
) -> AgentWallet:
    """Convenience for the zero-config path: the owner opens a fresh on-chain budget and we
    return an :class:`AgentWallet` over it. On devnet the owner account also holds the agent
    badge, so the wallet can pay; the owner powers (revoke/withdraw) are simply not exposed as
    MCP tools. For a production split, open the budget out of band and use :func:`attach_wallet`.
    """
    budget = open_budget(
        client, owner_account, fund=fund, per_tx_cap=per_tx_cap, daily_cap=daily_cap,
        whitelist=list(whitelist), epochs_per_window=epochs_per_window, template=template,
    )
    return AgentWallet(budget, per_tx_cap=per_tx_cap, daily_cap=daily_cap, whitelist=list(whitelist))
