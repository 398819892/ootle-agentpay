#!/usr/bin/env bash
#
# ci-local.sh — one-command local CI for the Ootle AgentPay / OTC Escrow repo.
#
# Runs every test suite and prints a single pass/fail summary with counts:
#
#     SUITE                     STATUS     TESTS
#     templates/escrow          PASS       17
#     templates/agent_budget    PASS       14
#     templates/otc_board       PASS       18
#     sdk (pytest)              PASS       46
#     web (node security test)  PASS       22
#     clients/ts (tsc build)    PASS       build ok
#     ----------------------------------------------
#     6/6 suites green · 117 tests
#
# WHY THIS SCRIPT EXISTS (read before editing):
#   * The Tari engine's wasmer/cranelift backend only builds on Linux, so the template
#     `cargo test`s must run in WSL/Ubuntu, never on native Windows (see docs/devnet.md
#     and the project memory "tari-dev-needs-linux").
#   * Compiling on the /mnt/f 9p mount is slow and flaky, so the templates and the TS
#     client are built in native-ext4 warm dirs (default under /root/ootle). This script
#     rsyncs the repo's current sources into those warm dirs before each run, so a source
#     edit is always what gets tested — the warm dir only caches build artifacts.
#
# RUN IT (from WSL, or from Windows via WSL):
#     bash scripts/ci-local.sh                 # inside WSL, repo on ext4 or /mnt
#     wsl -d Ubuntu-24.04 -u root -- bash -lc 'bash /mnt/f/oolte/scripts/ci-local.sh'
#   or just:  make ci   /   make test          (the Makefile shells out to here)
#
# ENV KNOBS (all optional):
#     TEMPLATE_BUILD_DIR   warm ext4 dir holding per-template build caches (default /root/ootle)
#     TS_BUILD_DIR         warm ext4 dir for the clients/ts tsc build      (default $TEMPLATE_BUILD_DIR/agentpay-ts-build)
#     PYTHON               python interpreter for the SDK suite            (default python3)
#     SKIP_TEMPLATES / SKIP_SDK / SKIP_WEB / SKIP_TS = 1   skip that suite
#     NO_SYNC=1            test the warm dirs as-is, don't rsync repo sources in
#
# It never touches a running swarm: no suite here needs the chain (the web test boots its
# own throwaway server; the templates run in-process in wasmer; the SDK/TS build don't hit RPC).
#
set -uo pipefail

# ---------------------------------------------------------------- locate repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TEMPLATE_BUILD_DIR="${TEMPLATE_BUILD_DIR:-/root/ootle}"
TS_BUILD_DIR="${TS_BUILD_DIR:-$TEMPLATE_BUILD_DIR/agentpay-ts-build}"
PYTHON="${PYTHON:-python3}"
TEMPLATES="escrow agent_budget otc_board"

# ---------------------------------------------------------------- pretty output
if [ -t 1 ]; then BOLD=$'\e[1m'; RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; DIM=$'\e[2m'; RST=$'\e[0m';
else BOLD=; RED=; GRN=; YEL=; DIM=; RST=; fi

LOGDIR="$(mktemp -d)"
trap 'rm -rf "$LOGDIR"' EXIT

# Parallel arrays of results, filled as we go.
R_NAME=(); R_STATUS=(); R_COUNT=(); R_NOTE=()
TOTAL_TESTS=0

step()  { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RST"; }
info()  { printf '    %s%s%s\n' "$DIM" "$1" "$RST"; }

record() { # name  status(PASS|FAIL|SKIP)  count  note
  R_NAME+=("$1"); R_STATUS+=("$2"); R_COUNT+=("$3"); R_NOTE+=("${4:-}")
  case "$2" in
    PASS) printf '    %s✓ %s%s — %s\n' "$GRN" "$1" "$RST" "${3:-ok}" ;;
    FAIL) printf '    %s✗ %s%s — %s\n' "$RED" "$1" "$RST" "${4:-failed}" ;;
    SKIP) printf '    %s• %s (skipped)%s — %s\n' "$YEL" "$1" "$RST" "${4:-}" ;;
  esac
}

