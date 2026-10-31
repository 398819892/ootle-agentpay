/**
 * Concurrency test for #11: a read (GET) must NOT queue behind an in-flight write holding the serial
 * lock. We stand up a tiny MOCK walletd whose `transactions.submit_manifest` is slow (parks a write
 * inside `serialize()` for ~2s), boot the real server against it, fire a write (POST /api/budget) and
 * — while it is parked — fire a read (GET /api/state). The read must return promptly, not after the
 * write finishes. Zero dependencies (Node built-ins). Run: node server/concurrency.test.js
 */
"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const HOST = "127.0.0.1";
const OWNER_COMPONENT = "component_" + "a".repeat(64);
const SUBMIT_DELAY_MS = 2000;

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data != null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const t0 = Date.now();
    const req = http.request({ host: HOST, port, method, path: pathname, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, ms: Date.now() - t0 });
      });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}

/** A mock wallet daemon: instant for everything except submit_manifest, which is delayed. */
function startMockWalletd() {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let rpc = {};
      try { rpc = JSON.parse(raw); } catch { /* ignore */ }
      const method = rpc.method;
      const reply = (result) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })); };
      switch (method) {
        case "auth.request": return reply({ token: "mock-token" });
        case "accounts.list":
          return reply({ accounts: [{ account: { name: "default", component_address: OWNER_COMPONENT } }] });
        case "accounts.get_balances": return reply({ balances: [{ token_symbol: "tTARI", balance: 1_000_000 }] });
        case "accounts.create_free_test_coins": return reply({});
        case "settings.get": return reply({ current_epoch: 1 });
        case "substates.get": return reply({ substate: {} });
        case "transactions.submit_manifest":
          // The write parks HERE (inside the server's serialize lock) for the delay.
          return setTimeout(() => reply({ transaction_id: "mocktx", result: { Accept: {} } }), SUBMIT_DELAY_MS);
        case "transactions.get_result":
          return reply({ result: { Accept: {} }, status: "Accept" });
        default: return reply({});
      }
    });
  });
  return new Promise((resolve) => server.listen(0, HOST, () => resolve({ server, port: server.address().port })));
}

async function boot(walletdUrl, env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn("node", [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), HOST, AGENTPAY_WALLETD_URL: walletdUrl, SESSION_SECRET: "0".repeat(64), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await request(port, "GET", "/api/session")).status === 200) return { port, child, get log() { return log; } }; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
    if (child.exitCode != null) throw new Error("server exited early: " + log);
  }
  throw new Error("server not ready: " + log);
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-conc-"));
  console.log("\nConcurrency test (#11: reads are not blocked by an in-flight write)\n");
  const mock = await startMockWalletd();
  const be = await boot(`http://${HOST}:${mock.port}/json_rpc`, {
    AGENTPAY_STATE_FILE: path.join(tmp, "s.json"),
    AGENTPAY_TXLOG_FILE: path.join(tmp, "t.json"),
    AGENTPAY_AUDIT_FILE: path.join(tmp, "a.log"),
  });
  try {
    // warm up the walletd connection + confirm a read is fast with no budget open
    const warm = await request(be.port, "GET", "/api/state");
    check("GET /api/state works (no budget) and is fast", warm.status === 200 && warm.ms < 1000, `${warm.status} ${warm.ms}ms`);

    // fire a WRITE that parks in the serialize lock on the slow submit_manifest …
    const writeP = request(be.port, "POST", "/api/budget", { fund: 1000, perTxCap: 100, dailyCap: 500, whitelist: [] });
    await new Promise((r) => setTimeout(r, 200)); // let the write reach submit_manifest and hold the lock

    // … and, while it is parked, a READ must still return promptly (not queued behind the ~2s write)
    const read = await request(be.port, "GET", "/api/state");
    check("GET /api/state returns while a write holds the lock (< 1s)", read.status === 200 && read.ms < 1000, `${read.status} ${read.ms}ms`);

    const write = await writeP;
    check("the write really was parked in the lock (took ~the submit delay)", write.ms >= SUBMIT_DELAY_MS - 300, `${write.ms}ms`);
  } finally {
    be.child.kill();
    mock.server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
