//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/** The dashboard state the frontend renders (chain is the authority) and the "pending" result shape. */
"use strict";

const { big, clampStr } = require("./http_util");

function createDashboard({
  store, nameByAddr, apiKeys, conn, txlog, readChainBudget, journalTotals, journalLedger,
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
      ledger: journalLedger(cfg.component, label),
      // Provenance of each figure, so the UI (and a reviewer) can see what is chain-authoritative.
      source: {
        treasury: treasuryFromChain ? "chain" : "journal(cache)",
        spent: chainOk ? "chain" : "unavailable",
        caps: chainOk ? "chain" : "cache",
        whitelist: chainOk ? "chain" : "cache",
        revoked: chainOk ? "chain" : "cache",
        fundedWithdrawn: "journal",
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

module.exports = { createDashboard };
