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
from typing import Any

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
    from agentpay.errors import ChainError  # noqa: E402
    from agentpay.onchain import OnChainBudget, WalletdClient  # noqa: E402
except ImportError as exc:  # pragma: no cover - friendly message when the SDK can't be found
    raise ImportError(
        "Could not import the AgentPay SDK (`agentpay.onchain`). Run the server from the repo, "
        "install it editable (`pip install -e integrations/agentpay_mcp`), or set AGENTPAY_SDK_PATH "
        "to the repo's `sdk/src` directory."
    ) from exc

WALLETD_URL = os.environ.get("AGENTPAY_WALLETD_URL", "http://127.0.0.1:12010/json_rpc")
DEFAULT_TEMPLATE = os.environ.get(
    "AGENTPAY_BUDGET_TEMPLATE",
    "template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97",
)


@dataclass
class PayResult:
    ok: bool
    merchant: str
    amount: int
    memo: str = ""
    reason: str | None = None       # the validator's rejection reason, when ok is False
    spent_in_window: int | None = None


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
            return PayResult(False, merchant, 0, memo, reason=f"amount {amount!r} is not an integer")

        # Ask the validator up front. This is a real dry run against the running network.
        reason = self.budget.would_reject(merchant, amount, memo=memo or "pay")
        if reason is not None:
            return PayResult(False, merchant, amount, memo, reason=reason)

        try:
            res = self.budget.pay(merchant, amount, memo=memo)
        except ChainError as e:                      # race: chain state changed between dry-run and submit
            return PayResult(False, merchant, amount, memo, reason=str(e))
        events = OnChainBudget.pay_events(res)
        spent_in_window = None
        if events:
            spent_in_window = int(events[0].get("spent_in_window", self.budget.spent))
        return PayResult(True, merchant, amount, memo, spent_in_window=spent_in_window)

    def status(self) -> dict[str, Any]:
        """What the agent is allowed to know about its own budget.

        `revoked` IS confirmed against the chain here (a dry-run probe). `spent_in_window` is the
        last figure this process saw — it is set from the chain's `pay` event on each payment, but it
        resets on restart and does not reflect spends by OTHER sessions of the same budget, so treat it
        as a local estimate, not an authoritative chain read. (A live read would call the template's
        `get_info` via dry-run and decode a typed result; tracked with #16 in docs/audit-notes.md.)"""
        spent = self.budget.spent
        remaining_daily = max(self.daily_cap - spent, 0)
        # A tiny whitelisted probe tells us whether the kill switch has been pulled on chain.
        revoked = False
        probe_reason = None
        if self.whitelist:
            probe_reason = self.budget.would_reject(self.whitelist[0], 1, memo="status-probe")
            if probe_reason and "revok" in probe_reason.lower():
                revoked = True
        return {
            "component": self.component,
            "per_tx_cap": self.per_tx_cap,
            "daily_cap": self.daily_cap,
            "spent_in_window": spent,
            "remaining_in_window": remaining_daily,
            "whitelist": list(self.whitelist),
            "revoked": revoked,
            "enforced_by": "Tari Ootle validator (AgentBudget on-chain template)",
        }

    def list_merchants(self) -> list[str]:
        return list(self.whitelist)


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
    agent_badge: str,
    agent_account: str,
    per_tx_cap: int,
    daily_cap: int,
    whitelist: list[str],
    template: str = DEFAULT_TEMPLATE,
) -> AgentWallet:
    """Agent action: attach to an existing on-chain budget using only the agent badge.

    The per_tx_cap / daily_cap / whitelist passed here are for *display*; the binding copy
    is on chain. Note we do NOT pass the owner badge — the agent cannot revoke or withdraw.
    """
    budget = OnChainBudget(
        client, template, owner_account=agent_account, agent_account=agent_account,
        component=component, agent_badge=agent_badge,
        per_tx_cap=per_tx_cap, daily_cap=daily_cap, whitelist=list(whitelist),
    )
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
