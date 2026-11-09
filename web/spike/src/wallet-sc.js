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

const $ = (id) => document.getElementById(id);
const VAULT_KEY = "ap-sc-vault";
const NETWORK = Network.LocalNet; // identity address is net-scoped; localnet for now (prefix otl_loc_)

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
  if (unlocked.account) {
    // an on-chain account (imported / funded): show the component address + live balance
    $("addrLabel").textContent = "账户";
    $("mainAddr").textContent = unlocked.account;
    $("balBlock").hidden = false;
    $("balNum").textContent = "…";
    try {
      const r = await fetch("/api/account");
      const j = await r.json();
      $("balNum").textContent = groupNum(j.balance ?? "0");
    } catch { $("balNum").textContent = "读取失败"; }
  } else {
    // a fresh self-custody key with no on-chain account yet: show the derived key address
    $("addrLabel").textContent = "密钥地址(未充值,链上尚无账户)";
    $("balBlock").hidden = true;
    $("mainAddr").textContent = "派生中…";
    try { $("mainAddr").textContent = await addressOf(fromHex(unlocked.owner), fromHex(unlocked.view)); }
    catch (e) { $("mainAddr").textContent = "地址派生失败: " + (e?.message || e); }
  }
}
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
// offer "import existing account" only when served by the wallet backend (localnet dev)
fetch("/api/status").then((r) => { if (r.ok) $("btnImportDev").hidden = false; }).catch(() => {});
routeStart();
