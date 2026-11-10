// inpage-wallet.test.mjs — unit test for the DOM-agnostic self-custody controller (src/inpage-wallet.mjs).
//
// No WASM / indexer / network / DOM: an in-memory storage + stub makeWallet/deriveAddress/chain are injected,
// but the REAL src/self-custody.mjs does the keygen + AES-GCM/PBKDF2 vault, so create -> lock -> unlock is a
// genuine encrypt/decrypt round-trip. Verifies the state model wallet-sc.js relies on (vault/meta/budget
// stores, multi-account, active switching, lock clears secrets) and the host surface sc-provider consumes.
//
// Run: node --test node/inpage-wallet.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18 shim; self-custody uses getRandomValues + subtle

const { createInPageWallet } = await import("../src/inpage-wallet.mjs");
const { toHex } = await import("../src/self-custody.mjs");

function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), _map: m }; }
function chainStub() {
  const calls = [];
  const rec = (name, ret) => (...a) => { calls.push({ name, args: a }); return ret; };
  return {
    _calls: calls,
    ownerPublicHex: rec("ownerPublicHex", "ownerpub"),
    connect: rec("connect", { __provider: true }),
    fundViaFaucet: rec("fundViaFaucet", { txId: "tx_fund", account: "component_" + "a".repeat(64) }),
    balanceOf: rec("balanceOf", 9000n),
    sendXtr: rec("sendXtr", { txId: "tx_send" }),
    openBudget: rec("openBudget", { txId: "tx_open", budget: "component_" + "b".repeat(64), state: { ownerBadge: "ob", agentBadge: "ab", vaultId: "vid" } }),
    readBudget: rec("readBudget", { address: "component_" + "b".repeat(64), perTx: "1000", daily: "1500", spent: "0" }),
  };
}
// a sync fake signer so the cached host.getWallet() is populated right after unlock/create
const makeWallet = (owner /*, view, net */) => ({ __signer: true, owner: toHex(owner) });
const deriveAddress = async (owner /*, view, net */) => "otl_loc_" + toHex(owner).slice(0, 16);
const mk = (over = {}) => createInPageWallet({ storage: memStorage(), makeWallet, deriveAddress, chain: chainStub(), network: "LocalNet", ...over });

test("fresh controller: no vault, locked, no accounts", () => {
  const w = mk();
  assert.equal(w.hasVault(), false);
  assert.equal(w.isUnlocked(), false);
  assert.deepEqual(w.accounts(), []);
  assert.equal(w.account(), null);
  assert.equal(w.budget(), null);
});

test("generate produces a 48-word mnemonic and a derivable address", async () => {
  const w = mk();
  const g = w.generate();
  assert.equal(g.mnemonic.split(/\s+/).length, 48);
  assert.match(await g.address(), /^otl_loc_/);
});

test("createFirst then host surface reflects an unlocked, signing wallet", async () => {
  const w = mk();
  const host = w.providerHost();
  const g = w.generate();
  await w.createFirst({ material: g.material, passphrase: "passw0rd" });
  assert.equal(w.hasVault(), true);
  assert.equal(w.isUnlocked(), true);
  assert.equal(w.accounts().length, 1);
  assert.ok(host.getWallet(), "host exposes the active signer after create");
  assert.equal(host.getWallet().owner, toHex(g.material.owner));
  assert.equal(host.getAccount(), null); // not yet funded -> no on-chain component
});

test("lock clears the in-memory secret but keeps the vault; unlock restores", async () => {
  const w = mk();
  const host = w.providerHost();
  const g = w.generate();
  await w.createFirst({ material: g.material, passphrase: "passw0rd" });
  w.lock();
  assert.equal(w.isUnlocked(), false);
  assert.equal(host.getWallet(), null, "locked -> no signer");
  assert.equal(w.hasVault(), true, "vault persists across lock");
  await assert.rejects(() => w.unlock("wrong-pass"), /./);
  const accts = await w.unlock("passw0rd");
  assert.equal(accts.length, 1);
  assert.equal(w.isUnlocked(), true);
  assert.ok(host.getWallet(), "signer rebuilt on unlock");
  assert.equal(host.getWallet().owner, toHex(g.material.owner));
});

