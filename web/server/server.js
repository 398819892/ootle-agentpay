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
const HOST = process.env.HOST || "0.0.0.0"; // bound wide so the Windows browser can reach WSL
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
    if (p && typeof p.exp === "number" && Date.now() < p.exp) return p;
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

// Simple per-IP throttle on failed logins.
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 8;
const LOGIN_LOCK_MS = (Number(process.env.LOGIN_LOCK_MINUTES) || 10) * 60 * 1000;
const loginFails = new Map(); // ip -> { fails, lockUntil }
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  return (xff ? String(xff).split(",")[0].trim() : req.socket.remoteAddress) || "?";
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
function issueConfirmToken(op) {
  const payload = { op, exp: Date.now() + CONFIRM_TTL_MS, n: crypto.randomBytes(12).toString("hex") };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", SESSION_SECRET).update("confirm." + body).digest("base64url");
  return `${body}.${mac}`;
}
function verifyConfirmToken(token, op) {
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
  pruneConfirmNonces();
  if (usedConfirmNonces.has(p.n)) return false; // already spent
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
async function resolveMerchant(nameOrAddr) {
  const c = await walletd();
  const raw = String(nameOrAddr || "").trim();
  if (!raw) throw httpError(400, "A merchant name or component address is required.");
  if (raw.startsWith("component_")) return raw; // already an address
  const key = raw.toLowerCase();
  if (store.merchants[key]) return store.merchants[key];
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
  // Layout (see docs/custody.md §state-model): [vault, agentBadgeRes, ownerBadgeRes,
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

/**
 * Run a fund-moving op exactly once per idempotency key, journaling its full lifecycle:
 *   pending (persisted before submit) → confirmed | rejected | unknown.
 * `submitFn` performs the chain call (an OnChainBudget method) and returns the finalized result;
 * it sets `wd.lastTxId` as a side effect. Returns { outcome, record, res, replay }.
 */
async function runChainOp(key, opName, component, params, submitFn) {
  const prior = txlog.get(key);
  if (prior) {
    if (prior.status === "confirmed") return { outcome: "confirmed", record: prior, replay: true };
    if (prior.status === "rejected") throw httpError(422, prior.reason || "Previously rejected.");
    // pending / unknown — try to settle it before considering a resubmit.
    const settled = await reconcileRecord(prior);
    if (settled.status === "confirmed") return { outcome: "confirmed", record: settled, replay: true };
    if (settled.status === "rejected") throw httpError(422, settled.reason || "Previously rejected.");
    // Still unresolved on chain: do NOT resubmit (that would double-spend). Report it as unknown.
    return { outcome: "unknown", record: settled, replay: true };
  }

  txlog.begin({ key, op: opName, params, component }); // persist pending BEFORE the chain submit (throws on fail)
  let res;
  try {
    res = await submitFn();
  } catch (e) {
    const txId = (wd && wd.lastTxId) || (e && e.txId) || null;
    if (e && e.pending) {
      // Submitted, but not confirmed within the window → UNKNOWN (never success). Reconciled later.
      const record = txlog.settle(key, { status: "unknown", txId, reason: "submitted; not confirmed within the window" });
      return { outcome: "unknown", record };
    }
    // Finalized reject (or a submit fault): record and surface the chain's reason.
    txlog.settle(key, { status: "rejected", txId, reason: chainMessage(e) });
    throw e;
  }
  const txId = (wd && wd.lastTxId) || null;
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
      const key = idemKey(body, "pay:" + invoiceId);
      let r;
      try {
        r = await runChainOp(key, "pay", b.component, { merchant, amount, invoiceId }, () =>
          b.payInvoice({ merchant, invoiceId, amount, agentTag }),
        );
      } catch (e) {
        // Surface the chain's own reason as a friendly 422, distinct from a server fault.
        throw httpError(422, chainMessage(e));
      }
      ctx.meta.txId = (r.record && r.record.txId) || invoiceId;
      ctx.meta.params = { merchant, amount, invoiceId };
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
      if (!/^[A-Za-z0-9 _-]{1,48}$/.test(session)) {
        throw httpError(400, "Use letters, numbers, spaces, hyphens or underscores (max 48).");
      }
      if ((b.sessions || []).includes(session)) throw httpError(400, "That session label already exists.");
      const key = idemKey(body, "issueSession:" + session);
      let r;
      try {
        r = await runChainOp(key, "issueSession", b.component, { session }, () => b.issueAgentBadge(session));
      } catch (e) {
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
  freeze: {
    tier: TIERS.ADMIN,
    highRisk: true,
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
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
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
  let urlPath = decodeURIComponent((req.url.split("?")[0] || "/"));
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) reject(httpError(413, "payload too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  if (!urlPath.startsWith("/api/")) return serveStatic(req, res);

  const key = `${req.method} ${urlPath}`;

  // --- public auth endpoints (no session required) -----------------------------------------
  if (key === "GET /api/session") {
    return sendJson(res, 200, {
      authRequired: AUTH_ON,
      authed: isAuthed(req),
      stepUpRequired: STEP_UP_ON,
      frozen: Boolean(store.frozen),
    });
  }
  if (key === "POST /api/logout") {
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
      const sid = crypto.randomUUID();
      setSessionCookie(req, res, signSession({ exp: Date.now() + SESSION_TTL_MS, sid }), SESSION_TTL_MS);
      audit.append({ actor: `op:${sid.slice(0, 8)}`, sid, ip, op: "login", tier: "auth", status: "ok" });
      return sendJson(res, 200, { authed: true });
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
    return sendJson(res, 200, { stepUp: true, token: issueConfirmToken(op) });
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
    if (e.confirmRequired) {
      payload.confirmRequired = true;
      payload.op = e.op;
    }
    sendJson(res, status, payload);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  AgentPay dashboard`);
  console.log(`  ├─ UI      http://localhost:${PORT}`);
  console.log(`  ├─ walletd ${WALLETD_URL}`);
  console.log(`  ├─ owner   ${OWNER}`);
  console.log(`  ├─ auth    ${AUTH_ON ? "ON (DASHBOARD_PASSWORD set)" : "OFF — local dev mode, do NOT expose"}`);
  console.log(`  ├─ step-up ${STEP_UP_ON ? "ON — high-risk actions need a fresh confirmation" : "OFF (no password set)"}`);
  console.log(`  ├─ frozen  ${store.frozen ? "YES — fund-moving actions are blocked" : "no"}`);
  console.log(`  ├─ audit   ${audit.file}`);
  if (AUTH_ON && !process.env.SESSION_SECRET) {
    console.log("  │          note: SESSION_SECRET unset — using an ephemeral secret (sessions reset on restart)");
  }
  if (AUTH_ON && !process.env.AGENTPAY_ADMIN_PASSWORD) {
    console.log("  │          note: AGENTPAY_ADMIN_PASSWORD unset — step-up reuses DASHBOARD_PASSWORD (set a distinct one to separate operate vs. move-funds)");
  }
  // Secret hygiene: a deployment that shipped the .env.example placeholders is not safe. Warn loudly
  // (we never print the secret itself).
  if (AUTH_ON && /change-me/i.test(DASHBOARD_PASSWORD)) {
    console.log("  │          ⚠ DASHBOARD_PASSWORD looks like the .env.example placeholder — set a long random value!");
  }
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
