# Custody & key-boundary hardening / 托管与密钥边界硬化

> **Status: testnet hardening, NOT production-grade.** This document describes the custody model of
> the AgentPay dashboard (`web/`), what this hardening pass actually changed, and — honestly — what
> is still missing before this should hold value on a public, value-bearing network. Read it
> alongside [`security.md`](security.md) (which covers what the *chain* enforces) and
> [`../web/DEPLOYMENT.md`](../web/DEPLOYMENT.md) (how to deploy).

---

## 1. The problem: this is a custodial service

The dashboard backend (`web/server/server.js`) is a **hosted / custodial wallet**. The browser never
talks to walletd; it talks to this backend, and the backend drives the chain through walletd, which
holds the keys and signs. That means:

```
browser ──HTTPS──> dashboard backend ──JSON-RPC──> walletd (HOLDS KEYS, SIGNS) ──> Ootle L2
            (session cookie)          (no auth on the local socket)
```

The on-chain `AgentBudget` template already constrains the **agent**: per-tx cap, rolling daily cap,
merchant whitelist, global revoke and per-session revoke are all validator-enforced and a compromised
*agent client* cannot exceed them (see `security.md`). **But the owner side is a separate attack
surface.** Whoever can make this backend call walletd can, within the chain's rules:

- move the agent's money (`pay`, `top_up`),
- **and with owner authority** change the whitelist, revoke, mint new agent badges, and **withdraw
  the treasury to the owner account**.

So the real custody questions are not "can the agent overspend" (the chain handles that) but:

1. Who/what can make the backend sign? (authn + the key boundary)
2. If the web layer is compromised, how big is the blast radius? (least privilege)
3. Can one stolen session or one bad operator drain or re-point funds? (second factor, approvals)
4. Can we *stop* the bleeding fast, and *reconstruct* what happened? (kill switch + audit)

This pass addresses 2–4 pragmatically in-process, and documents the target for 1.

---

## 2. Target architecture (where this is heading)

```
                 ┌─────────────────────────────────────────────────────────────┐
                 │  TARGET (not fully built — see §4 "still missing")            │
                 │                                                               │
  operators ──►  │  Web API box            Signing service          Key store    │
                 │  (no keys)      ──mTLS──►  (own authn,     ──►   HSM / KMS     │
                 │  authz + audit            policy, quorum)        (non-exportable)│
                 │  rate limit               approves per-op                      │
                 │  kill switch                                                   │
                 └─────────────────────────────────────────────────────────────┘
```

The end state separates **the box that takes web requests** from **the box that can sign**, so that
compromising the web tier yields *no keys* and only the ability to *ask* the signing service — which
has its own authentication, its own copy of the policy, and (for high-value ops) a human/quorum
approval step. Keys live in an HSM/KMS and are never exportable.

### This pass builds the in-process version of that boundary

We did not stand up a second service in this pass. Instead we introduced a **restricted authorizer**
*inside* the backend that models the same contract, so the move to a separate service is a transport
change rather than a redesign:

```
request handler ─► authz.execute("withdraw", args, ctx) ─► [whitelist][kill switch][rate limit][step-up][audit] ─► walletd
                     (handlers can NOT call walletd directly)
```

---

## 3. What this pass changed (in `web/`)

All of the following is zero-dependency Node (`node:*` only), enabled without breaking local dev.

### 3.1 Restricted authorizer — the single, audited chain exit
`web/server/authorizer.js` + the `OPS` registry in `server.js`.

- Every chain-touching mutation is a **named operation in a fixed registry**: `createBudget`, `pay`,
  `addMerchant`, `withdraw`, `topUp`, `revoke`, `issueSession`, `revokeSession`, `resetLocal`,
  `freeze`, `unfreeze`. The `run()` of each is **the only code that drives walletd**.
- Request handlers no longer call walletd directly — they call `authz.execute(opName, args, ctx)`.
  An **unknown opName is refused** (403). A compromised request path therefore cannot invoke an
  arbitrary wallet call; it is confined to this reviewed set.
