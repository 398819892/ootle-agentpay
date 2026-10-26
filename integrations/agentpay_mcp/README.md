# AgentPay × MCP — an on-chain, hard-limited wallet for AI agents

给 AI 代理一个**链上强制预算钱包**:owner 充值并发凭证给代理,代理只能在链上规则内花钱
(单笔上限 / 每日上限 / 商户白名单 / 随时撤销),限额由 **Tari Ootle 验证节点**强制执行,
代理的客户端绕不过。本目录把这套能力包成一个**真正的 MCP server**,任何 MCP 客户端
(Claude Desktop、IDE、或自写 agent)都能把它当成工具用。

This is a **real [Model Context Protocol](https://modelcontextprotocol.io) integration**,
not another script: the agent's payment ability is a genuine MCP server (stdio), and the demo
is a genuine MCP client that launches it, performs the handshake, lists tools and calls them.
The enforcement is on chain — the agent *sees* the validator's rejection reason and adapts.

## Why this matters

An autonomous agent that can spend money is only safe if the limits are **outside the agent's
control**. Client-side guard-rails can be prompt-injected or code-patched away. Here the per-tx
cap, daily cap, whitelist and kill switch live in the `AgentBudget` Ootle template and are
enforced by the validator at consensus time. The agent can request any payment it likes; the
chain is what says no.

## The agent's tool surface (and only this)

| MCP tool | what it does |
|---|---|
| `pay_merchant(merchant, amount, memo="")` | Attempt an on-chain payment. The validator adjudicates; a blocked payment returns `{"ok": false, "reason": "<validator's reason>"}`. |
| `get_budget_status()` | Remaining budget + the rules the agent must stay within. `spent_in_window` and `revoked` are confirmed against the live chain. |
| `list_merchants()` | The on-chain merchant whitelist the agent may pay. |

There is deliberately **no** tool to raise a cap, add a merchant, withdraw, or revoke — those are
owner powers (owner badge), exercised out of band. The agent holds only the *agent badge*.

## Architecture

```
  owner (holds owner badge)                   agent (holds agent badge, via MCP only)
  ───────────────────────────                 ────────────────────────────────────────
  demo_agent.py ── open_budget() ─┐            demo_agent.py (MCP client)
                   revoke()       │                 │  stdio: initialize / list_tools / call_tool
                   withdraw()     │                 ▼
        (direct SDK, owner badge) │            agentpay_mcp.server  (FastMCP stdio server)
                                  │                 │  pay_merchant / get_budget_status / list_merchants
                                  ▼                 ▼
                         agentpay.onchain.OnChainBudget  ──JSON-RPC──▶  walletd :12010
                                                                            │ submit_manifest (dry-run + real)
                                                                            ▼
                                                    AgentBudget template on the Tari Ootle swarm
                                                    (validator enforces caps / whitelist / revoke)
```

* `agentpay_mcp/backend.py` — thin glue over the repo's stdlib-only SDK
  (`sdk/src/agentpay/onchain.py`). `open_budget` (owner) / `attach_wallet` (agent).
  `pay_merchant` **dry-runs against the validator first**, so a rejection carries the chain's
  own reason and no fee is wasted.
* `agentpay_mcp/server.py` — the MCP server. Attaches to an already-open budget via env vars.
* `demo_agent.py` — owner setup/teardown (direct SDK) **plus** a real MCP client running a
  scripted agent decision loop that reacts to the tool results.

The core SDK stays pure-stdlib; the only extra dependency (`mcp`) is isolated here.

## Run the demo

Prerequisites: a local Tari Ootle **swarm** with its wallet daemon JSON-RPC on
`127.0.0.1:12010` (auth=none) and the `AgentBudget` template published (localnet address
`template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97`). See
[`../../docs/devnet.md`](../../docs/devnet.md).

```bash
# from the repo root (F:\oolte), one-time setup:
py -3 -m venv integrations/agentpay_mcp/.venv
integrations/agentpay_mcp/.venv/Scripts/pip install -r integrations/agentpay_mcp/requirements.txt

# run it (pauses at each step; add --auto to run straight through):
integrations/agentpay_mcp/.venv/Scripts/python integrations/agentpay_mcp/demo_agent.py --auto
```

On Linux/WSL use `.venv/bin/python` instead of `.venv/Scripts/python`.

### What you'll see (real run against the swarm)

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
━━━ 第 11 步 ━━━ owner 取回没花完的余额,收尾核对链上余额
  ✓ owner 取回 8600(充值 10000 − 代理已花 1400)
  shop 实际到账 1400(应为 1400 = 两笔 700)
```

Every `reason` string above is the **validator's own** verdict, relayed verbatim through MCP to
the agent — not a client-side check.

## Use the server from a real MCP client (e.g. Claude Desktop)

First open a budget and note its component + agent-badge addresses (the demo prints them, or call
`backend.open_budget` yourself). Then point an MCP client at the server. Example
`claude_desktop_config.json` entry:

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "F:\\oolte\\integrations\\agentpay_mcp\\.venv\\Scripts\\python.exe",
      "args": ["-m", "agentpay_mcp.server"],
      "cwd": "F:\\oolte\\integrations\\agentpay_mcp",
      "env": {
        "AGENTPAY_WALLETD_URL": "http://127.0.0.1:12010/json_rpc",
        "AGENTPAY_BUDGET_TEMPLATE": "template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97",
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

Now an LLM agent in that client can call `pay_merchant` / `get_budget_status` / `list_merchants`,
and will hit the exact same on-chain wall.

## Driving it with a real LLM (optional)

The demo uses a scripted decision loop so it runs with **no API key**. To let a real model drive
the same MCP tools, give an Anthropic (or any tool-calling) agent the three tools above and feed
each tool result back into the conversation — the `reason` field is already natural language the
model can reason over. Keep the key optional and fall back to the scripted loop when it is absent.
(The scripted loop and the LLM would call the *same* MCP server; only the decision-maker changes.)

## Files

```
integrations/agentpay_mcp/
├── README.md               ← this file
├── requirements.txt        ← mcp (the only extra dep; core SDK stays stdlib)
├── demo_agent.py           ← owner setup + real MCP client + scripted agent loop
└── agentpay_mcp/
    ├── __init__.py
    ├── backend.py          ← glue over agentpay.onchain (open / attach / pay / status)
    └── server.py           ← the MCP stdio server (3 agent tools)
```
