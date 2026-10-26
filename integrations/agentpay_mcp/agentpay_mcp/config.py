"""Configuration for the AgentPay MCP server.

Everything the server needs is read from environment variables (what an MCP client such
as Claude Desktop / Cursor passes under ``"env"``), with optional command-line flags that
override them for ad-hoc runs. Sensible defaults mean a developer pointing at a **local
swarm** needs to set almost nothing.

Two networks are supported out of the box via ``AGENTPAY_NETWORK`` (or ``--network``):

    local       (default) a local Tari Ootle swarm, walletd on 127.0.0.1:12010
    esmeralda   the public testnet, walletd on 127.0.0.1:5100

Each preset supplies a default walletd URL, AgentBudget template address and owner account
name; any of those can still be overridden individually.

Two running modes, chosen automatically:

    provision   (default when no component is given) the server opens a *fresh* on-chain
                budget on first use from the owner account, using the declared caps /
                whitelist / fund. Near-zero config — good for demos and dev.
    attach      if ``AGENTPAY_COMPONENT`` (+ badge + agent account) is given, the server
                attaches to that already-open budget holding only the agent badge. This is
                the production-shaped path: the owner opens the budget out of band and hands
                the agent just enough to spend.
"""
from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field

# --- network presets --------------------------------------------------------------------
PRESETS: dict[str, dict[str, str]] = {
    "local": {
        "walletd_url": "http://127.0.0.1:12010/json_rpc",
        "budget_template": "template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97",
        "owner_account": "default",
    },
    "esmeralda": {
        "walletd_url": "http://127.0.0.1:5100/json_rpc",
        "budget_template": "template_299d49bcace827cb86a8cdd9e6b1880783ae40a8a29ab28ba94b6b3ded6123a8",
        "owner_account": "dev",
    },
}
DEFAULT_NETWORK = "local"


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if v is None or not v.strip():
        return default
    try:
        return int(v)
    except ValueError:
        return default


def _split_whitelist(raw: str) -> list[str]:
    return [m.strip() for m in raw.replace("\n", ",").split(",") if m.strip()]


@dataclass
class ServerConfig:
    """Resolved configuration. Build it with :func:`load`."""

    network: str = DEFAULT_NETWORK
    walletd_url: str = PRESETS[DEFAULT_NETWORK]["walletd_url"]
    budget_template: str = PRESETS[DEFAULT_NETWORK]["budget_template"]
    owner_account: str = PRESETS[DEFAULT_NETWORK]["owner_account"]

    # attach mode (point at an already-open budget)
    component: str | None = None
    agent_badge: str | None = None
    agent_account: str | None = None

    # provision mode (server opens a fresh budget) + declared policy (display + whitelist)
    auto_provision: bool = True
    per_tx_cap: int = 1_000
    daily_cap: int = 1_500
    fund: int = 10_000
    epochs_per_window: int = 10
    whitelist: list[str] = field(default_factory=list)

    @property
    def mode(self) -> str:
        return "attach" if self.component else ("provision" if self.auto_provision else "unconfigured")

    def missing_attach_vars(self) -> list[str]:
        """In attach mode, the badge + agent account are required alongside the component."""
        if not self.component:
            return []
        return [n for n, v in (("AGENTPAY_AGENT_BADGE", self.agent_badge),
                               ("AGENTPAY_AGENT_ACCOUNT", self.agent_account)) if not v]

    def public_dict(self) -> dict:
        """Non-secret view of the config, safe to return from the ``get_server_info`` tool."""
        return {
            "network": self.network,
            "walletd_url": self.walletd_url,
            "budget_template": self.budget_template,
            "owner_account": self.owner_account,
            "mode": self.mode,
            "component": self.component,
            "per_tx_cap": self.per_tx_cap,
            "daily_cap": self.daily_cap,
            "whitelist": list(self.whitelist),
        }


