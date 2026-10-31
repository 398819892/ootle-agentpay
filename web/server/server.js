/**
 * AgentPay dashboard — backend (zero runtime dependencies).
 *
 * Architecture (security first): the browser NEVER talks to walletd. It talks only to this
 * backend over a small JSON API; the backend drives the chain through the committed
 * `clients/ts` TypeScript client (compiled `dist/`), and walletd signs/pays with the referenced
 * account. The per-tx cap, daily cap, whitelist and kill switch are enforced on chain by the
 * validator — this server cannot override them.
 *
 * It uses only Node's built-in `http`/`fs` (Node 18+ for the global `fetch` the client needs),
 * so there is no `npm install` and nothing to build: `node server/server.js` just runs.
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Local, zero-dependency hardening modules (see docs/custody.md for the custody model).
const { createAuthorizer, createRateLimiter, TIERS } = require("./authorizer");
const { createAudit } = require("./audit");
const { createTxLog, writeJsonAtomic } = require("./txlog");
const { createClaimStore } = require("./claims");
const { createApiKeys } = require("./apikeys");
const { paramFingerprint, conflicts: fpConflicts, stableStringify: idempotencyStableStringify } = require("./idempotency");

// ---- locate and load the committed TS client (its compiled dist) -----------------------------
const CLIENT_DIR = path.resolve(__dirname, "..", "..", "clients", "ts", "dist");
let client;
try {
  client = require(CLIENT_DIR);
} catch (e) {
  console.error(
    `\nCould not load the AgentPay TS client from ${CLIENT_DIR}\n` +
      `Build it once with:  (cd clients/ts && npm install && npm run build)\n` +
      `Original error: ${e.message}\n`,
  );
  process.exit(1);
}
const { WalletdClient, OnChainBudget, newInvoiceId, ChainError, PolicyViolation, windowStatus } = client;

// ---- configuration (env, defaults = local swarm) ---------------------------------------------
const PORT = Number(process.env.PORT || 8787);
// Bind to LOOPBACK by default. A custodial wallet UI must not be reachable from the network unless
// the operator deliberately exposes it (behind TLS / a reverse proxy). To listen on all interfaces,
// set HOST=0.0.0.0 EXPLICITLY — and then put HTTPS in front of it (see docs/security.md). On WSL2,
// Windows' localhost forwarding still reaches a 127.0.0.1-bound server in WSL, so the default needs
// no override for local dev (verified: Windows `localhost:8787` → WSL `127.0.0.1`).
const HOST = process.env.HOST || "127.0.0.1";
const WALLETD_URL = process.env.AGENTPAY_WALLETD_URL || "http://127.0.0.1:12010/json_rpc";
const BUDGET_TEMPLATE =
  process.env.AGENTPAY_BUDGET_TEMPLATE ||
  "template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97";
const OWNER = process.env.AGENTPAY_OWNER_ACCOUNT || "default";

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
// Overridable so a container can point it at a mounted volume for persistence.
const STATE_FILE = process.env.AGENTPAY_STATE_FILE || path.resolve(__dirname, "state.json");

// Confirmation budget: how long a money op waits for its tx to finalize before it is recorded as
// `unknown` (submitted, not yet confirmed) and handed to the reconciler. Kept modest so the UI
// stays responsive; a tx that misses the window is NEVER counted as success — it is settled later
// by its tx id. Tune via env (set TRIES very low to exercise the unknown path on purpose).
const FINALIZE_TRIES = Number(process.env.AGENTPAY_FINALIZE_TRIES || 40);
const FINALIZE_DELAY_MS = Number(process.env.AGENTPAY_FINALIZE_DELAY_MS || 1500);

// ---- authentication -------------------------------------------------------------------------
// The backend is a *hosted* wallet (it signs through walletd), so a public deployment with no
// login would let anyone operate the wallet. Auth is therefore mandatory in production and is
// enabled whenever DASHBOARD_PASSWORD is set. When it is unset (local dev against the swarm) the
// gate is disabled so the local experience is unchanged — NEVER deploy without the password.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const AUTH_ON = DASHBOARD_PASSWORD.length > 0;
// Auto-creating + faucet-funding a brand-new merchant account the first time a name is referenced
// is handy for a local demo, but on a public deployment it is an abuse / cost vector — anyone could
// mint and fund accounts at will. So it is allowed only in open local-dev mode (no password set),
// and can be forced either way with AGENTPAY_AUTO_CREATE_MERCHANTS=true|false. When disabled, an
// unknown merchant yields a clear error instead of silently creating an account.
const AUTO_CREATE_MERCHANTS =
  process.env.AGENTPAY_AUTO_CREATE_MERCHANTS === "true"
    ? true
    : process.env.AGENTPAY_AUTO_CREATE_MERCHANTS === "false"
      ? false
      : !AUTH_ON;
// Secret for signing the session cookie. Provide SESSION_SECRET in production so sessions survive
// restarts and are stable across replicas; otherwise we mint an ephemeral one per process.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 12) * 3600 * 1000;
const COOKIE_NAME = "ap_session";
// Set COOKIE_SECURE=true behind HTTPS to force the Secure flag; otherwise it is inferred from the
// X-Forwarded-Proto a TLS-terminating proxy sets (so cookies still work on plain-http localhost).
const COOKIE_SECURE_ENV = process.env.COOKIE_SECURE; // "true" | "false" | undefined

// ---- web-security boundary (CSRF / origin / trusted proxy) -----------------------------------
// Trusted-proxy policy for deriving the real client IP used by the login/operation throttles. The
// X-Forwarded-For header is client-controlled, so we do NOT trust it by default — an attacker could
// otherwise rotate a fake XFF to dodge the per-IP lockout. Values:
//   unset/"false" → never trust XFF; use the direct socket peer (correct for a directly-exposed box)
//   "true"        → trust the proxy in front of us; take the left-most XFF entry (the original client)
//   "ip,ip,…"     → trust XFF ONLY when the direct peer is one of these proxy IPs; then take the
//                   right-most entry that is not itself a listed proxy (defeats appended spoofing)
const TRUSTED_PROXY = String(process.env.TRUSTED_PROXY || "").trim();
// Extra allowed origins for the CSRF origin check (comma-separated full origins, e.g.
// "https://pay.example.com"). The request's own Host is always allowed; set this only when the
// browser-facing origin differs from the Host header the app sees (some proxy setups).
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ---- hardening config (custody boundary) ----------------------------------------------------
// High-risk owner actions (withdraw, revoke, change whitelist, mint/revoke an agent badge, reset,
// freeze/unfreeze) require a SECOND confirmation that is independent of the login session: the
// operator re-presents a secret and gets a short-lived, single-use token bound to that one action.
// This is enabled whenever auth is on. Locally (no password) there is no secret to step up with, so
// the extra gate is off and the dev experience is unchanged. A distinct AGENTPAY_ADMIN_PASSWORD can
// be set so that holding a read/operate session is not the same as being able to move funds.
const ADMIN_PASSWORD = process.env.AGENTPAY_ADMIN_PASSWORD || DASHBOARD_PASSWORD;
const STEP_UP_ON = AUTH_ON;
const CONFIRM_TTL_MS = (Number(process.env.CONFIRM_TTL_SECONDS) || 120) * 1000;

// Append-only audit log of every state-changing call. Overridable so a container can mount a
// volume (or a later deployment can tee it to an off-box append-only sink).
const audit = createAudit();

// Rate limit + anomaly flags for fund-moving / admin ops (separate from the login throttle).
const rate = createRateLimiter({
  windowMs: Number(process.env.AGENTPAY_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.AGENTPAY_RATE_MAX) || 40,
  moneyWindowMs: Number(process.env.AGENTPAY_MONEY_WINDOW_MS) || 60_000,
  moneyMax: Number(process.env.AGENTPAY_MONEY_MAX) || 12,
  // 0 = disabled; set to a base-unit threshold to flag unusually large single amounts.
  anomalyAmount: process.env.AGENTPAY_ANOMALY_AMOUNT || "0",
  burstN: Number(process.env.AGENTPAY_BURST_N) || 5,
  burstMs: Number(process.env.AGENTPAY_BURST_MS) || 10_000,
});

function cookieIsSecure(req) {
  if (COOKIE_SECURE_ENV === "true") return true;
  if (COOKIE_SECURE_ENV === "false") return false;
  return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
// Server-side revocation of session ids. Sessions are stateless signed tokens, so a logout cannot
// "unsign" a cookie; instead we remember the revoked sid until its own expiry and reject it here.
// This genuinely invalidates a logged-out token ON THIS INSTANCE. NOTE: like the rate limiter this
// is in-memory and per-process — it does not span replicas or survive a restart (see docs/security.md
// "Operational assumptions"). Keep SESSION_TTL modest and front multi-instance deploys with a shared
// session store if you need cross-replica revocation.
const revokedSids = new Map(); // sid -> exp (ms)
function pruneRevokedSids() {
  const now = Date.now();
  for (const [sid, exp] of revokedSids) if (exp <= now) revokedSids.delete(sid);
}
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (p && typeof p.exp === "number" && Date.now() < p.exp) {
      if (p.sid && revokedSids.has(p.sid)) return null; // explicitly logged out on this instance
      return p;
    }
  } catch {
    /* tampered */
  }
  return null;
}
function isAuthed(req) {
  if (!AUTH_ON) return true;
  return verifySession(parseCookies(req)[COOKIE_NAME]) !== null;
}
function passwordMatches(input) {
  // Hash both sides so timingSafeEqual never sees a length mismatch (which would itself leak length).
  const a = crypto.createHash("sha256").update(String(input ?? "")).digest();
  const b = crypto.createHash("sha256").update(DASHBOARD_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
function setSessionCookie(req, res, token, maxAgeMs) {
  const parts = [`${COOKIE_NAME}=${token}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (cookieIsSecure(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
function clearSessionCookie(req, res) {
  const parts = [`${COOKIE_NAME}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (cookieIsSecure(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

// ---- CSRF (synchronizer token bound to the session) ------------------------------------------
// A cookie-authenticated API is exposed to CSRF: a malicious page can make the browser POST with the
// session cookie attached. We defend with TWO independent checks on every state-changing request
// (enforced only when AUTH_ON — in open local-dev there is no ambient credential to abuse):
//   1. Origin/Referer must match (below) — a cross-site POST is refused outright.
//   2. a CSRF token derived from the session's sid must be presented in the X-CSRF-Token header.
// The token is NOT a secret cookie (so it is immune to a sibling-subdomain cookie-injection), it is an
// HMAC over the sid that only a holder of a valid session (who can also read it from /api/session or
// the login response) can produce. A stolen *token* without the cookie is useless, and a stolen
// *cookie* without the token (the CSRF case) is refused.
function csrfTokenFor(sid) {
  return crypto.createHmac("sha256", SESSION_SECRET).update("csrf:" + String(sid)).digest("base64url");
}
function csrfTokenOk(req, sid) {
  if (!sid) return false;
  const sent = String(req.headers["x-csrf-token"] || "");
  const expected = csrfTokenFor(sid);
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Origin / Referer check ------------------------------------------------------------------
// Browsers always send `Origin` on cross-origin POSTs (and modern ones on same-origin POSTs too), so a
// cross-site forgery is caught here even before the CSRF token. A request with neither header is a
// non-browser client (curl, server-to-server) which is not subject to ambient-cookie CSRF — it is
// allowed through to the token/auth checks, which still apply.
function hostMatches(urlStr, host) {
  try {
    const u = new URL(urlStr);
    if (ALLOWED_ORIGINS.includes((u.protocol + "//" + u.host).toLowerCase())) return true;
    return u.host.toLowerCase() === host; // host includes the port
  } catch {
    return false;
  }
}
function originAllowed(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!host) return false;
  const origin = req.headers.origin;
  if (origin) return origin !== "null" && hostMatches(origin, host);
  const ref = req.headers.referer || req.headers.referrer;
  if (ref) return hostMatches(ref, host);
  return true; // no Origin/Referer: not a browser cross-site POST
}

// ---- security response headers ---------------------------------------------------------------
// Applied to EVERY response (static assets and API). The CSP is strict on scripts — `script-src
// 'self'`, no inline/eval — which this zero-dependency SPA satisfies (no inline <script>, no inline
// handlers, no eval; app.js and styles.css are same-origin files). Inline *style attributes* are used
// throughout the hand-written markup, so `style-src` permits 'unsafe-inline'; this does NOT enable
// script injection. Google Fonts are the only third-party origin (style + font). `frame-ancestors
// 'none'` + X-Frame-Options block clickjacking; `object-src`/`base-uri 'none'` close common injection
// vectors; `connect-src 'self'` keeps the SPA talking only to its own backend.
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
].join("; ");
function applySecurityHeaders(req, res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  // HSTS only when the connection is (or terminates as) HTTPS, so we never pin plain-http localhost.
  if (cookieIsSecure(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
}

// Simple per-IP throttle on failed logins.
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 8;
const LOGIN_LOCK_MS = (Number(process.env.LOGIN_LOCK_MINUTES) || 10) * 60 * 1000;
const loginFails = new Map(); // ip -> { fails, lockUntil }
function normalizeIp(ip) {
  // Strip the IPv4-mapped-IPv6 prefix so "::ffff:1.2.3.4" and "1.2.3.4" compare equal.
  return String(ip || "").replace(/^::ffff:/i, "").trim();
}
const TRUSTED_PROXY_IPS =
  TRUSTED_PROXY && TRUSTED_PROXY.toLowerCase() !== "true" && TRUSTED_PROXY.toLowerCase() !== "false"
    ? new Set(TRUSTED_PROXY.split(",").map((s) => normalizeIp(s)).filter(Boolean))
    : null;
/**
 * The client IP used for rate-limiting / lockout. Trusts X-Forwarded-For ONLY per TRUSTED_PROXY, so
 * a forged XFF cannot be used to evade the per-IP throttle on a directly-exposed deployment.
 */
function clientIp(req) {
  const peer = normalizeIp(req.socket && req.socket.remoteAddress);
  const mode = TRUSTED_PROXY.toLowerCase();
  if (!TRUSTED_PROXY || mode === "false") return peer || "?"; // default: ignore XFF entirely
  const xff = req.headers["x-forwarded-for"];
  if (!xff) return peer || "?";
  const chain = String(xff).split(",").map((s) => normalizeIp(s)).filter(Boolean);
  if (mode === "true") return chain[0] || peer || "?"; // single trusted hop → left-most is the client
  // IP-list mode: only honour XFF when the direct peer is a configured proxy, then walk right-to-left
  // past any further trusted proxies to the first address we did not place there ourselves.
  if (TRUSTED_PROXY_IPS && TRUSTED_PROXY_IPS.has(peer)) {
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!TRUSTED_PROXY_IPS.has(chain[i])) return chain[i];
    }
  }
  return peer || "?";
}
function loginLocked(ip) {
  const e = loginFails.get(ip);
  return Boolean(e && e.lockUntil > Date.now());
}
function noteLoginFail(ip) {
  const e = loginFails.get(ip) || { fails: 0, lockUntil: 0 };
  e.fails += 1;
  if (e.fails >= LOGIN_MAX_FAILS) {
    e.lockUntil = Date.now() + LOGIN_LOCK_MS;
    e.fails = 0;
  }
  loginFails.set(ip, e);
}
function noteLoginOk(ip) {
  loginFails.delete(ip);
}

// ---- step-up confirmation for high-risk actions ---------------------------------------------
// A confirm token is an HMAC over {op, exp, nonce}, minted only when the caller re-presents the
// admin secret (see POST /api/confirm). It is bound to a single operation, expires quickly, and is
// single-use. This gives a second factor that does not ride on the session cookie: stealing a live
// session is not enough to move funds — you must also know the admin secret, right now.
const usedConfirmNonces = new Map(); // nonce -> exp
function pruneConfirmNonces() {
  const now = Date.now();
  for (const [n, exp] of usedConfirmNonces) if (exp <= now) usedConfirmNonces.delete(n);
}
function adminPasswordMatches(input) {
  const a = crypto.createHash("sha256").update(String(input ?? "")).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
// The FUNDING PARAMETERS a confirm token is bound to. A step-up token must authorise one SPECIFIC
// action, not just "some withdraw": the amount, the payee/session, the caps and the budget it targets.
// We extract exactly those from the request body into a canonical shape and fold them into the token;
// at execute time we recompute the shape from the ACTUAL op arguments and require an exact match. So a
// token minted to confirm "withdraw 100" cannot be replayed to withdraw 900, or redirected to another
// payee, or reused after the budget was reset (a new budget has a different component id). The budget
// component acts as the budget/authorisation "version": reset→new budget ⇒ old tokens are void.
function confirmParams(op, body) {
  const b = body || {};
  const s = (v) => (v == null ? null : String(v));
  const f = { op, component: (store.budget && store.budget.component) || null };
  switch (op) {
    case "createBudget": // no component yet (null on both mint+verify); bind the funding + caps
      f.fund = s(b.fund);
      f.perTxCap = s(b.perTxCap);
      f.dailyCap = s(b.dailyCap);
      f.epochsPerWindow = s(b.epochsPerWindow);
      f.whitelist = Array.isArray(b.whitelist) ? b.whitelist.map(String).sort() : [];
      break;
    case "withdraw":
      f.amount = s(b.amount);
      break;
    case "addMerchant":
      f.merchant = s(b.merchant);
      break;
    case "issueSession":
    case "revokeSession":
      f.session = s(b.session);
      break;
    // revoke / freeze / unfreeze / resetLocal carry no funding params: op + component is the binding.
    default:
      break;
  }
  return f;
}
/** HMAC digest of the funding parameters a token is bound to (stable key order via idempotency.js). */
function confirmDigest(op, body) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update("confirm-params." + idempotencyStableStringify(confirmParams(op, body)))
    .digest("base64url");
}
function issueConfirmToken(op, body) {
  const payload = {
    op,
    pd: confirmDigest(op, body), // bind the token to THIS action's funding parameters
    exp: Date.now() + CONFIRM_TTL_MS,
    n: crypto.randomBytes(12).toString("hex"),
  };
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", SESSION_SECRET).update("confirm." + b).digest("base64url");
  return `${b}.${mac}`;
}
function verifyConfirmToken(token, op, args) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [body, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update("confirm." + body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let p;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!p || p.op !== op || typeof p.exp !== "number" || Date.now() >= p.exp) return false;
  // Re-derive the funding-parameter digest from the ACTUAL op arguments and require it to match the
  // one bound into the token. A token minted for different parameters (amount, payee, caps, budget)
  // is rejected — this is what stops a confirmation being replayed against a different action.
  if (p.pd !== confirmDigest(op, args || {})) return false;
  pruneConfirmNonces();
  if (usedConfirmNonces.has(p.n)) return false; // already spent (single-use)
  usedConfirmNonces.set(p.n, p.exp);
  return true;
}
const stepUp = { required: () => STEP_UP_ON, verify: verifyConfirmToken };

/** Request identity for the authorizer/audit trail. Never carries a password. */
function requestCtx(req, body) {
  const session = AUTH_ON ? verifySession(parseCookies(req)[COOKIE_NAME]) : null;
  const ip = clientIp(req);
  const sid = session && session.sid ? session.sid : null;
  return {
    actor: AUTH_ON ? (sid ? `op:${sid.slice(0, 8)}` : "op") : "local",
    sid,
    ip,
    // throttle per session when logged in, else per IP
    rateKey: AUTH_ON ? sid || ip : ip,
    confirmToken: body && body.confirmToken,
  };
}

// ---- persisted runtime state ----------------------------------------------------------------
// IMPORTANT: this `store` is a REFERENCE + CONFIG cache, NOT the authority for money. It records
// which budget component is open, its badge resources, the friendly merchant name↔address book,
// the agent-session labels and the kill switch. The authoritative financial state — vault balance
// (treasury), spend-in-window, the on-chain whitelist and the revoked flag — is read LIVE from the
// chain in `dashboardState()` (see `readChainBudget`). The cached caps/whitelist/revoked here are
// only a fallback for when a chain read momentarily fails, and are labelled as such to the client.
/** @type {{ budget: any|null, merchants: Record<string,string>, frozen: boolean }} */
let store = { budget: null, merchants: {}, frozen: false };

// The operation journal: one record per fund-moving op, with a pending→confirmed|rejected|unknown
// lifecycle, idempotency and atomic persistence. This — not `store` — is what we reconcile against
// the chain. See txlog.js.
const txlog = createTxLog();

// Cross-process idempotency claims (see claims.js). Markers live in a shared directory next to the
// journal file so that two backend instances sharing one filesystem coordinate on who may submit a
// given idempotency key — closing the multi-instance double-spend the B-6 harness reproduced. The
// dir is overridable for containers that mount the journal on a volume.
const CLAIMS_DIR = process.env.AGENTPAY_CLAIMS_DIR || path.join(path.dirname(txlog.file), "claims");
const claims = createClaimStore(CLAIMS_DIR);
// How long a loser in a cross-process race waits for the winner's outcome to land in the shared
// journal before giving up and reporting `unknown` (never a resubmit). Scaled off the finalize
// budget so it comfortably covers a slow winner, with a floor and an env override.
const CLAIM_WAIT_MS = Number(process.env.AGENTPAY_CLAIM_WAIT_MS || Math.max(5000, FINALIZE_TRIES * FINALIZE_DELAY_MS + 2000));

function loadStore() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    /* first run */
  }
  if (!raw || typeof raw !== "object") return;
  store.merchants = raw.merchants && typeof raw.merchants === "object" ? raw.merchants : {};
  store.frozen = Boolean(raw.frozen);
  // API-key revocations persist across restarts (the key list itself stays in env).
  store.apiKeys = raw.apiKeys && typeof raw.apiKeys === "object" ? raw.apiKeys : {};
  if (raw.budget) {
    const b = raw.budget;
    store.budget = {
      component: b.component,
      ownerBadge: b.ownerBadge,
      agentBadge: b.agentBadge,
      template: b.template || BUDGET_TEMPLATE,
      // cached config (fallback only; chain is authority):
      perTxCap: String(b.perTxCap ?? "0"),
      dailyCap: String(b.dailyCap ?? "0"),
      whitelist: Array.isArray(b.whitelist) ? b.whitelist : [],
      revoked: Boolean(b.revoked),
      epochsPerWindow: Number(b.epochsPerWindow) || undefined,
      sessions: Array.isArray(b.sessions) ? b.sessions : ["default"],
      revokedSessions: Array.isArray(b.revokedSessions) ? b.revokedSessions : [],
    };
    // One-time migration: if we have a legacy budget but an empty journal, import the old local
    // funded/withdrawn/ledger as a single clearly-marked genesis row so the history display stays
    // continuous. This is NOT re-trusting local accumulation for balances — treasury/spend are now
    // read from chain; the genesis row only seeds the historical funded/withdrawn/ledger view.
    if (!txlog.get("genesis") && txlog.list().length === 0) {
      const legacyLedger = Array.isArray(b.ledger)
        ? b.ledger.map((e) => ({ ...e, amount: String(e.amount) }))
        : [];
      txlog.importGenesis({
        component: store.budget.component,
        funded: String(raw.funded ?? "0"),
        withdrawn: String(raw.withdrawn ?? "0"),
        ledger: legacyLedger,
      });
    }
  }
}
// Atomic + non-silent: a failed persist THROWS so the request that triggered it cannot report
// success (the old code only warned and returned 200 — a correctness bug this closes).
function saveStore() {
  writeJsonAtomic(STATE_FILE, store);
}
loadStore();

// ---- machine-to-machine API keys (independent of the browser session) ------------------------
// The /api/v1 integration surface authenticates third-party / agent callers with a bearer API key
// instead of a login cookie. Keys come from env (AGENTPAY_API_KEYS="role:id:secret, …"); the surface
// is DISABLED unless at least one key is configured. See apikeys.js and docs/api.md.
const apiKeys = createApiKeys({ raw: process.env.AGENTPAY_API_KEYS || "", store, save: saveStore, audit });

// name <-> address bookkeeping for friendly labels
const nameByAddr = () => {
  const m = {};
  for (const [name, addr] of Object.entries(store.merchants)) m[addr] = name;
  return m;
};

// ---- a tiny serial mutex: on-chain ops must not interleave ------------------------------------
let chainBusy = Promise.resolve();
function serialize(fn) {
  const run = chainBusy.then(fn, fn);
  // keep the chain going even if one op throws
  chainBusy = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- lazy walletd connection + owner address --------------------------------------------------
let wd = null;
let ownerAddr = null;
async function walletd() {
  if (!wd) {
    wd = await new WalletdClient(WALLETD_URL, {
      finalizeTries: FINALIZE_TRIES,
      finalizeDelayMs: FINALIZE_DELAY_MS,
    }).connect();
  }
  if (!ownerAddr) ownerAddr = await wd.accountAddress(OWNER);
  return wd;
}

/**
 * Resolve a merchant to a component address. A `component_…` address is used verbatim; a friendly
 * name is looked up on chain. If the account does not exist it is created + faucet-funded ONLY when
 * AUTO_CREATE_MERCHANTS is enabled (open local-dev mode); otherwise a clear error is returned so a
 * public deployment is never a free account-minting / faucet-draining endpoint.
 */
// A component address is exactly `component_` + 64 lowercase hex. The resolved value is spliced
// into a transaction manifest as `address!("…")`, so it must match this exactly — a loose
// `startsWith("component_")` would let `component_x") ; owner.withdraw(…` break out of the literal
// and inject manifest instructions (issue #7). Account-name lookups below return a chain-minted
// address, which we re-validate to the same shape before it can reach a manifest (defence in depth).
const COMPONENT_ADDR_RE = /^component_[0-9a-f]{64}$/;

async function resolveMerchant(nameOrAddr) {
  const raw = String(nameOrAddr || "").trim();
  if (!raw) throw httpError(400, "A merchant name or component address is required.");
  if (raw.startsWith("component_")) {
    // Validate the address shape BEFORE any daemon call: this value is spliced into a manifest.
    if (!COMPONENT_ADDR_RE.test(raw)) {
      throw httpError(400, "That is not a valid component_… address (expected component_ + 64 hex chars).");
    }
    return raw; // already a (now validated) address
  }
  const key = raw.toLowerCase();
  if (store.merchants[key]) {
    const cached = store.merchants[key];
    // A snapshot written before this check could hold a malformed address; re-validate on read.
    if (!COMPONENT_ADDR_RE.test(String(cached))) {
      throw httpError(502, "A cached merchant address has an unexpected shape; re-resolve the merchant.");
    }
    return cached;
  }
  const c = await walletd();
  let addr;
  try {
    addr = await c.accountAddress(key);
  } catch (e) {
    if (!(e instanceof ChainError)) throw e;
    if (!AUTO_CREATE_MERCHANTS) {
      throw httpError(
        400,
        `No account named "${key}" was found on chain. Paste the merchant's component_… address, ` +
          `or provision and fund the account out of band. (Auto-creating merchant accounts is ` +
          `disabled on this deployment.)`,
      );
    }
    addr = await c.createAccount(key);
    await c.fund(key);
  }
  if (!COMPONENT_ADDR_RE.test(String(addr))) {
    throw httpError(502, "The wallet returned an unexpected merchant address shape.");
  }
  store.merchants[key] = addr;
  saveStore();
  return addr;
}

/** Rebuild a live OnChainBudget from the persisted snapshot (or null if none open). */
async function liveBudget() {
  if (!store.budget) return null;
  const c = await walletd();
  // walletd parses manifest variables as values, so an account is referenced by its component
  // address (not its name). ownerAddr is resolved by walletd().
  const b = new OnChainBudget(c, BUDGET_TEMPLATE, ownerAddr);
  Object.assign(b, store.budget);
  return b;
}

// ---- chain-authoritative reads ---------------------------------------------------------------
// The displayed balances/policy MUST come from the chain, not from local accumulation. The
// AgentBudget component substate is a positional array; the vault (treasury) is a child substate.
// We parse both here so treasury / spend-in-window / caps / whitelist / revoked are all derived
// live from chain. Best-effort: callers fall back to the cached config + journal if a read fails.

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
  const [sub, currentEpoch] = await Promise.all([c.getSubstate(component), c.currentEpoch()]);
  const state = findComponentState(sub);
  if (!state) throw new Error("could not read the budget component state");
  // Layout (struct order, see docs/custody.md §state-model): [vault, ownerBadgeRes, agentBadgeRes,
  //   perTxCap, dailyCap, spentInWindow, windowStartEpoch, epochsPerWindow, [whitelist…], revoked, …]
  const nums = state.filter((x) => typeof x === "number");
  if (nums.length < 5) throw new Error("unexpected budget component layout");
  const [perTxCap, dailyCap, spentInWindow, windowStartEpoch, epochsPerWindow] = nums;
  const revoked = state.find((x) => typeof x === "boolean");
  const wlArr = state.find((x) => Array.isArray(x)) || [];
  const whitelist = wlArr.map((e) => (cborHex(e) ? "component_" + cborHex(e) : null)).filter(Boolean);
  const vaultHex = cborHex(state[0]);
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
    // Note: caps/spend come back as JS numbers from the CBOR substate (a known residual: values
    // above 2^53 would lose precision on this read path — see docs). Treasury is a string and exact.
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
          txKind: e.txKind || "pay",
          status: "confirmed",
          txId: null,
          migrated: true,
        });
      }
    }
    if (r.op === "pay" && r.status === "confirmed" && r.event) {
      out.push({
        merchant: r.event.merchant,
        merchantName: label(r.event.merchant),
        amount: String(r.event.amount),
        memo: r.event.memo,
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

// ---- idempotent chain-op runner (tx lifecycle) ------------------------------------------------
/** The idempotency key for an op: an explicit client key, else a sensible per-op default. */
function idemKey(body, fallback) {
  const k = body && (body.idempotencyKey || body.idemKey);
  return k ? String(k).slice(0, 128) : fallback;
}

/**
 * Settle a single open (pending/unknown) journal record against the chain by its tx id. Promotes it
 * to confirmed/rejected, or leaves it open if the chain still has no verdict / no tx id to check.
 */
async function reconcileRecord(rec) {
  if (!rec || !txlog.isOpen(rec.status) || !rec.txId) return rec;
  const c = await walletd();
  const got = await c.getResult(rec.txId);
  if (got.status === "accept") {
    const event = rec.op === "pay" ? firstPayEvent(got.result) || rec.event : rec.event;
    return txlog.settle(rec.key, { status: "confirmed", event });
  }
  if (got.status === "reject") {
    return txlog.settle(rec.key, { status: "rejected", reason: got.reason });
  }
  return rec; // still pending on chain
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLAIM_POLL_MS = 25;

/** The idempotency key was reused with DIFFERENT parameters — a 409 the caller must surface, never a
 *  silent replay of the prior receipt. */
function idempotencyConflict(key) {
  return httpError(
    409,
    "This idempotency key was already used with different parameters. Use a new key for a different operation.",
    { idempotencyConflict: true, key },
  );
}

/** Replay the outcome of a journal record that already exists, settling it against chain first if
 *  it is still open. Never resubmits — an unresolved open record is reported as `unknown`. */
async function replayPrior(prior) {
  if (prior.status === "confirmed") return { outcome: "confirmed", record: prior, replay: true };
  if (prior.status === "rejected") throw httpError(422, prior.reason || "Previously rejected.");
  // pending / unknown — try to settle it before considering a resubmit.
  const settled = await reconcileRecord(prior);
  if (settled.status === "confirmed") return { outcome: "confirmed", record: settled, replay: true };
  if (settled.status === "rejected") throw httpError(422, settled.reason || "Previously rejected.");
  // Still unresolved on chain: do NOT resubmit (that would double-spend). Report it as unknown.
  return { outcome: "unknown", record: settled, replay: true };
}

/**
 * A different instance holds the claim for this key, so we must NOT submit. Observe the SHARED
 * journal until the winner's outcome is terminal, then replay it. If it carries a tx id while still
 * open we may settle it against chain ourselves (read-only, idempotent). If it never resolves within
 * the wait budget (winner slow, or crashed mid-flight), report `unknown` — the existing startup
 * reconcile settles it later by its tx id, and we NEVER resubmit (that is the double-spend we block).
 */
async function replayForeignClaim(key, claim, fp) {
  const deadline = Date.now() + CLAIM_WAIT_MS;
  for (;;) {
    txlog.reload(); // merge whatever the winner has persisted into our view
    const rec = txlog.get(key);
    if (rec) {
      // The winner's journal record is authoritative for the fingerprint too: a mismatch here is the
      // same reused-key-different-params conflict, caught once the winner has persisted its record.
      if (fp != null && fpConflicts(rec.fp, fp)) throw idempotencyConflict(key);
      if (txlog.isTerminal(rec.status)) return await replayPrior(rec);
      if (rec.txId) {
        const settled = await reconcileRecord(rec); // read-only get_result; promotes if chain has a verdict
        if (txlog.isTerminal(settled.status)) return await replayPrior(settled);
      }
    }
    if (Date.now() >= deadline) {
      const record = rec || {
        key,
        op: null,
        component: null,
        status: "unknown",
        txId: null,
        reason: "claimed by another instance; outcome not yet observed within the wait budget",
      };
      return { outcome: "unknown", record, replay: true };
    }
    await sleep(CLAIM_POLL_MS);
  }
}

/**
 * Run a fund-moving op exactly once per idempotency key, journaling its full lifecycle:
 *   pending (persisted before submit) → confirmed | rejected | unknown.
 * `submitFn` performs the chain call (an OnChainBudget method) and returns the finalized result;
 * it sets `wd.lastTxId` as a side effect. Returns { outcome, record, res, replay }.
 *
 * Idempotency is enforced at two layers: an in-process journal (fast, single-instance) AND a
 * cross-process filesystem claim (claims.js) so that multiple instances sharing one filesystem never
 * submit the same key twice. See docs/stability.md for the cross-HOST limit that remains.
 */
async function runChainOp(key, opName, component, params, submitFn, fpParams) {
  // Bind this key to a fingerprint of its FUNDING-RELEVANT parameters: a repeat of the key with
  // different parameters (amount, payee, memo…) must NOT silently replay the prior receipt (see
  // idempotency.js). The fingerprint is computed from `fpParams` when the op supplies it, else from
  // `params`. The distinction matters because `params` also carries non-funding identifiers — notably
  // a server-GENERATED invoiceId, which is random per call and so must be excluded, or two legitimate
  // retries under one key would fingerprint differently and spuriously conflict. Recorded on both the
  // journal record and the cross-process claim marker so either layer can detect a real mismatch.
  const fp = paramFingerprint(opName, component, fpParams !== undefined ? fpParams : params);

  // Fast path — a record already visible IN THIS PROCESS (a same-process replay, or one recovered
  // from the journal at startup). This is the single-instance idempotency guarantee, unchanged.
  const prior = txlog.get(key);
  if (prior) {
    if (fpConflicts(prior.fp, fp)) throw idempotencyConflict(key);
    return await replayPrior(prior);
  }

  // No local record yet. Before submitting anything, take the CROSS-PROCESS claim on this key. On a
  // shared filesystem `fs.open(…,"wx")` lets exactly one instance win; every other instance that
  // races the same key loses and must NOT submit — otherwise the chain (which has no invoice dedup)
  // executes the payment twice. This is the multi-instance double-spend the B-6 harness reproduced.
  let claim;
  try {
    claim = claims.tryClaim(key, { op: opName, fp });
  } catch (e) {
    // We could not take the claim for a reason other than "already claimed" (e.g. the shared dir is
    // unwritable). Fail safe: do not submit on an unproven claim.
    throw httpError(503, "Could not take the idempotency claim (shared store unavailable): " + e.message);
  }
  if (!claim.won) {
    // A peer already holds this key. If its marker records a DIFFERENT fingerprint, this is a reused
    // key with different parameters — reject rather than wait to replay a receipt for another request.
    if (claim.record && fpConflicts(claim.record.fp, fp)) throw idempotencyConflict(key);
    return await replayForeignClaim(key, claim, fp);
  }

  txlog.begin({ key, op: opName, params, component, fp }); // persist pending BEFORE the chain submit (throws on fail)
  // Snapshot the client's last tx id BEFORE we submit. `wd.lastTxId` is sticky — it holds the id of
  // the most recent *successful* submit on this shared client. An op that fails WITHOUT submitting
  // (a client-side precheck rejection, or a fault before submit_manifest returns) must NOT inherit
  // that previous op's tx id, or its journal record / receipt would point at an unrelated tx. So we
  // only attribute a tx id to this op when lastTxId actually advanced, or the error carries one
  // explicitly (the timeout/pending case, where run() stamps e.txId on the tx it did submit).
  const txIdBefore = wd && wd.lastTxId;
  const submittedTxId = () => (wd && wd.lastTxId && wd.lastTxId !== txIdBefore ? wd.lastTxId : null);
  // #8: persist the tx id to the journal the moment it is known — i.e. as soon as the client's
  // lastTxId advances (right after submit, BEFORE the up-to-minutes confirmation wait) — not only
  // after submitFn resolves. Otherwise a crash during the wait leaves the record "pending" with no
  // txId, which the reconciler cannot settle against the chain (and replay won't resubmit). Chain ops
  // are serialized, so a lastTxId that advances during this submitFn is unambiguously this op's.
  let midflightTxId = null;
  const txIdWatcher = setInterval(() => {
    const t = submittedTxId();
    if (t && !midflightTxId) {
      midflightTxId = t;
      try { txlog.settle(key, { txId: t }); } catch { /* best-effort; final settle still records it */ }
      clearInterval(txIdWatcher);
    }
  }, 200);
  let res;
  try {
    res = await submitFn();
  } catch (e) {
    clearInterval(txIdWatcher);
    const txId = (e && e.txId) || submittedTxId();
    if (e && e.pending) {
      // Submitted, but not confirmed within the window → UNKNOWN (never success). Reconciled later.
      const record = txlog.settle(key, { status: "unknown", txId, reason: "submitted; not confirmed within the window" });
      return { outcome: "unknown", record };
    }
    // Finalized reject (or a submit fault): record and surface the chain's reason.
    txlog.settle(key, { status: "rejected", txId, reason: chainMessage(e) });
    throw e;
  }
  clearInterval(txIdWatcher);
  const txId = submittedTxId();
  const event = opName === "pay" ? firstPayEvent(res) : null;
  const record = txlog.settle(key, { status: "confirmed", txId, event });
  return { outcome: "confirmed", record, res };
}

/** On startup, settle every open record we can by its tx id (ledger is then rebuilt from chain). */
async function reconcileAll() {
  const open = txlog.pendingOrUnknown();
  if (!open.length) return { checked: 0, resolved: 0 };
  try {
    await walletd();
  } catch (e) {
    console.error("reconcile: walletd unreachable, deferring:", e.message);
    return { checked: 0, resolved: 0 };
  }
  let resolved = 0;
  for (const rec of open) {
    try {
      const before = rec.status;
      const after = await reconcileRecord(rec);
      if (after.status !== before && txlog.isTerminal(after.status)) resolved += 1;
    } catch (e) {
      console.error(`reconcile: ${rec.key} failed:`, e.message);
    }
  }
  return { checked: open.length, resolved };
}

/** Persist the config/reference fields (NOT balances) of a confirmed budget back to the store. */
function snapshotBudget(b) {
  store.budget = {
    component: b.component,
    ownerBadge: b.ownerBadge,
    agentBadge: b.agentBadge,
    template: BUDGET_TEMPLATE,
    // cached config only — the authoritative values are read from chain in dashboardState():
    perTxCap: String(b.perTxCap),
    dailyCap: String(b.dailyCap),
    whitelist: b.whitelist,
    revoked: b.revoked,
    epochsPerWindow: b.epochsPerWindow,
    sessions: b.sessions,
    revokedSessions: b.revokedSessions,
  };
  saveStore();
}

/**
 * The shape the frontend renders. CHAIN IS THE AUTHORITY: treasury (vault balance), spend-in-window,
 * caps, whitelist and the revoked flag are read live from chain every call. Only the history
 * (funded/withdrawn totals and the payment ledger) comes from the local journal, and only because
 * the chain does not expose a lifetime-total — it is clearly labelled in `budget.source`. If a chain
 * read fails we fall back to the cached config + journal estimate and say so, rather than break.
 */
async function dashboardState() {
  const names = nameByAddr();
  const label = (addr) => names[addr] || null;
  const base = {
    config: { walletdUrl: WALLETD_URL, template: BUDGET_TEMPLATE, ownerAccount: OWNER },
    connected: Boolean(wd),
    owner: ownerAddr,
    merchants: Object.entries(store.merchants).map(([name, address]) => ({ name, address })),
    // global emergency stop (dashboard-wide, independent of a single budget's on-chain revoke)
    frozen: Boolean(store.frozen),
    // whether high-risk actions require a step-up confirmation (true iff auth is enabled)
    stepUpRequired: STEP_UP_ON,
    // tx journal health: counts by status + anything needing operator attention (unknown txs).
    tx: txlog.summary(),
    budget: null,
  };
  if (!store.budget) return base;
  const cfg = store.budget;

  // Pull the authoritative state from chain; fall back to cached config on any read failure.
  let chain = null;
  try {
    chain = await readChainBudget(cfg.component);
  } catch (e) {
    console.error("warn: chain read failed, showing cached config:", e.message);
  }
  const chainOk = Boolean(chain);

  const totals = journalTotals(cfg.component); // historical funded/withdrawn (scoped; not a chain fact)
  const perTxCap = chainOk ? chain.perTxCap : String(cfg.perTxCap);
  const dailyCap = chainOk ? chain.dailyCap : String(cfg.dailyCap);
  const spent = chainOk ? chain.spentInWindow : "0";
  const whitelist = chainOk ? chain.whitelist : cfg.whitelist || [];
  const revoked = chainOk ? chain.revoked : Boolean(cfg.revoked);
  // Treasury = the vault's on-chain balance (exact). Only if the chain read fails do we fall back to
  // the journal estimate (funded − spent − withdrawn), and flag it as a cache value.
  const treasuryFromChain = chainOk && chain.vaultBalance != null;
  const treasury = treasuryFromChain
    ? chain.vaultBalance
    : clampStr(big(totals.funded) - big(spent) - big(totals.withdrawn));

  base.budget = {
    component: cfg.component,
    perTxCap,
    dailyCap,
    revoked,
    spent,
    funded: totals.funded,
    withdrawn: totals.withdrawn,
    treasury,
    dailyRemaining: chainOk ? String(chain.window.remaining) : clampStr(big(dailyCap) - big(spent)),
    sessions: (cfg.sessions || ["default"]).map((session) => ({
      session,
      revoked: (cfg.revokedSessions || []).includes(session),
    })),
    window: chainOk ? chain.window : null,
    whitelist: whitelist.map((address) => ({ address, name: label(address) })),
    ledger: journalLedger(cfg.component, label),
    // Provenance of each figure, so the UI (and a reviewer) can see what is chain-authoritative.
    source: {
      treasury: treasuryFromChain ? "chain" : "journal(cache)",
      spent: chainOk ? "chain" : "unavailable",
      caps: chainOk ? "chain" : "cache",
      whitelist: chainOk ? "chain" : "cache",
      revoked: chainOk ? "chain" : "cache",
      fundedWithdrawn: "journal",
      chainRead: chainOk,
    },
  };
  return base;
}

// ---- restricted operation registry -----------------------------------------------------------
// These `run` functions are the ONLY code that drives walletd / mutates the budget. Each declares a
// risk tier; high-risk ones require a step-up confirmation. The authorizer (below) is the single
// gate in front of them — request handlers never call walletd directly, so a compromised web layer
// is confined to exactly this reviewed set of actions.
// A short, honest "submitted but not confirmed" result for the unknown lifecycle outcome. The
// current dashboard state is returned alongside (chain-authoritative), plus a `pending` marker — it
// is explicitly NOT reported as done.
async function pendingResult(record, noun) {
  return {
    ...(await dashboardState()),
    pending: true,
    txId: record.txId,
    notice: `${noun} submitted to chain but not yet confirmed — it is NOT counted as done until reconciled (tx ${record.txId || "?"}).`,
  };
}

const OPS = {
  // Fund + mint a new budget: moves owner funds and sets the on-chain rules → high-risk.
  createBudget: {
    tier: TIERS.ADMIN,
    highRisk: true,
    async run(body, ctx) {
      if (store.budget) throw httpError(409, "A budget is already open. Reset it to create a new one.");
      const fund = toAmount(body.fund, "fund");
      const perTxCap = toAmount(body.perTxCap, "per-transaction cap");
      const dailyCap = toAmount(body.dailyCap, "daily cap");
      const epochsPerWindow = Math.max(1, Number(body.epochsPerWindow) || 10);
      if (big(perTxCap) > big(dailyCap)) throw httpError(400, "Per-transaction cap cannot exceed the daily cap.");
      if (big(fund) <= 0n) throw httpError(400, "Funding amount must be greater than zero.");
      const wlNames = Array.isArray(body.whitelist) ? body.whitelist : [];
      const whitelist = [];
      for (const n of wlNames) whitelist.push(await resolveMerchant(n));
      const c = await walletd();
      const budget = new OnChainBudget(c, BUDGET_TEMPLATE, ownerAddr);
      budget.epochsPerWindow = epochsPerWindow;
      const key = idemKey(body, "createBudget:" + crypto.randomUUID());
      const r = await runChainOp(
        key,
        "createBudget",
        null, // the new component address is unknown until the open confirms
        { fund, perTxCap, dailyCap, epochsPerWindow, whitelist: whitelist.length },
        () => budget.open({ fund, perTxCap, dailyCap, epochsPerWindow, whitelist }),
      );
      ctx.meta.txId = r.record.txId;
      ctx.meta.params = { fund, perTxCap, dailyCap, epochsPerWindow, whitelist: whitelist.length };
      if (r.outcome === "unknown") return await pendingResult(r.record, "Budget creation");
      txlog.settle(key, { component: budget.component }); // tag the record with its new budget
      snapshotBudget(budget); // only now is the component live on chain
      ctx.meta.txId = budget.component;
      return await dashboardState();
    },
  },

  // Agent payment: money-moving, within the on-chain caps → throttled + flagged, not step-up.
  // Idempotent on the invoice id: paying the same invoice twice does not double-spend.
  pay: {
    tier: TIERS.MONEY,
    async run(body, ctx) {
      const b = await liveBudget();
      if (!b) throw httpError(409, "No budget is open.");
      const merchant = await resolveMerchant(body.merchant);
      const amount = toAmount(body.amount, "amount");
      const agentTag = (body.agentTag || "agent").toString().slice(0, 24);
      const invoiceId = body.invoiceId ? String(body.invoiceId) : newInvoiceId();
      // Free-text memo is recorded in the journal/receipt for the caller's reference. (It is NOT the
      // on-chain memo — that public plaintext memo carries the encoded invoice id + agent tag; see invoice.ts.)
      const memo = body.memo != null ? String(body.memo).slice(0, 120) : undefined;
      const key = idemKey(body, "pay:" + invoiceId);
      let r;
      try {
        r = await runChainOp(
          key,
          "pay",
          b.component,
          { merchant, amount, invoiceId, memo },
          () => b.payInvoice({ merchant, invoiceId, amount, agentTag }),
          { merchant, amount, memo }, // fingerprint on what the money DOES, not the (often auto-generated) invoiceId
        );
      } catch (e) {
        // Surface the chain's own reason as a friendly 422, distinct from a server fault.
        if (e.idempotencyConflict) throw e; // preserve the 409 for a reused key with different params
        throw httpError(422, chainMessage(e));
      }
      ctx.meta.txId = (r.record && r.record.txId) || invoiceId;
      ctx.meta.params = { merchant, amount, invoiceId, memo };
      // No snapshotBudget: the ledger + spend are rebuilt from chain / the journal, not persisted here.
      if (r.outcome === "unknown") return await pendingResult(r.record, "Payment");
      return { ...(await dashboardState()), paid: { amount, merchant, invoiceId }, replayed: Boolean(r.replay) };
    },
  },

  // Expand the on-chain whitelist → high-risk (grows who the agent may pay).
  addMerchant: {
    tier: TIERS.ADMIN,
    highRisk: true,
    async run(body, ctx) {
      const b = await liveBudget();
      if (!b) throw httpError(409, "No budget is open.");
      const address = await resolveMerchant(body.merchant);
      if (b.whitelist.includes(address)) throw httpError(400, "That merchant is already whitelisted.");
      const key = idemKey(body, "addMerchant:" + crypto.randomUUID());
      const r = await runChainOp(key, "addMerchant", b.component, { merchant: address }, () => b.addMerchant(address));
      ctx.meta.txId = r.record.txId;
      ctx.meta.params = { merchant: address };
      if (r.outcome === "unknown") return await pendingResult(r.record, "Add-merchant");
      snapshotBudget(b); // refresh the cached whitelist (chain remains authority)
      return await dashboardState();
    },
  },

  // Pull funds out of the vault back to the owner → highest-risk money extraction.
  withdraw: {
    tier: TIERS.ADMIN,
    highRisk: true,
    async run(body, ctx) {
      const b = await liveBudget();
      if (!b) throw httpError(409, "No budget is open.");
      const amount = toAmount(body.amount, "amount");
      // Treasury ceiling comes from the CHAIN vault balance, not a local accumulator.
      let chain = null;
      try {
        chain = await readChainBudget(b.component);
      } catch (e) {
        console.error("warn: withdraw could not read chain treasury:", e.message);
      }
      if (chain && chain.vaultBalance != null && big(amount) > big(chain.vaultBalance)) {
        throw httpError(400, `Only ${chain.vaultBalance} remains in the treasury.`);
      }
      const key = idemKey(body, "withdraw:" + crypto.randomUUID());
      const r = await runChainOp(key, "withdraw", b.component, { amount }, () => b.withdraw(amount));
      ctx.meta.txId = r.record.txId;
      ctx.meta.params = { amount };
      if (r.outcome === "unknown") return await pendingResult(r.record, "Withdrawal");
      return await dashboardState(); // withdrawn total now derives from the journal
    },
  },

  // Add funds into the vault: money-moving (from the owner account) → throttled + flagged.
  topUp: {
    tier: TIERS.MONEY,
    async run(body, ctx) {
      const b = await liveBudget();
      if (!b) throw httpError(409, "No budget is open.");
      const amount = toAmount(body.amount, "amount");
      if (big(amount) <= 0n) throw httpError(400, "Top-up amount must be greater than zero.");
      const key = idemKey(body, "topUp:" + crypto.randomUUID());
      let r;
      try {
        r = await runChainOp(key, "topUp", b.component, { amount }, () => b.topUp(amount));
      } catch (e) {
        if (e.idempotencyConflict) throw e; // preserve the 409 for a reused key with different params
        throw httpError(422, chainMessage(e));
      }
      ctx.meta.txId = r.record.txId;
      ctx.meta.params = { amount };
      if (r.outcome === "unknown") return await pendingResult(r.record, "Top-up");
      return await dashboardState(); // funded total now derives from the journal
    },
  },

  // Global on-chain kill switch for the agent → high-risk, irreversible.
  revoke: {
    tier: TIERS.ADMIN,
    highRisk: true,
    async run(body, ctx) {
      const b = await liveBudget();
      if (!b) throw httpError(409, "No budget is open.");
      if (b.revoked) throw httpError(400, "This budget is already revoked.");
      const key = idemKey(body, "revoke:" + crypto.randomUUID());
      const r = await runChainOp(key, "revoke", b.component, {}, () => b.revoke());
      ctx.meta.txId = r.record.txId;
      ctx.meta.params = {};
      if (r.outcome === "unknown") return await pendingResult(r.record, "Revoke");
      snapshotBudget(b);
      return await dashboardState();
    },
  },

  // Mint a new agent-session badge → high-risk (grants fresh spending authority).
  // Idempotent on the session label.
  issueSession: {
    tier: TIERS.ADMIN,
    highRisk: true,
    async run(body, ctx) {
      const b = await liveBudget();
      if (!b) throw httpError(409, "No budget is open.");
      const session = String(body.session || "").trim();
      if (!session) throw httpError(400, "A session label is required.");
      // Keep this in lockstep with the SDK/TS client's SESSION_RE (no spaces): a label the server
      // accepts but the client then rejects would surface as a confusing 422 downstream (#13).
      if (!/^[A-Za-z0-9_.\-]{1,64}$/.test(session)) {
        throw httpError(400, "Use letters, numbers, '.', '-' or '_' (no spaces, max 64).");
      }
      if ((b.sessions || []).includes(session)) throw httpError(400, "That session label already exists.");
      const key = idemKey(body, "issueSession:" + session);
      let r;
      try {
        r = await runChainOp(key, "issueSession", b.component, { session }, () => b.issueAgentBadge(session));
      } catch (e) {
        if (e.idempotencyConflict) throw e; // preserve the 409 for a reused key with different params
        throw httpError(422, chainMessage(e));
      }
      ctx.meta.txId = r.record.txId;
      ctx.meta.params = { session };
      if (r.outcome === "unknown") return await pendingResult(r.record, "Issue-session");
      snapshotBudget(b);
      return await dashboardState();
    },
  },

  // Revoke a single agent session → high-risk, irreversible for that session.
  revokeSession: {
    tier: TIERS.ADMIN,
    highRisk: true,
    async run(body, ctx) {
      const b = await liveBudget();
      if (!b) throw httpError(409, "No budget is open.");
      const session = String(body.session || "").trim();
      if (!session) throw httpError(400, "A session label is required.");
      if ((b.revokedSessions || []).includes(session)) throw httpError(400, "That session is already revoked.");
      const key = idemKey(body, "revokeSession:" + session);
      let r;
      try {
        r = await runChainOp(key, "revokeSession", b.component, { session }, () => b.revokeSession(session));
      } catch (e) {
        if (e.idempotencyConflict) throw e; // preserve the 409 for a reused key with different params
        throw httpError(422, chainMessage(e));
      }
      ctx.meta.txId = r.record.txId;
      ctx.meta.params = { session };
      if (r.outcome === "unknown") return await pendingResult(r.record, "Revoke-session");
      snapshotBudget(b);
      return await dashboardState();
    },
  },

  // Detach the local budget view (no chain effect) → still high-risk (can hide a live budget).
  resetLocal: {
    tier: TIERS.ADMIN,
    highRisk: true,
    async run(_body, ctx) {
      // LOCAL ONLY. Detaches the dashboard's budget reference. It does NOT touch the chain: the
      // AgentBudget component, its vault and any remaining treasury stay exactly as they are, and no
      // funds are withdrawn or refunded. The tx journal is PRESERVED (it is an operation record, and
      // its rows are scoped by component, so a later new budget starts with its own clean history).
      store.budget = null;
      saveStore();
      ctx.meta.params = {};
      return {
        ...(await dashboardState()),
        notice:
          "Local view cleared. The on-chain budget component, its vault and any remaining treasury " +
          "still exist on chain — reset does not withdraw or refund funds. The operation journal is kept.",
      };
    },
  },

  // Emergency stop: freeze every money/admin action dashboard-wide (independent of on-chain revoke).
  // #12: an emergency stop must be EASY to engage and HARD to lift. `freeze` therefore skips the
  // step-up gate (`noStepUp`) and the rate limiter (`bypassRateLimit`) — a logged-in operator can
  // always hit the brakes, even while a flood is tripping limits. It stays `highRisk` so the action
  // is still durably audited. `unfreeze` below keeps the full step-up gate (hard to lift).
  freeze: {
    tier: TIERS.ADMIN,
    highRisk: true,
    noStepUp: true,
    bypassRateLimit: true,
    async run(_body, ctx) {
      store.frozen = true;
      saveStore();
      ctx.meta.params = {};
      return { ...(await dashboardState()), notice: "Dashboard frozen. All fund-moving actions are blocked until you unfreeze." };
    },
  },

  // Lift the emergency stop. Allowed even while frozen (it is the way out), but still step-up gated.
  unfreeze: {
    tier: TIERS.ADMIN,
    highRisk: true,
    allowWhenFrozen: true,
    async run(_body, ctx) {
      store.frozen = false;
      saveStore();
      ctx.meta.params = {};
      return { ...(await dashboardState()), notice: "Dashboard unfrozen. Fund-moving actions are enabled again." };
    },
  },
};

// The single audited gate in front of every chain operation.
const authz = createAuthorizer({ ops: OPS, audit, isFrozen: () => Boolean(store.frozen), stepUp, rate });

// ---- API handlers -----------------------------------------------------------------------------
// Reads are plain handlers. Every state-changing endpoint delegates to the authorizer, which
// enforces the whitelist, kill switch, rate limit, step-up confirmation and audit trail.
const api = {
  async "GET /api/state"() {
    return await dashboardState();
  },

  async "GET /api/audit"(_body, _ctx, query) {
    const limit = Math.max(1, Math.min(500, Number(query && query.limit) || 100));
    return { entries: audit.recent(limit) };
  },

  // The transaction journal (read-only): every fund-moving op with its pending/confirmed/rejected/
  // unknown lifecycle, tx id and idempotency key — the record the server reconciles against chain.
  async "GET /api/txlog"() {
    return { summary: txlog.summary(), records: txlog.list() };
  },

  // Force an on-chain reconcile of any open (pending/unknown) records right now (read-only on chain:
  // it only calls get_result). Handy after a crash/restart or a network blip.
  async "POST /api/reconcile"() {
    const r = await reconcileAll();
    return { ...r, summary: txlog.summary() };
  },

  async "POST /api/connect"() {
    await walletd();
    return await dashboardState();
  },

  async "POST /api/dry-run"(body) {
    const b = await liveBudget();
    if (!b) throw httpError(409, "No budget is open.");
    const merchant = await resolveMerchant(body.merchant);
    const amount = toAmount(body.amount, "amount");
    const reason = await b.wouldReject(merchant, amount, { memo: "dry-run" });
    return { ok: reason === null, reason };
  },

  async "POST /api/merchants/resolve"(body) {
    const address = await resolveMerchant(body.merchant);
    return { name: String(body.merchant).trim().toLowerCase(), address };
  },

  "POST /api/budget": (body, ctx) => authz.execute("createBudget", body, ctx),
  "POST /api/pay": (body, ctx) => authz.execute("pay", body, ctx),
  "POST /api/merchants": (body, ctx) => authz.execute("addMerchant", body, ctx),
  "POST /api/withdraw": (body, ctx) => authz.execute("withdraw", body, ctx),
  "POST /api/top-up": (body, ctx) => authz.execute("topUp", body, ctx),
  "POST /api/revoke": (body, ctx) => authz.execute("revoke", body, ctx),
  "POST /api/sessions": (body, ctx) => authz.execute("issueSession", body, ctx),
  "POST /api/sessions/revoke": (body, ctx) => authz.execute("revokeSession", body, ctx),
  "POST /api/reset": (body, ctx) => authz.execute("resetLocal", body, ctx),
  "POST /api/freeze": (body, ctx) => authz.execute("freeze", body, ctx),
  "POST /api/unfreeze": (body, ctx) => authz.execute("unfreeze", body, ctx),
};

// ---- helpers ----------------------------------------------------------------------------------
function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra); // policy flags the handlers forward (idempotencyConflict, …)
  return e;
}
// Base-unit amounts are integers that can exceed JS's safe-integer range (2^53). We carry them as
// decimal-integer STRINGS and do all arithmetic with BigInt, so a large amount never loses
// precision or stringifies in exponential form (which would corrupt the on-chain manifest).
function toAmount(v, label) {
  const s = String(v == null ? "" : v).trim();
  if (!/^\d+$/.test(s)) throw httpError(400, `Invalid ${label} (whole number only).`);
  return s;
}
/** Coerce a stored amount (string, or legacy number) to BigInt. */
function big(x) {
  if (typeof x === "bigint") return x;
  const s = String(x == null ? "0" : x).trim();
  return BigInt(/^-?\d+$/.test(s) ? s : "0");
}
/** max(0, a) for BigInt, as a decimal string. */
function clampStr(a) {
  return (a < 0n ? 0n : a).toString();
}
function chainMessage(e) {
  if (e instanceof PolicyViolation) return e.message;
  if (e instanceof ChainError) return e.message;
  return e && e.message ? e.message : "The chain rejected the transaction.";
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  let urlPath;
  try {
    // A malformed percent-escape (e.g. GET /%E0%A4%A) makes decodeURIComponent throw URIError;
    // without this guard that throw became an unhandled rejection and killed the process (H1).
    urlPath = decodeURIComponent((req.url.split("?")[0] || "/"));
  } catch {
    res.writeHead(400);
    return res.end("bad request");
  }
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback to index.html for unknown non-asset routes
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, idx) => {
          if (e2) {
            res.writeHead(404);
            return res.end("not found");
          }
          res.writeHead(200, { "Content-Type": MIME[".html"] });
          res.end(idx);
        });
      }
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const MAX_BODY_BYTES = 1e6; // 1 MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      // Stop accepting data AND tear the socket down, so a client streaming a huge body can't keep
      // growing our memory after we've rejected (H2: a 300 MB stream to /api/login pushed RSS to
      // ~410 MB because the old code only rejected the promise and kept appending).
      req.destroy();
      reject(err);
    };
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) return fail(httpError(413, "payload too large"));
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      if (size === 0) return resolve({});
      // Collect Buffers and concat once, so a multi-byte UTF-8 char split across chunks is not
      // corrupted (the old `raw += c` string concat could mangle it).
      const raw = Buffer.concat(chunks, size).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, "invalid JSON body"));
      }
    });
    req.on("error", fail);
  });
}

