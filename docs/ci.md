# Continuous Integration

This repo ships two layers of CI that run the **same** suites:

1. **Local one-command CI** — `make ci` (or `make test`), usable right now.
2. **GitHub Actions** — [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), **active** on
   [github.com/398819892/ootle-agentpay](https://github.com/398819892/ootle-agentpay): six jobs
   (templates ×3 / sdk / web / ts-client) run on every push and pull request.

Everything must run on **Linux / WSL Ubuntu**: the Tari engine's template test tooling pins
wasmer's cranelift backend, which does not build on Windows or macOS (see
[`docs/devnet.md`](devnet.md) and the project note *tari-dev-needs-linux*).

---

## What the suites cover

| Suite | Command | What it checks | Tests |
|---|---|---|---|
| `templates/escrow` | `cargo test` | Escrow lock/release/refund/dispute/resolve + fee, authz, conservation fuzz, adversarial/boundary cases | **26** |
| `templates/agent_budget` | `cargo test` | AgentBudget per-tx / daily caps, whitelist, revoke, multi-session badges, top-up, set-window, the escrow-route bypass suite, conservation fuzz | **28** |
| `templates/otc_board` (frozen) | `cargo test` | OTC list→take→confirm, authz/state-machine, arbiter stake lock/burn, fee snapshot, conservation fuzz | **45** |
| `sdk` | `pytest` | The stdlib JSON-RPC adapter (`agentpay.onchain`): manifests, injection guard, event decoding, badge resolution, non-custodial auth, resource parametrization; plus the chain-agnostic helpers and the public-API surface | **69** (+5 in `test_keys.py` with `ootle-py`) |
| `web` | `node server/*.test.js` | security boundary (22) · audit durability (9) · step-up token binding (10) · strict substate parse (15) · reads not blocked by writes (3) · reconcile of an ambiguous open (7) | **66** |
| `clients/ts` | `tsc` build + `node --test dist/*.test.js` | A clean type-checked compile of the zero-dependency TS client, then its manifest-injection, event-topic and resource-parametrization suites | build + **13** |
| `e2e (real chain)` | `make e2e` / `RUN_E2E=1` | **Integration, opt-in:** opens a budget and makes a *confirmed* payment against a **live swarm**, asserting funds moved (vault down, merchant up). Guards "unit-green but real pay rejected". | 1 |

Template unit tests run the compiled template **in wasmer in-process** — no chain, no swarm. The web
suite boots a **throwaway** server on a random port against temp state — no walletd. So **none of the
default suites touches a running swarm**; the local script is safe to run while a devnet is up.

The `e2e (real chain)` suite is the one exception and is therefore **gated**: `ci-local.sh` runs it
only with `RUN_E2E=1` **and** a reachable walletd, and otherwise marks it SKIP (never FAIL). The
GitHub workflow never sets `RUN_E2E`, so the swarm-free runner skips it rather than faking a pass —
run it locally (`make e2e`) against your devnet to exercise the real confirmed-payment path.

---

## 1. Local one-command CI

From the repo root, inside WSL:

```bash
make ci        # or: make test   — same thing
# or directly:
bash scripts/ci-local.sh
```

From Windows, drive WSL:

```bash
wsl -d Ubuntu-24.04 -u root -- bash -lc 'bash /mnt/f/oolte/scripts/ci-local.sh'
```

It runs every suite, prints progress, and ends with a single summary + counts:

```
──────────────────────────── SUMMARY ────────────────────────────
  SUITE                          STATUS   TESTS
  templates/escrow               PASS     26
  templates/agent_budget         PASS     28
  templates/otc_board            PASS     45
  sdk (pytest)                   PASS     69
  web (security)                 PASS     22
  web (audit)                    PASS     9
  web (stepup)                   PASS     10
  web (substate)                 PASS     15
  web (concurrency)              PASS     3
  web (reconcile)                PASS     7
  clients/ts (tsc build)         PASS     build ok
  e2e (real chain)               SKIP     set RUN_E2E=1 to run (needs a local swarm)
  ----------------------------------------------------------------
  11/11 suites green · 234 tests passed
```
(Counts as of 2026-11-01; the script prints whatever the suites report, so treat these as indicative.)

The script exits non-zero if any suite fails, so it drops straight into a git hook or a terminal `&&`
chain.

### How the template & TS builds are kept fast (and why the warm dirs)

Compiling on the `/mnt/f` 9p mount is slow and occasionally corrupts `node_modules`, so the script
builds the templates and the TS client in **native-ext4 warm directories** (default under
`/root/ootle`) that keep their build caches between runs. Before each run it **rsyncs the repo's
current sources into those warm dirs**, so a source edit is always what gets tested — the warm dir
only caches `target/` / `node_modules`, never source. First run is a cold build (minutes); later runs
are seconds.

Knobs (all optional — see the header of [`scripts/ci-local.sh`](../scripts/ci-local.sh)):

| Env var | Default | Effect |
|---|---|---|
| `TEMPLATE_BUILD_DIR` | `/root/ootle` | Warm ext4 dir for the per-template build caches. If absent, templates build in-tree (cold, slower). |
| `TS_BUILD_DIR` | `$TEMPLATE_BUILD_DIR/agentpay-ts-build` | Warm ext4 dir for the `tsc` build. |
| `PYTHON` | `python3` | Interpreter for the SDK suite. |
| `NO_SYNC=1` | — | Test the warm dirs as-is, skip the rsync. |
| `SKIP_TEMPLATES` / `SKIP_SDK` / `SKIP_WEB` / `SKIP_TS` | — | Skip a suite (`=1`). |

### Run one suite in isolation

```bash
make test-templates   # all three cargo tests (in-tree)
make test-sdk         # pytest
make test-web         # node security suite
make test-ts          # tsc build
```

### Known caveats (honest status)

- **`sdk/tests/test_keys.py` is a collection-skip on the dev box.** It imports the native `ootle`
  package (`ootle-py`), which requires **Python ≥ 3.13**; the WSL box has 3.12 and no `ootle-py`, so
  that one module fails to *collect*. The local script runs pytest with
  `--continue-on-collection-errors`, so the other tests still run and the skip is reported in the
  summary note. On GitHub Actions the `sdk` job installs Python 3.13 + the SDK's deps, so the full
  suite (including `test_keys.py`) runs there.
- The SDK's alternative `agentpay.ootle_chain.OotlePyChain` adapter is **experimental / unverified**
  and is **not** in any suite — a passing SDK count does not validate it. See `sdk/README.md`.

---

## 2. GitHub Actions

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) defines four parallel jobs on
`ubuntu-latest`, triggered on every `push`, every `pull_request`, and manually
(`workflow_dispatch`):

- **templates** — a 3-way matrix (`escrow` / `agent_budget` / `otc_board`): installs Rust + the
  `wasm32-unknown-unknown` target, caches the cargo registry and each template's `target/`, and runs
  `cargo test`.
- **sdk** — Python 3.13, `pip install -e sdk[dev]` (pulls `ootle-py` so `test_keys.py` runs too), then
  `pytest`. Pip cache enabled.
- **web** — Node 20, all six `web/server/*.test.js` suites (zero install).
- **ts-client** — Node 20, `npm install` + `npm run build`, asserts `dist/index.js` exists, then
  `node --test dist/*.test.js`.

The remote is `origin = https://github.com/398819892/ootle-agentpay.git`; the workflow has run green
there. The `sdk` job already skips `tests/test_keys.py` (it needs `ootle-py`), as the workflow's inline
comments explain.
