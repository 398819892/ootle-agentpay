//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause

/**
 * API key -> on-chain session mapping (/api/v1/keys/:id/session) — zero-dependency tests.
 *
 * The chain itself is not needed for the contract tested here: the deterministic key -> label
 * mapping, the role gate (admin only), the 404 for an unknown key, the 409 when no budget is open,
 * the session info exposed on GET /keys, and the index advertising the endpoints. The real on-chain
 * behaviour (pay proves `key-<id>`, revoke_session makes the validators refuse that key) is covered
 * by the live-swarm run documented in docs/api.md.
 */
"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const { sessionLabel, sessionGeneration, SESSION_PREFIX } = require("./apikeys");

const HOST = "127.0.0.1";
const PORT = 20000 + Math.floor(Math.random() * 20000);
const AGENT_KEY = "sk_agent_" + "a".repeat(32);
const ADMIN_KEY = "sk_admin_" + "b".repeat(32);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-keysess-"));
const env = {
  ...process.env,
  HOST,
  PORT: String(PORT),
  AGENTPAY_WALLETD_URL: "http://127.0.0.1:1/json_rpc", // dead on purpose: nothing here may need the chain
  AGENTPAY_API_KEYS: `agent:bot1:${AGENT_KEY}, admin:ops:${ADMIN_KEY}`,
  AGENTPAY_STATE_FILE: path.join(tmp, "state.json"),
  AGENTPAY_TXLOG_FILE: path.join(tmp, "txlog.json"),
  AGENTPAY_AUDIT_FILE: path.join(tmp, "audit.log"),
};
delete env.DASHBOARD_PASSWORD;
delete env.AGENTPAY_ADMIN_PASSWORD;

function request(method, pathname, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data != null) {
      h["Content-Type"] = "application/json";
      h["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request({ host: HOST, port: PORT, method, path: pathname, headers: h }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
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
  console.log("\nAPI key -> on-chain session tests\n");

  // 0. the pure mapping
  check("sessionLabel is deterministic: key-<id>", sessionLabel("bot1") === SESSION_PREFIX + "bot1" && sessionLabel("bot1") === "key-bot1");
  check("sessionLabel stays within the session-label alphabet/length for the longest legal id",
    /^[A-Za-z0-9_.\-]{1,64}$/.test(sessionLabel("k".repeat(48))));
  check("sessionLabel refuses an id that could not be a key id", (() => { try { sessionLabel('x") ; drop'); return false; } catch { return true; } })());
  check("generations: key-<id>, key-<id>.2 …", sessionLabel("bot1", 2) === "key-bot1.2" && sessionLabel("bot1", 10) === "key-bot1.10");
  check("sessionGeneration parses its own labels and nothing else",
    sessionGeneration("key-bot1", "bot1") === 1 && sessionGeneration("key-bot1.2", "bot1") === 2 && sessionGeneration("key-bot1.12", "bot1") === 12 &&
    sessionGeneration("key-bot12", "bot1") === 0 && sessionGeneration("key-bot1.x", "bot1") === 0 && sessionGeneration("key-bot1.0", "bot1") === 0 &&
    sessionGeneration("key-bot1.1", "bot1") === 0 && sessionGeneration("default", "bot1") === 0);

  const child = spawn("node", [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serverErr = "";
  child.stderr.on("data", (d) => (serverErr += d));
  child.stdout.on("data", () => {});
  try { await waitForServer(child); } catch (e) {
    console.error("Failed to start server:", e.message, "\n", serverErr); child.kill(); process.exit(1);
  }
  try {
    // 1. the index advertises the per-key session endpoints
    {
      const r = await request("GET", "/api/v1");
      const eps = (r.json && r.json.endpoints || []).join("\n");
      check("index lists POST /keys/:id/session", eps.includes("/api/v1/keys/:id/session "), eps);
      check("index lists POST /keys/:id/session/revoke", eps.includes("/api/v1/keys/:id/session/revoke"));
    }
    // 2. GET /keys exposes each key's on-chain session state (admin only)
    {
      const denied = await request("GET", "/api/v1/keys", { headers: asAgent });
      check("agent key cannot list keys (403)", denied.status === 403, denied.status);
      const r = await request("GET", "/api/v1/keys", { headers: asAdmin });
      check("admin lists keys (200)", r.status === 200, r.status);
      const bot = r.json && r.json.keys.find((k) => k.id === "bot1");
      check("each key carries session {label, issued, revoked}", Boolean(bot && bot.session), r.json);
      check("label is key-<id>", bot && bot.session.label === "key-bot1", bot && bot.session);
      check("not issued / not revoked before any issue (generation 0)", bot && bot.session.issued === false && bot.session.revoked === false && bot.session.generation === 0, bot && bot.session);
      check("no secret in the listing", !JSON.stringify(r.json).includes(AGENT_KEY) && !JSON.stringify(r.json).includes(ADMIN_KEY));
    }
    // 3. issuing / revoking a key session: role gate, unknown key, no budget
    {
      const a = await request("POST", "/api/v1/keys/bot1/session", { headers: asAgent, body: {} });
      check("agent key cannot issue a key session (403)", a.status === 403, a.status);
      const u = await request("POST", "/api/v1/keys/nobody/session", { headers: asAdmin, body: {} });
      check("unknown key id -> 404", u.status === 404, u.status);
      const nb = await request("POST", "/api/v1/keys/bot1/session", { headers: asAdmin, body: {} });
      check("issue with no budget open -> 409 (no chain call attempted)", nb.status === 409, { status: nb.status, body: nb.json });
      const ra = await request("POST", "/api/v1/keys/bot1/session/revoke", { headers: asAgent, body: {} });
      check("agent key cannot revoke a key session (403)", ra.status === 403, ra.status);
      const ru = await request("POST", "/api/v1/keys/nobody/session/revoke", { headers: asAdmin, body: {} });
      check("revoke for unknown key id -> 404", ru.status === 404, ru.status);
      const rn = await request("POST", "/api/v1/keys/bot1/session/revoke", { headers: asAdmin, body: {} });
      check("revoke with no budget open -> 409", rn.status === 409, { status: rn.status, body: rn.json });
      // a path that is not one of ours still 404s (no accidental prefix match)
      const odd = await request("POST", "/api/v1/keys/bot1/sessions", { headers: asAdmin, body: {} });
      check("unrelated /keys/... path is 404", odd.status === 404, odd.status);
    }
    // 4. the server-side key revoke still works and keeps the session info in its response
    {
      const r = await request("POST", "/api/v1/keys/bot1/revoke", { headers: asAdmin, body: {} });
      check("server-side key revoke -> 200", r.status === 200, r.status);
      const bot = r.json && r.json.keys.find((k) => k.id === "bot1");
      check("revoked key is flagged and still shows its (unissued) session", bot && bot.revoked === true && bot.session && bot.session.issued === false, bot);
      const after = await request("GET", "/api/v1/keys", { headers: asAgent });
      check("the revoked agent key is now rejected (401)", after.status === 401, after.status);
    }
  } finally {
    child.kill();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (serverErr.trim()) console.log("server stderr:\n" + serverErr);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });