/**
 * Cross-process idempotency CLAIMS for the AgentPay dashboard (zero dependencies).
 *
 * WHY THIS EXISTS
 * The journal (txlog.js) enforces idempotency *within one process* via an in-memory map keyed by
 * the Idempotency-Key. That is not enough when TWO backend instances share the same state/journal
 * files and the same chain: each process has its own in-memory map, so the SAME key sent
 * concurrently to BOTH instances is submitted to chain twice → a double-spend (the chain has no
 * invoice-level dedup; that guarantee is ours). This was the one hard go-live gate the B-6
 * multi-instance harness reproduced.
 *
 * THE FIX — an atomic, cross-process "claim" taken BEFORE the chain submit, using the one primitive
 * a shared POSIX/Windows filesystem gives us for free: an EXCLUSIVE create. `fs.openSync(path, "wx")`
 * (O_CREAT|O_EXCL) succeeds for exactly ONE caller across all processes on the shared filesystem and
 * fails with EEXIST for every other; it is atomic — there is no check-then-create window to race.
 * So:
 *
 *   - Processing an op with key K first calls `tryClaim(K)`. Exactly one process WINS (creates the
 *     marker) and is the only one allowed to submit K to chain. Every other caller LOSES (EEXIST)
 *     and must NOT submit — it reads the shared journal and replays the winner's recorded outcome
 *     (polling while that outcome is still pending).
 *   - The marker is just the GATE (its existence is the claim). The authoritative lifecycle
 *     (pending→confirmed|rejected|unknown) stays in the shared journal, which is reconciled against
 *     the chain exactly as before — so a crash that leaves a claim but no verdict is recovered by
 *     the existing A-2 startup reconcile + `unknown` handling, and is NEVER auto-resubmitted.
 *
 * HONEST SCOPE: this coordinates multiple instances that share ONE filesystem (the B-6 scenario:
 * same host, shared state dir). It does NOT coordinate instances on different hosts with separate
 * filesystems — that still needs a real shared store (Postgres / Redis) with a uniqueness
 * constraint on the idempotency key + a distributed lock. See docs/stability.md.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

// A claim whose owner never resolved it and is older than this is "stale" — surfaced for operator
// attention, but NEVER auto-reclaimed (reclaiming could double-spend if the owner did submit before
// dying without recording a tx id). Conservative on purpose: we favour "never double-spend" over
// "always available". Tunable for tests.
const STALE_MS = Number(process.env.AGENTPAY_CLAIM_STALE_MS || 10 * 60 * 1000);

/** Filesystem-safe, fixed-length marker filename for an arbitrary idempotency key. */
function fileFor(dir, key) {
  const h = crypto.createHash("sha1").update(String(key)).digest("hex");
  return path.join(dir, h + ".claim");
}

function createClaimStore(dir) {
  let ensured = false;
  function ensureDir() {
    if (ensured) return;
    fs.mkdirSync(dir, { recursive: true });
    ensured = true;
  }

  /**
   * Atomically attempt to claim `key`. Returns:
   *   { won: true }                         — this process created the marker; it alone may submit.
   *   { won: false, record, stale }         — someone else holds (or held) the key; do NOT submit.
   * `record` is the marker's provenance (pid/host/startedAt) when readable, else null. A failure to
   * create for any reason OTHER than EEXIST throws — a claim we cannot take must not be assumed won.
   */
  function tryClaim(key, meta = {}) {
    ensureDir();
    const file = fileFor(dir, key);
    const body = JSON.stringify({
      key: String(key),
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      ...meta,
    });
    let fd;
    try {
      fd = fs.openSync(file, "wx"); // atomic exclusive create — the cross-process gate
    } catch (e) {
      if (e && e.code === "EEXIST") {
        const record = read(key);
        const stale = Boolean(record && record.startedAt && Date.now() - Date.parse(record.startedAt) > STALE_MS);
        return { won: false, record, stale, file };
      }
      throw e; // ENOENT (dir vanished), EACCES, … — propagate; never silently "win"
    }
    try {
      fs.writeSync(fd, body);
      try { fs.fsyncSync(fd); } catch { /* some mounts reject fsync; the marker's existence is the claim */ }
    } finally {
      fs.closeSync(fd);
    }
    return { won: true, file };
  }

  /** Read a marker's provenance (never the op outcome — that lives in the journal). Null if absent. */
  function read(key) {
    try {
      return JSON.parse(fs.readFileSync(fileFor(dir, key), "utf8"));
    } catch {
      return null;
    }
  }

  function has(key) {
    try { fs.accessSync(fileFor(dir, key)); return true; } catch { return false; }
  }

  /** Remove a marker. Only ever called for a key whose journal record is already TERMINAL, where the
   *  durable journal record (not the marker) carries the replay guarantee. Best-effort. */
  function release(key) {
    try { fs.unlinkSync(fileFor(dir, key)); return true; } catch { return false; }
  }

  /** List all claim markers (provenance only), for diagnostics / stale sweeps. */
  function list() {
    ensureDir();
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".claim")); } catch { return out; }
    for (const n of names) {
      try { out.push({ file: path.join(dir, n), ...JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) }); } catch { /* skip unreadable */ }
    }
    return out;
  }

  return { dir, tryClaim, read, has, release, list, fileFor: (k) => fileFor(dir, k), STALE_MS };
}

module.exports = { createClaimStore };
