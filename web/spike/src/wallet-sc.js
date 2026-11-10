// wallet-sc.js — onboarding + accounts + settings controller for the self-custody wallet.
//
// Wires src/self-custody.mjs (pure: keygen, mnemonic, encrypted vault) to the ootle WASM for the one
// thing the module deliberately leaves out — deriving the account address from the secret. Everything
// here runs in the browser: secrets are generated, shown-for-backup, encrypted and stored locally, and
// never sent anywhere.
//
// Multi-account model: the encrypted vault holds a LIST of keypairs { keys:[{id,owner,view}] } under one
// passphrase; the per-account PUBLIC metadata (label, on-chain component, which is active) lives in a
// plaintext store (`ap-sc-meta`) — it is public anyway, and keeping it out of the vault means switching,
// renaming and recording a funded account need no re-encrypt. Adding an account or changing the
// passphrase do re-encrypt, so while unlocked we keep the passphrase in memory (the decrypted secrets
// are already in memory, so this adds no real exposure) and clear it on lock.
import {
  generateKeyMaterial, keyMaterialToMnemonic, mnemonicToKeyMaterial,
  encryptVault, decryptVault, toHex, fromHex, TOTAL_WORDS,
} from "./self-custody.mjs";
import { Network } from "@tari-project/ootle";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { connect as scConnect, fundViaFaucet, balanceOf, sendXtr, ownerPublicHex, accountHistory, openBudget, readBudget, payBudget } from "./sc-chain.mjs";

const $ = (id) => document.getElementById(id);
const VAULT_KEY = "ap-sc-vault";       // encrypted: { keys:[{id,owner,view}] }
const META_KEY = "ap-sc-meta";         // plaintext: { list:[{id,label,account}], active }
const SETTINGS_KEY = "ap-sc-settings"; // plaintext: { autoLockMin, indexer }
const LEGACY_ACCOUNT_KEY = "ap-sc-account"; // pre-multi-account single component (migrated away)
const ACTIVITY_KEY = "ap-sc-activity"; // this wallet's own send actions, for recipient enrichment
const BUDGET_KEY = "ap-sc-budget";     // plaintext, per account id: { component, ownerBadge, agentBadge, vaultId, merchant, template } — all public
const NETWORK = Network.LocalNet;      // identity address is net-scoped; localnet for now (prefix otl_loc_)
const DEFAULT_INDEXER = "http://127.0.0.1:12008";

let INDEXER = null; // indexer URL: user setting > /api/status > default; enables on-chain ops
let TEMPLATE = null; // AgentBudget template address (from /api/status) — needed to open a budget
let DEFAULT_MERCHANT = null; // a sample merchant from /api/status, prefilled in the open-budget form
let _provider = null;
let _providerUrl = null;
async function ensureIndexer() {
  const saved = loadSettings().indexer;
  if (saved) { INDEXER = saved; return INDEXER; }
  if (INDEXER) return INDEXER;
  try { const r = await fetch("/api/status"); if (r.ok) { const s = await r.json(); INDEXER = s.indexer || DEFAULT_INDEXER; } } catch { /* standalone, no backend */ }
  return INDEXER;
}
async function indexer() {
  if (_provider && _providerUrl === INDEXER) return _provider;
  _provider = await scConnect(INDEXER); _providerUrl = INDEXER; return _provider;
}

// --- storage helpers ---------------------------------------------------------------------------
const genId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
function loadMeta() {
  try { const m = JSON.parse(localStorage.getItem(META_KEY)); if (m && Array.isArray(m.list)) return m; } catch { /* fresh */ }
  return { list: [], active: null };
}
function saveMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch { /* storage blocked */ } }
function loadSettings() {
  try { return { autoLockMin: 0, indexer: "", ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; } catch { return { autoLockMin: 0, indexer: "" }; }
}
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* blocked */ } }
// budget store (plaintext, keyed by account id — the budget component + badge resources are all public)
function loadBudgets() { try { return JSON.parse(localStorage.getItem(BUDGET_KEY)) || {}; } catch { return {}; } }
function budgetFor(accountId) { const b = loadBudgets()[accountId]; return b && b.component ? b : null; }
function saveBudgetFor(accountId, b) { const all = loadBudgets(); all[accountId] = b; try { localStorage.setItem(BUDGET_KEY, JSON.stringify(all)); } catch { /* blocked */ } }
function clearBudgetFor(accountId) { const all = loadBudgets(); delete all[accountId]; try { localStorage.setItem(BUDGET_KEY, JSON.stringify(all)); } catch { /* blocked */ } }
const activeBudget = () => budgetFor(activeId());

// --- in-memory, cleared on lock ----------------------------------------------------------------
let pending = null;  // { owner, view, account?, mode:"first"|"add" } awaiting a passphrase or append
let unlocked = null; // { keys:[{id,owner,view}], pass } the live, decrypted wallet
let editingId = null; // the account row currently being renamed, if any

const metaFor = (id) => loadMeta().list.find((a) => a.id === id) || null;
const activeId = () => loadMeta().active;
const activeKey = () => (unlocked && unlocked.keys.find((k) => k.id === activeId())) || null;
const activeMeta = () => metaFor(activeId());
const currentAccount = () => (activeMeta() && activeMeta().account) || null;
const walletOf = () => { const k = activeKey(); return SecretKeyWallet.fromSecretKey(fromHex(k.owner), NETWORK, fromHex(k.view)); };
const addressOf = (owner, view) => SecretKeyWallet.fromSecretKey(owner, NETWORK, view).getAddress();
async function saveVault(pass) { localStorage.setItem(VAULT_KEY, JSON.stringify(await encryptVault({ keys: unlocked.keys }, pass))); }

const PANELS = ["pOnboard", "pCreate", "pRestore", "pSetPass", "pUnlock", "pMain"];
function show(panel) {
  for (const p of PANELS) $(p).hidden = p !== panel;
  const onMain = panel === "pMain";
  $("btnLock").hidden = !onMain;
  $("btnSettings").hidden = !onMain;
  if (!onMain) { closeSheet("sheetAccounts"); closeSheet("sheetSettings"); }
}
const shortAddr = (a) => (a && a.length > 20) ? a.slice(0, 10) + "…" + a.slice(-6) : (a || "");

