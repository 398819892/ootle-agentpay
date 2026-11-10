// sc-provider.test.mjs — unit test for the in-page window.tari provider (src/sc-provider.mjs).
//
// Pure, headless, no chain/indexer/WASM: the host injects stub chain ops + keystore accessors, so this
// verifies the DISPATCH itself — method routing, connection gating, approval rejection, lock gating, and
// argument validation — the logic that must hold regardless of what the chain does. The real chain ops
// (sc-chain.mjs) are exercised live by node/flow-a-sc.mjs; here they are stubbed to record calls.
//
// Run: node --test node/sc-provider.test.mjs   (no flags, no network)
import { test } from "node:test";
import assert from "node:assert/strict";

// --- minimal browser globals the provider touches (location.origin + window events) ---
const events = [];
globalThis.location = { origin: "http://localhost:8787" };
globalThis.window = { dispatchEvent: (e) => { events.push(e.type); return true; } };
globalThis.CustomEvent = class CustomEvent extends Event { constructor(type, init) { super(type); this.detail = init && init.detail; } };

const { createInPageTari } = await import("../src/sc-provider.mjs");

const ACCOUNT = "component_" + "a".repeat(64);
const BUDGET = "component_" + "b".repeat(64);
const MERCHANT = "component_" + "c".repeat(64);
const OTHER = "component_" + "d".repeat(64);
const WALLET = { __wallet: true };

// A host factory: sensible unlocked defaults, each piece overridable per test; records chain calls.
function makeHost(over = {}) {
  const calls = [];
  const rec = (name, ret) => (...a) => { calls.push({ name, args: a }); return ret; };
  const host = {
    _calls: calls,
    getWallet: () => WALLET,
    getAccount: () => ACCOUNT,
    getBudget: () => ({ component: BUDGET, merchant: MERCHANT, template: "template_x", ownerBadge: "badge_owner" }),
    getIndexer: async () => ({ __indexer: true }),
    approve: async () => true,
    onChange: () => calls.push({ name: "onChange", args: [] }),
    chain: {
      balanceOf: rec("balanceOf", 12345n),
      readBudget: rec("readBudget", { address: BUDGET, perTx: "1000", daily: "1500", spent: "700", vault: "vault_1", whitelist: [MERCHANT], ownerBadge: "badge_owner", agentBadge: "badge_agent", vaultId: "v", revoked: false }),
      payBudget: rec("payBudget", { committed: true, txid: "tx_pay" }),
      setLimits: rec("setLimits", { committed: true, txid: "tx_limits" }),
      setMerchant: rec("setMerchant", { committed: true, txid: "tx_merchant" }),
      sendXtr: rec("sendXtr", { txId: "tx_send" }),
      topUp: rec("topUp", { committed: true, txid: "tx_topup" }),
      withdraw: rec("withdraw", { committed: true, txid: "tx_withdraw" }),
      issueSession: rec("issueSession", { committed: true, txid: "tx_issue" }),
      revokeSession: rec("revokeSession", { committed: true, txid: "tx_revsess" }),
      revoke: rec("revoke", { committed: true, txid: "tx_revoke" }),
    },
    ...over,
  };
  return host;
}
const connected = async (over) => { const h = makeHost(over); const p = createInPageTari(h); await p.connect(); return { h, p }; };
// Like `connected`, but records every approval SPEC the provider builds (dropping the connect one), so a
// test can assert the DECODED intent shown to the user — the "no blind-signing" surface.
async function connectedCapturing(over) {
  const specs = [];
  const h = makeHost({ approve: async (s) => { specs.push(s); return true; }, ...over });
  const p = createInPageTari(h);
  await p.connect();
  specs.length = 0;
  return { specs, h, p };
}
async function throws(fn, re) { await assert.rejects(fn, re); }

test("request before connect is gated", async () => {
  const p = createInPageTari(makeHost());
  assert.equal(p.connected, false);
  await throws(() => p.request({ method: "tari_getAccount" }), /请先连接/);
});

test("connect with no account rejects, nothing linked", async () => {
  const p = createInPageTari(makeHost({ getAccount: () => null }));
  await throws(() => p.connect(), /账户/);
  assert.equal(p.connected, false);
});

test("connect returns the account, sets connected, fires tari#connect", async () => {
  events.length = 0;
  const { p } = await connected();
  assert.equal(p.connected, true);
  assert.equal(p.account, ACCOUNT);
  assert.deepEqual(await p.request({ method: "tari_requestAccounts" }), [ACCOUNT]);
  assert.ok(events.includes("tari#connect"));
});

