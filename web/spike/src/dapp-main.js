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
const RE_COMPONENT = /^component_[0-9a-f]{64}$/;

const wallet = createInPageWallet();
let pendingMaterial = null; // the generated/restored key material awaiting a passphrase

// --- approval modal: resolve a boolean the in-page provider awaits before signing ---------------
let _resolveApprove = null;
function approve(spec) {
  $("apw2-mtitle").textContent = spec.title || "请求批准";
  $("apw2-morigin").textContent = spec.origin || location.origin;
  $("apw2-mapprove").textContent = spec.approveLabel || "批准";
  $("apw2-mbody").innerHTML = (spec.lines || []).map((l) => `<div class="line">${l}</div>`).join("");
  $("apw2-modal").hidden = false;
  return new Promise((resolve) => { _resolveApprove = resolve; });
}
function settleApprove(ok) { $("apw2-modal").hidden = true; const r = _resolveApprove; _resolveApprove = null; if (r) r(ok); }
$("apw2-mapprove").onclick = () => settleApprove(true);
$("apw2-mreject").onclick = () => settleApprove(false);

// --- install the same-origin window.tari (connected=false until the user connects in the drawer) ---
const provider = installInPageTari(wallet.providerHost({ approve, onChange: () => { renderMain(); } }));

// --- panel open/close ---------------------------------------------------------------------------
let panelOpen = false;
function setPanel(open) { panelOpen = open; $("apw2").hidden = !open; $("apw2-fab").classList.toggle("on", wallet.isUnlocked()); }
$("apw2-fab").onclick = () => setPanel(!panelOpen);
$("apw2-close").onclick = () => setPanel(false);

// --- view routing -------------------------------------------------------------------------------
const SECTIONS = ["w-onboard", "w-create", "w-restore", "w-unlock", "w-main"];
function show(id) { for (const s of SECTIONS) $(s).hidden = s !== id; $("apw2-fab").classList.toggle("on", id === "w-main"); }
function route() { show(wallet.hasVault() ? "w-unlock" : "w-onboard"); }

// --- onboard: create ----------------------------------------------------------------------------
$("w-btnCreate").onclick = async () => {
  const g = wallet.generate();
  pendingMaterial = g.material;
  $("w-words").innerHTML = g.mnemonic.split(/\s+/).map((w, i) => `<div class="w"><b>${i + 1}</b>${w}</div>`).join("");
  $("w-createAddr").textContent = "派生中…";
  $("w-newPass1").value = $("w-newPass2").value = ""; $("w-createErr").textContent = "";
  show("w-create");
  try { $("w-createAddr").textContent = await g.address(); } catch (e) { $("w-createAddr").textContent = "地址派生失败: " + (e?.message || e); }
};
$("w-btnCreateDo").onclick = async () => {
  const p1 = $("w-newPass1").value, p2 = $("w-newPass2").value;
  if (p1.length < 8) return void ($("w-createErr").textContent = "口令至少 8 位");
  if (p1 !== p2) return void ($("w-createErr").textContent = "两次输入不一致");
  try { await wallet.createFirst({ material: pendingMaterial, passphrase: p1 }); }
  catch (e) { return void ($("w-createErr").textContent = "保存失败: " + (e?.message || e)); }
  pendingMaterial = null;
  await enterMain();
};

// --- onboard: restore ---------------------------------------------------------------------------
$("w-btnRestore").onclick = () => { $("w-restoreWords").value = ""; $("w-rPass1").value = $("w-rPass2").value = ""; $("w-restoreErr").textContent = ""; show("w-restore"); };
$("w-btnRestoreBack").onclick = () => route();
$("w-btnRestoreDo").onclick = async () => {
  $("w-restoreErr").textContent = "";
  let r;
  try { r = wallet.fromMnemonic($("w-restoreWords").value); } catch (e) { return void ($("w-restoreErr").textContent = e?.message || String(e)); }
  const p1 = $("w-rPass1").value, p2 = $("w-rPass2").value;
  if (p1.length < 8) return void ($("w-restoreErr").textContent = "口令至少 8 位");
  if (p1 !== p2) return void ($("w-restoreErr").textContent = "两次输入不一致");
  try { await wallet.createFirst({ material: r.material, passphrase: p1 }); }
  catch (e) { return void ($("w-restoreErr").textContent = "保存失败: " + (e?.message || e)); }
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
  if (!confirm("清除本机的钱包数据?若无助记词备份将无法找回。")) return;
  wallet.forget(); provider._notifyLocked(); route();
};
$("w-btnLock").onclick = () => { wallet.lock(); provider._notifyLocked(); route(); };

