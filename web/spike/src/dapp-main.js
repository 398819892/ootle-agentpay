// dapp-main.js — the entry that fuses the AgentPay dashboard and the in-page self-custody wallet into one
// same-origin page. It drives the #apw2 wallet drawer (agentpay.html) through src/inpage-wallet.mjs, installs a
// same-origin window.tari backed by that browser-held key (src/sc-provider.mjs), then boots the dashboard
// (../public/app.js) last so the provider is already present. No relay, no second window, no server key:
// the dashboard's window.tari calls are approved in the drawer and signed in this page.
import "../../public/styles.css";
import { createInPageWallet } from "./inpage-wallet.mjs";
import { installInPageTari } from "./sc-provider.mjs";

const $ = (id) => document.getElementById(id);
const groupNum = (s) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const shortAddr = (a) => (a && a.length > 22 ? a.slice(0, 12) + "…" + a.slice(-6) : a || "");

const wallet = createInPageWallet();
let pendingMaterial = null; // the generated/restored key material awaiting a passphrase

// --- approval modal: resolve a boolean the in-page provider awaits before signing ---------------
// The provider hands us the DECODED intent as structured rows (+ an optional self-check verdict and note).
// We render every request-supplied value with textContent — NEVER innerHTML — so a value from the dApp
// (a memo, a session name) can't inject markup into the one surface the user trusts to sign. This is the
// "no blind-signing" surface: the user sees exactly what will be signed, in plain language, before approving.
let _resolveApprove = null;
function approve(spec) {
  $("apw2-mtitle").textContent = spec.title || "请求批准";
  $("apw2-morigin").textContent = spec.origin || location.origin;
  $("apw2-mapprove").textContent = spec.approveLabel || "批准";
  const body = $("apw2-mbody");
  body.textContent = "";
  for (const r of (spec.rows || [])) {
    const row = document.createElement("div"); row.className = "arow";
    const k = document.createElement("span"); k.className = "ak"; k.textContent = r.label;
    const v = document.createElement("span"); v.className = "av" + (r.mono ? " mono" : ""); v.textContent = r.value;
    row.append(k, v); body.append(row);
  }
  if (spec.check) {
    const c = document.createElement("div"); c.className = "achk " + (spec.check.ok ? "good" : "bad2");
    c.textContent = spec.check.text; body.append(c);
  }
  if (spec.note) {
    const n = document.createElement("div"); n.className = "anote"; n.textContent = spec.note; body.append(n);
  }
  $("apw2-modal").hidden = false;
  kickIdle(); // approving is activity — don't auto-lock out from under a prompt
  return new Promise((resolve) => { _resolveApprove = resolve; });
}
function settleApprove(ok) { $("apw2-modal").hidden = true; const r = _resolveApprove; _resolveApprove = null; kickIdle(); if (r) r(ok); }
$("apw2-mapprove").onclick = () => settleApprove(true);
$("apw2-mreject").onclick = () => settleApprove(false);

// --- install the same-origin window.tari (connected=false until the user connects in the drawer) ---
const provider = installInPageTari(wallet.providerHost({ approve, onChange: () => { renderMain(); } }));

// --- view routing -------------------------------------------------------------------------------
// The wallet is no longer a floating drawer — it's a first-class dashboard nav view ("钱包"). app.js owns the
// sidebar entry and moves this #apw2 element into the view's mount on render (see app.js render()); here we
// only drive which inner section (onboard/unlock/main) shows.
const SECTIONS = ["w-onboard", "w-create", "w-restore", "w-unlock", "w-main"];
function show(id) { for (const s of SECTIONS) $(s).hidden = s !== id; }
// Outermost gate: whenever the wallet isn't unlocked (no vault → onboard, has vault → unlock), the wallet
// screen is the whole page and the dashboard is hidden (see agentpay.html body[data-ap-gate]). enterMain()
// flips it open once the key is unlocked. Every lock/forget/auto-lock path calls route(), so the gate closes
// again whenever the key leaves memory.
function gate(open) { if (typeof document !== "undefined") document.body.dataset.apGate = open ? "open" : "locked"; }
function route() { gate(false); show(wallet.hasVault() ? "w-unlock" : "w-onboard"); }

