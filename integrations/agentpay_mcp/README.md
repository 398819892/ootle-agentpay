# AgentPay × MCP — an on-chain, hard-limited wallet for AI agents

给 AI 代理一个**链上强制预算钱包**:owner 充值并发凭证给代理,代理只能在链上规则内花钱
(单笔上限 / 每日上限 / 商户白名单 / 随时撤销),限额由 **Tari Ootle 验证节点**强制执行,
代理的客户端绕不过。本目录把这套能力包成一个**正式、可配置、可一键安装的 MCP server**,
任何 MCP 客户端(Claude Desktop、Cursor、或自写 agent)都能把它当成工具装上。

This is a **real [Model Context Protocol](https://modelcontextprotocol.io) server**, not a
script: the agent's payment ability is a genuine stdio MCP server, enforcement is on chain, and
the agent *sees* the validator's rejection reason and adapts. It installs with `pip` / `pipx` /
`uvx`, is configured entirely through environment variables, works against a **local swarm** or
the **esmeralda** public testnet, and returns agent-friendly structured errors.

## Why this matters

An autonomous agent that can spend money is only safe if the limits are **outside the agent's
control**. Client-side guard-rails can be prompt-injected or code-patched away. Here the per-tx
cap, daily cap, whitelist and kill switch live in the `AgentBudget` Ootle template and are
enforced by the validator at consensus time. The agent can request any payment it likes; the
chain is what says no.

## The agent's tool surface

| MCP tool | what it does |
|---|---|
| `pay_merchant(merchant, amount, memo="")` | Attempt an on-chain payment. The validator adjudicates; a blocked payment returns `{"ok": false, "reason": "<validator's reason>", "rejected_by": ...}`. |
| `get_budget_status()` | Remaining budget + the rules the agent must stay within. `spent_in_window` and `revoked` are confirmed against the live chain. |
| `list_merchants()` | `{"ok": true, "merchants": [...]}` — the on-chain whitelist the agent may pay. |
| `get_server_info()` | How this server is configured (network, walletd, template, mode, caps) and whether the budget is reachable. Handy for the agent or operator to confirm wiring. |

There is deliberately **no** tool to raise a cap, add a merchant, withdraw, or revoke — those are
owner powers (owner badge), exercised out of band. The agent holds only the *agent badge*.

## Install

The package is `agentpay-mcp`; it installs a console script of the same name.

```bash
# editable install from the repo (recommended for this repo):
pip install -e integrations/agentpay_mcp

# or isolated, with pipx / uvx (set AGENTPAY_SDK_PATH so the bundled SDK is importable):
pipx install ./integrations/agentpay_mcp
uvx --from ./integrations/agentpay_mcp agentpay-mcp --print-config
```

> The on-chain SDK (`agentpay.onchain`) ships inside this repo (`sdk/src`, stdlib-only) and is
> **not** fetched from PyPI. With an editable install or when run from the repo it is found
> automatically. For an isolated install (pipx/uvx from a copy) set `AGENTPAY_SDK_PATH` to the
> repo's `sdk/src` directory.

Legacy (no build tooling): a local venv + `requirements.txt` still works —
`py -3 -m venv integrations/agentpay_mcp/.venv` then
`integrations/agentpay_mcp/.venv/Scripts/pip install -r integrations/agentpay_mcp/requirements.txt`
and run with `python -m agentpay_mcp.server`.

Verify the install without touching the chain:

```bash
agentpay-mcp --print-config            # resolved (non-secret) config
agentpay-mcp --selftest                # connect to walletd + open/attach a budget, then exit
```

## Configure

Everything is set through environment variables (what an MCP client passes under `"env"`), each
overridable by a CLI flag. **Defaults target a local swarm, so a dev usually sets nothing.**

| Env var | CLI flag | Default (local) | Meaning |
|---|---|---|---|
| `AGENTPAY_NETWORK` | `--network` | `local` | `local` or `esmeralda` — picks the defaults below |
| `AGENTPAY_WALLETD_URL` | `--walletd-url` | `http://127.0.0.1:12010/json_rpc` | wallet daemon JSON-RPC |
| `AGENTPAY_BUDGET_TEMPLATE` | `--template` | `template_758d0c58…` | AgentBudget template address |
| `AGENTPAY_OWNER_ACCOUNT` | `--owner` | `default` | account that funds a provisioned budget |
| `AGENTPAY_PER_TX_CAP` | `--per-tx-cap` | `1000` | per-transaction cap |
| `AGENTPAY_DAILY_CAP` | `--daily-cap` | `1500` | rolling daily cap |
| `AGENTPAY_WHITELIST` | `--whitelist` | *(empty)* | comma-separated merchant account addresses |
| `AGENTPAY_FUND` | `--fund` | `10000` | amount to fund a provisioned budget |
| `AGENTPAY_COMPONENT` | `--component` | *(unset)* | **attach mode:** an already-open budget component |
| `AGENTPAY_AGENT_BADGE` | `--agent-badge` | *(unset)* | **attach mode:** the agent badge resource |
| `AGENTPAY_AGENT_ACCOUNT` | `--agent-account` | *(unset)* | **attach mode:** the agent's account |
| `AGENTPAY_AUTO_PROVISION` | `--no-provision` | `true` | open a budget automatically when none is given |

**esmeralda preset:** walletd `http://127.0.0.1:5100/json_rpc`, template
`template_299d49bc…` (the published `agent_budget`), owner `dev`. See
[`../../docs/esmeralda.md`](../../docs/esmeralda.md).

### Two modes (chosen automatically)

* **Provision** (default — near-zero config). No `AGENTPAY_COMPONENT` given → the server opens a
  fresh on-chain budget from the owner account on first tool call, using the caps / whitelist /
  fund above. Great for demos and dev. The agent still only gets the three spending tools.
  (An empty whitelist means the agent can pay *nobody* until merchants are whitelisted by the
  owner — set `AGENTPAY_WHITELIST` to a merchant account to make payments possible.)
* **Attach** (production-shaped). Set `AGENTPAY_COMPONENT` + `AGENTPAY_AGENT_BADGE` +
  `AGENTPAY_AGENT_ACCOUNT` → the server attaches to a budget the owner opened out of band,
  holding **only the agent badge**. It can pay but can never raise its caps or revoke itself.

## Prerequisites

A running Tari Ootle **wallet daemon** that the URL above points at:

* **local swarm** — walletd JSON-RPC on `127.0.0.1:12010` (auth=none) and the `AgentBudget`
  template published. See [`../../docs/devnet.md`](../../docs/devnet.md).
* **esmeralda** — walletd on `127.0.0.1:5100`. See [`../../docs/esmeralda.md`](../../docs/esmeralda.md).

If walletd is down or misconfigured, the tools return a structured `not_connected` /
`not_configured` error (see below) instead of crashing — `agentpay-mcp --selftest` is the quick
way to check wiring.

## Add to Claude Desktop

Edit `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`; Windows:
`%APPDATA%\Claude\claude_desktop_config.json`), add an `mcpServers` entry, and restart Claude.

