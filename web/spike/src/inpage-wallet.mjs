// inpage-wallet.mjs — a DOM-agnostic self-custody wallet controller for the one-page dApp.
//
// This is the keystore + account/budget bookkeeping that wallet-sc.js does, lifted out of the DOM so the
// merged dashboard page can host it and feed it to src/sc-provider.mjs. It owns exactly the same browser
// state model wallet-sc.js uses (same localStorage keys, same shapes) so the two are interchangeable and a
// wallet created in one opens in the other:
//   ap-sc-vault   encrypted  { keys:[{id,owner,view}] }           (one passphrase over a LIST of keypairs)
//   ap-sc-meta    plaintext  { list:[{id,label,account}], active } (public per-account metadata)
//   ap-sc-budget  plaintext  { [accountId]: {component,ownerBadge,agentBadge,vaultId,merchant,template} }
//   ap-sc-settings plaintext { autoLockMin, indexer }
// The decrypted secrets + passphrase live in memory only while unlocked and are cleared on lock.
//
// Everything that touches a secret (encrypt/decrypt, mnemonic) comes from the pure src/self-custody.mjs,
// imported statically (no WASM). Address derivation, the SecretKeyWallet signer and the chain ops pull in
// @tari-project / sc-chain, so they are injectable (and lazily imported by default) — a unit test injects
// stubs and drives the whole keystore + host surface with no WASM, indexer or network.
import {
  generateKeyMaterial, keyMaterialToMnemonic, mnemonicToKeyMaterial,
  encryptVault, decryptVault, toHex, fromHex,
} from "./self-custody.mjs";

const VAULT_KEY = "ap-sc-vault";
const META_KEY = "ap-sc-meta";
const BUDGET_KEY = "ap-sc-budget";
const SETTINGS_KEY = "ap-sc-settings";
const LEGACY_ACCOUNT_KEY = "ap-sc-account";
const DEFAULT_INDEXER = "http://127.0.0.1:12008";
const genId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) }; };

/**
 * Create the controller. All deps are optional:
 *   storage        Storage-like (getItem/setItem/removeItem). Default: globalThis.localStorage, else in-memory.
 *   makeWallet     (ownerBytes, viewBytes, network) -> signer. Default: SecretKeyWallet.fromSecretKey (lazy).
 *   deriveAddress  async (ownerBytes, viewBytes, network) -> string. Default: makeWallet(...).getAddress().
 *   chain          sc-chain.mjs (ownerPublicHex/connect/fundViaFaucet/balanceOf/sendXtr/openBudget/readBudget/…). Default: lazy import.
 *   network        the ootle Network for address scoping. Default: Network.LocalNet (lazy).
 *   indexerUrl     initial indexer URL (else settings > this > default).
 */
