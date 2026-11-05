/**
 * WalletdClient.listTransactions — the read-only `transactions.list` wrapper the dashboard uses to
 * rebuild the payment ledger from chain (every AgentBudget pay, including pays made by other
 * clients). Returns the `transactions` array, tolerates a missing array, and surfaces an RPC error.
 *     npm run build && node --test dist/walletd.txlist.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { WalletdClient } from "./walletd";

function installFetch(script: Record<string, any>, calls: any[] = []): any[] {
  (globalThis as any).fetch = async (_url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const h = script[body.method];
    if (h === undefined) throw new Error("unexpected method " + body.method);
    return { json: async () => (typeof h === "function" ? h(body) : h) };
  };
  return calls;
}

test("listTransactions returns the transactions array and passes offset/limit", async () => {
  const calls = installFetch({
    "transactions.list": { result: { transactions: [{ id: "t1" }, { id: "t2" }] } },
  });
  const c = new WalletdClient("http://fake", { token: "t" });
  const txs = await c.listTransactions({ offset: 0, limit: 50 });
  assert.deepEqual(txs.map((t: any) => t.id), ["t1", "t2"]);
  assert.deepEqual(calls[0].params, { offset: 0, limit: 50 });
});

test("listTransactions returns [] when the daemon omits the array", async () => {
  installFetch({ "transactions.list": { result: {} } });
  const c = new WalletdClient("http://fake", { token: "t" });
  assert.deepEqual(await c.listTransactions(), []);
});

test("listTransactions throws a ChainError on an RPC error", async () => {
  installFetch({ "transactions.list": { error: { message: "boom" } } });
  const c = new WalletdClient("http://fake", { token: "t" });
  await assert.rejects(() => c.listTransactions(), /boom/);
});
