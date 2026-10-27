/**
 * Audit DURABILITY tests for high-risk operations (zero dependencies).
 *
 * A high-risk fund operation must have its audit record durably persisted as PART OF the operation:
 * if the audit write fails, the operation must FAIL and must NOT take effect — never silently proceed
 * unrecorded. This test proves that end to end against a real server:
 *
 *   BROKEN audit sink (unwritable path):
 *     • a high-risk op (freeze) is REFUSED (500 auditUnavailable)…
 *     • …and did NOT take effect (state still reports frozen=false)
 *     • reads (GET /api/state) still work (they are not audited and not blocked)
 *   WORKING audit sink:
 *     • the same high-risk op SUCCEEDS and takes effect (frozen=true)
 *     • a DURABLE audit trail exists for it (an `attempt` record written before the effect)
 *
 * `freeze` is used because it is high-risk but purely local (no chain / walletd needed), so the test is
 * deterministic and never touches a swarm. Open local-dev mode (no password) isolates this from the
 * step-up gate. Run: node server/audit.test.js
 */
"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const HOST = "127.0.0.1";

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data != null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request({ host: HOST, port, method, path: pathname, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, json, body: raw });
      });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
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

async function boot(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn("node", [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST,
      AGENTPAY_WALLETD_URL: "http://127.0.0.1:1/json_rpc", // dead; freeze never needs it anyway
      SESSION_SECRET: "0".repeat(64),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await request(port, "GET", "/api/session");
      if (r.status === 200) return { port, child, get log() { return log; } };
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode != null) throw new Error("server exited early: " + log);
  }
  throw new Error("server not ready: " + log);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-audit-"));

  console.log("\nAudit durability tests\n");

  // ---- phase 1: BROKEN audit sink (parent directory does not exist → every write throws) ----
  {
    const brokenAudit = path.join(tmp, "no", "such", "dir", "audit.log");
    const be = await boot({
      AGENTPAY_STATE_FILE: path.join(tmp, "s1.json"),
      AGENTPAY_TXLOG_FILE: path.join(tmp, "t1.json"),
      AGENTPAY_AUDIT_FILE: brokenAudit,
    });
    try {
      const before = await request(be.port, "GET", "/api/state");
      check("reads work despite broken audit (GET /api/state → 200)", before.status === 200, String(before.status));
      check("precondition: not frozen", before.json && before.json.frozen === false, JSON.stringify(before.json && before.json.frozen));

      const fr = await request(be.port, "POST", "/api/freeze", {});
      check("high-risk op REFUSED when audit cannot be recorded (500)", fr.status === 500, `${fr.status} ${JSON.stringify(fr.json)}`);
      check("…with an auditUnavailable signal", fr.json && fr.json.auditUnavailable === true, JSON.stringify(fr.json));

      const after = await request(be.port, "GET", "/api/state");
      check("high-risk op did NOT take effect (still frozen=false)", after.json && after.json.frozen === false, JSON.stringify(after.json && after.json.frozen));
    } finally {
      be.child.kill();
    }
  }

  // ---- phase 2: WORKING audit sink ----
  {
    const goodAudit = path.join(tmp, "audit2.log");
    const be = await boot({
      AGENTPAY_STATE_FILE: path.join(tmp, "s2.json"),
      AGENTPAY_TXLOG_FILE: path.join(tmp, "t2.json"),
      AGENTPAY_AUDIT_FILE: goodAudit,
    });
    try {
      const fr = await request(be.port, "POST", "/api/freeze", {});
      check("high-risk op SUCCEEDS with a working audit sink", fr.status === 200, `${fr.status} ${JSON.stringify(fr.json)}`);
      const after = await request(be.port, "GET", "/api/state");
      check("…and takes effect (frozen=true)", after.json && after.json.frozen === true, JSON.stringify(after.json && after.json.frozen));

      const lines = fs.readFileSync(goodAudit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const freezeAttempt = lines.find((l) => l.op === "freeze" && l.status === "attempt");
      const freezeOk = lines.find((l) => l.op === "freeze" && l.status === "ok");
      check("a durable `attempt` record was written before the effect", Boolean(freezeAttempt), JSON.stringify(lines.map((l) => [l.op, l.status])));
      check("a durable `ok` outcome record was written", Boolean(freezeOk));
    } finally {
      be.child.kill();
    }
  }

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
