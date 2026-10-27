/**
 * Step-up CONFIRMATION-TOKEN binding tests for the AgentPay dashboard (zero dependencies).
 *
 * A high-risk action (withdraw / change caps / revoke / issue-or-revoke a session / open a budget /
 * change the whitelist) requires a second confirmation independent of the login session: the operator
 * re-presents the admin secret and receives a short-lived, SINGLE-USE token. This test proves the
 * token is bound to the SPECIFIC action, not merely to the operation name:
 *
 *   • no token               → the high-risk op is refused (confirmRequired).
 *   • token for amount 100    used with amount 900 → refused (funding-parameter mismatch).
 *   • token for amount 100    used with amount 100 → PASSES the step-up gate (reaches app logic).
 *   • the token is single-use: the same (matching) token a second time → refused.
 *   • token minted for one op  cannot confirm a DIFFERENT op.
 *   • token for session "alpha" cannot confirm session "beta".
 *
 * Boots a REAL server with auth enabled and a DEAD walletd URL (so a request that passes the step-up
 * gate fails fast on the chain call rather than touching any live swarm). We only ever assert whether
 * the STEP-UP gate (401 + confirmRequired) was hit — never a chain outcome. Run: node server/stepup.test.js
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
const ADMIN = "admin-password-ghijkl";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-stepup-"));

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST,
  DASHBOARD_PASSWORD: PASSWORD,
  AGENTPAY_ADMIN_PASSWORD: ADMIN,
  SESSION_SECRET: "0".repeat(64),
  AGENTPAY_STATE_FILE: path.join(tmp, "state.json"),
  AGENTPAY_TXLOG_FILE: path.join(tmp, "txlog.json"),
  AGENTPAY_AUDIT_FILE: path.join(tmp, "audit.log"),
  // A dead walletd: any op that PASSES the step-up gate fails fast here (we never assert chain state).
  AGENTPAY_WALLETD_URL: "http://127.0.0.1:1/json_rpc",
};
delete env.TRUSTED_PROXY;

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

  console.log(`\nStep-up token binding tests (auth ON) @ ${ORIGIN}\n`);

  // log in → cookie + csrf
  const login = await request("POST", "/api/login", { headers: { Origin: ORIGIN }, body: { password: PASSWORD } });
  const cookie = cookieFrom(login);
  const csrf = login.json && login.json.csrfToken;
  const H = { Origin: ORIGIN, Cookie: cookie, "X-CSRF-Token": csrf };
  check("logged in (cookie + csrf)", Boolean(cookie) && Boolean(csrf), String(login.status));

  // mint a confirm token for one specific action
  async function mint(fields) {
    const r = await request("POST", "/api/confirm", { headers: H, body: { password: ADMIN, ...fields } });
    return r.json && r.json.token;
  }
  // true iff the response was blocked AT the step-up gate (not by anything downstream)
  const blockedAtStepUp = (r) => r.status === 401 && r.json && r.json.confirmRequired === true;

  // 1. no token → refused at the step-up gate
  {
    const r = await request("POST", "/api/withdraw", { headers: H, body: { amount: "100" } });
    check("withdraw with NO confirm token → refused (confirmRequired)", blockedAtStepUp(r), `${r.status} ${JSON.stringify(r.json)}`);
  }

  // 2. token minted for amount 100, used with amount 900 → refused (parameter mismatch)
  {
    const token = await mint({ op: "withdraw", amount: "100" });
    check("minted a withdraw token", Boolean(token));
    const r = await request("POST", "/api/withdraw", { headers: H, body: { amount: "900", confirmToken: token } });
    check("token for amount 100 used with amount 900 → refused", blockedAtStepUp(r), `${r.status} ${JSON.stringify(r.json)}`);
  }

  // 3. token minted for amount 100, used with amount 100 → PASSES the step-up gate
  let matchingToken;
  {
    matchingToken = await mint({ op: "withdraw", amount: "100" });
    const r = await request("POST", "/api/withdraw", { headers: H, body: { amount: "100", confirmToken: matchingToken } });
    check("token for amount 100 used with amount 100 → passes step-up (not confirmRequired)", !blockedAtStepUp(r), `${r.status} ${JSON.stringify(r.json)}`);
  }

  // 4. single-use: the SAME matching token, used again → refused (already spent)
  {
    const r = await request("POST", "/api/withdraw", { headers: H, body: { amount: "100", confirmToken: matchingToken } });
    check("matching token reused a second time → refused (single-use)", blockedAtStepUp(r), `${r.status} ${JSON.stringify(r.json)}`);
  }

  // 5. a token minted for one op cannot confirm a DIFFERENT op
  {
    const token = await mint({ op: "withdraw", amount: "100" });
    const r = await request("POST", "/api/revoke", { headers: H, body: { confirmToken: token } });
    check("withdraw token cannot confirm revoke → refused", blockedAtStepUp(r), `${r.status} ${JSON.stringify(r.json)}`);
  }

  // 6. session binding: token for session "alpha" cannot confirm session "beta"
  {
    const token = await mint({ op: "issueSession", session: "alpha" });
    const bad = await request("POST", "/api/sessions", { headers: H, body: { session: "beta", confirmToken: token } });
    check("issueSession token for 'alpha' used with 'beta' → refused", blockedAtStepUp(bad), `${bad.status} ${JSON.stringify(bad.json)}`);
    const token2 = await mint({ op: "issueSession", session: "alpha" });
    const ok = await request("POST", "/api/sessions", { headers: H, body: { session: "alpha", confirmToken: token2 } });
    check("issueSession token for 'alpha' used with 'alpha' → passes step-up", !blockedAtStepUp(ok), `${ok.status} ${JSON.stringify(ok.json)}`);
  }

  // 7. a tampered token → refused
  {
    const token = await mint({ op: "withdraw", amount: "100" });
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "b" : "a");
    const r = await request("POST", "/api/withdraw", { headers: H, body: { amount: "100", confirmToken: tampered } });
    check("a tampered token → refused", blockedAtStepUp(r), `${r.status} ${JSON.stringify(r.json)}`);
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
