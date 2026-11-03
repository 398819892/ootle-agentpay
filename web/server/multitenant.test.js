//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause

/**
 * Multi-tenant boundary of the /api/v1 payment surface — zero-dependency tests (no chain needed).
 *
 * The chain is not exercised here: we SEED the operation journal with already-settled `pay` records
 * belonging to two different API keys, boot a real server against a dead walletd (every record is
 * terminal + carries its event, so startup reconcile never calls out), and assert the per-key
 * boundary the server enforces around those records:
 *
 *   S-2  the v1 idempotency key is namespaced by the CALLING key, so the SAME Idempotency-Key value
 *        sent by two different keys is two independent payments (no cross-key collision / leak).
 *   S-3  a member key sees only the payments it made — on the list AND on a single lookup — while an
 *        admin key keeps the full cross-key view. The public receipt id is always the caller's own
 *        raw Idempotency-Key, with the internal namespace stripped.
 *
 * The chain-authoritative session-revoke probe (S-7) is live-swarm behaviour and is covered by the
 * run documented in docs/api.md, like the rest of the on-chain session contract.
 */
"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const HOST = "127.0.0.1";
const PORT = 20000 + Math.floor(Math.random() * 20000);
const AGENT_KEY = "sk_agent_" + "a".repeat(32); // id "bot1", role member
const ADMIN_KEY = "sk_admin_" + "b".repeat(32); // id "ops",  role admin
const NUL = "\u0000";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-multitenant-"));

// A settled `pay` record in the on-disk journal shape. Terminal (confirmed) + an event present, and
// NO tx id, so startup reconcile treats it as nothing to do (no walletd call).
function rec(key, { merchant, amount, seq }) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    key, op: "pay", status: "confirmed", seq,
    component: "component_budget",
    params: { merchant, amount: String(amount), invoiceId: "inv" + seq, session: "key-x", memo: "" },
    event: { merchant, amount, memo: "", session: "key-x" },
    txId: null, reason: null, createdAt: now, updatedAt: now,
  };
}

// Two keys, and crucially TWO records that share the raw idempotency key "same" (one per key).
const SEED = [
  rec(`bot1${NUL}abc`, { merchant: "merchant_bot1_a", amount: 10, seq: 1 }),
  rec(`bot1${NUL}same`, { merchant: "merchant_bot1_same", amount: 11, seq: 2 }),
  rec(`ops${NUL}same`, { merchant: "merchant_ops_same", amount: 22, seq: 3 }),
  rec(`ops${NUL}xyz`, { merchant: "merchant_ops_x", amount: 23, seq: 4 }),
  rec(`pay:legacy`, { merchant: "merchant_legacy", amount: 5, seq: 5 }), // un-namespaced (owner/dashboard)
];
fs.writeFileSync(path.join(tmp, "txlog.json"), JSON.stringify(SEED, null, 2));

const env = {
  ...process.env,
  HOST,
  PORT: String(PORT),
  AGENTPAY_WALLETD_URL: "http://127.0.0.1:1/json_rpc", // dead on purpose: nothing here may touch the chain
  AGENTPAY_API_KEYS: `agent:bot1:${AGENT_KEY}, admin:ops:${ADMIN_KEY}`,
  AGENTPAY_STATE_FILE: path.join(tmp, "state.json"),
  AGENTPAY_TXLOG_FILE: path.join(tmp, "txlog.json"),
  AGENTPAY_AUDIT_FILE: path.join(tmp, "audit.log"),
};
delete env.DASHBOARD_PASSWORD;
delete env.AGENTPAY_ADMIN_PASSWORD;

function request(method, pathname, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, method, path: pathname, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
const asAgent = { Authorization: `Bearer ${AGENT_KEY}` };
const asAdmin = { Authorization: `Bearer ${ADMIN_KEY}` };

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? "  — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); }
}

async function waitForServer(child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const r = await request("GET", "/api/v1"); if (r.status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode != null) throw new Error("server exited early (code " + child.exitCode + ")");
  }
  throw new Error("server did not become ready in time");
}

async function main() {
  console.log("\nMulti-tenant /api/v1 payment boundary tests\n");
  const { spawn } = require("node:child_process");
  const child = spawn("node", [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serverErr = "";
  child.stderr.on("data", (d) => (serverErr += d));
  child.stdout.on("data", () => {});
  try { await waitForServer(child); } catch (e) {
    console.error("Failed to start server:", e.message, "\n", serverErr); child.kill(); process.exit(1);
  }
  try {
    // --- S-3: the member key sees ONLY its own payments on the list, ids stripped to its raw keys ---
    {
      const r = await request("GET", "/api/v1/payments", { headers: asAgent });
      check("member lists payments (200)", r.status === 200, r.status);
      const ids = (r.json && r.json.payments || []).map((p) => p.id).sort();
      check("member sees exactly its own two receipts (raw ids, namespace stripped)",
        JSON.stringify(ids) === JSON.stringify(["abc", "same"]), ids);
      const leaked = (r.json && r.json.payments || []).some(
        (p) => p.merchant === "merchant_ops_same" || p.merchant === "merchant_ops_x" || p.merchant === "merchant_legacy",
      );
      check("member list never leaks another key's or the owner's payment", !leaked, r.json);
    }
    // --- S-2: the SAME raw idempotency key under two keys is two independent payments ---
    {
      const m = await request("GET", "/api/v1/payments/same", { headers: asAgent });
      check("member fetches its own 'same' (200)", m.status === 200, m.status);
      check("member's 'same' is ITS record, not the admin key's same-named one",
        m.json && m.json.receipt && m.json.receipt.merchant === "merchant_bot1_same", m.json && m.json.receipt);
      const a = await request("GET", "/api/v1/payments/same", { headers: asAdmin });
      check("admin's own 'same' resolves to the admin key's record (independent namespace)",
        a.status === 200 && a.json && a.json.receipt && a.json.receipt.merchant === "merchant_ops_same",
        a.json && a.json.receipt);
    }
    // --- S-3: a member cannot read another key's (or the owner's) payment by its id ---
    {
      const x = await request("GET", "/api/v1/payments/xyz", { headers: asAgent });
      check("member cannot fetch the admin key's 'xyz' (404)", x.status === 404, x.status);
      const l = await request("GET", "/api/v1/payments/legacy", { headers: asAgent });
      check("member cannot fetch an un-namespaced owner payment (404)", l.status === 404, l.status);
      const mine = await request("GET", "/api/v1/payments/abc", { headers: asAgent });
      check("member can still fetch its own 'abc' (200)", mine.status === 200 && mine.json.receipt.id === "abc", mine.json);
    }
    // --- S-3: the admin key keeps the full cross-key view ---
    {
      const r = await request("GET", "/api/v1/payments", { headers: asAdmin });
      check("admin lists payments (200)", r.status === 200, r.status);
      const n = (r.json && r.json.payments || []).length;
      check("admin sees ALL five seeded payments (full cross-key view)", n === 5, n);
      const x = await request("GET", "/api/v1/payments/xyz", { headers: asAdmin });
      check("admin fetches its own 'xyz' (200)", x.status === 200, x.status);
    }
  } finally {
    child.kill();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (serverErr.trim()) console.log("server stderr:\n" + serverErr);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
