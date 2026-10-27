# AgentPay stability harness (B-6)

Deterministic stability/reliability tests for the dashboard backend's money pipeline. They drive the
**unmodified** `web/server/server.js` against a **controllable mock wallet daemon**, so faults, crashes
and concurrency are exercised **without ever touching the resident local swarm**. Full report and
go-live gate: [`docs/stability.md`](../../docs/stability.md).

## Run

```bash
make stability            # all suites (run_all.js)
make soak                 # soak only;  SOAK_ROUNDS=1500 make soak  to lengthen
make stability-fault      # walletd down / timeout / unknown verdict
make stability-crash      # SIGKILL the backend mid-flight, restart, reconcile
make stability-idem       # same key under retry/timeout/concurrency → one on-chain effect
make stability-multi      # two-instance concurrency diagnostics (documents the shared-store limit)
```

Each script is standalone: `node scripts/stability/<name>.js`. Set `STAB_TMP` to choose the scratch dir
for isolated state/txlog files (default `/tmp/ap_stab`). Requires Node 18+ (global `fetch`); zero deps.

## Files

| file | what it is |
| --- | --- |
| `mock_walletd.js` | Chain-authoritative mock walletd with a fault-injection control channel (`POST /__control`, `GET /__state`). Never touches the real swarm. |
| `lib.js` | Spawn the backend (exact child PID for gentle kills) + the mock, tiny `/api/v1` client, reporter. |
| `soak.js` | Long run: no drift, no leak, chain↔journal consistency. |
| `fault_injection.js` | walletd down / network timeout / unknown verdict / chain-read failure. |
| `crash_recovery.js` | Hard-crash the backend mid-flight; restart; prove reconcile settles with no double-spend. |
| `idempotency.js` | Same `Idempotency-Key` under retry/timeout/concurrency → one on-chain effect. |
| `multi_instance.js` | Two instances, shared files: surfaces the cross-instance idempotency / shared-journal limit. |
| `smoke.js` | Quick end-to-end sanity of the mock + backend. |
| `run_all.js` | Runs every suite with a one-line verdict each. |

## Safety

The only process these tests ever kill is a **test backend they spawned**, by its exact child PID with a
single signal. They never signal, `pkill`, or restart the swarm / walletd. "walletd unavailable /
timeout / unknown verdict" are simulated on the mock, not on any real process.