def load(argv: list[str] | None = None) -> ServerConfig:
    """Resolve config from environment variables, then CLI flags (flags win).

    ``argv`` defaults to the process args; pass ``[]`` to read environment only.
    """
    # 1) pick the network preset (env), so its values become the defaults.
    network = os.environ.get("AGENTPAY_NETWORK", DEFAULT_NETWORK).strip().lower()
    preset = PRESETS.get(network, PRESETS[DEFAULT_NETWORK])

    cfg = ServerConfig(
        network=network if network in PRESETS else DEFAULT_NETWORK,
        walletd_url=os.environ.get("AGENTPAY_WALLETD_URL", preset["walletd_url"]),
        budget_template=os.environ.get("AGENTPAY_BUDGET_TEMPLATE", preset["budget_template"]),
        owner_account=os.environ.get("AGENTPAY_OWNER_ACCOUNT", preset["owner_account"]),
        component=os.environ.get("AGENTPAY_COMPONENT") or None,
        agent_badge=os.environ.get("AGENTPAY_AGENT_BADGE") or None,
        agent_account=os.environ.get("AGENTPAY_AGENT_ACCOUNT") or None,
        auto_provision=_env_bool("AGENTPAY_AUTO_PROVISION", True),
        per_tx_cap=_env_int("AGENTPAY_PER_TX_CAP", 1_000),
        daily_cap=_env_int("AGENTPAY_DAILY_CAP", 1_500),
        fund=_env_int("AGENTPAY_FUND", 10_000),
        epochs_per_window=_env_int("AGENTPAY_EPOCHS_PER_WINDOW", 10),
        whitelist=_split_whitelist(os.environ.get("AGENTPAY_WHITELIST", "")),
    )

    # 2) CLI overrides (handy for `agentpay-mcp --network esmeralda --print-config`).
    if argv is None:
        import sys
        argv = sys.argv[1:]
    args = _parser().parse_args(argv)

    if args.network:
        cfg.network = args.network
        p = PRESETS[args.network]
        # Re-apply preset defaults only where the env did not already set a value.
        if "AGENTPAY_WALLETD_URL" not in os.environ:
            cfg.walletd_url = p["walletd_url"]
        if "AGENTPAY_BUDGET_TEMPLATE" not in os.environ:
            cfg.budget_template = p["budget_template"]
        if "AGENTPAY_OWNER_ACCOUNT" not in os.environ:
            cfg.owner_account = p["owner_account"]
    if args.walletd_url:
        cfg.walletd_url = args.walletd_url
    if args.template:
        cfg.budget_template = args.template
    if args.owner:
        cfg.owner_account = args.owner
    if args.component:
        cfg.component = args.component
    if args.agent_badge:
        cfg.agent_badge = args.agent_badge
    if args.agent_account:
        cfg.agent_account = args.agent_account
    if args.per_tx_cap is not None:
        cfg.per_tx_cap = args.per_tx_cap
    if args.daily_cap is not None:
        cfg.daily_cap = args.daily_cap
    if args.fund is not None:
        cfg.fund = args.fund
    if args.epochs_per_window is not None:
        cfg.epochs_per_window = args.epochs_per_window
    if args.whitelist:
        cfg.whitelist = _split_whitelist(args.whitelist)
    if args.no_provision:
        cfg.auto_provision = False

    # In attach mode the agent account defaults to the owner account (devnet: one key).
    if cfg.component and not cfg.agent_account:
        cfg.agent_account = cfg.owner_account

    cfg._print_config = args.print_config  # type: ignore[attr-defined]
    cfg._selftest = args.selftest  # type: ignore[attr-defined]
    return cfg


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="agentpay-mcp",
        description="AgentPay MCP server — an on-chain, hard-limited wallet for AI agents.",
    )
    p.add_argument("--network", choices=sorted(PRESETS), help="preset: local (default) or esmeralda")
    p.add_argument("--walletd-url", dest="walletd_url", help="wallet daemon JSON-RPC URL")
    p.add_argument("--template", help="AgentBudget template address")
    p.add_argument("--owner", help="owner account name (funds a provisioned budget)")
    p.add_argument("--component", help="attach mode: an already-open budget component address")
    p.add_argument("--agent-badge", dest="agent_badge", help="attach mode: the agent badge resource")
    p.add_argument("--agent-account", dest="agent_account", help="attach mode: the agent's account")
    p.add_argument("--per-tx-cap", dest="per_tx_cap", type=int, help="per-transaction cap (provision)")
    p.add_argument("--daily-cap", dest="daily_cap", type=int, help="rolling daily cap (provision)")
    p.add_argument("--fund", type=int, help="amount to fund a provisioned budget with")
    p.add_argument("--epochs-per-window", dest="epochs_per_window", type=int,
                   help="epochs per daily-cap window (provision)")
    p.add_argument("--whitelist", help="comma-separated merchant account addresses")
    p.add_argument("--no-provision", dest="no_provision", action="store_true",
                   help="do not open a budget automatically; require attach vars")
    p.add_argument("--print-config", dest="print_config", action="store_true",
                   help="print the resolved (non-secret) config as JSON and exit")
    p.add_argument("--selftest", action="store_true",
                   help="run an in-process check against walletd (connect + budget) and exit")
    return p
