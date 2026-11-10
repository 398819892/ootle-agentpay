// Live wallet backend: wraps the self-built non-custodial engine (src/l2-wallet.mjs) behind a tiny
// HTTP/JSON API and serves the wallet UI (wallet-live.html). The engine runs HERE in Node — where the
// whole resolve→sign→seal→submit lifecycle is already proven on the live 0.50.1 swarm — so the browser
// never touches wasm, keys or CORS; the page just fetches these endpoints (same origin).
//
//   GET  /                 -> wallet.html (full MetaMask-style wallet)
//   GET  /api/status       -> { connected, account, network, linkedOrigin?, budget? , caps, spent, vault }
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
import { openBudgetTx, payTx, transferTx, setLimitsTx, addMerchantTx, removeMerchantTx, topUpTx, withdrawTx, issueBadgeTx, revokeSessionTx, revokeTx, templateEvents, parseBudgetSubstate, XTR } from "../src/agentpay-tx.js";
import { connectIndexer, accountVaults } from "../src/chain.js";
import { createDappBridge } from "../src/dapp-bridge.mjs";
import { loadKeyFile, keyFilePresent } from "./key-vault.mjs";

const PORT = parseInt(process.env.PORT) || 7777;
// Bind loopback by default: this process holds a funded dev key and signs, so it must NOT be reachable
// from the LAN. Set HOST=0.0.0.0 explicitly (and only behind a trusted proxy) if you truly need that.
const HOST = process.env.HOST || "127.0.0.1";
const INDEXER_URL = process.env.INDEXER_URL || "http://127.0.0.1:12008";
// The merged one-page dApp (dist/agentpay.html) bundles the AgentPay dashboard, whose app.js boots by
// reading the dashboard backend's /api/session + /api/state. This wallet server has its OWN /api (status,
// pay, open, …) but not those dashboard reads, so any /api/* path THIS server does not handle is forwarded
// to the dashboard backend. The forward is a fallback placed after every local /api handler and after the
// POST-token gate, so it only ever sees GET reads the wallet itself doesn't own — it never shadows or
// relays a wallet write. Until Phase 3 detaches the dashboard's reads, this is how :7777 serves the merged
// page whole. Unset DASHBOARD_PROXY (or point DASHBOARD_ORIGIN elsewhere) to disable/retarget.
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || "http://127.0.0.1:8787";
const DASHBOARD_PROXY = process.env.DASHBOARD_PROXY !== "0";
const TEMPLATE = process.env.AGENT_TEMPLATE || "template_c4b58558181f19c17d6ccc75c93e0707e2c5b75d1ef4de96a70acd0fd2d40e47";
const MERCHANT = process.env.MERCHANT || "component_c5c2db90a8f9f02981617244b835fd36d4830bdcb80eb7f5cb092932896924e3";
// Agent session badge label proven on pay. "default" is the badge this wallet's own open() minted;
// set SESSION to a label the owner issued into this account (issueAgentBadge) to pay a budget this
// wallet did not open — e.g. a budget opened by the dashboard and shared with this agent.
const SESSION = process.env.SESSION || "default";