// --- onboard: create (generate → SHOW words → VERIFY a few back → encrypt & save) ----------------
// Mainnet red line: the recovery phrase is the only way back, so we don't let the user leave the create
// screen until they've proven they wrote it down — a backup-confirmation challenge (re-enter 3 words by
// position) stands between seeing the phrase and the wallet becoming usable.
let createStage = "backup";   // "backup" (showing the phrase) → "verify" (re-enter words)
let mnemonicWords = [];
let verifyPositions = [];
function renderWords(container, words) {
  container.textContent = "";
  words.forEach((w, i) => {
    const d = document.createElement("div"); d.className = "w";
    const b = document.createElement("b"); b.textContent = String(i + 1);
    d.append(b, document.createTextNode(w)); container.append(d);
  });
}
function pickPositions(n, k) {
  const pool = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, k).sort((a, b) => a - b);
}
function buildVerifyFields(positions) {
  const host = $("w-verifyFields"); host.textContent = "";
  for (const pos of positions) {
    const lab = document.createElement("label"); lab.textContent = `第 ${pos} 个词`;
    const inp = document.createElement("input"); inp.type = "text"; inp.autocapitalize = "none"; inp.autocomplete = "off"; inp.spellcheck = false; inp.dataset.pos = String(pos);
    host.append(lab, inp);
  }
}
$("w-btnCreate").onclick = async () => {
  const g = wallet.generate();
  pendingMaterial = g.material;
  mnemonicWords = g.mnemonic.split(/\s+/);
  renderWords($("w-words"), mnemonicWords);
  createStage = "backup";
  $("w-words").hidden = false; $("w-createPass").hidden = false; $("w-verify").hidden = true;
  $("w-btnCreateDo").textContent = "我已离线备份,继续";
  $("w-createAddr").textContent = "派生中…";
  $("w-newPass1").value = $("w-newPass2").value = ""; $("w-createErr").textContent = "";
  show("w-create");
  try { $("w-createAddr").textContent = await g.address(); } catch (e) { $("w-createAddr").textContent = "地址派生失败: " + (e?.message || e); }
};
$("w-btnCreateDo").onclick = async () => {
  $("w-createErr").textContent = "";
  const p1 = $("w-newPass1").value, p2 = $("w-newPass2").value;
  if (p1.length < 8) return void ($("w-createErr").textContent = "口令至少 8 位");
  if (p1 !== p2) return void ($("w-createErr").textContent = "两次输入不一致");
  if (createStage === "backup") {
    verifyPositions = pickPositions(mnemonicWords.length, 3);
    buildVerifyFields(verifyPositions);
    $("w-words").hidden = true; $("w-createPass").hidden = true; $("w-verify").hidden = false;
    $("w-btnCreateDo").textContent = "验证备份并保存";
    createStage = "verify";
    return;
  }
  // verify stage: the 3 re-entered words must match the generated phrase
  const inputs = [...$("w-verifyFields").querySelectorAll("input")];
  const ok = inputs.length === verifyPositions.length &&
    inputs.every((inp) => (inp.value || "").trim().toLowerCase() === mnemonicWords[Number(inp.dataset.pos) - 1]);
  if (!ok) return void ($("w-createErr").textContent = "备份词不匹配,请对照你抄写的助记词再试。");
  try { await wallet.createFirst({ material: pendingMaterial, passphrase: p1 }); }
  catch (e) { return void ($("w-createErr").textContent = "保存失败: " + (e?.message || e)); }
  pendingMaterial = null; mnemonicWords = [];
  await enterMain();
};

// --- onboard: restore (validate phrase → SHOW derived address to confirm → encrypt & save) --------
let restoreMaterial = null;
function resetRestore() {
  restoreMaterial = null;
  $("w-restoreWords").value = ""; $("w-rPass1").value = $("w-rPass2").value = ""; $("w-restoreErr").textContent = "";
  $("w-restoreAddrWrap").hidden = true; $("w-restoreAddr").textContent = "";
  $("w-btnRestoreDo").textContent = "恢复";
}
$("w-btnRestore").onclick = () => { resetRestore(); show("w-restore"); };
$("w-btnRestoreBack").onclick = () => { resetRestore(); route(); };
// typing a new phrase invalidates a previously-derived address (so the shown address always matches input)
$("w-restoreWords").addEventListener("input", () => { if (restoreMaterial) { restoreMaterial = null; $("w-restoreAddrWrap").hidden = true; $("w-btnRestoreDo").textContent = "恢复"; } });
$("w-btnRestoreDo").onclick = async () => {
  $("w-restoreErr").textContent = "";
  const p1 = $("w-rPass1").value, p2 = $("w-rPass2").value;
  if (p1.length < 8) return void ($("w-restoreErr").textContent = "口令至少 8 位");
  if (p1 !== p2) return void ($("w-restoreErr").textContent = "两次输入不一致");
  // First press: validate the phrase and SHOW the account address it derives to, so the user confirms this
  // is the wallet they meant before anything is persisted. Second press: encrypt & save.
  if (!restoreMaterial) {
    let r;
    try { r = wallet.fromMnemonic($("w-restoreWords").value); } catch (e) { return void ($("w-restoreErr").textContent = e?.message || String(e)); }
    restoreMaterial = r.material;
    $("w-restoreAddr").textContent = "派生中…"; $("w-restoreAddrWrap").hidden = false;
    $("w-btnRestoreDo").textContent = "地址无误,恢复";
    try { $("w-restoreAddr").textContent = await r.address(); }
    catch (e) { $("w-restoreAddr").textContent = "地址派生失败: " + (e?.message || e); }
    return;
  }
  try { await wallet.createFirst({ material: restoreMaterial, passphrase: p1 }); }
  catch (e) { return void ($("w-restoreErr").textContent = "保存失败: " + (e?.message || e)); }
  restoreMaterial = null;
  await enterMain();
};

