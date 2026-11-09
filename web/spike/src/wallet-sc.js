// wallet-sc.js — onboarding controller for the self-custody wallet.
//
// Wires src/self-custody.mjs (pure: keygen, mnemonic, encrypted vault) to the ootle WASM for the one
// thing the module deliberately leaves out — deriving the account address from the secret. Everything
// here runs in the browser: the secret is generated, shown-for-backup, encrypted and stored locally,
// and never sent anywhere.
import {
  generateKeyMaterial, keyMaterialToMnemonic, mnemonicToKeyMaterial,
  encryptVault, decryptVault, toHex, fromHex, TOTAL_WORDS,
} from "./self-custody.mjs";
import { Network } from "@tari-project/ootle";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { connect as scConnect, fundViaFaucet, balanceOf, sendXtr, ownerPublicHex } from "./sc-chain.mjs";

const $ = (id) => document.getElementById(id);
const VAULT_KEY = "ap-sc-vault";
const ACCOUNT_KEY = "ap-sc-account"; // the on-chain account component (public; stored in the clear)
const ACTIVITY_KEY = "ap-sc-activity"; // this wallet's own fund/send actions, recorded locally per account
const NETWORK = Network.LocalNet; // identity address is net-scoped; localnet for now (prefix otl_loc_)

let INDEXER = null; // indexer URL, learned from the backend's /api/status; enables on-chain ops
let _provider = null;
async function ensureIndexer() {
  if (INDEXER) return INDEXER;
  try { const r = await fetch("/api/status"); if (r.ok) { const s = await r.json(); INDEXER = s.indexer || "http://127.0.0.1:12008"; } } catch { /* standalone, no backend */ }
  return INDEXER;
}
async function indexer() { return (_provider ??= await scConnect(INDEXER)); }
// the live on-chain account: imported (in the vault) or one we funded (public, in localStorage)
const currentAccount = () => (unlocked && unlocked.account) || localStorage.getItem(ACCOUNT_KEY) || null;
const walletOf = () => SecretKeyWallet.fromSecretKey(fromHex(unlocked.owner), NETWORK, fromHex(unlocked.view));

const PANELS = ["pOnboard", "pCreate", "pRestore", "pSetPass", "pUnlock", "pMain"];
function show(panel) {
  for (const p of PANELS) $(p).hidden = p !== panel;
}

// in-memory, cleared on lock
let pending = null; // { owner: Uint8Array, view: Uint8Array } awaiting a passphrase
let unlocked = null; // { owner, view } the live key

const addressOf = (owner, view) =>
  SecretKeyWallet.fromSecretKey(owner, NETWORK, view).getAddress();

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

// --- create ------------------------------------------------------------------------------------
$("btnCreate").onclick = async () => {
  pending = generateKeyMaterial();
  renderWords("wordGrid", keyMaterialToMnemonic(pending));
  $("createAddr").textContent = "派生中…";
  show("pCreate");
  try { $("createAddr").textContent = await addressOf(pending.owner, pending.view); }
  catch (e) { $("createAddr").textContent = "地址派生失败: " + (e?.message || e); }
};
$("btnReveal").onclick = () => { $("setPassErr").textContent = ""; $("pass1").value = $("pass2").value = ""; show("pSetPass"); };

// --- import an existing account (localnet dev continuity) ---------------------------------------
// Pulls the dev account's key from the wallet backend (localnet only) INTO the browser, so the
// existing funded account keeps showing but the key is now browser-held and encrypted here.
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
  pending = { owner: fromHex(k.owner), view: fromHex(k.view), account: k.account || null };
  $("pass1").value = $("pass2").value = "";
  $("setPassErr").textContent = "";
  show("pSetPass");
};

// --- restore -----------------------------------------------------------------------------------
$("btnRestoreStart").onclick = () => { $("restoreErr").textContent = ""; $("restoreWords").value = ""; show("pRestore"); };
$("btnRestoreBack").onclick = routeStart;
$("btnRestoreVerify").onclick = async () => {
  $("restoreErr").textContent = "";
  try {
    pending = mnemonicToKeyMaterial($("restoreWords").value);
  } catch (e) {
    $("restoreErr").textContent = e?.message || String(e);
    return;
  }
  $("pass1").value = $("pass2").value = "";
  $("setPassErr").textContent = "";
  show("pSetPass");
};

// --- set passphrase -> encrypt + store (shared by create & restore) ----------------------------
$("btnEncrypt").onclick = async () => {
  const p1 = $("pass1").value, p2 = $("pass2").value;
  if (p1.length < 8) return void ($("setPassErr").textContent = "口令至少 8 位");
  if (p1 !== p2) return void ($("setPassErr").textContent = "两次输入不一致");
  if (!pending) return void ($("setPassErr").textContent = "没有待保存的密钥,请重试");
  const secret = { owner: toHex(pending.owner), view: toHex(pending.view) };
  if (pending.account) secret.account = pending.account;
  const blob = await encryptVault(secret, p1);
  try { localStorage.setItem(VAULT_KEY, JSON.stringify(blob)); }
  catch (e) { return void ($("setPassErr").textContent = "保存失败: " + (e?.message || e)); }
  unlocked = secret;
  pending = null;
  $("pass1").value = $("pass2").value = "";
  await enterMain();
};

