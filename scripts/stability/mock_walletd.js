#!/usr/bin/env node
/**
 * Controllable mock Tari Ootle wallet daemon — the SAFE, deterministic backbone of the AgentPay
 * stability harness (scripts/stability/*). It speaks exactly the JSON-RPC surface the real
 * `WalletdClient` (clients/ts) calls, so the UNMODIFIED dashboard backend (web/server/server.js) can
 * be pointed at it with `AGENTPAY_WALLETD_URL` and driven end to end — WITHOUT ever touching the
 * resident local swarm / real walletd on :12010.
 *
 * WHY A MOCK (and not the real swarm) for the fault/crash/concurrency tests:
 *   - We must be able to force "walletd unavailable", "network timeout" and "tx verdict unknown"
 *     on demand. Doing that to the real walletd would mean killing/stalling swarm processes, which
 *     has repeatedly crashed WSL (pkill -9 storms → E_UNEXPECTED). This mock gives the SAME backend
 *     code those conditions deterministically, with zero risk to the swarm.
 *   - It is chain-authoritative in the same shape the backend parses: the component substate is a
 *     positional state array and the vault is a child substate exposing `revealed_amount`. An
 *     accepted `pay` advances spent_in_window and drains the vault, so the backend's chain reads
 *     (readChainBudget) move in lockstep — letting the harness assert "backend == chain".
 *
 * Methods implemented (1:1 with clients/ts/src/walletd.ts): auth.request, accounts.list,
 * accounts.create, accounts.create_free_test_coins, accounts.get_balances, settings.get,
 * substates.get, transactions.submit_manifest (real + dry_run), transactions.get_result.
 *
 * CONTROL CHANNEL (so a test can inject faults mid-run):
 *   POST /__control  { down, delayMs, epoch, acceptAfterPolls, submitError, getResultMode,
 *                      failMethods:[...], rejectReason }
 *   GET  /__state     → { submits, getResults, component, spent, vault, flags }
 * Flags:
 *   down            : true → every RPC replies 503 (simulates walletd unreachable/returning errors)
 *   delayMs         : sleep this long before replying (simulates slow network / timeout)
 *   acceptAfterPolls: a submitted tx finalizes (accept/reject) only after this many get_result polls
 *                     (0 = immediately). Large/Infinity + low backend FINALIZE_TRIES → `unknown` path.
 *   getResultMode   : "auto" (default) | "pending" (never finalize) | "reject"
 *   submitError     : string → submit_manifest returns this as an RPC error
 *   failMethods     : methods to answer with an RPC error (e.g. ["substates.get"])
 *
 * Deliberately zero-dependency (node:http only); runs under the repo's WSL Node 18.
 *
 *   node scripts/stability/mock_walletd.js [PORT]        # default 13010
 */
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.argv[2] || process.env.MOCK_WALLETD_PORT || 13010);
const HOST = process.env.MOCK_WALLETD_HOST || "127.0.0.1";

