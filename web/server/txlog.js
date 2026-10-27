/**
 * Transaction journal + atomic persistence for the AgentPay dashboard (zero dependencies).
 *
 * WHY THIS EXISTS
 * The dashboard used to treat a local JSON blob (`funded - spent - withdrawn`, plus a local ledger
 * array) as the *authority* for the budget's financial state. That is wrong: the chain is the
 * authority. A local file is, at best, an **operation journal** — a durable record of what the
 * server asked the chain to do and what it last heard back — which the server reconciles *against*
 * the chain. It is never the source of truth for balances.
 *
 * This module provides exactly that journal, plus the atomic-write primitive the rest of the
 * server persists through:
 *
 *   - Every fund-moving operation gets ONE record, keyed by an **idempotency key**, with an
 *     explicit lifecycle: `pending → confirmed | rejected | unknown`.
 *       • pending   — written BEFORE we submit, so a crash mid-flight leaves a reconcilable trace.
 *       • confirmed — the chain finalized it as Accept (carries the tx id + any on-chain event).
 *       • rejected  — the chain finalized it as Reject (carries the reason).
 *       • unknown   — submitted, but we did not see a verdict in time. NEVER treated as success;
 *                     it is reconciled later by its tx id.
 *   - Idempotency: a repeat with the same key returns the recorded outcome instead of re-submitting.
 *   - Atomic, non-silent persistence: writes go to a temp file, are fsync'd, then renamed over the
 *     target (an atomic replace). A failed write THROWS — the caller must not report success.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Write `obj` as pretty JSON to `file` atomically: a crash can leave the old file or the new file,
 * never a half-written one. THROWS if the bytes could not be durably written (callers treat a
 * persistence failure as a failed request — never a silent success).
 */
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, "." + path.basename(file) + ".tmp-" + process.pid + "-" + Date.now());
  const data = JSON.stringify(obj, null, 2);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data);
    try {
      fs.fsyncSync(fd); // flush to disk before the rename so the replace is durable
    } catch {
      /* some filesystems (e.g. certain mounts) reject fsync — the rename below is still atomic */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file); // atomic replace on POSIX; Node replaces on Windows too
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const TERMINAL = new Set(["confirmed", "rejected"]);
const OPEN = new Set(["pending", "unknown"]);

/**
 * The journal. Records are held in insertion order and indexed by idempotency key. The whole set is
 * rewritten atomically on every transition (a dashboard's volume is tiny; see docs for when an
 * append-log or sqlite would be warranted instead).
 */
function createTxLog(file = process.env.AGENTPAY_TXLOG_FILE || path.resolve(__dirname, "txlog.json")) {
  /** @type {Array<Record<string, any>>} */
  let records = [];
  /** @type {Map<string, Record<string, any>>} */
  let byKey = new Map();
  let seq = 0;

  function index() {
    byKey = new Map();
    seq = 0;
    for (const r of records) {
      byKey.set(r.key, r);
      if (typeof r.seq === "number" && r.seq > seq) seq = r.seq;
    }
  }

  function load() {
    const data = readJson(file, null);
    records = Array.isArray(data) ? data : Array.isArray(data && data.records) ? data.records : [];
    index();
  }

  function persist() {
    writeJsonAtomic(file, records); // THROWS on failure — intentional
  }

  function get(key) {
    return byKey.get(key) || null;
  }
  function list() {
    return records.slice();
  }

  /**
   * Create (and persist) a `pending` record for `key`, or return the existing record if the key is
   * already known (the caller decides what to do with a prior record). Persisting the pending row
   * BEFORE the chain submit is what makes a mid-flight crash reconcilable.
   */
  function begin({ key, op, params, component }) {
    const existing = byKey.get(key);
    if (existing) return existing;
    const now = new Date().toISOString();
    const rec = {
      key,
      op,
      component: component || null, // which budget this op belongs to (scopes the history)
      params: params || {},
      status: "pending",
      txId: null,
      reason: null,
      event: null,
      seq: ++seq,
      createdAt: now,
      updatedAt: now,
    };
    records.push(rec);
    byKey.set(key, rec);
    persist(); // throws if it cannot be durably written
    return rec;
  }

  /** Merge `fields` into the record for `key`, stamp updatedAt, and persist atomically. */
  function settle(key, fields) {
    const rec = byKey.get(key);
    if (!rec) throw new Error(`txlog.settle: no record for key ${key}`);
    Object.assign(rec, fields, { updatedAt: new Date().toISOString() });
    persist();
    return rec;
  }

  /**
   * Insert a one-time genesis row that imports a pre-existing local snapshot (legacy funded /
   * withdrawn / ledger) so the history display is continuous after the switch to chain-authority.
   * Clearly marked `migrated` and non-authoritative: balances are still read live from chain.
   */
  function importGenesis({ funded, withdrawn, ledger, component }) {
    if (byKey.has("genesis")) return byKey.get("genesis");
    const now = new Date().toISOString();
    const rec = {
      key: "genesis",
      op: "migrated-genesis",
      component: component || null,
      params: { funded: String(funded || "0"), withdrawn: String(withdrawn || "0") },
      status: "confirmed",
      txId: null,
      reason: null,
      event: null,
      migrated: true,
      migratedLedger: Array.isArray(ledger) ? ledger : [],
      seq: ++seq,
      createdAt: now,
      updatedAt: now,
    };
    records.push(rec);
    byKey.set("genesis", rec);
    persist();
    return rec;
  }

  function pendingOrUnknown() {
    return records.filter((r) => OPEN.has(r.status));
  }

  /** Counts by status + the records that need operator attention (unknown, or open with no tx id). */
  function summary() {
    const counts = { pending: 0, confirmed: 0, rejected: 0, unknown: 0 };
    const needsAttention = [];
    for (const r of records) {
      if (counts[r.status] !== undefined) counts[r.status] += 1;
      if (r.status === "unknown" || (r.status === "pending" && !r.txId)) {
        needsAttention.push({ key: r.key, op: r.op, txId: r.txId, reason: r.reason, updatedAt: r.updatedAt });
      }
    }
    return { counts, needsAttention };
  }

  load();
  return {
    file,
    load,
    get,
    list,
    begin,
    settle,
    importGenesis,
    pendingOrUnknown,
    summary,
    isTerminal: (s) => TERMINAL.has(s),
    isOpen: (s) => OPEN.has(s),
  };
}

module.exports = { createTxLog, writeJsonAtomic, readJson };
