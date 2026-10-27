/**
 * Automated web-security tests for the AgentPay dashboard backend (zero dependencies).
 *
 * Boots a REAL server process with auth enabled (DASHBOARD_PASSWORD set) on a random port, pointed at
 * throwaway state/audit/journal files, and asserts the web-security boundary end to end:
 *
 *   • security response headers (CSP, nosniff, frame-deny, referrer, permissions) are present
 *   • unauthenticated state-changing requests are refused (401)
 *   • cross-origin state-changing requests are refused (403), including login-CSRF
 *   • a cookie-authenticated request WITHOUT / with a WRONG CSRF token is refused (403)
 *   • a cookie + correct CSRF + same-origin request passes the security layer
 *   • logout actually invalidates the session token (reused cookie → 401)
 *   • a forged X-Forwarded-For can NOT evade the per-IP login lockout (default: XFF untrusted)
 *
 * No walletd is required: every assertion lands on the security layer, before any chain call. Run:
 *   node server/security.test.js
 * Exit code is 0 iff every check passes.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-sec-"));

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST,
  DASHBOARD_PASSWORD: PASSWORD,
  AGENTPAY_ADMIN_PASSWORD: "admin-password-ghijkl",
  SESSION_SECRET: "0".repeat(64), // fixed so the run is deterministic
  AGENTPAY_STATE_FILE: path.join(tmp, "state.json"),
  AGENTPAY_TXLOG_FILE: path.join(tmp, "txlog.json"),
  AGENTPAY_AUDIT_FILE: path.join(tmp, "audit.log"),
  LOGIN_MAX_FAILS: "3",
  LOGIN_LOCK_MINUTES: "10",
  // Leave TRUSTED_PROXY unset so X-Forwarded-For is ignored (the behaviour we assert).
};
delete env.TRUSTED_PROXY;

/** One HTTP request. Returns { status, headers, body, json }. */
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
        try {
          json = JSON.parse(raw);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}