function hex64() {
  return crypto.randomBytes(32).toString("hex");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- in-memory "chain" ------------------------------------------------------------------------
const OWNER_ADDR = "component_" + hex64();
const flags = {
  down: false,
  delayMs: 0,
  epoch: 1000,
  acceptAfterPolls: 0,
  getResultMode: "auto", // auto | pending | reject
  submitError: null,
  failMethods: [],
  rejectReason: "Dry-run transaction rejected: Execution failure (AssertionFailed): Panic! policy violation",
};
const accounts = new Map([["default", OWNER_ADDR]]);

// The one budget component this mock tracks (created by the backend's createBudget).
let budget = null; // { component, vaultHex, ownerBadge, agentBadge, perTxCap, dailyCap, spent, windowStart, epochsPerWindow, whitelist[], revoked, vault }
const txs = new Map(); // txId -> { kind, manifest, polls, verdict, result, decided, params }

const counters = { submits: 0, getResults: 0, substates: 0, rpc: 0, openSubmits: 0, paySubmits: 0, withdrawSubmits: 0, topUpSubmits: 0, revokeSubmits: 0, addMerchantSubmits: 0, otherSubmits: 0 };

// ---- manifest parsing (enough to model open / pay / owner calls) ------------------------------
function parseAmount(manifest, re) {
  const m = manifest.match(re);
  return m ? BigInt(m[1]) : null;
}
function addressesIn(manifest) {
  return [...new Set(manifest.match(/(component|resource)_[0-9a-f]{64}/g) || [])];
}
function classify(manifest) {
  if (/AgentBudget::new\(/.test(manifest)) return "open";
  if (/budget\.pay\(/.test(manifest)) return "pay";
  if (/budget\.withdraw\(/.test(manifest)) return "withdraw";
  if (/budget\.top_up\(/.test(manifest)) return "topUp";
  if (/budget\.revoke\(\)/.test(manifest)) return "revoke";
  if (/budget\.add_merchant\(/.test(manifest)) return "addMerchant";
  return "other";
}

// Build the Accept diff blob the backend scrapes addresses/events out of.
function openAcceptDiff() {
  // new component + two badge resources (not resource_0101.. / resource_0000..)
  return {
    up_substates: [
      { Component: { address: budget.component } },
      { Resource: { address: budget.ownerBadge } },
      { Resource: { address: budget.agentBadge } },
    ],
    events: [],
  };
}
function payAcceptDiff(merchant, amount, memo, spentAfter) {
  // event objects must carry a `payload` with merchant/amount/memo and a `topic` (iterEvents gate)
  const ev = {
    topic: "pay",
    substate_id: budget.component,
    payload: { merchant, amount: String(amount), memo, spent_in_window: String(spentAfter) },
  };
  return { up_substates: [{ Component: { address: budget.component } }], events: [ev, ev] };
}

// Apply an accepted op's effect to the mock chain state (so reads reflect it).
function applyEffect(tx) {
  if (tx.kind === "pay") {
    budget.spent += tx.params.amount;
    budget.vault -= tx.params.amount;
  } else if (tx.kind === "withdraw") {
    budget.vault -= tx.params.amount;
  } else if (tx.kind === "topUp") {
    budget.vault += tx.params.amount;
  } else if (tx.kind === "revoke") {
    budget.revoked = true;
  } else if (tx.kind === "addMerchant") {
    if (tx.params.merchant) budget.whitelist.push(tx.params.merchant);
  }
}

// Decide a tx's verdict once its poll budget is reached.
function decide(tx) {
  if (tx.decided) return;
  const forceReject = flags.getResultMode === "reject";
  // Model the on-chain rules for a pay so the harness's reference model can agree with the mock.
  let reject = forceReject;
  let reason = flags.rejectReason;
  if (tx.kind === "pay" && !forceReject) {
    const { merchant, amount } = tx.params;
    if (budget.revoked) { reject = true; reason = "Agent has been revoked"; }
    else if (amount <= 0n || amount > budget.perTxCap) { reject = true; reason = "over per-tx cap"; }
    else if (!budget.whitelist.includes(merchant)) { reject = true; reason = "merchant not whitelisted"; }
    else if (budget.spent + amount > budget.dailyCap) { reject = true; reason = "would exceed daily cap"; }
  }
  tx.decided = true;
  if (reject) {
    tx.verdict = "reject";
    tx.result = { result: { result: { Reject: { ExecutionFailure: { code: 1, message: reason } } } } };
  } else {
    tx.verdict = "accept";
    applyEffect(tx);
    let diff;
    if (tx.kind === "open") diff = openAcceptDiff();
    else if (tx.kind === "pay") diff = payAcceptDiff(tx.params.merchant, tx.params.amount, tx.params.memo, budget.spent);
    else diff = { up_substates: [], events: [] };
    tx.result = { result: { result: { Accept: diff } } };
  }
}

// ---- substate shapes --------------------------------------------------------------------------
function componentSubstate() {
  const tag = (hex) => ({ "@@TAGGED@@": 128, value: { hex } });
  const state = [
    tag(budget.vaultHex), // vault (child substate)
    tag(budget.agentBadge.slice("resource_".length)),
    tag(budget.ownerBadge.slice("resource_".length)),
    Number(budget.perTxCap),
    Number(budget.dailyCap),
    Number(budget.spent),
    budget.windowStart,
    budget.epochsPerWindow,
    budget.whitelist.map((c) => tag(c.slice("component_".length))),
    budget.revoked,
  ];
  return { substate: { substate: { Component: { body: { state } } } } };
}
function vaultSubstate() {
  return { substate: { substate: { Vault: { resource_container: { Confidential: { revealed_amount: String(budget.vault) } } } } } };
}

// ---- JSON-RPC dispatch ------------------------------------------------------------------------
function dryRunResult(manifest) {
  const kind = classify(manifest);
  if (kind !== "pay") return { result: { result: { finalize: { result: { Accept: {} } } } } };
  // model the pay rules for a dry run (would_reject)
  const amount = parseAmount(manifest, /amount!\((\d+)\)/);
  const addrs = addressesIn(manifest);
  const merchant = addrs.find((a) => a.startsWith("component_") && a !== budget.component) || null;
  let reject = false, reason = flags.rejectReason;
  if (budget.revoked) { reject = true; reason = "Agent has been revoked"; }
  else if (amount == null || amount <= 0n || amount > budget.perTxCap) { reject = true; reason = "over per-tx cap"; }
  else if (!budget.whitelist.includes(merchant)) { reject = true; reason = "merchant not whitelisted"; }
  else if (budget.spent + amount > budget.dailyCap) { reject = true; reason = "would exceed daily cap"; }
  if (reject) return { error: { code: 5, message: "Dry-run transaction rejected: " + reason } };
  return { result: { result: { finalize: { result: { Accept: {} } } } } };
}

async function handleRpc(method, params) {
  counters.rpc++;
  if (flags.failMethods.includes(method)) return { error: { code: -1, message: `injected failure on ${method}` } };
  switch (method) {
    case "auth.request":
      return { result: { token: "mock-token-" + Date.now() } };
    case "accounts.list":
      return { result: { accounts: [...accounts].map(([name, component_address]) => ({ account: { name, component_address } })) } };
    case "accounts.create": {
      const name = params.account_name;
      const addr = "component_" + hex64();
      accounts.set(name, addr);
      return { result: { account: { component_address: addr } } };
    }
    case "accounts.create_free_test_coins":
      return { result: { amount: params.amount } };
    case "accounts.get_balances":
      return { result: { balances: [{ token_symbol: "tTARI", balance: 1_000_000 }] } };
    case "settings.get":
      return { result: { current_epoch: flags.epoch } };
    case "substates.get": {
      counters.substates++;
      const id = params.substate_id || "";
      if (!budget) return { error: { code: -1, message: "no component yet" } };
      if (id.startsWith("vault_")) return { result: vaultSubstate() };
      if (id === budget.component) return { result: componentSubstate() };
      return { error: { code: -1, message: "substate not found: " + id } };
    }
    case "transactions.submit_manifest": {
      const { manifest, dry_run } = params;
      if (dry_run) return dryRunResult(manifest);
      counters.submits++;
      if (flags.submitError) return { error: { code: 5, message: flags.submitError } };
      const kind = classify(manifest);
      counters[kind + "Submits"] = (counters[kind + "Submits"] || 0) + 1;
      const txId = "tx_" + hex64();
      const addrs = addressesIn(manifest);
      let txParams = {};
      if (kind === "open") {
        // materialise the new budget component (first real open wins; backend guards re-open anyway)
        if (!budget) {
          budget = {
            component: "component_" + hex64(),
            vaultHex: hex64(),
            ownerBadge: "resource_" + hex64(),
            agentBadge: "resource_" + hex64(),
            perTxCap: parseAmount(manifest, /amount!\((\d+)\)[^)]*amount!\((\d+)\)/) || 0n,
            dailyCap: 0n,
            spent: 0n,
            windowStart: flags.epoch,
            epochsPerWindow: Number((manifest.match(/(\d+)u64/) || [])[1] || 10),
            whitelist: addrs.filter((a) => a.startsWith("component_") && a !== OWNER_ADDR),
            revoked: false,
            vault: parseAmount(manifest, /amount!\((\d+)\)/) || 0n,
          };
          // caps: the manifest has new(funds, amount!(perTx), amount!(daily), ...) → first three amounts
          const amts = [...manifest.matchAll(/amount!\((\d+)\)/g)].map((m) => BigInt(m[1]));
          if (amts.length >= 3) { budget.vault = amts[0]; budget.perTxCap = amts[1]; budget.dailyCap = amts[2]; }
        }
      } else if (kind === "pay") {
        const amount = parseAmount(manifest, /amount!\((\d+)\)/) || 0n;
        const memo = (manifest.match(/,\s*"([^"]*)"\)/) || [])[1] || "";
        const merchant = addrs.find((a) => a.startsWith("component_") && a !== budget.component && a !== OWNER_ADDR) || null;
        txParams = { amount, memo, merchant };
      } else if (kind === "withdraw" || kind === "topUp") {
        txParams = { amount: parseAmount(manifest, /amount!\((\d+)\)/) || 0n };
      } else if (kind === "addMerchant") {
        txParams = { merchant: addrs.find((a) => a.startsWith("component_") && a !== budget.component) || null };
      }
      txs.set(txId, { kind, polls: 0, decided: false, verdict: null, result: null, params: txParams });
      return { result: { transaction_id: txId } };
    }
    case "transactions.get_result": {
      counters.getResults++;
      const tx = txs.get(params.transaction_id);
      if (!tx) return { result: {} }; // unknown tx id → pending shape
      if (flags.getResultMode === "pending") return { result: { result: {} } };
      tx.polls++;
      if (tx.polls > flags.acceptAfterPolls) decide(tx);
      if (!tx.decided) return { result: { result: {} } }; // still pending
      return tx.result;
    }
    default:
      return { error: { code: -32601, message: "method not found: " + method } };
  }
}

const server = http.createServer(async (req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    // control / introspection
    if (req.url === "/__control" && req.method === "POST") {
      try {
        const patch = JSON.parse(body || "{}");
        Object.assign(flags, patch);
        return send(200, { ok: true, flags });
      } catch (e) { return send(400, { error: String(e) }); }
    }
    if (req.url === "/__state") {
      return send(200, {
        counters,
        flags,
        owner: OWNER_ADDR,
        budget: budget && {
          component: budget.component, perTxCap: String(budget.perTxCap), dailyCap: String(budget.dailyCap),
          spent: String(budget.spent), vault: String(budget.vault), whitelist: budget.whitelist,
          revoked: budget.revoked,
        },
        txCount: txs.size,
      });
    }
    if (req.url === "/__reset" && req.method === "POST") { budget = null; txs.clear(); return send(200, { ok: true }); }

    // JSON-RPC
    if (flags.down) return send(503, { error: { code: -1, message: "walletd unavailable (injected)" } });
    if (flags.delayMs) await sleep(flags.delayMs);
    let payload;
    try { payload = JSON.parse(body); } catch { return send(400, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }); }
    const out = await handleRpc(payload.method, payload.params || {});
    send(200, { jsonrpc: "2.0", id: payload.id, ...out });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-walletd] listening http://${HOST}:${PORT}/json_rpc  owner=${OWNER_ADDR}`);
});

// expose owner address for harness scripts that spawn this inline
module.exports = { OWNER_ADDR };
