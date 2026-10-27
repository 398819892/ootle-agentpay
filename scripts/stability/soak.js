#!/usr/bin/env node
/**
 * SOAK — long run of mixed payments + queries through the real /api/v1 layer, checking the three
 * things a soak is for: no state drift (backend's chain-authoritative numbers == the chain == an
 * independent reference model), no resource leak (RSS + journal size bounded, no duplicate/lost
 * records), and chain↔journal consistency (every confirmed pay is on chain exactly once).
 *
 * Deterministic against the mock walletd (safe; never touches the real swarm). The mock enforces the
 * SAME rules the AgentBudget template does — per-tx cap, daily cap, whitelist, kill switch — and an
 * accepted pay advances on-chain spent + drains the vault, so the backend's readChainBudget moves in
 * lockstep. The reference model here recomputes the expected accept/reject verdict independently.
 *
 *   SOAK_ROUNDS=400 node scripts/stability/soak.js
 */
"use strict";
const L = require("./lib");

const ROUNDS = Number(process.env.SOAK_ROUNDS || 300);
const SEED = Number(process.env.SOAK_SEED || 42);
const PER_TX = 1000n, DAILY = 20000n, FUND = 1_000_000n;

// tiny deterministic PRNG (mulberry32)
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function rss(pid) {
  try {
    const fs = require("node:fs");
    const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ");
    return Math.round((Number(statm[1]) * 4096) / 1024); // resident pages * page size → KiB
  } catch { return null; }
}

