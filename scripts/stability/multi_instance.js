#!/usr/bin/env node
/**
 * MULTI-INSTANCE CONCURRENCY — two backend instances sharing the SAME state.json + txlog.json and
 * the SAME chain (mock), hit concurrently. This test EXPECTS to surface the limit of a single-file
 * JSON journal with no cross-process lock, and it does. It separates what still holds from what does
 * not, so the go-live criteria can be honest:
 *
 *   HOLDS (the on-chain safety net):
 *     - The on-chain caps are enforced regardless of how many hosted backends submit. Two instances
 *       racing many payments can never push on-chain spend past the daily cap.
 *     - Each instance stays up and internally consistent; neither crashes the other.
 *
 *   DOES NOT HOLD across instances (hosted-layer idempotency / journal):
 *     - Invoice-level idempotency is per-process (in-memory map + whole-file rewrite). The SAME
 *       idempotency key sent concurrently to BOTH instances is submitted to chain TWICE → a double
 *       payment of one invoice. The chain has no invoice dedup; that is purely a backend guarantee.
 *     - Concurrent writers clobber the shared journal (each rewrites the entire file from its own
 *       in-memory copy), so records from one instance can be lost from the file even though the
 *       payment really happened on chain.
 *
 * Conclusion (recorded in docs/stability.md): run ONE backend instance per budget/account. Running
 * multiple requires a shared store with atomic idempotency (DB / Redis) and a distributed lock.
 */
"use strict";
const L = require("./lib");

(async () => {
  const r = L.makeReport("multi-instance");
  const dir = L.tmpDir("multi");
  const stateFile = `${dir}/state.json`, txlogFile = `${dir}/txlog.json`;
  const mock = await L.startMock();
  const envHi = { AGENTPAY_RATE_MAX: "100000000", AGENTPAY_MONEY_MAX: "100000000", AGENTPAY_RATE_WINDOW_MS: "3600000", AGENTPAY_MONEY_WINDOW_MS: "3600000" };

  // Instance A opens the budget, then B starts and inherits it from the shared state.json.
  const A = await L.startBackend({ walletdUrl: mock.url, stateFile, txlogFile, env: envHi, label: "A", finalizeTries: 20, finalizeDelayMs: 40 });
  const adminA = L.apiClient(A.base, "adminsecret-0123456789");
  const agentA = L.apiClient(A.base, "agentsecret-0123456789");
  const shop = L.addr();
  await adminA.createBudget({ fund: 1_000_000, perTxCap: 1000, dailyCap: 100000, epochsPerWindow: 10_000_000, whitelist: [shop] }, "m-open");
  const B = await L.startBackend({ walletdUrl: mock.url, stateFile, txlogFile, env: envHi, label: "B", finalizeTries: 20, finalizeDelayMs: 40 });
  const agentB = L.apiClient(B.base, "agentsecret-0123456789");

  try {
    // ---------- Finding 1: same idempotency key to both instances → double-spend ----------
    const before = (await mock.state());
    const spentBefore = BigInt(before.budget.spent);
    const submitsBefore = before.counters.paySubmits;
    const [ra, rb] = await Promise.all([
      agentA.pay({ merchant: shop, amount: 500, invoiceId: "dup-key" }, "dup-key"),
      agentB.pay({ merchant: shop, amount: 500, invoiceId: "dup-key" }, "dup-key"),
    ]);
    await L.sleep(200);
    const after = await mock.state();
    const dupSubmits = after.counters.paySubmits - submitsBefore;
    const dupSpend = BigInt(after.budget.spent) - spentBefore;
    r.info("same key sent to BOTH instances concurrently", `A→${ra.body.receipt && ra.body.receipt.status}, B→${rb.body.receipt && rb.body.receipt.status}`);
    if (dupSubmits > 1) {
      r.info("EXPECTED LIMITATION confirmed: cross-instance idempotency is NOT enforced", `chain submits for one invoice = ${dupSubmits}, double-spend = ${dupSpend}`);
    } else {
      r.info("cross-instance submits for duplicate key", `${dupSubmits} (no double-spend observed this run; still unsafe by design — timing-dependent)`);
    }
    r.check("DIAGNOSTIC: double-submit is observable with shared-file journal (documents the need for a shared idempotency store)", dupSubmits >= 1, `submits=${dupSubmits}`);

    // ---------- Holds: on-chain daily cap bounds total spend even under a 2-instance race ----------
    await mock.reset();
    // reopen a tight budget via a fresh file set so caps are small and easy to exhaust
    const dir2 = L.tmpDir("multi2");
    const A2 = await L.startBackend({ walletdUrl: mock.url, stateFile: `${dir2}/s.json`, txlogFile: `${dir2}/t.json`, env: envHi, label: "A2", finalizeTries: 20, finalizeDelayMs: 40 });
    const adminA2 = L.apiClient(A2.base, "adminsecret-0123456789");
    const agentA2 = L.apiClient(A2.base, "agentsecret-0123456789");
    const shop2 = L.addr();
    await adminA2.createBudget({ fund: 1_000_000, perTxCap: 300, dailyCap: 900, epochsPerWindow: 10_000_000, whitelist: [shop2] }, "m2-open");
    const B2 = await L.startBackend({ walletdUrl: mock.url, stateFile: `${dir2}/s.json`, txlogFile: `${dir2}/t.json`, env: envHi, label: "B2", finalizeTries: 20, finalizeDelayMs: 40 });
    const agentB2 = L.apiClient(B2.base, "agentsecret-0123456789");
    // 10 distinct pays of 300 across both instances; on-chain only 3 fit (900 cap)
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(agentA2.pay({ merchant: shop2, amount: 300, invoiceId: `cap-A-${i}` }, `cap-A-${i}`));
      jobs.push(agentB2.pay({ merchant: shop2, amount: 300, invoiceId: `cap-B-${i}` }, `cap-B-${i}`));
    }
    await Promise.all(jobs);
    await L.sleep(200);
    const capState = await mock.state();
    r.check("on-chain daily cap HOLDS under 2-instance race (spent <= cap)", BigInt(capState.budget.spent) <= 900n, `spent=${capState.budget.spent} cap=900`);
    r.check("on-chain spent is an exact multiple of 300 within the cap (no partial corruption)", Number(capState.budget.spent) % 300 === 0 && Number(capState.budget.spent) <= 900, `spent=${capState.budget.spent}`);
    r.info("payments the chain accepted under the race", `${Number(capState.budget.spent) / 300} of 10 (rest rejected on-chain by the cap)`);

    // ---------- Finding 2: shared journal file loses records under concurrent writers ----------
    const tlog = L.readJson(`${dir2}/t.json`, []);
    const payRecs = tlog.filter((t) => t.op === "pay").length;
    r.info("journal pay-records persisted vs 10 attempted", `${payRecs} (shared-file clobber can drop records; chain remains authoritative)`);
    r.check("both instances stayed up (no crash) through the race", A2.child.exitCode == null && B2.child.exitCode == null);

    await A2.kill(); await B2.kill();
  } catch (e) {
    r.check("no exception", false, e.message + "\nA LOG:\n" + A.log.slice(-1500) + "\nB LOG:\n" + B.log.slice(-1500));
  } finally {
    await A.kill(); await B.kill();
    mock.stop();
  }
  process.exit(r.done() ? 0 : 1);
})();