**Zero-config, local swarm** (provision mode — opens a budget for you; set a whitelist so the
agent can actually pay a merchant):

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "agentpay-mcp",
      "env": {
        "AGENTPAY_NETWORK": "local",
        "AGENTPAY_WHITELIST": "component_...your merchant account..."
      }
    }
  }
}
```

**esmeralda** (public testnet):

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "agentpay-mcp",
      "env": {
        "AGENTPAY_NETWORK": "esmeralda",
        "AGENTPAY_OWNER_ACCOUNT": "dev",
        "AGENTPAY_WHITELIST": "component_...your merchant account..."
      }
    }
  }
}
```

**Attach to an existing budget** (production-shaped — the agent holds only the agent badge):

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "agentpay-mcp",
      "env": {
        "AGENTPAY_NETWORK": "local",
        "AGENTPAY_COMPONENT": "component_...the open budget...",
        "AGENTPAY_AGENT_BADGE": "resource_...the agent badge...",
        "AGENTPAY_AGENT_ACCOUNT": "component_...the agent account...",
        "AGENTPAY_PER_TX_CAP": "1000",
        "AGENTPAY_DAILY_CAP": "1500",
        "AGENTPAY_WHITELIST": "component_...shop..."
      }
    }
  }
}
```

> If `agentpay-mcp` is not on Claude Desktop's `PATH`, use the venv's absolute path as `command`
> (e.g. `F:\\oolte\\integrations\\agentpay_mcp\\.venv\\Scripts\\agentpay-mcp.exe`), or
> `"command": "python", "args": ["-m", "agentpay_mcp.server"]` with the repo checked out and
> `AGENTPAY_SDK_PATH` set.

## Add to Cursor

Cursor reads MCP servers from `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project).
Same shape as above:

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "agentpay-mcp",
      "env": {
        "AGENTPAY_NETWORK": "local",
        "AGENTPAY_WHITELIST": "component_...your merchant account..."
      }
    }
  }
}
```

Then enable **agentpay** in Cursor's Settings → MCP. The model can now call `pay_merchant` /
`get_budget_status` / `list_merchants` / `get_server_info` and hit the exact same on-chain wall.

## Error handling (agent-friendly)

Tool results never surface a raw traceback. Two shapes of failure:

* **Policy rejection** (normal, expected): the chain refused a payment.
  `{"ok": false, "reason": "Amount exceeds the per-transaction cap", "rejected_by": "Tari Ootle validator (on-chain budget rule)"}`
  — `reason` is the validator's own words; the agent can reason over it and adjust.
* **Setup / chain problem:** `{"ok": false, "error_type": "...", "error": "...", "hint": "..."}`
  with `error_type` one of `not_connected`, `not_configured`, `attach_failed`,
  `provision_failed`, `chain_error`. The `hint` says what to fix. The server stays up and
  recovers on the next call once the problem is resolved (e.g. walletd comes back).

## Run the demo (real MCP client ↔ server, local swarm)

```bash
pip install -e integrations/agentpay_mcp
# pauses at each step; add --auto to run straight through:
python integrations/agentpay_mcp/demo_agent.py --auto
```

The demo sets up owner/merchant accounts and a budget (direct SDK, owner badge), launches the MCP
server as a subprocess in **attach mode**, and drives it as a real MCP client with a scripted
agent loop (no API key needed). You'll see:

```
━━━ 第 4 步 ━━━ 代理决定给 shop 付一笔正常的钱(700)
  ✓ pay_merchant → {"ok": true, "amount": 700, "spent_in_window": 700}
