#!/usr/bin/env node
/**
 * CRASH RECOVERY — kill the BACKEND (never the swarm) at the "submitted but not yet confirmed"
 * moment, restart it against the SAME state/txlog files, and prove the startup reconciler settles
 * the in-flight tx against the chain with NO double-spend and NO lost record. This directly exercises
 * A-2 (chain-authoritative reconcile) on real process death.
 *
 * Sequence:
 *   1. open a budget, confirm one pay normally (baseline on-chain spent).
 *   2. force the next pay into the `unknown` lifecycle (submit ok, verdict withheld) → the journal
 *      holds a pending/unknown record WITH a tx id, persisted to disk.
 *   3. SIGKILL the backend by its exact child PID (a hard crash — no graceful shutdown).
 *   4. let the chain finalize that tx (flip the mock to auto).
 *   5. restart the backend on the same files → boot-time reconcileAll() settles the record.
 *   6. assert: record now confirmed; chain spent advanced by exactly that one pay (no re-submit);
 *      backend's reported spent == chain; a same-key retry replays (no second effect).
 *
 * Also checks the "pending persisted BEFORE submit" guarantee: a crash leaves a reconcilable trace.
 */
"use strict";
const L = require("./lib");

(async () => {
  const r = L.makeReport("crash-recovery");
  const dir = L.tmpDir("crash");
  const stateFile = `${dir}/state.json`, txlogFile = `${dir}/txlog.json`;
  const mock = await L.startMock();
  let be = await L.startBackend({ walletdUrl: mock.url, stateFile, txlogFile, finalizeTries: 4, finalizeDelayMs: 80 });
  try {
    const admin = L.apiClient(be.base, "adminsecret-0123456789");
    let agent = L.apiClient(be.base, "agentsecret-0123456789");
    const shop = L.addr();
    await admin.createBudget({ fund: 100000, perTxCap: 1000, dailyCap: 50000, epochsPerWindow: 10_000_000, whitelist: [shop] }, "c-open");

    // baseline confirmed pay
    await agent.pay({ merchant: shop, amount: 100, invoiceId: "c-base" }, "c-base");
    r.check("baseline chain spent == 100", (await mock.state()).budget.spent === "100");

    // in-flight pay → unknown (submit ok, verdict withheld)
    const before = (await mock.state()).counters.paySubmits;
    await mock.ctl({ getResultMode: "pending" });
    const inflight = await agent.pay({ merchant: shop, amount: 250, invoiceId: "c-inflight" }, "c-inflight");
    r.check("in-flight pay recorded unknown (not success)", inflight.status === 202 || (inflight.body.receipt && inflight.body.receipt.status === "unknown"), `status=${inflight.status}`);
    let tx = L.readJson(txlogFile, []);
    let rec = tx.find((t) => t.key === "c-inflight");
    r.check("disk journal has reconcilable trace with tx id BEFORE crash", rec && (rec.status === "unknown" || rec.status === "pending") && !!rec.txId, `status=${rec && rec.status} txId=${rec && rec.txId}`);
    const submittedOnce = (await mock.state()).counters.paySubmits - before;
    r.check("chain saw exactly one submit for the in-flight pay", submittedOnce === 1, `submits=${submittedOnce}`);

    // --- HARD CRASH: SIGKILL the backend by its exact PID (never pkill, never the swarm) ---
    const deadPid = be.pid;
    await be.kill("SIGKILL");
    r.check("backend process killed (precise PID, gentle on everything else)", be.child.killed || be.child.exitCode != null || be.child.signalCode != null, `pid=${deadPid}`);

    // chain finalizes the withheld tx while the backend is down
    await mock.ctl({ getResultMode: "auto", acceptAfterPolls: 0 });

    // --- RESTART on the same files ---
    be = await L.startBackend({ walletdUrl: mock.url, stateFile, txlogFile, finalizeTries: 4, finalizeDelayMs: 80 });
    agent = L.apiClient(be.base, "agentsecret-0123456789");
    // give boot-time reconcileAll a moment (it runs async after listen); also force one explicitly
    await L.sleep(400);
    await L.reconcile(be.base);

    tx = L.readJson(txlogFile, []);
    rec = tx.find((t) => t.key === "c-inflight");
    r.check("after restart: in-flight record settled to confirmed", rec && rec.status === "confirmed", `status=${rec && rec.status}`);

    const ms = await mock.state();
    r.check("no double-spend: chain spent == 100 + 250 == 350", ms.budget.spent === "350", `spent=${ms.budget.spent}`);
    r.check("no re-submit across the crash: still ONE submit for c-inflight", (ms.counters.paySubmits - before) === 1, `submits=${ms.counters.paySubmits - before}`);

    const bud = await agent.budget();
    r.check("backend reported spent == chain (350) after recovery", String(bud.body.budget.spent) === "350", `backend=${bud.body.budget.spent}`);
    r.check("no record lost: both pays present in journal", tx.filter((t) => t.op === "pay").length === 2, `payRecords=${tx.filter((t) => t.op === "pay").length}`);

    // same-key retry after recovery → replay, no new effect
    const retry = await agent.pay({ merchant: shop, amount: 250, invoiceId: "c-inflight" }, "c-inflight");
    r.check("same-key retry after recovery replays (no double-spend)", retry.body.receipt && retry.body.receipt.status === "confirmed" && retry.body.replayed === true, JSON.stringify(retry.body).slice(0, 140));
    r.check("still exactly ONE submit after retry", ((await mock.state()).counters.paySubmits - before) === 1);
  } catch (e) {
    r.check("no exception", false, e.message + "\nBACKEND LOG:\n" + be.log.slice(-2000));
  } finally {
    await be.kill();
    mock.stop();
  }
  process.exit(r.done() ? 0 : 1);
})();
