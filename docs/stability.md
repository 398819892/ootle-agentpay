# Stability & reliability verification (B-6)

> **Honest summary.** The AgentPay dashboard backend's money pipeline (chain-authoritative reads +
> transaction journal with `pending → confirmed | rejected | unknown` + idempotency keys + startup
> reconciliation, from A-1/A-2/A-3) was put under soak, fault injection, crash recovery, multi-instance
> concurrency and retry/timeout tests. **Single-instance behaviour is sound:** no state drift, no leak,
> no double-spend, unconfirmed outcomes are never counted as success, and a crash mid-flight recovers
> correctly against the chain. The multi-instance suite originally surfaced **two findings** (double-submit
> of the same idempotency key, and shared-journal clobber). **Both are now fixed for instances that share
> one filesystem** (the scenario the suite reproduces) via a cross-process filesystem **claim** before
> submit + a merge-under-lock journal persist — see "Bugs found" and suite 5. **One limit remains:**
> instances on **different hosts** with separate filesystems still need a real shared store (DB/Redis) +
> distributed lock; the filesystem claim cannot coordinate across hosts. The on-chain caps are the real
> backstop and hold even when the hosted layer races. This is a verification report, not a "ship it" —
> see the go-live gate.

## How this was tested (and why it is safe)

Everything runs the **unmodified** dashboard backend (`web/server/server.js`) against a **controllable
mock wallet daemon** (`scripts/stability/mock_walletd.js`) — never the resident local swarm.

- The mock speaks the exact JSON-RPC surface `WalletdClient` (clients/ts) calls, and is
  **chain-authoritative in the same shape the backend parses**: the budget component is a positional
  state array, the vault is a child substate exposing `revealed_amount`, and an accepted `pay` advances
  on-chain `spent_in_window` + drains the vault. So `readChainBudget` moves in lockstep and the harness
  can assert *backend == chain == an independent reference model*.
- The mock enforces the **same rules the AgentBudget template does** (per-tx cap, daily cap, whitelist,
  kill switch), so accept/reject verdicts are real, not stubbed.
- A control channel (`POST /__control`) injects faults — `down`, `delayMs`, withheld/late verdicts,
  per-method failures — **deterministically**, so "walletd unavailable / timeout / unknown" never
  requires touching a real process. **No `pkill`, no swarm/walletd signals** (the swarm has repeatedly
  crashed WSL under `pkill -9`); the only process ever killed is a test backend, by its **exact child
  PID** with a single signal.

Backend instances are spawned on their own ports with isolated `AGENTPAY_STATE_FILE` /
`AGENTPAY_TXLOG_FILE`, so nothing touches the live dashboard's state.

Run it:

```bash
make stability                       # all suites
make soak                            # SOAK_ROUNDS=1500 make soak  (lengthen)
make stability-fault stability-crash stability-idem stability-multi
```

Harness: [`scripts/stability/`](../scripts/stability/) — `mock_walletd.js`, `lib.js`, and one script
per suite (`soak.js`, `fault_injection.js`, `crash_recovery.js`, `idempotency.js`, `multi_instance.js`),
plus `run_all.js`. Latest evidence capture is in the session notes (`b6-stability-run.txt`).

## What was tested and what it showed

### 1. Soak — no drift, no leak, chain↔journal consistency (`soak.js`) ✅
A long run (300 default, verified to 1500) of random payments + interleaved `/api/v1` queries against
a live budget, with an independent reference model of the on-chain rules.

- **0 model-vs-chain mismatches** over 1500 rounds — the chain accepts a payment iff the rules allow it.
- **No drift**: backend-reported `spent` == mock chain `spent` == reference model; `treasury == fund − spent` exactly (BigInt, no float).
- **chain↔journal**: confirmed-pay count == accepted; **no duplicate idempotency keys**; chain pay-submits == journal records that reached the chain (every accepted/rejected-on-chain pay submitted exactly once, no resubmits); **no record stuck in `pending`**; `GET /payments` count == journal records.
- **No leak**: backend RSS flat with volume (≈+20 MB at 1500 rounds, same band as 300 rounds — GC noise, not growth proportional to operations); journal is one record per op.

### 2. Fault injection — walletd down / timeout / unknown verdict (`fault_injection.js`) ✅
- **walletd down** → the pay is **not** reported as success; nothing is marked confirmed.
- **timeout** (verdict lands after the finalize budget) → recorded **`unknown`** with a tx id, **never success**; the chain saw **exactly one submit**; after recovery, `reconcile` settles it to confirmed and **does not resubmit**; a same-key retry replays the confirmed receipt (no double-spend).
- **unknown verdict** (submit ok, never finalizes in-window) → same `unknown` handling; later reconcile settles it; single on-chain effect.
- **chain-read failure** → `/api/state` still returns 200 and falls back to cache/journal with explicit provenance (`source`), rather than crashing.

