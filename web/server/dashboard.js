//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/** The dashboard state the frontend renders (chain is the authority) and the "pending" result shape. */
"use strict";

const { big, clampStr } = require("./http_util");

/**
 * Merge the dashboard's journal ledger with the chain scan into one oldest→newest feed. Journal
 * rows are kept as-is (they carry the caller's free-text memo and the migrated legacy rows) and are
 * time-stamped from the chain by txId; chain pays whose txId is NOT already in the journal are added
 * (the external pays — made via the MCP / SDK / another dashboard). Ordered by chain timestamp (a
 * row with no timestamp sorts oldest), then re-indexed. `scan` is `{ rows, tsByTxId }` from
 * extractChainPays. Pure + exported for unit testing.
 */
function mergeLedgers(journal, scan, label) {
  const { rows: chainRows, tsByTxId } = scan;
  const journalTxIds = new Set(journal.map((e) => e.txId).filter(Boolean));
  const out = [];
  for (const e of journal) {
    // prefer the chain's finalize timestamp for this tx; fall back to the journal row's own time
    out.push({ ...e, _ts: (e.txId && tsByTxId.get(e.txId)) || e.ts || 0 });
  }
  for (const p of chainRows) {
    if (p.txId && journalTxIds.has(p.txId)) continue; // the journal already has this pay (richer memo)
    out.push({
      merchant: p.merchant,
      merchantName: label(p.merchant),
      amount: String(p.amount),
      memo: p.memo,
      onchainMemo: p.memo,
      txKind: "pay",
      status: "confirmed",
      txId: p.txId,
      source: "chain", // discovered on chain, not in this dashboard's journal
      via: "chain", // external client (MCP / SDK / another dashboard) — not journaled here
      _ts: p.ts || 0,
    });
  }
  out.sort((a, b) => a._ts - b._ts); // oldest→newest; equal ts keeps insertion order (journal first)
  return out.map((e, i) => {
    const { _ts, ...rest } = e;
    return { ...rest, index: i, ts: _ts || null }; // epoch ms of the pay (for the UI's date/time column)
  });
}

