# AgentPay integration examples

Copy-paste examples for calling a **hosted AgentPay service** from a third-party app or an
autonomous agent. You call the owner's HTTP API with an **API key**; the on-chain AgentBudget
enforces the per-transaction cap, rolling daily cap, merchant whitelist and kill switch. You never
touch the wallet daemon and never hold keys.

> Full reference + integration guide: [`docs/api.md`](../docs/api.md). Machine spec:
> `GET /api/v1/openapi.json` (also [`web/public/openapi.json`](../web/public/openapi.json)).

The owner issues you a key out of band. Keys have a role:
- **agent** — make payments and read (budget, payments, whitelist).
- **admin** — all of the above **plus** open a budget, register merchants, read the audit log.

Set these once:

```bash
export AGENTPAY_URL=http://localhost:8787      # the hosted service
export AGENTPAY_API_KEY=sk_agent_xxxxxxxxxxxx  # your agent key
```

---

## curl

**Budget status** (what are my caps, what's left this window):

```bash
curl -s "$AGENTPAY_URL/api/v1/budget" -H "Authorization: Bearer $AGENTPAY_API_KEY"
```

**Make a capped payment** — note the `Idempotency-Key` so a retry can't double-spend:

```bash
curl -s -X POST "$AGENTPAY_URL/api/v1/payments" \
  -H "Authorization: Bearer $AGENTPAY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-4821" \
  -d '{"merchant":"shop","amount":"250","memo":"order #4821"}'
```

You get a **receipt**: `{ "receipt": { "id", "status", "txId", "amount", "merchant", "reason", … }, "replayed" }`.
`status` is one of `confirmed` / `rejected` / `pending` / `unknown`. A payment over a cap or to a
non-whitelisted merchant comes back `rejected` with a `reason` — that is a valid receipt, HTTP 402.

**Track status / fetch a receipt** (the server settles it against chain on read):

```bash
curl -s "$AGENTPAY_URL/api/v1/payments/order-4821" -H "Authorization: Bearer $AGENTPAY_API_KEY"
```

**Idempotent retry** — resend the exact same `Idempotency-Key`; you get the first receipt back and
the chain is **not** charged again:

```bash
curl -s -X POST "$AGENTPAY_URL/api/v1/payments" \
  -H "Authorization: Bearer $AGENTPAY_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-4821" \
  -d '{"merchant":"shop","amount":"250","memo":"order #4821"}'
# → same receipt.id, "replayed": true
```

**List payments:**

```bash
curl -s "$AGENTPAY_URL/api/v1/payments" -H "Authorization: Bearer $AGENTPAY_API_KEY"
```

**Admin only** (needs an admin key — an agent key gets HTTP 403):

```bash
# register a merchant on the whitelist
curl -s -X POST "$AGENTPAY_URL/api/v1/merchants" \
  -H "Authorization: Bearer $AGENTPAY_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"merchant":"coffee-bar"}'

# read the audit trail
curl -s "$AGENTPAY_URL/api/v1/audit?limit=20" -H "Authorization: Bearer $AGENTPAY_ADMIN_KEY"
```

---

## Node (zero dependencies, no build)

```bash
AGENTPAY_URL=$AGENTPAY_URL AGENTPAY_API_KEY=$AGENTPAY_API_KEY \
  node examples/node_agent.mjs shop 250
```

See [`node_agent.mjs`](node_agent.mjs) — budget → pay → poll → idempotent retry, with raw `fetch`.

A typed client is also published by the package: `import { AgentPayApiClient } from "@agentpay/client"`
(see [`clients/ts/src/api.ts`](../clients/ts/src/api.ts)).

## Python (standard library only, no pip install)

```bash
AGENTPAY_URL=$AGENTPAY_URL AGENTPAY_API_KEY=$AGENTPAY_API_KEY \
  python3 examples/agentpay_api.py
```

[`agentpay_api.py`](agentpay_api.py) is both a runnable demo and an importable thin client
(`from agentpay_api import AgentPayApi`).

---

## For the owner: enabling the API

The API is **off** until you configure at least one key. Set `AGENTPAY_API_KEYS` (comma/newline
separated `role:id:secret`) in the service's environment:

```bash
AGENTPAY_API_KEYS="agent:bot1:sk_agent_$(openssl rand -hex 24), admin:ops:sk_admin_$(openssl rand -hex 24)"
```

Give the `agent` secret to your integrators; keep the `admin` secret for provisioning. Revocation and
the full operator guide are in [`docs/api.md`](../docs/api.md) and [`web/DEPLOYMENT.md`](../web/DEPLOYMENT.md).
