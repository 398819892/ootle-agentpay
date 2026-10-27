/**
 * API-key authentication for the machine-to-machine integration API (/api/v1) — zero dependencies.
 *
 * WHY THIS EXISTS
 * The browser dashboard authenticates a *human operator* with a password → signed session cookie
 * (+ CSRF). That is the wrong credential for a third-party service or an autonomous agent calling
 * the hosted AgentPay API server-to-server: there is no browser, no cookie jar, no CSRF token, and
 * the caller must be identified by a long-lived, revocable secret instead.
 *
 * This module is that second, independent credential surface. It is deliberately small:
 *   - Keys are provisioned out of band (env `AGENTPAY_API_KEYS`), each with a non-secret `id`
 *     (shown in the audit trail) and a `role` (`agent` or `admin`). The role drives tiered access:
 *     an agent key may pay and read; an admin key may also register merchants and read the audit log.
 *   - Only the SHA-256 digest of each secret is held in memory; verification is constant-time over
 *     every configured key (no early exit, no length leak), so a wrong key reveals nothing by timing.
 *   - A key can be revoked at runtime; the revocation set is persisted in the dashboard store so it
 *     survives a restart. (The key list itself stays in env — this module never writes secrets.)
 *
 * It intentionally does NOT implement per-key rate limits, quotas, automatic rotation or scopes
 * finer than agent/admin — those are listed as out-of-scope follow-ups in docs/api.md. The on-chain
 * AgentBudget still enforces the real spending limits regardless of which key calls.
 */
"use strict";

const crypto = require("node:crypto");

const ROLES = Object.freeze({ AGENT: "agent", ADMIN: "admin" });
const ID_RE = /^[A-Za-z0-9_.-]{1,48}$/;
const MIN_SECRET = 16;

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest();
}

/**
 * Parse the `AGENTPAY_API_KEYS` value. Entries are separated by commas or newlines; each entry is
 *   role:id:secret
 * where `role` is agent|admin, `id` is a short non-secret label (unique), and `secret` is the bearer
 * value the client presents (may itself contain ':'). Blank lines and `#` comments are ignored.
 * Throws a clear error on a malformed entry so a misconfiguration fails fast at startup.
 */
function parseKeys(raw) {
  const out = [];
  const seen = new Set();
  for (const chunk of String(raw || "").split(/[\n,]/)) {
    const line = chunk.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(":");
    if (parts.length < 3) {
      throw new Error(`AGENTPAY_API_KEYS: entry must be "role:id:secret" (got "${line.slice(0, 16)}…")`);
    }
    const role = parts[0].trim().toLowerCase();
    const id = parts[1].trim();
    const secret = parts.slice(2).join(":").trim(); // allow ':' inside the secret
    if (role !== ROLES.AGENT && role !== ROLES.ADMIN) {
      throw new Error(`AGENTPAY_API_KEYS: unknown role "${role}" for key "${id}" (use agent|admin)`);
    }
    if (!ID_RE.test(id)) throw new Error(`AGENTPAY_API_KEYS: bad key id "${id}" (letters/digits/._- , max 48)`);
    if (secret.length < MIN_SECRET) {
      throw new Error(`AGENTPAY_API_KEYS: secret for key "${id}" is too short (min ${MIN_SECRET} chars)`);
    }
    if (seen.has(id)) throw new Error(`AGENTPAY_API_KEYS: duplicate key id "${id}"`);
    seen.add(id);
    out.push({ id, role, digest: sha256(secret) });
  }
  return out;
}

/**
 * Build the API-key verifier.
 * @param {object} cfg
 * @param {string} cfg.raw             - the AGENTPAY_API_KEYS env value
 * @param {object} cfg.store           - the dashboard store (revocations persisted under store.apiKeys)
 * @param {Function} [cfg.save]        - persist the store (called after a revoke)
 * @param {{append:Function}} [cfg.audit]
 */
function createApiKeys({ raw, store, save, audit } = {}) {
  const keys = parseKeys(raw);
  if (!store.apiKeys || typeof store.apiKeys !== "object") store.apiKeys = {};
  if (!store.apiKeys.revoked || typeof store.apiKeys.revoked !== "object") store.apiKeys.revoked = {};

  function isRevoked(id) {
    return Boolean(store.apiKeys.revoked[id]);
  }

  /**
   * Verify a presented secret. Returns `{ id, role }` for a known, non-revoked key, else null.
   * Constant-time: the presented digest is compared against EVERY configured key with
   * timingSafeEqual (32-byte digests are always equal length) and no early exit.
   */
  function verify(presented) {
    if (!presented) return null;
    const d = sha256(presented);
    let match = null;
    for (const k of keys) {
      if (crypto.timingSafeEqual(d, k.digest)) match = k;
    }
    if (!match || isRevoked(match.id)) return null;
    return { id: match.id, role: match.role };
  }

  /** Revoke a key by id (persisted). Returns false if no such key is configured. */
  function revoke(id) {
    if (!keys.some((k) => k.id === id)) return false;
    if (!store.apiKeys.revoked[id]) {
      store.apiKeys.revoked[id] = new Date().toISOString();
      if (save) save();
      if (audit) audit.append({ actor: "admin", op: "revokeApiKey", tier: "admin", status: "ok", params: { id } });
    }
    return true;
  }

  /** Public, secret-free metadata for every configured key. */
  function list() {
    return keys.map((k) => ({ id: k.id, role: k.role, revoked: isRevoked(k.id) }));
  }

  function configured() {
    return keys.length > 0;
  }

  return { verify, revoke, list, configured, ROLES };
}

module.exports = { createApiKeys, parseKeys, ROLES };