test("vault round-trips across a fresh controller on the SAME storage", async () => {
  const storage = memStorage();
  const a = createInPageWallet({ storage, makeWallet, deriveAddress, chain: chainStub() });
  const g = a.generate();
  await a.createFirst({ material: g.material, passphrase: "passw0rd" });
  // a second controller instance (e.g. a page reload) sees the vault and can unlock it
  const b = createInPageWallet({ storage, makeWallet, deriveAddress, chain: chainStub() });
  assert.equal(b.hasVault(), true);
  assert.equal(b.isUnlocked(), false);
  await b.unlock("passw0rd");
  assert.equal(b.accounts().length, 1);
  assert.equal(b.providerHost().getWallet().owner, toHex(g.material.owner));
});

test("addAccount grows the list, switches active, and rebuilds the signer", async () => {
  const w = mk();
  const host = w.providerHost();
  const g1 = w.generate();
  await w.createFirst({ material: g1.material, passphrase: "passw0rd" });
  const id1 = w.activeId();
  const g2 = w.generate();
  const id2 = await w.addAccount({ material: g2.material });
  assert.equal(w.accounts().length, 2);
  assert.equal(w.activeId(), id2);
  assert.equal(host.getWallet().owner, toHex(g2.material.owner), "active signer follows the new account");
  await w.setActive(id1);
  assert.equal(w.activeId(), id1);
  assert.equal(host.getWallet().owner, toHex(g1.material.owner), "switching active rebuilds the signer");
});

test("mnemonic restore is deterministic (same phrase -> same key)", () => {
  const w = mk();
  const g = w.generate();
  const r = w.fromMnemonic(g.mnemonic);
  assert.equal(toHex(r.material.owner), toHex(g.material.owner));
  assert.equal(toHex(r.material.view), toHex(g.material.view));
});

test("fromMnemonic rejects a bad phrase", () => {
  const w = mk();
  assert.throws(() => w.fromMnemonic("not a valid mnemonic phrase"));
});

test("account component + budget persist and surface on the host", async () => {
  const w = mk();
  const host = w.providerHost();
  await w.createFirst({ material: w.generate().material, passphrase: "passw0rd" });
  const id = w.activeId();
  w.recordAccountComponent(id, "component_" + "c".repeat(64));
  assert.equal(host.getAccount(), "component_" + "c".repeat(64));
  w.setBudget(id, { component: "component_" + "b".repeat(64), merchant: "component_" + "d".repeat(64), template: "template_x", ownerBadge: "ob" });
  assert.equal(host.getBudget().component, "component_" + "b".repeat(64));
  assert.equal(host.getBudget().merchant, "component_" + "d".repeat(64));
  w.clearBudget(id);
  assert.equal(w.budget(), null);
});

test("forget wipes vault + meta + budgets + journal", async () => {
  const w = mk();
  await w.createFirst({ material: w.generate().material, passphrase: "passw0rd" });
  w.recordAccountComponent(w.activeId(), "component_" + "c".repeat(64));
  const comp = "component_" + "b".repeat(64);
  w.providerHost().recordPay({ component: comp, merchant: "component_" + "d".repeat(64), amount: "700", txid: "tx1" });
  assert.equal(w.journalFor(comp).ledger.length, 1);
  w.forget();
  assert.equal(w.hasVault(), false);
  assert.equal(w.isUnlocked(), false);
  assert.deepEqual(w.accounts(), []);
  assert.equal(w.account(), null);
  assert.deepEqual(w.journalFor(comp).ledger, [], "journal history cleared on forget");
});

test("fund calls the faucet and records the on-chain account", async () => {
  const chain = chainStub();
  const w = mk({ chain });
  await w.createFirst({ material: w.generate().material, passphrase: "passw0rd" });
  const r = await w.fund();
  assert.equal(r.account, "component_" + "a".repeat(64));
  assert.equal(w.account(), "component_" + "a".repeat(64), "account recorded to meta");
  assert.ok(chain._calls.some((c) => c.name === "fundViaFaucet"));
});

