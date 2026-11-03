/**
 * N-1 regression: an `issueSession` whose submit came back UNKNOWN but which ACTUALLY LANDED must,
 * once reconciled, mark the API key's session as issued — otherwise, with REQUIRE_KEY_SESSIONS=true
 * (the default), that key is refused (403) forever even though its badge is on chain.
 *
 * Before the fix, `reconcileRecord` only settled the record `confirmed` and never rebuilt the issued-
 * session cache (`store.budget.sessions`), which `keySessionInfo` derives `issued` from — so the key
 * stayed `issued:false` after reconcile. We stand up a MOCK walletd that mounts a budget (tx1 accepted)
 * and then reports the issue-session tx (tx2) as pending → the op is journaled `unknown`; we assert the
 * key is NOT yet issued, flip tx2 to accepted, reconcile, and assert the key is now issued. Zero deps.
 * Run:  node server/session_reconcile.test.js
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
const ADMIN_SECRET = "A".repeat(40);
const AGENT_SECRET = "B".repeat(40);

function request(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data != null) {
      h["Content-Type"] = "application/json";
      h["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request({ host: HOST, port, method, path: pathname, headers: h }, (res) => {
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
 * Mock wallet daemon. Real submits get sequential tx ids (tx1, tx2, …); `get_result` reports a tx
 * ACCEPTED iff it is in `accepted`. tx1 (the budget open) is accepted from the start so the budget
 * mounts; the issue-session tx is left pending until the test flips it with `acceptNext()`.
 */
function startMockWalletd() {
  let realCount = 0;
  const accepted = new Set(); // nothing is finalized until the test flips it with acceptTx()
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
          return reply({
            Component: { body: { state: [
              { tag: 131, value: { hex: "b".repeat(64) } },
              { tag: 131, value: { hex: "c".repeat(64) } },
            ] } },
          });
        case "transactions.submit_manifest":
          if (rpc.params && rpc.params.dry_run) return reply({ result: { Accept: {} } });
          realCount += 1;
          return reply({ transaction_id: "tx" + realCount });
        case "transactions.get_result":
          return accepted.has(rpc.params && rpc.params.transaction_id)
            ? reply({ finalize: { result: { Accept: { up_substates: [NEW_COMPONENT] } } } })
            : reply({ status: "Pending" });
        default: return reply({});
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, HOST, () => resolve({
      server,
      port: server.address().port,
      acceptTx: (id) => accepted.add(id),
    })));
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
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    (async () => {
      while (Date.now() < deadline) {
        try { if ((await request(port, "GET", "/api/session")).status === 200) return resolve({ port, child, get log() { return log; } }); } catch { /* not up */ }
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

const adminHdr = { Authorization: "Bearer " + ADMIN_SECRET };

function keyInfo(listJson, id) {
  const k = (listJson && listJson.keys || []).find((x) => x.id === id);
  return k && k.session;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentpay-sess-"));
  console.log("\nIssue-session reconcile (N-1: unknown issueSession that landed must leave the key issued)\n");
  const mock = await startMockWalletd();
  const be = await boot(`http://${HOST}:${mock.port}/json_rpc`, {
    AGENTPAY_STATE_FILE: path.join(tmp, "s.json"),
    AGENTPAY_TXLOG_FILE: path.join(tmp, "t.json"),
    AGENTPAY_AUDIT_FILE: path.join(tmp, "a.log"),
    AGENTPAY_API_KEYS: `admin:adm:${ADMIN_SECRET},agent:bot1:${AGENT_SECRET}`,
    AGENTPAY_REQUIRE_KEY_SESSIONS: "true",
    AGENTPAY_FINALIZE_TRIES: "1",
    AGENTPAY_FINALIZE_DELAY_MS: "10",
  });
  try {
    // 1) Mount a budget the proven way: the open's tx (tx1) is reported pending → journaled unknown →
    //    mounts nothing; flip tx1 accepted and reconcile to recover and mount the component.
    const open = await request(be.port, "POST", "/api/budget", { fund: 1000, perTxCap: 100, dailyCap: 500, epochsPerWindow: 10, whitelist: [] });
    check("open is pending (unmounted) first", open.status === 200 && open.json && open.json.pending === true,
      `${open.status} ${JSON.stringify(open.json && open.json.pending)}`);
    mock.acceptTx("tx1");
    await request(be.port, "POST", "/api/reconcile", {});
    const st = await request(be.port, "GET", "/api/state");
    check("budget is mounted after reconcile", st.json && st.json.budget && st.json.budget.component === NEW_COMPONENT,
      `comp=${st.json && st.json.budget && st.json.budget.component}`);

    // 2) Issue bot1's session badge; the mock reports its tx (tx2) pending → the op is journaled unknown.
    const issue = await request(be.port, "POST", "/api/v1/keys/bot1/session", {}, adminHdr);
    check("issue-session returns pending (202), not issued yet", issue.status === 202 && issue.json && issue.json.pending === true,
      `${issue.status} ${JSON.stringify(issue.json)}`);

    // 3) Before reconcile the key is NOT issued.
    const l1 = await request(be.port, "GET", "/api/v1/keys", null, adminHdr);
    check("bot1 session.issued is false while the issue is unresolved", keyInfo(l1.json, "bot1") && keyInfo(l1.json, "bot1").issued === false,
      JSON.stringify(keyInfo(l1.json, "bot1")));

    // 4) The issue tx actually landed: flip tx2 to accepted and reconcile.
    mock.acceptTx("tx2");
    const rec = await request(be.port, "POST", "/api/reconcile", {});
    check("reconcile resolves the unknown issue-session", rec.status === 200 && rec.json && rec.json.resolved >= 1, JSON.stringify(rec.json));

    // 5) THE FIX: after reconcile the key is issued (before the fix it stayed false → permanent 403).
    const l2 = await request(be.port, "GET", "/api/v1/keys", null, adminHdr);
    check("bot1 session.issued is TRUE after reconcile (N-1 fixed)", keyInfo(l2.json, "bot1") && keyInfo(l2.json, "bot1").issued === true,
      JSON.stringify(keyInfo(l2.json, "bot1")));
  } finally {
    be.child.kill();
    mock.server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