function cookieFrom(res) {
  const sc = res.headers["set-cookie"];
  if (!sc || !sc.length) return null;
  const m = String(sc[0]).match(/^ap_session=([^;]*)/);
  return m ? `ap_session=${m[1]}` : null;
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`);
  }
}

async function waitForServer(child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await request("GET", "/api/session");
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode != null) throw new Error("server exited early (code " + child.exitCode + ")");
  }
  throw new Error("server did not become ready in time");
}

async function main() {
  const child = spawn("node", [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let serverErr = "";
  child.stderr.on("data", (d) => (serverErr += d));
  child.stdout.on("data", () => {});

  try {
    await waitForServer(child);
  } catch (e) {
    console.error("Failed to start server:", e.message, "\n", serverErr);
    child.kill();
    process.exit(1);
  }

  console.log(`\nWeb-security tests (auth ON) @ ${ORIGIN}\n`);

  // 1. security response headers on a static GET
  {
    const r = await request("GET", "/");
    const h = r.headers;
    check("CSP header present with strict script-src", /script-src 'self'/.test(h["content-security-policy"] || ""), h["content-security-policy"]);
    check("CSP forbids framing (frame-ancestors 'none')", /frame-ancestors 'none'/.test(h["content-security-policy"] || ""));
    check("X-Content-Type-Options: nosniff", h["x-content-type-options"] === "nosniff", h["x-content-type-options"]);
    check("X-Frame-Options: DENY", h["x-frame-options"] === "DENY", h["x-frame-options"]);
    check("Referrer-Policy present", Boolean(h["referrer-policy"]), h["referrer-policy"]);
    check("Permissions-Policy present", Boolean(h["permissions-policy"]), h["permissions-policy"]);
    check("No HSTS over plain http", !h["strict-transport-security"], h["strict-transport-security"]);
  }

  // 2. session endpoint (unauthenticated)
  {
    const r = await request("GET", "/api/session");
    check("GET /api/session → 200", r.status === 200, String(r.status));
    check("session: authRequired=true, authed=false, csrfToken=null", r.json && r.json.authRequired === true && r.json.authed === false && r.json.csrfToken == null, JSON.stringify(r.json));
  }

  // 3. unauthenticated state-changing request is refused
  {
    const r = await request("POST", "/api/pay", { headers: { Origin: ORIGIN }, body: { merchant: "x", amount: "1" } });
    check("POST /api/pay unauthenticated → 401", r.status === 401, String(r.status));
  }

  // 4. cross-origin login is refused (login-CSRF)
  {
    const r = await request("POST", "/api/login", { headers: { Origin: "http://evil.example:9" }, body: { password: PASSWORD } });
    check("cross-origin POST /api/login → 403", r.status === 403, String(r.status) + " " + (r.json && r.json.error));
  }

  // 5. same-origin login succeeds, returns a CSRF token + cookie
  let cookie = null;
  let csrf = null;
  {
    const r = await request("POST", "/api/login", { headers: { Origin: ORIGIN }, body: { password: PASSWORD } });
    cookie = cookieFrom(r);
    csrf = r.json && r.json.csrfToken;
    check("same-origin login with correct password → 200", r.status === 200, String(r.status));
    check("login sets an HttpOnly session cookie", Boolean(cookie) && /HttpOnly/i.test(String(r.headers["set-cookie"])), String(r.headers["set-cookie"]));
    check("login returns a CSRF token", Boolean(csrf));
  }

  // 6. authed request WITHOUT CSRF token is refused
  {
    const r = await request("POST", "/api/pay", { headers: { Origin: ORIGIN, Cookie: cookie }, body: { merchant: "x", amount: "1" } });
    check("cookie but NO CSRF token → 403", r.status === 403 && r.json && r.json.csrf === true, String(r.status) + " " + JSON.stringify(r.json));
  }

  // 7. authed request with a WRONG CSRF token is refused
  {
    const r = await request("POST", "/api/pay", { headers: { Origin: ORIGIN, Cookie: cookie, "X-CSRF-Token": "not-the-token" }, body: { merchant: "x", amount: "1" } });
    check("cookie + WRONG CSRF token → 403", r.status === 403, String(r.status));
  }

  // 8. authed + correct CSRF but CROSS-ORIGIN is refused
  {
    const r = await request("POST", "/api/pay", { headers: { Origin: "http://evil.example:9", Cookie: cookie, "X-CSRF-Token": csrf }, body: { merchant: "x", amount: "1" } });
    check("cookie + CSRF but cross-origin → 403", r.status === 403, String(r.status));
  }

  // 9. cookie + correct CSRF + same origin PASSES the security layer (409 "no budget", not 401/403)
  {
    const r = await request("POST", "/api/pay", { headers: { Origin: ORIGIN, Cookie: cookie, "X-CSRF-Token": csrf }, body: { merchant: "x", amount: "1" } });
    check("cookie + CSRF + same-origin passes security (not 401/403)", r.status !== 401 && r.status !== 403, String(r.status) + " " + (r.json && r.json.error));
    check("…and reaches app logic → 409 no budget open", r.status === 409, String(r.status));
  }

  // 10. logout truly invalidates the token (reused cookie → 401)
  {
    const out = await request("POST", "/api/logout", { headers: { Origin: ORIGIN, Cookie: cookie, "X-CSRF-Token": csrf } });
    check("logout → 200", out.status === 200, String(out.status));
    const reuse = await request("POST", "/api/pay", { headers: { Origin: ORIGIN, Cookie: cookie, "X-CSRF-Token": csrf }, body: { merchant: "x", amount: "1" } });
    check("reusing the logged-out cookie → 401", reuse.status === 401, String(reuse.status));
  }

  // 11. a forged X-Forwarded-For can NOT evade the per-IP login lockout (XFF untrusted by default)
  {
    for (let i = 0; i < 3; i++) {
      await request("POST", "/api/login", { headers: { Origin: ORIGIN, "X-Forwarded-For": `9.9.9.${i}` }, body: { password: "wrong" } });
    }
    const r = await request("POST", "/api/login", { headers: { Origin: ORIGIN, "X-Forwarded-For": "1.2.3.4" }, body: { password: "wrong" } });
    check("locked out despite a fresh forged X-Forwarded-For → 429", r.status === 429, String(r.status) + " " + (r.json && r.json.error));
  }

  child.kill();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