// --- unlock ------------------------------------------------------------------------------------
$("btnUnlock").onclick = async () => {
  $("unlockErr").textContent = "";
  let blob;
  try { blob = JSON.parse(localStorage.getItem(VAULT_KEY)); } catch { blob = null; }
  if (!blob) return routeStart();
  try {
    unlocked = await decryptVault(blob, $("unlockPass").value);
  } catch (e) {
    $("unlockErr").textContent = e?.message || "口令错误";
    return;
  }
  $("unlockPass").value = "";
  await enterMain();
};
$("btnForget").onclick = () => {
  if (!confirm("清除本机的钱包数据?若没有助记词备份将无法找回。")) return;
  localStorage.removeItem(VAULT_KEY);
  localStorage.removeItem(ACCOUNT_KEY);
  unlocked = pending = null;
  routeStart();
};

// --- main (unlocked) ---------------------------------------------------------------------------
const groupNum = (s) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

async function enterMain() {
  show("pMain");
  $("phraseReveal").hidden = true;
  $("revealGrid").hidden = true;
  $("btnHidePhrase").hidden = true;
  $("revealPass").value = "";
  $("revealErr").textContent = "";
  $("fundErr").textContent = "";
  await ensureIndexer();
  const account = currentAccount();
  // reset the send + receive forms each time we (re-)enter the main view
  $("sendForm").hidden = true;
  $("sendErr").textContent = "";
  $("sendOk").textContent = "";
  $("recvView").hidden = true;
  if (account) {
    // an on-chain account (imported / funded): show the component address + live balance
    $("addrLabel").textContent = "账户";
    $("mainAddr").textContent = account;
    $("fundBlock").hidden = true;
    $("balBlock").hidden = false;
    $("recvBlock").hidden = false; // an on-chain account can receive
    $("sendBlock").hidden = !INDEXER; // sending needs the indexer to resolve inputs + submit
    $("actBlock").hidden = false;
    renderActivity(account);
    await refreshBalance(account);
  } else {
    // a fresh self-custody key with no on-chain account yet: show the derived key address, offer funding
    $("addrLabel").textContent = "密钥地址(未充值,链上尚无账户)";
    $("balBlock").hidden = true;
    $("recvBlock").hidden = true; // nothing to receive into until an account exists
    $("sendBlock").hidden = true; // nothing to send until an account exists
    $("actBlock").hidden = true;
    $("mainAddr").textContent = "派生中…";
    try { $("mainAddr").textContent = await addressOf(fromHex(unlocked.owner), fromHex(unlocked.view)); }
    catch (e) { $("mainAddr").textContent = "地址派生失败: " + (e?.message || e); }
    $("btnFund").disabled = false;
    $("btnFund").textContent = "创建账户并领取测试币(localnet)";
    $("fundBlock").hidden = !INDEXER; // funding needs the localnet indexer/faucet
  }
}

// --- activity: this wallet's OWN fund/send actions, recorded locally (keyed by account) -----------
// Honest scope: these are the actions THIS wallet took (the txIds it produced), not a full chain
// history — incoming receives from others are not here (that would need a chain scan). Local only.
function loadActivity() {
  try { return JSON.parse(localStorage.getItem(ACTIVITY_KEY)) || []; } catch { return []; }
}
function logActivity(entry) {
  const all = loadActivity();
  all.unshift({ t: Date.now(), ...entry });
  try { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(all.slice(0, 50))); } catch { /* storage full/blocked: skip */ }
}
function ago(t) {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + " 秒前";
  const m = Math.floor(s / 60); if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60); if (h < 24) return h + " 小时前";
  return Math.floor(h / 24) + " 天前";
}
function renderActivity(account) {
  const list = loadActivity().filter((e) => e.account === account);
  const box = $("actList");
  if (!list.length) { box.innerHTML = '<p class="mut" style="font-size:12px">暂无记录。</p>'; return; }
  box.innerHTML = list.map((e) => {
    const tx = e.txId ? String(e.txId).slice(0, 10) + "…" : "";
    const when = ago(e.t);
    if (e.kind === "send") {
      const to = e.to ? e.to.slice(0, 14) + "…" : "";
      return `<div class="act"><div><div class="k">发送</div><div class="m">→ ${to} · ${tx}</div></div>`
        + `<div style="text-align:right"><div class="amt">−${groupNum(e.amount)} XTR</div><div class="m">${when}</div></div></div>`;
    }
    return `<div class="act"><div><div class="k">充值领取</div><div class="m">${tx}</div></div>`
      + `<div style="text-align:right"><div class="amt mut">领取测试币</div><div class="m">${when}</div></div></div>`;
  }).join("");
}

async function refreshBalance(account) {
  $("balNum").textContent = "…";
  await ensureIndexer();
  if (!INDEXER) { $("balNum").textContent = "—"; return; }
  try {
    const bal = await balanceOf(await indexer(), account);
    $("balNum").textContent = groupNum(bal.toString());
  } catch (e) { $("balNum").textContent = "读取失败"; console.warn("balance read:", e); }
}

