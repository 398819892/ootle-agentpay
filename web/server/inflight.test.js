/**
 * In-flight duplicate guard: an owner money op whose first submit is still UNRESOLVED (pending/unknown
 * on chain) must not be submittable a SECOND time under a fresh idempotency key — the refresh-and-retry
 * double-spend. A page reload drops the in-memory idempotency slot, so the retry mints a new random key
 * that sidesteps the same-key replay; runChainOp now also refuses when an IDENTICAL-fingerprint record
 * is still open. We stand up a MOCK walletd, mount a budget, leave a top-up unresolved, and assert:
 *   • a second IDENTICAL top-up (different key, same amount) is refused (409 inflightDuplicate),
 *   • a top-up with a DIFFERENT amount is NOT blocked (the guard is fingerprint-scoped, not a blanket).
 * Zero dependencies. Run:  node server/inflight.test.js
 */
"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const HOST = "127.0.0.1";
const OWNER_COMPONENT = "component_" + "a".repeat(64);
const NEW_COMPONENT = "component_" + "d".repeat(64);
const TXID = "mocktx-1";

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data != null) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
    const req = http.request({ host: HOST, port, method, path: pathname, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}

/**
 * A mock wallet daemon. `phase`:
 *   "pending" → every real submit's tx reports no verdict (get_result Pending) → the op is journaled
 *               `unknown` (submitted, not confirmed) and stays OPEN.
 *   "accept"  → the pending tx is reported accepted with a result that created NEW_COMPONENT, so a
 *               POST /api/reconcile mounts that budget.
 */
function startMockWalletd() {
  let phase = "pending";
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let rpc = {}; try { rpc = JSON.parse(raw); } catch { /* ignore */ }
      const reply = (result) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })); };
      switch (rpc.method) {
        case "auth.request": return reply({ token: "mock-token" });
        case "accounts.list": return reply({ accounts: [{ account: { name: "default", component_address: OWNER_COMPONENT } }] });
        case "accounts.get_balances": return reply({ balances: [{ token_symbol: "tTARI", balance: 1_000_000 }] });
        case "accounts.create_free_test_coins": return reply({});
        case "settings.get": return reply({ current_epoch: 1 });
        case "substates.get":
          return reply({ Component: { body: { state: [
            { tag: 131, value: { hex: "b".repeat(64) } },
            { tag: 131, value: { hex: "c".repeat(64) } },
          ] } } });
        case "transactions.submit_manifest":
          return reply(rpc.params && rpc.params.dry_run ? { result: { Accept: {} } } : { transaction_id: TXID });
        case "transactions.get_result":
          return phase === "accept"
            ? reply({ finalize: { result: { Accept: { up_substates: [NEW_COMPONENT] } } } })
            : reply({ status: "Pending" });
        default: return reply({});
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, HOST, () => resolve({
      server, port: server.address().port,
      accept: () => { phase = "accept"; },
      stall: () => { phase = "pending"; },
    })));
}

function boot(walletdUrl) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-inflight-"));
  const env = {
    ...process.env, PORT: String(port), HOST, AGENTPAY_WALLETD_URL: walletdUrl, SESSION_SECRET: "0".repeat(64),
    AGENTPAY_STATE_FILE: path.join(tmp, "state.json"), AGENTPAY_TXLOG_FILE: path.join(tmp, "txlog.json"),
    AGENTPAY_AUDIT_FILE: path.join(tmp, "audit.log"),
    AGENTPAY_FINALIZE_TRIES: "1", AGENTPAY_FINALIZE_DELAY_MS: "80", // make the "unknown" verdict quick
  };
  delete env.DASHBOARD_PASSWORD; delete env.AGENTPAY_ADMIN_PASSWORD; delete env.AGENTPAY_API_KEYS;
  const child = spawn("node", [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    (async () => {
      while (Date.now() < deadline) {
        try { if ((await request(port, "GET", "/api/session")).status === 200) return resolve({ port, child, tmp, get log() { return log; } }); } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 150));
        if (child.exitCode != null) return reject(new Error("server exited early: " + log));
      }
      reject(new Error("server not ready: " + log));
    })();
  });
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}

async function main() {
  console.log("\nIn-flight duplicate guard: an unresolved owner op cannot be re-submitted under a fresh key\n");
  const wd = await startMockWalletd();
  const be = await boot(`http://${HOST}:${wd.port}/json_rpc`);
  try {
    const port = be.port;

    // Mount a budget: open comes back unknown (phase pending), then accept + reconcile mounts it.
    const open = await request(port, "POST", "/api/budget", { fund: "1000", perTxCap: "100", dailyCap: "500", epochsPerWindow: 10 });
    check("open budget recorded (pending/unknown)", open.status === 200, `${open.status} ${open.json && open.json.error}`);
    wd.accept();
    await request(port, "POST", "/api/reconcile", {});
    const st = await request(port, "GET", "/api/state");
    check("reconcile mounts the budget", st.status === 200 && st.json && st.json.budget && st.json.budget.component === NEW_COMPONENT,
      JSON.stringify(st.json && st.json.budget));

    // Leave the next top-up unresolved on chain.
    wd.stall();
    const t1 = await request(port, "POST", "/api/top-up", { amount: "5" });
    check("first top-up is submitted-but-unresolved (200 pending)", t1.status === 200 && t1.json && t1.json.pending === true,
      `${t1.status} ${JSON.stringify(t1.json && { pending: t1.json.pending })}`);

    // The refresh-and-retry: an identical top-up under a fresh (default random) key must be refused.
    const t2 = await request(port, "POST", "/api/top-up", { amount: "5" });
    check("identical in-flight top-up refused (409 inflightDuplicate)",
      t2.status === 409 && t2.json && t2.json.inflightDuplicate === true, `${t2.status} ${JSON.stringify(t2.json)}`);

    // A different amount is a different operation (different fingerprint) → NOT blocked.
    const t3 = await request(port, "POST", "/api/top-up", { amount: "9" });
    check("a different-amount top-up is NOT blocked by the guard", t3.status !== 409, `${t3.status} ${JSON.stringify(t3.json && { status: t3.status })}`);
  } finally {
    be.child.kill();
    wd.server.close();
    try { fs.rmSync(be.tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