### 3. Crash recovery — SIGKILL mid-flight, restart, reconcile (`crash_recovery.js`) ✅
A pay is forced into the "submitted but not confirmed" state (journal holds a `pending/unknown` record
**with a tx id**, persisted to disk), then the backend is **SIGKILL'd by its exact PID** (hard crash, no
graceful shutdown). The chain finalizes the tx while the backend is down; on restart against the same
files, **boot-time `reconcileAll()`** settles the record:

- record → **confirmed**; **no double-spend** (chain spent advanced by exactly the one pay); **no
  re-submit** across the crash; backend-reported spent == chain; **no record lost**; a same-key retry
  after recovery replays with no second effect.

This directly validates A-2: the pending row is persisted **before** submit, so a crash always leaves a
reconcilable trace.

### 4. Idempotency under retry / timeout / concurrency (`idempotency.js`) ✅
Within one instance, the same `Idempotency-Key` maps to **at most one on-chain effect**:
- concurrent burst of 12 identical requests → **one** chain submit, 12 identical confirmed receipts;
- timeout then retry of the same key → reconciled, **not** resubmitted (one submit);
- replay of a confirmed key (same key, **same parameters**) → `replayed: true`, no new submit;
- **same key, DIFFERENT parameters** (a changed amount or payee) → **HTTP 409 `idempotencyConflict`**,
  no new submit, and the original receipt is left untouched — a reused key never silently returns the
  prior receipt for a different request (the key is bound to a fingerprint of its funding parameters;
  see `web/server/idempotency.js` and `docs/security.md`);
- retry of a chain-rejected key → refused, **not** resubmitted, stays rejected (deterministic);
- 6 distinct keys → 6 submits (no accidental collapsing).

### 5. Multi-instance concurrency — same-host now safe; cross-host limited (`multi_instance.js`) ✅ (one documented limit)
Two backends share one `state.json` + `txlog.json` + `claims/` dir and one chain, hit concurrently.

- **Same key to both instances → exactly ONE submit (FIXED).** Over 10 rounds, a fresh key fired at both
  instances at once produces **one** chain submit and **one** payment each round (measured: 10 submits for
  10 rounds, on-chain spend exactly 10×500; the loser **replays the winner's receipt** — both responses
  confirmed with the **same tx id**). Before the fix this reliably double-submitted. The guarantee is a
  cross-process **claim** (`web/server/claims.js`): `fs.open(…,"wx")` lets exactly one instance win the key
  and submit; the loser reads the shared journal and replays.
- **No shared-journal clobber (FIXED).** 10 distinct keys fired concurrently across both instances →
  **all 10 records survive** in the shared file (was 5 of 10). The journal persist now re-reads and
  **merges** the on-disk set under a stale-aware cross-process lock before writing, so a peer's records are
  never overwritten.
- **Distinct keys stay independent:** 10 distinct keys → 10 submits (no accidental collapsing).
- **Holds (on-chain backstop):** two instances racing payments can **never** push on-chain spend past the
  daily cap (measured: cap 900, 10×300 concurrent pays across both → chain accepts exactly 3 = 900). Both
  instances stay up across every race.