function renderWords(gridId, phrase) {
  const grid = $(gridId);
  grid.innerHTML = "";
  phrase.split(/\s+/).forEach((w, i) => {
    const d = document.createElement("div");
    d.className = "w";
    d.innerHTML = `<b>${i + 1}</b>${w}`;
    grid.appendChild(d);
  });
}

function routeStart() {
  const hasVault = !!localStorage.getItem(VAULT_KEY);
  show(hasVault ? "pUnlock" : "pOnboard");
}

// --- create / restore entry points (first wallet OR add-account) -------------------------------
function startCreate(mode) {
  pending = { ...generateKeyMaterial(), mode };
  renderWords("wordGrid", keyMaterialToMnemonic(pending));
  $("createAddr").textContent = "派生中…";
  $("btnReveal").textContent = mode === "add" ? "▣ 已备份,添加账户" : "▣ 已确认,下一步";
  show("pCreate");
  addressOf(pending.owner, pending.view)
    .then((a) => ($("createAddr").textContent = a))
    .catch((e) => ($("createAddr").textContent = "地址派生失败: " + (e?.message || e)));
}
function startRestore(mode) {
  pending = { mode };
  $("restoreErr").textContent = ""; $("restoreWords").value = "";
  $("btnRestoreVerify").textContent = mode === "add" ? "导入并添加" : "验证并继续";
  show("pRestore");
}

$("btnCreate").onclick = () => startCreate("first");
$("btnRestoreStart").onclick = () => startRestore("first");
$("btnRestoreBack").onclick = () => (pending && pending.mode === "add" ? (openSheet("sheetAccounts"), show("pMain")) : routeStart());

// pCreate "next": first → set passphrase; add → append to the unlocked vault right away
$("btnReveal").onclick = async () => {
  if (pending && pending.mode === "add") return void appendAccount(pending);
  $("setPassErr").textContent = ""; $("pass1").value = $("pass2").value = ""; show("pSetPass");
};
$("btnRestoreVerify").onclick = async () => {
  $("restoreErr").textContent = "";
  let km;
  try { km = mnemonicToKeyMaterial($("restoreWords").value); }
  catch (e) { $("restoreErr").textContent = e?.message || String(e); return; }
  const mode = (pending && pending.mode) || "first";
  pending = { ...km, mode };
  if (mode === "add") return void appendAccount(pending);
  $("pass1").value = $("pass2").value = ""; $("setPassErr").textContent = ""; show("pSetPass");
};

// --- import an existing account (localnet dev continuity) — first wallet only -------------------
$("btnImportDev").onclick = async () => {
  let k;
  try {
    const r = await fetch("/api/dev-key");
    if (!r.ok) throw new Error("backend returned " + r.status);
    k = await r.json();
    if (!k.owner || !k.view) throw new Error("no key in response");
  } catch (e) {
    alert("无法导入现有账户: " + (e?.message || e) + "(需从 :7777 钱包后端打开)");
    return;
  }
  pending = { owner: fromHex(k.owner), view: fromHex(k.view), account: k.account || null, mode: "first" };
  $("pass1").value = $("pass2").value = ""; $("setPassErr").textContent = ""; show("pSetPass");
};

// --- set passphrase -> create the FIRST wallet (one account) -----------------------------------
$("btnEncrypt").onclick = async () => {
  const p1 = $("pass1").value, p2 = $("pass2").value;
  if (p1.length < 8) return void ($("setPassErr").textContent = "口令至少 8 位");
  if (p1 !== p2) return void ($("setPassErr").textContent = "两次输入不一致");
  if (!pending) return void ($("setPassErr").textContent = "没有待保存的密钥,请重试");
  const id = genId();
  unlocked = { keys: [{ id, owner: toHex(pending.owner), view: toHex(pending.view) }], pass: p1 };
  try { await saveVault(p1); }
  catch (e) { return void ($("setPassErr").textContent = "保存失败: " + (e?.message || e)); }
  saveMeta({ list: [{ id, label: "账户 1", account: pending.account || null }], active: id });
  pending = null; $("pass1").value = $("pass2").value = "";
  startIdleTimer();
  await enterMain();
};

// --- add an account to the already-unlocked wallet (create or import) ---------------------------
async function appendAccount({ owner, view, account }) {
  if (!unlocked) return routeStart();
  const id = genId();
  const ownerHex = owner instanceof Uint8Array ? toHex(owner) : owner;
  const viewHex = view instanceof Uint8Array ? toHex(view) : view;
  unlocked.keys.push({ id, owner: ownerHex, view: viewHex });
  try { await saveVault(unlocked.pass); }
  catch (e) { unlocked.keys.pop(); alert("添加失败: " + (e?.message || e)); return; }
  const m = loadMeta();
  m.list.push({ id, label: "账户 " + (m.list.length + 1), account: account || null });
  m.active = id;
  saveMeta(m);
  pending = null;
  await enterMain();
}

