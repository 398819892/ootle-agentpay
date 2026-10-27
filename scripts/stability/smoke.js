#!/usr/bin/env node
"use strict";
const L = require("./lib");

(async () => {
  const r = L.makeReport("smoke");
  const dir = L.tmpDir("smoke");
  const mock = await L.startMock();
  const be = await L.startBackend({
    walletdUrl: mock.url,
    stateFile: `${dir}/state.json`,
    txlogFile: `${dir}/txlog.json`,
  });
  try {
    const admin = L.apiClient(be.base, "adminsecret-0123456789");
    const agent = L.apiClient(be.base, "agentsecret-0123456789");

    const shop = L.addr();
    // create a budget: fund 100000, perTx 1000, daily 5000, whitelist [shop]
    const cb = await admin.createBudget({ fund: 100000, perTxCap: 1000, dailyCap: 5000, epochsPerWindow: 10000, whitelist: [shop] }, "cb1");
    r.check("createBudget 2xx", cb.status >= 200 && cb.status < 300, `status=${cb.status}`);

    const bud = await agent.budget();
    r.check("budget readable", bud.status === 200, `status=${bud.status}`);
    r.check("treasury == funded (chain read)", bud.body.budget && String(bud.body.budget.treasury) === "100000", `treasury=${bud.body.budget && bud.body.budget.treasury}`);

    // accepted pay (within caps, whitelisted)
    const p1 = await agent.pay({ merchant: shop, amount: 500, invoiceId: "inv1" }, "inv1");
    r.check("pay accepted (201)", p1.status === 201, `status=${p1.status} body=${JSON.stringify(p1.body).slice(0,160)}`);
    r.check("receipt status=confirmed", p1.body.receipt && p1.body.receipt.status === "confirmed", `status=${p1.body.receipt && p1.body.receipt.status}`);

    const bud2 = await agent.budget();
    r.check("spent advanced on chain to 500", bud2.body.budget && String(bud2.body.budget.spent) === "500", `spent=${bud2.body.budget && bud2.body.budget.spent}`);
    r.check("treasury drained to 99500", bud2.body.budget && String(bud2.body.budget.treasury) === "99500", `treasury=${bud2.body.budget && bud2.body.budget.treasury}`);

    // rejected pay: over per-tx cap
    const p2 = await agent.pay({ merchant: shop, amount: 9999, invoiceId: "inv2" }, "inv2");
    r.check("over-cap pay rejected (402)", p2.status === 402, `status=${p2.status}`);
    r.check("reject receipt carries reason", p2.body.receipt && p2.body.receipt.status === "rejected" && !!p2.body.receipt.reason, `status=${p2.body.receipt && p2.body.receipt.status} reason=${p2.body.receipt && p2.body.receipt.reason}`);

    // idempotent replay of accepted pay
    const p1b = await agent.pay({ merchant: shop, amount: 500, invoiceId: "inv1" }, "inv1");
    r.check("replay returns confirmed + replayed", p1b.body.receipt && p1b.body.receipt.status === "confirmed" && p1b.body.replayed === true, JSON.stringify(p1b.body).slice(0,160));

    const ms = await mock.state();
    r.check("chain saw exactly 1 accepted pay submit for inv1 (spent stayed 500)", ms.budget.spent === "500", `spent=${ms.budget.spent}`);
  } catch (e) {
    r.check("no exception", false, e.message + "\nBACKEND LOG:\n" + be.log + "\nMOCK LOG:\n" + mock.log);
  } finally {
    await be.kill();
    mock.stop();
  }
  process.exit(r.done() ? 0 : 1);
})();
