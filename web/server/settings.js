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

// ---- configuration (env, defaults = local swarm) ---------------------------------------------
const PORT = Number(process.env.PORT || 8787);
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


// Simple per-IP throttle on failed logins (see throttle.js).
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 8;
const LOGIN_LOCK_MS = (Number(process.env.LOGIN_LOCK_MINUTES) || 10) * 60 * 1000;

module.exports = {
  PORT, HOST, WALLETD_URL, BUDGET_TEMPLATE, OWNER, NETWORK, TOKEN_SYMBOL, PUBLIC_DIR, STATE_FILE,
  FINALIZE_TRIES, FINALIZE_DELAY_MS, DASHBOARD_PASSWORD, AUTH_ON, AUTO_CREATE_MERCHANTS, REQUIRE_KEY_SESSIONS,
  SESSION_SECRET, SESSION_TTL_MS, COOKIE_NAME, COOKIE_SECURE_ENV, TRUSTED_PROXY, ALLOWED_ORIGINS,
  ADMIN_PASSWORD, STEP_UP_ON, CONFIRM_TTL_MS, LOGIN_MAX_FAILS, LOGIN_LOCK_MS,
};
