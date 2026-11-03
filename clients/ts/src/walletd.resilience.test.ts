/**
 * Four-state resilience of the TS WalletdClient: accept / reject / pending / transient, plus the
 * D-5 guard that a REAL submit is never auto-resubmitted on an auth-looking error.
 *
 * The "unknown ≠ failure" contract (H5): a SUBMITTED-but-unresolved tx must surface as pending
 * (e.pending) or at least leave `lastTxId` set, so the server records it UNKNOWN and reconciles —
 * never a hard failure, which a caller reads as "safe to retry" → double-spend. Only a finalized
 * chain Reject is a hard failure, flagged `chainRejected`.
 *     npm run build && node --test dist/walletd.resilience.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { WalletdClient } from "./walletd";

type Handler = any | ((body: any) => any);

/** A fake global fetch that replays a scripted JSON-RPC response per method (or a thrown error). */
function installFetch(script: Record<string, Handler>, calls: any[] = []): any[] {
  (globalThis as any).fetch = async (_url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const h = script[body.method];
    if (h === undefined) throw new Error("unexpected method " + body.method);
    const payload = typeof h === "function" ? h(body) : h;
    return { json: async () => payload };
  };
  return calls;
}

const SUBMIT = "transactions.submit_manifest";
const GETRES = "transactions.get_result";

test("run returns the result on a finalized Accept", async () => {
  installFetch({ [SUBMIT]: { result: { transaction_id: "tx1" } }, [GETRES]: { result: { Accept: { ok: 1 } } } });
  const c = new WalletdClient("http://fake", { token: "t" });
  assert.deepEqual(await c.run("m", {}), { Accept: { ok: 1 } });
});

test("run flags chainRejected (and NOT pending) on a finalized Reject", async () => {
  installFetch({ [SUBMIT]: { result: { transaction_id: "tx1" } }, [GETRES]: { result: { Reject: "over cap" } } });
  const c = new WalletdClient("http://fake", { token: "t" });
  await assert.rejects(() => c.run("m", {}), (e: any) => e.chainRejected === true && !e.pending);
});

test("run times out as pending, carrying the tx id", async () => {
  installFetch({ [SUBMIT]: { result: { transaction_id: "tx9" } }, [GETRES]: { result: {} } });
  const c = new WalletdClient("http://fake", { token: "t", finalizeTries: 2, finalizeDelayMs: 1 });
  await assert.rejects(() => c.run("m", {}), (e: any) => e.pending === true && e.txId === "tx9");
});

test("a thrown fetch on a REAL submit is pending (submitted-but-unknown), not a hard failure", async () => {
  (globalThis as any).fetch = async () => { throw new Error("ECONNRESET"); };
  const c = new WalletdClient("http://fake", { token: "t" });
  await assert.rejects(() => c.run("m", {}), (e: any) => e.pending === true);
});

test("a transport blip during the confirm poll leaves lastTxId set (server → UNKNOWN)", async () => {
  (globalThis as any).fetch = async (_u: string, opts: any) => {
    const b = JSON.parse(opts.body);
    if (b.method === SUBMIT) return { json: async () => ({ result: { transaction_id: "tx5" } }) };
    throw new Error("socket hang up"); // get_result blips after a successful submit
  };
  const c = new WalletdClient("http://fake", { token: "t", finalizeTries: 2, finalizeDelayMs: 1 });
  await assert.rejects(() => c.run("m", {}));
  assert.equal(c.lastTxId, "tx5"); // submittedTxId() non-empty → the server records UNKNOWN, not rejected
});

test("a REAL submit is NOT auto-resubmitted on an auth-looking error (D-5)", async () => {
  const calls = installFetch({
    "auth.request": { result: { token: "minted" } },
    [SUBMIT]: { error: { message: "Access denied by a template access rule" } },
  });
  const c = new WalletdClient("http://fake"); // internally-minted token (tokenIsExternal = false)
  await c.connect();
  await assert.rejects(() => c.run("m", {}));
  const submits = calls.filter((b) => b.method === SUBMIT);
  assert.equal(submits.length, 1, "a real submit must never be resubmitted on an auth-looking error (H5/D-5)");
});

test("a dry run IS still re-minted & retried when an internally-minted token expires", async () => {
  // The auth-retry is preserved for non-state-changing calls: a dry run that hits an expired token
  // re-mints once and retries (only a REAL submit and an external token are excluded).
  let firstDry = true;
  const calls = installFetch({
    "auth.request": { result: { token: "fresh" } },
    [SUBMIT]: (b: any) => {
      if (b.params.dry_run && firstDry) { firstDry = false; return { error: { message: "Expired token" } }; }
      return { result: { result: { Accept: {} } } };
    },
  });
  const c = new WalletdClient("http://fake"); // internally-minted token (tokenIsExternal = false)
  await c.connect();
  firstDry = true;
  await c.dryRun("m", {});
  const dryCalls = calls.filter((b) => b.method === SUBMIT && b.params.dry_run);
  assert.equal(dryCalls.length, 2, "an expired-token dry run is re-minted and retried once");
});