test("openBudget persists the budget state the host then exposes", async () => {
  const chain = chainStub();
  const w = mk({ chain });
  await w.createFirst({ material: w.generate().material, passphrase: "passw0rd" });
  w.recordAccountComponent(w.activeId(), "component_" + "a".repeat(64));
  const r = await w.openBudget({ template: "template_x", merchant: "component_" + "d".repeat(64), fund: 50000, perTxCap: 1000, dailyCap: 1500, epochsPerWindow: 10 });
  assert.equal(r.budget, "component_" + "b".repeat(64));
  const b = w.budget();
  assert.equal(b.component, "component_" + "b".repeat(64));
  assert.equal(b.ownerBadge, "ob");
  assert.equal(b.agentBadge, "ab");
  assert.equal(b.vaultId, "vid");
});

test("budget journal: openBudget records the opening deposit as funded", async () => {
  const chain = chainStub();
  const w = mk({ chain });
  await w.createFirst({ material: w.generate().material, passphrase: "passw0rd" });
  w.recordAccountComponent(w.activeId(), "component_" + "a".repeat(64));
  await w.openBudget({ template: "template_x", merchant: "component_" + "d".repeat(64), fund: 50000, perTxCap: 1000, dailyCap: 1500, epochsPerWindow: 10 });
  const comp = "component_" + "b".repeat(64);
  const j = w.journalFor(comp);
  assert.equal(j.funded, "50000");
  assert.equal(j.withdrawn, "0");
  assert.deepEqual(j.ledger, []);
  assert.deepEqual(j.sessions, []);
});

test("budget journal: host.recordPay appends a ledger row the host then serves", async () => {
  const w = mk();
  const host = w.providerHost();
  const comp = "component_" + "b".repeat(64);
  host.recordPay({ component: comp, merchant: "component_" + "d".repeat(64), amount: "700", memo: "coffee", txid: "tx_pay1" });
  host.recordPay({ component: comp, merchant: "component_" + "d".repeat(64), amount: "300", memo: "", txid: "tx_pay2" });
  const j = host.getJournal(comp);
  assert.equal(j.ledger.length, 2);
  assert.equal(j.ledger[0].amount, "700");          // oldest first (append order)
  assert.equal(j.ledger[0].memo, "coffee");
  assert.equal(j.ledger[0].txid, "tx_pay1");
  assert.ok(typeof j.ledger[0].ts === "number");
  assert.equal(j.ledger[1].amount, "300");
});

test("budget journal: recordFunded/recordWithdrawn accumulate; a fresh controller on the same storage sees it", async () => {
  const storage = memStorage();
  const a = createInPageWallet({ storage, makeWallet, deriveAddress, chain: chainStub() });
  const comp = "component_" + "b".repeat(64);
  a.providerHost().recordFunded(comp, "50000");
  a.providerHost().recordFunded(comp, "10000");
  a.providerHost().recordWithdrawn(comp, "4000");
  const b = createInPageWallet({ storage, makeWallet, deriveAddress, chain: chainStub() });
  const j = b.journalFor(comp);
  assert.equal(j.funded, "60000");
  assert.equal(j.withdrawn, "4000");
});

test("budget journal: unknown component reads an empty skeleton, never throws", () => {
  const w = mk();
  const j = w.journalFor("component_" + "f".repeat(64));
  assert.deepEqual(j, { funded: "0", withdrawn: "0", ledger: [], sessions: [] });
  assert.deepEqual(w.journalFor(null), { funded: "0", withdrawn: "0", ledger: [], sessions: [] });
});

test("send is blocked before the account is on-chain, then calls sendXtr", async () => {
  const chain = chainStub();
  const w = mk({ chain });
  await w.createFirst({ material: w.generate().material, passphrase: "passw0rd" });
  await assert.rejects(() => w.send("component_" + "d".repeat(64), 5n), /上链/);
  w.recordAccountComponent(w.activeId(), "component_" + "a".repeat(64));
  const r = await w.send("component_" + "d".repeat(64), 5n);
  assert.equal(r.txId, "tx_send");
});