// --- unlock (+ one-time migration from the old single-vault format) -----------------------------
$("btnUnlock").onclick = async () => {
  $("unlockErr").textContent = "";
  let blob;
  try { blob = JSON.parse(localStorage.getItem(VAULT_KEY)); } catch { blob = null; }
  if (!blob) return routeStart();
  const pass = $("unlockPass").value;
  let obj;
  try { obj = await decryptVault(blob, pass); }
  catch (e) { $("unlockErr").textContent = e?.message || "口令错误"; return; }
  if (Array.isArray(obj.keys)) {
    unlocked = { keys: obj.keys, pass };
  } else {
    // migrate the legacy { owner, view, account? } vault → a one-account multi-account vault
    const id = genId();
    unlocked = { keys: [{ id, owner: obj.owner, view: obj.view }], pass };
    if (!localStorage.getItem(META_KEY)) {
      const acct = obj.account || localStorage.getItem(LEGACY_ACCOUNT_KEY) || null;
      saveMeta({ list: [{ id, label: "账户 1", account: acct }], active: id });
    }
    try { await saveVault(pass); localStorage.removeItem(LEGACY_ACCOUNT_KEY); } catch { /* keep legacy on failure */ }
  }
  // meta may be missing (e.g. cleared) — rebuild a default from the key list
  let m = loadMeta();
  if (!m.list.length) { m = { list: unlocked.keys.map((k, i) => ({ id: k.id, label: "账户 " + (i + 1), account: null })), active: unlocked.keys[0].id }; saveMeta(m); }
  if (!m.list.find((a) => a.id === m.active)) { m.active = m.list[0].id; saveMeta(m); }
  $("unlockPass").value = "";
  startIdleTimer();
  await enterMain();
};
$("btnForget").onclick = () => {
  if (!confirm("清除本机的钱包数据(所有账户)?若没有助记词备份将无法找回。")) return;
  for (const k of [VAULT_KEY, META_KEY, SETTINGS_KEY, LEGACY_ACCOUNT_KEY]) localStorage.removeItem(k);
  stopIdleTimer();
  unlocked = pending = null;
  routeStart();
};

// --- main (unlocked) ---------------------------------------------------------------------------
const groupNum = (s) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

async function enterMain() {
  show("pMain");
  $("fundErr").textContent = "";
  await ensureIndexer();
  startBridge(); // begin draining dApp requests (idempotent; no-op without a backend)
  const am = activeMeta();
  const account = currentAccount();
  $("acctLabel").textContent = (am && am.label) || "账户";
  // reset the send + receive forms each time we (re-)enter the main view
  $("sendForm").hidden = true;
  $("sendErr").textContent = ""; $("sendOk").textContent = "";
  $("recvView").hidden = true;
  $("btnFund").disabled = false; $("fundLabel").textContent = "充值";
  if (account) {
    $("addrLabel").textContent = "账户余额(链上读取)";
    setAddress(account);
    $("balBlock").hidden = false;
    $("btnRecvOpen").hidden = false;
    $("btnSendOpen").hidden = false;
    $("btnSendOpen").disabled = !INDEXER;
    $("btnFund").hidden = true;
    $("actBlock").hidden = false;
    $("budgetBlock").hidden = false;
    renderActivity(account);
    renderBudget();
    await refreshBalance(account);
  } else {
    $("addrLabel").textContent = "未充值 · 链上尚无账户";
    $("balBlock").hidden = true;
    $("tokBal").textContent = "—";
    $("btnRecvOpen").hidden = true;
    $("btnSendOpen").hidden = true;
    $("btnFund").hidden = !INDEXER;
    $("actBlock").hidden = true;
    $("budgetBlock").hidden = true;
    setAddress("派生中…");
    try { const k = activeKey(); setAddress(await addressOf(fromHex(k.owner), fromHex(k.view))); }
    catch (e) { setAddress("地址派生失败: " + (e?.message || e)); }
  }
}

// the full address lives in #mainAddr (used by copy + QR); the hero shows a short, copyable chip
function setAddress(addr) {
  $("mainAddr").textContent = addr;
  $("addrShort").textContent = /^(otl_|component_)/.test(addr) ? shortAddr(addr) : addr;
}

// --- activity: the account's REAL on-chain history, read from the indexer's per-vault events --------
// The list is chain-sourced (incoming transfers from others included — see sc-chain.accountHistory).
// A small local log of this wallet's OWN sends is kept ONLY to enrich a matching tx with its recipient
// address, which the chain events do not name.
function loadActivity() {
  try { return JSON.parse(localStorage.getItem(ACTIVITY_KEY)) || []; } catch { return []; }
}
function logActivity(entry) {
  const all = loadActivity();
  all.unshift({ t: Date.now(), ...entry });
  try { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(all.slice(0, 50))); } catch { /* storage full/blocked: skip */ }
}
function ago(t) {
  if (!t) return "链上";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + " 秒前";
  const m = Math.floor(s / 60); if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60); if (h < 24) return h + " 小时前";
  return Math.floor(h / 24) + " 天前";
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function actRow(cls, ic, title, sub, amt, amtCls) {
  return `<div class="arow"><div class="aic ${cls}">${ic}</div>`
    + `<div class="agrow"><div class="atitle">${title}</div><div class="asub">${sub}</div></div>`
    + `<div class="aamt ${amtCls || ""}">${amt}</div></div>`;
}
let _actToken = 0; // guards against a stale async render overwriting a newer one
async function renderActivity(account) {
  const box = $("actList");
  const token = ++_actToken;
  box.innerHTML = '<div class="empty">读取链上记录…</div>';
  await ensureIndexer();
  if (!INDEXER) { box.innerHTML = '<div class="empty">未连接索引器,无法读取链上记录。</div>'; return; }
  const mine = new Map(loadActivity().filter((e) => e.account === account && e.txId).map((e) => [String(e.txId), e]));
  let rows;
  try { rows = await accountHistory(await indexer(), account, { limit: 25 }); }
  catch (e) { if (token === _actToken) box.innerHTML = '<div class="empty">链上记录读取失败。</div>'; console.warn("history:", e); return; }
  if (token !== _actToken) return;
  if (!rows.length) { box.innerHTML = '<div class="empty">暂无链上记录。</div>'; return; }
  box.innerHTML = rows.map((r) => {
    const tx = esc(String(r.txId).slice(0, 10)) + "…";
    const when = ago(r.time);
    const bad = r.ok ? "" : ' · <span class="afail">未成功</span>';
    if (r.dir === "out") {
      const loc = mine.get(String(r.txId));
      const to = loc && loc.to ? "→ " + esc(shortAddr(loc.to)) + " · " : "";
      const fee = BigInt(r.fee || "0") > 0n ? " · 费 " + groupNum(r.fee) : "";
      return actRow("out", "↑", "发送", `${to}${tx}${fee} · ${when}${bad}`, `−${groupNum(r.amount)} XTR`, "neg");
    }
    if (r.dir === "fund") {
      return actRow("fund", "＋", "充值领取", `${tx} · ${when}${bad}`, `+${groupNum(r.amount)} XTR`, "pos");
    }
    if (r.dir === "op") {
      return actRow("op", "⚙", "合约操作", `仅手续费 · ${tx} · ${when}${bad}`, `−${groupNum(r.fee)} XTR`, "neg");
    }
    return actRow("in", "↓", "收到", `${tx} · ${when}${bad}`, `+${groupNum(r.amount)} XTR`, "pos");
  }).join("");
}