// ================================================================================================
// Machine-to-machine integration API (/api/v1/*) — API-key authenticated.
//
// This is a SECOND, independent entry surface that sits on the SAME foundations as the browser
// dashboard and re-uses them rather than re-implementing anything:
//   • the restricted authorizer (authz.execute) — same whitelist / kill switch / rate limit / audit;
//   • the tx journal (txlog) — same pending→confirmed|rejected|unknown lifecycle + idempotency;
//   • chain-authoritative reads (dashboardState / readChainBudget) — same live balances/caps.
//
// It does NOT touch the browser's session cookie, CSRF or login throttle: a v1 request is dispatched
// here BEFORE those gates, and it authenticates with a bearer API key instead. Tiered access:
//   • an `agent` key may create payments and read (payments / budget / merchants);
//   • an `admin` key may additionally open a budget, register merchants and read the audit log.
// The on-chain AgentBudget still enforces the real spend limits regardless of which key calls.
// See docs/api.md for the full reference + integration guide.
// ================================================================================================
const V1 = "/api/v1";

/** Extract the presented API key from `Authorization: Bearer …` or `X-API-Key`. */
function bearerKey(req) {
  const h = req.headers["authorization"];
  if (h && /^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, "").trim();
  const x = req.headers["x-api-key"];
  return x ? String(x).trim() : "";
}
/** An invoice id valid for the on-chain (public plaintext) memo codec, or null. */
function validInvoiceId(v) {
  const s = String(v == null ? "" : v).trim();
  return /^[a-z0-9]{8,32}$/.test(s) ? s : null;
}
/**
 * Execute an authorizer op on behalf of an API key. High-risk ops require a step-up confirmation in
 * the browser world (a human re-enters the admin secret); for machine-to-machine there is no human
 * second factor — the admin API key IS the strong, out-of-band credential. So when step-up is on and
 * the op is high-risk, we mint the single-use confirm token server-side. The v1 role gate upstream
 * guarantees ONLY an admin key ever reaches a high-risk op, so this does not widen access.
 */
