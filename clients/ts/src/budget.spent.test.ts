//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause

// D-4: pay() must track the window spend from the chain's OWN running total (`spent_in_window`, carried
// in each pay event), NOT by accumulating amounts locally. A local accumulator keeps growing past a
// lazy on-chain window reset and misses spends by other sessions of the same budget, so the client
// daily-cap pre-check drifts out of sync with the chain. Mirrors the Python SDK (onchain.py).
//     npm run build && node --test dist/budget.spent.test.js

import assert from "node:assert/strict";
import test from "node:test";

import { OnChainBudget } from "./budget";
import { WalletdClient } from "./walletd";

const TPL = "template_" + "7".repeat(64);
const OWNER = "component_" + "9".repeat(64);
const SHOP = "component_" + "1".repeat(64);
const AGENT_BADGE = "resource_" + "b".repeat(64);

class PayWalletd extends WalletdClient {
  next: any = { result: {} };
  constructor() {
    super("http://127.0.0.1:1/json_rpc");
  }
  async run(): Promise<any> {
    return this.next;
  }
  async dryRun(): Promise<any> {
    return { result: {} };
  }
}

function budget(): { b: OnChainBudget; fake: PayWalletd } {
  const fake = new PayWalletd();
  const b = new OnChainBudget(fake, TPL, OWNER);
  b.component = "component_" + "c".repeat(64);
  b.agentBadge = AGENT_BADGE;
  b.ownerBadge = "resource_" + "a".repeat(64);
  b.perTxCap = "1000";
  b.dailyCap = "5000";
  b.whitelist = [SHOP];
  return { b, fake };
}

// A finalized result carrying one AgentBudget.pay event. `spentInWindow === undefined` omits the field.
function payResult(spentInWindow: string | undefined, amount = "100", merchant = SHOP, memo = "m") {
  const payload: Record<string, unknown> = { merchant, amount, memo };
  if (spentInWindow !== undefined) payload.spent_in_window = spentInWindow;
  const e = { topic: "AgentBudget.pay", substate_id: "component_" + "9".repeat(64), payload };
  return { result: { events: [e] } };
}

test("pay() mirrors the chain's spent_in_window, not a local sum of amounts", async () => {
  const { b, fake } = budget();
  // The chain reports the window total is 700, even though THIS pay is 100 (e.g. other sessions spent).
  fake.next = payResult("700", "100");
  await b.pay(SHOP, 100, { memo: "m" });
  assert.equal(b.spent, "700"); // mirrors the chain; local accumulation would give "100"
});

test("spent follows the chain across a window reset instead of growing unbounded", async () => {
  const { b, fake } = budget();
  fake.next = payResult("900", "100");
  await b.pay(SHOP, 100, { memo: "m" });
  assert.equal(b.spent, "900");
  // The on-chain window rolled over: the next pay's running total RESETS to a small value.
  fake.next = payResult("100", "100");
  await b.pay(SHOP, 100, { memo: "m" });
  assert.equal(b.spent, "100"); // NOT 900 + 100 — a local accumulator would wrongly read "1000"
});

test("falls back to local accumulation when an event omits spent_in_window", async () => {
  const { b, fake } = budget();
  fake.next = payResult(undefined, "100");
  await b.pay(SHOP, 100, { memo: "m" });
  assert.equal(b.spent, "100");
  fake.next = payResult(undefined, "50");
  await b.pay(SHOP, 50, { memo: "m" });
  assert.equal(b.spent, "150"); // 100 + 50 — the documented fallback when the chain omits the field
});
