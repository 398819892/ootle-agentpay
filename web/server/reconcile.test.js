/**
 * Reconcile-after-ambiguous-open test (#3): an "open budget" whose submit came back UNKNOWN (the
 * tx may or may not have landed) must NOT silently leave the dashboard budget-less. We stand up a
 * MOCK walletd that (phase A) accepts the submit but reports the tx as still pending, so the server
 * records the open as `unknown` and mounts nothing; then (phase B) reports the SAME tx as accepted
 * with a result that created a new component. A POST /api/reconcile must then recover that component
 * and mount it. We also assert the in-flight GUARD: while the open is unresolved, a second
 * POST /api/budget is refused (409), so a retry can never fund a second budget. Zero dependencies.
 * Run:  node server/reconcile.test.js
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
const OWNER_BADGE = "resource_" + "b".repeat(64);
const AGENT_BADGE = "resource_" + "c".repeat(64);
const TXID = "mocktx-open-1";

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
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}

/**
 * A mock wallet daemon. `phase` is flipped by the test: "pending" → the open's tx never finalizes
 * (server records `unknown`); "accept" → the SAME tx is reported accepted with a result that
 * created NEW_COMPONENT, and that component's state exposes the owner + agent badges.
 */
function startMockWalletd() {
  let phase = "pending";
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let rpc = {};
      try { rpc = JSON.parse(raw); } catch { /* ignore */ }
      const reply = (result) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })); };
      switch (rpc.method) {
        case "auth.request": return reply({ token: "mock-token" });
        case "accounts.list":
          return reply({ accounts: [{ account: { name: "default", component_address: OWNER_COMPONENT } }] });
        case "accounts.get_balances": return reply({ balances: [{ token_symbol: "tTARI", balance: 1_000_000 }] });
        case "accounts.create_free_test_coins": return reply({});
        case "settings.get": return reply({ current_epoch: 1 });
        case "substates.get":
          // The recovered component's on-chain state: positional struct, two CBOR-tagged (131)
          // ResourceAddresses in order [owner_badge, agent_badge] — what readBadges() reads.
          return reply({
            Component: { body: { state: [
              { tag: 131, value: { hex: "b".repeat(64) } },
              { tag: 131, value: { hex: "c".repeat(64) } },
            ] } },
          });
        case "transactions.submit_manifest":
          // Dry runs (if any) just pass; a REAL submit returns a tx id with no verdict yet.
          return reply(rpc.params && rpc.params.dry_run
            ? { result: { Accept: {} } }
            : { transaction_id: TXID });
        case "transactions.get_result":
          return phase === "accept"
            // Accepted: a finalized result that created NEW_COMPONENT (the budget `open` minted).
            ? reply({ finalize: { result: { Accept: { up_substates: [NEW_COMPONENT] } } } })
            // Pending: not finalized → the open times out and is journaled `unknown`.
            : reply({ status: "Pending" });
        default: return reply({});
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, HOST, () => resolve({ server, port: server.address().port, accept: () => { phase = "accept"; } })));
}

function boot(walletdUrl, env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn("node", [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), HOST, AGENTPAY_WALLETD_URL: walletdUrl, SESSION_SECRET: "0".repeat(64), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return new Promise(async (resolve, reject) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { if ((await request(port, "GET", "/api/session")).status === 200) return resolve({ port, child, get log() { return log; } }); } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 150));
      if (child.exitCode != null) return reject(new Error("server exited early: " + log));
    }
    reject(new Error("server not ready: " + log));
  });
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-recon-"));
  console.log("\nReconcile after ambiguous open (#3: unknown open → recover + mount, and refuse a second open)\n");
  const mock = await startMockWalletd();
  const be = await boot(`http://${HOST}:${mock.port}/json_rpc`, {
    AGENTPAY_STATE_FILE: path.join(tmp, "s.json"),
    AGENTPAY_TXLOG_FILE: path.join(tmp, "t.json"),
    AGENTPAY_AUDIT_FILE: path.join(tmp, "a.log"),
    // Make the open go `unknown` fast: poll the (pending) result just once.
    AGENTPAY_FINALIZE_TRIES: "1",
    AGENTPAY_FINALIZE_DELAY_MS: "10",
  });
  try {
    const before = await request(be.port, "GET", "/api/state");
    check("baseline: no budget mounted", before.status === 200 && before.json.budget === null, `${before.status}`);

    // Open a budget; the mock reports the tx pending, so the server records it UNKNOWN and mounts nothing.
    const open1 = await request(be.port, "POST", "/api/budget", { fund: 1000, perTxCap: 100, dailyCap: 500, epochsPerWindow: 10, whitelist: [] });
    check("open returns pending (not a success), budget still unmounted",
      open1.status === 200 && open1.json && open1.json.pending === true && open1.json.budget === null,
      `${open1.status} pending=${open1.json && open1.json.pending} budget=${open1.json && open1.json.budget}`);

    const mid = await request(be.port, "GET", "/api/state");
    check("state still shows no budget while the open is unresolved", mid.json.budget === null, JSON.stringify(mid.json.budget));

    // The in-flight guard: a second open must be refused, or a retry would fund a SECOND budget.
    const open2 = await request(be.port, "POST", "/api/budget", { fund: 1000, perTxCap: 100, dailyCap: 500, epochsPerWindow: 10, whitelist: [] });
    check("a second open is refused (409) while the first is unresolved", open2.status === 409, `${open2.status}`);

    // The tx actually landed: flip the mock to report it accepted, then reconcile.
    mock.accept();
    const rec = await request(be.port, "POST", "/api/reconcile", {});
    check("reconcile resolves the unknown open", rec.status === 200 && rec.json && rec.json.resolved >= 1, JSON.stringify(rec.json));

    const after = await request(be.port, "GET", "/api/state");
    check("the recovered budget is now mounted at the on-chain component",
      after.json.budget && after.json.budget.component === NEW_COMPONENT,
      JSON.stringify(after.json.budget && after.json.budget.component));

    // Once mounted, a further open is refused for the usual reason (one budget at a time).
    const open3 = await request(be.port, "POST", "/api/budget", { fund: 1000, perTxCap: 100, dailyCap: 500, epochsPerWindow: 10, whitelist: [] });
    check("with a budget mounted, a further open is refused (409)", open3.status === 409, `${open3.status}`);
  } finally {
    be.child.kill();
    mock.server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
