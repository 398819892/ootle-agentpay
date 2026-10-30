/**
 * Manifest injection guard (issue #7) — TypeScript client.
 *
 * Mirrors `sdk/tests/test_onchain.py`'s injection tests: every value spliced into a transaction
 * manifest is validated at the lowest layer (inside the manifest builders), so a crafted memo /
 * address / session label can never break out of its string literal and inject extra manifest
 * instructions. A fake WalletdClient records manifests instead of talking to a daemon, so no chain
 * is needed. CI type-checks this file via `tsc`; run it with `node --test` after a build:
 *     npm run build && node --test dist/budget.injection.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OnChainBudget, XTR } from "./budget";
import { ChainError } from "./errors";
import { WalletdClient } from "./walletd";

const TPL = "template_" + "7".repeat(64);
const OWNER = "component_" + "9".repeat(64);
const SHOP = "component_" + "1".repeat(64);
const OTHER = "component_" + "2".repeat(64);
const OWNER_BADGE = "resource_" + "a".repeat(64);
const AGENT_BADGE = "resource_" + "b".repeat(64);

/** Records the manifests the adapter builds; returns a canned Accept with no pay events. */
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

function budget(): { b: OnChainBudget; fake: FakeWalletd } {
  const fake = new FakeWalletd();
  const b = new OnChainBudget(fake, TPL, OWNER);
  b.component = "component_" + "c".repeat(64);
  b.ownerBadge = OWNER_BADGE;
  b.agentBadge = AGENT_BADGE;
  b.perTxCap = "1000";
  b.dailyCap = "3000";
  b.whitelist = [SHOP];
  return { b, fake };
}

// Memos that try to close the string literal and append their own instructions, plus the raw
// characters a literal can't safely carry.
const INJECTION_MEMOS = [
  'x"); owner.withdraw(amount!(999999)); agent.deposit("',
  'a"); drop_all_proofs!(); budget.pay(proof, "',
  'has a " quote',
  "back\\slash",
  "line\nbreak",
  "tab\there",
  "x".repeat(254), // over the 253-byte limit
];

test("pay rejects every injection memo and builds no tainted manifest", async () => {
  for (const memo of INJECTION_MEMOS) {
    const { b, fake } = budget();
    await assert.rejects(() => b.pay(SHOP, 100, { memo }), ChainError);
    assert.deepEqual(fake.runs, []); // nothing reached the daemon
  }
});

test("pay rejects a non-hex / malformed merchant address", async () => {
  const bad = [
    "component_not_hex",
    "component_" + "a".repeat(63),
    "resource_" + "a".repeat(64),
    'component_' + "a".repeat(64) + '"); drop_all_proofs!(); //',
    "component_" + "A".repeat(64), // uppercase hex rejected
  ];
  for (const m of bad) {
    const { b, fake } = budget();
    b.whitelist = []; // skip the friendly whitelist pre-check so the manifest-layer guard is hit
    await assert.rejects(() => b.pay(m, 100, { memo: "ok" }), ChainError);
    assert.deepEqual(fake.runs, []);
  }
});

test("open rejects injection in the template address and whitelist", async () => {
  const fake1 = new FakeWalletd();
  const b1 = new OnChainBudget(fake1, 'template_x") as Evil; use template_' + "0".repeat(64), OWNER);
  await assert.rejects(
    () => b1.open({ fund: 1000, perTxCap: 100, dailyCap: 300, epochsPerWindow: 48, whitelist: [SHOP] }),
    ChainError,
  );
  assert.deepEqual(fake1.runs, []);

  const fake2 = new FakeWalletd();
  const b2 = new OnChainBudget(fake2, TPL, OWNER);
  await assert.rejects(
    () =>
      b2.open({
        fund: 1000,
        perTxCap: 100,
        dailyCap: 300,
        epochsPerWindow: 48,
        whitelist: ['component_' + "a".repeat(64) + '"), address!("component_evil'],
      }),
    ChainError,
  );
  assert.deepEqual(fake2.runs, []);
});

test("session labels with manifest-breaking characters are rejected", async () => {
  const bad = ['default"); revoke(); budget.issue_agent_badge("x', "has space", "a".repeat(65), 'quote"'];
  for (const s of bad) {
    const { b, fake } = budget();
    await assert.rejects(() => b.issueAgentBadge(s), ChainError);
    await assert.rejects(() => b.revokeSession(s), ChainError);
    assert.deepEqual(fake.runs, []);
  }
});

test("legitimate memo, invoice memo and addresses still build a well-formed manifest", async () => {
  const { b, fake } = budget();
  await b.pay(SHOP, 500, { memo: "order #42 — café latte" }); // punctuation / unicode is fine
  assert.ok(
    fake.runs[fake.runs.length - 1].manifest.includes(
      `budget.pay(proof, address!("${SHOP}"), amount!(500), "order #42 — café latte")`,
    ),
  );

  await b.payInvoice({ merchant: SHOP, invoiceId: "deadbeef", amount: 200, agentTag: "shopper" });
  assert.ok(fake.runs[fake.runs.length - 1].manifest.includes('"ap1|deadbeef|shopper"'));

  await b.addMerchant(OTHER); // valid component address passes
  await b.issueAgentBadge("session-1.default"); // valid label passes
  assert.equal(XTR, "XTR");
});