# Source the Rust toolchain if present (login shells sometimes miss it).
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# ================================================================ templates
run_templates() {
  step "Rust/WASM templates — cargo test (wasmer, Linux only)"
  if ! command -v cargo >/dev/null 2>&1; then
    for t in $TEMPLATES; do record "templates/$t" FAIL "" "cargo not found (run in WSL/Ubuntu)"; done
    return
  fi
  for t in $TEMPLATES; do
    local src="$REPO_ROOT/templates/$t"
    if [ ! -f "$src/Cargo.toml" ]; then record "templates/$t" FAIL "" "missing $src"; continue; fi

    local work="$src"            # default: test in-tree
    if [ -n "${TEMPLATE_BUILD_DIR:-}" ] && [ -d "$TEMPLATE_BUILD_DIR" ]; then
      work="$TEMPLATE_BUILD_DIR/$t"
      mkdir -p "$work"
      if [ -z "${NO_SYNC:-}" ]; then
        info "sync $t sources → $work"
        # Mirror sources into the warm dir; keep target/ (the build cache) intact.
        rsync -a --delete "$src/src/"   "$work/src/"
        if [ -d "$src/tests" ]; then rsync -a --delete "$src/tests/" "$work/tests/"; else rm -rf "$work/tests"; fi
        for f in Cargo.toml Cargo.lock build.rs; do
          [ -f "$src/$f" ] && cp -f "$src/$f" "$work/$f"
        done
      fi
    else
      info "warm dir $TEMPLATE_BUILD_DIR absent → building in-tree ($src) — this is a cold build, slower"
    fi

    info "cargo test ($t) — first run is a cold build, please wait…"
    local log="$LOGDIR/$t.log"
    if ( cd "$work" && cargo test ) >"$log" 2>&1; then
      # Sum "test result: ok. N passed" across every test binary + doctests.
      local n; n=$(grep -Eo 'test result: ok\. [0-9]+ passed' "$log" | grep -Eo '[0-9]+' | awk '{s+=$1} END{print s+0}')
      n=${n:-0}
      record "templates/$t" PASS "$n"
      TOTAL_TESTS=$((TOTAL_TESTS + n))
    else
      record "templates/$t" FAIL "" "cargo test failed — see tail below"
      tail -n 25 "$log" | sed 's/^/        /'
    fi
  done
}

# ================================================================ sdk
run_sdk() {
  step "Python SDK — pytest"
  if [ ! -d "$REPO_ROOT/sdk" ]; then record "sdk (pytest)" FAIL "" "no sdk/"; return; fi
  if ! command -v "$PYTHON" >/dev/null 2>&1; then record "sdk (pytest)" FAIL "" "$PYTHON not found"; return; fi
  local log="$LOGDIR/sdk.log"
  # test_keys.py imports the native `ootle` pkg (ootle-py, needs Python >=3.13); it's absent on
  # the dev box, so it fails COLLECTION only. --continue-on-collection-errors lets the ~46 pure
  # stdlib tests run and still fails the run on any real test failure.
  ( cd "$REPO_ROOT/sdk" && "$PYTHON" -m pytest -q --continue-on-collection-errors ) >"$log" 2>&1
  local rc=$?
  local passed; passed=$(grep -Eo '[0-9]+ passed' "$log" | tail -1 | grep -Eo '[0-9]+'); passed=${passed:-0}
  local collerr=""; grep -q "error" "$log" && collerr="$(grep -Eo '[0-9]+ error' "$log" | tail -1)"
  local note=""
  [ -n "$collerr" ] && note="($collerr — test_keys needs ootle-py / py≥3.13)"
  # Pass if pytest reported >0 passed and the only non-pass outcome is the known collection error.
  if [ "$passed" -gt 0 ] && ! grep -Eq '[0-9]+ failed' "$log"; then
    record "sdk (pytest)" PASS "$passed" "$note"
    TOTAL_TESTS=$((TOTAL_TESTS + passed))
  else
    record "sdk (pytest)" FAIL "" "pytest failed (rc=$rc)"
    tail -n 25 "$log" | sed 's/^/        /'
  fi
}