**Conclusion:** multiple instances that **share one filesystem** (same host, shared state dir) are now
safe — the claim closes the double-spend and the merge closes the clobber. **Cross-HOST** instances with
separate filesystems are NOT covered (the filesystem claim cannot see another host's claims) and still
need a real shared store with atomic idempotency (DB / Redis) + a distributed lock — logged below.

## Bugs found

### Fixed this round (go-live hardening pass)
- **Idempotency key not bound to its parameters.** A key deduped purely on the key string, so the same
  key reused with **different** parameters (a different amount or payee) would silently replay the
  original receipt — masking a second, different payment, or letting a replayed key be redirected.
  Fixed by binding each key to a canonical fingerprint of its funding parameters (op + budget +
  payee + amount + memo; a server-generated invoiceId is excluded as it is random per call), recorded
  on both the journal record and the cross-process claim marker. Same key + same params → replay as
  before; same key + different params → **409 `idempotencyConflict`**, never a silent replay; concurrent
  same-key/same-params → still exactly one submit. New module `web/server/idempotency.js`; changes in
  `web/server/server.js` (`runChainOp`) and `web/server/txlog.js` (record carries `fp`). Proven by the
  extended `scripts/stability/idempotency.js`.
- **B-6 mock walletd substate shape was stale.** The pay-badge-fix changed the TS client to resolve
  badges from CBOR-tagged resource entries (`tag 131`, struct order owner→agent) instead of address
  sort order, but `scripts/stability/mock_walletd.js` still emitted the old `@@TAGGED@@` shape, so
  `createBudget` failed against the mock and the whole stability harness was red. Updated the mock's
  `componentSubstate()` to the real tagged shape (resources `tag 131` owner-first, vault `tag 130`,
  whitelist components `tag 128`). Test-infra only; no production change.
- **Multi-instance double-spend of the same idempotency key (the one hard go-live gate).** Idempotency
  was enforced only *per process* (an in-memory map keyed by the Idempotency-Key). Two instances sharing
  one journal did not share that map, so the **same key sent concurrently to both was submitted to chain
  twice** — a double payment the chain cannot dedup. Fixed with a **cross-process claim** taken before the
  submit: `fs.open(path,"wx")` (atomic exclusive create) in a shared `claims/` dir lets exactly one
  instance win a key and submit; every other caller loses (`EEXIST`), does **not** submit, and instead
  replays the winner's outcome from the shared journal — polling while it is still pending, and reporting
  `unknown` (never a resubmit) if the winner is slow or crashed mid-flight, which the existing A-2 startup
  reconcile then settles by tx id. Also closed the companion **shared-journal clobber**: the journal
  persist now re-reads and **merges** the on-disk record set (keeping the most-advanced record per key)
  under a stale-aware cross-process file lock before the atomic write, so concurrent writers no longer
  overwrite each other's records. Single-instance behaviour is unchanged (no contention → the merge is a
  no-op and the fast in-memory idempotency path is taken first). **Scope:** same host / shared filesystem
  only; cross-host remains known-issue #1. New module `web/server/claims.js`; changes in
  `web/server/txlog.js` (merge-under-lock persist + `reload`) and `web/server/server.js` (`runChainOp`).
  Proven by the rewritten `scripts/stability/multi_instance.js` (9/9).
- **Stale tx id attributed to a non-submitting op.** `runChainOp` set a failed op's journal `txId` from
  the shared client's sticky `wd.lastTxId`, so an op that failed **before submitting** (a client-side
  precheck rejection, or a pre-submit fault) inherited the **previous** op's tx id — a misleading
  receipt/audit entry. No fund risk (reconcile only acts on open records with a tx id; these are
  terminal `rejected`). Fixed by snapshotting `lastTxId` before submit and attributing a tx id only when
  it actually advanced (or the error carries one explicitly). Caught by, and now guarded by, the soak
  assertion `chain pay-submits == journal records that reached chain`.
  Change: `web/server/server.js` `runChainOp`.

## Known issues / limitations (not fixed this round)

1. **Cross-HOST horizontal scaling still needs a shared store.** *(architectural — the remaining multi-node gap)*
   *Same-host* multi-instance is now safe: a cross-process filesystem claim (`claims/`) makes duplicate-key
   requests submit exactly once, and a merge-under-lock journal persist stops concurrent writers clobbering
   the file (see suite 5, now 9/9). **What this does NOT cover:** instances on **different hosts** with
   **separate filesystems**. `fs.open(…,"wx")` and a lockfile only coordinate processes that can see the
   same directory; two hosts each have their own `claims/` and their own journal, so the same key could win
   on both and double-submit. For true multi-host scale-out, move the journal + claim to a shared
   transactional store (Postgres/SQLite-WAL/Redis) with a **unique constraint on the idempotency key** and a
   **per-budget distributed lock** before submit; the claim/replay logic in `runChainOp` is the seam to swap
   the backing store behind. Until then: either keep all instances on one shared filesystem (now supported),
   or run one instance per budget/account across hosts, as an operational constraint.
   *(Also note: the claim dir accumulates one small marker per key, like the journal; a compaction/rotation
   pass — dropping markers whose journal record is already terminal — is a low-priority follow-up, same as
   issue #4 for the journal.)*

2. **Pre-submit infrastructure failure is journaled as terminal `rejected`.** *(correctness, medium)*
   When walletd is unreachable, the pay never reaches the chain but is recorded as `rejected` (a terminal
   state) with the transport error as the reason. No double-spend (nothing executed on chain), but it
   **poisons that idempotency key**: a later legitimate retry of the same invoice is refused with "422
   previously rejected" even though it never ran, and the status is misleading (it was not a chain
   verdict). **Recommendation:** distinguish a chain *verdict* (`PolicyViolation` / a finalized Reject —
   terminal) from a *transport/pre-submit* failure (no tx id, not a `PolicyViolation` → a non-terminal
   `failed`/retryable state that does not block the key). This touches the lifecycle taxonomy
   (`reconcile`, `receiptOf`, `summary`, v1 status codes), so it was left for a dedicated change rather
   than patched piecemeal.

