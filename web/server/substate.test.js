/**
 * Unit tests for the strict AgentBudget substate parse (#16). Verifies a well-formed positional
 * state parses correctly AND that a drifted / malformed layout THROWS (rather than returning wrong
 * numbers silently). Zero dependencies. Run: node server/substate.test.js
 */
"use strict";

const { findComponentState, cborHex, parseBudgetState } = require("./substate");

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}
function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

const tag = (hex) => ({ value: { hex } });
// A well-formed state in struct order: vault, owner_badge, agent_badge, per_tx, daily, spent,
// window_start, epochs, whitelist, revoked, revoked_sessions.
const validState = [
  tag("ab".repeat(32)), tag("11".repeat(32)), tag("22".repeat(32)),
  1000, 3000, 500, 10, 48,
  [tag("cc".repeat(32))], false, [],
];

console.log("\nSubstate parse tests (#16)\n");

// findComponentState digs the positional array out of a substates.get-shaped result.
const wrapped = { substate_from_remote: { substate: { Component: { body: { state: validState } } } } };
check("findComponentState locates the positional state array", findComponentState(wrapped) === validState);

// A valid state parses to the right fields.
const p = parseBudgetState(validState);
check("per_tx_cap parsed", p.perTxCap === 1000, String(p.perTxCap));
check("daily_cap parsed", p.dailyCap === 3000, String(p.dailyCap));
check("spent_in_window parsed", p.spentInWindow === 500, String(p.spentInWindow));
check("epochs_per_window parsed", p.epochsPerWindow === 48, String(p.epochsPerWindow));
check("revoked parsed", p.revoked === false, String(p.revoked));
check("whitelist raw length", Array.isArray(p.whitelistRaw) && p.whitelistRaw.length === 1);
check("vault hex parsed", p.vaultHex === "ab".repeat(32));
check("cborHex of a whitelist entry", cborHex(p.whitelistRaw[0]) === "cc".repeat(32));

// LAYOUT DRIFT must throw, not silently return wrong values.
check("throws when a bool sits where a number (per_tx_cap) is expected", throws(() => {
  const drifted = validState.slice();
  drifted[3] = false; // e.g. a field was inserted/reordered so index 3 is no longer a number
  parseBudgetState(drifted);
}));
check("throws when field 9 (revoked) is not a boolean", throws(() => {
  const drifted = validState.slice();
  drifted[9] = 7;
  parseBudgetState(drifted);
}));
check("throws when field 8 (whitelist) is not an array", throws(() => {
  const drifted = validState.slice();
  drifted[8] = 123;
  parseBudgetState(drifted);
}));
check("throws when field 0 (vault) is not an address", throws(() => parseBudgetState([1, 2, 3, 4, 5, 6, 7, 8, [], false, []])));
check("throws on a too-short state", throws(() => parseBudgetState([tag("ab".repeat(32)), 1, 2])));
check("throws on a non-array", throws(() => parseBudgetState(null)));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
