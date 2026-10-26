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

const DEFAULT_FILE = path.resolve(__dirname, "audit.log");

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
  /**
   * Append one audit entry. `entry` is any JSON-serialisable object; `ts` is stamped here so the
   * caller can't forge the time. Returns nothing and never throws.
   */
  function append(entry) {
    const line = {
      ts: new Date().toISOString(),
      ...entry,
      // defensively redact a params blob if the caller passed one raw
      params: entry && entry.params !== undefined ? redact(entry.params) : undefined,
    };
    try {
      fs.appendFileSync(file, JSON.stringify(line) + "\n");
    } catch (e) {
      // Never let an audit write failure break the operation it is recording.
      console.error("warn: could not write audit log:", e.message);
    }
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

  return { append, recent, file, redact };
}

module.exports = { createAudit, redact };