function createDashboard({
  store, nameByAddr, apiKeys, conn, txlog, readChainBudget, journalTotals, journalLedger, chainPayScan,
  walletdUrl: WALLETD_URL, budgetTemplate: BUDGET_TEMPLATE, owner: OWNER, tokenSymbol: TOKEN_SYMBOL, network: NETWORK,
  stepUpOn: STEP_UP_ON,
}) {
  /**
   * The shape the frontend renders. CHAIN IS THE AUTHORITY: treasury (vault balance), spend-in-window,
   * caps, whitelist and the revoked flag are read live from chain every call. Only the history
   * (funded/withdrawn totals and the payment ledger) comes from the local journal, and only because
   * the chain does not expose a lifetime-total — it is clearly labelled in `budget.source`. If a chain
   * read fails we fall back to the cached config + journal estimate and say so, rather than break.
   */
  async function dashboardState() {
    const names = nameByAddr();
    const label = (addr) => names[addr] || null;
    const base = {
      config: { walletdUrl: WALLETD_URL, template: BUDGET_TEMPLATE, ownerAccount: OWNER, tokenSymbol: TOKEN_SYMBOL, network: NETWORK },
      // Integration-API status for the Connect panel: whether /api/v1 is enabled, and the (non-secret)
      // ids of the configured agent keys. Secrets are never exposed — only ids/roles (apikeys.list()).
      api: {
        enabled: apiKeys.configured(),
        agentKeys: apiKeys.list().filter((k) => k.role === "agent" && !k.revoked).map((k) => k.id),
      },
      connected: Boolean(conn.wd),
      owner: conn.ownerAddr,
      merchants: Object.entries(store.merchants).map(([name, address]) => ({ name, address })),
      // global emergency stop (dashboard-wide, independent of a single budget's on-chain revoke)
      frozen: Boolean(store.frozen),
      // whether high-risk actions require a step-up confirmation (true iff auth is enabled)
      stepUpRequired: STEP_UP_ON,
      // tx journal health: counts by status + anything needing operator attention (unknown txs).
      tx: txlog.summary(),
      budget: null,
    };
    if (!store.budget) return base;
    const cfg = store.budget;

    // Pull the authoritative state from chain; fall back to cached config on any read failure.
    let chain = null;
    try {
      chain = await readChainBudget(cfg.component);
    } catch (e) {
      console.error("warn: chain read failed, showing cached config:", e.message);
    }
    const chainOk = Boolean(chain);

    const totals = journalTotals(cfg.component); // historical funded/withdrawn (scoped; not a chain fact)
    const perTxCap = chainOk ? chain.perTxCap : String(cfg.perTxCap);
    const dailyCap = chainOk ? chain.dailyCap : String(cfg.dailyCap);
    const spent = chainOk ? chain.spentInWindow : "0";
    const whitelist = chainOk ? chain.whitelist : cfg.whitelist || [];
    const revoked = chainOk ? chain.revoked : Boolean(cfg.revoked);
    // Treasury = the vault's on-chain balance (exact). Only if the chain read fails do we fall back to
    // the journal estimate (funded − spent − withdrawn), and flag it as a cache value.
    const treasuryFromChain = chainOk && chain.vaultBalance != null;
    const treasury = treasuryFromChain
      ? chain.vaultBalance
      : clampStr(big(totals.funded) - big(spent) - big(totals.withdrawn));

    // The payment feed: the dashboard's own journal MERGED with the chain's full pay history, so a
    // pay made via the MCP / SDK / another dashboard shows up too (not just this dashboard's own
    // pays). The journal row wins for a matching tx (its memo is the caller's free text). On any
    // chain failure we fall back to the journal alone — the pre-feature behaviour.
    const jLedger = journalLedger(cfg.component, label);
    let ledger = jLedger;
    let ledgerSource = "journal";
    try {
      const scan = chainPayScan ? await chainPayScan(cfg.component) : null;
      if (scan) {
        ledger = mergeLedgers(jLedger, scan, label);
        ledgerSource = "chain+journal";
      }
    } catch (e) {
      console.error("warn: chain ledger scan failed, showing journal only:", e.message);
    }

    base.budget = {
      component: cfg.component,
      perTxCap,
      dailyCap,
      revoked,
      spent,
      funded: totals.funded,
      withdrawn: totals.withdrawn,
      treasury,
      dailyRemaining: chainOk ? String(chain.window.remaining) : clampStr(big(dailyCap) - big(spent)),
      sessions: (cfg.sessions || ["default"]).map((session) => ({
        session,
        revoked: (cfg.revokedSessions || []).includes(session),
      })),
      window: chainOk ? chain.window : null,
      whitelist: whitelist.map((address) => ({ address, name: label(address) })),
      ledger,
      // Provenance of each figure, so the UI (and a reviewer) can see what is chain-authoritative.
      source: {
        treasury: treasuryFromChain ? "chain" : "journal(cache)",
        spent: chainOk ? "chain" : "unavailable",
        caps: chainOk ? "chain" : "cache",
        whitelist: chainOk ? "chain" : "cache",
        revoked: chainOk ? "chain" : "cache",
        fundedWithdrawn: "journal",
        ledger: ledgerSource, // "chain+journal" (all on-chain pays) or "journal" (fallback)
        chainRead: chainOk,
      },
    };
    return base;
  }

  // A short, honest "submitted but not confirmed" result for the unknown lifecycle outcome. The
  // current dashboard state is returned alongside (chain-authoritative), plus a `pending` marker — it
  // is explicitly NOT reported as done.
  async function pendingResult(record, noun) {
    return {
      ...(await dashboardState()),
      pending: true,
      txId: record.txId,
      notice: `${noun} submitted to chain but not yet confirmed — it is NOT counted as done until reconciled (tx ${record.txId || "?"}).`,
    };
  }

  return { dashboardState, pendingResult };
}

module.exports = { createDashboard, mergeLedgers };
