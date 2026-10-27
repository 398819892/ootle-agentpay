#!/usr/bin/env node
/**
 * MULTI-INSTANCE CONCURRENCY — two backend instances sharing the SAME state.json + txlog.json (and
 * the claims/ dir beside it) and the SAME chain (mock), hit concurrently.
 *
 * This test used to merely DOCUMENT the shared-file limit. After the cross-process idempotency fix
 * (web/server/claims.js + the merge-under-lock journal persist in web/server/txlog.js) it now
 * ASSERTS that the limit is closed for instances that share one filesystem:
 *
 *   NOW ENFORCED (same-host, shared filesystem):
 *     - The SAME idempotency key sent concurrently to BOTH instances is submitted to chain EXACTLY
 *       ONCE — no double-spend. The losing instance replays the winner's receipt. Repeated over many
 *       rounds so a lucky timing cannot hide a regression.
 *     - Concurrent writers no longer clobber the shared journal: every distinct key's record
 *       survives in the file (merge-under-lock), so no payment is lost from the journal.
 *     - Distinct keys stay independent (no accidental collapsing) and the on-chain daily cap still
 *       bounds total spend under a 2-instance race. Both instances stay up.
 *
 *   STILL NOT HANDLED (documented in docs/stability.md):
 *     - Instances on DIFFERENT hosts with separate filesystems. The filesystem claim only coordinates
 *       processes that share a filesystem. Cross-host needs a real shared store (Postgres / Redis)
 *       with a uniqueness constraint on the idempotency key + a distributed lock.
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
  await adminA.createBudget({ fund: 1_000_000, perTxCap: 1000, dailyCap: 1_000_000, epochsPerWindow: 10_000_000, whitelist: [shop] }, "m-open");
  const B = await L.startBackend({ walletdUrl: mock.url, stateFile, txlogFile, env: envHi, label: "B", finalizeTries: 20, finalizeDelayMs: 40 });
  const agentB = L.apiClient(B.base, "agentsecret-0123456789");

  try {
    // ---------- Finding 1 (FIXED): same key to BOTH instances → exactly ONE chain submit ----------
    // Many independent rounds, each a fresh key fired at both instances at once. A single double-spend
    // in any round fails the test. (Before the fix this reliably produced 2 submits per round.)
    const ROUNDS = 10, AMOUNT = 500;
    let totalDupSubmits = 0, totalDupSpend = 0n, bothConfirmed = 0, sameTxId = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const key = `dup-${i}`;
      const before = await mock.state();
      const [ra, rb] = await Promise.all([
        agentA.pay({ merchant: shop, amount: AMOUNT, invoiceId: key }, key),
        agentB.pay({ merchant: shop, amount: AMOUNT, invoiceId: key }, key),
      ]);
      await L.sleep(120);
      const after = await mock.state();
      totalDupSubmits += after.counters.paySubmits - before.counters.paySubmits;
      totalDupSpend += BigInt(after.budget.spent) - BigInt(before.budget.spent);
      const sa = ra.body.receipt && ra.body.receipt.status, sb = rb.body.receipt && rb.body.receipt.status;
      if (sa === "confirmed" && sb === "confirmed") bothConfirmed++;
      const ta = ra.body.receipt && ra.body.receipt.txId, tb = rb.body.receipt && rb.body.receipt.txId;
      if (ta && tb && ta === tb) sameTxId++;
    }
    r.check(`same key to BOTH instances → exactly ONE submit per round (${ROUNDS} rounds)`, totalDupSubmits === ROUNDS, `chain submits=${totalDupSubmits} expected=${ROUNDS}`);
    r.check("no double-spend: on-chain spend == one payment per round", totalDupSpend === BigInt(ROUNDS) * BigInt(AMOUNT), `spend=${totalDupSpend} expected=${BigInt(ROUNDS) * BigInt(AMOUNT)}`);
    r.check("both instances return a confirmed receipt for the shared key (loser replays)", bothConfirmed === ROUNDS, `bothConfirmed=${bothConfirmed}/${ROUNDS}`);
    r.check("both instances report the SAME tx id (same on-chain tx, not two)", sameTxId === ROUNDS, `sameTxId=${sameTxId}/${ROUNDS}`);

    // ---------- Finding 2 (FIXED): concurrent distinct-key writes do NOT clobber the journal ----------
    const dir2 = L.tmpDir("multi2");
    const A2 = await L.startBackend({ walletdUrl: mock.url, stateFile: `${dir2}/s.json`, txlogFile: `${dir2}/t.json`, env: envHi, label: "A2", finalizeTries: 20, finalizeDelayMs: 40 });
    const adminA2 = L.apiClient(A2.base, "adminsecret-0123456789");
    const agentA2 = L.apiClient(A2.base, "agentsecret-0123456789");
    const shop2 = L.addr();
    await adminA2.createBudget({ fund: 1_000_000, perTxCap: 1000, dailyCap: 1_000_000, epochsPerWindow: 10_000_000, whitelist: [shop2] }, "m2-open");
    const B2 = await L.startBackend({ walletdUrl: mock.url, stateFile: `${dir2}/s.json`, txlogFile: `${dir2}/t.json`, env: envHi, label: "B2", finalizeTries: 20, finalizeDelayMs: 40 });
    const agentB2 = L.apiClient(B2.base, "agentsecret-0123456789");

    const NDISTINCT = 10; // 5 per instance, all distinct keys, fired concurrently
    const beforeD = (await mock.state()).counters.paySubmits;
    const jobs = [];
    for (let i = 0; i < NDISTINCT / 2; i++) {
      jobs.push(agentA2.pay({ merchant: shop2, amount: 200, invoiceId: `dk-A-${i}` }, `dk-A-${i}`));
      jobs.push(agentB2.pay({ merchant: shop2, amount: 200, invoiceId: `dk-B-${i}` }, `dk-B-${i}`));
    }
    await Promise.all(jobs);
    await L.sleep(200);
    const distinctSubmits = (await mock.state()).counters.paySubmits - beforeD;
    r.check("distinct keys stay independent: N distinct keys → N submits", distinctSubmits === NDISTINCT, `submits=${distinctSubmits} expected=${NDISTINCT}`);
    const tlog = L.readJson(`${dir2}/t.json`, []);
    const payKeys = new Set(tlog.filter((t) => t.op === "pay").map((t) => t.key));
    r.check("no journal clobber: every distinct key's record survived in the shared file", payKeys.size === NDISTINCT, `distinct pay records=${payKeys.size} expected=${NDISTINCT}`);

    // ---------- Holds: on-chain daily cap bounds total spend even under a 2-instance race ----------
    await mock.reset();
    const dir3 = L.tmpDir("multi3");
    const A3 = await L.startBackend({ walletdUrl: mock.url, stateFile: `${dir3}/s.json`, txlogFile: `${dir3}/t.json`, env: envHi, label: "A3", finalizeTries: 20, finalizeDelayMs: 40 });
    const adminA3 = L.apiClient(A3.base, "adminsecret-0123456789");
    const agentA3 = L.apiClient(A3.base, "agentsecret-0123456789");
    const shop3 = L.addr();
    await adminA3.createBudget({ fund: 1_000_000, perTxCap: 300, dailyCap: 900, epochsPerWindow: 10_000_000, whitelist: [shop3] }, "m3-open");
    const B3 = await L.startBackend({ walletdUrl: mock.url, stateFile: `${dir3}/s.json`, txlogFile: `${dir3}/t.json`, env: envHi, label: "B3", finalizeTries: 20, finalizeDelayMs: 40 });
    const agentB3 = L.apiClient(B3.base, "agentsecret-0123456789");
    const capJobs = [];
    for (let i = 0; i < 5; i++) {
      capJobs.push(agentA3.pay({ merchant: shop3, amount: 300, invoiceId: `cap-A-${i}` }, `cap-A-${i}`));
      capJobs.push(agentB3.pay({ merchant: shop3, amount: 300, invoiceId: `cap-B-${i}` }, `cap-B-${i}`));
    }
    await Promise.all(capJobs);
    await L.sleep(200);
    const capState = await mock.state();
    r.check("on-chain daily cap HOLDS under 2-instance race (spent <= cap)", BigInt(capState.budget.spent) <= 900n, `spent=${capState.budget.spent} cap=900`);
    r.check("on-chain spent is an exact multiple of 300 within the cap (no partial corruption)", Number(capState.budget.spent) % 300 === 0 && Number(capState.budget.spent) <= 900, `spent=${capState.budget.spent}`);

    const insts = { A, B, A2, B2, A3, B3 };
    const dead = Object.entries(insts).filter(([, h]) => h.child.exitCode != null).map(([n]) => n);
    r.check("all instances stayed up (no crash) through every race", dead.length === 0, dead.length ? `dead=${dead.join(",")} :: ${dead.map((n) => n + " LOG:\n" + insts[n].log.slice(-1200)).join("\n---\n")}` : "all alive");

    r.info("scope", "same-host / shared-filesystem multi-instance is now safe; cross-HOST still needs a shared store (DB/Redis) — see docs/stability.md");
    await A2.kill(); await B2.kill(); await A3.kill(); await B3.kill();
  } catch (e) {
    r.check("no exception", false, e.message + "\nA LOG:\n" + A.log.slice(-1500) + "\nB LOG:\n" + B.log.slice(-1500));
  } finally {
    await A.kill(); await B.kill();
    mock.stop();
  }
  process.exit(r.done() ? 0 : 1);
})();
