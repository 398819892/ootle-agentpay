//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * Chain-authoritative reads (treasury, spend-in-window, caps, whitelist, revoked) plus the
 * journal-derived history (funded/withdrawn totals, payment ledger) that the chain cannot provide.
 */
"use strict";

const { big } = require("./http_util");
const { numEnv } = require("./settings");
const { findComponentState, cborHex, parseBudgetState } = require("./substate");

// ---- chain-discovered payment ledger (pure helpers) --------------------------------------------
// journalLedger (below) only knows the pays THIS dashboard made (its own journal). A pay made
// against the same budget through the MCP / SDK / another dashboard leaves no journal row here, so
// it is invisible ("money moved, no row") even though the chain recorded it. These helpers rebuild
// the FULL pay history for a component straight from the account's transaction list, so the feed
// reflects the chain, not just local activity. Pure + exported so they can be unit-tested.

/** Walk a finalize tree, yielding every object that carries a string `topic` (an event). */
function* iterEvents(node) {
  if (!node || typeof node !== "object") return;
  if (typeof node.topic === "string") yield node;
  if (Array.isArray(node)) {
    for (const v of node) yield* iterEvents(v);
    return;
  }
  for (const v of Object.values(node)) yield* iterEvents(v);
}

/** Parse a walletd `last_update_time` ("YYYY-MM-DD HH:MM:SS.s") to epoch ms, or 0 if unparseable. */
function parseWalletdTime(s) {
  if (typeof s !== "string") return 0;
  const t = Date.parse(s.replace(" ", "T"));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Reconstruct a component's payments from the account's transaction list: EVERY AgentBudget `pay`
 * event for `component`, whichever client submitted the tx. Returns `{ rows, tsByTxId }` — rows
 * oldest→newest (the UI slices the tail as "recent"), and a txId→timestamp map so the caller can
 * also time-order the journal rows it merges in. Mirrors OnChainBudget.payEvents' topic/dedup rules
 * (leaf topic === "pay" excludes pay_fee / pay_via_escrow; de-dup the event's duplicated copy
 * within one tx by the strictly-increasing spent_in_window), and additionally scopes to this
 * component by the event's substate_id.
 */
function extractChainPays(txs, component) {
  const rows = [];
  const tsByTxId = new Map();
  for (const tx of Array.isArray(txs) ? txs : []) {
    if (!tx || typeof tx !== "object") continue;
    const txId = tx.id != null ? String(tx.id) : null;
    const ts = parseWalletdTime(tx.last_update_time);
    if (txId) tsByTxId.set(txId, ts);
    if (tx.is_dry_run) continue; // a dry run moved nothing — never a ledger row
    const seen = new Set();
    for (const ev of iterEvents(tx.finalize)) {
      const topic = typeof ev.topic === "string" ? ev.topic : "";
      const leaf = topic.includes(".") ? topic.slice(topic.lastIndexOf(".") + 1) : topic;
      if (leaf !== "pay") continue; // excludes pay_fee / pay_via_escrow
      if (ev.substate_id !== component) continue; // scope to THIS budget component
      const p = ev.payload;
      if (!p || typeof p !== "object" || !("merchant" in p) || !("memo" in p)) continue;
      const key = String(p.spent_in_window); // two COPIES of one event share it; two real pays differ
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ merchant: p.merchant, amount: String(p.amount), memo: p.memo, txId, ts });
    }
  }
  rows.reverse(); // transactions.list is newest-first; the ledger is oldest→newest
  return { rows, tsByTxId };
}

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
    // readInfo (a live get_info call) is authoritative for the financial state; the component SUBSTATE is
    // only needed for the whitelist. walletd can hand back a STALE local substate copy with no state body
    // (findComponentState → null) when the budget was last updated by an EXTERNAL, non-custodial payer
    // that walletd never tracked (e.g. a self-signing agent wallet paying a shared budget). In that case
    // do NOT fail the whole read if readInfo succeeded: use it, and fall back to the last-known (cached)
    // whitelist for that one field. Only when BOTH reads are unusable do we give up (caller → cache).
    if (!state && !info) throw new Error("could not read the budget component state");
    if (info) {
      let whitelist;
      let whitelistStale = false;
      if (Array.isArray(state && state[8])) {
        whitelist = state[8].map((e) => (cborHex(e) ? "component_" + cborHex(e) : null)).filter(Boolean);
      } else {
        // substate unavailable/stale — reuse the last-known whitelist (cached snapshot) and flag it.
        whitelist = ((store.budget && store.budget.whitelist) || []).slice();
        whitelistStale = true;
      }
      const window = windowStatus({
        dailyCap: Number(info.dailyCap), spentInWindow: Number(info.spentInWindow),
        windowStartEpoch: Number(info.windowStartEpoch), epochsPerWindow: Number(info.epochsPerWindow), currentEpoch,
      });
      return {
        perTxCap: info.perTxCap, // exact decimal strings (the event payload is strings — no lossy JS number)
        dailyCap: info.dailyCap,
        spentInWindow: String(window.spentInWindow), // effective (0 once the window has lazily elapsed)
        whitelist,
        whitelistStale, // true → whitelist came from cache, not this read (substate was stale)
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
            via: "manual", // legacy dashboard ledger — this dashboard's own (owner / UI) pays
            ts: e.ts || (e.time ? Date.parse(e.time) : null) || null,
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
          // How this pay was initiated. /api/v1 pays namespace their idempotency key with a NUL
          // separator (see api_v1.payKeyFor); a plain key is a dashboard/owner (manual) pay.
          via: typeof r.key === "string" && r.key.includes("\u0000") ? "api" : "manual",
          ts: r.createdAt ? Date.parse(r.createdAt) : null, // when this dashboard journaled the pay
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

  // ---- chain-discovered payment ledger (reads the account's whole tx history) ------------------
  // Heavy (the full history), so the scan is cached briefly; dashboardState merges the result with
  // the journal and falls back to the journal alone on any failure. Turn it off with
  // AGENTPAY_CHAIN_LEDGER=0 (then the feed is journal-only, the pre-feature behaviour); tune the
  // cache with AGENTPAY_CHAIN_LEDGER_TTL_MS (default 15s).
  const CHAIN_LEDGER_ON = process.env.AGENTPAY_CHAIN_LEDGER !== "0";
  const CHAIN_LEDGER_TTL_MS = numEnv("AGENTPAY_CHAIN_LEDGER_TTL_MS", 15000, { min: 0 });
  const chainPayCache = new Map(); // component -> { at, value }
  /** Cached `{ rows, tsByTxId }` for a component, or null when disabled. Throws on a walletd failure. */
  async function chainPayScan(component) {
    if (!CHAIN_LEDGER_ON) return null;
    const hit = chainPayCache.get(component);
    if (hit && Date.now() - hit.at < CHAIN_LEDGER_TTL_MS) return hit.value;
    const c = await walletd();
    const txs = await c.listTransactions({ offset: 0, limit: 1000 });
    const value = extractChainPays(txs, component);
    chainPayCache.set(component, { at: Date.now(), value });
    return value;
  }

  return {
    liveBudget, vaultBalanceFromSubstate, readChainBudget, journalTotals, journalLedger,
    firstPayEvent, chainPayScan,
  };
}

module.exports = { createChainReads, extractChainPays, parseWalletdTime };
