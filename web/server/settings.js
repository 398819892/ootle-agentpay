//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * Dashboard backend configuration: every env / shared-config knob in ONE place, so the custody
 * boundary can be audited by reading this file. Precedence for chain/identity values:
 * AGENTPAY_* env var -> agentpay.config.json -> defaults.json -> the literal fallback here.
 */
"use strict";

const path = require("node:path");
const crypto = require("node:crypto");

/**
 * Read a numeric env var, or REFUSE TO START with a clear, variable-named error if it is set to
 * something non-numeric or out of range. The old `Number(process.env.X || def)` idiom let a typo like
 * `AGENTPAY_FINALIZE_TRIES=4o` through as `NaN`, which then silently poisons every loop / timeout that
 * uses it (a `for (i<NaN)` never runs → a real submit is recorded `unknown` without ever waiting). A
 * misconfigured money daemon must fail loudly at boot, not mis-behave in flight. An unset or empty var
 * uses `def`; `0` is honoured (unlike `Number(x) || def`) unless it violates `min`. (P2 — NaN config)
 */
function numEnv(name, def, { min, max, integer = false } = {}) {
  const rawVal = process.env[name];
  if (rawVal === undefined) return def;
  const raw = String(rawVal).trim();
  // An empty / whitespace-only value is "unset" → default. (Note `Number("   ")` is 0, not NaN, in
  // JS, so a whitespace var would otherwise sneak through as 0 rather than using the default.)
  if (raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid config: ${name}=${JSON.stringify(raw)} is not a number`);
  }
  if (integer && !Number.isInteger(n)) {
    throw new Error(`Invalid config: ${name}=${JSON.stringify(raw)} must be an integer`);
  }
  if (min !== undefined && n < min) {
    throw new Error(`Invalid config: ${name}=${n} must be >= ${min}`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`Invalid config: ${name}=${n} must be <= ${max}`);
  }
  return n;
}

// ---- configuration (env, defaults = local swarm) ---------------------------------------------
const PORT = numEnv("PORT", 8787, { min: 1, max: 65535, integer: true });
// Bind to LOOPBACK by default. A custodial wallet UI must not be reachable from the network unless
// the operator deliberately exposes it (behind TLS / a reverse proxy). To listen on all interfaces,
// set HOST=0.0.0.0 EXPLICITLY — and then put HTTPS in front of it (see docs/security.md). On WSL2,
// Windows' localhost forwarding still reaches a 127.0.0.1-bound server in WSL, so the default needs
// no override for local dev (verified: Windows `localhost:8787` → WSL `127.0.0.1`).
const HOST = process.env.HOST || "127.0.0.1";
// Chain/identity config resolves through the shared source (agentpay.config.json), so the wallet
// daemon URL / budget template / owner account are configured ONCE and shared with the MCP server
// and the SDK. Precedence: AGENTPAY_* env var -> agentpay.config.json -> defaults.json -> the literal
// fallback here. (defaults.json stays the single source of truth for a republished local template.)
const sharedConfig = require("./config");
const WALLETD_URL = sharedConfig.get("walletd_url", { default: "http://127.0.0.1:12010/json_rpc" });
const BUDGET_TEMPLATE = sharedConfig.get("budget_template", {
  templateName: "agent_budget",
  default: "template_978113ef1251cf83cff05ca21057eefcaa2ebaa7770abf07ba82d6ffda0e453f",
});
const OWNER = sharedConfig.get("owner_account", { default: "default" });
// Network name (preset selector). Surfaced to the dashboard's Connect panel so it can emit a block
// that targets the right network; the shared source resolves it (env > agentpay.config.json > local).
const NETWORK = sharedConfig.get("network", { default: "local" });
// Display ticker for the native token, surfaced to the dashboard. Defaults to the testnet tTARI;
// set AGENTPAY_TOKEN_SYMBOL (e.g. "TARI") — or AGENTPAY_NETWORK=mainnet — for mainnet, so going live
// is a config change, not a code edit. Display-only; the on-chain manifest keyword is unaffected.
const TOKEN_SYMBOL =
  process.env.AGENTPAY_TOKEN_SYMBOL ||
  (String(process.env.AGENTPAY_NETWORK || "").toLowerCase() === "mainnet" ? "TARI" : "tTARI");

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
// Overridable so a container can point it at a mounted volume for persistence.
const STATE_FILE = process.env.AGENTPAY_STATE_FILE || path.resolve(__dirname, "state.json");

// Confirmation budget: how long a money op waits for its tx to finalize before it is recorded as
// `unknown` (submitted, not yet confirmed) and handed to the reconciler. Kept modest so the UI
// stays responsive; a tx that misses the window is NEVER counted as success — it is settled later
// by its tx id. Tune via env (set TRIES very low to exercise the unknown path on purpose).
const FINALIZE_TRIES = numEnv("AGENTPAY_FINALIZE_TRIES", 40, { min: 1, integer: true });
const FINALIZE_DELAY_MS = numEnv("AGENTPAY_FINALIZE_DELAY_MS", 1500, { min: 0 });

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
// API key -> on-chain session. Each /api/v1 key maps to its own agent session badge (`key-<id>`,
// see apikeys.js). Once an admin has issued that badge (POST /api/v1/keys/:id/session) the key's
// payments prove it, so `revoke_session` on chain cuts off that one key. Until then a key pays
// through the budget's "default" session — UNLESS this is on (the default), in which case a key
// without an issued session is refused (403) instead of silently falling back to the shared session.
// Set AGENTPAY_REQUIRE_KEY_SESSIONS=false to restore the old permissive fallback. (S-7)
const REQUIRE_KEY_SESSIONS = process.env.AGENTPAY_REQUIRE_KEY_SESSIONS !== "false";
// Secret for signing the session cookie. Provide SESSION_SECRET in production so sessions survive
// restarts and are stable across replicas; otherwise we mint an ephemeral one per process.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = numEnv("SESSION_TTL_HOURS", 12, { min: 1 }) * 3600 * 1000;
const COOKIE_NAME = "ap_session";
// Set COOKIE_SECURE=true behind HTTPS to force the Secure flag; otherwise it is inferred from the
// X-Forwarded-Proto a TLS-terminating proxy sets (so cookies still work on plain-http localhost).
const COOKIE_SECURE_ENV = process.env.COOKIE_SECURE; // "true" | "false" | undefined

// ---- web-security boundary (CSRF / origin / trusted proxy) -----------------------------------
// Trusted-proxy policy for deriving the real client IP used by the login/operation throttles. The
// X-Forwarded-For header is client-controlled, so we do NOT trust it by default — an attacker could
// otherwise rotate a fake XFF to dodge the per-IP lockout. Values:
//   unset/"false" → never trust XFF; use the direct socket peer (correct for a directly-exposed box)
//   "true"        → trust a single appending proxy in front of us; take the RIGHT-most XFF entry (the
//                   address our proxy actually observed — nginx/Caddy append it). Taking the left-most
//                   would let a client forge its own entry and choose its throttle key (N-2).
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

// Host allowlist — defence against DNS rebinding. The Origin/Referer check (csrf.js) proves a POST's
// Origin matches the request's OWN Host header, but a Host header is attacker-influenceable: a page on
// evil.example whose DNS has been rebound to 127.0.0.1 sends a SELF-CONSISTENT Host: evil.example +
// Origin: http://evil.example that would pass. Pinning the Host to a known set closes that: the browser
// is the confused deputy, but it can only reach us under a name we accept. Loopback names are always
// allowed (the dev case); the bound address and any configured origins are folded in; AGENTPAY_ALLOWED_HOSTS
// adds the public hostname(s) a network deployment is served under. Compared on hostname only (no port).
function hostnameOf(hostHeader) {
  const h = String(hostHeader || "").trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]") === -1 ? undefined : h.indexOf("]")); // [::1]:port → ::1
  const i = h.lastIndexOf(":");
  // Strip a trailing :port, but leave a bare IPv6 literal (which has several colons and no brackets) intact.
  return i !== -1 && h.indexOf(":") === i ? h.slice(0, i) : h;
}
const ALLOWED_HOSTS = (() => {
  const set = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  for (const o of ALLOWED_ORIGINS) { try { set.add(new URL(o).hostname.toLowerCase()); } catch { /* ignore */ } }
  for (const h of String(process.env.AGENTPAY_ALLOWED_HOSTS || "").split(",").map((s) => hostnameOf(s)).filter(Boolean)) set.add(h);
  if (HOST && HOST !== "0.0.0.0" && HOST !== "::") set.add(hostnameOf(HOST));
  return set;
})();
// Enforce the Host allowlist only when we can actually enumerate the valid hosts: always on a loopback
// bind (the DNS-rebinding-exposed dev case), and whenever the operator configured an origin/host list.
// A network-exposed deployment that set neither can be served under a hostname we cannot guess, so we
// fall back to not enforcing there (a startup note nudges the operator) — its password + CSRF token
// still stand. Set AGENTPAY_ALLOWED_HOSTS to turn enforcement on for such a deployment.
const _hostLoopback = ["127.0.0.1", "::1", "localhost", ""].includes(String(HOST).trim().toLowerCase());
const HOST_CHECK_ON =
  _hostLoopback || ALLOWED_ORIGINS.length > 0 || String(process.env.AGENTPAY_ALLOWED_HOSTS || "").trim() !== "";

// ---- hardening config (custody boundary) ----------------------------------------------------
// High-risk owner actions (withdraw, revoke, change whitelist, mint/revoke an agent badge, reset,
// freeze/unfreeze) require a SECOND confirmation that is independent of the login session: the
// operator re-presents a secret and gets a short-lived, single-use token bound to that one action.
// This is enabled whenever auth is on. Locally (no password) there is no secret to step up with, so
// the extra gate is off and the dev experience is unchanged. A distinct AGENTPAY_ADMIN_PASSWORD can
// be set so that holding a read/operate session is not the same as being able to move funds.
const ADMIN_PASSWORD = process.env.AGENTPAY_ADMIN_PASSWORD || DASHBOARD_PASSWORD;
const STEP_UP_ON = AUTH_ON;
const CONFIRM_TTL_MS = numEnv("CONFIRM_TTL_SECONDS", 120, { min: 1 }) * 1000;


// Simple per-IP throttle on failed logins (see throttle.js).
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 8;
const LOGIN_LOCK_MS = (Number(process.env.LOGIN_LOCK_MINUTES) || 10) * 60 * 1000;

module.exports = {
  PORT, HOST, WALLETD_URL, BUDGET_TEMPLATE, OWNER, NETWORK, TOKEN_SYMBOL, PUBLIC_DIR, STATE_FILE,
  FINALIZE_TRIES, FINALIZE_DELAY_MS, DASHBOARD_PASSWORD, AUTH_ON, AUTO_CREATE_MERCHANTS, REQUIRE_KEY_SESSIONS,
  SESSION_SECRET, SESSION_TTL_MS, COOKIE_NAME, COOKIE_SECURE_ENV, TRUSTED_PROXY, ALLOWED_ORIGINS,
  ALLOWED_HOSTS, HOST_CHECK_ON, hostnameOf,
  ADMIN_PASSWORD, STEP_UP_ON, CONFIRM_TTL_MS, LOGIN_MAX_FAILS, LOGIN_LOCK_MS,
  numEnv,
};
