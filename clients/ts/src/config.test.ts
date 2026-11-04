//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause

// The shared config source (agentpay.config.json / AGENTPAY_*) read by the TS client, mirroring the
// Python agentpay.config and web/server/config.js: precedence (explicit > env > file > default), the
// deprecated OOTLE_WALLETD_TOKEN alias, and the convenience factories.
//     npm run build && node --test dist/config.test.js

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getConfig, getConfigBool, loadConfig, walletdFromConfig, budgetFromConfig, apiClientFromConfig } from "./config";
import { WalletdClient } from "./walletd";

function withConfig(data: Record<string, unknown>, env: Record<string, string>, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apcfg-"));
  const file = path.join(dir, "agentpay.config.json");
  fs.writeFileSync(file, JSON.stringify(data));
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

test("precedence: explicit > env > file > default", () => {
  withConfig({ walletd_url: "http://file" }, {}, () => {
    assert.equal(getConfig("walletd_url", { default: "http://d" }), "http://file");
  });
  withConfig({ walletd_url: "http://file" }, { AGENTPAY_WALLETD_URL: "http://env" }, () => {
    assert.equal(getConfig("walletd_url", { default: "http://d" }), "http://env");
    assert.equal(getConfig("walletd_url", { explicit: "http://x" }), "http://x");
  });
});

test("getConfigBool reads env then file", () => {
  withConfig({ proof_windows: false }, {}, () => {
    assert.equal(getConfigBool("proof_windows", true), false);
  });
  withConfig({ proof_windows: false }, { AGENTPAY_PROOF_WINDOWS: "on" }, () => {
    assert.equal(getConfigBool("proof_windows", false), true);
  });
});

test("walletd_token honours the deprecated OOTLE_ alias then the canonical name", () => {
  withConfig({}, { OOTLE_WALLETD_TOKEN: "legacy" }, () => {
    assert.equal(getConfig("walletd_token"), "legacy");
  });
  withConfig({}, { OOTLE_WALLETD_TOKEN: "legacy", AGENTPAY_WALLETD_TOKEN: "canonical" }, () => {
    assert.equal(getConfig("walletd_token"), "canonical");
  });
});

test("loadConfig is fail-soft and factories resolve from it", () => {
  withConfig(
    { walletd_url: "http://w/json_rpc", walletd_token: "t", budget_template: "template_x", owner_account: "o", api_url: "https://pay", api_key: "sk_a" },
    {},
    () => {
      assert.deepEqual(loadConfig().owner_account, "o");

      const w = walletdFromConfig();
      assert.equal(w.url, "http://w/json_rpc");

      const b = budgetFromConfig(new WalletdClient("http://ignored/json_rpc"));
      assert.equal(b.budgetTemplate, "template_x");
      assert.equal(b.ownerAccount, "o");

      const api = apiClientFromConfig();
      assert.ok(api); // constructed without throwing (baseUrl + apiKey came from the file)
    },
  );
});

test("apiClientFromConfig throws when no api_key is configured", () => {
  withConfig({ api_url: "https://pay" }, {}, () => {
    assert.throws(() => apiClientFromConfig());
  });
});
