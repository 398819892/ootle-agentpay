/**
 * payEvents topic parsing (ledger correctness). The engine namespaces a template event topic as
 * "<Struct>.<event>", so a real AgentBudget pay carries topic "AgentBudget.pay" — NOT a bare "pay".
 * A strict `topic === "pay"` check silently dropped every real pay event, emptying the dashboard
 * ledger. These assert the final-segment match: "AgentBudget.pay" is a pay, "AgentBudget.pay_via_escrow"
 * and "std.vault.pay_fee" are not, and the duplicate copy of one event (same spent_in_window) collapses.
 *     npm run build && node --test dist/budget.events.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OnChainBudget } from "./budget";

const SHOP = "component_" + "1".repeat(64);

function ev(topic: string, payload: Record<string, unknown>) {
  return { topic, substate_id: "component_" + "9".repeat(64), payload };
}

test("payEvents matches the namespaced AgentBudget.pay topic and excludes escrow/fee", () => {
  const pay1 = ev("AgentBudget.pay", { merchant: SHOP, amount: "100", memo: "m", spent_in_window: "100" });
  const pay2 = ev("AgentBudget.pay", { merchant: SHOP, amount: "100", memo: "m", spent_in_window: "200" });
  const escrow = ev("AgentBudget.pay_via_escrow", { merchant: SHOP, amount: "100", memo: "m" });
  const fee = ev("std.vault.pay_fee", { amount: 200000 });
  const all = [pay1, pay2, escrow, fee];
  // Each event appears twice in a real finalized result (two subtrees) — the de-dup must collapse copies.
  const result = { result: { events: all }, receipt: { Accept: { events: all } } };

  const got = OnChainBudget.payEvents(result);
  assert.equal(got.length, 2, "two distinct pays kept (by spent_in_window), copies collapsed, escrow/fee excluded");
  assert.deepEqual(got.map((p) => p.spent_in_window), ["100", "200"]);
});

test("payEvents still accepts a bare 'pay' topic (older templates) and drops a bare 'pay_fee'", () => {
  const bare = ev("pay", { merchant: SHOP, amount: "5", memo: "x", spent_in_window: "5" });
  const fee = ev("pay_fee", { amount: 1 });
  const got = OnChainBudget.payEvents({ result: { events: [bare, fee] } });
  assert.equal(got.length, 1);
  assert.equal(got[0].amount, "5");
});
