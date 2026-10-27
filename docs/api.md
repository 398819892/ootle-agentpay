# AgentPay integration API (`/api/v1`)

A **machine-to-machine REST API** for AgentPay on Tari Ootle. The *owner* runs the hosted service
(the `web/` backend); third-party developers and autonomous agents integrate against it with an
**API key**. Every payment is capped and enforced **on chain** by the AgentBudget template — the
per-transaction cap, the rolling daily cap, the merchant whitelist and the kill switch are validator
rules, not server policy, so a compromised integrator (or a compromised web layer) cannot exceed
them. Integrators never talk to the wallet daemon and never hold keys.

- **Reference** (this document) · **Integration guide** (below) · **Machine spec**:
  `GET /api/v1/openapi.json` → [`web/public/openapi.json`](../web/public/openapi.json)
- **Examples**: [`examples/`](../examples/) (curl · Node · Python)
- **Thin clients**: TypeScript [`clients/ts/src/api.ts`](../clients/ts/src/api.ts) · Python
  [`examples/agentpay_api.py`](../examples/agentpay_api.py)

This is **testnet-grade**. The surface is versioned (`/api/v1`); things deliberately left for later
are listed under [Out of scope](#out-of-scope-todo).

---

## How it fits the rest of the system

The API is a **second, independent entry surface** on the existing hardened backend. It does **not**
re-implement any chain logic — it reuses the same internals the browser dashboard uses:

| Concern | Reused component | Where |
| --- | --- | --- |
| The single audited exit to the chain | restricted **authorizer** (whitelist / kill switch / rate-limit / step-up) | `web/server/authorizer.js` |
| Payment lifecycle + idempotency | **tx journal** (`pending → confirmed \| rejected \| unknown`) | `web/server/txlog.js` |
| Balances / caps / spend | **chain-authoritative reads** | `readChainBudget` in `web/server/server.js` |
| Operator trail | **append-only audit log** | `web/server/audit.js` |

The browser dashboard (session cookie + CSRF) and the API (bearer key) coexist and don't interfere:
a `/api/v1/*` request is dispatched **before** the cookie/CSRF/login gate and authenticates with a
key instead. Enabling the API does not weaken the dashboard's auth, and the dashboard keeps working
unchanged.

```
 third-party app / AI agent ──API key──▶ /api/v1/* ─┐
                                                     ├─▶ authorizer ─▶ txlog ─▶ walletd ─▶ chain
 human operator ──cookie+CSRF──▶ dashboard /api/* ──┘        │
                                                             └─▶ audit log  (chain = source of truth)
```

---

## Authentication

Present an API key on every call (except the public index and spec), either header works:

```
Authorization: Bearer <key>
X-API-Key: <key>
```

The surface is **disabled** (HTTP 503) until the owner configures at least one key. Keys live in the
environment variable `AGENTPAY_API_KEYS`, comma- or newline-separated, each `role:id:secret`:

```bash
AGENTPAY_API_KEYS="agent:bot1:sk_agent_<32+hex>, admin:ops:sk_admin_<32+hex>"
```

- `role` — `agent` or `admin` (drives tiered access, below).
- `id` — a short, **non-secret** label (`[A-Za-z0-9_.-]`, ≤48). It appears in the audit log; the
  secret never does.
- `secret` — the bearer value the client sends (≥16 chars; generate it with
  `openssl rand -hex 24`). Only its SHA-256 digest is held in memory, and key verification is
  constant-time.

### Roles (tiered access)

| Capability | agent | admin |
| --- | :---: | :---: |
| `GET /budget`, `GET /merchants`, `GET/POST /payments`, `GET /payments/:id` | ✅ | ✅ |
| `POST /budgets` (open/fund a budget) | — | ✅ |
| `POST /merchants`, `DELETE /merchants/:name` | — | ✅ |
| `GET /audit` | — | ✅ |

An agent key hitting an admin endpoint gets **HTTP 403** (and the denial is audited). High-risk
admin operations (open budget, register merchant) are still subject to the backend's custody
boundary (kill switch, rate limit, audit). In the browser, those actions require a human *step-up*
re-confirmation; for machine-to-machine there is no human second factor, so **the admin API key is
itself the strong, out-of-band credential** that authorizes them — see
[docs/custody.md](custody.md) for the custody model.

### Revoking a key

Add the key's `id` to `store.apiKeys.revoked` (persisted in the state file) — e.g. remove the key
from `AGENTPAY_API_KEYS` and restart, or revoke at runtime via the backend's `apiKeys.revoke(id)`.
A revoked key is rejected even though it is still syntactically valid. (A convenience admin endpoint
for revocation is a planned follow-up — see [Out of scope](#out-of-scope-todo).)

---

## Amounts, ids and idempotency

- **Amounts** are base-unit integers passed as **decimal strings** (BigInt-safe): `"250"`, not `250`.
  Values can exceed 2^53, so always send and compare them as strings.
- **Payment id** = the **idempotency key**. Send an `Idempotency-Key` header (recommended) and that
  becomes the id; otherwise the server derives a stable id from the invoice. Re-sending the same key
  **never submits a second chain transaction** — you get the original receipt back with
  `"replayed": true`. This is the failure-recovery contract: if your request times out, just retry
  with the same key.
- **`invoiceId`** (optional) must match `^[a-z0-9]{8,32}$`; the server generates one if omitted.

---

## Endpoints

Base URL: your deployment, e.g. `http://localhost:8787`. All paths below are under `/api/v1`.

### `GET /api/v1` — index (no auth)
Lists the endpoints, whether the API is enabled, and the spec URL.

### `GET /api/v1/openapi.json` — OpenAPI 3.0 spec (no auth)

### `POST /api/v1/payments` — make a capped payment  *(agent)*
Headers: `Idempotency-Key` (recommended). Body:

```json
{ "merchant": "shop", "amount": "250", "memo": "order #4821", "invoiceId": "optional", "agentTag": "optional" }
```

Response — a **receipt**, with an HTTP status that reflects the chain verdict:

| HTTP | `receipt.status` | meaning |
| --- | --- | --- |
| 201 | `confirmed` | finalized Accept on chain |
| 402 | `rejected` | finalized Reject (over a cap / not whitelisted / revoked) — **still a receipt**, with `reason` |
| 202 | `pending` / `unknown` | submitted, not yet confirmed — poll `GET /payments/:id` |

```json
{
  "receipt": {
    "id": "order-4821", "status": "confirmed", "txId": "...",
    "amount": "250", "merchant": "component_...", "merchantName": "shop",
    "memo": "order #4821", "invoiceId": "a1b2c3d4e5f6a7b8",
    "reason": null, "createdAt": "...", "updatedAt": "..."
  },
  "replayed": false
}
```

Other statuses: `400` bad request · `401` missing/invalid key · `409` no budget open · `423` frozen
(kill switch) · `429` rate limited.

### `GET /api/v1/payments` — list receipts  *(agent)*
`{ "payments": [ Receipt, … ] }`.

### `GET /api/v1/payments/:id` — one receipt / status  *(agent)*
Returns the receipt for a payment id. If it is still open, the server settles it against chain
(read-only `get_result`) before replying, so polling tracks the chain. `404` if unknown.

### `GET /api/v1/budget` — budget status  *(agent)*
All figures are **chain-derived**; `source` records the provenance of each.

```json
{ "budget": { "component": "...", "perTxCap": "1000", "dailyCap": "1500", "spent": "1303",
  "dailyRemaining": "197", "treasury": "8697", "balance": "8697", "revoked": false, "frozen": false,
  "window": { … }, "whitelist": [ { "address": "...", "name": "shop" } ],
  "funded": "...", "withdrawn": "...", "source": { "treasury": "chain", … } } }
```

### `POST /api/v1/budgets` — open/fund a budget  *(admin)*
Owner-side provisioning. Body: `{ "fund", "perTxCap", "dailyCap", "epochsPerWindow"?, "whitelist"? }`
(amounts as strings). `409` if a budget is already open.

### `GET /api/v1/merchants` — the whitelist  *(agent)*
`{ "merchants": [ { "address", "name" } ], "source": "chain" }`.

### `POST /api/v1/merchants` — add to the whitelist  *(admin)*
Body: `{ "merchant": "coffee-bar" }` (friendly name or `component_…` address). Returns the updated
whitelist.

### `DELETE /api/v1/merchants/:name` — remove a merchant alias  *(admin)*
Removes the local friendly-name → address mapping. **See [Known limitations](#known-limitations):**
this template has no on-chain whitelist-remove, so the address stays spendable on chain until you
revoke the agent or open a new budget. The response says so explicitly.

### `GET /api/v1/audit?limit=100` — audit trail  *(admin)*
Recent append-only audit entries (secrets redacted). Every state-changing API call, and every denial
(bad key, insufficient role, frozen, rate-limited), is recorded with the acting key's `id`.

---

## Integration guide — an external AI agent on AgentPay

The typical shape: an **owner** funds a budget and sets the rules; an **agent** (your code or an
autonomous AI) spends inside those rules via the API.

1. **Owner provisions** (admin key, once): open a budget and whitelist the merchants the agent may
   pay.
   ```bash
   curl -X POST "$URL/api/v1/budgets" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
     -d '{"fund":"10000","perTxCap":"1000","dailyCap":"1500","epochsPerWindow":10,"whitelist":["shop"]}'
   ```
2. **Owner issues an agent key** and hands it to the integrator. The agent key can pay and read, but
   cannot change the rules.
3. **Agent checks headroom** before acting: `GET /budget` → `dailyRemaining`, `perTxCap`.
4. **Agent pays** with an idempotency key it controls (e.g. your order id):
   ```
   POST /payments  Idempotency-Key: order-4821  { "merchant":"shop", "amount":"250" }
   ```
   - On `201` you have a confirmed receipt. On `402` the **chain** refused it (cap/whitelist/revoke)
     — inspect `receipt.reason`; this is normal, enforce-by-chain behaviour, not an outage.
   - On a transport error or timeout, **retry with the same `Idempotency-Key`**. You will get the
     original receipt, never a double charge.
5. **Agent tracks status** by polling `GET /payments/:id` until `status` is terminal
   (`confirmed`/`rejected`). The thin clients' `waitForPayment` / `wait_for_payment` do this for you.
6. **Recovery after a crash**: your durable key is the idempotency key. Re-issue the same request;
   the server reconciles any in-flight transaction against the chain and returns the true outcome —
   it never reports an unconfirmed transaction as success.

The on-chain budget is the backstop: even a buggy or hostile agent cannot exceed the caps, pay a
non-whitelisted merchant, or spend after a `revoke`. Treat the API's limits as convenience and the
chain's as truth.

### Language starting points
- **curl**: [`examples/README.md`](../examples/README.md)
- **Node** (zero-dep): [`examples/node_agent.mjs`](../examples/node_agent.mjs); typed client
  `import { AgentPayApiClient } from "@agentpay/client"` ([`clients/ts/src/api.ts`](../clients/ts/src/api.ts))
- **Python** (stdlib): [`examples/agentpay_api.py`](../examples/agentpay_api.py) —
  `from agentpay_api import AgentPayApi`

---

## Known limitations

- **No on-chain whitelist removal.** The current AgentBudget template exposes `add_whitelist` but no
  remove. `DELETE /merchants/:name` therefore only drops the local friendly-name alias; to actually
  stop payments to an address, `revoke` the agent or open a new budget. (Tracked for the template.)
- **No cap change in place.** Changing `perTxCap`/`dailyCap` means opening a new budget; there is no
  update-caps endpoint because the template has no such method.
- **Keep the client and the deployed template in step.** `pay` is driven by a transaction manifest,
  so the client (SDK / TS / web) must match the AgentBudget template deployed on the swarm. A real
  confirmed payment on the current multi-session template **is** exercised end-to-end — `POST
  /api/v1/payments` returns a `201 confirmed` receipt and the funds move on chain — and the
  `scripts/e2e_onchain_pay.py` integration test (run with `make e2e` against a local swarm) asserts
  exactly that, so a client/template mismatch shows up as a red test rather than a silent reject.
  (Earlier builds hit two such mismatches, both now fixed: a `pay` arg-count change, and the
  multi-session agent badge where the client proved the wrong badge resource — "Proof of resource
  did not match". The badge the template authorizes is now read from the component's on-chain state,
  never guessed from address sort order.) If `pay` ever finalizes as *Reject*, the API still handles
  it as designed: a `rejected` receipt carrying the chain's own reason.

## Out of scope (TODO)

Deliberately not in this round; the surface is versioned so these can land without breaking clients:

- **Per-key rate limits & quotas** (today the backend throttles per actor globally; there is no
  per-key spend quota beyond the on-chain caps).
- **Webhooks / callbacks** on payment settlement (today clients poll `GET /payments/:id`).
- **Key rotation & a self-serve key-management API** (issue/rotate/revoke keys over HTTP, key
  expiry). Revocation today is via the persisted revocation set.
- **Fine-grained scopes** beyond `agent`/`admin` (e.g. per-merchant or per-amount keys).
- **Cursor pagination** on `GET /payments` and `GET /audit` (today both return a bounded recent set).
- **A separate signing microservice** so the web box holds no keys at all (see
  [docs/custody.md](custody.md) — the target custody architecture).
