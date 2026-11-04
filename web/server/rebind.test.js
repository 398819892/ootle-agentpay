/**
 * DNS-rebinding regression: the Origin/Referer check proves a POST's Origin matches the request's OWN
 * Host header, but a Host header is attacker-influenceable. A page on evil.example whose DNS is rebound
 * to 127.0.0.1 reaches this loopback server while the browser sends a SELF-CONSISTENT
 * `Host: evil.example` + `Origin: http://evil.example` — which the host-relative Origin check alone
 * would accept, letting that page drive /api/freeze etc. We now pin the Host to an allowlist (loopback
 * + configured hosts); this asserts, with NO password (the most exposed mode):
 *   • a POST with a rebound Host + self-consistent Origin is refused (403),
 *   • the SAME with no Origin (a bare rebound Host) is still refused (403),
 *   • a legitimate loopback Host + matching Origin still passes the gate,
 *   • AGENTPAY_ALLOWED_HOSTS lets a configured public hostname through.
 * No walletd required: every assertion lands on the gate, before any chain call. Zero deps. Run:
 *   node server/rebind.test.js
 */
"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const HOST = "127.0.0.1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-rebind-"));

/** One request. `hostHeader` forges the Host the server sees while the socket still goes to 127.0.0.1
 *  (exactly what DNS rebinding produces). A JSON body is sent so only the Origin/Host gate can stop it. */
function req(port, method, pathname, { origin = null, hostHeader = null, body = { amount: "1" } } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data != null) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
    if (origin) headers["Origin"] = origin;
    if (hostHeader) headers["Host"] = hostHeader;
    const r = http.request({ host: HOST, port, method, path: pathname, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on("error", reject);
    if (data != null) r.write(data);
    r.end();
  });
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}

function boot(extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    ...process.env, PORT: String(port), HOST, SESSION_SECRET: "0".repeat(64),
    AGENTPAY_STATE_FILE: path.join(tmp, `state-${port}.json`),
    AGENTPAY_TXLOG_FILE: path.join(tmp, `txlog-${port}.json`),
    AGENTPAY_AUDIT_FILE: path.join(tmp, `audit-${port}.log`),
    ...extraEnv,
  };
  delete env.DASHBOARD_PASSWORD; delete env.AGENTPAY_ADMIN_PASSWORD; delete env.AGENTPAY_API_KEYS;
  const child = spawn("node", [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    (async () => {
      while (Date.now() < deadline) {
        try { if ((await req(port, "GET", "/api/session", { body: null })).status === 200) return resolve({ port, child, get log() { return log; } }); } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 150));
        if (child.exitCode != null) return reject(new Error("server exited early: " + log));
      }
      reject(new Error("server not ready: " + log));
    })();
  });
}

async function main() {
  console.log("\nDNS-rebinding: the Host must be on the allowlist, not merely self-consistent with Origin\n");
  const be = await boot();
  let be2 = null;
  try {
    const port = be.port;

    // 1) Rebound Host + self-consistent Origin → refused. This is the attack the host-relative Origin
    //    check alone would miss.
    const evil = `evil.example:${port}`;
    const rebind = await req(port, "POST", "/api/freeze", { hostHeader: evil, origin: `http://${evil}` });
    check("rebound Host + matching Origin refused (403)", rebind.status === 403, `${rebind.status} ${rebind.json && rebind.json.error}`);

    // 2) A bare rebound Host with no Origin (a non-browser client could still only set Host) → refused,
    //    because the Host itself is not one we serve.
    const bare = await req(port, "POST", "/api/freeze", { hostHeader: evil });
    check("rebound Host with no Origin refused (403)", bare.status === 403, `${bare.status} ${bare.json && bare.json.error}`);

    // 3) The legitimate loopback Host + matching Origin still passes the gate (reaches app logic — here
    //    /api/freeze with no budget still runs; the point is it is NOT a 403 bad-origin refusal).
    const ok = await req(port, "POST", "/api/freeze", { hostHeader: `${HOST}:${port}`, origin: `http://${HOST}:${port}`, body: {} });
    check("loopback Host + matching Origin passes the gate (not 403)", ok.status !== 403, `${ok.status} ${ok.json && ok.json.error}`);

    // 4) A configured public hostname (AGENTPAY_ALLOWED_HOSTS) is accepted; an unlisted one is not.
    be2 = await boot({ AGENTPAY_ALLOWED_HOSTS: "pay.example.com" });
    const good = await req(be2.port, "POST", "/api/freeze", { hostHeader: `pay.example.com:${be2.port}`, origin: `http://pay.example.com:${be2.port}`, body: {} });
    check("configured host (AGENTPAY_ALLOWED_HOSTS) passes the gate (not 403)", good.status !== 403, `${good.status} ${good.json && good.json.error}`);
    const other = await req(be2.port, "POST", "/api/freeze", { hostHeader: `other.example:${be2.port}`, origin: `http://other.example:${be2.port}` });
    check("an unlisted host is still refused (403) even with an allowlist set", other.status === 403, `${other.status} ${other.json && other.json.error}`);
  } finally {
    be.child.kill();
    if (be2) be2.child.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
