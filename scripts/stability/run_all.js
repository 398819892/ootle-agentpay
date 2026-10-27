#!/usr/bin/env node
/**
 * Run the whole AgentPay stability harness and print a one-line verdict per suite. Each suite is a
 * standalone script (run them individually for detail); this is the `make stability` entry point.
 *
 *   node scripts/stability/run_all.js            # all suites
 *   SOAK_ROUNDS=1500 node scripts/stability/run_all.js
 *
 * Exit code is non-zero if any suite with hard invariants fails. The multi-instance suite only has
 * diagnostics (it documents known limits), so it never fails the run.
 */
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SUITES = ["soak.js", "fault_injection.js", "crash_recovery.js", "idempotency.js", "multi_instance.js"];

let anyFail = false;
for (const s of SUITES) {
  console.log(`\n\x1b[1m══════ ${s} ══════\x1b[0m`);
  const res = spawnSync("node", [path.join(__dirname, s)], { stdio: "inherit", env: process.env });
  if (res.status !== 0) { anyFail = true; console.log(`\x1b[31m${s} FAILED (exit ${res.status})\x1b[0m`); }
}
console.log(anyFail ? "\n\x1b[31m✗ stability: one or more suites FAILED\x1b[0m" : "\n\x1b[32m✓ stability: all suites green\x1b[0m");
process.exit(anyFail ? 1 : 0);
