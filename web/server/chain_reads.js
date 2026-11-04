//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * Chain-authoritative reads (treasury, spend-in-window, caps, whitelist, revoked) plus the
 * journal-derived history (funded/withdrawn totals, payment ledger) that the chain cannot provide.
 */
"use strict";

const { big } = require("./http_util");
const { findComponentState, cborHex, parseBudgetState } = require("./substate");

function createChainReads({ store, walletd, conn, txlog, OnChainBudget, windowStatus, budgetTemplate: BUDGET_TEMPLATE }) {
  /** Rebuild a live OnChainBudget from the persisted snapshot (or null if none open). */
  async function liveBudget() {
    if (!store.budget) return null;
    const c = await walletd();
    // walletd parses manifest variables as values, so an account is referenced by its component
    // address (not its name). conn.ownerAddr is resolved by walletd().
    const b = new OnChainBudget(c, BUDGET_TEMPLATE, conn.ownerAddr);
    Object.assign(b, store.budget);
    return b;
  }

  // ---- chain-authoritative reads ---------------------------------------------------------------
  // The displayed balances/policy MUST come from the chain, not from local accumulation. The
  // AgentBudget component substate is a positional array; the vault (treasury) is a child substate.
  // We parse both here so treasury / spend-in-window / caps / whitelist / revoked are all derived
  // live from chain. Best-effort: callers fall back to the cached config + journal if a read fails.

  // #16: the positional substate parse lives in a unit-tested module and reads by explicit index +
  // type (throws on layout drift) instead of "first N numbers" (which read wrong values silently).

  /** Pull the vault's token balance out of a vault substate as an exact decimal string (BigInt-safe). */
  function vaultBalanceFromSubstate(sub) {
    const s = JSON.stringify(sub || {});
    // Stealth (devnet XTR) exposes `revealed_amount`; a plain fungible vault exposes `amount`.
    const m = s.match(/"revealed_amount":"(\d+)"/) || s.match(/"amount":"(\d+)"/);
    return m ? m[1] : null;
  }

  /**
   * Read the authoritative financial + policy state of a budget directly from chain:
   *   treasury (vault balance), spend-in-window, caps, whitelist, revoked, and the rolling window.
   * Throws if the component/vault cannot be read (caller falls back to cache).
   */
  async function readChainBudget(component) {
    const c = await walletd();
    const currentEpoch = await c.currentEpoch();
    // Prefer the name-keyed `get_info` info-event read (OnChainBudget.readInfo, #1): it decodes the
    // caps/spend/revoked/balance BY NAME, so a same-type field swap in the component struct is caught —
    // the gap the positional parse below cannot see. Fall back to the positional parse if the info event
    // is unavailable (older template / changed shape). The whitelist is always read positionally (it is
    // the only list field — no same-type-swap risk).
    let info = null;
    try {
      const b = new OnChainBudget(c, BUDGET_TEMPLATE, conn.ownerAddr);
      b.component = component;
      info = await b.readInfo();
    } catch (_e) {
      /* fall back to the positional parse below */
    }
    const sub = await c.getSubstate(component);
    const state = findComponentState(sub);
    if (!state) throw new Error("could not read the budget component state");
    if (info) {
      const wlRaw = Array.isArray(state[8]) ? state[8] : [];
      const whitelist = wlRaw.map((e) => (cborHex(e) ? "component_" + cborHex(e) : null)).filter(Boolean);
      const window = windowStatus({
        dailyCap: Number(info.dailyCap), spentInWindow: Number(info.spentInWindow),
        windowStartEpoch: Number(info.windowStartEpoch), epochsPerWindow: Number(info.epochsPerWindow), currentEpoch,
      });
      return {
        perTxCap: info.perTxCap, // exact decimal strings (the event payload is strings — no lossy JS number)
        dailyCap: info.dailyCap,
        spentInWindow: String(window.spentInWindow), // effective (0 once the window has lazily elapsed)
        whitelist,
        revoked: info.revoked,
        vaultBalance: info.balance, // vault.balance() from the info event — no separate vault read needed
        window,
      };
    }
    // Fallback: strict, position-pinned parse (throws on layout drift; see substate.js / audit #16).
    const { perTxCap, dailyCap, spentInWindow, windowStartEpoch, epochsPerWindow, revoked, whitelistRaw, vaultHex } =
      parseBudgetState(state);
    const whitelist = whitelistRaw.map((e) => (cborHex(e) ? "component_" + cborHex(e) : null)).filter(Boolean);
    let vaultBalance = null;
    if (vaultHex) {
      try {
        vaultBalance = vaultBalanceFromSubstate(await c.getSubstate("vault_" + vaultHex));
      } catch (e) {
        console.error("warn: could not read vault balance:", e.message);
      }
    }
    const window = windowStatus({ dailyCap, spentInWindow, windowStartEpoch, epochsPerWindow, currentEpoch });
    return {
      // Note: caps/spend come back as JS numbers from the CBOR substate. `parseBudgetState` now REFUSES
      // a value outside JS safe-integer range (throws → we fall back to cache) instead of surfacing a
      // silently-rounded one; the lossless fix (bigint parse at the RPC boundary) is tracked post-mainnet.
      // Treasury is a string and exact. See docs/stability.md §5 / custody.md.
      perTxCap: String(perTxCap),
      dailyCap: String(dailyCap),
      spentInWindow: String(window.spentInWindow), // effective (0 once the window has lazily elapsed)
      whitelist,
      revoked: Boolean(revoked),
      vaultBalance,
      window,
    };
  }

  // ---- journal-derived history (NOT authority for balances) ------------------------------------
  /** Sum confirmed funding/withdrawal from the journal (scoped to one budget component). */
  function journalTotals(component) {
    let funded = 0n;
    let withdrawn = 0n;
    for (const r of txlog.list()) {
      if (r.status !== "confirmed") continue;
      if (component && r.component && r.component !== component) continue;
      if (r.op === "createBudget") funded += big(r.params && r.params.fund);
      else if (r.op === "topUp") funded += big(r.params && r.params.amount);
      else if (r.op === "withdraw") withdrawn += big(r.params && r.params.amount);
      else if (r.op === "migrated-genesis") {
        funded += big(r.params && r.params.funded);
        withdrawn += big(r.params && r.params.withdrawn);
      }
    }
    return { funded: funded.toString(), withdrawn: withdrawn.toString() };
  }
  /** Rebuild the payment ledger from the journal's confirmed `pay` events (+ migrated legacy rows). */
  function journalLedger(component, label) {
    const out = [];
    for (const r of txlog.list()) {
      if (component && r.component && r.component !== component) continue;
      if (r.op === "migrated-genesis" && Array.isArray(r.migratedLedger)) {
        for (const e of r.migratedLedger) {
          out.push({
            merchant: e.merchant,
            merchantName: label(e.merchant),
            amount: String(e.amount),
            memo: e.memo,
            onchainMemo: e.memo,
            txKind: e.txKind || "pay",
            status: "confirmed",
            txId: null,
            migrated: true,
          });
        }
      }
      if (r.op === "pay" && r.status === "confirmed" && r.event) {
        // Show the caller's free-text memo (what they typed) in the list; fall back to the
        // on-chain codec memo (ap1|<invoiceId>|<agentTag>) when no free text was given. The
        // codec memo is kept as `onchainMemo` so the UI can still surface the provable value.
        out.push({
          merchant: r.event.merchant,
          merchantName: label(r.event.merchant),
          amount: String(r.event.amount),
          memo: (r.params && r.params.memo) || r.event.memo,
          onchainMemo: r.event.memo,
          txKind: "pay",
          status: "confirmed",
          txId: r.txId,
        });
      }
    }
    return out.map((e, i) => ({ index: i, ...e }));
  }
  /** The first AgentBudget `pay` event from a finalized tx result (merchant/amount/memo). */
  function firstPayEvent(res) {
    const evs = OnChainBudget.payEvents(res) || [];
    if (!evs.length) return null;
    const p = evs[0];
    return { merchant: p.merchant, amount: String(p.amount), memo: p.memo };
  }

  return { liveBudget, vaultBalanceFromSubstate, readChainBudget, journalTotals, journalLedger, firstPayEvent };
}

module.exports = { createChainReads };
