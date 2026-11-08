// Live wallet backend: wraps the self-built non-custodial engine (src/l2-wallet.mjs) behind a tiny
// HTTP/JSON API and serves the wallet UI (wallet-live.html). The engine runs HERE in Node — where the
// whole resolve→sign→seal→submit lifecycle is already proven on the live 0.50.1 swarm — so the browser
// never touches wasm, keys or CORS; the page just fetches these endpoints (same origin).
//
//   GET  /                 -> wallet.html (full MetaMask-style wallet)
//   GET  /api/status       -> { connected, account, network, budget? , caps, spent, vault }
//   GET  /api/account      -> { account, resource, balance }  (the OWNER account's real XTR balance)
//   POST /api/open  {fund, perTx, daily, epochsPerWindow}  -> opens a fresh budget, returns its state
//   POST /api/send  {amount, memo}  -> owner->merchant transfer FROM THE OWNER'S OWN FUNDS (not the budget)
//   POST /api/pay   {amount, memo}  -> { committed, amount, prevSpent, spent, txid?, events?, reason? }
//
// Two independent pools: the owner's Send (/api/send) spends the account's real XTR balance; the
// AgentBudget's pay (/api/pay) spends the budget vault. They never move together — that is the model.
//
// Run in WSL ext4 against the local swarm:
//   node --experimental-wasm-modules --experimental-global-webcrypto node/wallet-server.mjs
// Env: PORT (default 7777), INDEXER_URL, AGENT_TEMPLATE, MERCHANT, BUDGET (reuse instead of opening).
import http from "node:http";
import fs from "node:fs";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { Network } from "@tari-project/ootle";
import { decodeExecuteResult, decodeSubstateValue } from "@tari-project/ootle-wasm-bor";
import { L2Wallet } from "../src/l2-wallet.mjs";
import { openBudgetTx, payTx, transferTx, templateEvents, parseBudgetSubstate, XTR } from "../src/agentpay-tx.js";
import { connectIndexer, accountVaults } from "../src/chain.js";

const PORT = parseInt(process.env.PORT) || 7777;
const INDEXER_URL = process.env.INDEXER_URL || "http://127.0.0.1:12008";
const TEMPLATE = process.env.AGENT_TEMPLATE || "template_c4b58558181f19c17d6ccc75c93e0707e2c5b75d1ef4de96a70acd0fd2d40e47";
const MERCHANT = process.env.MERCHANT || "component_c5c2db90a8f9f02981617244b835fd36d4830bdcb80eb7f5cb092932896924e3";
// Agent session badge label proven on pay. "default" is the badge this wallet's own open() minted;
// set SESSION to a label the owner issued into this account (issueAgentBadge) to pay a budget this
// wallet did not open — e.g. a budget opened by the dashboard and shared with this agent.
const SESSION = process.env.SESSION || "default";

const KEY_FILE = new URL("../.spike-key.json", import.meta.url);
if (!fs.existsSync(KEY_FILE)) throw new Error(`need a funded dev key at ${KEY_FILE.pathname}`);
const key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
if (!key.account) throw new Error(".spike-key.json has no account — fund one first");
const ACCOUNT = key.account;
const UI = new URL("../wallet-live.html", import.meta.url);

const w = new L2Wallet({ ownerSecretHex: key.owner, viewSecretHex: key.view, network: Network.LocalNet, indexerUrl: INDEXER_URL, account: ACCOUNT });
const provider = await connectIndexer(INDEXER_URL, Network.LocalNet);

const state = { budget: process.env.BUDGET || null, initialFund: null, template: TEMPLATE, merchant: MERCHANT };

