/**
 * Resource parametrization — the budget is not bound to XTR. `open({ resource })` sets the budget's
 * resource and `topUp` reuses it: the manifest splices the `XTR` keyword for the native token, or a
 * strictly-validated `address!("resource_…")` for anything else (never a raw string). Mirrors the
 * Python SDK's `test_resource_parametrization_uses_address_not_xtr`.
 *     npm run build && node --test dist/budget.resource.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OnChainBudget, XTR } from "./budget";
import { ChainError } from "./errors";
import { WalletdClient } from "./walletd";

const TPL = "template_" + "7".repeat(64);
const OWNER = "component_" + "9".repeat(64);
const SHOP = "component_" + "1".repeat(64);
const RESCOIN = "resource_" + "d".repeat(64);

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

function mounted(resource?: string): { b: OnChainBudget; fake: FakeWalletd } {
  const fake = new FakeWalletd();
  const b = new OnChainBudget(fake, TPL, OWNER);
  b.component = "component_" + "c".repeat(64);
  b.ownerBadge = "resource_" + "a".repeat(64);
  b.agentBadge = "resource_" + "b".repeat(64);
  if (resource) b.resource = resource;
  return { b, fake };
}

test("default resource is XTR: topUp withdraws with the XTR keyword", async () => {
  const { b, fake } = mounted();
  assert.equal(b.resource, XTR);
  await b.topUp(500);
  assert.ok(fake.runs[0].manifest.includes("withdraw(XTR, amount!(500))"));
});

test("a non-XTR budget splices a validated address!(\"resource_…\"), not XTR", async () => {
  const { b, fake } = mounted(RESCOIN);
  await b.topUp(500);
  const m = fake.runs[0].manifest;
  assert.ok(m.includes(`withdraw(address!("${RESCOIN}"), amount!(500))`));
  assert.ok(!m.includes("withdraw(XTR"));
});

test("open({ resource }) records the resource and funds the budget in it", async () => {
  const fake = new FakeWalletd();
  const b = new OnChainBudget(fake, TPL, OWNER);
  // open() needs a new component + two badges in the result and a readable component state; this
  // fake has neither, so open() throws AFTER the manifest was built and submitted — which is all we
  // need to inspect here.
  await assert.rejects(() =>
    b.open({ fund: 1000, perTxCap: 100, dailyCap: 300, epochsPerWindow: 48, whitelist: [SHOP], resource: RESCOIN }),
  );
  assert.equal(b.resource, RESCOIN);
  assert.ok(fake.runs[0].manifest.includes(`owner.withdraw(address!("${RESCOIN}"), amount!(1000))`));
});

test("a malformed resource address is rejected before any manifest reaches the daemon", async () => {
  const { b, fake } = mounted("resource_not_hex");
  await assert.rejects(() => b.topUp(500), ChainError);
  assert.deepEqual(fake.runs, []);
});
