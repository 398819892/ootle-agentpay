/**
 * Proof authorization windows (tari-ootle 0.49, #3206). A workspace proof authorizes nothing until
 * `authorize!(proof)` opens a window over it, so every OWNER-badge manifest must open one around the
 * owner-gated call and close it (`drop_authorize!`) before dropping the proof. The agent's `pay`
 * proof is only shown to the template (an argument it reads), so it never needs a window. A 0.47
 * parser does not know the macros: `{ proofWindows: false }` (or `AGENTPAY_PROOF_WINDOWS=0`) keeps
 * the old dialect. Mirrors the Python SDK's `test_owner_calls_open_a_proof_window*`.
 *     npm run build && node --test dist/budget.authz.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OnChainBudget } from "./budget";
import { WalletdClient } from "./walletd";

const TPL = "template_" + "7".repeat(64);
const OWNER = "component_" + "9".repeat(64);
const SHOP = "component_" + "1".repeat(64);
const OWNER_BADGE = "resource_" + "a".repeat(64);
const AGENT_BADGE = "resource_" + "b".repeat(64);

class FakeWalletd extends WalletdClient {
  runs: Array<{ manifest: string; variables: Record<string, string> }> = [];
  constructor() {
    super("http://fake");
  }
  async connect(): Promise<this> {
    return this;
  }
  async run(manifest: string, variables: Record<string, string>): Promise<any> {
    this.runs.push({ manifest, variables });
    return { result: { Accept: {} } };
  }
}

function mounted(opts: { proofWindows?: boolean } = {}): { b: OnChainBudget; fake: FakeWalletd } {
  const fake = new FakeWalletd();
  const b = new OnChainBudget(fake, TPL, OWNER, opts);
  b.component = "component_" + "c".repeat(64);
  b.ownerBadge = OWNER_BADGE;
  b.agentBadge = AGENT_BADGE;
  b.perTxCap = "1000";
  b.dailyCap = "3000";
  b.whitelist = [SHOP];
  return { b, fake };
}

/** Index of `needle` in `m`, asserting it occurs exactly once. */
function at(m: string, needle: string): number {
  const i = m.indexOf(needle);
  assert.ok(i >= 0, `missing ${needle} in:\n${m}`);
  assert.equal(m.indexOf(needle, i + 1), -1, `${needle} occurs more than once`);
  return i;
}

test("owner calls open a window around the owner-gated call (0.49 dialect, the default)", async () => {
  const { b, fake } = mounted();
  assert.equal(b.proofWindows, true);
  await b.setLimits(250, 900);
  await b.withdraw(100);
  await b.issueAgentBadge("s2");
  await b.revokeSession("s2");
  assert.equal(fake.runs.length, 4);
  for (const { manifest: m } of fake.runs) {
    const create = at(m, `owner.create_proof_for_resource(address!("${OWNER_BADGE}"));`);
    const open = at(m, "\n    authorize!(proof);");
    const close = at(m, "drop_authorize!(proof);");
    const drop = at(m, "drop_all_proofs!();");
    const call = m.indexOf("budget.");
    // create → authorize! → the budget call → drop_authorize! → drop_all_proofs!
    assert.ok(create < open && open < call && call < close && close < drop, m);
  }
});

test("the agent's pay proof is only shown: no window on either dialect", async () => {
  for (const proofWindows of [true, false]) {
    const { b, fake } = mounted({ proofWindows });
    await b.pay(SHOP, 10, { memo: "m" });
    const m = fake.runs[0].manifest;
    assert.ok(m.includes("create_proof_by_non_fungible_ids("));
    assert.ok(m.includes("budget.pay(proof, "));
    assert.ok(!m.includes("authorize!("), m);
    assert.ok(m.includes("drop_all_proofs!();"));
  }
});

test("{ proofWindows: false } keeps the pre-0.49 dialect for a 0.47 walletd", async () => {
  const { b, fake } = mounted({ proofWindows: false });
  assert.equal(b.proofWindows, false);
  await b.setLimits(250, 900);
  const m = fake.runs[0].manifest;
  assert.ok(m.includes(`owner.create_proof_for_resource(address!("${OWNER_BADGE}"));`));
  assert.ok(m.includes("budget.set_limits(amount!(250), amount!(900));"));
  assert.ok(m.includes("drop_all_proofs!();"));
  assert.ok(!m.includes("authorize!("), m);
});

test("AGENTPAY_PROOF_WINDOWS=0 is the environment form of the switch", () => {
  const prev = process.env.AGENTPAY_PROOF_WINDOWS;
  try {
    process.env.AGENTPAY_PROOF_WINDOWS = "0";
    assert.equal(new OnChainBudget(new FakeWalletd(), TPL, OWNER).proofWindows, false);
    process.env.AGENTPAY_PROOF_WINDOWS = "1";
    assert.equal(new OnChainBudget(new FakeWalletd(), TPL, OWNER).proofWindows, true);
    delete process.env.AGENTPAY_PROOF_WINDOWS;
    assert.equal(new OnChainBudget(new FakeWalletd(), TPL, OWNER).proofWindows, true);
    // an explicit option wins over the environment
    process.env.AGENTPAY_PROOF_WINDOWS = "0";
    assert.equal(new OnChainBudget(new FakeWalletd(), TPL, OWNER, { proofWindows: true }).proofWindows, true);
  } finally {
    if (prev === undefined) delete process.env.AGENTPAY_PROOF_WINDOWS;
    else process.env.AGENTPAY_PROOF_WINDOWS = prev;
  }
});