// --- two-account decoupling --------------------------------------------------------------------
// A SEPARATE agent account (its own key) holds the budget's agent badge and pays its OWN gas, so the
// owner wallet (ACCOUNT) is untouched by the dApp's payments. `.spike-two-account.json` is written by
// setup-agent.mjs (faucet-funded agent account + a budget opened with the agent badge routed to it).
// If the file is absent, pay falls back to the single-account model (agent == owner).
const TWO_FILE = new URL("../.spike-two-account.json", import.meta.url);
const AGENT_KEY_FILE = new URL("../.spike-agent-key.json", import.meta.url);
let two = null, agentW = null;
if (fs.existsSync(TWO_FILE) && fs.existsSync(AGENT_KEY_FILE)) {
  two = JSON.parse(fs.readFileSync(TWO_FILE, "utf8"));
  const ak = JSON.parse(fs.readFileSync(AGENT_KEY_FILE, "utf8"));
  agentW = new L2Wallet({ ownerSecretHex: ak.owner, viewSecretHex: ak.view, network: Network.LocalNet, indexerUrl: INDEXER_URL, account: ak.account });
  state.budget = two.budget; // the two-account budget (agent badge lives in the agent account)
  console.log(`two-account mode: agent=${two.agent} budget=${two.budget}`);
}
const PAY_AGENT = two ? two.agent : ACCOUNT;      // who proves the badge + pays the pay-tx gas
// The agent-badge NFT id to prove. In two-account mode the badge was minted by AgentBudget::new (id
// "default"); the single-account dashboard budget used an owner-issued id (env SESSION, e.g. "agent1").
const PAY_SESSION = two ? (two.session || "default") : SESSION;
const paySign = (unsignedTransaction) => (agentW || w).request("tari_signAndSubmitTransaction", { unsignedTransaction });

// --- dApp <-> wallet relay (WalletConnect-style) ---------------------------------------------------
// The dApp lives on ANOTHER origin and holds no key. It can only ENQUEUE a request here; it can never
// sign. The wallet UI (same origin, holds the key) polls /bridge/poll, shows its own approval, signs
// via /api/pay, and posts the answer to /bridge/resolve. CORS is granted to the dApp origin for the
// /bridge/* queue ONLY — /api/pay gets NO CORS, so a cross-origin dApp physically cannot call it.
const DAPP_ORIGINS = (process.env.DAPP_ORIGINS || "http://127.0.0.1:7788,http://localhost:7788").split(",");
const bridge = { q: [], res: {}, seq: 0 };
function corsFor(req, res) {
  const o = req.headers.origin;
  if (o && DAPP_ORIGINS.includes(o)) {
    res.setHeader("access-control-allow-origin", o);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
  }
}
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

// --- owner account balance (the wallet's OWN funds, independent of any budget) ---------------------
const XTR_HEX = XTR.replace(/^resource_/, "");
let xtrVaultIds = null; // cache: just the account's XTR-bearing vault ids (re-scanned if a read misses)
async function vaultXtr(vaultId) {
  let c = (await w.request("tari_getSubstate", { substate_id: vaultId }))?.state?.up?.substate;
  if (typeof c === "string") c = JSON.parse(decodeSubstateValue(c));
  const s = JSON.stringify(c);
  if (!s.includes(XTR_HEX)) return null; // a badge/NFT vault, or some other resource
  const m = s.match(/"revealed_amount":"?(\d+)"?/) || s.match(/"amount":"?(\d+)"?/);
  return m ? BigInt(m[1]) : null;
}
async function ownerBalance() {
  const ids = xtrVaultIds || (await accountVaults(provider, ACCOUNT));
  let total = 0n; const hits = [];
  for (const v of ids) { const a = await vaultXtr(v); if (a != null) { total += a; hits.push(v); } }
  xtrVaultIds = hits.length ? hits : null; // keep the XTR vaults hot; re-scan next time if none matched
  return total;
}