// --- main (unlocked) ----------------------------------------------------------------------------
async function enterMain() {
  show("w-main");
  await renderMain();
}
let _balToken = 0;
async function renderMain() {
  const account = wallet.account();
  $("w-acct").textContent = account ? shortAddr(account) : "未充值 · 链上尚无账户";
  const funded = !!account;
  $("w-btnOpenBudget").disabled = !funded;
  $("w-btnConnect").disabled = !funded;
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
    $("w-bMerch").textContent = shortAddr(bud.merchant);
    try {
      const st = await wallet.refreshBudget();
      if (st) { $("w-bCaps").textContent = `${groupNum(st.perTx)} / ${groupNum(st.daily)}`; $("w-bSpent").textContent = groupNum(st.spent); }
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
  const fund = $("w-bFund").value.trim(), perTx = $("w-bPerTx").value.trim(), daily = $("w-bDaily").value.trim(), merchant = $("w-bMerchant").value.trim();
  if (![fund, perTx, daily].every((v) => /^\d+$/.test(v))) return void ($("w-budErr").textContent = "注资/额度需为整数");
  if (!RE_COMPONENT.test(merchant)) return void ($("w-budErr").textContent = "商户地址应为 component_ 开头的 64 位十六进制");
  const btn = $("w-btnOpenBudget"); btn.disabled = true; const lab = btn.textContent; btn.textContent = "开预算中…";
  try {
    await wallet.openBudget({ template: await templateAddr(), merchant, fund: Number(fund), perTxCap: Number(perTx), dailyCap: Number(daily), epochsPerWindow: 10 });
    await renderMain();
  } catch (e) { $("w-budErr").textContent = "开预算失败: " + (e?.message || e); }
  finally { btn.disabled = false; btn.textContent = lab; }
};
// the AgentBudget template for this localnet — from the wallet backend's /api/status, else the live default
let _template = null;
async function templateAddr() {
  if (_template) return _template;
  try { const r = await fetch("/api/status"); if (r.ok) _template = (await r.json()).template || null; } catch { /* fall through */ }
  return (_template = _template || "template_c4b58558181f19c17d6ccc75c93e0707e2c5b75d1ef4de96a70acd0fd2d40e47");
}

$("w-btnConnect").onclick = async () => {
  const btn = $("w-btnConnect"); btn.disabled = true; const lab = btn.textContent; btn.textContent = "连接中…";
  try { await provider.connect(); btn.textContent = "已连接到仪表盘"; $("w-connNote").textContent = "仪表盘已连接本钱包。付款从你的预算支出、由你在此批准、浏览器签名。"; }
  catch (e) { btn.disabled = false; btn.textContent = lab; $("w-connNote").textContent = "连接失败: " + (e?.message || e); }
};

// --- boot: show the wallet, then start the dashboard (provider already installed) ----------------
$("apw2-fab").hidden = false;
route();
setPanel(true); // open the drawer so first-run onboarding is visible
// the dashboard is a classic app that boots on load; import it last so window.tari is already present.
// __AP_WALLET_ONLY tells app.js there is no backend on this origin: skip every /api read and be driven
// entirely by the in-page wallet + the chain (Phase 3 — this is what lets the :7777 /api proxy go away).
window.__AP_WALLET_ONLY = true;
import("../../public/app.js").catch((e) => console.error("[dapp] dashboard failed to load:", e));
