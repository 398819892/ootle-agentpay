"""A real Model Context Protocol (MCP) server exposing an AI agent's on-chain wallet.

Run it as a stdio MCP server — this is what an MCP client (Claude Desktop, Cursor, or this
repo's ``demo_agent.py``) launches:

    agentpay-mcp                 # installed console script
    python -m agentpay_mcp.server

Configuration comes from environment variables (what the client passes under ``"env"``) with
optional CLI flags; see ``agentpay_mcp.config`` for the full list. With nothing but a running
wallet daemon it defaults to the **local swarm** and opens a fresh budget on first use
(provision mode). Point it at an already-open budget with ``AGENTPAY_COMPONENT`` to run in
attach mode, or at the public testnet with ``AGENTPAY_NETWORK=esmeralda``.

The three tools below are the agent's *entire* spending surface. Every payment is adjudicated
by the Tari Ootle validator; a blocked payment returns the validator's own reason so the agent
can react. Infrastructure problems (walletd down, bad config) come back as structured,
agent-friendly error objects rather than raw exceptions / a crashed server.
"""
from __future__ import annotations

import json
import sys

from . import backend, config

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:  # pragma: no cover - friendly message when deps are missing
    sys.stderr.write(
        "The 'mcp' package is not installed. Install this server, e.g.:\n"
        "  pip install -e integrations/agentpay_mcp\n"
        "or into a local venv:\n"
        "  python -m venv integrations/agentpay_mcp/.venv\n"
        "  integrations/agentpay_mcp/.venv/Scripts/pip install -r integrations/agentpay_mcp/requirements.txt\n"
    )
    raise

try:  # the SDK's typed chain error, for precise handling
    from agentpay.errors import ChainError
except Exception:  # pragma: no cover
    ChainError = Exception  # type: ignore


mcp = FastMCP("agentpay")
CONFIG: config.ServerConfig = config.load([])  # env-only by default; CLI main() may replace it
_wallet: "backend.AgentWallet | None" = None


# --- structured, agent-friendly errors --------------------------------------------------
def _error(error_type: str, message: str, hint: str = "") -> dict:
    """Shape returned to the agent when something is wrong with the setup or the chain link
    (as opposed to a *policy* rejection, which is a normal ``ok=false`` + ``reason``)."""
    out = {"ok": False, "error_type": error_type, "error": message}
    if hint:
        out["hint"] = hint
    return out


def _walletd_hint() -> str:
    if CONFIG.network == "esmeralda":
        return ("Is the esmeralda wallet daemon reachable at " + CONFIG.walletd_url +
                "? See docs/esmeralda.md.")
    return ("Is the local swarm running with walletd at " + CONFIG.walletd_url +
            " (auth=none)? See docs/devnet.md.")


def _build_wallet() -> "backend.AgentWallet | dict":
    """Connect to walletd and either attach to or provision a budget. Returns an AgentWallet on
    success, or a structured error dict (never raises) so a tool can relay it to the agent."""
    # 1) connect / authenticate
    try:
        client = backend.connect(CONFIG.walletd_url)
    except Exception as exc:
        return _error("not_connected", f"could not reach the wallet daemon: {exc}", _walletd_hint())

    # 2) attach mode
    if CONFIG.component:
        missing = CONFIG.missing_attach_vars()
        if missing:
            return _error("not_configured",
                          "attach mode needs " + ", ".join(missing),
                          "Set those env vars, or unset AGENTPAY_COMPONENT to let the server open a budget.")
        try:
            return backend.attach_wallet(
                client, component=CONFIG.component, agent_badge=CONFIG.agent_badge,
                agent_account=CONFIG.agent_account, per_tx_cap=CONFIG.per_tx_cap,
                daily_cap=CONFIG.daily_cap, whitelist=CONFIG.whitelist,
                template=CONFIG.budget_template,
            )
        except Exception as exc:
            return _error("attach_failed", f"could not attach to budget {CONFIG.component}: {exc}",
                          "Check AGENTPAY_COMPONENT / AGENTPAY_AGENT_BADGE / AGENTPAY_AGENT_ACCOUNT.")

    # 3) provision mode
    if not CONFIG.auto_provision:
        return _error("not_configured",
                      "no budget configured and auto-provision is disabled",
                      "Set AGENTPAY_COMPONENT (+badge +agent account), or drop --no-provision.")
    try:
        owner = client.account_address(CONFIG.owner_account)  # resolve first for a clear error
    except ChainError as exc:
        return _error("not_configured",
                      f"owner account {CONFIG.owner_account!r} not found on chain: {exc}",
                      "Set AGENTPAY_OWNER_ACCOUNT to a funded account (local default 'default', "
                      "esmeralda 'dev').")
    try:
        return backend.provision_wallet(
            client, owner, fund=CONFIG.fund, per_tx_cap=CONFIG.per_tx_cap,
            daily_cap=CONFIG.daily_cap, whitelist=CONFIG.whitelist,
            epochs_per_window=CONFIG.epochs_per_window, template=CONFIG.budget_template,
        )
    except Exception as exc:
        return _error("provision_failed", f"could not open a budget: {exc}",
                      "Is the owner account funded and the AgentBudget template published on this "
                      "network? " + _walletd_hint())