// Owner Send: a plain transfer straight from the owner account's real funds to the merchant. This is
// the wallet owner spending their OWN balance — it does NOT touch the AgentBudget (that is /api/pay).
async function doSend({ amount, memo = "Wallet transfer" }) {
  const b0 = await ownerBalance();
  const unsigned = transferTx({
    network: Network.LocalNet, maxEpoch: await w.maxEpoch(), owner: ACCOUNT,
    ownerVaults: await accountVaults(provider, ACCOUNT), recipient: MERCHANT,
    recipientVaults: await accountVaults(provider, MERCHANT), amount, memo, maxFee: 200_000,
  });
  let txid = null, reason = null;
  try {
    const r = await sign(unsigned);
    txid = r?.result?.Finalized?.transaction_id || null;
    const d = r?.result?.Finalized?.final_decision;
    if (d !== "Commit") reason = "final_decision=" + d;
    const ad = r?.result?.Finalized?.abort_details;
    if (ad) reason = typeof ad === "string" ? ad : JSON.stringify(ad);
  } catch (e) { reason = (e.outcome ? e.outcome + ": " : "") + (e.reason ?? e.message); }
  const balance = await ownerBalance();
  const committed = balance < b0; // the owner's own funds actually left the account
  return { committed, amount, prevBalance: b0.toString(), balance: balance.toString(), merchant: MERCHANT, txid, reason };
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
  // The AGENT proves the badge and pays the pay-tx gas. In two-account mode that is a separate account
  // (PAY_AGENT), so the owner wallet never moves on a dApp pay — not even the fee. Re-fetch the agent's
  // CURRENT vaults (the open minted the agent-badge vault the proof needs, in the agent account).
  const full = {
    network: Network.LocalNet, maxEpoch: await (agentW || w).maxEpoch(), agent: PAY_AGENT,
    agentVaults: await accountVaults(provider, PAY_AGENT), budget: state.budget, budgetVault: parsed.vault,
    agentBadge: parsed.agentBadge, session: PAY_SESSION, merchant: MERCHANT,
    merchantVaults: await accountVaults(provider, MERCHANT), amount, memo, maxFee: 200_000,
  };
  let txid = null, events = [], reason = null;
  try {
    const r = await paySign(payTx(full));
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
    // Root now serves the full MetaMask-style wallet; the old single-page demo stays at /live.
    const STATIC = { "/": "wallet.html", "/index.html": "wallet.html", "/wallet.html": "wallet.html", "/wallet": "wallet.html",
      "/live": "wallet-live.html", "/wallet-live.html": "wallet-live.html",
      "/linked": "linked.html", "/linked.html": "linked.html", "/dapp.html": "dapp.html" };
    if (req.method === "GET" && STATIC[url.pathname]) {
      const f = new URL("../" + STATIC[url.pathname], import.meta.url);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(fs.readFileSync(f));
    }
    if (url.pathname === "/api/status") {
      return send(res, 200, { connected: true, account: ACCOUNT, network: "localnet", indexer: INDEXER_URL,
        template: TEMPLATE, merchant: MERCHANT, agentAccount: PAY_AGENT, twoAccount: !!two, budget: await budgetState() });
    }
    if (url.pathname === "/api/account") {
      return send(res, 200, { account: ACCOUNT, resource: "XTR", balance: (await ownerBalance()).toString() });
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      const p = await body(req); const amt = parseInt(p.amount);
      if (!(amt > 0)) return send(res, 400, { error: "amount must be a positive integer" });
      return send(res, 200, await doSend({ amount: amt, memo: p.memo }));
    }
    if (req.method === "POST" && url.pathname === "/api/open") return send(res, 200, await doOpen(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/pay") {
      const p = await body(req); const amt = parseInt(p.amount);
      if (!(amt > 0)) return send(res, 400, { error: "amount must be a positive integer" });
      return send(res, 200, await doPay({ amount: amt, memo: p.memo }));
    }

    // --- relay: the dApp enqueues (CORS-allowed), the wallet drains + answers (same origin) ---
    if (url.pathname.startsWith("/bridge/")) {
      corsFor(req, res);
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      if (req.method === "POST" && url.pathname === "/bridge/req") {        // dApp -> enqueue
        const p = await body(req);
        if (!p.method) return send(res, 400, { error: "method required" });
        const id = ++bridge.seq;
        bridge.q.push({ id, method: p.method, params: p.params, origin: req.headers.origin || "(unknown)", claimed: false });
        return send(res, 200, { id });
      }
      if (req.method === "GET" && url.pathname === "/bridge/res") {         // dApp -> poll for answer
        const id = Number(url.searchParams.get("id"));
        const r = bridge.res[id];
        return send(res, 200, r ? { done: true, result: r.result, error: r.error } : { done: false });
      }
      if (req.method === "GET" && url.pathname === "/bridge/poll") {        // wallet -> drain new requests
        const out = bridge.q.filter((e) => !e.claimed);
        out.forEach((e) => { e.claimed = true; });
        return send(res, 200, { reqs: out.map((e) => ({ id: e.id, method: e.method, params: e.params, origin: e.origin })) });
      }
      if (req.method === "POST" && url.pathname === "/bridge/resolve") {    // wallet -> post the answer
        const p = await body(req);
        bridge.res[p.id] = { result: p.result, error: p.error };
        bridge.q = bridge.q.filter((e) => e.id !== p.id);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "unknown bridge route" });
    }

    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
});
server.listen(PORT, "0.0.0.0", () => console.log(`wallet-server on http://127.0.0.1:${PORT}  account=${ACCOUNT}  budget=${state.budget || "(open one)"}`));
