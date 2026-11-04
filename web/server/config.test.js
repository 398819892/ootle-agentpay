//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause

/**
 * Shared config source (server-side reader) — zero-dependency unit tests.
 *
 * No server boot / chain needed: these exercise web/server/config.js directly — the same resolver
 * server.js uses for WALLETD_URL / BUDGET_TEMPLATE / OWNER — proving precedence (env > file >
 * defaults.json template > default), the OOTLE_ token alias, getBool, and fail-soft parsing. The
 * schema is kept in lock-step with agentpay/config.py and clients/ts/src/config.ts.
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");

const cfg = require("./config");

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

function withConfig(data, env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apcfg-"));
  const file = path.join(dir, "agentpay.config.json");
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("AGENTPAY_") || k === "OOTLE_WALLETD_TOKEN") delete process.env[k];
  }
  process.env.AGENTPAY_CONFIG = file;
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nShared config source (web/server/config.js)\n");

check("precedence: env > file > default", () => {
  withConfig({ walletd_url: "http://file" }, {}, () => {
    assert.equal(cfg.get("walletd_url", { default: "http://d" }), "http://file");
  });
  withConfig({ walletd_url: "http://file" }, { AGENTPAY_WALLETD_URL: "http://env" }, () => {
    assert.equal(cfg.get("walletd_url", { default: "http://d" }), "http://env");
  });
});

check("explicit beats everything", () => {
  withConfig({ owner_account: "file" }, { AGENTPAY_OWNER_ACCOUNT: "env" }, () => {
    assert.equal(cfg.get("owner_account", { explicit: "x" }), "x");
  });
});

check("default when nothing set", () => {
  withConfig("{}", {}, () => {
    assert.equal(cfg.get("owner_account", { default: "default" }), "default");
  });
});

check("budget_template file value overrides the defaults.json template", () => {
  withConfig({ budget_template: "template_fromfile" }, {}, () => {
    assert.equal(cfg.get("budget_template", { templateName: "agent_budget" }), "template_fromfile");
  });
});

check("getBool reads env then file", () => {
  withConfig({ proof_windows: false }, {}, () => {
    assert.equal(cfg.getBool("proof_windows", true), false);
  });
  withConfig({ proof_windows: false }, { AGENTPAY_PROOF_WINDOWS: "on" }, () => {
    assert.equal(cfg.getBool("proof_windows", false), true);
  });
});

check("walletd_token honours the deprecated OOTLE_ alias, canonical wins", () => {
  withConfig({}, { OOTLE_WALLETD_TOKEN: "legacy" }, () => {
    assert.equal(cfg.get("walletd_token"), "legacy");
  });
  withConfig({}, { OOTLE_WALLETD_TOKEN: "legacy", AGENTPAY_WALLETD_TOKEN: "canonical" }, () => {
    assert.equal(cfg.get("walletd_token"), "canonical");
  });
});

check("fail-soft on malformed file", () => {
  withConfig("{ not json", {}, () => {
    assert.deepEqual(cfg.loadFile(), {});
    assert.equal(cfg.get("walletd_url", { default: "http://d" }), "http://d");
  });
});

console.log(`\n${process.exitCode ? "FAIL" : "PASS"} — ${passed} passed\n`);
