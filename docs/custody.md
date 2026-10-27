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

## 4. State model & reconciliation — the chain is the authority

**Problem this fixes.** The dashboard used to treat a local JSON file as the *authority* for the
budget's money: it tracked `funded`, `withdrawn` and a local ledger and computed
`treasury = funded − spent − withdrawn`, rebuilding its whole picture from that file. A local file is
not on-chain truth. It drifts on a crash, an unconfirmed or timed-out submit, an external payment, or
a second instance; a serial in-process lock prevents interleaving within one process but is no
substitute for reconciliation, idempotency and state recovery. Worse, the persist step only *warned*
on failure — a request could succeed while its state was never written.

**Principle.** The local file is, at most, an **operation journal** — a durable record of what the
server asked the chain to do and what it last heard back. It is **never** the source of truth for
balances. Money state is read **live from chain** every time.

### 4.1 Chain-authoritative reads (`readChainBudget` in `web/server/server.js`)

On every `/api/state`, the displayed figures are derived from chain, not accumulated locally:

| Figure | Source |
|---|---|
| **treasury** | the budget **vault substate**'s balance (`vault_…` → `revealed_amount`), exact (string/BigInt) |
| **spend-in-window** | the component substate's `spent_in_window` scalar |
| **per-tx / daily cap** | the component substate's cap scalars |
| **whitelist** | the component substate's address list |
| **revoked** | the component substate's flag |
| **window / reset ETA** | component epochs + current epoch (`windowStatus`) |

The AgentBudget component state is a positional array
`[vault, agentBadgeRes, ownerBadgeRes, perTxCap, dailyCap, spentInWindow, windowStartEpoch,
epochsPerWindow, [whitelist…], revoked, …]`; the vault is a child substate read for its balance.
Each response carries a `budget.source` map stating whether each figure came from `chain` or a
`cache` fallback, so a reviewer (and the UI) can see what is authoritative. Only the **historical**
`funded` / `withdrawn` totals and the **payment ledger** come from the journal — because the chain
exposes no lifetime total — and they are labelled as such.

### 4.2 Transaction lifecycle + idempotency (`web/server/txlog.js`)

Every fund-moving op gets **one journal record**, keyed by an **idempotency key**, with an explicit
lifecycle:

```
pending ─submit→ (await finalize) ─accept→ confirmed
                                  ─reject→ rejected
                                  ─timeout→ unknown ──reconcile──→ confirmed | rejected
```

- **pending** is persisted *before* the chain submit, so a crash mid-flight leaves a reconcilable
  trace (it carries the tx id once known).
- **unknown** = submitted but no verdict within the confirmation window. It is **never** treated as
  success; the response is `pending: true`, and the record is settled later by its tx id. The window
  is `AGENTPAY_FINALIZE_TRIES × AGENTPAY_FINALIZE_DELAY_MS` (client option on `WalletdClient`).
- **Idempotency:** a repeat with the same key returns the recorded outcome instead of re-submitting —
  so a double-clicked button or a retried HTTP request does not double-spend. For payments the key
  defaults to the **invoice id** (pay-the-same-invoice-twice is deduped); other ops accept an explicit
  `idempotencyKey`. Records are scoped by budget `component` so history never leaks across budgets.
- The client capture that makes this possible is a minimal, read-only-friendly addition to
  `clients/ts` (`WalletdClient.lastTxId`, `getResult(txId)`, a configurable finalize budget, and a
  `submit()` split); `run()`'s default behaviour is unchanged.

### 4.3 Startup reconciliation

On boot (and via `POST /api/reconcile`), every record left `pending`/`unknown` by a previous run is
settled against the chain by its tx id (`get_result`, read-only) → `confirmed`/`rejected`, or left
open if the chain still has no verdict. The ledger is then rebuilt from confirmed on-chain `pay`
events, not from any local running total.

### 4.4 Atomic, non-silent persistence

`writeJsonAtomic` writes to a temp file, `fsync`s, then atomically renames over the target — a crash
leaves the old or the new file, never a torn one. A failed write **throws**, so the request that
triggered it cannot report success (closing the old "warn-and-return-200" bug). Both the state
snapshot and the journal persist this way.

### 4.5 Verified on the local swarm

A self-contained harness (`node` driving the real server against isolated state files) checks, green:
① displayed treasury/spend/caps/ledger equal live `substates.get` reads (`8697` / `1303`, ledger sum
= spend) — not local accumulation; ② the same idempotency key submits **one** on-chain tx and replays
the stored outcome; ③ a restart reconciles an `unknown` record to its chain verdict and rebuilds the
ledger from chain; ④ a zero-window submit is recorded `unknown` (never success); plus a fresh
`createBudget` whose treasury equals the freshly-funded chain vault, and the atomic/throwing-persist
unit checks. (On this restarted swarm the on-chain `pay`/owner methods reject due to a pre-existing
template-version drift — unrelated to this change — so the money-op evidence uses real submitted
transactions that finalize as *reject*; a reject is a real finalized tx and exercises the full
lifecycle identically to an accept, which the fresh-budget case demonstrates.)

### 4.6 Still missing here (noted, not done)

- [ ] **Event subscription / block scan.** The ledger is rebuilt from the journal's confirmed `pay`
      events, not from an independent scan of all `pay` events for the component. walletd exposes no
      "list events for a component" RPC, so a payment made **outside** this server (by another client
      holding the agent badge) would not appear until such a scan or an indexer subscription exists.
      The authoritative *balances* (treasury, spend-in-window) still reflect it immediately.
- [ ] **Multi-instance coordination.** The serial lock, the journal file and reconciliation are
      per-process. Two instances sharing a budget need a shared journal + a distributed lock (or an
      on-chain idempotency guard) to stay safe; today this is single-instance.
- [ ] **On-chain idempotency.** Dedup is server-side; the template does not reject a replayed invoice
      id on chain. A fully compromised/duplicated server could still submit twice.
- [ ] **Large-value read precision.** Caps/spend read back from the CBOR substate as JS numbers
      (precision loss above 2^53 on the read path only); treasury is exact (string). Amounts on the
      *write* path are already BigInt-exact end to end.

---

## 5. Still missing (honest to-do before production / high value)

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

## 6. One-line summary

The chain stops the **agent** from overspending; this pass stops a compromised **web layer or stolen
session** from quietly doing owner-level damage — by funnelling every signature through one reviewed,
rate-limited, audited gate with a second factor on high-risk actions and a global kill switch — while
being explicit that true key isolation (separate signer + HSM + multisig) is still future work.