async function executeAsKey(opName, body, ctx) {
  const op = OPS[opName];
  // Mint the single-use confirm token from the SAME body the op will run with, so the funding-param
  // binding is satisfied automatically for the machine-to-machine path (the admin key is the strong
  // out-of-band factor; the token binding still pins amount/payee/budget for the audit trail).
  if (op && op.highRisk && STEP_UP_ON) ctx = { ...ctx, confirmToken: issueConfirmToken(opName, body) };
  return await authz.execute(opName, body, ctx);
}
/** Build a public payment receipt from a tx-journal record (status is chain-authoritative). */
function receiptOf(rec) {
  if (!rec) return null;
  const names = nameByAddr();
  const p = rec.params || {};
  const ev = rec.event || null;
  const merchant = (ev && ev.merchant) || p.merchant || null;
  return {
    id: rec.key, // the idempotency key is the stable payment id
    status: rec.status, // pending | confirmed | rejected | unknown
    txId: rec.txId || null,
    amount: ev && ev.amount != null ? String(ev.amount) : p.amount != null ? String(p.amount) : null,
    merchant,
    merchantName: merchant ? names[merchant] || null : null,
    memo: (ev && ev.memo) || p.memo || null,
    invoiceId: p.invoiceId || null,
    reason: rec.reason || null,
    createdAt: rec.createdAt || null,
    updatedAt: rec.updatedAt || null,
  };
}
/** Project the dashboard state into the compact v1 budget shape (all values chain-derived). */
function v1Budget(st) {
  if (!st.budget) return null;
  const b = st.budget;
  return {
    component: b.component,
    perTxCap: b.perTxCap,
    dailyCap: b.dailyCap,
    spent: b.spent,
    dailyRemaining: b.dailyRemaining,
    treasury: b.treasury,
    balance: b.treasury, // alias
    revoked: b.revoked,
    frozen: Boolean(st.frozen),
    window: b.window,
    whitelist: b.whitelist,
    funded: b.funded,
    withdrawn: b.withdrawn,
    source: b.source, // provenance of each figure (chain / cache / journal)
  };
}

