/**
 * AgentBudget component-substate parsing (zero dependencies), split out so it is unit-testable.
 *
 * #16: the component state is a POSITIONAL array (struct field order). The old reader took "the first
 * 5 numbers / the first boolean / the first array", which silently returned WRONG values if the
 * struct field order ever changed. This version reads by EXPLICIT index and asserts each slot's type,
 * so a layout drift throws a clear error instead of reporting bad numbers as if they were real.
 *
 * NOTE: a fully type-safe read would call the template's `get_info` via a dry-run and decode a typed
 * return; that needs the live walletd result shape to validate against, so it is tracked as the
 * remaining part of #16 in docs/audit-notes.md. This strict positional read is the loud-failure
 * stopgap: it cannot catch a same-type field swap, but it ends the "silently wrong" failure mode.
 *
 * Struct order (templates/agent_budget/src/lib.rs, see docs/custody.md §state-model):
 *   [0] vault  [1] owner_badge  [2] agent_badge  [3] per_tx_cap  [4] daily_cap
 *   [5] spent_in_window  [6] window_start_epoch  [7] epochs_per_window
 *   [8] merchant_whitelist  [9] revoked  [10] revoked_sessions  [11..] escrow fields
 */
"use strict";

/** Find the AgentBudget component's positional state array anywhere in a substates.get result. */
function findComponentState(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findComponentState(v);
      if (r) return r;
    }
    return null;
  }
  if (node.Component && node.Component.body && Array.isArray(node.Component.body.state)) {
    return node.Component.body.state;
  }
  for (const v of Object.values(node)) {
    const r = findComponentState(v);
    if (r) return r;
  }
  return null;
}

/** A CBOR-tagged address object → its 32-byte hex, or null. */
function cborHex(x) {
  return x && typeof x === "object" && x.value && typeof x.value.hex === "string" ? x.value.hex : null;
}

/**
 * Parse the positional AgentBudget component state by explicit index + type. Throws a descriptive
 * error (which the caller turns into a cache fallback) if any slot is not the expected type.
 * Returns the raw positional fields; the caller maps the whitelist and computes the window.
 */
function parseBudgetState(state) {
  if (!Array.isArray(state) || state.length < 10) {
    throw new Error(
      `unexpected budget component layout: expected an array of >=10 fields, got ` +
        (Array.isArray(state) ? `length ${state.length}` : typeof state),
    );
  }
  const vaultHex = cborHex(state[0]);
  if (!vaultHex) throw new Error("unexpected budget component layout: field 0 (vault) is not an address");
  const num = (i, name) => {
    const v = state[i];
    if (typeof v !== "number") {
      throw new Error(`unexpected budget component layout: field ${i} (${name}) is ${typeof v}, expected number`);
    }
    return v;
  };
  const perTxCap = num(3, "per_tx_cap");
  const dailyCap = num(4, "daily_cap");
  const spentInWindow = num(5, "spent_in_window");
  const windowStartEpoch = num(6, "window_start_epoch");
  const epochsPerWindow = num(7, "epochs_per_window");
  if (!Array.isArray(state[8])) {
    throw new Error("unexpected budget component layout: field 8 (merchant_whitelist) is not an array");
  }
  if (typeof state[9] !== "boolean") {
    throw new Error("unexpected budget component layout: field 9 (revoked) is not a boolean");
  }
  return {
    vaultHex,
    perTxCap,
    dailyCap,
    spentInWindow,
    windowStartEpoch,
    epochsPerWindow,
    whitelistRaw: state[8],
    revoked: state[9],
  };
}

module.exports = { findComponentState, cborHex, parseBudgetState };