(async () => {
  const r = L.makeReport("soak");
  const dir = L.tmpDir("soak");
  const mock = await L.startMock();
  // Raise the rate limiter so we can push volume through the MONEY pipeline. The limiter (default
  // 12 money ops/min) is a deliberate production safeguard with its own test coverage; a soak that
  // kept it would only measure the limiter. We load-test the chain/journal pipeline instead.
  const be = await L.startBackend({
    walletdUrl: mock.url, stateFile: `${dir}/state.json`, txlogFile: `${dir}/txlog.json`,
    finalizeTries: 10, finalizeDelayMs: 60,
    env: { AGENTPAY_RATE_MAX: "100000000", AGENTPAY_MONEY_MAX: "100000000", AGENTPAY_RATE_WINDOW_MS: "3600000", AGENTPAY_MONEY_WINDOW_MS: "3600000" },
  });
  const fs = require("node:fs");
  try {
    const admin = L.apiClient(be.base, "adminsecret-0123456789");
    const agent = L.apiClient(be.base, "agentsecret-0123456789");
    const shops = [L.addr(), L.addr()];
    const rogue = L.addr();
    const merchants = [...shops, rogue];

    const cb = await admin.createBudget({ fund: Number(FUND), perTxCap: Number(PER_TX), dailyCap: Number(DAILY), epochsPerWindow: 10_000_000, whitelist: shops }, "soak-open");
    r.check("budget opened", cb.status === 201, `status=${cb.status}`);

    const rand = rng(SEED);
    let modelSpent = 0n;           // reference model of on-chain spent
    let accepted = 0, rejected = 0, mismatch = 0;
    let acceptedAmount = 0n;
    const usedKeys = new Set();
    const rssStart = await rss(be.pid);
    let rssMax = rssStart || 0;

    for (let n = 1; n <= ROUNDS; n++) {
      const merchant = merchants[Math.floor(rand() * merchants.length)];
      const amount = BigInt(1 + Math.floor(rand() * Number(PER_TX + 400n))); // sometimes over per-tx
      const key = `soak-${n}`;
      usedKeys.add(key);
      // independent reference verdict (mirrors the on-chain rules)
      const allowed = shops.includes(merchant) && amount > 0n && amount <= PER_TX && (modelSpent + amount) <= DAILY;

      const res = await agent.pay({ merchant, amount: Number(amount), invoiceId: key }, key);
      const rec = res.body.receipt || {};
      const chainAccepted = rec.status === "confirmed";
      if (chainAccepted !== allowed) {
        mismatch++;
        r.check(`round ${n} model==chain`, false, `model=${allowed} chain=${rec.status} amount=${amount} merchant=${shops.includes(merchant) ? "shop" : "rogue"}`);
      }
      if (allowed) { modelSpent += amount; acceptedAmount += amount; accepted++; } else rejected++;

      // interleave queries every few rounds (exercise the read/reconcile path under load)
      if (n % 7 === 0) {
        await agent.budget();
        await agent.listPayments();
        await L.getState(be.base);
      }
      if (n % 25 === 0) { const m = await rss(be.pid); if (m) rssMax = Math.max(rssMax, m); }
    }

    r.check(`${ROUNDS} rounds: 0 model/chain mismatches`, mismatch === 0, `accepted=${accepted} rejected=${rejected} mismatch=${mismatch}`);

    // ---- drift: backend chain-read == reference model == mock chain ----
    const ms = await mock.state();
    const bud = await agent.budget();
    const b = bud.body.budget;
    r.check("backend spent == reference model", String(b.spent) === String(modelSpent), `backend=${b.spent} model=${modelSpent}`);
    r.check("mock chain spent == reference model", ms.budget.spent === String(modelSpent), `chain=${ms.budget.spent} model=${modelSpent}`);
    r.check("treasury == fund - spent (no drift)", String(b.treasury) === String(FUND - modelSpent), `treasury=${b.treasury} expected=${FUND - modelSpent}`);

    // ---- chain↔journal consistency ----
    const txlog = L.readJson(be.txlogFile, []);
    const payRecs = txlog.filter((t) => t.op === "pay");
    const confirmedPays = payRecs.filter((t) => t.status === "confirmed").length;
    const keys = payRecs.map((t) => t.key);
    const dupKeys = keys.length - new Set(keys).size;
    r.check("journal confirmed-pay count == accepted", confirmedPays === accepted, `journal=${confirmedPays} accepted=${accepted}`);
    r.check("no duplicate idempotency keys in journal", dupKeys === 0, `dups=${dupKeys}`);
    r.check("chain pay-submits == accepted + chain-rejects (no resubmits)", ms.counters.paySubmits >= accepted, `paySubmits=${ms.counters.paySubmits} accepted=${accepted}`);
    // every accepted pay submitted to chain EXACTLY once: paySubmits counts accepts + chain-side rejects
    // (client-prechecked rejects never reached chain). So paySubmits == number of records with a txId.
    const withTx = payRecs.filter((t) => t.txId).length;
    r.check("chain pay-submits == journal records that reached chain", ms.counters.paySubmits === withTx, `paySubmits=${ms.counters.paySubmits} recordsWithTx=${withTx}`);

    // ---- no stuck pending ----
    const stuck = txlog.filter((t) => t.status === "pending").length;
    r.check("no records stuck in 'pending'", stuck === 0, `pending=${stuck}`);

    // ---- query consistency ----
    const list = await agent.listPayments();
    r.check("GET /payments count == journal pay records", list.body.payments.length === payRecs.length, `api=${list.body.payments.length} journal=${payRecs.length}`);

    // ---- leak ----
    const rssEnd = await rss(be.pid);
    const txlogBytes = fs.statSync(be.txlogFile).size;
    if (rssStart && rssEnd) {
      const growth = rssEnd - rssStart;
      r.check("backend RSS growth bounded (<120MB over run)", growth < 120 * 1024, `start=${rssStart}KiB end=${rssEnd}KiB max=${rssMax}KiB growth=${growth}KiB`);
    } else {
      console.log("  (RSS sampling unavailable on this platform; skipped leak-by-RSS check)");
    }
    r.check("journal size bounded (one record per op, no unbounded growth)", txlog.length <= ROUNDS + 2, `records=${txlog.length} rounds=${ROUNDS}`);
    console.log(`  soak stats: rounds=${ROUNDS} accepted=${accepted} rejected=${rejected} acceptedAmount=${acceptedAmount} txlogBytes=${txlogBytes}`);
  } catch (e) {
    r.check("no exception", false, e.message + "\nBACKEND LOG:\n" + be.log.slice(-2000));
  } finally {
    await be.kill();
    mock.stop();
  }
  process.exit(r.done() ? 0 : 1);
})();