def _wallet_or_error() -> "tuple[backend.AgentWallet | None, dict | None]":
    """Lazily build the wallet, caching only on success so a later retry can recover once the
    chain link / config is fixed."""
    global _wallet
    if _wallet is not None:
        return _wallet, None
    built = _build_wallet()
    if isinstance(built, dict):
        return None, built
    _wallet = built
    return _wallet, None


# --- tools (the agent's entire surface) -------------------------------------------------
@mcp.tool()
def pay_merchant(merchant: str, amount: int, memo: str = "") -> dict:
    """Pay a merchant from the agent's on-chain budget.

    The payment is adjudicated by the Tari Ootle validator against the budget's on-chain rules
    (per-transaction cap, daily cap, merchant whitelist, revocation). Outcomes:

      * accepted  -> ``{"ok": true, "spent_in_window": <int>, ...}``
      * rejected  -> ``{"ok": false, "reason": "<validator's reason>", "rejected_by": ...}``
        (a normal, expected outcome — the agent cannot override it)
      * setup/chain problem -> ``{"ok": false, "error_type": ..., "error": ..., "hint": ...}``

    Args:
        merchant: the merchant's account component address (see ``list_merchants``).
        amount:   amount to pay, in XTR (integer).
        memo:     optional note / invoice reference carried on chain with the payment.
    """
    w, err = _wallet_or_error()
    if err:
        return err
    try:
        r = w.pay_merchant(merchant, amount, memo)
    except Exception as exc:  # defensive: never surface a raw traceback to the agent
        return _error("chain_error", f"payment failed unexpectedly: {exc}", _walletd_hint())
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

    The caps and whitelist are the owner's declared policy; the binding copy is enforced on
    chain. ``spent_in_window`` and ``revoked`` are confirmed against the live chain. On a setup
    or chain problem, returns a structured error object instead."""
    w, err = _wallet_or_error()
    if err:
        return err
    try:
        status = w.status()
    except Exception as exc:
        return _error("chain_error", f"could not read budget status: {exc}", _walletd_hint())
    status["ok"] = True
    return status


@mcp.tool()
def list_merchants() -> dict:
    """List the merchant addresses the agent is allowed to pay (the on-chain whitelist).

    Returns ``{"ok": true, "merchants": [...]}`` or a structured error object."""
    w, err = _wallet_or_error()
    if err:
        return err
    return {"ok": True, "merchants": w.list_merchants()}


@mcp.tool()
def get_server_info() -> dict:
    """Describe how this AgentPay server is configured and whether the wallet is live.

    Non-secret: network, walletd URL, template, mode (provision/attach) and declared caps. Use
    it to confirm the server is pointed where you expect and that the budget is reachable."""
    info = CONFIG.public_dict()
    w, err = _wallet_or_error()
    info["connected"] = w is not None
    if err:
        info["status"] = err
    elif w is not None:
        info["component"] = w.component
    return info


# --- entry point ------------------------------------------------------------------------
def main() -> None:
    """Console-script / module entry point. Parses CLI flags, handles ``--print-config`` and
    ``--selftest``, otherwise runs the stdio MCP server."""
    global CONFIG
    CONFIG = config.load()  # read CLI args this time

    if getattr(CONFIG, "_print_config", False):
        print(json.dumps(CONFIG.public_dict(), indent=2))
        return
    if getattr(CONFIG, "_selftest", False):
        built = _build_wallet()
        if isinstance(built, dict):
            print(json.dumps({"selftest": "fail", **built}, indent=2))
            sys.exit(1)
        global _wallet
        _wallet = built
        info = get_server_info()
        print(json.dumps({"selftest": "ok", **info}, indent=2, default=str))
        return

    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