━━━ 第 5 步 ━━━ 代理想一次付 1500(超单笔上限)—— 链当场拒绝
  ✗ pay_merchant → {"ok": false, "reason": "Amount exceeds the per-transaction cap", ...}
━━━ 第 6 步 ━━━ 代理想付给 scammer(不在白名单)—— 链当场拒绝
  ✗ pay_merchant → {"ok": false, "reason": "Merchant is not whitelisted", ...}
━━━ 第 8 步 ━━━ 代理还想再付 700(1400+700>1500)—— 撞每日上限,链拒绝
  ✗ pay_merchant → {"ok": false, "reason": "Amount exceeds the daily cap", ...}
━━━ 第 10 步 ━━━ 代理撤销后再试付 100 —— 链拒绝
  ✗ pay_merchant → {"ok": false, "reason": "Agent has been revoked", ...}
```

Every `reason` string is the **validator's own** verdict, relayed verbatim through MCP — not a
client-side check.

## Driving it with a real LLM (optional)

To let a real model drive the same MCP tools, give an Anthropic (or any tool-calling) agent the
four tools above and feed each tool result back into the conversation — the `reason` field is
already natural language the model can reason over. The scripted demo loop and an LLM call the
*same* MCP server; only the decision-maker changes.

## Architecture

```
  owner (holds owner badge)                   agent (holds agent badge, via MCP only)
  ───────────────────────────                 ────────────────────────────────────────
  open_budget() / revoke() / withdraw()        MCP client (Claude Desktop / Cursor / demo)
        (direct SDK, owner badge)                    │  stdio: initialize / list_tools / call_tool
                                  │                   ▼
                                  │              agentpay_mcp.server  (FastMCP stdio server)
                                  │                   │  pay_merchant / get_budget_status / list_merchants / get_server_info
                                  ▼                   ▼
                         agentpay.onchain.OnChainBudget  ──JSON-RPC──▶  walletd (:12010 / :5100)
                                                                            │ submit_manifest (dry-run + real)
                                                                            ▼
                                                    AgentBudget template on Tari Ootle
                                                    (validator enforces caps / whitelist / revoke)
```

## Files

```
integrations/agentpay_mcp/
├── README.md               ← this file
├── pyproject.toml          ← installable package + `agentpay-mcp` console script
├── requirements.txt        ← legacy venv path (mcp only; core SDK stays stdlib)
├── demo_agent.py           ← owner setup + real MCP client + scripted agent loop
└── agentpay_mcp/
    ├── __init__.py
    ├── config.py           ← env/CLI config, network presets, provision/attach mode
    ├── backend.py          ← glue over agentpay.onchain (open / attach / provision / pay / status)
    └── server.py           ← the MCP stdio server (4 tools, structured errors, CLI entry)
```
