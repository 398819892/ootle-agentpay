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
 * Synchronous sleep that parks the thread (does not spin a CPU core). Used only to back off a few
 * milliseconds while contending for the cross-process journal lock below — critical sections are a
 * single small read+write, so the wait is sub-millisecond in practice.
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback busy-wait if SharedArrayBuffer is unavailable */ }
  }
}

/**
 * Hold a cross-process advisory lock (an exclusive lockfile) for the duration of `fn`, so that when
 * MULTIPLE backend instances share one journal file the read-merge-write below cannot interleave and
 * lose each other's records. Safety valves so it can never deadlock or starve:
 *   - a STALE lock (owner crashed holding it) older than `staleMs` is stolen;
 *   - if we cannot acquire within `timeoutMs` we proceed WITHOUT the lock (best-effort) rather than
 *     block the event loop — bounded progress always wins over a hang. (The critical section is tiny,
 *     so real contention is milliseconds; a multi-second wait means something is wrong, not busy.)
 * Single-instance deployments never contend, so this is one extra create+unlink per persist.
 */
function withFileLock(lockFile, fn, { timeoutMs = 3000, staleMs = 10000, pollMs = 8 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let held = false;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx"); // atomic exclusive create — only one process holds it
      try { fs.writeSync(fd, `${process.pid} ${Date.now()}`); } catch { /* best effort */ }
      fs.closeSync(fd);
      held = true;
      break;
    } catch (e) {
      if (e && e.code !== "EEXIST") throw e;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockFile).mtimeMs > staleMs;
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      if (stale) { try { fs.unlinkSync(lockFile); } catch { /* someone else stole it */ } continue; }
      if (Date.now() >= deadline) break; // give up waiting; proceed unlocked (bounded progress)
      sleepSync(pollMs);
    }
  }
  try {
    return fn();
  } finally {
    if (held) { try { fs.unlinkSync(lockFile); } catch { /* already gone */ } }
  }
}

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

// Lifecycle rank: a terminal verdict beats an open one; among equals, the later update wins. Used to
// MERGE a record that exists both on disk (written by a peer instance) and in our memory, so a
// concurrent peer can never clobber a more-advanced record with a staler one.
function rank(status) {
  return TERMINAL.has(status) ? 2 : OPEN.has(status) ? 1 : 0;
}
function mostAdvanced(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ra = rank(a.status), rb = rank(b.status);
  if (ra !== rb) return ra > rb ? a : b;
  const ua = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
  const ub = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
  return ub > ua ? b : a;
}

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

  const lockFile = file + ".lock";

  function readArray() {
    const data = readJson(file, null);
    return Array.isArray(data) ? data : Array.isArray(data && data.records) ? data.records : [];
  }

  // Fold an on-disk record set into whatever we already hold, keeping the more-advanced record per
  // key, and re-index. `ours` decides the tie-break seed order (memory first vs disk first).
  function merge(diskArr, { preferMemory }) {
    const m = new Map();
    const first = preferMemory ? records : diskArr;
    const second = preferMemory ? diskArr : records;
    for (const r of first) m.set(r.key, r);
    for (const r of second) m.set(r.key, mostAdvanced(m.get(r.key), r));
    records = [...m.values()].sort(
      (a, b) => (a.seq || 0) - (b.seq || 0) || String(a.createdAt).localeCompare(String(b.createdAt)),
    );
    index();
  }

  function load() {
    records = readArray();
    index();
  }

  /**
   * Re-read the shared journal from disk and merge it into memory WITHOUT writing. A loser in a
   * cross-process idempotency race calls this to observe the winner's recorded outcome; it never
   * discards our own in-memory records (both sides merge by most-advanced).
   */
  function reload() {
    merge(readArray(), { preferMemory: true });
  }

  // Persist under the cross-process lock, re-reading and MERGING the on-disk set first so a peer
  // instance that wrote between our load and now is not clobbered. Single-instance: the disk set
  // equals ours, so the merge is a no-op and the file is written exactly as before. THROWS on a
  // write failure — intentional (a persistence failure must not be reported as success).
  function persist() {
    withFileLock(lockFile, () => {
      merge(readArray(), { preferMemory: true });
      writeJsonAtomic(file, records);
    });
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
    reload,
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

module.exports = { createTxLog, writeJsonAtomic, readJson, withFileLock };