3. **Default money-op rate limit throttles bulk/soak traffic.** *(by design — operational note)*
   The authorizer caps money ops at 12/min (all ops 40/min) per actor. This is a deliberate safeguard
   with its own coverage; the soak raised it via env (`AGENTPAY_MONEY_MAX` etc.) to load-test the
   pipeline. Real high-throughput agents must either pace requests or have the operator raise these — size
   them deliberately before go-live.

4. **Journal grows unbounded (full-file rewrite per op).** *(scaling, low for now)*
   ≈580 bytes/record, rewritten in full on every transition. Fine at dashboard volume (872 KB at 1500
   ops) but O(n) write cost and no compaction/rotation. **Recommendation:** append-log or SQLite, with
   archival of terminal records, before sustained high volume. (Already flagged in `docs/custody.md`.)

5. **Amounts above 2^53 lose precision on the chain *read* path.** *(pre-existing, documented)*
   `readChainBudget` takes caps/spend as JS numbers from the CBOR substate. Treasury is read as an exact
   string; caps/spend are not. Not exercised at devnet amounts. See `docs/custody.md` §state-model.

## Go-live criteria (what must be green before real money)

**Hard gates (block go-live):**
- [x] Soak: 0 drift, 0 stuck-pending, 0 duplicate keys, chain↔journal consistent, no RSS growth with volume.
- [x] Unconfirmed outcomes (timeout / unknown / walletd down) are **never** reported as success.
- [x] Crash mid-flight → startup reconcile settles against chain with **no double-spend, no lost record**.
- [x] Idempotency: same key under retry/timeout/concurrency → **one** on-chain effect; rejected keys not resubmitted.
- [x] **Idempotency key bound to its parameters** — same key with a different amount/payee is refused
      (409), never a silent replay of the prior receipt (`web/server/idempotency.js`).
- [x] **Step-up confirmation bound to funding parameters + single-use** — a confirm token cannot be
      replayed against a different amount/payee/budget (`web/server/stepup.test.js`, 10 checks).
- [x] **High-risk audit durable (fsync) as part of the op** — a high-risk fund op whose audit write
      fails is refused and not performed (`web/server/audit.test.js`).
- [x] **Loopback bind by default** — exposing the dashboard needs an explicit `HOST` + a password, or
      the server refuses to start (`docs/security.md`).
- [x] On-chain caps hold under concurrency (the backstop).
- [x] **Same-host multi-instance idempotency enforced** — same key across instances submits once, no
      shared-journal clobber (cross-process claim + merge-under-lock persist; multi-instance suite extended
      to prove it, 9/9). *Was the one hard gate; now closed for shared-filesystem deployments.*
- [ ] **Cross-HOST** multi-instance (separate filesystems) needs a shared store + distributed lock
      (known-issue #1). Until then, either keep all instances on **one shared filesystem** (now supported)
      or run **one instance per budget/account** per host. **← the remaining gap before multi-host scale-out.**

**Should-fix before go-live (not blocking a single-instance pilot):**
- [ ] Known-issue #2: transport/pre-submit failures become retryable, not terminal `rejected`.
- [ ] Rate limits sized for the expected agent throughput and load-tested at that rate.
- [ ] Backup/restore runbook for `state.json` + `txlog.json` (atomic snapshot; restore → run `POST /api/reconcile` to re-settle against chain). Reconcile is idempotent and chain-authoritative, so a restored-stale journal self-heals; this should be drilled, not assumed.

**Operational guardrails for a pilot:**
- Instances may now share one host / filesystem safely (cross-process claim + merge persist); across
  separate hosts, still one instance per budget/account until known-issue #1 (shared store) is done. A
  process manager that restarts on crash (reconcile runs on boot) either way.
- The shared `claims/` dir must live on the **same filesystem** as the journal (it defaults next to it;
  override both consistently via `AGENTPAY_TXLOG_FILE` / `AGENTPAY_CLAIMS_DIR`). A claim marker left by a
  crashed instance with no resolved outcome surfaces as an `unknown`/needs-attention record, never an
  auto-resubmit.
- Alert on `txlog.summary().needsAttention` (unknown txs / open-without-tx-id) — these need an operator.
- Keep walletd reachable; a sustained outage currently poisons in-flight keys (known-issue #2).
