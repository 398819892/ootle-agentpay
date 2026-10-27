#!/usr/bin/env node
/**
 * FAULT INJECTION — walletd unavailable / network timeout / verdict unknown, all forced on the mock
 * (never on the real swarm). Verifies the backend degrades safely:
 *   A. walletd DOWN           → money op fails loudly (no false success); nothing marked confirmed.
 *   B. network TIMEOUT        → op recorded `unknown` (NOT success); after recovery, reconcile settles
 *                               it; the chain shows exactly ONE submit (the timeout did not double-send).
 *   C. verdict UNKNOWN        → submit ok but no finalize in the window → `unknown`; later reconcile
 *                               against the tx id settles it to confirmed; single on-chain effect.
 *   D. read failure (substate)→ a chain-read fault falls back to cache and the op still reports a
 *                               truthful state rather than crashing.
 *
 * The invariant throughout: an unconfirmed outcome is never counted as done, and a retry/reconcile
 * never produces a second on-chain effect.
 */
"use strict";
const L = require("./lib");

(async () => {
  const r = L.makeReport("fault-injection");
  const dir = L.tmpDir("fault");
  const mock = await L.startMock();
  // low finalize budget so the "unknown" path is reached quickly
  const be = await L.startBackend({ walletdUrl: mock.url, stateFile: `${dir}/state.json`, txlogFile: `${dir}/txlog.json`, finalizeTries: 4, finalizeDelayMs: 80 });
  try {
    const admin = L.apiClient(be.base, "adminsecret-0123456789");
    const agent = L.apiClient(be.base, "agentsecret-0123456789");
    const shop = L.addr();
    await admin.createBudget({ fund: 100000, perTxCap: 1000, dailyCap: 50000, epochsPerWindow: 10_000_000, whitelist: [shop] }, "f-open");

    // ---- A. walletd DOWN ----
    await mock.ctl({ down: true });
    const a = await agent.pay({ merchant: shop, amount: 100, invoiceId: "f-down" }, "f-down");
    r.check("A: pay while walletd down is NOT a success (>=400 / not confirmed)", a.status >= 400 || (a.body.receipt && a.body.receipt.status !== "confirmed"), `status=${a.status} rec=${a.body.receipt && a.body.receipt.status}`);
    let tx = L.readJson(be.txlogFile, []);
    let down = tx.find((t) => t.key === "f-down");
    r.check("A: journal record for down op is not confirmed", !down || down.status !== "confirmed", `status=${down && down.status}`);
    await mock.ctl({ down: false });

    // ---- B. network TIMEOUT (slow walletd) → unknown, then recover + reconcile ----
    // delay each RPC beyond the finalize window so run() times out AFTER submit → pending/unknown.
    const before = (await mock.state()).counters.paySubmits;
    // submit succeeds, but the verdict does not land within the backend's finalize budget
    // (finalizeTries=4): the tx only decides on poll #5, modelling a confirmation that arrives late.
    await mock.ctl({ delayMs: 40, acceptAfterPolls: 4 });
    const b = await agent.pay({ merchant: shop, amount: 200, invoiceId: "f-timeout" }, "f-timeout");
    r.check("B: timed-out pay reported pending/unknown (not confirmed)", (b.status === 202) || (b.body.receipt && (b.body.receipt.status === "unknown" || b.body.receipt.status === "pending")), `status=${b.status} rec=${b.body.receipt && b.body.receipt.status}`);
    tx = L.readJson(be.txlogFile, []);
    let to = tx.find((t) => t.key === "f-timeout");
    r.check("B: journal marks it 'unknown' with a tx id to reconcile", to && to.status === "unknown" && !!to.txId, `status=${to && to.status} txId=${to && to.txId}`);
    const submittedOnce = (await mock.state()).counters.paySubmits - before;
    r.check("B: chain saw exactly ONE submit for the timed-out pay", submittedOnce === 1, `submits=${submittedOnce}`);

    // recover: speed up walletd, reconcile; the SAME tx settles, no resubmit
    await mock.ctl({ delayMs: 0 });
    const rec1 = await L.reconcile(be.base);
    tx = L.readJson(be.txlogFile, []);
    to = tx.find((t) => t.key === "f-timeout");
    r.check("B: reconcile settled the unknown op to confirmed", to && to.status === "confirmed", `status=${to && to.status}`);
    const afterReconcile = (await mock.state()).counters.paySubmits - before;
    r.check("B: reconcile did NOT resubmit (still ONE submit)", afterReconcile === 1, `submits=${afterReconcile}`);

    // a retry with the same key now returns the confirmed receipt, no new submit
    const bRetry = await agent.pay({ merchant: shop, amount: 200, invoiceId: "f-timeout" }, "f-timeout");
    r.check("B: same-key retry replays confirmed (no double-spend)", bRetry.body.receipt && bRetry.body.receipt.status === "confirmed" && bRetry.body.replayed === true, JSON.stringify(bRetry.body).slice(0, 140));
    r.check("B: still exactly ONE submit after retry", ((await mock.state()).counters.paySubmits - before) === 1, `submits=${(await mock.state()).counters.paySubmits - before}`);

    // ---- C. verdict UNKNOWN (submit ok, never finalizes in-window) ----
    const beforeC = (await mock.state()).counters.paySubmits;
    await mock.ctl({ getResultMode: "pending" });
    const c = await agent.pay({ merchant: shop, amount: 300, invoiceId: "f-unknown" }, "f-unknown");
    r.check("C: never-finalizing pay is 'unknown', not success", (c.status === 202) || (c.body.receipt && c.body.receipt.status === "unknown"), `status=${c.status} rec=${c.body.receipt && c.body.receipt.status}`);
    await mock.ctl({ getResultMode: "auto", acceptAfterPolls: 0 });
    await L.reconcile(be.base);
    tx = L.readJson(be.txlogFile, []);
    const cu = tx.find((t) => t.key === "f-unknown");
    r.check("C: reconcile settles it to confirmed", cu && cu.status === "confirmed", `status=${cu && cu.status}`);
    r.check("C: exactly ONE submit for the unknown-verdict pay", ((await mock.state()).counters.paySubmits - beforeC) === 1, `submits=${(await mock.state()).counters.paySubmits - beforeC}`);

    // ---- D. read failure falls back gracefully ----
    await mock.ctl({ failMethods: ["substates.get"] });
    const st = await L.getState(be.base);
    r.check("D: state read still responds (200) when chain read fails", st.status === 200, `status=${st.status}`);
    r.check("D: budget figures fall back to cache/journal with provenance", st.body.budget && st.body.budget.source != null, `source=${st.body.budget && JSON.stringify(st.body.budget.source)}`);
    await mock.ctl({ failMethods: [] });

    // final: chain spent reflects only the three confirmed pays (100-down never happened)
    const ms = await mock.state();
    r.check("final: chain spent == 200+300 (down pay never executed)", ms.budget.spent === "500", `spent=${ms.budget.spent}`);
  } catch (e) {
    r.check("no exception", false, e.message + "\nBACKEND LOG:\n" + be.log.slice(-2000));
  } finally {
    await be.kill();
    mock.stop();
  }
  process.exit(r.done() ? 0 : 1);
})();
