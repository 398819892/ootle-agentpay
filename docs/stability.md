# Stability & reliability verification (B-6)

> **Honest summary.** The AgentPay dashboard backend's money pipeline (chain-authoritative reads +
> transaction journal with `pending → confirmed | rejected | unknown` + idempotency keys + startup
> reconciliation, from A-1/A-2/A-3) was put under soak, fault injection, crash recovery, multi-instance
> concurrency and retry/timeout tests. **Single-instance behaviour is sound:** no state drift, no leak,
> no double-spend, unconfirmed outcomes are never counted as success, and a crash mid-flight recovers
> correctly against the chain. **Two findings** came out of it (one fixed, one logged) and **one hard
> limit** is confirmed: the backend must run as **a single instance per budget/account** until it has a
> shared idempotency store + distributed lock. The on-chain caps are the real backstop and hold even
> when the hosted layer races. This is a verification report, not a "ship it" — see the go-live gate.

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
- replay of a confirmed key → `replayed: true`, no new submit;
- retry of a chain-rejected key → refused, **not** resubmitted, stays rejected (deterministic);
- 6 distinct keys → 6 submits (no accidental collapsing).

### 5. Multi-instance concurrency — the hard limit (`multi_instance.js`) ⚠️ findings
Two backends share one `state.json` + `txlog.json` and one chain, hit concurrently.

- **Holds (on-chain backstop):** two instances racing payments can **never** push on-chain spend past
  the daily cap (measured: cap 900, 10×300 concurrent pays across both instances → chain accepts exactly
  3 = 900, rest rejected on-chain). Both instances stay up.
- **Does NOT hold (hosted layer):** the **same idempotency key sent to both instances concurrently is
  submitted to chain twice → a double payment of one invoice** (measured: 2 submits, double-spend of
  1000). Invoice-level idempotency is per-process (in-memory map + whole-file rewrite); the chain has no
  invoice dedup. Concurrent writers also **clobber the shared journal** (measured: 5 of 10 records
  survived), because each process rewrites the entire file from its own in-memory copy.

**Conclusion:** run **one backend instance per budget/account**. Horizontal scaling needs a shared store
with atomic idempotency (DB / Redis) and a distributed lock — logged below.

## Bugs found

### Fixed this round
- **Stale tx id attributed to a non-submitting op.** `runChainOp` set a failed op's journal `txId` from
  the shared client's sticky `wd.lastTxId`, so an op that failed **before submitting** (a client-side
  precheck rejection, or a pre-submit fault) inherited the **previous** op's tx id — a misleading
  receipt/audit entry. No fund risk (reconcile only acts on open records with a tx id; these are
  terminal `rejected`). Fixed by snapshotting `lastTxId` before submit and attributing a tx id only when
  it actually advanced (or the error carries one explicitly). Caught by, and now guarded by, the soak
  assertion `chain pay-submits == journal records that reached chain`.
  Change: `web/server/server.js` `runChainOp`.

## Known issues / limitations (not fixed this round)

1. **No horizontal scaling (single-instance only).** *(architectural — highest priority before multi-node)*
   The journal is a single JSON file rewritten atomically per op, with an in-memory idempotency map
   loaded once at boot. Safe and correct for **one** instance; with two instances, duplicate-key requests
   double-submit and concurrent writes clobber the file (see suite 5). **Recommendation:** a shared
   transactional store (Postgres/SQLite-WAL/Redis) with a unique constraint on the idempotency key and a
   per-budget advisory/distributed lock before submit. Until then, deploy one instance per account and
   document it as an operational constraint.

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
- [x] On-chain caps hold under concurrency (the backstop).
- [ ] **Single-instance deployment enforced** (process manager runs exactly one backend per budget/account),
      **or** known-issue #1 resolved (shared store + distributed lock) and the multi-instance suite extended
      to prove cross-instance idempotency. **← the one thing standing between here and multi-node.**

**Should-fix before go-live (not blocking a single-instance pilot):**
- [ ] Known-issue #2: transport/pre-submit failures become retryable, not terminal `rejected`.
- [ ] Rate limits sized for the expected agent throughput and load-tested at that rate.
- [ ] Backup/restore runbook for `state.json` + `txlog.json` (atomic snapshot; restore → run `POST /api/reconcile` to re-settle against chain). Reconcile is idempotent and chain-authoritative, so a restored-stale journal self-heals; this should be drilled, not assumed.

**Operational guardrails for a single-instance pilot:**
- One instance per budget/account; a process manager that restarts on crash (reconcile runs on boot).
- Alert on `txlog.summary().needsAttention` (unknown txs / open-without-tx-id) — these need an operator.
- Keep walletd reachable; a sustained outage currently poisons in-flight keys (known-issue #2).