async function refreshBalance(account) {
  $("balNum").textContent = "…"; $("tokBal").textContent = "…";
  await ensureIndexer();
  if (!INDEXER) { $("balNum").textContent = "—"; $("tokBal").textContent = "—"; return; }
  try {
    const bal = await balanceOf(await indexer(), account);
    const g = groupNum(bal.toString());
    $("balNum").textContent = g; $("tokBal").textContent = g;
  } catch (e) { $("balNum").textContent = "读取失败"; $("tokBal").textContent = "—"; console.warn("balance read:", e); }
}

// create + fund the active account on localnet, signed in the browser by the user's own key
$("btnFund").onclick = async () => {
  $("fundErr").textContent = "";
  $("btnFund").disabled = true; $("fundLabel").textContent = "创建中…";
  try {
    await ensureIndexer();
    if (!INDEXER) throw new Error("无法连接本地索引器");
    const provider = await indexer();
    const k = activeKey();
    const { txId, account } = await fundViaFaucet(provider, walletOf(), ownerPublicHex(fromHex(k.owner)));
    if (!account) throw new Error("交易已提交但未找到新账户");
    const m = loadMeta(); const a = m.list.find((x) => x.id === k.id); if (a) a.account = account; saveMeta(m);
    logActivity({ kind: "fund", account, txId });
    await enterMain();
  } catch (e) {
    $("fundErr").textContent = "创建失败: " + (e?.reason || e?.message || e);
    $("btnFund").disabled = false; $("fundLabel").textContent = "充值";
  }
};

