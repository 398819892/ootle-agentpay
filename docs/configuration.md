# Configuration — one shared source for every surface

AgentPay can be driven three ways — the **MCP server**, the hosted **HTTP `/api/v1`**, and the
**SDKs** (Python `agentpay.onchain`, TypeScript `@agentpay/client`). They all read **one** optional
config file, `agentpay.config.json`, whose keys mirror the canonical `AGENTPAY_*` environment
variables one-to-one. Fill it in once and every surface resolves the same values.

> Copy [`agentpay.config.example.json`](../agentpay.config.example.json) to `agentpay.config.json`
> and edit it. The real file is gitignored (it may hold a deployment template / API key).

## Precedence

Lowest → highest, identical in the Python SDK, the JS server reader and the TS client:

```
built-in / preset default
  → defaults.json            (localnet template addresses only — re-derived on each swarm reset)
  → agentpay.config.json     (this shared file)
  → AGENTPAY_* env var
  → explicit argument / CLI flag
```

A missing or unparseable file is **fail-soft**: every value simply falls through to the next source.

## Where the file is found

1. `AGENTPAY_CONFIG` — an explicit path (honored even if the file is absent).
2. `./agentpay.config.json` — the working directory.
3. the OS user-config directory:
   - Windows `%APPDATA%\agentpay\agentpay.config.json`
   - macOS `~/Library/Application Support/agentpay/agentpay.config.json`
   - Linux `~/.config/agentpay/agentpay.config.json` (honors `XDG_CONFIG_HOME`)

## Fields

| File key | Env var | Used by | Meaning |
|---|---|---|---|
| `network` | `AGENTPAY_NETWORK` | MCP, server | preset selector (`local` / `esmeralda`; unknown → must set `walletd_url`) |
| `walletd_url` | `AGENTPAY_WALLETD_URL` | MCP, server, SDK | wallet daemon JSON-RPC URL |
| `walletd_token` | `AGENTPAY_WALLETD_TOKEN` | SDK | least-privilege bearer token (non-custodial) |
| `budget_template` | `AGENTPAY_BUDGET_TEMPLATE` | MCP, server, SDK | AgentBudget template address |
| `owner_account` | `AGENTPAY_OWNER_ACCOUNT` | MCP, server, SDK | owner account name |
| `component` | `AGENTPAY_COMPONENT` | MCP, SDK | an already-open budget component (attach mode) |
| `agent_account` | `AGENTPAY_AGENT_ACCOUNT` | MCP, SDK | the agent's account (defaults to owner) |
| `agent_badge` | `AGENTPAY_AGENT_BADGE` | MCP, SDK | agent badge resource (derived on chain if omitted) |
| `proof_windows` | `AGENTPAY_PROOF_WINDOWS` | SDK | manifest dialect: 0.49 (`true`) vs 0.47 (`false`) |
| `api_url` | `AGENTPAY_URL` | HTTP consumer | base URL of the hosted service |
| `api_key` | `AGENTPAY_API_KEY` | HTTP consumer | the agent/admin API key |

> `walletd_token` also accepts the **deprecated** `OOTLE_WALLETD_TOKEN` env var for back-compat.

**Out of scope (env-only).** Web-server operational knobs — `PORT`, `HOST`, `SESSION_SECRET`,
`DASHBOARD_PASSWORD`, `AGENTPAY_API_KEYS`, rate limits, file paths — are deployment concerns, not
agent identity, and are **not** in the shared schema. See [`../web/DEPLOYMENT.md`](../web/DEPLOYMENT.md).

## Using it from each surface

**SDK (Python)** — factories read the shared source; base constructors stay pure:

```python
from agentpay.onchain import WalletdClient, OnChainBudget
client = WalletdClient.from_config()                 # walletd_url + walletd_token
budget = OnChainBudget.from_config(client)           # template / owner / component / badge
```

**SDK (TypeScript)**:

```ts
import { walletdFromConfig, budgetFromConfig, apiClientFromConfig } from "@agentpay/client";
const client = walletdFromConfig();
const budget = budgetFromConfig(client);
const api = apiClientFromConfig();                    // hosted /api/v1
```

**MCP server** — resolves the file automatically; generate host wiring without hand-editing JSON:

```bash
agentpay-mcp --emit-config --host claude     # or cursor | generic | http-json | http-env
agentpay-mcp --install     --host cursor     # merge into the host's config file (claude|cursor)
```

**HTTP consumer (any framework, e.g. OpenClaw)** — the agent holds only the capped API key:

```bash
agentpay-mcp --emit-config --host http-env   # prints AGENTPAY_URL=… / AGENTPAY_API_KEY=…
```

Drop those two lines into the framework's environment (or set `api_url` / `api_key` in
`agentpay.config.json`); the example clients in [`../examples/`](../examples/) read them directly.
