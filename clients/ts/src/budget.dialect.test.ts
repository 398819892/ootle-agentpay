/**
 * P1-3: a walletd dialect mismatch on an owner-badge call is ATTRIBUTABLE, not a bare parser
 * rejection. Owner manifests use `authorize!`/`drop_authorize!` on the 0.49 dialect and omit them on
 * 0.47, and walletd exposes no version RPC to auto-detect which one the daemon speaks — so the
 * dialect defaults to a guess. When it was a guess, an owner-call failure is enriched with a hint
 * pointing at `AGENTPAY_PROOF_WINDOWS`; when the operator chose the dialect explicitly, or the
 * failure is a transport/token auth error (`authFailed`), the hint is suppressed. Mirrors the Python
 * SDK's `test_owner_call_failure_carries_dialect_hint*`.
 *     npm run build && node --test dist/budget.dialect.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OnChainBudget } from "./budget";
import { ChainError } from "./errors";
import { WalletdClient } from "./walletd";

const TPL = "template_" + "7".repeat(64);
const OWNER = "component_" + "9".repeat(64);
const OWNER_BADGE = "resource_" + "a".repeat(64);

/** A client whose `run` always throws `err`, so we observe how an owner call surfaces the failure. */
function ownerBudgetThatRejects(err: Error, opts: { proofWindows?: boolean } = {}): OnChainBudget {
  class Rejecting extends WalletdClient {
    constructor() {
      super("http://fake");
    }
    async connect(): Promise<this> {
      return this;
    }
    async run(): Promise<any> {
      throw err;
    }
  }
  const b = new OnChainBudget(new Rejecting(), TPL, OWNER, opts);
  b.component = "component_" + "c".repeat(64);
  b.ownerBadge = OWNER_BADGE;
  return b;
}

/** Run `fn`, asserting it rejects, and return the thrown error's message. */
async function rejectionMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new assert.AssertionError({ message: "expected a rejection" });
}

const withoutEnv = async (fn: () => Promise<void>): Promise<void> => {
  const prev = process.env.AGENTPAY_PROOF_WINDOWS;
  delete process.env.AGENTPAY_PROOF_WINDOWS;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.AGENTPAY_PROOF_WINDOWS;
    else process.env.AGENTPAY_PROOF_WINDOWS = prev;
  }
};

test("owner-call failure carries the dialect hint when the dialect was a guess", async () => {
  await withoutEnv(async () => {
    const b = ownerBudgetThatRejects(new ChainError("manifest parse error: unknown instruction `authorize!`"));
    assert.equal(b.proofWindowsGuessed, true);
    const msg = await rejectionMessage(() => b.revoke()); // an owner-badge call (uses the window macros)
    assert.ok(msg.includes("AGENTPAY_PROOF_WINDOWS"), msg);
    assert.ok(msg.includes("DEFAULTED"), msg);
  });
});

test("the hint is suppressed when the operator chose the dialect explicitly", async () => {
  await withoutEnv(async () => {
    // explicit option → not a guess, so the error is left as-is
    const b = ownerBudgetThatRejects(new ChainError("manifest parse error"), { proofWindows: true });
    assert.equal(b.proofWindowsGuessed, false);
    const msg = await rejectionMessage(() => b.revoke());
    assert.ok(!msg.includes("AGENTPAY_PROOF_WINDOWS"), msg);
  });
});

test("the hint is suppressed on a transport/token auth failure", async () => {
  await withoutEnv(async () => {
    // a 401/403-equivalent is the auth layer, not the manifest dialect → don't misattribute it
    const err = new ChainError("walletd rejected: Unauthorized");
    (err as any).authFailed = true;
    const b = ownerBudgetThatRejects(err);
    assert.equal(b.proofWindowsGuessed, true);
    const msg = await rejectionMessage(() => b.revoke());
    assert.ok(!msg.includes("AGENTPAY_PROOF_WINDOWS"), msg);
  });
});