test("connect is rejected when the user declines approval", async () => {
  const p = createInPageTari(makeHost({ approve: async () => false }));
  await throws(() => p.connect(), /用户拒绝/);
  assert.equal(p.connected, false);
});

test("tari_getAccount returns balance from the chain", async () => {
  const { p } = await connected();
  const r = await p.request({ method: "tari_getAccount" });
  assert.deepEqual(r, { account: ACCOUNT, network: "localnet", balance: "12345" });
});

test("tari_getBudget shapes the budget view", async () => {
  const { p } = await connected();
  const r = await p.request({ method: "tari_getBudget" });
  assert.equal(r.account, ACCOUNT);
  assert.equal(r.merchant, MERCHANT);
  assert.equal(r.budget.perTx, "1000");
  assert.equal(r.budget.spent, "700");
  assert.deepEqual(r.budget.whitelist, [MERCHANT]);
});

test("tari_getBudget returns budget:null when none is open", async () => {
  const { p } = await connected({ getBudget: () => null });
  const r = await p.request({ method: "tari_getBudget" });
  assert.equal(r.budget, null);
});

test("tari_getBudget merges the wallet's browser journal (funded/withdrawn/ledger/sessions)", async () => {
  const journal = {
    funded: "60000", withdrawn: "4000",
    ledger: [{ merchant: MERCHANT, amount: "700", memo: "m", txid: "tx_pay", ts: 1 }],
    sessions: [{ session: "s1", revoked: false }],
  };
  const { p } = await connected({ getJournal: () => journal });
  const r = await p.request({ method: "tari_getBudget" });
  // chain facts stay live; history comes from the journal
  assert.equal(r.budget.spent, "700");
  assert.equal(r.budget.funded, "60000");
  assert.equal(r.budget.withdrawn, "4000");
  assert.equal(r.budget.ledger.length, 1);
  assert.equal(r.budget.ledger[0].txid, "tx_pay");
  assert.deepEqual(r.budget.sessions, [{ session: "s1", revoked: false }]);
});

test("tari_getBudget without a journal host still returns the chain view (funded/ledger absent)", async () => {
  const { p } = await connected(); // makeHost has no getJournal
  const r = await p.request({ method: "tari_getBudget" });
  assert.equal(r.budget.spent, "700");
  assert.equal(r.budget.funded, null);
  assert.deepEqual(r.budget.ledger, []);
});

test("pay happy path calls payBudget and reports committed", async () => {
  const { h, p } = await connected();
  const r = await p.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 700, memo: "m" } } });
  assert.equal(r.committed, true);
  assert.equal(r.txid, "tx_pay");
  assert.equal(r.amount, "700");
  const pay = h._calls.find((c) => c.name === "payBudget");
  assert.ok(pay, "payBudget called");
  assert.equal(pay.args[2].amount, 700n);
  assert.equal(pay.args[2].merchant, MERCHANT);
  assert.ok(h._calls.some((c) => c.name === "onChange"), "onChange fired on commit");
});

test("pay records the committed pay to the wallet journal", async () => {
  const recorded = [];
  const { p } = await connected({ recordPay: (e) => recorded.push(e) });
  await p.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 700, memo: "coffee" } } });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].component, BUDGET);
  assert.equal(recorded[0].merchant, MERCHANT);
  assert.equal(recorded[0].amount, "700");
  assert.equal(recorded[0].memo, "coffee");
  assert.equal(recorded[0].txid, "tx_pay");
});

test("pay does NOT record to the journal when the chain rejects it", async () => {
  const recorded = [];
  const chain = { ...makeHost().chain, payBudget: () => ({ committed: false, reason: "over cap" }) };
  const { p } = await connected({ recordPay: (e) => recorded.push(e), chain });
  const r = await p.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 5000 } } });
  assert.equal(r.committed, false);
  assert.equal(recorded.length, 0, "rejected pays are never journaled");
});

test("pay is rejected when wallet is locked", async () => {
  const { p } = await connected({ getWallet: () => null });
  await throws(() => p.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 700 } } }), /锁定/);
});

test("pay is rejected when the user declines", async () => {
  let n = 0;
  const { p } = await connected({ approve: async () => (++n === 1) }); // allow connect, deny pay
  await throws(() => p.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 700 } } }), /用户拒绝/);
});

test("pay rejects a non-positive amount", async () => {
  const { p } = await connected();
  await throws(() => p.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 0 } } }), /大于 0/);
});