export function createInPageWallet(opts = {}) {
  const storage = opts.storage || (typeof localStorage !== "undefined" ? localStorage : memStore());
  let _network = opts.network || null;
  let _makeWallet = opts.makeWallet || null;
  let _deriveAddress = opts.deriveAddress || null;
  let _chain = opts.chain || null;
  let INDEXER = opts.indexerUrl || null;
  let _provider = null, _providerUrl = null;

  // in-memory, cleared on lock
  let unlocked = null;       // { keys:[{id,owner,view}], pass }
  let _activeSigner = null;  // the active account's SecretKeyWallet, cached so the host getter is sync

  // --- lazy defaults for the WASM/chain-backed deps (skipped entirely when injected) ---
  async function network() {
    if (_network) return _network;
    const { Network } = await import("@tari-project/ootle");
    return (_network = Network.LocalNet);
  }
  async function makeWallet(ownerBytes, viewBytes) {
    if (_makeWallet) return _makeWallet(ownerBytes, viewBytes, await network());
    const { SecretKeyWallet } = await import("@tari-project/ootle-secret-key-wallet");
    return SecretKeyWallet.fromSecretKey(ownerBytes, await network(), viewBytes);
  }
  async function deriveAddress(ownerBytes, viewBytes) {
    if (_deriveAddress) return _deriveAddress(ownerBytes, viewBytes, await network());
    return (await makeWallet(ownerBytes, viewBytes)).getAddress();
  }
  async function chain() { return _chain || (_chain = await import("./sc-chain.mjs")); }

  // --- plaintext stores -------------------------------------------------------------------------
  const readJSON = (k, fallback) => { try { const v = JSON.parse(storage.getItem(k)); return v == null ? fallback : v; } catch { return fallback; } };
  const writeJSON = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
  function loadMeta() { const m = readJSON(META_KEY, null); return m && Array.isArray(m.list) ? m : { list: [], active: null }; }
  const saveMeta = (m) => writeJSON(META_KEY, m);
  const loadBudgets = () => readJSON(BUDGET_KEY, {});
  function settings() { return { autoLockMin: 0, indexer: "", ...readJSON(SETTINGS_KEY, {}) }; }
  const saveSettings = (s) => writeJSON(SETTINGS_KEY, { ...settings(), ...s });

  // --- derived state ----------------------------------------------------------------------------
  const hasVault = () => !!storage.getItem(VAULT_KEY);
  const isUnlocked = () => !!unlocked;
  const accounts = () => loadMeta().list.slice();
  const activeId = () => loadMeta().active;
  const metaFor = (id) => loadMeta().list.find((a) => a.id === id) || null;
  const activeMeta = () => metaFor(activeId());
  const account = () => (activeMeta() && activeMeta().account) || null;
  const keyOf = (id) => (unlocked && unlocked.keys.find((k) => k.id === (id || activeId()))) || null;
  function budgetFor(id) { const b = loadBudgets()[id || activeId()]; return b && b.component ? b : null; }
  const budget = () => budgetFor(activeId());

  async function saveVault(pass) { storage.setItem(VAULT_KEY, JSON.stringify(await encryptVault({ keys: unlocked.keys }, pass))); }

  // --- onboarding: generate / restore (pure, no secret persisted yet) ---------------------------
  function generate() {
    const material = generateKeyMaterial();
    return { material, mnemonic: keyMaterialToMnemonic(material), address: () => deriveAddress(material.owner, material.view) };
  }
  function fromMnemonic(phrase) {
    const material = mnemonicToKeyMaterial(phrase); // throws on a bad phrase
    return { material, address: () => deriveAddress(material.owner, material.view) };
  }

  // --- create the first wallet (one account) from a passphrase ----------------------------------
  async function createFirst({ material, passphrase, account: acct = null }) {
    if (!passphrase || passphrase.length < 8) throw new Error("口令至少 8 位");
    const id = genId();
    const owner = material.owner instanceof Uint8Array ? toHex(material.owner) : material.owner;
    const view = material.view instanceof Uint8Array ? toHex(material.view) : material.view;
    unlocked = { keys: [{ id, owner, view }], pass: passphrase };
    await saveVault(passphrase);
    saveMeta({ list: [{ id, label: "账户 1", account: acct }], active: id });
    await refreshSigner();
    return id;
  }

  // --- add an account to the already-unlocked wallet --------------------------------------------
  async function addAccount({ material, account: acct = null }) {
    if (!unlocked) throw new Error("钱包未解锁");
    const id = genId();
    const owner = material.owner instanceof Uint8Array ? toHex(material.owner) : material.owner;
    const view = material.view instanceof Uint8Array ? toHex(material.view) : material.view;
    unlocked.keys.push({ id, owner, view });
    try { await saveVault(unlocked.pass); }
    catch (e) { unlocked.keys.pop(); throw e; }
    const m = loadMeta();
    m.list.push({ id, label: "账户 " + (m.list.length + 1), account: acct });
    m.active = id;
    saveMeta(m);
    await refreshSigner();
    return id;
  }

  // --- unlock (+ one-time migration from the legacy single-key vault) ---------------------------
  async function unlock(passphrase) {
    const blob = readJSON(VAULT_KEY, null);
    if (!blob) throw new Error("本机没有钱包");
    const obj = await decryptVault(blob, passphrase); // throws on wrong passphrase
    if (Array.isArray(obj.keys)) {
      unlocked = { keys: obj.keys, pass: passphrase };
    } else {
      const id = genId();
      unlocked = { keys: [{ id, owner: obj.owner, view: obj.view }], pass: passphrase };
      if (!storage.getItem(META_KEY)) {
        const acct = obj.account || storage.getItem(LEGACY_ACCOUNT_KEY) || null;
        saveMeta({ list: [{ id, label: "账户 1", account: acct }], active: id });
      }
      try { await saveVault(passphrase); storage.removeItem(LEGACY_ACCOUNT_KEY); } catch { /* keep legacy on failure */ }
    }
    let m = loadMeta();
    if (!m.list.length) { m = { list: unlocked.keys.map((k, i) => ({ id: k.id, label: "账户 " + (i + 1), account: null })), active: unlocked.keys[0].id }; saveMeta(m); }
    if (!m.list.find((a) => a.id === m.active)) { m.active = m.list[0].id; saveMeta(m); }
    await refreshSigner();
    return accounts();
  }
  function lock() { unlocked = null; _activeSigner = null; }
  function forget() { for (const k of [VAULT_KEY, META_KEY, SETTINGS_KEY, BUDGET_KEY, LEGACY_ACCOUNT_KEY]) storage.removeItem(k); unlocked = null; _activeSigner = null; }

  // --- account metadata mutations ---------------------------------------------------------------
  async function setActive(id) { const m = loadMeta(); if (m.list.find((a) => a.id === id)) { m.active = id; saveMeta(m); await refreshSigner(); } }
  function rename(id, label) { const m = loadMeta(); const a = m.list.find((x) => x.id === id); if (a) { a.label = label; saveMeta(m); } }
  function recordAccountComponent(id, component) { const m = loadMeta(); const a = m.list.find((x) => x.id === (id || activeId())); if (a) { a.account = component; saveMeta(m); } }
  function setBudget(id, b) { const all = loadBudgets(); all[id || activeId()] = b; writeJSON(BUDGET_KEY, all); }
  function clearBudget(id) { const all = loadBudgets(); delete all[id || activeId()]; writeJSON(BUDGET_KEY, all); }

  // --- signer (requires unlocked) ---------------------------------------------------------------
  // Building a SecretKeyWallet is async (the WASM module may still be importing), but sc-provider needs a
  // SYNChronous getWallet() for its lock gate + signer. So we cache the ACTIVE signer and rebuild the cache
  // whenever unlock/create/add/switch changes which key is active; lock/forget clear it.
  async function walletFor(id) { const k = keyOf(id); return k ? makeWallet(fromHex(k.owner), fromHex(k.view)) : null; }
  async function refreshSigner() { const k = keyOf(); _activeSigner = k ? await makeWallet(fromHex(k.owner), fromHex(k.view)) : null; return _activeSigner; }
  const activeSigner = () => _activeSigner;
  async function addressFor(id) { const k = keyOf(id); if (!k) throw new Error("钱包未解锁"); return deriveAddress(fromHex(k.owner), fromHex(k.view)); }

  // --- indexer -----------------------------------------------------------------------------------
  async function ensureIndexer() {
    const saved = settings().indexer;
    if (saved) return (INDEXER = saved);
    if (INDEXER) return INDEXER;
    try { if (typeof fetch === "function") { const r = await fetch("/api/status"); if (r.ok) INDEXER = (await r.json()).indexer || DEFAULT_INDEXER; } } catch { /* standalone */ }
    return (INDEXER = INDEXER || DEFAULT_INDEXER);
  }
  async function provider() {
    await ensureIndexer();
    if (_provider && _providerUrl === INDEXER) return _provider;
    _provider = await (await chain()).connect(INDEXER); _providerUrl = INDEXER; return _provider;
  }

  // --- chain ops (thin; persist their result into the state above) ------------------------------
  async function fund() {
    const k = keyOf(); if (!k) throw new Error("钱包未解锁");
    const c = await chain(); const p = await provider();
    const ownerPubHex = c.ownerPublicHex(fromHex(k.owner));
    const r = await c.fundViaFaucet(p, await walletFor(), ownerPubHex);
    if (r.account) recordAccountComponent(activeId(), r.account);
    return r;
  }
  async function balance() { const a = account(); if (!a) return 0n; return (await chain()).balanceOf(await provider(), a); }
  async function send(to, amount) { const from = account(); if (!from) throw new Error("账户尚未上链"); return (await chain()).sendXtr(await provider(), await walletFor(), from, to, BigInt(amount)); }
  async function openBudget({ template, merchant, fund: fundAmt, perTxCap, dailyCap, epochsPerWindow }) {
    const owner = account(); if (!owner) throw new Error("账户尚未上链");
    const c = await chain(); const p = await provider();
    const r = await c.openBudget(p, await walletFor(), { owner, template, merchant, fund: fundAmt, perTxCap, dailyCap, epochsPerWindow });
    const s = r.state || {};
    setBudget(activeId(), { component: r.budget, merchant, template, ownerBadge: s.ownerBadge, agentBadge: s.agentBadge, vaultId: s.vaultId });
    return r;
  }
  async function refreshBudget() { const b = budget(); if (!b) return null; return (await chain()).readBudget(await provider(), b.component); }

  // --- the host object sc-provider consumes (inject approve + onChange from the page) -----------
  function providerHost({ approve, onChange } = {}) {
    return {
      network: "localnet",
      getWallet: () => activeSigner(),       // the cached active SecretKeyWallet, or null when locked
      getAccount: () => account(),
      getBudget: () => budget(),
      getIndexer: () => provider(),
      approve: approve || (async () => true),
      onChange: onChange || (() => {}),
    };
  }

  return {
    // state
    hasVault, isUnlocked, accounts, activeId, account, budget, settings, saveSettings,
    // onboarding + keystore
    generate, fromMnemonic, createFirst, addAccount, unlock, lock, forget,
    // account metadata
    setActive, rename, recordAccountComponent, setBudget, clearBudget,
    // crypto
    walletFor, addressFor, activeSigner,
    // chain
    ensureIndexer, provider, fund, balance, send, openBudget, refreshBudget,
    // integration
    providerHost,
  };
}