async function handleApiV1(req, res, urlPath) {
  const ip = clientIp(req);
  const method = req.method;
  const sub = urlPath.slice(V1.length).replace(/\/+$/, "") || "/"; // "/payments", "/payments/:id", …

  // --- public (no key): discovery + the OpenAPI spec --------------------------------------------
  if (method === "GET" && sub === "/") {
    return sendJson(res, 200, {
      name: "AgentPay integration API",
      version: "v1",
      enabled: apiKeys.configured(),
      auth: "Bearer API key (Authorization: Bearer <key>, or X-API-Key). Roles: agent, admin.",
      endpoints: [
        "POST   /api/v1/payments        (agent) — make a capped payment; REQUIRES an Idempotency-Key header",
        "GET    /api/v1/payments        (agent) — list payment receipts",
        "GET    /api/v1/payments/:id    (agent) — one receipt / status",
        "GET    /api/v1/budget          (agent) — caps, remaining window, treasury (chain-derived)",
        "GET    /api/v1/merchants       (agent) — the on-chain whitelist",
        "POST   /api/v1/merchants       (admin) — add a merchant to the whitelist",
        "DELETE /api/v1/merchants/:name (admin) — remove a local merchant alias",
        "POST   /api/v1/budgets         (admin) — open/fund a budget",
        "GET    /api/v1/audit           (admin) — recent audit entries",
        "GET    /api/v1/keys            (admin) — list API keys (id/role/revoked)",
        "POST   /api/v1/keys/:id/revoke (admin) — revoke an API key at runtime",
      ],
      spec: "/api/v1/openapi.json",
      docs: "docs/api.md",
    });
  }
  if (method === "GET" && sub === "/openapi.json") {
    try {
      const spec = fs.readFileSync(path.join(PUBLIC_DIR, "openapi.json"));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(spec);
    } catch {
      return sendJson(res, 404, { error: "OpenAPI spec unavailable." });
    }
  }

  // --- the surface is disabled unless keys are configured ---------------------------------------
  if (!apiKeys.configured()) {
    return sendJson(res, 503, {
      error: "The integration API is not enabled on this deployment. Set AGENTPAY_API_KEYS to enable /api/v1.",
    });
  }

  // --- authenticate the API key -----------------------------------------------------------------
  const presented = bearerKey(req);
  const who = apiKeys.verify(presented);
  if (!who) {
    audit.append({ actor: "api", ip, op: `${method} ${sub}`, tier: "api", status: "denied", reason: presented ? "bad_api_key" : "missing_api_key" });
    res.setHeader("WWW-Authenticate", 'Bearer realm="AgentPay"');
    return sendJson(res, 401, { error: "Missing or invalid API key.", authenticate: "Bearer" });
  }

  const ctx = { actor: `key:${who.id}`, sid: null, ip, rateKey: `key:${who.id}`, apiKeyId: who.id, apiRole: who.role };
  // Deny + audit an admin-only endpoint reached by a non-admin key.
  function denyIfNotAdmin(op) {
    if (who.role === apiKeys.ROLES.ADMIN) return false;
    audit.append({ actor: `key:${who.id}`, ip, op: op || `${method} ${sub}`, tier: "api", status: "denied", reason: "insufficient_role" });
    sendJson(res, 403, { error: "This endpoint requires an admin API key." });
    return true;
  }

  let body = {};
  if (method === "POST" || method === "DELETE") {
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message });
    }
  }
  const query = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);

  try {
    // ---- payments -------------------------------------------------------------------------------
    if (sub === "/payments" && method === "POST") {
      const idemHeader = String(req.headers["idempotency-key"] || "").trim();
      // #14: REQUIRE an Idempotency-Key on the payment endpoint. Without it a client that retries a
      // timed-out request would pay twice (the server would otherwise mint a random invoice id per
      // call, so the retry gets a fresh key and re-submits). Making it mandatory puts the dedup key
      // in the caller's control and closes that double-pay path.
      if (!idemHeader) {
        throw httpError(400, "POST /payments requires an Idempotency-Key header (so a retried request cannot pay twice).");
      }
      const invoiceId = validInvoiceId(body.invoiceId) || newInvoiceId();
      // Payment id = the caller's Idempotency-Key. A repeat with the same key never re-submits to
      // chain (txlog enforces it); a repeat with different funding params is a hard conflict.
      const key = idemHeader.slice(0, 128);
      const payBody = {
        merchant: body.merchant,
        amount: body.amount,
        memo: body.memo,
        agentTag: body.agentTag,
        invoiceId,
        idempotencyKey: key,
      };
      // A journaled key already present means this request is a replay (idempotent hit), whatever the
      // recorded outcome — including a prior rejection, where the op re-throws the chain's reason.
      const priorExisted = Boolean(txlog.get(key));
      let replayed = priorExisted;
      try {
        const r = await serialize(() => authz.execute("pay", payBody, ctx));
        replayed = priorExisted || Boolean(r && r.replayed);
      } catch (e) {
        // A reused key with DIFFERENT parameters is a hard conflict — surface it, never fall through
        // to replay the prior receipt (which belongs to a different request).
        if (e.idempotencyConflict) throw e;
        // A chain REJECTION still produces a receipt (status=rejected). Only a record-less failure
        // (bad request, frozen, rate-limited, no budget) is surfaced as an error.
        if (!txlog.get(key)) throw e;
      }
      const rec = txlog.get(key);
      const receipt = receiptOf(rec);
      const status =
        rec && rec.status === "confirmed" ? 201 : rec && rec.status === "rejected" ? 402 : 202; // pending/unknown
      return sendJson(res, status, { receipt, replayed });
    }
    if (sub === "/payments" && method === "GET") {
      const payments = txlog
        .list()
        .filter((r) => r.op === "pay")
        .map(receiptOf);
      return sendJson(res, 200, { payments });
    }
    if (sub.startsWith("/payments/") && method === "GET") {
      const id = decodeURIComponent(sub.slice("/payments/".length));
      // This is the payments endpoint: only ever expose `pay` records. Looking a record up by its
      // idempotency key could otherwise return any op (e.g. a withdraw), leaking it on this route.
      let rec = txlog.get(id);
      if (rec && rec.op !== "pay") rec = null;
      if (!rec) rec = txlog.list().find((r) => r.op === "pay" && r.txId === id) || null;
      // Status tracking: advance an open record by settling it against chain (read-only get_result).
      if (rec && txlog.isOpen(rec.status) && rec.txId) {
        try {
          rec = await serialize(() => reconcileRecord(rec));
        } catch {
          /* leave it open; the caller can poll again */
        }
      }
      if (!rec) return sendJson(res, 404, { error: "No payment with that id." });
      return sendJson(res, 200, { receipt: receiptOf(rec) });
    }

    // ---- budget ---------------------------------------------------------------------------------
    if (sub === "/budget" && method === "GET") {
      const st = await serialize(() => dashboardState());
      return sendJson(res, 200, { budget: v1Budget(st) });
    }
    if (sub === "/budgets" && method === "POST") {
      if (denyIfNotAdmin("createBudget")) return;
      await serialize(() => executeAsKey("createBudget", body, ctx));
      const st = await dashboardState();
      return sendJson(res, 201, { budget: v1Budget(st) });
    }

    // ---- merchants (whitelist) ------------------------------------------------------------------
    if (sub === "/merchants" && method === "GET") {
      const st = await serialize(() => dashboardState());
      const whitelist = (st.budget && st.budget.whitelist) || [];
      return sendJson(res, 200, { merchants: whitelist, source: st.budget ? "chain" : "none" });
    }
    if (sub === "/merchants" && method === "POST") {
      if (denyIfNotAdmin("addMerchant")) return;
      await serialize(() => executeAsKey("addMerchant", { merchant: body.merchant }, ctx));
      const st = await dashboardState();
      return sendJson(res, 201, { merchants: (st.budget && st.budget.whitelist) || [] });
    }
    if (sub.startsWith("/merchants/") && method === "DELETE") {
      if (denyIfNotAdmin("deleteMerchantAlias")) return;
      const name = decodeURIComponent(sub.slice("/merchants/".length)).trim().toLowerCase();
      const existed = Object.prototype.hasOwnProperty.call(store.merchants, name);
      if (existed) {
        delete store.merchants[name];
        saveStore();
      }
      audit.append({ actor: `key:${who.id}`, ip, op: "deleteMerchantAlias", tier: "admin", status: "ok", params: { name } });
      return sendJson(res, 200, {
        removedAlias: existed,
        name,
        notice:
          "Removed the local merchant alias only. NOTE: this endpoint does NOT call the template's " +
          "on-chain remove_merchant — the address stays whitelisted (spendable) on chain. To remove " +
          "it on chain, use the owner-badge remove_merchant method directly, or revoke the agent / " +
          "open a new budget. See docs/api.md 'Known limitations'.",
      });
    }

    // ---- audit ----------------------------------------------------------------------------------
    if (sub === "/audit" && method === "GET") {
      if (denyIfNotAdmin("audit")) return;
      const limit = Math.max(1, Math.min(500, Number(query.limit) || 100));
      return sendJson(res, 200, { entries: audit.recent(limit) });
    }

    // ---- API keys (#9: the runtime revoke entry point) ------------------------------------------
    // apikeys.js has always supported runtime revoke; these endpoints expose it (admin-only) so a
    // leaked key can be killed without an env edit + restart. The key list stays in env; this only
    // flips the persisted revocation flag (secret-free metadata is returned).
    if (sub === "/keys" && method === "GET") {
      if (denyIfNotAdmin("listApiKeys")) return;
      return sendJson(res, 200, { keys: apiKeys.list() });
    }
    if (sub.startsWith("/keys/") && sub.endsWith("/revoke") && method === "POST") {
      if (denyIfNotAdmin("revokeApiKey")) return;
      const id = decodeURIComponent(sub.slice("/keys/".length, -"/revoke".length));
      const ok = apiKeys.revoke(id);
      if (!ok) return sendJson(res, 404, { error: `No API key with id ${JSON.stringify(id)}.` });
      return sendJson(res, 200, { id, revoked: true, keys: apiKeys.list() });
    }

    return sendJson(res, 404, { error: "Unknown API endpoint. GET /api/v1 lists the available ones." });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`v1 ${method} ${sub} failed:`, e);
    const payload = { error: chainMessage(e) };
    if (e.frozen) payload.frozen = true;
    if (e.rateLimited) payload.rateLimited = true;
    if (e.idempotencyConflict) payload.idempotencyConflict = true;
    if (e.auditUnavailable) payload.auditUnavailable = true;
    if (e.confirmRequired) payload.confirmRequired = true; // not expected for admin keys (token auto-minted)
    return sendJson(res, status, payload);
  }
}

