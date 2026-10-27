# Continuous Integration

This repo ships two layers of CI that run the **same** suites:

1. **Local one-command CI** — `make ci` (or `make test`), usable right now.
2. **GitHub Actions** — [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), **prepared but not yet
   activated** (there is no GitHub remote yet). It will run automatically on the first push once a
   remote is added. It has never run on GitHub, so it is *correct-by-construction*, not *CI-verified*.

Everything must run on **Linux / WSL Ubuntu**: the Tari engine's template test tooling pins
wasmer's cranelift backend, which does not build on Windows or macOS (see
[`docs/devnet.md`](devnet.md) and the project note *tari-dev-needs-linux*).

---

## What the suites cover

| Suite | Command | What it checks | Tests |
|---|---|---|---|
| `templates/escrow` | `cargo test` | Escrow lock/release/refund/dispute/resolve + fee, adversarial/boundary cases | **17** |
| `templates/agent_budget` | `cargo test` | AgentBudget per-tx / daily caps, whitelist, revoke, multi-session badges, top-up, set-window | **14** |
| `templates/otc_board` | `cargo test` | OTC list→take→confirm, arbiter stake/slash, the unstake-during-dispute guard | **18** |
| `sdk` | `pytest` | Business logic + the stdlib JSON-RPC adapter (`agentpay.onchain`): policy, invoices, manifests, event decoding | **~46** |
| `web` | `node server/security.test.js` | The dashboard's web-security boundary end-to-end (auth, CSRF, CORS, headers, session, IP lockout) | **22** |
| `clients/ts` | `tsc` build | A clean type-checked compile of the zero-dependency TS client (it has no unit tests) | build |

Template unit tests run the compiled template **in wasmer in-process** — no chain, no swarm. The web
suite boots a **throwaway** server on a random port against temp state — no walletd. So **no suite
touches a running swarm**; the local script is safe to run while a devnet is up.

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
  templates/escrow               PASS     17
  templates/agent_budget         PASS     14
  templates/otc_board            PASS     18
  sdk (pytest)                   PASS     46
  web (node security test)       PASS     22
  clients/ts (tsc build)         PASS     build ok
  ----------------------------------------------------------------
  6/6 suites green · 117 tests passed
```

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

## 2. GitHub Actions (prepared, awaiting a remote)

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) defines four parallel jobs on
`ubuntu-latest`, triggered on every `push`, every `pull_request`, and manually
(`workflow_dispatch`):

- **templates** — a 3-way matrix (`escrow` / `agent_budget` / `otc_board`): installs Rust + the
  `wasm32-unknown-unknown` target, caches the cargo registry and each template's `target/`, and runs
  `cargo test`.
- **sdk** — Python 3.13, `pip install -e sdk[dev]` (pulls `ootle-py` so `test_keys.py` runs too), then
  `pytest`. Pip cache enabled.
- **web** — Node 20, `node server/security.test.js` (zero install).
- **ts-client** — Node 20, `npm install` + `npm run build`, then asserts `dist/index.js` exists.

**It has not run on GitHub.** There is no remote yet, so this is correct-by-construction and will
first execute on the initial push. Do not read a green badge into it until that push happens.

### Activating it

```bash
git remote add origin <your-github-remote>
git push -u origin main
```

Actions picks up `.github/workflows/ci.yml` automatically — no extra configuration. If `ootle-py`
cannot be resolved on the runner, drop the `[dev]`/install step for the `sdk` job and run pytest with
`--continue-on-collection-errors` (exactly what the local CI does on Python 3.12), as noted in the
workflow's inline comments.
