//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause

/**
 * P2 — NaN / invalid numeric config must REFUSE TO START, naming the offending variable.
 *
 * The old `Number(process.env.X || def)` idiom turned a typo like `AGENTPAY_FINALIZE_TRIES=4o` into
 * `NaN`, which then silently poisons the loop/timeout that uses it (a `for (i < NaN)` never runs → a
 * real submit is recorded `unknown` without ever waiting for its tx). A money daemon must fail loud
 * at boot on a misconfigured number, not mis-behave in flight. `settings.numEnv` is that guard; this
 * also proves `require("./settings")` itself throws when a knob (PORT) is non-numeric.
 */
"use strict";

const assert = require("node:assert/strict");

const settings = require("./settings");
const { numEnv } = settings;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}  — ${e.message}`);
    process.exitCode = 1;
  }
}

/** Run fn with VAR set to value, always restoring the previous environment. */
function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (had) process.env[name] = saved;
    else delete process.env[name];
  }
}

console.log("\nNaN / invalid numeric config refuses start (web/server/settings.js numEnv)\n");

check("unset or empty var uses the default", () => {
  withEnv("AGENTPAY_TEST_KNOB", undefined, () => {
    assert.equal(numEnv("AGENTPAY_TEST_KNOB", 42), 42);
  });
  withEnv("AGENTPAY_TEST_KNOB", "   ", () => {
    assert.equal(numEnv("AGENTPAY_TEST_KNOB", 42), 42);
  });
});

check("a valid value is parsed (and 0 is honoured, unlike `Number(x) || def`)", () => {
  withEnv("AGENTPAY_TEST_KNOB", "7", () => assert.equal(numEnv("AGENTPAY_TEST_KNOB", 42), 7));
  withEnv("AGENTPAY_TEST_KNOB", "0", () => assert.equal(numEnv("AGENTPAY_TEST_KNOB", 42, { min: 0 }), 0));
});

check("a non-numeric value throws, naming the variable", () => {
  withEnv("AGENTPAY_TEST_KNOB", "4o", () => {
    assert.throws(() => numEnv("AGENTPAY_TEST_KNOB", 42), /AGENTPAY_TEST_KNOB/);
  });
});

check("an out-of-range or non-integer value throws, naming the variable", () => {
  withEnv("AGENTPAY_TEST_KNOB", "-5", () => {
    assert.throws(() => numEnv("AGENTPAY_TEST_KNOB", 42, { min: 1 }), /AGENTPAY_TEST_KNOB/);
  });
  withEnv("AGENTPAY_TEST_KNOB", "3.5", () => {
    assert.throws(() => numEnv("AGENTPAY_TEST_KNOB", 42, { integer: true }), /AGENTPAY_TEST_KNOB/);
  });
});

check("requiring settings with a non-numeric PORT refuses to load, naming PORT", () => {
  withEnv("PORT", "80o8", () => {
    delete require.cache[require.resolve("./settings")]; // force the top-level config to re-run
    assert.throws(() => require("./settings"), /PORT/);
  });
  // env restored by withEnv; now reload cleanly so later requirers get a valid cached module.
  delete require.cache[require.resolve("./settings")];
  require("./settings");
});

console.log(`\n${process.exitCode ? "FAIL" : "PASS"} — ${passed} passed\n`);
