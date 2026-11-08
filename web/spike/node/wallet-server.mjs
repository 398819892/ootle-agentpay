// Live wallet backend: wraps the self-built non-custodial engine (src/l2-wallet.mjs) behind a tiny
// HTTP/JSON API and serves the wallet UI (wallet-live.html). The engine runs HERE in Node — where the
// whole resolve→sign→seal→submit lifecycle is already proven on the live 0.50.1 swarm — so the browser
// never touches wasm, keys or CORS; the page just fetches these endpoints (same origin).
//
//   GET  /                 -> wallet-live.html
//   GET  /api/status       -> { connected, account, network, budget? , caps, spent, vault }
//   POST /api/open  {fund, perTx, daily, epochsPerWindow}  -> opens a fresh budget, returns its state
//   POST /api/pay   {amount, memo}  -> { committed, amount, prevSpent, spent, txid?, events?, reason? }
//
// Run in WSL ext4 against the local swarm:
//   node --experimental-wasm-modules --experimental-global-webcrypto node/wallet-server.mjs
// Env: PORT (default 7777), INDEXER_URL, AGENT_TEMPLATE, MERCHANT, BUDGET (reuse instead of opening).
import http from "node:http";
import fs from "node:fs";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { Network } from "@tari-project/ootle";
import { decodeExecuteResult } from "@tari-project/ootle-wasm-bor";
import { L2Wallet } from "../src/l2-wallet.mjs";
import { openBudgetTx, payTx, templateEvents, parseBudgetSubstate } from "../src/agentpay-tx.js";
import { connectIndexer, accountVaults } from "../src/chain.js";

const PORT = parseInt(process.env.PORT) || 7777;
const INDEXER_URL = process.env.INDEXER_URL || "http://127.0.0.1:12008";
const TEMPLATE = process.env.AGENT_TEMPLATE || "template_c4b58558181f19c17d6ccc75c93e0707e2c5b75d1ef4de96a70acd0fd2d40e47";
const MERCHANT = process.env.MERCHANT || "component_c5c2db90a8f9f02981617244b835fd36d4830bdcb80eb7f5cb092932896924e3";

const KEY_FILE = new URL("../.spike-key.json", import.meta.url);
if (!fs.existsSync(KEY_FILE)) throw new Error(`need a funded dev key at ${KEY_FILE.pathname}`);
const key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
if (!key.account) throw new Error(".spike-key.json has no account — fund one first");
const ACCOUNT = key.account;
const UI = new URL("../wallet-live.html", import.meta.url);

const w = new L2Wallet({ ownerSecretHex: key.owner, viewSecretHex: key.view, network: Network.LocalNet, indexerUrl: INDEXER_URL, account: ACCOUNT });
const provider = await connectIndexer(INDEXER_URL, Network.LocalNet);

const state = { budget: process.env.BUDGET || null, initialFund: null, template: TEMPLATE, merchant: MERCHANT };
const collect = (x, pfx, out = new Set()) => {
  if (!x) return out;
  if (typeof x === "string") { if (x.startsWith(pfx)) out.add(x); return out; }
  if (Array.isArray(x)) { x.forEach((v) => collect(v, pfx, out)); return out; }
  if (typeof x === "object") Object.values(x).forEach((v) => collect(v, pfx, out));
  return out;
};
const commit = (r, label) => {
  const d = r?.result?.Finalized?.final_decision;
  if (d !== "Commit") throw new Error(`${label} not committed (final_decision=${d})`);
  return r;
};
const sign = (unsignedTransaction) => w.request("tari_signAndSubmitTransaction", { unsignedTransaction });
async function budgetState() {
  if (!state.budget) return null;
  const b = await parseBudgetSubstate(await w.request("tari_getSubstate", { substate_id: state.budget }));
  const vault = state.initialFund != null ? Math.max(0, state.initialFund - b.spentInWindow) : null;
  return {
    address: state.budget, perTx: b.perTxCap, daily: b.dailyCap, spent: b.spentInWindow,
    vault, whitelist: b.whitelist, agentBadge: b.agentBadge, epochsPerWindow: b.epochsPerWindow,
  };
}

async function doOpen({ fund = 5000, perTx = 1000, daily = 1500, epochsPerWindow = 10 }) {
  const open = commit(await sign(openBudgetTx({
    network: Network.LocalNet, maxEpoch: await w.maxEpoch(), template: TEMPLATE, owner: ACCOUNT,
    ownerVaults: await accountVaults(provider, ACCOUNT), fund, perTxCap: perTx, dailyCap: daily, epochsPerWindow,
    whitelist: [MERCHANT], maxFee: 200_000,
  })), "open");
  let exec = open.result.Finalized.execution_result;
  if (typeof exec === "string") exec = JSON.parse(decodeExecuteResult(exec));
  const budget = [...collect(exec, "component_")].find((c) => c !== ACCOUNT && c !== MERCHANT);
  if (!budget) throw new Error("open committed but no new budget component found");
  state.budget = budget; state.initialFund = fund;
  const txid = open.result.Finalized?.transaction_id || null;
  return { ...(await budgetState()), txid };
}

async function doPay({ amount, memo = "Caravel order" }) {
  if (!state.budget) throw new Error("no budget open yet");
  // read the budget: its spent-before and the vault/badge addresses the pay needs to declare
  const parsed = await parseBudgetSubstate(await w.request("tari_getSubstate", { substate_id: state.budget }));
  const b0 = parsed.spentInWindow;
  // CONTRACT: re-fetch the agent's CURRENT vaults (open minted the agent-badge vault the proof needs).
  const full = {
    network: Network.LocalNet, maxEpoch: await w.maxEpoch(), agent: ACCOUNT,
    agentVaults: await accountVaults(provider, ACCOUNT), budget: state.budget, budgetVault: parsed.vault,
    agentBadge: parsed.agentBadge, session: "default", merchant: MERCHANT,
    merchantVaults: await accountVaults(provider, MERCHANT), amount, memo, maxFee: 200_000,
  };
  let txid = null, events = [], reason = null;
  try {
    const r = await sign(payTx(full));
    txid = r?.result?.Finalized?.transaction_id || null;
    events = templateEvents(r, TEMPLATE).map((e) => e.topic);
    const ad = r?.result?.Finalized?.abort_details;
    if (ad) reason = typeof ad === "string" ? ad : JSON.stringify(ad);
  } catch (e) {
    reason = (e.outcome ? e.outcome + ": " : "") + (e.reason ?? e.message);
  }
  const after = await budgetState();
  const committed = after.spent > b0;
  return { committed, amount, prevSpent: b0, spent: after.spent, vault: after.vault, txid, events, reason };
}

const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => d += c); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(UI));
    }
    if (url.pathname === "/api/status") {
      return send(res, 200, { connected: true, account: ACCOUNT, network: "localnet", indexer: INDEXER_URL,
        template: TEMPLATE, merchant: MERCHANT, budget: await budgetState() });
    }
    if (req.method === "POST" && url.pathname === "/api/open") return send(res, 200, await doOpen(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/pay") {
      const p = await body(req); const amt = parseInt(p.amount);
      if (!(amt > 0)) return send(res, 400, { error: "amount must be a positive integer" });
      return send(res, 200, await doPay({ amount: amt, memo: p.memo }));
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
});
server.listen(PORT, "0.0.0.0", () => console.log(`wallet-server on http://127.0.0.1:${PORT}  account=${ACCOUNT}  budget=${state.budget || "(open one)"}`));
