//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * The persisted REFERENCE + CONFIG store (which budget is open, its badges, merchant aliases, the
 * kill switch, API-key revocations). Never the authority for money — see dashboard.js / chain_reads.js.
 */
"use strict";

const fs = require("node:fs");
const { writeJsonAtomic } = require("./txlog");

function createStore({ stateFile: STATE_FILE, budgetTemplate: BUDGET_TEMPLATE, txlog }) {
  // ---- persisted runtime state ----------------------------------------------------------------
  // IMPORTANT: this `store` is a REFERENCE + CONFIG cache, NOT the authority for money. It records
  // which budget component is open, its badge resources, the friendly merchant name↔address book,
  // the agent-session labels and the kill switch. The authoritative financial state — vault balance
  // (treasury), spend-in-window, the on-chain whitelist and the revoked flag — is read LIVE from the
  // chain in `dashboardState()` (see `readChainBudget`). The cached caps/whitelist/revoked here are
  // only a fallback for when a chain read momentarily fails, and are labelled as such to the client.
  /** @type {{ budget: any|null, merchants: Record<string,string>, frozen: boolean, receiptLang: string }} */
  let store = { budget: null, merchants: {}, frozen: false, receiptLang: "both" };

  function loadStore() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      /* first run */
    }
    if (!raw || typeof raw !== "object") return;
    store.merchants = raw.merchants && typeof raw.merchants === "object" ? raw.merchants : {};
    store.frozen = Boolean(raw.frozen);
    // Default language for the MCP's payment-receipt image ("zh" | "en" | "both"); the MCP reads it
    // live from /api/state so the dashboard setting controls a separate process too.
    store.receiptLang = ["zh", "en", "both"].includes(raw.receiptLang) ? raw.receiptLang : "both";
    // API-key revocations persist across restarts (the key list itself stays in env).
    store.apiKeys = raw.apiKeys && typeof raw.apiKeys === "object" ? raw.apiKeys : {};
    if (raw.budget) {
      const b = raw.budget;
      store.budget = {
        component: b.component,
        ownerBadge: b.ownerBadge,
        agentBadge: b.agentBadge,
        template: b.template || BUDGET_TEMPLATE,
        // cached config (fallback only; chain is authority):
        perTxCap: String(b.perTxCap ?? "0"),
        dailyCap: String(b.dailyCap ?? "0"),
        whitelist: Array.isArray(b.whitelist) ? b.whitelist : [],
        revoked: Boolean(b.revoked),
        epochsPerWindow: Number(b.epochsPerWindow) || undefined,
        sessions: Array.isArray(b.sessions) ? b.sessions : ["default"],
        revokedSessions: Array.isArray(b.revokedSessions) ? b.revokedSessions : [],
      };
      // One-time migration: if we have a legacy budget but an empty journal, import the old local
      // funded/withdrawn/ledger as a single clearly-marked genesis row so the history display stays
      // continuous. This is NOT re-trusting local accumulation for balances — treasury/spend are now
      // read from chain; the genesis row only seeds the historical funded/withdrawn/ledger view.
      if (!txlog.get("genesis") && txlog.list().length === 0) {
        const legacyLedger = Array.isArray(b.ledger)
          ? b.ledger.map((e) => ({ ...e, amount: String(e.amount) }))
          : [];
        txlog.importGenesis({
          component: store.budget.component,
          funded: String(raw.funded ?? "0"),
          withdrawn: String(raw.withdrawn ?? "0"),
          ledger: legacyLedger,
        });
      }
    }
  }
  // Atomic + non-silent: a failed persist THROWS so the request that triggered it cannot report
  // success (the old code only warned and returned 200 — a correctness bug this closes).
  function saveStore() {
    writeJsonAtomic(STATE_FILE, store);
  }

  // name <-> address bookkeeping for friendly labels
  const nameByAddr = () => {
    const m = {};
    for (const [name, addr] of Object.entries(store.merchants)) m[addr] = name;
    return m;
  };

  /** Persist the config/reference fields (NOT balances) of a confirmed budget back to the store. */
  function snapshotBudget(b) {
    store.budget = {
      component: b.component,
      ownerBadge: b.ownerBadge,
      agentBadge: b.agentBadge,
      template: BUDGET_TEMPLATE,
      // cached config only — the authoritative values are read from chain in dashboardState():
      perTxCap: String(b.perTxCap),
      dailyCap: String(b.dailyCap),
      whitelist: b.whitelist,
      revoked: b.revoked,
      epochsPerWindow: b.epochsPerWindow,
      sessions: b.sessions,
      revokedSessions: b.revokedSessions,
    };
    saveStore();
  }

  loadStore();
  return { store, loadStore, saveStore, nameByAddr, snapshotBudget };
}

module.exports = { createStore };