// Last-resort safety net: an unexpected rejection/exception in an async request handler must not
// take the whole process down (H1 — one malformed URL could do exactly that). Log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(req, res); // every response: static and API
  const urlPath = (req.url || "/").split("?")[0];
  // Machine-to-machine API: dispatched BEFORE the browser session/CSRF/auth gate (it authenticates
  // with an API key, not a cookie), so it neither relies on nor weakens the dashboard's gate.
  if (urlPath === V1 || urlPath.startsWith(V1 + "/")) return handleApiV1(req, res, urlPath);
  if (!urlPath.startsWith("/api/")) return serveStatic(req, res);

  const key = `${req.method} ${urlPath}`;

  // --- CSRF / cross-origin defense for cookie-authenticated, state-changing requests -----------
  // Only meaningful when AUTH_ON (a cookie is the ambient credential being abused). Applies to all
  // POSTs. Login is exempt from the TOKEN check (no session exists yet) but NOT from the Origin check,
  // so login-CSRF from another origin is still refused. Reads (GET) carry no side effects.
  if (AUTH_ON && req.method === "POST") {
    if (!originAllowed(req)) {
      audit.append({ actor: "?", ip: clientIp(req), op: "request", tier: "auth", status: "denied", reason: "bad_origin" });
      return sendJson(res, 403, { error: "Cross-origin request refused." });
    }
    const session = verifySession(parseCookies(req)[COOKIE_NAME]);
    if (key !== "POST /api/login" && session && !csrfTokenOk(req, session.sid)) {
      audit.append({
        actor: `op:${session.sid.slice(0, 8)}`,
        sid: session.sid,
        ip: clientIp(req),
        op: "request",
        tier: "auth",
        status: "denied",
        reason: "missing_csrf",
      });
      return sendJson(res, 403, { error: "Missing or invalid CSRF token.", csrf: true });
    }
  }

  // --- public auth endpoints (no session required) -----------------------------------------
  if (key === "GET /api/session") {
    const session = AUTH_ON ? verifySession(parseCookies(req)[COOKIE_NAME]) : null;
    return sendJson(res, 200, {
      authRequired: AUTH_ON,
      authed: AUTH_ON ? session !== null : true,
      stepUpRequired: STEP_UP_ON,
      frozen: Boolean(store.frozen),
      // The CSRF token for this session; the SPA echoes it in the X-CSRF-Token header on every POST.
      csrfToken: session && session.sid ? csrfTokenFor(session.sid) : null,
    });
  }
  if (key === "POST /api/logout") {
    // Truly invalidate the token on this instance: remember its sid as revoked until it would expire.
    const session = verifySession(parseCookies(req)[COOKIE_NAME]);
    if (session && session.sid && typeof session.exp === "number") {
      pruneRevokedSids();
      revokedSids.set(session.sid, session.exp);
    }
    clearSessionCookie(req, res);
    return sendJson(res, 200, { authed: false });
  }
  if (key === "POST /api/login") {
    if (!AUTH_ON) return sendJson(res, 200, { authed: true }); // nothing to authenticate against
    const ip = clientIp(req);
    if (loginLocked(ip)) return sendJson(res, 429, { error: "Too many attempts. Try again in a few minutes." });
    let body = {};
    try {
      body = await readBody(req);
    } catch {
      /* treat as empty */
    }
    if (passwordMatches(body.password)) {
      noteLoginOk(ip);
      // Session rotation: every successful login mints a brand-new random sid and a freshly signed
      // cookie, so there is no attacker-chosen identifier to fixate (and the token is server-minted —
      // a pre-set cookie can't be forged without SESSION_SECRET).
      const sid = crypto.randomUUID();
      setSessionCookie(req, res, signSession({ iat: Date.now(), exp: Date.now() + SESSION_TTL_MS, sid }), SESSION_TTL_MS);
      audit.append({ actor: `op:${sid.slice(0, 8)}`, sid, ip, op: "login", tier: "auth", status: "ok" });
      return sendJson(res, 200, { authed: true, csrfToken: csrfTokenFor(sid) });
    }
    noteLoginFail(ip);
    return sendJson(res, 401, { error: "Incorrect password." }); // never log the attempt/value
  }

  // --- gate everything else ----------------------------------------------------------------
  if (AUTH_ON && !isAuthed(req)) return sendJson(res, 401, { error: "Authentication required." });

  // --- step-up: mint a short-lived, single-use confirmation token for one high-risk action -----
  // Requires a valid session AND re-presenting the admin secret, so a stolen session alone can't
  // move funds. In open local-dev mode there is no secret, so this is a no-op the UI skips.
  if (key === "POST /api/confirm") {
    let body = {};
    try {
      body = await readBody(req);
    } catch {
      /* treat as empty */
    }
    const op = String(body.op || "");
    if (!OPS[op] || !OPS[op].highRisk) return sendJson(res, 400, { error: "Unknown or non-confirmable operation." });
    if (!STEP_UP_ON) return sendJson(res, 200, { stepUp: false, token: null });
    const ip = clientIp(req);
    if (loginLocked(ip)) return sendJson(res, 429, { error: "Too many attempts. Try again in a few minutes." });
    const ctx = requestCtx(req, body);
    if (!adminPasswordMatches(body.password)) {
      noteLoginFail(ip);
      audit.append({ actor: ctx.actor, sid: ctx.sid, ip, op: `confirm:${op}`, tier: "admin", status: "denied", reason: "bad_password" });
      return sendJson(res, 401, { error: "Incorrect password." }); // never log the attempt/value
    }
    noteLoginOk(ip);
    audit.append({ actor: ctx.actor, sid: ctx.sid, ip, op: `confirm:${op}`, tier: "admin", status: "issued" });
    // Bind the token to the funding parameters the client sent alongside the op name, so it can only
    // confirm THIS action (same amount / payee / caps / budget). The client must send those same
    // fields on the subsequent op call, or verification fails at execute time.
    return sendJson(res, 200, { stepUp: true, token: issueConfirmToken(op, body) });
  }

  const handler = api[key];
  if (!handler) return sendJson(res, 404, { error: "unknown endpoint" });

  try {
    const body = req.method === "POST" ? await readBody(req) : {};
    const query = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
    const ctx = requestCtx(req, body);
    // all chain-touching ops run one at a time; the authorizer enforces policy + audit inside
    const result = await serialize(() => handler(body, ctx, query));
    sendJson(res, 200, result);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`${key} failed:`, e);
    // pass through policy flags so the client can react (frozen / rate-limited / confirm needed)
    const payload = { error: chainMessage(e) };
    if (e.frozen) payload.frozen = true;
    if (e.rateLimited) payload.rateLimited = true;
    if (e.idempotencyConflict) payload.idempotencyConflict = true;
    if (e.auditUnavailable) payload.auditUnavailable = true;
    if (e.confirmRequired) {
      payload.confirmRequired = true;
      payload.op = e.op;
    }
    sendJson(res, status, payload);
  }
});

