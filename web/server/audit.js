/**
 * Append-only audit log for the AgentPay dashboard (zero dependencies).
 *
 * Every state-changing API call (who, what, when, tx id, result) is written as one JSON line to an
 * append-only file. The log is the record of what the *hosted* wallet was asked to do — the chain
 * is still the source of truth for what actually moved, but this is where an operator reconstructs
 * "who told the server to withdraw, and when".
 *
 * Design choices:
 *  - JSONL (one JSON object per line): append-only, grep-able, trivially shippable to a real log
 *    sink later. We only ever `appendFile`; we never rewrite or truncate it here.
 *  - Secrets never reach the log: `redact()` strips password / token / secret-ish fields from any
 *    params summary before it is written. Callers should also avoid passing raw secrets.
 *  - Best-effort durability: a failed write is logged to stderr but never throws into the request
 *    path, so an audit-disk hiccup can't take payments down. (A production deployment should ship
 *    these lines to an append-only sink off-box — see docs/custody.md.)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_FILE = path.resolve(__dirname, "audit.log");
// Genesis `prevHash` for the first record in a fresh log (64 hex zeros).
const GENESIS_HASH = "0".repeat(64);

/** sha256 hex of `prevHash` concatenated with the canonical (pre-hash) JSON of a record. */
function hashRecord(prevHash, canonicalJson) {
  return crypto.createHash("sha256").update(prevHash + "\n" + canonicalJson).digest("hex");
}

// Keys whose values must never be written to the audit log, matched case-insensitively as a
// substring so `password`, `adminPassword`, `confirmToken`, `sessionSecret`, … are all caught.
const SECRET_KEY_RE = /pass|secret|token|cookie|authorization|keyring/i;

/** Return a shallow, secret-free copy of an object for logging. Non-objects pass through. */
function redact(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "[redacted]";
    } else if (v && typeof v === "object") {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function createAudit(file = process.env.AGENTPAY_AUDIT_FILE || DEFAULT_FILE) {
  // Hash-chain head: each record carries the hash of the one before it, so a deleted or edited line
  // breaks the chain and is detectable (`verify`). In-memory and single-instance (matches the rest of
  // the server's security state); it is NOT a substitute for shipping the log to an append-only,
  // off-box sink — that is what makes tampering impossible rather than merely detectable. Seeded from
  // the last well-formed record already on disk so the chain continues across restarts.
  let lastHash = (() => {
    try {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const o = JSON.parse(lines[i]);
          if (typeof o.hash === "string" && o.hash) return o.hash;
        } catch {
          /* skip a malformed trailing line */
        }
      }
    } catch {
      /* no file yet */
    }
    return GENESIS_HASH;
  })();

  /**
   * Stamp the time (so the caller can't forge it), redact secrets, and chain the record to the
   * previous one. Returns the JSONL text to write AND the new head hash — the caller advances
   * `lastHash` only AFTER the bytes are durably written, so a failed write never leaves a gap.
   */
  function buildLine(entry) {
    const base = {
      ts: new Date().toISOString(),
      ...entry,
      // defensively redact a params blob if the caller passed one raw
      params: entry && entry.params !== undefined ? redact(entry.params) : undefined,
    };
    const prevHash = lastHash;
    const hash = hashRecord(prevHash, JSON.stringify(base));
    return { text: JSON.stringify({ ...base, prevHash, hash }) + "\n", hash };
  }

  /**
   * Append one audit entry. `entry` is any JSON-serialisable object; `ts` is stamped here so the
   * caller can't forge the time. Best-effort: a write failure is logged, never thrown — used for
   * low-risk / informational entries where losing one line must not take the request path down.
   */
  function append(entry) {
    const { text, hash } = buildLine(entry);
    try {
      fs.appendFileSync(file, text);
      lastHash = hash; // advance the chain head only once the line is on disk
    } catch (e) {
      // Never let a best-effort audit write failure break the operation it is recording.
      console.error("warn: could not write audit log:", e.message);
    }
  }

  /**
   * DURABLE append for HIGH-RISK fund operations: synchronously append AND fsync to disk, and THROW
   * if the bytes cannot be durably written. The caller treats a failure here as the operation failing
   * — a money action we cannot record is one we refuse to take (see authorizer.js). We open with 'a'
   * (atomic append), write, fsync the file descriptor, then close; any error propagates.
   */
  function appendStrict(entry) {
    const { text, hash } = buildLine(entry);
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd); // flush to stable storage before we report the action as recorded
    } finally {
      fs.closeSync(fd);
    }
    lastHash = hash; // reached only if the write + fsync above did not throw
  }

  /**
   * Verify the on-disk hash chain: each record's `hash` must equal sha256(prevHash + its canonical
   * body), and each `prevHash` must equal the previous record's `hash`. Returns `{ ok, count,
   * brokenAt }` — `brokenAt` is the 0-based index of the first record that fails (null if intact).
   * A deleted, reordered or edited line is detected here. Records with no `hash` (pre-chain legacy
   * lines) are skipped until the first chained record, which is allowed to start from GENESIS.
   */
  function verify() {
    let lines;
    try {
      lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch {
      return { ok: true, count: 0, brokenAt: null }; // no log yet is trivially intact
    }
    let prev = GENESIS_HASH;
    let started = false;
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      let o;
      try {
        o = JSON.parse(lines[i]);
      } catch {
        return { ok: false, count, brokenAt: i };
      }
      if (typeof o.hash !== "string") {
        if (started) return { ok: false, count, brokenAt: i }; // a gap after the chain began
        continue; // legacy pre-chain line before any chained record
      }
      const { hash, prevHash, ...body } = o;
      const expect = hashRecord(prevHash, JSON.stringify(body));
      if (hash !== expect || prevHash !== prev) return { ok: false, count, brokenAt: i };
      prev = hash;
      started = true;
      count++;
    }
    return { ok: true, count, brokenAt: null };
  }

  /** Best-effort read of the last `limit` entries (newest last), for an operator read-out. */
  function recent(limit = 100) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n").filter(Boolean);
      return lines
        .slice(-Math.max(1, Math.min(1000, limit)))
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { ts: null, raw: l };
          }
        });
    } catch {
      return [];
    }
  }

  return { append, appendStrict, recent, verify, file, redact };
}

module.exports = { createAudit, redact };