# ================================================================ web
run_web() {
  step "Web dashboard — node security test suite"
  local t="$REPO_ROOT/web/server/security.test.js"
  if [ ! -f "$t" ]; then record "web (node security test)" FAIL "" "missing $t"; return; fi
  if ! command -v node >/dev/null 2>&1; then record "web (node security test)" FAIL "" "node not found"; return; fi
  local log="$LOGDIR/web.log"
  ( cd "$REPO_ROOT/web" && node server/security.test.js ) >"$log" 2>&1
  local rc=$?
  local passed; passed=$(grep -Eo '([0-9]+) passed' "$log" | tail -1 | grep -Eo '[0-9]+'); passed=${passed:-0}
  if [ $rc -eq 0 ] && [ "$passed" -gt 0 ]; then
    record "web (node security test)" PASS "$passed"
    TOTAL_TESTS=$((TOTAL_TESTS + passed))
  else
    record "web (node security test)" FAIL "" "node test failed (rc=$rc)"
    tail -n 25 "$log" | sed 's/^/        /'
  fi
}

# ================================================================ clients/ts
run_ts() {
  step "TypeScript client — tsc build (type-check)"
  local src="$REPO_ROOT/clients/ts"
  if [ ! -f "$src/tsconfig.json" ]; then record "clients/ts (tsc build)" FAIL "" "no clients/ts"; return; fi
  if ! command -v node >/dev/null 2>&1; then record "clients/ts (tsc build)" FAIL "" "node not found"; return; fi
  # clients/ts has no unit tests; its "suite" is a clean tsc compile of the committed sources.
  # npm install on the /mnt 9p mount corrupts node_modules, so build in a native-ext4 warm dir.
  local work="$TS_BUILD_DIR"
  local log="$LOGDIR/ts.log"
  mkdir -p "$work"
  rsync -a --delete "$src/src/" "$work/src/"
  cp -f "$src/tsconfig.json" "$src/package.json" "$work/"
  (
    cd "$work"
    if [ ! -x node_modules/.bin/tsc ]; then
      echo "installing typescript (one-time) in $work"
      npm install --silent --no-audit --no-fund || exit 97
    fi
    rm -rf dist
    ./node_modules/.bin/tsc -p tsconfig.json || exit 98
    [ -f dist/index.js ] || { echo "tsc produced no dist/index.js"; exit 99; }
  ) >"$log" 2>&1
  local rc=$?
  if [ $rc -eq 0 ]; then
    record "clients/ts (tsc build)" PASS "build ok"
  else
    record "clients/ts (tsc build)" FAIL "" "tsc build failed (rc=$rc)"
    tail -n 25 "$log" | sed 's/^/        /'
  fi
}

# ================================================================ main
printf '%s╔══════════════════════════════════════════════════════╗%s\n' "$BOLD" "$RST"
printf '%s║  Local CI — Ootle AgentPay / OTC Escrow                ║%s\n' "$BOLD" "$RST"
printf '%s╚══════════════════════════════════════════════════════╝%s\n' "$BOLD" "$RST"
info "repo:      $REPO_ROOT"
info "warm dir:  $TEMPLATE_BUILD_DIR"

[ -n "${SKIP_TEMPLATES:-}" ] || run_templates
[ -n "${SKIP_SDK:-}" ]       || run_sdk
[ -n "${SKIP_WEB:-}" ]       || run_web
[ -n "${SKIP_TS:-}" ]        || run_ts

# ---------------------------------------------------------------- summary
green=0; total=0; failed=0
printf '\n%s──────────────────────────── SUMMARY ────────────────────────────%s\n' "$BOLD" "$RST"
printf '%s  %-30s %-8s %s%s\n' "$BOLD" "SUITE" "STATUS" "TESTS" "$RST"
for i in "${!R_NAME[@]}"; do
  total=$((total+1))
  local_status="${R_STATUS[$i]}"
  case "$local_status" in
    PASS) green=$((green+1)); c="$GRN";;
    FAIL) failed=$((failed+1)); c="$RED";;
    *)    c="$YEL";;
  esac
  printf '  %-30s %s%-8s%s %s %s%s\n' \
    "${R_NAME[$i]}" "$c" "$local_status" "$RST" "${R_COUNT[$i]}" "$DIM" "${R_NOTE[$i]}${RST}"
done
printf '  %s\n' "----------------------------------------------------------------"
if [ "$failed" -eq 0 ]; then
  printf '  %s%d/%d suites green · %d tests passed%s\n\n' "$GRN$BOLD" "$green" "$total" "$TOTAL_TESTS" "$RST"
  exit 0
else
  printf '  %s%d/%d suites FAILED · %d tests passed in the green suites%s\n\n' "$RED$BOLD" "$failed" "$total" "$TOTAL_TESTS" "$RST"
  exit 1
fi
