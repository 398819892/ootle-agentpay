"""A real Model Context Protocol (MCP) server exposing an AI agent's on-chain wallet.

Run it as a stdio MCP server (what an MCP client such as Claude Desktop, or this repo's
`demo_agent.py`, launches):

    python -m agentpay_mcp.server

It attaches to an already-open AgentBudget component (the owner opens it; see the demo)
using these environment variables:

    AGENTPAY_WALLETD_URL     wallet daemon JSON-RPC    (default http://127.0.0.1:12010/json_rpc)
    AGENTPAY_BUDGET_TEMPLATE AgentBudget template address
    AGENTPAY_COMPONENT       the open budget component address      (required)
    AGENTPAY_AGENT_BADGE     the agent badge resource address       (required)
    AGENTPAY_AGENT_ACCOUNT   the agent's account component address   (required)
    AGENTPAY_PER_TX_CAP      declared per-transaction cap (display)
    AGENTPAY_DAILY_CAP       declared rolling daily cap   (display)
    AGENTPAY_WHITELIST       comma-separated merchant addresses (display + list_merchants)

The three tools below are the agent's *entire* surface. Every payment is adjudicated by
the chain; a blocked payment returns the validator's own reason so the agent can react.
"""
from __future__ import annotations

import os
import sys

from . import backend

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:  # pragma: no cover - friendly message when deps are missing
    sys.stderr.write(
        "The 'mcp' package is not installed. Create the venv and install deps:\n"
        "  python -m venv integrations/agentpay_mcp/.venv\n"
        "  integrations/agentpay_mcp/.venv/Scripts/pip install -r integrations/agentpay_mcp/requirements.txt\n"
    )
    raise


def _build_wallet() -> backend.AgentWallet:
    component = os.environ.get("AGENTPAY_COMPONENT")
    agent_badge = os.environ.get("AGENTPAY_AGENT_BADGE")
    agent_account = os.environ.get("AGENTPAY_AGENT_ACCOUNT")
    missing = [n for n, v in [
        ("AGENTPAY_COMPONENT", component),
        ("AGENTPAY_AGENT_BADGE", agent_badge),
        ("AGENTPAY_AGENT_ACCOUNT", agent_account),
    ] if not v]
    if missing:
        raise SystemExit(f"missing required env var(s): {', '.join(missing)}")

    whitelist = [m for m in os.environ.get("AGENTPAY_WHITELIST", "").split(",") if m.strip()]
    client = backend.connect(os.environ.get("AGENTPAY_WALLETD_URL", backend.WALLETD_URL))
    return backend.attach_wallet(
        client,
        component=component,
        agent_badge=agent_badge,
        agent_account=agent_account,
        per_tx_cap=int(os.environ.get("AGENTPAY_PER_TX_CAP", "0")),
        daily_cap=int(os.environ.get("AGENTPAY_DAILY_CAP", "0")),
        whitelist=whitelist,
        template=os.environ.get("AGENTPAY_BUDGET_TEMPLATE", backend.DEFAULT_TEMPLATE),
    )


mcp = FastMCP("agentpay")
_wallet: backend.AgentWallet | None = None


def wallet() -> backend.AgentWallet:
    global _wallet
    if _wallet is None:
        _wallet = _build_wallet()
    return _wallet


@mcp.tool()
def pay_merchant(merchant: str, amount: int, memo: str = "") -> dict:
    """Pay a merchant from the agent's on-chain budget.

    The payment is adjudicated by the Tari Ootle validator against the budget's on-chain
    rules (per-transaction cap, daily cap, merchant whitelist, revocation). If the chain
    rejects it, the returned object has ``ok=false`` and ``reason`` set to the validator's
    explanation — the agent cannot override this.

    Args:
        merchant: the merchant's account component address (see list_merchants).
        amount:   amount to pay, in XTR (integer).
        memo:     optional note / invoice reference carried on chain with the payment.
    """
    r = wallet().pay_merchant(merchant, amount, memo)
    out = {"ok": r.ok, "merchant": r.merchant, "amount": r.amount, "memo": r.memo}
    if r.ok:
        out["spent_in_window"] = r.spent_in_window
    else:
        out["reason"] = r.reason
        out["rejected_by"] = "Tari Ootle validator (on-chain budget rule)"
    return out


@mcp.tool()
def get_budget_status() -> dict:
    """Report the agent's remaining budget and the rules it must stay within.

    The caps and whitelist are the owner's declared policy; the binding copy is enforced
    on chain. ``spent_in_window`` and ``revoked`` are confirmed against the live chain.
    """
    return wallet().status()


@mcp.tool()
def list_merchants() -> list[str]:
    """List the merchant addresses the agent is allowed to pay (the on-chain whitelist)."""
    return wallet().list_merchants()


def main() -> None:
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