// --- receive: a scannable QR of the account address (vendored global `qrcode`) -------------------
function qrSvgFor(addr) {
  const q = globalThis.qrcode;
  if (!addr || typeof q !== "function") return '<p class="mut" style="font-size:12px">二维码生成器未加载,请复制上面的地址。</p>';
  for (const ecc of ["M", "L"]) {
    try { const qr = q(0, ecc); qr.addData(addr); qr.make(); return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
    catch { /* address too long for this ECC level; try the next */ }
  }
  return '<p class="mut" style="font-size:12px">地址过长,无法生成二维码,请复制上面的地址。</p>';
}
$("btnRecvOpen").onclick = () => {
  const open = $("recvView").hidden;
  if (open) $("qrBox").innerHTML = qrSvgFor(currentAccount() || $("mainAddr").textContent);
  $("recvView").hidden = !open;
};

// --- send: owner → recipient payment, signed in the browser -------------------------------------
$("btnSendOpen").onclick = () => {
  $("sendErr").textContent = ""; $("sendOk").textContent = "";
  $("sendForm").hidden = false; $("sendTo").focus();
};
$("btnSendCancel").onclick = () => {
  $("sendForm").hidden = true; $("sendTo").value = ""; $("sendAmt").value = ""; $("sendErr").textContent = "";
};
$("btnSendDo").onclick = async () => {
  $("sendErr").textContent = ""; $("sendOk").textContent = "";
  const to = $("sendTo").value.trim();
  const amtStr = $("sendAmt").value.trim();
  if (!/^component_[0-9a-f]{64}$/.test(to)) return void ($("sendErr").textContent = "收款地址应为 component_ 开头的 64 位十六进制账户地址");
  const from = currentAccount();
  if (to === from) return void ($("sendErr").textContent = "不能给自己转账");
  let amount;
  try { amount = BigInt(amtStr); } catch { return void ($("sendErr").textContent = "金额必须是整数"); }
  if (amount <= 0n) return void ($("sendErr").textContent = "金额必须大于 0");
  $("btnSendDo").disabled = true; $("btnSendCancel").disabled = true;
  const prev = $("btnSendDo").textContent;
  $("btnSendDo").textContent = "发送中…(约 10–30 秒)";
  try {
    await ensureIndexer();
    if (!INDEXER) throw new Error("无法连接本地索引器");
    const { txId } = await sendXtr(await indexer(), walletOf(), from, to, amount);
    $("sendOk").textContent = "已发送 ✓ tx " + String(txId).slice(0, 16) + "…";
    $("sendTo").value = ""; $("sendAmt").value = ""; $("sendForm").hidden = true;
    logActivity({ kind: "send", account: from, to, amount: amount.toString(), txId });
    renderActivity(from);
    await refreshBalance(from);
  } catch (e) {
    $("sendErr").textContent = "发送失败: " + (e?.reason || e?.message || e);
  } finally {
    $("btnSendDo").disabled = false; $("btnSendCancel").disabled = false; $("btnSendDo").textContent = prev;
  }
};

// --- AgentBudget: the chain-enforced budget a dApp (the dashboard) drives over window.tari ----------
// The active account can OPEN one budget (owner-signed), which the dashboard then reads (tari_getBudget)
// and pays against (params.pay). Single-account: this key is both owner (governs) and agent (pays).
let _budToken = 0;
async function renderBudget() {
  const account = currentAccount();
  const b = activeBudget();
  const has = !!b;
  $("budHas").hidden = !has;
  $("budNone").hidden = has;
  $("budgetForm").hidden = true;
  $("budErr").textContent = "";
  if (!has) {
    // no budget yet: offer to open one (disabled until we know the template + indexer)
    $("btnBudgetOpen").disabled = !(INDEXER && TEMPLATE && account);
    $("budNoneHint").textContent = !account ? "先充值/创建账户后即可开预算。"
      : !INDEXER ? "未连接索引器,暂不能开预算。"
      : !TEMPLATE ? "未取得预算模板地址(需后端 /api/status)。"
      : "开一个链上预算,仪表盘连接后即可按额度付款。";
    return;
  }
  $("budComp").textContent = shortAddr(b.component);
  $("budMerchant").textContent = shortAddr(b.merchant);
  $("budCaps").textContent = "读取中…"; $("budSpent").textContent = "…"; $("budVault").textContent = "…";
  const token = ++_budToken;
  try {
    await ensureIndexer();
    const wb = await readBudget(await indexer(), b.component);
    if (token !== _budToken) return;
    $("budCaps").textContent = `${groupNum(wb.perTx)} / ${groupNum(wb.daily)} XTR`;
    $("budSpent").textContent = `${groupNum(wb.spent)} XTR`;
    $("budVault").textContent = `${groupNum(wb.vault)} XTR`;
  } catch (e) {
    if (token !== _budToken) return;
    $("budCaps").textContent = "读取失败"; $("budSpent").textContent = "—"; $("budVault").textContent = "—";
    console.warn("budget read:", e);
  }
}
$("btnBudgetOpen").onclick = () => {
  $("budErr").textContent = "";
  $("budFund").value = $("budFund").value || "1000000";
  $("budPerTx").value = $("budPerTx").value || "100000";
  $("budDaily").value = $("budDaily").value || "500000";
  $("budMerchantIn").value = $("budMerchantIn").value || DEFAULT_MERCHANT || "";
  $("budTemplate").textContent = TEMPLATE ? shortAddr(TEMPLATE) : "(未知)";
  $("budgetForm").hidden = false;
  $("budNone").hidden = true;
};
$("btnBudgetCancel").onclick = () => { $("budgetForm").hidden = true; $("budNone").hidden = !!activeBudget(); renderBudget(); };
$("btnBudgetDo").onclick = async () => {
  $("budErr").textContent = "";
  const account = currentAccount();
  const merchant = $("budMerchantIn").value.trim();
  const fund = $("budFund").value.trim(), perTx = $("budPerTx").value.trim(), daily = $("budDaily").value.trim();
  if (!account) return void ($("budErr").textContent = "无账户");
  if (!TEMPLATE) return void ($("budErr").textContent = "缺少预算模板地址");
  if (!/^component_[0-9a-f]{64}$/.test(merchant)) return void ($("budErr").textContent = "商户地址应为 component_ 开头的 64 位十六进制");
  for (const [v, n] of [[fund, "初始注资"], [perTx, "单笔上限"], [daily, "每日上限"]]) {
    if (!/^\d+$/.test(v) || BigInt(v) <= 0n) return void ($("budErr").textContent = `${n}必须是正整数`);
  }
  $("btnBudgetDo").disabled = true; $("btnBudgetCancel").disabled = true;
  const prev = $("btnBudgetDo").textContent; $("btnBudgetDo").textContent = "开预算中…(约 10–30 秒)";
  try {
    await ensureIndexer();
    if (!INDEXER) throw new Error("无法连接本地索引器");
    const { budget, state } = await openBudget(await indexer(), walletOf(), {
      owner: account, template: TEMPLATE, merchant, fund, perTxCap: perTx, dailyCap: daily, epochsPerWindow: 10,
    });
    saveBudgetFor(activeId(), { component: budget, ownerBadge: state.ownerBadge, agentBadge: state.agentBadge, vaultId: state.vault, merchant, template: TEMPLATE });
    $("budgetForm").hidden = true;
    renderBudget();
  } catch (e) {
    $("budErr").textContent = "开预算失败: " + (e?.reason || e?.message || e);
  } finally {
    $("btnBudgetDo").disabled = false; $("btnBudgetCancel").disabled = false; $("btnBudgetDo").textContent = prev;
  }
};

// copy the full address from either the hero chip or the token-row address box
async function copyAddress() {
  const prev = $("addrShort").textContent;
  try { await navigator.clipboard.writeText($("mainAddr").textContent); $("addrShort").textContent = "已复制 ✓"; setTimeout(() => ($("addrShort").textContent = prev), 1200); } catch {}
}
$("addrChip").onclick = copyAddress;
$("mainAddr").onclick = copyAddress;
$("btnActRefresh").onclick = async () => {
  const account = currentAccount();
  if (!account) return;
  const b = $("btnActRefresh");
  b.disabled = true; b.classList.add("spin");
  try { await Promise.all([renderActivity(account), refreshBalance(account)]); }
  finally { b.disabled = false; b.classList.remove("spin"); }
};
$("btnLock").onclick = lockWallet;

// --- sheets (accounts / settings) overlay the main view ----------------------------------------
function openSheet(id) { $(id).hidden = false; }
function closeSheet(id) { $(id).hidden = true; }
$("btnCloseAccounts").onclick = () => closeSheet("sheetAccounts");
$("btnCloseSettings").onclick = () => closeSheet("sheetSettings");

// account switcher ------------------------------------------------------------------------------
$("acctSwitch").onclick = () => { editingId = null; renderAccounts(); openSheet("sheetAccounts"); };
function renderAccounts() {
  const m = loadMeta();
  const box = $("acctList");
  box.innerHTML = m.list.map((a) => {
    const on = a.id === m.active;
    const addr = a.account ? esc(shortAddr(a.account)) : "未充值";
    if (editingId === a.id) {
      return `<div class="acrow edit"><div class="ava sm"></div>`
        + `<input class="renameIn" id="renameIn" value="${esc(a.label)}" maxlength="24" />`
        + `<button class="minibtn" data-act="save" data-id="${a.id}">✓</button>`
        + `<button class="minibtn" data-act="cancelrename" data-id="${a.id}">✕</button></div>`;
    }
    const del = m.list.length > 1 ? `<button class="minibtn" data-act="remove" data-id="${a.id}" title="移除账户">🗑</button>` : "";
    return `<div class="acrow${on ? " on" : ""}" data-act="switch" data-id="${a.id}">`
      + `<div class="ava sm"></div>`
      + `<div class="acinfo"><div class="acname">${esc(a.label)}${on ? ' <span class="acnow">当前</span>' : ""}</div><div class="acaddr">${addr}</div></div>`
      + `<button class="minibtn" data-act="rename" data-id="${a.id}" title="重命名">✎</button>${del}</div>`;
  }).join("");
}
$("acctList").onclick = (e) => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  if (act === "switch") switchAccount(id);
  else if (act === "rename") { editingId = id; renderAccounts(); setTimeout(() => $("renameIn")?.focus(), 0); }
  else if (act === "cancelrename") { editingId = null; renderAccounts(); }
  else if (act === "save") saveRename(id);
  else if (act === "remove") removeAccount(id);
};
async function removeAccount(id) {
  if (!unlocked) return;
  const m = loadMeta();
  if (m.list.length <= 1) return; // never remove the last account
  const a = m.list.find((x) => x.id === id);
  if (!confirm(`移除账户「${(a && a.label) || id}」?\n请先确认已备份其助记词 —— 移除后本机不再保留它的私钥,只能用助记词恢复。`)) return;
  const keep = unlocked.keys.filter((k) => k.id !== id);
  if (!keep.length) return;
  const removed = unlocked.keys;
  unlocked.keys = keep;
  try { await saveVault(unlocked.pass); }
  catch (e) { unlocked.keys = removed; alert("移除失败: " + (e?.message || e)); return; }
  m.list = m.list.filter((x) => x.id !== id);
  if (m.active === id) m.active = m.list[0].id;
  saveMeta(m);
  editingId = null;
  renderAccounts();
  await enterMain();
}
async function switchAccount(id) {
  const m = loadMeta();
  if (!m.list.find((a) => a.id === id)) return;
  m.active = id; saveMeta(m);
  editingId = null;
  closeSheet("sheetAccounts");
  await enterMain();
}
function saveRename(id) {
  const v = ($("renameIn")?.value || "").trim();
  if (v) { const m = loadMeta(); const a = m.list.find((x) => x.id === id); if (a) { a.label = v; saveMeta(m); } }
  editingId = null;
  renderAccounts();
  if (id === activeId()) $("acctLabel").textContent = activeMeta().label;
}
$("btnAddCreate").onclick = () => { closeSheet("sheetAccounts"); startCreate("add"); };
$("btnAddImport").onclick = () => { closeSheet("sheetAccounts"); startRestore("add"); };