// --- unlock -------------------------------------------------------------------------------------
$("w-btnUnlock").onclick = async () => {
  $("w-unlockErr").textContent = "";
  try { await wallet.unlock($("w-unlockPass").value); }
  catch (e) { return void ($("w-unlockErr").textContent = e?.message || "口令错误"); }
  $("w-unlockPass").value = "";
  await enterMain();
};
$("w-btnForget").onclick = () => {
  if (!confirm("清除本机的 AgentWallet 数据?若无助记词备份将无法找回。")) return;
  wallet.forget(); provider._notifyLocked(); kickIdle(); route();
};
$("w-btnLock").onclick = () => { wallet.lock(); provider._notifyLocked(); kickIdle(); route(); };

// --- auto-lock on idle (mainnet red line: an unlocked key shouldn't sit live on a walked-away tab) ------
// settings().autoLockMin (0 = off) is persisted in the wallet controller; off localnet we default it to 15
// so a real-network wallet is never left unlocked indefinitely. Any pointer/key activity (and an approval
// prompt) resets the timer; firing it locks the wallet, drops any linked dApp, and shows the unlock screen.
let _idleTimer = null;
function autoLockMin() { try { return Number(wallet.settings().autoLockMin) || 0; } catch { return 0; } }
function kickIdle() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const min = autoLockMin();
  if (min > 0 && wallet.isUnlocked()) {
    _idleTimer = setTimeout(() => {
      _idleTimer = null;
      wallet.lock(); provider._notifyLocked();
      route();
      const e = $("w-unlockErr"); if (e) e.textContent = "已因闲置自动锁定,请重新解锁。";
    }, min * 60 * 1000);
  }
}
for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, () => { if (wallet.isUnlocked()) kickIdle(); }, { passive: true });

// --- wallet-server config (the wallet's OWN /api/status: network/indexer/template) — NOT the custodial
// dashboard backend. Used only to learn the network so real-network dev crutches (faucet, the localnet
// default template) stay off mainnet. Fetched lazily on unlock, so the anonymous boot still makes zero /api.
let _status = null, _netNonLocal = false;
const LOCALNET_TEMPLATE = "template_c4b58558181f19c17d6ccc75c93e0707e2c5b75d1ef4de96a70acd0fd2d40e47";
async function loadStatus() {
  if (_status) return _status;
  try { const r = await fetch("/api/status"); if (r.ok) _status = await r.json(); } catch { /* standalone/offline */ }
  _status = _status || {};
  const net = _status.network || "localnet";
  _netNonLocal = net !== "localnet";
  const sub = $("apw2-sub"); if (sub) sub.textContent = `浏览器持钥 · 同源 · Ootle ${net}`;
  if (_netNonLocal) { const f = $("w-btnFund"); if (f) f.hidden = true; } // no dev faucet off localnet
  return _status;
}

// --- main (unlocked) ----------------------------------------------------------------------------
function initAutoLockUI() {
  const sel = $("w-autolock"); if (!sel) return;
  let v = autoLockMin();
  if (!v && _netNonLocal) { v = 15; wallet.saveSettings({ autoLockMin: 15 }); } // safe default on real networks
  sel.value = String(v);
  sel.onchange = () => { wallet.saveSettings({ autoLockMin: Number(sel.value) || 0 }); kickIdle(); };
}
async function enterMain() {
  gate(true);
  show("w-main");
  await loadStatus();
  initAutoLockUI();
  kickIdle();
  await renderMain();
}
let _balToken = 0;
async function renderMain() {
  const account = wallet.account();
  $("w-acct").textContent = account ? shortAddr(account) : "未充值 · 链上尚无账户";
  const funded = !!account;
  $("w-btnOpenBudget").disabled = !funded;
  // Auto-connect: the moment the wallet is unlocked and has an account, link the in-page dashboard to it
  // silently (same origin, no approval modal) so there's no separate "connect" step — the unlocked key IS
  // the session. Idempotent; stays manual only if there's no account yet (unfunded). Payments still approved.
  if (funded) { try { provider._autoConnect(); } catch { /* fall back to the manual button */ } }
  const linked = !!provider.connected;
  $("w-btnConnect").disabled = !funded || linked;
  $("w-btnConnect").textContent = linked ? "已连接到仪表盘" : "连接到仪表盘";
  if (linked) $("w-connNote").textContent = "仪表盘已自动连接本 AgentWallet。付款从你的预算支出、由你在此批准、浏览器签名。";
  // balance (chain read; tolerate failure)
  if (funded) {
    const tok = ++_balToken;
    $("w-bal").textContent = "…";
    try { const b = await wallet.balance(); if (tok === _balToken) $("w-bal").textContent = groupNum(b.toString()); }
    catch { if (tok === _balToken) $("w-bal").textContent = "—"; }
  } else { $("w-bal").textContent = "—"; }
  // budget
  const bud = wallet.budget();
  $("w-budNone").hidden = !!bud;
  $("w-budHas").hidden = !bud;
  if (bud) {
    $("w-bComp").textContent = shortAddr(bud.component);
    try {
      const st = await wallet.refreshBudget();
      if (st) {
        $("w-bCaps").textContent = `${groupNum(st.perTx)} / ${groupNum(st.daily)}`;
        $("w-bSpent").textContent = groupNum(st.spent);
        // merchant whitelist is managed in 管理 › 商户白名单 — show how many are currently authorized
        const n = Array.isArray(st.whitelist) ? st.whitelist.length : 0;
        $("w-bMerch").textContent = n ? `${n} 个(在「管理」里增删)` : "空 · 在「管理」里添加";
      }
    } catch { /* leave dashes */ }
  }
}