- Each op declares a **risk tier** (`read` / `money` / `admin`) and whether it is `highRisk`.

### 3.2 High-risk tiering + step-up confirmation (second factor)
- **Read** (`state`, `dry-run`, `connect`, `audit`): no gate.
- **Money** (`pay`, `topUp`): rate-limited + audited + kill-switchable, no second factor (so an agent
  keeper can operate).
- **Admin / high-risk** (`withdraw`, `revoke`, `addMerchant`, `issueSession`, `revokeSession`,
  `createBudget`, `resetLocal`, `freeze`, `unfreeze`): require a **step-up confirmation that is
  independent of the login session**. The operator re-presents the admin secret to
  `POST /api/confirm`, which mints a **short-lived (120 s), single-use, op-bound HMAC token**; the
  op is refused (401 `confirmRequired`) without a valid token. Stealing a live session cookie is
  therefore **not enough to move funds** — you must also know the admin secret, right now, for that
  specific action. A distinct `AGENTPAY_ADMIN_PASSWORD` separates "can operate/read" from "can move
  funds"; if unset it falls back to `DASHBOARD_PASSWORD`.
- The step-up is active whenever auth is on. In open local-dev mode (no password) there is no secret
  to step up with, so it is a no-op and the dev experience is unchanged.

### 3.3 Append-only audit log
`web/server/audit.js`, written to `AGENTPAY_AUDIT_FILE` (default `web/server/audit.log`).

- **Every state-changing call** writes one JSON line: timestamp, actor (`op:<sid8>` / `local`),
  session id, client IP, op, tier, params summary, result (`ok` / `error` / `denied`), tx id and any
  anomaly flags. Denials (frozen, rate-limited, confirmation-required, unknown-op, bad admin
  password) are logged too, as is login.
- **Secrets never reach the log**: a redactor strips any `pass*/secret*/token*/cookie*/keyring*`
  field before writing, and the per-op params summaries carry no secrets by construction.
- Best-effort durability: a failed audit write is logged to stderr but never breaks the operation.

### 3.4 Emergency stop (global kill switch)
`POST /api/freeze` / `POST /api/unfreeze` (persisted in `store.frozen`).

- When frozen, **every money/admin op is refused** (423); **read-only views keep working**.
- This is **distinct from a single budget's on-chain `revoke`**: revoke stops the *agent* on *that*
  budget on chain; freeze stops the *whole dashboard's* ability to move *any* funds (payments,
  top-ups, withdrawals, new budgets), instantly, at the custody layer, and is **reversible**. Use it
  if you suspect the server or an operator account is compromised.
- The UI shows a persistent banner while frozen and a Freeze/Unfreeze control in Governance.

### 3.5 Fund-movement rate limiting + anomaly flags
`createRateLimiter` in `authorizer.js` (separate from the existing login throttle).

- Per-actor sliding windows: a cap on **all** state-changing ops and a **stricter cap on money ops**
  (defaults: 40/min all, 12/min money). Exceeding a cap → 429 + audit `rate_limited`.
