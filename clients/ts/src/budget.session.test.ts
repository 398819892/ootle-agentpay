//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause

// Session selection in the pay proof: the client must prove EXACTLY ONE agent session badge
// (the template rejects a proof carrying several — the guard behind `revoke_session`). A plain
// `create_proof_for_resource` carries every token of the resource the account holds, so as soon as
// a second session badge lands in the agent account every payment would be refused. The client
// therefore proves one specific non-fungible id: `"default"` unless told otherwise.

import assert from "node:assert/strict";
import test from "node:test";

import { OnChainBudget } from "./budget";
import { ChainError } from "./errors";
import { WalletdClient } from "./walletd";

const TPL = "template_" + "7".repeat(64);
const OWNER = "component_" + "9".repeat(64);
const SHOP = "component_" + "1".repeat(64);
const AGENT_BADGE = "resource_" + "b".repeat(64);

class FakeWalletd extends WalletdClient {
  runs: Array<{ manifest: string; variables: Record<string, string> }> = [];
  dryRuns: Array<{ manifest: string; variables: Record<string, string> }> = [];
  constructor() {
    super("http://127.0.0.1:1/json_rpc");
  }
  async run(manifest: string, variables: Record<string, string>): Promise<any> {
    this.runs.push({ manifest, variables });
    return { result: {} };
  }
  async dryRun(manifest: string, variables: Record<string, string>): Promise<any> {
    this.dryRuns.push({ manifest, variables });
    return { result: {} };
  }
}

function budget(): { b: OnChainBudget; fake: FakeWalletd } {
  const fake = new FakeWalletd();
  const b = new OnChainBudget(fake, TPL, OWNER);
  b.component = "component_" + "c".repeat(64);
  b.agentBadge = AGENT_BADGE;
  b.ownerBadge = "resource_" + "a".repeat(64);
  b.perTxCap = "1000";
  b.dailyCap = "5000";
  b.whitelist = [SHOP];
  return { b, fake };
}

const PROOF = (session: string) =>
  `agent.create_proof_by_non_fungible_ids(address!("${AGENT_BADGE}"), [non_fungible_id!("${session}")])`;

test("pay proves exactly the default session badge by id (not the whole resource)", async () => {
  const { b, fake } = budget();
  await b.pay(SHOP, 100, { memo: "m" });
  const m = fake.runs[0].manifest;
  assert.ok(m.includes(PROOF("default")), m);
  assert.ok(!m.includes("create_proof_for_resource"), "must not prove the whole resource");
});

test("a per-call session, the client's session field, and payInvoice all select the badge", async () => {
  const { b, fake } = budget();
  await b.pay(SHOP, 100, { session: "key-bot1" });
  assert.ok(fake.runs[0].manifest.includes(PROOF("key-bot1")));
  b.session = "agent-2";
  await b.pay(SHOP, 100);
  assert.ok(fake.runs[1].manifest.includes(PROOF("agent-2")));
  await b.payInvoice({ merchant: SHOP, invoiceId: "deadbeef", amount: 50, session: "key-x" });
  assert.ok(fake.runs[2].manifest.includes(PROOF("key-x")));
  await b.wouldReject(SHOP, 100, { session: "key-y" });
  assert.ok(fake.dryRuns[0].manifest.includes(PROOF("key-y")));
});

test("a session label that could break out of the literal is refused before any RPC", async () => {
  const { b, fake } = budget();
  for (const bad of ['x") ; owner.withdraw(XTR, amount!(1)); //', "with space", "", "a".repeat(65), "é"]) {
    await assert.rejects(() => b.pay(SHOP, 100, { session: bad }), ChainError);
  }
  assert.equal(fake.runs.length, 0);
});