$("w-btnFund").onclick = async () => {
  const btn = $("w-btnFund"); btn.disabled = true; const lab = btn.textContent; btn.textContent = "充值中…"; $("w-mainErr").textContent = "";
  try { await wallet.fund(); await renderMain(); }
  catch (e) { $("w-mainErr").textContent = "充值失败: " + (e?.message || e); }
  finally { btn.disabled = false; btn.textContent = lab; }
};
$("w-btnRefresh").onclick = () => renderMain();

$("w-btnOpenBudget").onclick = async () => {
  $("w-budErr").textContent = "";
  // Opening a budget delegates spending authority to the agent and sets the caps; the merchant whitelist
  // starts EMPTY (AgentPay manages merchants afterwards — add/remove them in 管理 › 商户白名单). So the
  // only required inputs here are the amounts; no merchant is bound at open.
  const fund = $("w-bFund").value.trim(), perTx = $("w-bPerTx").value.trim(), daily = $("w-bDaily").value.trim();
  if (![fund, perTx, daily].every((v) => /^\d+$/.test(v))) return void ($("w-budErr").textContent = "注资/额度需为整数");
  const btn = $("w-btnOpenBudget"); btn.disabled = true; const lab = btn.textContent; btn.textContent = "开预算中…";
  try {
    await wallet.openBudget({ template: await templateAddr(), fund: Number(fund), perTxCap: Number(perTx), dailyCap: Number(daily), epochsPerWindow: 10 });
    await renderMain();
  } catch (e) { $("w-budErr").textContent = "开预算失败: " + (e?.message || e); }
  finally { btn.disabled = false; btn.textContent = lab; }
};
// The AgentBudget template address — from the wallet's own /api/status. On a real network we DON'T fall
// back to the localnet dev default (opening a budget against the wrong template would be a silent footgun);
// the user must have a network-configured template. The localnet default is a dev convenience only.
async function templateAddr() {
  const s = await loadStatus();
  if (s && s.template) return s.template;
  if (_netNonLocal) throw new Error("本网络未配置 AgentBudget 模板地址(真网络不使用本地默认模板)。");
  return LOCALNET_TEMPLATE;
}

$("w-btnConnect").onclick = async () => {
  const btn = $("w-btnConnect"); btn.disabled = true; const lab = btn.textContent; btn.textContent = "连接中…";
  try { await provider.connect(); btn.textContent = "已连接到仪表盘"; $("w-connNote").textContent = "仪表盘已连接本 AgentWallet。付款从你的预算支出、由你在此批准、浏览器签名。"; }
  catch (e) { btn.disabled = false; btn.textContent = lab; $("w-connNote").textContent = "连接失败: " + (e?.message || e); }
};

// --- boot: set the wallet's initial section, then start the dashboard (provider already installed) ----
// No auto-popup: the page lands on the dashboard's default view; the wallet is reached via its "钱包" nav
// entry. route() just picks onboard-vs-unlock so the section is correct whenever the user opens that view.
route();
// the dashboard is a classic app that boots on load; import it last so window.tari is already present.
// __AP_WALLET_ONLY tells app.js there is no backend on this origin: skip every /api read and be driven
// entirely by the in-page wallet + the chain (Phase 3 — this is what lets the :7777 /api proxy go away).
window.__AP_WALLET_ONLY = true;
import("../../public/app.js").catch((e) => console.error("[dapp] dashboard failed to load:", e));