test("setLimits happy path; non-integer caps rejected", async () => {
  const { h, p } = await connected();
  const r = await p.request({ method: "tari_signAndSubmitTransaction", params: { setLimits: { perTxCap: "2000", dailyCap: "5000" } } });
  assert.equal(r.committed, true);
  const sl = h._calls.find((c) => c.name === "setLimits");
  assert.equal(sl.args[2].perTxCap, "2000");
  assert.equal(sl.args[2].ownerBadge, "badge_owner");
  await throws(() => p.request({ method: "tari_signAndSubmitTransaction", params: { setLimits: { perTxCap: "1.5", dailyCap: "5000" } } }), /整数/);
});

test("addMerchant validates the address and calls setMerchant(add=true)", async () => {
  const { h, p } = await connected();
  await throws(() => p.request({ method: "tari_signAndSubmitTransaction", params: { addMerchant: { merchant: "nope" } } }), /component_/);
  const r = await p.request({ method: "tari_signAndSubmitTransaction", params: { addMerchant: { merchant: OTHER } } });
  assert.equal(r.committed, true);
  const sm = h._calls.find((c) => c.name === "setMerchant");
  assert.equal(sm.args[2].add, true);
  assert.equal(sm.args[2].merchant, OTHER);
});

test("removeMerchant calls setMerchant(add=false)", async () => {
  const { h, p } = await connected();
  await p.request({ method: "tari_signAndSubmitTransaction", params: { removeMerchant: { merchant: MERCHANT } } });
  assert.equal(h._calls.find((c) => c.name === "setMerchant").args[2].add, false);
});

test("topUp routes to chain.topUp and journals the funded amount on commit", async () => {
  const funded = [];
  const { h, p } = await connected({ recordFunded: (c, a) => funded.push([c, a]) });
  const r = await p.request({ method: "tari_signAndSubmitTransaction", params: { topUp: { amount: "5000" } } });
  assert.equal(r.committed, true);
  assert.equal(r.txid, "tx_topup");
  const call = h._calls.find((c) => c.name === "topUp");
  assert.equal(call.args[2].budget, BUDGET);
  assert.equal(call.args[2].amount, "5000");
  assert.deepEqual(funded, [[BUDGET, "5000"]]);
});

test("withdraw routes to chain.withdraw and journals the withdrawn amount on commit", async () => {
  const withdrawn = [];
  const { h, p } = await connected({ recordWithdrawn: (c, a) => withdrawn.push([c, a]) });
  const r = await p.request({ method: "tari_signAndSubmitTransaction", params: { withdraw: { amount: "2000" } } });
  assert.equal(r.committed, true);
  assert.equal(r.txid, "tx_withdraw");
  assert.equal(h._calls.find((c) => c.name === "withdraw").args[2].amount, "2000");
  assert.deepEqual(withdrawn, [[BUDGET, "2000"]]);
});

test("issueSession routes to chain.issueSession and journals the session; empty name rejected", async () => {
  const issued = [];
  const { h, p } = await connected({ recordSessionIssued: (c, s) => issued.push([c, s]) });
  await throws(() => p.request({ method: "tari_signAndSubmitTransaction", params: { issueSession: { session: "  " } } }), /会话名称/);
  const r = await p.request({ method: "tari_signAndSubmitTransaction", params: { issueSession: { session: "agent2" } } });
  assert.equal(r.committed, true);
  assert.equal(r.txid, "tx_issue");
  const call = h._calls.find((c) => c.name === "issueSession");
  assert.equal(call.args[2].session, "agent2");
  assert.equal(call.args[2].agent, ACCOUNT); // single-account: owner is the session account
  assert.deepEqual(issued, [[BUDGET, "agent2"]]);
});

test("revokeSession routes to chain.revokeSession and journals the revocation", async () => {
  const revoked = [];
  const { h, p } = await connected({ recordSessionRevoked: (c, s) => revoked.push([c, s]) });
  const r = await p.request({ method: "tari_signAndSubmitTransaction", params: { revokeSession: { session: "agent2" } } });
  assert.equal(r.committed, true);
  assert.equal(h._calls.find((c) => c.name === "revokeSession").args[2].session, "agent2");
  assert.deepEqual(revoked, [[BUDGET, "agent2"]]);
});

test("revoke (global kill switch) routes to chain.revoke", async () => {
  const { h, p } = await connected();
  const r = await p.request({ method: "tari_signAndSubmitTransaction", params: { revoke: {} } });
  assert.equal(r.committed, true);
  assert.equal(r.txid, "tx_revoke");
  assert.equal(h._calls.find((c) => c.name === "revoke").args[2].budget, BUDGET);
});

