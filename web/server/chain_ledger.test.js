//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * The chain-discovered payment ledger: reconstruct EVERY AgentBudget `pay` for a component from the
 * account's transaction list (so a pay made via the MCP / SDK / another dashboard — which left no
 * local journal row — still shows in the feed), and merge it with the dashboard's own journal.
 *
 *     node --test web/server/chain_ledger.test.js
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractChainPays, parseWalletdTime } = require("./chain_reads");
const { mergeLedgers } = require("./dashboard");

const COMP = "component_" + "e1".repeat(32);
const OTHER = "component_" + "99".repeat(32);
const SHOP = "component_" + "12".repeat(32);

/** A finalized `AgentBudget.pay` event the engine namespaces as "<Struct>.pay". */
function payEv(substate, { amount, memo, merchant, spent }) {
  return { topic: "AgentBudget.pay", substate_id: substate, payload: { amount, memo, merchant, spent_in_window: spent } };
}
/** A tx entry shaped like walletd's `transactions.list` returns (events duplicated, as on chain). */
function tx(id, time, events, { dryRun = false } = {}) {
  return { id, last_update_time: time, is_dry_run: dryRun, finalize: { events: [...events, ...events] } };
}

test("parseWalletdTime parses the walletd timestamp, 0 on junk", () => {
  assert.equal(parseWalletdTime("1970-01-01 00:00:00.0"), 0 + new Date("1970-01-01T00:00:00.0").getTime());
  assert.ok(parseWalletdTime("2026-11-04 15:39:33.0") > parseWalletdTime("2026-11-04 08:00:00.0"));
  assert.equal(parseWalletdTime(null), 0);
  assert.equal(parseWalletdTime("not a time"), 0);
});

test("extractChainPays: only this component's pays, deduped, oldest→newest, with timestamps", () => {
  // transactions.list is newest-first.
  const txs = [
    tx("t3", "2026-11-04 15:00:00.0", [payEv(COMP, { amount: "2", memo: "我想你", merchant: SHOP, spent: "1499" })]),
    tx("t2", "2026-11-04 12:00:00.0", [
      payEv(OTHER, { amount: "9", memo: "other-budget", merchant: SHOP, spent: "9" }), // different component → excluded
      { topic: "std.vault.pay_fee", substate_id: COMP, payload: { amount: 200000 } },  // not a pay → excluded
    ]),
    tx("t1", "2026-11-04 09:00:00.0", [payEv(COMP, { amount: "10", memo: "first", merchant: SHOP, spent: "10" })]),
    tx("tDry", "2026-11-04 16:00:00.0", [payEv(COMP, { amount: "5", memo: "dry", merchant: SHOP, spent: "5" })], { dryRun: true }),
  ];
  const { rows, tsByTxId } = extractChainPays(txs, COMP);
  assert.deepEqual(rows.map((r) => r.memo), ["first", "我想你"]); // oldest→newest; OTHER/fee/dry-run dropped
  assert.deepEqual(rows.map((r) => r.txId), ["t1", "t3"]);
  assert.equal(rows[0].amount, "10");
  // the duplicated copy of each event within a tx collapses (one row per real pay)
  assert.equal(rows.filter((r) => r.txId === "t3").length, 1);
  // timestamps are recorded for every tx (even the fee-only / dry-run ones) so journal rows can order
  assert.ok(tsByTxId.get("t3") > tsByTxId.get("t1"));
  assert.ok(tsByTxId.has("tDry"));
});

test("mergeLedgers: journal wins on a matching tx; chain-only pays are added; ordered by time", () => {
  const label = (a) => (a === SHOP ? "shop" : null);
  // Journal knows only t1 (made by this dashboard, with a free-text memo).
  const journal = [
    { index: 0, merchant: SHOP, merchantName: "shop", amount: "10", memo: "typed-in-ui", onchainMemo: "ap1|x|agent", txKind: "pay", status: "confirmed", txId: "t1" },
  ];
  const scan = extractChainPays([
    { id: "t3", last_update_time: "2026-11-04 15:00:00.0", is_dry_run: false, finalize: { events: [payEv(COMP, { amount: "2", memo: "我想你", merchant: SHOP, spent: "1499" })] } },
    { id: "t1", last_update_time: "2026-11-04 09:00:00.0", is_dry_run: false, finalize: { events: [payEv(COMP, { amount: "10", memo: "ap1|x|agent", merchant: SHOP, spent: "10" })] } },
  ], COMP);

  const merged = mergeLedgers(journal, scan, label);
  assert.equal(merged.length, 2); // t1 (from journal, not duplicated) + t3 (chain-only)
  assert.deepEqual(merged.map((e) => e.txId), ["t1", "t3"]); // oldest→newest
  assert.deepEqual(merged.map((e) => e.index), [0, 1]); // re-indexed
  // the journal row is kept verbatim for the shared tx (free-text memo, no "chain" source tag)
  assert.equal(merged[0].memo, "typed-in-ui");
  assert.equal(merged[0].source, undefined);
  // the external pay is added, tagged as chain-discovered, with its on-chain memo
  assert.equal(merged[1].memo, "我想你");
  assert.equal(merged[1].source, "chain");
  assert.equal(merged[1].merchantName, "shop");
});

test("mergeLedgers: with no journal rows, every on-chain pay appears", () => {
  const label = () => null;
  const scan = extractChainPays([
    { id: "a", last_update_time: "2026-11-04 10:00:00.0", is_dry_run: false, finalize: { events: [payEv(COMP, { amount: "1", memo: "m1", merchant: SHOP, spent: "1" })] } },
    { id: "b", last_update_time: "2026-11-04 11:00:00.0", is_dry_run: false, finalize: { events: [payEv(COMP, { amount: "2", memo: "m2", merchant: SHOP, spent: "3" })] } },
  ], COMP);
  const merged = mergeLedgers([], scan, label);
  assert.deepEqual(merged.map((e) => e.memo), ["m1", "m2"]);
  assert.ok(merged.every((e) => e.source === "chain"));
});
