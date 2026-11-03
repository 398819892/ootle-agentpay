# AgentPay integration API (`/api/v1`)

A **machine-to-machine REST API** for AgentPay on Tari Ootle. The *owner* runs the hosted service
(the `web/` backend); third-party developers and autonomous agents integrate against it with an
**API key**. Every payment is capped and enforced **on chain** by the AgentBudget template — the
per-transaction cap, the per-window spending cap (fixed epoch window), the merchant whitelist and the kill switch are validator
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
| `POST /merchants`, `DELETE /merchants/:name`, `POST /budget/limits` | — | ✅ |
| `GET /audit` | — | ✅ |
| `GET /keys`, `POST /keys/:id/revoke` | — | ✅ |

An agent key hitting an admin endpoint gets **HTTP 403** (and the denial is audited). High-risk
admin operations (open budget, register merchant) are still subject to the backend's custody
boundary (kill switch, rate limit, audit). In the browser, those actions require a human *step-up*
re-confirmation; for machine-to-machine there is no human second factor, so **the admin API key is
itself the strong, out-of-band credential** that authorizes them — see
[docs/custody.md](custody.md) for the custody model.

### Revoking a key

At runtime, with an admin key: `POST /api/v1/keys/<id>/revoke` (and `GET /api/v1/keys` to list
`{ id, role, revoked }` for every configured key — never the secrets). The revocation is persisted
in the state file (`store.apiKeys.revoked`), so it survives a restart; a revoked key is rejected even
though it is still syntactically valid. Removing the key from `AGENTPAY_API_KEYS` and restarting
also works. Issuing or rotating keys over HTTP is still out of scope (below) — the key list lives in
the environment.

### Per-key on-chain sessions (API key → agent session badge)

A server-side revoke stops the *server* honouring a key. To make the **chain** refuse a key, give it
its own agent session badge: every key maps deterministically to the session label **`key-<id>`**
(no mapping table to keep in sync — whether that badge exists / is revoked is read from the budget's
session list, which follows confirmed chain transactions).

