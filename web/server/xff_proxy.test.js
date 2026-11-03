/**
 * N-2 regression: in single-hop proxy mode (TRUSTED_PROXY=true), the client IP used for the login
 * throttle / lockout must be the RIGHT-most X-Forwarded-For entry — the one our trusted proxy appends
 * (nginx `$proxy_add_x_forwarded_for`, Caddy) — NOT the left-most, which the client supplies and can
 * forge. Taking the left-most let an attacker:
 *   (a) LOCK OUT a victim by putting the victim's IP left-most, and
 *   (b) BYPASS the throttle (unlimited password guesses) by rotating the left-most each attempt.
 *
 * Boots a REAL server with auth on and TRUSTED_PROXY=true, then simulates the header the server sees
 * AFTER the proxy appended the real peer: "<client-supplied>, <real-client>". Zero dependencies. Run:
 *   node server/xff_proxy.test.js
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
const PASSWORD = "test-password-abcdef";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-xff-"));

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST,
  DASHBOARD_PASSWORD: PASSWORD,
  SESSION_SECRET: "0".repeat(64),
  AGENTPAY_STATE_FILE: path.join(tmp, "state.json"),
  AGENTPAY_TXLOG_FILE: path.join(tmp, "txlog.json"),
  AGENTPAY_AUDIT_FILE: path.join(tmp, "audit.log"),
  LOGIN_MAX_FAILS: "3",
  LOGIN_LOCK_MINUTES: "10",
  TRUSTED_PROXY: "true", // single trusted hop — the mode N-2 is about
};

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

// A failed login from a given forged XFF. `xff` is the FULL header the server receives (proxy already
// appended the real client as the last entry).
function badLogin(xff) {
  return request("POST", "/api/login", { headers: { Origin: ORIGIN, "X-Forwarded-For": xff }, body: { password: "wrong" } });
}

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
        try { if ((await request("GET", "/api/session")).status === 200) return resolve({ child, get log() { return log; } }); } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 150));
        if (child.exitCode != null) return reject(new Error("server exited early: " + log));
      }
      reject(new Error("server not ready: " + log));
    })();
  });
}

async function main() {
  console.log("\nN-2: single-hop proxy must key the login throttle on the RIGHT-most (proxy-appended) XFF\n");
  const be = await boot();
  try {
    // (a) No victim lockout via a forged LEFT-most entry. The attacker burns the lock on their OWN
    //     real IP (10.0.0.1, right-most) while putting the victim 1.2.3.4 left-most. LOGIN_MAX_FAILS=3,
    //     so after 3 fails 10.0.0.1 is locked.
    for (let i = 0; i < 3; i++) await badLogin("1.2.3.4, 10.0.0.1");
    // The victim connects (their real IP 10.0.0.2 is right-most; 1.2.3.4 appears left-most only because
    // the attacker's forgery is irrelevant now). They must NOT be locked out: a wrong password → 401,
    // not 429. Under the bug (key = left-most 1.2.3.4) this would be 429.
    const victim = await badLogin("1.2.3.4, 10.0.0.2");
    check("a forged left-most XFF cannot lock out a victim (401, not 429)", victim.status === 401,
      `${victim.status} ${victim.json && victim.json.error}`);

    // (b) No throttle bypass by rotating the LEFT-most entry. All four attempts share the same real
    //     right-most IP 20.0.0.9; the key must bind to it, so the 4th attempt is locked.
    for (let i = 1; i <= 3; i++) await badLogin(`7.7.7.${i}, 20.0.0.9`);
    const fourth = await badLogin("7.7.7.4, 20.0.0.9");
    check("rotating the left-most XFF cannot evade the throttle (429 on the 4th)", fourth.status === 429,
      `${fourth.status} ${fourth.json && fourth.json.error}`);

    // Sanity: the correct password from a NEW real IP (not throttled) still logs in — the throttle is
    // per-(right-most)-IP, not global.
    const ok = await request("POST", "/api/login", { headers: { Origin: ORIGIN, "X-Forwarded-For": "8.8.8.8, 30.0.0.1" }, body: { password: PASSWORD } });
    check("a fresh real IP with the right password still logs in (200)", ok.status === 200, `${ok.status}`);
  } finally {
    be.child.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
