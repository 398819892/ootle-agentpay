"""Configuration for the AgentPay MCP server.

Everything the server needs is read from environment variables (what an MCP client such
as Claude Desktop / Cursor passes under ``"env"``), with optional command-line flags that
override them for ad-hoc runs. Sensible defaults mean a developer pointing at a **local
swarm** needs to set almost nothing.

Two networks are supported out of the box via ``AGENTPAY_NETWORK`` (or ``--network``):

    local       (default) a local Tari Ootle swarm, walletd on 127.0.0.1:12010
    esmeralda   the public testnet, walletd on 127.0.0.1:5100

Each preset supplies a default walletd URL, AgentBudget template address and owner account
name; any of those can still be overridden individually. An **unknown** network name is
fail-closed: it is rejected unless the operator points the server at it explicitly with
``AGENTPAY_WALLETD_URL`` — the server never silently falls back to the local swarm's config
(so e.g. ``AGENTPAY_NETWORK=mainnet`` demands an explicit endpoint, never an assumed one).

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
import json
import os
from dataclasses import dataclass, field

from . import _defaults

# --- network presets --------------------------------------------------------------------
PRESETS: dict[str, dict[str, str]] = {
    "local": {
        "walletd_url": "http://127.0.0.1:12010/json_rpc",
        # Read from the repo-root defaults.json (single source of truth) rather than a baked-in
        # literal that silently goes stale after a swarm reset — AGENTPAY_BUDGET_TEMPLATE still wins
        # (applied in load()). Empty if defaults.json is absent → fails honestly at provision time.
        "budget_template": _defaults.template("agent_budget"),
        "owner_account": "default",
    },
    # esmeralda: the 0.49 testnet reset (docs/compat-0.49.md) invalidated the previously-published
    # template, so we do NOT bake a budget_template here. A stale address looks configured but fails
    # on chain as "Template not found"; an empty default instead fails honestly at provision time.
    # After re-publishing on the current 0.49 esmeralda, pass AGENTPAY_BUDGET_TEMPLATE (or --template).
    "esmeralda": {
        "walletd_url": "http://127.0.0.1:5100/json_rpc",
        "budget_template": "",
        "owner_account": "dev",
    },
    # NOTE — mainnet (Ootle L2, 2026-11-11): no preset yet, on purpose. The agent_budget / escrow
    # template addresses only exist after the mainnet publish (≈11-12), and we do NOT bake in a
    # guessed walletd port. C-5 is decided: agent_budget is OWNER-UPGRADEABLE (its new() sets the
    # component upgrade_rule to the owner badge, so only the owner can migrate it to a new template),
    # while escrow / otc_board stay IMMUTABLE (Locked) — see docs/mainnet-params.md §0 and
    # docs/template-freeze.md §3. Until a "mainnet" entry is added here (with the real addresses),
    # run mainnet by supplying AGENTPAY_WALLETD_URL + AGENTPAY_BUDGET_TEMPLATE + AGENTPAY_OWNER_ACCOUNT
    # explicitly; D-8 (load() below) fail-closes AGENTPAY_NETWORK=mainnet without an explicit URL, so
    # a mainnet run can never silently fall back to the local swarm's config.
}
DEFAULT_NETWORK = "local"


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    # An unset / empty var uses the default; a SET-but-non-integer value is refused, not silently
    # swallowed — a typo in a cap / port / window would otherwise leave the agent running on a
    # surprise default instead of what the operator configured. Fail loud, naming the variable. (P2)
    v = os.environ.get(name)
    if v is None or not v.strip():
        return default
    try:
        return int(v)
    except ValueError:
        raise ValueError(f"Invalid config: {name}={v.strip()!r} is not an integer") from None


def _split_whitelist(raw: str) -> list[str]:
    return [m.strip() for m in raw.replace("\n", ",").split(",") if m.strip()]


def _split_tokens(raw: str) -> list[str]:
    """Bearer tokens for the HTTP transport, comma/newline separated (secret; env only)."""
    return [t.strip() for t in (raw or "").replace("\n", ",").split(",") if t.strip()]


def _norm_transport(v: str) -> str:
    v = (v or "stdio").strip().lower()
    return "streamable-http" if v in ("http", "streamable-http", "streamable_http", "streamablehttp") else "stdio"


def _norm_http_path(v: str) -> str:
    v = (v or "/mcp").strip()
    if not v.startswith("/"):
        v = "/" + v
    return v or "/mcp"


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

    # provision mode (server opens a fresh budget) + declared policy (display + whitelist).
    # Default FALSE = ATTACH (non-custodial: the agent holds only the agent badge); provision is
    # opt-in for local demos. Must agree with the env default in from_env() (audit #9 / #15).
    auto_provision: bool = False
    # Amounts below are in BASE UNITS (µT; 1 XTR = 1,000,000 µT) — the unit the manifest/chain use.
    # The defaults are tiny demo values (1_000 µT = 0.001 XTR), NOT whole XTR. (D-6)
    per_tx_cap: int = 1_000
    daily_cap: int = 1_500
    fund: int = 10_000
    epochs_per_window: int = 10
    whitelist: list[str] = field(default_factory=list)

    # transport: STDIO (default; local hosts launch the server over stdio) or Streamable HTTP (opt-in,
    # for remote/mobile clients). Exposing the payment tools over the network requires a bearer token
    # (http_tokens, from AGENTPAY_MCP_HTTP_TOKEN); binding to a non-loopback host without one is
    # refused in server._run_http (fail-closed). Put the HTTP endpoint behind HTTPS in production.
    transport: str = "stdio"  # "stdio" | "streamable-http"
    http_host: str = "127.0.0.1"
    http_port: int = 8000
    http_path: str = "/mcp"
    http_tokens: list[str] = field(default_factory=list)  # bearer token(s); SECRET — env only

    @property
    def mode(self) -> str:
        return "attach" if self.component else ("provision" if self.auto_provision else "unconfigured")

    def missing_attach_vars(self) -> list[str]:
        """In attach mode only the agent account is required alongside the component — and it
        defaults to the owner account (see load()), so in practice a bare AGENTPAY_COMPONENT is
        enough. The agent badge is no longer required: it is derived from the component's on-chain
        state (struct order owner_badge, agent_badge) when not given, so an operator need not copy
        that 64-hex resource by hand. Pass AGENTPAY_AGENT_BADGE only to pin it explicitly."""
        if not self.component:
            return []
        return [n for n, v in (("AGENTPAY_AGENT_ACCOUNT", self.agent_account),) if not v]

    def claude_env(self) -> dict[str, str]:
        """The minimal ``env`` block a Claude Desktop / Cursor entry needs to reproduce THIS
        resolved config — only values that differ from the active network preset, so the generated
        block stays short. Used by ``--emit-claude-config`` / ``--install-claude``."""
        preset = PRESETS.get(self.network, {})
        env: dict[str, str] = {}
        if self.network != DEFAULT_NETWORK:
            env["AGENTPAY_NETWORK"] = self.network
        if self.walletd_url and self.walletd_url != preset.get("walletd_url"):
            env["AGENTPAY_WALLETD_URL"] = self.walletd_url
        if self.budget_template and self.budget_template != preset.get("budget_template"):
            env["AGENTPAY_BUDGET_TEMPLATE"] = self.budget_template
        if self.component:  # attach mode
            env["AGENTPAY_COMPONENT"] = self.component
            # agent account only when it is NOT the owner-account default; badge only if pinned
            # (otherwise it is derived from the component on chain).
            if self.agent_account and self.agent_account != self.owner_account:
                env["AGENTPAY_AGENT_ACCOUNT"] = self.agent_account
            if self.agent_badge:
                env["AGENTPAY_AGENT_BADGE"] = self.agent_badge
        else:  # provision mode
            if self.auto_provision:
                env["AGENTPAY_AUTO_PROVISION"] = "true"
            if self.owner_account and self.owner_account != preset.get("owner_account"):
                env["AGENTPAY_OWNER_ACCOUNT"] = self.owner_account
        if self.whitelist:
            env["AGENTPAY_WHITELIST"] = ",".join(self.whitelist)
        return env

    def mcp_entry(self) -> dict:
        """The ``mcpServers["agentpay"]`` entry (``{command, env?}``) for any MCP host that uses the
        mcpServers schema (Claude Desktop, Cursor) or a bare stdio host."""
        entry: dict = {"command": "agentpay-mcp"}
        env = self.claude_env()
        if env:
            entry["env"] = env
        return entry

    # Back-compat alias (the method was Claude-specific before the host-agnostic generator).
    claude_entry = mcp_entry

    def http_env(self) -> dict[str, str]:
        """The HTTP-consumer env (``AGENTPAY_URL`` / ``AGENTPAY_API_KEY``) resolved from the shared
        config — for a non-MCP framework (e.g. OpenClaw) that calls the hosted ``/api/v1`` with a
        capped API key and never touches walletd. The key is included only if the shared config has
        one (it is a secret the owner issues out of band)."""
        env = {"AGENTPAY_URL": _defaults.get("api_url", default="http://localhost:8787")}
        key = _defaults.get("api_key")
        if key:
            env["AGENTPAY_API_KEY"] = key
        return env

    def emit(self, host: str) -> str:
        """Render the wiring for ``host`` as text to print:

        - ``claude`` / ``cursor`` → ``{"mcpServers": {"agentpay": {command, env?}}}`` (JSON)
        - ``generic`` → the bare stdio entry ``{command, env?}`` for any other MCP host (JSON)
        - ``http-json`` → ``{"baseUrl", "apiKey"?}`` for an HTTP-API consumer (JSON)
        - ``http-env`` → ``AGENTPAY_URL=… / AGENTPAY_API_KEY=…`` dotenv lines (plain text)
        """
        if host in ("claude", "cursor"):
            return json.dumps({"mcpServers": {"agentpay": self.mcp_entry()}}, indent=2, ensure_ascii=False)
        if host == "generic":
            return json.dumps(self.mcp_entry(), indent=2, ensure_ascii=False)
        if host == "http-json":
            env = self.http_env()
            block = {"baseUrl": env["AGENTPAY_URL"]}
            if "AGENTPAY_API_KEY" in env:
                block["apiKey"] = env["AGENTPAY_API_KEY"]
            return json.dumps(block, indent=2, ensure_ascii=False)
        if host == "http-env":
            return "\n".join(f"{k}={v}" for k, v in self.http_env().items())
        if host == "remote":
            # Remote MCP over Streamable HTTP. The server doesn't know your public HTTPS URL, so this
            # prints the local bind endpoint plus the shape clients use once it's behind a TLS proxy.
            local = f"http://{self.http_host}:{self.http_port}{self.http_path}"
            return "\n".join([
                "# Remote MCP (Streamable HTTP). Front this with HTTPS before exposing it publicly.",
                f"# Local bind / test endpoint: {local}",
                "#",
                "# Run the server (token is required to expose beyond localhost):",
                f"#   AGENTPAY_MCP_HTTP_TOKEN=<secret> agentpay-mcp --http "
                f"--http-host {self.http_host} --http-port {self.http_port}" +
                ("" if self.http_path == "/mcp" else f" --http-path {self.http_path}"),
                "#",
                "# Point a remote client (Claude connector, ChatGPT custom connector) at your proxy:",
                "#   URL:    https://YOUR_DOMAIN" + self.http_path,
                "#   Header: Authorization: Bearer <the same AGENTPAY_MCP_HTTP_TOKEN>",
            ])
        raise ValueError(f"unknown --host {host!r}")

    #: Hosts ``--emit-config`` understands, and the subset ``--install`` can write a file for.
    EMIT_HOSTS = ("claude", "cursor", "generic", "http-json", "http-env", "remote")
    INSTALL_HOSTS = ("claude", "cursor")

    def public_dict(self) -> dict:
        """Non-secret view of the config, safe to return from the ``get_server_info`` tool."""
        d = {
            "network": self.network,
            "walletd_url": self.walletd_url,
            "budget_template": self.budget_template,
            "owner_account": self.owner_account,
            "mode": self.mode,
            "component": self.component,
            "per_tx_cap": self.per_tx_cap,
            "daily_cap": self.daily_cap,
            "whitelist": list(self.whitelist),
            "transport": self.transport,
        }
        if self.transport == "streamable-http":
            # endpoint is non-secret; the token itself is NEVER exposed — only whether auth is on.
            d["http_bind"] = f"{self.http_host}:{self.http_port}{self.http_path}"
            d["http_auth"] = bool(self.http_tokens)
        return d


def load(argv: list[str] | None = None) -> ServerConfig:
    """Resolve config from environment variables, then CLI flags (flags win).

    ``argv`` defaults to the process args; pass ``[]`` to read environment only.
    """
    # 1) pick the network preset (env), so its values become the defaults. An UNKNOWN network name is
    #    fail-closed: we NEVER silently fall back to the local swarm's walletd/template for it (D-8) —
    #    a typo'd or real "mainnet" would otherwise run against local-swarm config. A name with no
    #    built-in preset (notably "mainnet", whose real addresses must never be hardcoded here) is
    #    allowed ONLY when the operator points the server at it explicitly with AGENTPAY_WALLETD_URL;
    #    the template/owner should be given too, or provisioning fails honestly later.
    # Chain/identity values resolve through the shared config source (agentpay.config.json), so they
    # are configured ONCE and shared with the HTTP server and the SDK. Precedence inside _defaults.get:
    # AGENTPAY_* env var -> agentpay.config.json -> (the preset default passed here). The preset still
    # selects walletd/template/owner for a known network, and the file/env override it.
    network = _defaults.get("network", default=DEFAULT_NETWORK).strip().lower()
    if network in PRESETS:
        preset = PRESETS[network]
    elif _defaults.get("walletd_url"):
        preset = {"walletd_url": "", "budget_template": "", "owner_account": ""}
    else:
        raise SystemExit(
            f"Unknown AGENTPAY_NETWORK={network!r}: no built-in preset. Known presets: "
            f"{', '.join(sorted(PRESETS))}. For any other network (e.g. mainnet) point the server at "
            f"it explicitly with AGENTPAY_WALLETD_URL (and AGENTPAY_BUDGET_TEMPLATE / "
            f"AGENTPAY_OWNER_ACCOUNT) — there is NO default, so nothing about mainnet is ever assumed."
        )

    cfg = ServerConfig(
        network=network,  # keep the real name — never silently coerce an unknown network to "local"
        walletd_url=_defaults.get("walletd_url", default=preset["walletd_url"]),
        budget_template=_defaults.get("budget_template", default=preset["budget_template"]),
        owner_account=_defaults.get("owner_account", default=preset["owner_account"]),
        component=_defaults.get("component") or None,
        agent_badge=_defaults.get("agent_badge") or None,
        agent_account=_defaults.get("agent_account") or None,
        # #15: default to ATTACH (non-custodial): the MCP/agent process attaches to a budget the
        # OWNER already opened (component + agent badge + agent account), so it holds only the agent
        # badge — not the owner key. Auto-provision (the agent process opening a budget with the owner
        # key, thus holding both badges) is now opt-in for local demos: set AGENTPAY_AUTO_PROVISION=1.
        auto_provision=_env_bool("AGENTPAY_AUTO_PROVISION", False),
        per_tx_cap=_env_int("AGENTPAY_PER_TX_CAP", 1_000),
        daily_cap=_env_int("AGENTPAY_DAILY_CAP", 1_500),
        fund=_env_int("AGENTPAY_FUND", 10_000),
        epochs_per_window=_env_int("AGENTPAY_EPOCHS_PER_WINDOW", 10),
        whitelist=_split_whitelist(os.environ.get("AGENTPAY_WHITELIST", "")),
        transport=_norm_transport(os.environ.get("AGENTPAY_MCP_TRANSPORT", "stdio")),
        http_host=(os.environ.get("AGENTPAY_MCP_HTTP_HOST", "").strip() or "127.0.0.1"),
        http_port=_env_int("AGENTPAY_MCP_HTTP_PORT", 8000),
        http_path=_norm_http_path(os.environ.get("AGENTPAY_MCP_HTTP_PATH", "/mcp")),
        http_tokens=_split_tokens(os.environ.get("AGENTPAY_MCP_HTTP_TOKEN", "")),
    )

    # 2) CLI overrides (handy for `agentpay-mcp --network esmeralda --print-config`).
    if argv is None:
        import sys
        argv = sys.argv[1:]
    args = _parser().parse_args(argv)

    if args.network:
        cfg.network = args.network
        p = PRESETS[args.network]
        # Re-apply preset defaults only where neither the env nor the shared config file set a value.
        if not _defaults.get("walletd_url"):
            cfg.walletd_url = p["walletd_url"]
        if not _defaults.get("budget_template"):
            cfg.budget_template = p["budget_template"]
        if not _defaults.get("owner_account"):
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
    if args.transport:
        cfg.transport = _norm_transport(args.transport)
    if args.http:
        cfg.transport = "streamable-http"
    if args.http_host:
        cfg.http_host = args.http_host
    if args.http_port is not None:
        cfg.http_port = args.http_port
    if args.http_path:
        cfg.http_path = _norm_http_path(args.http_path)

    # In attach mode the agent account defaults to the owner account (devnet: one key).
    if cfg.component and not cfg.agent_account:
        cfg.agent_account = cfg.owner_account

    cfg._print_config = args.print_config  # type: ignore[attr-defined]
    cfg._selftest = args.selftest  # type: ignore[attr-defined]
    # Host-agnostic generator: --emit-config / --install take --host (default claude); the old
    # --emit-claude-config / --install-claude are aliases for --host claude.
    cfg._emit_host = (  # type: ignore[attr-defined]
        (args.host or "claude") if args.emit_config else ("claude" if args.emit_claude_config else None)
    )
    cfg._install_host = (  # type: ignore[attr-defined]
        (args.host or "claude") if args.install else ("claude" if args.install_claude else None)
    )
    cfg._install_project = args.project  # type: ignore[attr-defined]
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
    p.add_argument("--daily-cap", dest="daily_cap", type=int, help="per-window spending cap; fixed epoch window, not a trailing 24h (provision)")
    p.add_argument("--fund", type=int, help="amount to fund a provisioned budget with")
    p.add_argument("--epochs-per-window", dest="epochs_per_window", type=int,
                   help="epochs per spending window (provision)")
    p.add_argument("--whitelist", help="comma-separated merchant account addresses")
    p.add_argument("--no-provision", dest="no_provision", action="store_true",
                   help="do not open a budget automatically; require attach vars")
    # transport (default stdio). --http is shorthand for --transport streamable-http. The bearer
    # token is a SECRET and is read only from AGENTPAY_MCP_HTTP_TOKEN (never a CLI flag, so it does
    # not land in the process list).
    p.add_argument("--transport", choices=["stdio", "streamable-http"],
                   help="MCP transport: stdio (default, local) or streamable-http (remote)")
    p.add_argument("--http", action="store_true", help="shorthand for --transport streamable-http")
    p.add_argument("--http-host", dest="http_host", help="streamable-http bind host (default 127.0.0.1)")
    p.add_argument("--http-port", dest="http_port", type=int, help="streamable-http bind port (default 8000)")
    p.add_argument("--http-path", dest="http_path", help="streamable-http URL path (default /mcp)")
    p.add_argument("--print-config", dest="print_config", action="store_true",
                   help="print the resolved (non-secret) config as JSON and exit")
    p.add_argument("--selftest", action="store_true",
                   help="run an in-process check against walletd (connect + budget) and exit")
    p.add_argument("--emit-config", dest="emit_config", action="store_true",
                   help="print the wiring for --host (claude|cursor|generic|http-json|http-env|remote) and exit")
    p.add_argument("--install", dest="install", action="store_true",
                   help="merge the 'agentpay' entry into --host's config file (claude|cursor; keeps other servers) and exit")
    p.add_argument("--host", choices=list(ServerConfig.EMIT_HOSTS),
                   help="target host for --emit-config / --install (default: claude)")
    p.add_argument("--project", action="store_true",
                   help="with --install --host cursor: write the project-local .cursor/mcp.json instead of the global one")
    # Back-compat aliases (pre-dating the host-agnostic generator); equivalent to --host claude.
    p.add_argument("--emit-claude-config", dest="emit_claude_config", action="store_true",
                   help="alias for --emit-config --host claude")
    p.add_argument("--install-claude", dest="install_claude", action="store_true",
                   help="alias for --install --host claude")
    return p
