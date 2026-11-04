/**
 * #3 — a dry-run preflight that could not reach a verdict (transient indexer / transport failure)
 * must NOT be reported as a validator rejection. `wouldReject` surfaces the chain's OWN verdict; when
 * the dry run never got one (the indexer timed out, the connection dropped, walletd answered garbage)
 * it raises a `transient`-flagged ChainError instead, so the server/MCP preflight falls through to the
 * real submit (the chain is the authority) rather than burning the idempotency key on a phantom
 * "rejected". Only a genuine (non-transient) RPC error or a finalized Reject returns a reason; a
 * definitive auth failure is surfaced, NOT flagged transient. Mirrors the Python SDK's
 * test_wouldreject_transient.
 *     npm run build && node --test dist/budget.wouldreject.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OnChainBudget } from "./budget";
import { ChainError } from "./errors";
import { WalletdClient } from "./walletd";

const TPL = "template_" + "7".repeat(64);
const OWNER = "component_" + "9".repeat(64);
const SHOP = "component_" + "1".repeat(64);
const AGENT_BADGE = "resource_" + "b".repeat(64);

class DryRunWalletd extends WalletdClient {
  constructor(private reply: any) {
    super("http://fake");
  }
  async connect(): Promise<this> {
    return this;
  }
  async dryRun(): Promise<any> {
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

function mounted(reply: any): OnChainBudget {
  const b = new OnChainBudget(new DryRunWalletd(reply), TPL, OWNER);
  b.component = "component_" + "c".repeat(64);
  b.agentBadge = AGENT_BADGE;
  b.perTxCap = "1000";
  b.dailyCap = "3000";
  b.whitelist = [SHOP];
  return b;
}

test("a transient RPC error from the dry run raises `transient`, not a reject reason", async () => {
  const b = mounted({ error: { message: "Indexer client error: did not respond within 30s" } });
  await assert.rejects(
    () => b.wouldReject(SHOP, "10"),
    (e: any) => e instanceof ChainError && (e as any).transient === true,
  );
});

test("a genuine (non-transient) dry-run rejection returns the reason", async () => {
  const b = mounted({ error: { message: "amount exceeds the per-transaction cap" } });
  const reason = await b.wouldReject(SHOP, "10");
  assert.ok(reason && reason.includes("per-transaction cap"), reason ?? "(null)");
});

test("a thrown transport failure is re-flagged `transient`", async () => {
  const b = mounted(new ChainError("fetch failed: ECONNRESET"));
  await assert.rejects(
    () => b.wouldReject(SHOP, "10"),
    (e: any) => e instanceof ChainError && (e as any).transient === true,
  );
});

test("a definitive auth failure is surfaced, NOT flagged transient", async () => {
  const authErr: any = new ChainError("Unauthorized");
  authErr.authFailed = true;
  const b = mounted(authErr);
  await assert.rejects(
    () => b.wouldReject(SHOP, "10"),
    (e: any) => e instanceof ChainError && (e as any).authFailed === true && (e as any).transient !== true,
  );
});

test("an acceptable pay returns null", async () => {
  const b = mounted({ result: {} });
  assert.equal(await b.wouldReject(SHOP, "10"), null);
});