// Refuse the one dangerous combination: bound to a NON-loopback interface (reachable from the network)
// with auth OFF (no DASHBOARD_PASSWORD). That would expose a custodial wallet, unauthenticated, to
// anyone who can reach the port. Loopback (the default) stays open for local dev; to expose the
// dashboard you must set DASHBOARD_PASSWORD (and put HTTPS / a reverse proxy in front — see
// docs/security.md). This is the "exposed without a password refuses to start" guard.
function isLoopbackHost(h) {
  const v = String(h || "").trim().toLowerCase();
  return v === "127.0.0.1" || v === "::1" || v === "localhost" || v === "";
}
if (!isLoopbackHost(HOST) && !AUTH_ON) {
  console.error(
    `\nRefusing to start: HOST=${HOST} binds beyond loopback (reachable from the network) but no ` +
      `DASHBOARD_PASSWORD is set — that would expose a custodial wallet with no authentication.\n` +
      `Fix one of:\n` +
      `  • set DASHBOARD_PASSWORD (and front the service with HTTPS / a reverse proxy), or\n` +
      `  • bind to loopback for local dev (unset HOST, or HOST=127.0.0.1).\n`,
  );
  process.exit(1);
}

// #10: on a network-exposed deployment, the step-up ("second factor" for move-funds / admin ops)
// must NOT reuse the login password — otherwise it is the same single secret typed twice, not a
// second factor. Refuse to start exposed without a DISTINCT AGENTPAY_ADMIN_PASSWORD. On loopback
// (local dev) this stays a non-fatal note below.
if (!isLoopbackHost(HOST) && AUTH_ON && ADMIN_PASSWORD === DASHBOARD_PASSWORD) {
  console.error(
    `\nRefusing to start: HOST=${HOST} is network-exposed and AGENTPAY_ADMIN_PASSWORD is not set ` +
      `(step-up would reuse DASHBOARD_PASSWORD — no real second factor for a custodial wallet).\n` +
      `Fix: set a DISTINCT AGENTPAY_ADMIN_PASSWORD, or bind to loopback for local dev.\n`,
  );
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  AgentPay dashboard`);
  console.log(`  ├─ UI      http://localhost:${PORT}`);
  console.log(`  ├─ bind    ${HOST}${isLoopbackHost(HOST) ? " (loopback — not reachable from the network)" : " ⚠ EXPOSED — ensure HTTPS / a reverse proxy is in front"}`);
  console.log(`  ├─ walletd ${WALLETD_URL}`);
  console.log(`  ├─ owner   ${OWNER}`);
  console.log(`  ├─ auth    ${AUTH_ON ? "ON (DASHBOARD_PASSWORD set)" : "OFF — local dev mode, do NOT expose"}`);
  console.log(`  ├─ csrf    ${AUTH_ON ? "ON — Origin check + X-CSRF-Token on every POST" : "OFF (no auth)"}`);
  console.log(
    `  ├─ proxy   ${
      !TRUSTED_PROXY || TRUSTED_PROXY.toLowerCase() === "false"
        ? "direct (X-Forwarded-For ignored; client IP = socket peer)"
        : TRUSTED_PROXY.toLowerCase() === "true"
          ? "trusted (left-most X-Forwarded-For = client IP)"
          : `trusted IPs [${[...(TRUSTED_PROXY_IPS || [])].join(", ")}]`
    }`,
  );
  console.log(`  ├─ step-up ${STEP_UP_ON ? "ON — high-risk actions need a fresh confirmation" : "OFF (no password set)"}`);
  console.log(`  ├─ frozen  ${store.frozen ? "YES — fund-moving actions are blocked" : "no"}`);
  console.log(`  ├─ audit   ${audit.file}`);
  if (AUTH_ON && !process.env.SESSION_SECRET) {
    console.log("  │          note: SESSION_SECRET unset — using an ephemeral secret (sessions reset on restart)");
  }
  if (AUTH_ON && (!TRUSTED_PROXY || TRUSTED_PROXY.toLowerCase() === "false")) {
    console.log("  │          note: login/op throttle + logout revocation are in-memory, single-instance (testnet assumption — see docs/security.md). Behind a proxy set TRUSTED_PROXY so the real client IP is used.");
  }
  if (AUTH_ON && !process.env.AGENTPAY_ADMIN_PASSWORD) {
    console.log("  │          note: AGENTPAY_ADMIN_PASSWORD unset — step-up reuses DASHBOARD_PASSWORD (set a distinct one to separate operate vs. move-funds)");
  }
  // Secret hygiene: a deployment that shipped the .env.example placeholders is not safe. Warn loudly
  // (we never print the secret itself).
  if (AUTH_ON && /change-me/i.test(DASHBOARD_PASSWORD)) {
    console.log("  │          ⚠ DASHBOARD_PASSWORD looks like the .env.example placeholder — set a long random value!");
  }
  console.log(
    `  ├─ api/v1  ${
      apiKeys.configured()
        ? `ON — ${apiKeys.list().length} key(s): ${apiKeys.list().map((k) => `${k.id}(${k.role}${k.revoked ? ",revoked" : ""})`).join(", ")}`
        : "OFF — set AGENTPAY_API_KEYS to enable the machine-to-machine API"
    }`,
  );
  console.log(`  ├─ journal ${txlog.file}`);
  const openCount = txlog.pendingOrUnknown().length;
  console.log(`  └─ template ${BUDGET_TEMPLATE.slice(0, 24)}…\n`);

  // Startup reconciliation: settle any journal records left pending/unknown by a previous run (e.g.
  // a crash mid-submit) against the chain, by their tx id. Non-blocking so the UI is up immediately;
  // the chain is still the authority for every displayed balance regardless of this.
  if (openCount > 0) {
    console.log(`  reconciling ${openCount} open tx record(s) against chain…`);
    reconcileAll()
      .then((r) => console.log(`  reconcile: checked ${r.checked}, resolved ${r.resolved}; ${txlog.pendingOrUnknown().length} still open`))
      .catch((e) => console.error("  reconcile failed:", e.message));
  }
});