- **Anomaly flags** (annotate, don't block): a `burst` of money ops in a short window, and
  (if `AGENTPAY_ANOMALY_AMOUNT` is set) an unusually `large_amount`. Flags are written to the audit
  line and surfaced on the response.

### 3.6 Secret / credential hygiene
- All secrets come from **environment variables, never hardcoded, never logged**:
  `DASHBOARD_PASSWORD`, `AGENTPAY_ADMIN_PASSWORD`, `SESSION_SECRET`, and the walletd keyring
  passphrase (`WALLETD_KEYRING_PASSWORD`, consumed by walletd, not by this app). Passwords are
  compared with a constant-time hash; failed attempts are never logged with their value.
- Startup prints **warnings** (never the secret) when `SESSION_SECRET` is ephemeral, when
  `AGENTPAY_ADMIN_PASSWORD` is unset (so step-up reuses the login password), and when
  `DASHBOARD_PASSWORD` still looks like the `.env.example` placeholder.
- **Storage / backup / rotation policy:**
  - Store secrets in the platform's secret manager (or a `web/.env` with `chmod 600`), **never** in
    the image, the repo, or compose files checked into git. `web/.env` and `web/server/audit.log`
    and `state.json` are git-ignored.
  - **Rotate** `SESSION_SECRET` to force-log-out all sessions; rotate `DASHBOARD_PASSWORD` /
    `AGENTPAY_ADMIN_PASSWORD` on any suspected compromise or operator change; rotate the walletd
    keyring passphrase per your wallet's procedure. Rotating `SESSION_SECRET` also invalidates any
    outstanding confirm tokens.
  - **Back up** the walletd keyring (that is what controls the funds) encrypted and off-box. The
    dashboard's `state.json` is only a convenience cache of the on-chain budget reference — it is
    **not** authoritative and can be rebuilt; do not treat it as a backup of funds.
  - **Ship the audit log off-box** to an append-only sink (the local file is a starting point, not a
    tamper-proof store — see §4).

### 3.7 Account isolation
- The funding/owner account is configurable via `AGENTPAY_OWNER_ACCOUNT` (today it defaults to
  `default` for local dev). **Recommended topology for anything real:**
  - Use a **dedicated owner/treasury account** per deployment, *not* the wallet's `default`
    account, so the dashboard's blast radius is one purpose-built account rather than the whole
    wallet. Fund it with only what the agent program needs in the near term; sweep surplus to cold
    storage.
  - Keep **merchant accounts separate** from the owner account (they already are — merchants are
    distinct components), and disable auto-create in production (`AGENTPAY_AUTO_CREATE_MERCHANTS=
    false`, already the default when a password is set) so the endpoint can't be used to mint/fund
    accounts.
  - Longer term, give the signing service its **own** operating account distinct from the treasury,
    and require the step-up/quorum for any movement between them.

---

## 4. Still missing (honest to-do before production / high value)

This pass **shrinks the attack surface and makes incidents stoppable and reconstructable**. It does
**not** make the backend a non-custodial or production-grade signer. Before this holds real value:

- [ ] **Separate signing microservice.** Move signing off the web box entirely; the web tier holds
      no keys and can only *ask* the signer over mTLS. (This pass built the in-process authorizer
      boundary that this step would sit behind.)
- [ ] **HSM / KMS-backed keys**, non-exportable; the walletd keyring on disk is the current weak
      point.
- [ ] **Multisig / quorum approval** for withdrawals and limit/rule changes — one admin secret is
      still a single point of compromise. The step-up token is a second *factor*, not a second
      *person*.
- [ ] **Tamper-evident, off-box audit.** The current log is a local append-only file an attacker
      with box access could still alter or delete; ship to a WORM/append-only sink and consider
      hash-chaining entries.
- [ ] **Per-operator identities and roles** (real accounts, not one shared password), so the audit
      trail names a person and roles can be least-privileged.
- [ ] **Withdrawal allow-list / velocity limits enforced on chain**, not just advisory server-side
      rate limits, so a fully compromised custody stack still can't drain beyond policy.
- [ ] **Alerting** on anomaly flags and denials (today they are logged, not paged).
- [ ] **Confirm-token / session store shared across replicas** (both are currently in-process, so
      single-instance only; a multi-replica deployment needs a shared store).
- [ ] Independent security review of the custody stack (this is self-assessed).

---

## 5. One-line summary

The chain stops the **agent** from overspending; this pass stops a compromised **web layer or stolen
session** from quietly doing owner-level damage — by funnelling every signature through one reviewed,
rate-limited, audited gate with a second factor on high-risk actions and a global kill switch — while
being explicit that true key isolation (separate signer + HSM + multisig) is still future work.