// create + fund the account on localnet, signed in the browser by the user's own key
$("btnFund").onclick = async () => {
  $("fundErr").textContent = "";
  $("btnFund").disabled = true;
  const prev = $("btnFund").textContent;
  $("btnFund").textContent = "创建中…(约 10–30 秒)";
  try {
    await ensureIndexer();
    if (!INDEXER) throw new Error("无法连接本地索引器");
    const provider = await indexer();
    const ownerPub = ownerPublicHex(fromHex(unlocked.owner));
    const { txId, account } = await fundViaFaucet(provider, walletOf(), ownerPub);
    if (!account) throw new Error("交易已提交但未找到新账户");
    localStorage.setItem(ACCOUNT_KEY, account);
    logActivity({ kind: "fund", account, txId });
    await enterMain();
  } catch (e) {
    $("fundErr").textContent = "创建失败: " + (e?.reason || e?.message || e);
    $("btnFund").disabled = false;
    $("btnFund").textContent = prev;
  }
};
// --- receive: a scannable QR of the account address (vendored global `qrcode`, same as classic) ---
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
  $("sendErr").textContent = "";
  $("sendOk").textContent = "";
  $("sendForm").hidden = false;
  $("sendTo").focus();
};
$("btnSendCancel").onclick = () => {
  $("sendForm").hidden = true;
  $("sendTo").value = "";
  $("sendAmt").value = "";
  $("sendErr").textContent = "";
};
$("btnSendDo").onclick = async () => {
  $("sendErr").textContent = "";
  $("sendOk").textContent = "";
  const to = $("sendTo").value.trim();
  const amtStr = $("sendAmt").value.trim();
  if (!/^component_[0-9a-f]{64}$/.test(to)) return void ($("sendErr").textContent = "收款地址应为 component_ 开头的 64 位十六进制账户地址");
  const from = currentAccount();
  if (to === from) return void ($("sendErr").textContent = "不能给自己转账");
  let amount;
  try { amount = BigInt(amtStr); } catch { return void ($("sendErr").textContent = "金额必须是整数"); }
  if (amount <= 0n) return void ($("sendErr").textContent = "金额必须大于 0");
  $("btnSendDo").disabled = true;
  $("btnSendCancel").disabled = true;
  const prev = $("btnSendDo").textContent;
  $("btnSendDo").textContent = "发送中…(约 10–30 秒)";
  try {
    await ensureIndexer();
    if (!INDEXER) throw new Error("无法连接本地索引器");
    const { txId } = await sendXtr(await indexer(), walletOf(), from, to, amount);
    $("sendOk").textContent = "已发送 ✓ tx " + String(txId).slice(0, 16) + "…";
    $("sendTo").value = "";
    $("sendAmt").value = "";
    $("sendForm").hidden = true;
    logActivity({ kind: "send", account: from, to, amount: amount.toString(), txId });
    renderActivity(from);
    await refreshBalance(from);
  } catch (e) {
    $("sendErr").textContent = "发送失败: " + (e?.reason || e?.message || e);
  } finally {
    $("btnSendDo").disabled = false;
    $("btnSendCancel").disabled = false;
    $("btnSendDo").textContent = prev;
  }
};
$("btnCopy").onclick = async () => {
  try { await navigator.clipboard.writeText($("mainAddr").textContent); $("btnCopy").textContent = "已复制"; setTimeout(() => ($("btnCopy").textContent = "复制地址"), 1200); } catch {}
};
$("btnLock").onclick = () => { unlocked = null; $("unlockPass").value = ""; $("unlockErr").textContent = ""; show("pUnlock"); };

$("btnShowPhrase").onclick = () => { $("phraseReveal").hidden = false; $("revealErr").textContent = ""; $("revealPass").focus(); };
$("btnRevealDo").onclick = async () => {
  $("revealErr").textContent = "";
  let blob;
  try { blob = JSON.parse(localStorage.getItem(VAULT_KEY)); } catch { blob = null; }
  if (!blob) return;
  let secret;
  try { secret = await decryptVault(blob, $("revealPass").value); }
  catch (e) { $("revealErr").textContent = e?.message || "口令错误"; return; }
  const phrase = keyMaterialToMnemonic({ owner: fromHex(secret.owner), view: fromHex(secret.view) });
  renderWords("revealGrid", phrase);
  $("revealGrid").hidden = false;
  $("btnHidePhrase").hidden = false;
  $("revealPass").value = "";
};
$("btnHidePhrase").onclick = () => { $("revealGrid").hidden = true; $("btnHidePhrase").hidden = true; $("phraseReveal").hidden = true; };

// boot
void TOTAL_WORDS; // 48 (owner 24 ‖ view 24)
// learn the indexer + offer "import existing account" when served by the wallet backend (localnet dev)
fetch("/api/status").then((r) => r.ok ? r.json() : null).then((s) => {
  if (!s) return;
  $("btnImportDev").hidden = false;
  INDEXER = s.indexer || "http://127.0.0.1:12008";
}).catch(() => {});
routeStart();