// settings --------------------------------------------------------------------------------------
$("btnSettings").onclick = () => { renderSettings(); openSheet("sheetSettings"); };
function renderSettings() {
  const s = loadSettings();
  $("setAutoLock").value = String(s.autoLockMin || 0);
  $("setIndexer").value = s.indexer || "";
  $("setIndexerCur").textContent = INDEXER || DEFAULT_INDEXER;
  // reset the transient areas
  $("cpOld").value = $("cpNew").value = $("cpNew2").value = "";
  $("cpErr").textContent = ""; $("cpOk").textContent = "";
  $("exPass").value = ""; $("exErr").textContent = "";
  $("exOut").hidden = true; $("exGrid").innerHTML = ""; $("exKeys").textContent = "";
  $("setMsg").textContent = "";
  renderLinked();
}
$("setAutoLock").onchange = () => {
  const s = loadSettings(); s.autoLockMin = Number($("setAutoLock").value) || 0; saveSettings(s);
  $("setMsg").textContent = s.autoLockMin ? `已设:闲置 ${s.autoLockMin} 分钟后自动锁定` : "已关闭自动锁定";
  startIdleTimer();
};
$("btnSaveIndexer").onclick = async () => {
  const url = $("setIndexer").value.trim();
  const s = loadSettings(); s.indexer = url; saveSettings(s);
  INDEXER = url || null; _provider = null; _providerUrl = null;
  await ensureIndexer();
  $("setIndexerCur").textContent = INDEXER || DEFAULT_INDEXER;
  $("setMsg").textContent = url ? "已保存自定义索引器" : "已恢复默认索引器";
  if (currentAccount()) { renderActivity(currentAccount()); refreshBalance(currentAccount()); }
};
// change passphrase
$("btnChangePass").onclick = async () => {
  $("cpErr").textContent = ""; $("cpOk").textContent = "";
  const oldp = $("cpOld").value, n1 = $("cpNew").value, n2 = $("cpNew2").value;
  if (n1.length < 8) return void ($("cpErr").textContent = "新口令至少 8 位");
  if (n1 !== n2) return void ($("cpErr").textContent = "两次新口令不一致");
  let blob;
  try { blob = JSON.parse(localStorage.getItem(VAULT_KEY)); } catch { blob = null; }
  if (!blob) return void ($("cpErr").textContent = "找不到保险箱");
  try { await decryptVault(blob, oldp); }
  catch { return void ($("cpErr").textContent = "当前口令不正确"); }
  try { await saveVault(n1); unlocked.pass = n1; }
  catch (e) { return void ($("cpErr").textContent = "保存失败: " + (e?.message || e)); }
  $("cpOld").value = $("cpNew").value = $("cpNew2").value = "";
  $("cpOk").textContent = "口令已更新 ✓";
};
// export the ACTIVE account's phrase + raw keys (passphrase-gated)
$("btnExport").onclick = async () => {
  $("exErr").textContent = "";
  let blob;
  try { blob = JSON.parse(localStorage.getItem(VAULT_KEY)); } catch { blob = null; }
  if (!blob) return;
  let obj;
  try { obj = await decryptVault(blob, $("exPass").value); }
  catch (e) { $("exErr").textContent = e?.message || "口令错误"; return; }
  const keys = Array.isArray(obj.keys) ? obj.keys : [{ id: activeId(), owner: obj.owner, view: obj.view }];
  const k = keys.find((x) => x.id === activeId()) || keys[0];
  renderWords("exGrid", keyMaterialToMnemonic({ owner: fromHex(k.owner), view: fromHex(k.view) }));
  $("exKeys").textContent = "owner: " + k.owner + "\nview:  " + k.view;
  $("exOut").hidden = false;
  $("exPass").value = "";
};
$("btnExportHide").onclick = () => { $("exOut").hidden = true; $("exGrid").innerHTML = ""; $("exKeys").textContent = ""; };