test("a rejected lifecycle op does NOT journal", async () => {
  const funded = [];
  const chain = { ...makeHost().chain, topUp: () => ({ committed: false, reason: "no funds" }) };
  const { p } = await connected({ chain, recordFunded: (c, a) => funded.push([c, a]) });
  const r = await p.request({ method: "tari_signAndSubmitTransaction", params: { topUp: { amount: "5000" } } });
  assert.equal(r.committed, false);
  assert.equal(funded.length, 0);
});

test("lifecycle ops reject a non-positive amount and require a connected, unlocked wallet", async () => {
  const { p } = await connected();
  await throws(() => p.request({ method: "tari_signAndSubmitTransaction", params: { topUp: { amount: "0" } } }), /正整数/);
  const locked = createInPageTari(makeHost({ getWallet: () => null }));
  await locked.connect();
  await throws(() => locked.request({ method: "tari_signAndSubmitTransaction", params: { withdraw: { amount: "5" } } }), /锁定/);
});

test("transfer validates recipient, blocks self-send, calls sendXtr", async () => {
  const { h, p } = await connected();
  await throws(() => p.request({ method: "tari_sendTransaction", params: { to: "bad", amount: "5" } }), /收款地址/);
  await throws(() => p.request({ method: "tari_sendTransaction", params: { to: ACCOUNT, amount: "5" } }), /自己/);
  const r = await p.request({ method: "tari_sendTransaction", params: { to: OTHER, amount: "5" } });
  assert.equal(r.txId, "tx_send");
  const sx = h._calls.find((c) => c.name === "sendXtr");
  assert.equal(sx.args[4], 5n);
});

test("unknown method is rejected", async () => {
  const { p } = await connected();
  await throws(() => p.request({ method: "tari_doMagic" }), /不支持的方法/);
});

// --- decoded-intent approval (Phase 5: no blind-signing) ---------------------------------------
test("pay approval decodes the intent (amount/merchant/caps) and self-checks within caps", async () => {
  const { specs, p } = await connectedCapturing();
  await p.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 700, memo: "coffee" } } });
  const s = specs[0];
  assert.ok(s.rows && s.rows.length, "approval carries decoded rows");
  const val = (label) => (s.rows.find((r) => r.label === label) || {}).value;
  assert.equal(val("金额"), "700 XTR");
  assert.equal(val("商户"), MERCHANT);
  assert.equal(val("单笔上限"), "1000 XTR");
  assert.equal(val("每日上限"), "1500 XTR");
  assert.ok(s.rows.some((r) => r.value === "coffee"), "memo shown as a plain value");
  assert.ok(s.rows.every((r) => typeof r.value === "string"), "every row value is a plain string, not HTML");
  assert.equal(s.check.ok, true); // 700 ≤ 1000 and 700 + 700 ≤ 1500
});

test("pay approval flags an over-cap payment in the self-check", async () => {
  const { specs, p } = await connectedCapturing();
  await p.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 5000 } } });
  assert.equal(specs[0].check.ok, false);
  assert.match(specs[0].check.text, /上限|超过/);
});

test("pay approval on a revoked budget warns it will be rejected", async () => {
  const chain = { ...makeHost().chain, readBudget: () => ({ address: BUDGET, perTx: "1000", daily: "1500", spent: "0", vault: "v", whitelist: [MERCHANT], revoked: true }) };
  const { specs, p } = await connectedCapturing({ chain });
  await p.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 100 } } });
  assert.equal(specs[0].check.ok, false);
  assert.match(specs[0].check.text, /停用/);
});

test("issueSession approval carries the raw session name as a plain row value (rendered as text, not HTML)", async () => {
  const { specs, p } = await connectedCapturing();
  const evil = '<img src=x onerror="boom()">';
  await p.request({ method: "tari_signAndSubmitTransaction", params: { issueSession: { session: evil } } });
  // the provider hands the host the RAW string as a value; the host renders it with textContent, so it can
  // never inject markup into the approval surface. Asserting equality proves nothing was pre-rendered to HTML.
  assert.ok(specs[0].rows.some((r) => r.value === evil), "session name passed through verbatim as a value");
});

test("disconnect clears connected and fires tari#disconnect", async () => {
  events.length = 0;
  const { p } = await connected();
  p.disconnect();
  assert.equal(p.connected, false);
  assert.ok(events.includes("tari#disconnect"));
  await throws(() => p.request({ method: "tari_getAccount" }), /请先连接/);
});