| Step | Call | On chain |
| --- | --- | --- |
| issue | `POST /api/v1/keys/<id>/session` *(admin)* | `issue_agent_badge("key-<id>")` via the owner badge (high-risk op: step-up + durable audit, like the dashboard's *issue session*) |
| pay | `POST /api/v1/payments` with that key | the pay proof carries **exactly** the `key-<id>` badge (`create_proof_by_non_fungible_ids`), so the `pay` event's `session` names the key |
| revoke | `POST /api/v1/keys/<id>/session/revoke` *(admin)* | `revoke_session("key-<id>")` — the validators reject every further pay from this key; other keys/sessions keep working |
| re-enable | `POST /api/v1/keys/<id>/session` again | mints the **next generation** `key-<id>.2`, `.3`, … — a revoked badge stays revoked for good (its non-fungible id cannot be minted twice: `revoke_session` marks it, it does not burn it); the key's current label is the highest generation in the budget's session list |

Which session signs a payment is decided by **who is calling** (the key id), never by the request
body — a client cannot pay as another key's session. A key whose badge has not been issued pays
through the budget's `"default"` session (backwards compatible); set
`AGENTPAY_REQUIRE_KEY_SESSIONS=true` to refuse such keys with `403` instead. A key whose session was
revoked on chain gets a `403` before any transaction is submitted (no fee spent on a certain reject).
Receipts carry the paying `session`, and `GET /api/v1/keys` shows each key's
`session: { label, issued, revoked }`.

> The dashboard's own session list shows `key-…` sessions like any other, and its *revoke session*
> button does the same on-chain revoke. Note that **all** clients now prove one specific badge by id:
> with several session badges in one account, a proof over the whole resource carries all of them and
> the template rejects it (`Present exactly one agent session badge`) — proving by id is what makes
> per-key sessions in a single agent account possible.

---

## Amounts, ids and idempotency

- **Amounts** are base-unit integers passed as **decimal strings** (BigInt-safe): `"250"`, not `250`.
  Values can exceed 2^53, so always send and compare them as strings.
- **Payment id** = the **idempotency key**. `POST /payments` **requires** an `Idempotency-Key`
  header (HTTP 400 without one): it becomes the payment id, and re-sending the same key **never
  submits a second chain transaction** — you get the original receipt back with `"replayed": true`.
  This is the failure-recovery contract: if your request times out, just retry with the same key.
  (Without the header a retried request would get a fresh server-generated invoice id and pay
  twice, which is why it is mandatory.) The same key with **different** parameters is a hard
  `409 idempotencyConflict`, never a silent replay.
- **`invoiceId`** (optional) must match `^[a-z0-9]{8,32}$`; the server generates one if omitted.

---

## Endpoints

Base URL: your deployment, e.g. `http://localhost:8787`. All paths below are under `/api/v1`.

### `GET /api/v1` — index (no auth)
Lists the endpoints, whether the API is enabled, and the spec URL.

### `GET /api/v1/openapi.json` — OpenAPI 3.0 spec (no auth)

### `POST /api/v1/payments` — make a capped payment  *(agent)*
Headers: `Idempotency-Key` (**required**). Body:

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
    "session": "key-bot1",
    "reason": null, "createdAt": "...", "updatedAt": "..."
  },
  "replayed": false
}
```

`session` is the agent session badge that signed the payment: the key's own `key-<id>` once issued
(see *Per-key on-chain sessions*), else `default`.

Other statuses: `400` bad request (incl. a missing `Idempotency-Key`) · `401` missing/invalid key ·
`403` the key's on-chain session is revoked, or (with `AGENTPAY_REQUIRE_KEY_SESSIONS`) not issued yet ·
`409` no budget open, or the same `Idempotency-Key` reused with different parameters
(`idempotencyConflict`) · `423` frozen (kill switch) · `429` rate limited.

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

### `DELETE /api/v1/merchants/:name` — remove from the whitelist, on chain  *(admin)*
Removes the merchant from the **on-chain** whitelist: the owner badge signs the template's
`remove_merchant`, so once the tx finalizes the validators refuse any payment to that address.
`:name` is a friendly name the service already knows, or a `component_…` address (URL-encoded). A
name that was never added is a `400` — nothing is auto-provisioned on this path. The local
name → address alias is kept so the merchant can be re-added by name later. Returns
`{ "removed": { "name", "address" }, "merchants": [ … ] }`: `200` once confirmed, `202` with
`pending: true` + `txId` when submitted but not yet confirmed (reconciled against chain like every
other op; poll `GET /merchants`).

### `POST /api/v1/budget/limits` — change the caps on chain  *(admin)*
Body: `{ "perTxCap": "500", "dailyCap": "2000" }` (amounts as strings, `perTxCap ≤ dailyCap`). One
owner-badge `set_limits` call. The new per-transaction cap binds on the very next payment; the daily
cap applies to the current rolling window (spend already counted in it is kept — this is not a
window reset). Returns `{ "budget": … }` read back from chain: `200` confirmed, `202` pending as
above.

### `GET /api/v1/audit?limit=100` — audit trail  *(admin)*
Recent append-only audit entries (secrets redacted). Every state-changing API call, and every denial
(bad key, insufficient role, frozen, rate-limited), is recorded with the acting key's `id`.

### `GET /api/v1/keys` — list API keys  *(admin)*
`{ "keys": [ { "id", "role", "revoked", "session": { "label", "issued", "revoked", "generation" } } ] }` —
metadata only, never a secret. `session` is the key's **current** on-chain agent session (`key-<id>`,
or `key-<id>.N` after N−1 re-enables) and whether it has been issued / revoked on chain.

### `POST /api/v1/keys/:id/revoke` — revoke a key at runtime  *(admin)*
Flips the persisted **server-side** revocation flag for `id` (404 if no such key is configured).
Returns the updated key list. The entry stays in `AGENTPAY_API_KEYS`; remove it there too when you
next restart. This does not touch the chain — see the next two endpoints for that.

### `POST /api/v1/keys/:id/session` — issue the key's on-chain session badge  *(admin)*
Mints the agent session badge `key-<id>` (owner-badge transaction; high-risk: step-up + durable audit).
`201 { id, session: { label, issued, revoked }, issued: true }` once confirmed, `202 … pending` if the
tx is still finalizing, `200 … already: true` if it was already issued, `404` unknown key, `409` no
budget open. After an on-chain revoke, issuing again mints the next generation (`key-<id>.2`, …) and
the key pays with that one from then on; the response's `session.generation` says which.

### `POST /api/v1/keys/:id/session/revoke` — revoke that session **on chain**  *(admin)*
`revoke_session("key-<id>")`: from the next block the validators reject every payment this key
signs, whatever the server does. `200 { id, session, revoked: true }` (or `already: true`),
`202 … pending`, `404` unknown key / no session issued, `409` no budget open.

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

- **Removing a merchant / changing the caps are owner-badge transactions, not instant.** Both are
  exposed (`DELETE /merchants/:name`, `POST /budget/limits`) and take effect when the tx finalizes;
  a payment that is already in flight on the old rules may still land. `set_limits` does not restart
  the rolling window — lower the daily cap below what is already spent and the next payment is
  refused until the window rolls over.
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
- **Key rotation & a self-serve key-management API** (issue/rotate keys over HTTP, key expiry).
  Listing and **revoking** keys over HTTP exists (`GET /keys`, `POST /keys/:id/revoke`); issuing new
  ones still means editing `AGENTPAY_API_KEYS` and restarting.
- **Fine-grained scopes** beyond `agent`/`admin` (e.g. per-merchant or per-amount keys).
- **Cursor pagination** on `GET /payments` and `GET /audit` (today both return a bounded recent set).
- **A separate signing microservice** so the web box holds no keys at all (see
  [docs/custody.md](custody.md) — the target custody architecture).