// --- auto-lock on idle -------------------------------------------------------------------------
let idleTimer = null;
function lockWallet() {
  unlocked = pending = null;
  stopIdleTimer();
  stopBridge(); // no signing while locked — queued dApp requests wait until the next unlock
  $("unlockPass").value = ""; $("unlockErr").textContent = "";
  show("pUnlock");
}
function startIdleTimer() {
  stopIdleTimer();
  const min = loadSettings().autoLockMin || 0;
  if (!min || !unlocked) return;
  idleTimer = setTimeout(lockWallet, min * 60_000);
}
function stopIdleTimer() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
function bumpIdle() { if (unlocked && (loadSettings().autoLockMin || 0)) startIdleTimer(); }
for (const ev of ["click", "keydown", "touchstart"]) document.addEventListener(ev, bumpIdle, { passive: true });

$("btnShowPhrase").onclick = () => { $("btnSettings").click(); };

// --- dApp connect: this wallet as a NON-CUSTODIAL signer for another-origin dApp -----------------
// The server (wallet-server.mjs) hosts a WalletConnect-style relay (src/dapp-bridge.mjs): a dApp on
// another origin loads tari-provider.js and can only ENQUEUE a request (POST /bridge/req); it can
// never sign. THIS page (same origin, holds the key) drains /bridge/poll, shows its own approval, and
// — unlike the classic custodial wallet, which signs via the backend /api/pay — signs IN THE BROWSER
// with the user's own key, then posts the answer to /bridge/resolve. So the dApp drives a non-custodial
// wallet: every call is approved + browser-signed here.
let HAS_BACKEND = false;       // the bridge + /api/status only exist when served by wallet-server
let linkedOrigin = null;       // the connected dApp site (lives on the server; survives a reload)
let bridgeTimer = null;
const inflight = new Set();