// Load the custodial dev key. If a .spike-key.enc.json is present it is decrypted with the passphrase
// from WALLET_KEY_PASSPHRASE[_FILE]; otherwise it falls back to the plaintext .spike-key.json (dev).
const key = loadKeyFile(import.meta.url);
if (!key.account) throw new Error("key file has no account — fund one first");
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
let two = null, agentW = null;
if (fs.existsSync(TWO_FILE) && keyFilePresent(import.meta.url, ".spike-agent-key")) {
  two = JSON.parse(fs.readFileSync(TWO_FILE, "utf8"));
  const ak = loadKeyFile(import.meta.url, process.env, ".spike-agent-key"); // encrypted at rest like the owner key
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
// The dApp <-> wallet relay (enqueue / poll / resolve / linkedOrigin + CORS) lives in its own module
// so it can be regression-tested with no chain, engine or key — see src/dapp-bridge.mjs and its tests.
const bridge = createDappBridge({ dappOrigins: process.env.DAPP_ORIGINS });
// The custodial-signing /api writes and the dev-key export require the same per-process pairing token the
// same-origin wallet page already fetches from GET /bridge/session (x-wallet-token header or ?token=).
const tokenOK = (req) => (req.headers["x-wallet-token"] || new URL(req.url, "http://x").searchParams.get("token")) === bridge.sessionToken;
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
const txidOf = (r) => r?.result?.Finalized?.transaction_id || null;
const abortedOf = (r) => r?.result?.Finalized?.abort_details || null; // set on AcceptFeeRejectRest

// --- wallet-side activity journal (Phase 3) -----------------------------------------------------
// The indexer exposes NO per-component transaction/event history (only getSubstate + getTransactionResult
// by id), so — unlike the custodial backend, which scans walletd's listTransactions — the wallet cannot
// rebuild a budget's pay/session history from chain. Instead it keeps its OWN small ledger of everything
// it submits, so a connected dApp can show recent activity / tx-count / sessions / funded-withdrawn from
// the wallet. It is authoritative for wallet-driven activity going forward; it does NOT back-fill a
// budget's pre-existing on-chain history (a one-time `seeded` baseline makes funded + the default session
// sensible on first sight). Persisted per budget component in .spike-ledger.json.
const LEDGER_FILE = new URL("../.spike-ledger.json", import.meta.url);
let journal = {};
try { journal = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")); } catch { /* fresh */ }
function saveJournal() { try { fs.writeFileSync(LEDGER_FILE, JSON.stringify(journal)); } catch (e) { console.error("journal save:", e.message); } }
function jFor(component) {
  if (!journal[component]) journal[component] = { funded: "0", withdrawn: "0", pays: [], sessions: {}, seeded: false };
  return journal[component];
}
const recordPay = (c, { merchant, amount, memo, txid }) => { jFor(c).pays.push({ merchant, amount: String(amount), memo: memo || "", txid: txid || null, ts: Date.now(), via: "wallet" }); saveJournal(); };
const recordFund = (c, amount) => { const j = jFor(c); j.funded = (BigInt(j.funded) + BigInt(amount)).toString(); saveJournal(); };
const recordWithdraw = (c, amount) => { const j = jFor(c); j.withdrawn = (BigInt(j.withdrawn) + BigInt(amount)).toString(); saveJournal(); };
const recordIssue = (c, session) => { jFor(c).sessions[session] = { revoked: false }; saveJournal(); };
const recordRevokeSession = (c, session) => { jFor(c).sessions[session] = { revoked: true }; saveJournal(); };
async function budgetState() {
  if (!state.budget) return null;
  const b = await parseBudgetSubstate(await w.request("tari_getSubstate", { substate_id: state.budget }));
  let vault = state.initialFund != null ? Math.max(0, state.initialFund - b.spentInWindow) : null;
  // When this wallet didn't open the budget (reused via BUDGET / the two-account file), initialFund is
  // unknown — read the budget vault's real XTR balance on-chain so a connected dApp can show the true
  // treasury instead of a blank. vaultXtr() is hoisted (async function declaration) and resource-filters.
  if (vault == null && b.vault) { try { const v = await vaultXtr(b.vault); if (v != null) vault = Number(v); } catch { /* leave null */ } }
  // Seed the journal once per component so funded + the default session are sensible on first sight
  // (the wallet never saw this budget's pre-existing history). funded0 ≈ what is net in the vault now.
  const j = jFor(state.budget);
  if (!j.seeded) {
    if (vault != null) j.funded = String((Number(vault) || 0) + (Number(b.spentInWindow) || 0));
    if (!j.sessions[PAY_SESSION]) j.sessions[PAY_SESSION] = { revoked: false };
    j.seeded = true; saveJournal();
  }
  return {
    address: state.budget, perTx: b.perTxCap, daily: b.dailyCap, spent: b.spentInWindow,
    vault, whitelist: b.whitelist, agentBadge: b.agentBadge, epochsPerWindow: b.epochsPerWindow,
    // Phase 3 wallet-side history (the indexer can't rebuild it from chain) — see the journal note above.
    funded: j.funded, withdrawn: j.withdrawn,
    sessions: Object.entries(j.sessions).map(([session, v]) => ({ session, revoked: !!v.revoked })),
    ledger: j.pays.map((p, index) => ({
      index, merchant: p.merchant, amount: p.amount, memo: p.memo, onchainMemo: p.memo,
      txKind: "pay", status: "confirmed", txId: p.txid, via: p.via || "wallet", ts: p.ts,
    })),
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
  if (committed) recordPay(state.budget, { merchant: MERCHANT, amount, memo, txid });
  return { committed, amount, prevSpent: b0, spent: after.spent, vault: after.vault, txid, events, reason };
}

// --- owner governance ops (owner-badge gated) ---------------------------------------------------
// The OWNER signs these (sign(), not paySign) and pays the fee; the on-chain access rule requires the
// owner-badge proof the builder puts in the auth zone. Each returns the fresh budget state so the dApp
// re-renders from chain. On a chain rejection, commit() throws → the route answers 5xx and the wallet's
// bridge resolves an error to the dApp.
async function ownerOpCommon() {
  if (!state.budget) throw new Error("no budget open yet");
  const parsed = await parseBudgetSubstate(await w.request("tari_getSubstate", { substate_id: state.budget }));
  return {
    network: Network.LocalNet, maxEpoch: await w.maxEpoch(), owner: ACCOUNT,
    ownerVaults: await accountVaults(provider, ACCOUNT), budget: state.budget,
    // budgetVault + agentBadge power the lifecycle ops (top-up/withdraw touch the vault; issue mints the
    // agent-badge resource into the session account); harmless extra fields for the governance ops.
    // agentVaults are the session account's CURRENT vault ids — issue's deposit lands in its agent-badge
    // vault, which must be declared as an input (the bare indexer can't auto-detect it).
    budgetVault: parsed.vault, ownerBadge: parsed.ownerBadge, agentBadge: parsed.agentBadge,
    agent: PAY_AGENT, agentVaults: await accountVaults(provider, PAY_AGENT),
    maxFee: 200_000,
  };
}
async function doSetLimits({ perTxCap, dailyCap }) {
  commit(await sign(setLimitsTx({ ...(await ownerOpCommon()), perTxCap, dailyCap })), "set_limits");
  return { committed: true, ...(await budgetState()) };
}
async function doAddMerchant({ merchant }) {
  commit(await sign(addMerchantTx({ ...(await ownerOpCommon()), merchant })), "add_merchant");
  return { committed: true, ...(await budgetState()) };
}
async function doRemoveMerchant({ merchant }) {
  commit(await sign(removeMerchantTx({ ...(await ownerOpCommon()), merchant })), "remove_merchant");
  return { committed: true, ...(await budgetState()) };
}
// Lifecycle ops (Phase 2b). top_up is open (owner funds from their own account, no owner proof); the
// rest are owner-badge gated. All owner-signed + owner-paid. Each returns the fresh budget state.
async function doTopUp({ amount }) {
  commit(await sign(topUpTx({ ...(await ownerOpCommon()), amount })), "top_up");
  recordFund(state.budget, amount);
  return { committed: true, ...(await budgetState()) };
}
async function doWithdraw({ amount }) {
  commit(await sign(withdrawTx({ ...(await ownerOpCommon()), amount })), "withdraw");
  recordWithdraw(state.budget, amount);
  return { committed: true, ...(await budgetState()) };
}
async function doIssueSession({ session }) {
  const r = commit(await sign(issueBadgeTx({ ...(await ownerOpCommon()), session })), "issue_agent_badge");
  // Only journal the session if the mint actually landed (a fee-only AcceptFeeRejectRest still finalizes
  // as Commit — see the issue-deposit note in agentpay-tx.js), so a phantom session can't appear.
  if (!abortedOf(r)) recordIssue(state.budget, session);
  return { committed: true, ...(await budgetState()) };
}
async function doRevokeSession({ session }) {
  commit(await sign(revokeSessionTx({ ...(await ownerOpCommon()), session })), "revoke_session");
  recordRevokeSession(state.budget, session);
  return { committed: true, ...(await budgetState()) };
}
async function doRevoke() {
  commit(await sign(revokeTx(await ownerOpCommon())), "revoke");
  return { committed: true, ...(await budgetState()) };
}

const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => d += c); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });

