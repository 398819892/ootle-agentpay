/**
 * N-11 regression: the cross-site guards must run even with NO password (AUTH_ON off). A no-password
 * localhost dashboard still moves funds, and the network position is the ambient credential — any web
 * page can `fetch("http://127.0.0.1:PORT/api/withdraw", {mode:"no-cors", body:...})`. Previously the
 * whole Origin/CSRF block was inside `if (AUTH_ON)`, so with no password a forged cross-site POST was
 * accepted. We now assert, with NO password set:
 *   • a cross-origin POST is refused (403) before any app logic,
 *   • a POST whose body is not application/json is refused (415) — blocks the <form>/no-cors vector,
 *   • a same-origin JSON POST (and a non-browser POST with no Origin) still passes the gate.
 * No walletd required: every assertion lands on the gate, before any chain call. Zero deps. Run:
 *   node server/csrf_noauth.test.js
 */
"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const PORT = 20000 + Math.floor(Math.random() * 20000);
const HOST = "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-csrf-"));

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST,
  SESSION_SECRET: "0".repeat(64),
  AGENTPAY_STATE_FILE: path.join(tmp, "state.json"),
  AGENTPAY_TXLOG_FILE: path.join(tmp, "txlog.json"),
  AGENTPAY_AUDIT_FILE: path.join(tmp, "audit.log"),
};
delete env.DASHBOARD_PASSWORD;       // no password → AUTH_ON off (the mode N-11 is about)
delete env.AGENTPAY_ADMIN_PASSWORD;  // no step-up either
delete env.AGENTPAY_API_KEYS;

// A low-level request so we can set an arbitrary Content-Type and send a raw (non-JSON) body.
function raw(method, pathname, { headers = {}, rawBody = null } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (rawBody != null) h["Content-Length"] = Buffer.byteLength(rawBody);
    const req = http.request({ host: HOST, port: PORT, method, path: pathname, headers: h }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on("error", reject);
    if (rawBody != null) req.write(rawBody);
    req.end();
  });
}
const json = (method, pathname, obj, headers = {}) =>
  raw(method, pathname, { headers: { "Content-Type": "application/json", ...headers }, rawBody: JSON.stringify(obj) });

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}

function boot() {
  const child = spawn("node", [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    (async () => {
      while (Date.now() < deadline) {
        try { if ((await raw("GET", "/api/session")).status === 200) return resolve({ child, get log() { return log; } }); } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 150));
        if (child.exitCode != null) return reject(new Error("server exited early: " + log));
      }
      reject(new Error("server not ready: " + log));
    })();
  });
}

async function main() {
  console.log("\nN-11: cross-site guards must hold with NO password (AUTH_ON off)\n");
  const be = await boot();
  try {
    // Confirm we really are in no-password mode.
    const sess = await raw("GET", "/api/session");
    check("baseline: no-password mode (authRequired false)", sess.json && sess.json.authRequired === false, JSON.stringify(sess.json));

    // 1) A cross-origin POST is refused outright — the core N-11 fix.
    const cross = await json("POST", "/api/withdraw", { amount: "1000000" }, { Origin: "http://evil.example:9" });
    check("cross-origin withdraw refused (403) even with no password", cross.status === 403,
      `${cross.status} ${cross.json && cross.json.error}`);

    // 2) A POST carrying a non-JSON body is refused (415): the <form>/no-cors body vector. Same-origin,
    //    so only the Content-Type guard can stop it.
    const textBody = await raw("POST", "/api/withdraw", {
      headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
      rawBody: '{"amount":"1000000"}',
    });
    check("non-JSON body refused (415)", textBody.status === 415, `${textBody.status} ${textBody.json && textBody.json.error}`);

    // Also a no-cors fetch often sends no Content-Type at all → Node/curl would omit it; simulate an
    // unspecified content type with a body.
    const noCt = await raw("POST", "/api/withdraw", { headers: { Origin: ORIGIN }, rawBody: '{"amount":"1"}' });
    check("body with no Content-Type refused (415)", noCt.status === 415, `${noCt.status} ${noCt.json && noCt.json.error}`);

    // 3) The legit paths still pass the gate (reach app logic, i.e. NOT 403/415). Without a budget the
    //    app answers 409 "no budget open" — the point is only that the CSRF gate let it through.
    const sameOrigin = await json("POST", "/api/withdraw", { amount: "1" }, { Origin: ORIGIN });
    check("same-origin JSON POST passes the gate (not 403/415)", sameOrigin.status !== 403 && sameOrigin.status !== 415,
      `${sameOrigin.status} ${sameOrigin.json && sameOrigin.json.error}`);

    const noOrigin = await json("POST", "/api/withdraw", { amount: "1" }); // non-browser client, no Origin
    check("non-browser JSON POST (no Origin) passes the gate (not 403/415)", noOrigin.status !== 403 && noOrigin.status !== 415,
      `${noOrigin.status} ${noOrigin.json && noOrigin.json.error}`);
  } finally {
    be.child.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