async function resolveReq(id, result, error) {
  try { await fetch("/bridge/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, result, error }) }); } catch { /* server gone */ }
  inflight.delete(id);
}
const isLinked = (origin) => !!linkedOrigin && origin === linkedOrigin;

// a reusable approval overlay; resolves true (approve) / false (reject)
function dappApprove({ title, origin, lines, approveLabel }) {
  return new Promise((resolve) => {
    $("dmTitle").textContent = title;
    $("dmOrigin").textContent = origin || "(未知来源)";
    $("dmBody").innerHTML = lines.map((l) => `<div class="dmline">${l}</div>`).join("");
    $("dmApprove").textContent = approveLabel || "批准";
    $("dappModal").hidden = false;
    const done = (v) => { $("dappModal").hidden = true; $("dmApprove").onclick = $("dmReject").onclick = null; resolve(v); };
    $("dmApprove").onclick = () => done(true);
    $("dmReject").onclick = () => done(false);
  });
}

async function handleReq(q) {
  const origin = q.origin || "(未知来源)";
  try {
    if (q.method === "tari_requestAccounts") {
      const account = currentAccount();
      if (!account) return resolveReq(q.id, null, "钱包尚无链上账户,请先在钱包里充值/创建账户");
      const ok = await dappApprove({ title: "连接请求", origin, approveLabel: "连接",
        lines: ["该网站请求连接你的自持钱包。", "连接后它将看到你的账户地址:", `<b class="mono">${esc(shortAddr(account))}</b>`] });
      if (!ok) return resolveReq(q.id, null, "用户拒绝连接 (4001)");
      await resolveReq(q.id, [account]);
      return refreshLinked(); // the server links the site on a successful connect
    }
    if (q.method === "tari_getAccount") {
      if (!isLinked(origin)) return resolveReq(q.id, null, "请先连接钱包 (4100)");
      const account = currentAccount();
      let balance = null;
      try { balance = (await balanceOf(await indexer(), account)).toString(); } catch { /* leave null */ }
      return resolveReq(q.id, { account, network: "localnet", balance });
    }
    // READ: hand a linked dApp (the dashboard) this account's budget so it shows + pays against THIS
    // wallet's chain-enforced budget. No signing, no approval modal. budget:null when none is open yet.
    if (q.method === "tari_getBudget" || q.method === "tari_getState") {
      if (!isLinked(origin)) return resolveReq(q.id, null, "请先连接钱包 (4100)");
      const account = currentAccount();
      const b = activeBudget();
      if (!b) return resolveReq(q.id, { account, network: "localnet", merchant: null, template: TEMPLATE, agentAccount: account, twoAccount: false, linkedOrigin, budget: null });
      try {
        await ensureIndexer();
        const wb = await readBudget(await indexer(), b.component);
        return resolveReq(q.id, {
          account, network: "localnet", merchant: b.merchant, template: b.template || TEMPLATE,
          agentAccount: account, twoAccount: false, linkedOrigin,
          budget: { address: wb.address, perTx: wb.perTx, daily: wb.daily, spent: wb.spent, vault: wb.vault, whitelist: wb.whitelist, funded: null, withdrawn: null, sessions: [], ledger: [] },
        });
      } catch (e) { return resolveReq(q.id, null, e?.message || String(e)); }
    }
    // WRITE: a budget payment the dashboard requested — the owner approves here, the browser signs with
    // the agent badge, and the chain enforces the per-tx/daily caps + whitelist.
    if (q.method === "tari_signAndSubmitTransaction" && q.params && q.params.pay) {
      if (!isLinked(origin)) return resolveReq(q.id, null, "请先连接钱包 (4100)");
      const account = currentAccount();
      const b = activeBudget();
      if (!account) return resolveReq(q.id, null, "钱包尚无链上账户");
      if (!b) return resolveReq(q.id, null, "钱包尚未开通预算(请先在钱包里开预算)");
      let amount;
      try { amount = BigInt(Math.trunc(Number(q.params.pay.amount))); } catch { return resolveReq(q.id, null, "金额无效"); }
      if (amount <= 0n) return resolveReq(q.id, null, "金额必须大于 0");
      const memo = q.params.pay.memo || "";
      const ok = await dappApprove({ title: "预算付款请求", origin, approveLabel: "确认付款",
        lines: [`从预算 <b class="mono">${esc(shortAddr(b.component))}</b>`, `向商户 <b class="mono">${esc(shortAddr(b.merchant))}</b>`, `支付 <b>${groupNum(amount.toString())} XTR</b>`, `<span class="mut" style="font-size:12px">链上强制额度;超限或非白名单将被拒。</span>`] });
      if (!ok) return resolveReq(q.id, null, "用户拒绝 (4001)");
      try {
        await ensureIndexer();
        const state = await readBudget(await indexer(), b.component); // fresh vault + badge ids
        const r = await payBudget(await indexer(), walletOf(), { account, budget: b.component, state, merchant: b.merchant, amount, memo });
        if (r.committed && currentAccount() === account) renderBudget();
        return resolveReq(q.id, { committed: !!r.committed, txid: r.txid || null, amount: amount.toString(), reason: r.reason || "" });
      } catch (e) { return resolveReq(q.id, null, e?.reason || e?.message || String(e)); }
    }
    if (q.method === "tari_sendTransaction" || (q.method === "tari_signAndSubmitTransaction" && q.params && q.params.transfer)) {
      if (!isLinked(origin)) return resolveReq(q.id, null, "请先连接钱包 (4100)");
      const p = (q.params && q.params.transfer) || q.params || {};
      const to = p.to, amtStr = String(p.amount);
      const from = currentAccount();
      if (!from) return resolveReq(q.id, null, "钱包尚无链上账户");
      if (!/^component_[0-9a-f]{64}$/.test(to || "")) return resolveReq(q.id, null, "收款地址无效(应为 component_ 开头的 64 位十六进制)");
      if (to === from) return resolveReq(q.id, null, "不能给自己转账");
      let amount;
      try { amount = BigInt(amtStr); } catch { return resolveReq(q.id, null, "金额无效"); }
      if (amount <= 0n) return resolveReq(q.id, null, "金额必须大于 0");
      const ok = await dappApprove({ title: "付款请求", origin, approveLabel: "确认付款",
        lines: [`向 <b class="mono">${esc(shortAddr(to))}</b>`, `发送 <b>${groupNum(amount.toString())} XTR</b>`, `<span class="mut" style="font-size:12px">从 ${esc(shortAddr(from))} 的自持余额支付(手续费另计)</span>`] });
      if (!ok) return resolveReq(q.id, null, "用户拒绝 (4001)");
      try {
        await ensureIndexer();
        const { txId } = await sendXtr(await indexer(), walletOf(), from, to, amount);
        logActivity({ kind: "send", account: from, to, amount: amount.toString(), txId });
        if (currentAccount() === from) { renderActivity(from); refreshBalance(from); }
        return resolveReq(q.id, { txId });
      } catch (e) { return resolveReq(q.id, null, e?.reason || e?.message || String(e)); }
    }
    return resolveReq(q.id, null, "不支持的方法 " + q.method);
  } catch (e) { return resolveReq(q.id, null, e?.message || String(e)); }
}

async function drainBridge() {
  if (!unlocked || !HAS_BACKEND) return; // signing needs the unlocked key
  let r;
  try { r = await fetch("/bridge/poll"); } catch { return; }
  if (!r.ok) return;
  const { reqs } = await r.json();
  for (const q of reqs) { if (inflight.has(q.id)) continue; inflight.add(q.id); handleReq(q); }
}
function startBridge() { if (bridgeTimer || !HAS_BACKEND) return; bridgeTimer = setInterval(drainBridge, 800); refreshLinked(); }
function stopBridge() { if (bridgeTimer) { clearInterval(bridgeTimer); bridgeTimer = null; } }
async function refreshLinked() {
  if (!HAS_BACKEND) return;
  try { const r = await fetch("/api/status"); if (r.ok) { linkedOrigin = (await r.json()).linkedOrigin || null; } } catch { /* ignore */ }
  renderLinked();
}
async function unlinkSite() {
  try { await fetch("/bridge/unlink", { method: "POST" }); } catch { /* ignore */ }
  linkedOrigin = null; renderLinked();
}
function renderLinked() {
  const box = $("linkedSite");
  if (!box) return;
  if (linkedOrigin) {
    box.innerHTML = `<div class="kv"><span class="mono" style="font-size:12px;word-break:break-all">${esc(linkedOrigin)}</span>`
      + `<button id="btnUnlinkSite" class="minibtn" title="断开">✕</button></div>`;
    $("btnUnlinkSite").onclick = unlinkSite;
  } else {
    box.innerHTML = '<div class="mut" style="font-size:12px">暂无已连接的网站。</div>';
  }
}

// boot
void TOTAL_WORDS; // 48 (owner 24 ‖ view 24)
fetch("/api/status").then((r) => r.ok ? r.json() : null).then((s) => {
  if (!s) return;
  HAS_BACKEND = true; // the bridge + dev-key import are available
  $("btnImportDev").hidden = false;
  if (!loadSettings().indexer) INDEXER = s.indexer || DEFAULT_INDEXER;
  TEMPLATE = s.template || TEMPLATE;          // AgentBudget template, for opening a budget
  DEFAULT_MERCHANT = s.merchant || DEFAULT_MERCHANT; // a sample merchant to prefill
  if (unlocked) { startBridge(); if ($("pMain") && !$("pMain").hidden) renderBudget(); }
}).catch(() => {});
routeStart();
