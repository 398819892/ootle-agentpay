/**
 * Idempotency PARAMETER FINGERPRINT for the AgentPay dashboard (zero dependencies).
 *
 * WHY THIS EXISTS
 * An idempotency key is a promise: "this exact operation, at most once". The journal (txlog.js) and
 * the cross-process claim (claims.js) already guarantee the "at most once" half — one key maps to one
 * chain effect. But a key on its own does not pin WHAT that effect is. If a client (or an attacker who
 * has seen a key) reuses the SAME key with DIFFERENT parameters — a larger amount, a different payee —
 * the "replay the prior receipt" path would silently return the ORIGINAL outcome and quietly ignore the
 * new, different request. That is a correctness/safety hole: the caller believes it moved 700 to Mallory
 * and got back "done" (the receipt for 300 to the shop), or a genuine key-collision masks a real second
 * payment. Neither should pass silently.
 *
 * THE FIX — bind the key to a canonical fingerprint of the operation's funding-relevant parameters
 * (operation type + budget component + payee + amount + memo + session + caps…). The fingerprint is
 * recorded alongside the key in BOTH the journal record and the cross-process claim marker. On any
 * repeat of a key:
 *   - same key + SAME fingerprint  → a genuine idempotent replay: return the recorded receipt.
 *   - same key + DIFFERENT finger  → REJECT with 409 (idempotencyConflict). NEVER silently return the
 *                                    old receipt for a request whose parameters differ.
 * Legacy records written before this field existed carry no fingerprint; they are treated as "unknown,
 * cannot conflict" so the upgrade is backward-compatible (they simply replay as before).
 *
 * The fingerprint is a plain SHA-256 over a STABLE JSON encoding (keys sorted recursively) so it does
 * not depend on property insertion order, and amounts are normalised to decimal strings so `300`,
 * `"300"` and `300n` all fingerprint identically.
 */
"use strict";

const crypto = require("node:crypto");

/** Normalise one scalar into a stable, type-independent string form (BigInt/number/amount → decimal). */
function normScalar(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return String(v);
}

/** Deterministic JSON: object keys sorted recursively; arrays keep order; scalars normalised. */
function stableStringify(value) {
  const seen = new Set();
  const walk = (v) => {
    if (v == null) return null;
    if (typeof v === "object") {
      if (seen.has(v)) throw new Error("stableStringify: circular reference");
      seen.add(v);
      let out;
      if (Array.isArray(v)) {
        out = v.map(walk);
      } else {
        out = {};
        for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      }
      seen.delete(v);
      return out;
    }
    return normScalar(v);
  };
  return JSON.stringify(walk(value));
}

/**
 * Canonical fingerprint of an operation's identity + funding parameters. `params` is the curated,
 * per-op object the server already passes to the journal (e.g. { merchant, amount, invoiceId, memo }),
 * so no field list is hard-coded here — whatever defines the operation defines its fingerprint.
 */
function paramFingerprint(op, component, params) {
  const canon = stableStringify({ op: op || null, component: component || null, params: params || {} });
  return crypto.createHash("sha256").update(canon).digest("hex");
}

/**
 * Decide whether a repeat of an idempotency key may replay a prior record, or conflicts with it.
 * `priorFp` is the fingerprint recorded on the existing record/claim; `fp` is this request's.
 *   - returns true  → a conflict: same key, different parameters → caller must reject (409).
 *   - returns false → no conflict: either the fingerprints match, or the prior carries none (legacy).
 */
function conflicts(priorFp, fp) {
  return Boolean(priorFp) && Boolean(fp) && priorFp !== fp;
}

module.exports = { paramFingerprint, stableStringify, conflicts };
