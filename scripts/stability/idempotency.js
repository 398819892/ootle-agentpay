#!/usr/bin/env node
/**
 * IDEMPOTENCY under retry / timeout / concurrency — within ONE backend instance, the same
 * Idempotency-Key always maps to at most ONE on-chain effect, no matter how it is retried.
 *
 *   1. CONCURRENT burst: N simultaneous requests with the same key → exactly ONE chain submit.
 *   2. TIMEOUT then retry: key times out (unknown), the client retries the same key → reconciled,
 *      NOT resubmitted → still ONE submit.
 *   3. CONFIRMED replay: retrying a confirmed key returns the same receipt, no new submit.
 *   4. REJECTED key: retrying a chain-rejected key is refused (no resubmit, deterministic).
 *   5. Distinct keys are independent: N distinct keys → N submits (no accidental collapsing).
 */
"use strict";
const L = require("./lib");

(async () => {
  const r = L.makeReport("idempotency");
  const dir = L.tmpDir("idem");
  const mock = await L.startMock();
  const be = await L.startBackend({
    walletdUrl: mock.url, stateFile: `${dir}/state.json`, txlogFile: `${dir}/txlog.json`,
    finalizeTries: 4, finalizeDelayMs: 60,
    env: { AGENTPAY_RATE_MAX: "100000000", AGENTPAY_MONEY_MAX: "100000000", AGENTPAY_RATE_WINDOW_MS: "3600000", AGENTPAY_MONEY_WINDOW_MS: "3600000" },
  });
  try {
    const admin = L.apiClient(be.base, "adminsecret-0123456789");
    const agent = L.apiClient(be.base, "agentsecret-0123456789");
    const shop = L.addr();
    await admin.createBudget({ fund: 1_000_000, perTxCap: 10000, dailyCap: 1_000_000, epochsPerWindow: 10_000_000, whitelist: [shop] }, "i-open");

    // ---- 1. concurrent burst, same key ----
    let base = (await mock.state()).counters.paySubmits;
    const burst = await Promise.all(
      Array.from({ length: 12 }, () => agent.pay({ merchant: shop, amount: 400, invoiceId: "burst" }, "burst")),
    );
    const submits1 = (await mock.state()).counters.paySubmits - base;
    r.check("concurrent burst of 12 → exactly ONE chain submit", submits1 === 1, `submits=${submits1}`);
    const confirmed = burst.filter((x) => x.body.receipt && x.body.receipt.status === "confirmed").length;
    r.check("all 12 responses report the same confirmed receipt", confirmed === 12, `confirmed=${confirmed}`);
    r.check("chain spent advanced by a single 400", (await mock.state()).budget.spent === "400", `spent=${(await mock.state()).budget.spent}`);

    // ---- 2. timeout then retry, same key ----
    base = (await mock.state()).counters.paySubmits;
    await mock.ctl({ acceptAfterPolls: 4 }); // verdict lands after the finalize budget → unknown
    const t1 = await agent.pay({ merchant: shop, amount: 500, invoiceId: "to" }, "to");
    r.check("timed-out pay is unknown (not success)", t1.status === 202 || (t1.body.receipt && t1.body.receipt.status === "unknown"), `status=${t1.status}`);
    await mock.ctl({ acceptAfterPolls: 0 });
    const t2 = await agent.pay({ merchant: shop, amount: 500, invoiceId: "to" }, "to"); // retry same key
    r.check("retry of timed-out key reconciles to confirmed", t2.body.receipt && t2.body.receipt.status === "confirmed", `status=${t2.body.receipt && t2.body.receipt.status}`);
    const submits2 = (await mock.state()).counters.paySubmits - base;
    r.check("timeout + retry → exactly ONE chain submit", submits2 === 1, `submits=${submits2}`);

    // ---- 3. confirmed replay ----
    base = (await mock.state()).counters.paySubmits;
    const rep = await agent.pay({ merchant: shop, amount: 500, invoiceId: "to" }, "to");
    r.check("replay of confirmed key → replayed flag, no new submit", rep.body.replayed === true && ((await mock.state()).counters.paySubmits - base) === 0, `replayed=${rep.body.replayed} submits=${(await mock.state()).counters.paySubmits - base}`);

    // ---- 4. rejected key is not resubmitted ----
    base = (await mock.state()).counters.paySubmits;
    await mock.ctl({ getResultMode: "reject" });
    const j1 = await agent.pay({ merchant: shop, amount: 600, invoiceId: "rej" }, "rej");
    r.check("chain-rejected key returns a rejected receipt (402)", j1.status === 402 && j1.body.receipt && j1.body.receipt.status === "rejected", `status=${j1.status} rec=${j1.body.receipt && j1.body.receipt.status}`);
    await mock.ctl({ getResultMode: "auto" });
    const j2 = await agent.pay({ merchant: shop, amount: 600, invoiceId: "rej" }, "rej");
    const submits4 = (await mock.state()).counters.paySubmits - base;
    r.check("retry of a rejected key is NOT resubmitted to chain", submits4 === 1, `submits=${submits4}`);
    r.check("retry of rejected key stays rejected (deterministic, no flip to confirmed)", j2.body.receipt && j2.body.receipt.status === "rejected", `status=${j2.body.receipt && j2.body.receipt.status}`);

    // ---- 5. distinct keys independent ----
    base = (await mock.state()).counters.paySubmits;
    await Promise.all(Array.from({ length: 6 }, (_, i) => agent.pay({ merchant: shop, amount: 100, invoiceId: `d${i}` }, `d${i}`)));
    const submits5 = (await mock.state()).counters.paySubmits - base;
    r.check("6 distinct keys → 6 chain submits (no accidental collapse)", submits5 === 6, `submits=${submits5}`);
  } catch (e) {
    r.check("no exception", false, e.message + "\nBACKEND LOG:\n" + be.log.slice(-2000));
  } finally {
    await be.kill();
    mock.stop();
  }
  process.exit(r.done() ? 0 : 1);
})();