// Forward an /api/* path this server doesn't own to the dashboard backend (see DASHBOARD_ORIGIN above).
// Only reached as a fallback, so req has not been consumed; pipe it through and stream the response back.
function proxyToDashboard(req, res, url) {
  const target = new URL(url.pathname + url.search, DASHBOARD_ORIGIN);
  const headers = { ...req.headers, host: target.host };
  const preq = http.request(target, { method: req.method, headers }, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  preq.on("error", (e) => { if (!res.headersSent) send(res, 502, { error: "dashboard proxy: " + e.message }); });
  req.pipe(preq);
}

// The self-custody wallet is a Vite-built bundle (keys live in the browser) served from ../dist.
const DIST = new URL("../dist/", import.meta.url);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json; charset=utf-8" };
function serveDist(res, rel) {
  const f = new URL(rel.replace(/^\/+/, ""), DIST);
  if (!fs.existsSync(f)) return false;
  const ext = rel.slice(rel.lastIndexOf("."));
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": ext === ".html" ? "no-store" : "max-age=86400" });
  res.end(fs.readFileSync(f));
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    // Root now serves the full MetaMask-style wallet; the old single-page demo stays at /live.
    // Vendored QR generator (Kazuhiko Arase, MIT), served to the wallet for the real receive QR.
    if (req.method === "GET" && url.pathname === "/qrcode.js") {
      const f = new URL("../qrcode.js", import.meta.url);
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "max-age=86400" });
      return res.end(fs.readFileSync(f));
    }
    // Root = the self-custody wallet (Vite build in ../dist). Built assets live under /assets.
    // The classic backend-custodial wallet stays reachable at /classic.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (serveDist(res, "wallet-sc.html")) return;
      // no build present -> fall back to the classic wallet below
    }
    // The merged one-page dApp (dashboard + this wallet on one origin). Its bundled assets live under
    // /assets (served below); its dashboard reads are proxied to :8787 by the /api fallback near the end.
    if (req.method === "GET" && url.pathname === "/agentpay.html") {
      if (serveDist(res, "agentpay.html")) return;
      return send(res, 404, { error: "agentpay.html not built — run vite build" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      if (serveDist(res, url.pathname)) return;
      return send(res, 404, { error: "asset not found" });
    }
    const STATIC = { "/": "wallet.html", "/classic": "wallet.html", "/classic.html": "wallet.html", "/wallet.html": "wallet.html", "/wallet": "wallet.html",
      "/live": "wallet-live.html", "/wallet-live.html": "wallet-live.html",
      "/linked": "linked.html", "/linked.html": "linked.html", "/dapp.html": "dapp.html" };
    if (req.method === "GET" && STATIC[url.pathname]) {
      const f = new URL("../" + STATIC[url.pathname], import.meta.url);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(fs.readFileSync(f));
    }
    if (url.pathname === "/api/status") {
      return send(res, 200, { connected: true, account: ACCOUNT, network: "localnet", indexer: INDEXER_URL,
        template: TEMPLATE, merchant: MERCHANT, agentAccount: PAY_AGENT, twoAccount: !!two,
        linkedOrigin: bridge.linkedOrigin, budget: await budgetState() });
    }
    if (url.pathname === "/api/account") {
      return send(res, 200, { account: ACCOUNT, resource: "XTR", balance: (await ownerBalance()).toString() });
    }
    // Everything below signs with the custodial key (or exports it): gate on the same pairing token the
    // same-origin wallet page holds. The read-only /api/status and /api/account above stay open.
    if ((url.pathname === "/api/dev-key" || (req.method === "POST" && url.pathname.startsWith("/api/"))) && !tokenOK(req)) {
      return send(res, 401, { error: "unauthorized (wallet token required)" });
    }
    // localnet dev continuity: let the in-browser self-custody wallet IMPORT this funded dev account by
    // taking its key into the browser. This server is localnet-only (status.network === "localnet");
    // never expose this on a real network.
    if (req.method === "GET" && url.pathname === "/api/dev-key") {
      return send(res, 200, { owner: key.owner, view: key.view, account: ACCOUNT });
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
    // Owner governance (owner-badge gated, owner-signed) — the dApp reaches these only via the bridge.
    if (req.method === "POST" && url.pathname === "/api/limits") {
      const p = await body(req); const perTxCap = String(p.perTxCap), dailyCap = String(p.dailyCap);
      if (!/^\d+$/.test(perTxCap) || !/^\d+$/.test(dailyCap) || BigInt(dailyCap) < BigInt(perTxCap))
        return send(res, 400, { error: "perTxCap/dailyCap must be positive integers with daily >= perTx" });
      return send(res, 200, await doSetLimits({ perTxCap, dailyCap }));
    }
    if (req.method === "POST" && (url.pathname === "/api/merchant/add" || url.pathname === "/api/merchant/remove")) {
      const p = await body(req); const merchant = String(p.merchant || "");
      if (!merchant.startsWith("component_")) return send(res, 400, { error: "merchant must be a component_ address" });
      return send(res, 200, url.pathname.endsWith("/add") ? await doAddMerchant({ merchant }) : await doRemoveMerchant({ merchant }));
    }
    // Lifecycle (Phase 2b): fund / withdraw the vault, issue + revoke session badges, global kill switch.
    if (req.method === "POST" && (url.pathname === "/api/top-up" || url.pathname === "/api/withdraw")) {
      const p = await body(req); const amount = String(p.amount ?? "");
      if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) return send(res, 400, { error: "amount must be a positive integer" });
      return send(res, 200, url.pathname.endsWith("/top-up") ? await doTopUp({ amount }) : await doWithdraw({ amount }));
    }
    if (req.method === "POST" && (url.pathname === "/api/sessions" || url.pathname === "/api/sessions/revoke")) {
      const p = await body(req); const session = String(p.session || "").trim();
      if (!session) return send(res, 400, { error: "session label required" });
      return send(res, 200, url.pathname.endsWith("/revoke") ? await doRevokeSession({ session }) : await doIssueSession({ session }));
    }
    if (req.method === "POST" && url.pathname === "/api/revoke") return send(res, 200, await doRevoke());

    // --- relay: the dApp enqueues (CORS-allowed), the wallet drains + answers (same origin) ---
    // The queue/poll/resolve/linkedOrigin state machine + CORS live in src/dapp-bridge.mjs; handle()
    // writes the response itself (with its own body reader), exactly as this block used to inline.
    if (url.pathname.startsWith("/bridge/")) return void (await bridge.handle(req, res));

    // Fallback: an /api/* path none of the wallet's own handlers claimed — forward it to the dashboard
    // backend so the merged page's app.js can read /api/session + /api/state. POST /api/* was already
    // 401'd by the token gate above, so in practice only GET reads reach here.
    if (DASHBOARD_PROXY && url.pathname.startsWith("/api/")) return void proxyToDashboard(req, res, url);

    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
});
server.listen(PORT, HOST, () => console.log(`wallet-server on http://${HOST}:${PORT}  account=${ACCOUNT}  budget=${state.budget || "(open one)"}`));
