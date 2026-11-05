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
 *
 * Layout — this file is the wiring and the HTTP routes; everything else lives in its own module:
 *   settings.js                                   every env / shared-config knob
 *   http_util.js static.js security_headers.js    HTTP helpers, SPA static files, response headers
 *   session.js csrf.js throttle.js stepup.js      the browser-facing web-security layer
 *   store.js                                      persisted reference/config store (not money)
 *   chain_conn.js merchants.js chain_reads.js     walletd connection + mutex, merchant resolution,
 *                                                 chain-authoritative reads + journal history
 *   chain_ops.js                                  idempotent op runner + reconciler (tx lifecycle)
 *   dashboard.js ops.js key_sessions.js           dashboard projection, the OPS registry, key sessions
 *   api_v1.js                                     the machine-to-machine /api/v1 surface
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
const { paramFingerprint, conflicts: fpConflicts } = require("./idempotency");
// Configuration and the web-security building blocks each live in their own module (see headers).
const {
  PORT, HOST, WALLETD_URL, BUDGET_TEMPLATE, OWNER, NETWORK, TOKEN_SYMBOL, PUBLIC_DIR, STATE_FILE,
  FINALIZE_TRIES, FINALIZE_DELAY_MS, DASHBOARD_PASSWORD, AUTH_ON, AUTO_CREATE_MERCHANTS, REQUIRE_KEY_SESSIONS,
  SESSION_SECRET, SESSION_TTL_MS, COOKIE_NAME, TRUSTED_PROXY, ALLOWED_ORIGINS, ADMIN_PASSWORD, STEP_UP_ON,
  CONFIRM_TTL_MS, LOGIN_MAX_FAILS, LOGIN_LOCK_MS, ALLOWED_HOSTS, HOST_CHECK_ON, hostnameOf,
} = require("./settings");
const { httpError, toAmount, big, clampStr, sendJson, readBody, parseCookies } = require("./http_util");
const { applySecurityHeaders } = require("./security_headers");
const { createStaticServer } = require("./static");
const { createSessions } = require("./session");
const { createCsrf } = require("./csrf");
const { createLoginThrottle } = require("./throttle");
const { createStepUp } = require("./stepup");
const { createStore } = require("./store");
const { createChainConn } = require("./chain_conn");
const { createMerchants } = require("./merchants");
const { createChainReads } = require("./chain_reads");
const { createChainOps } = require("./chain_ops");
const { createDashboard } = require("./dashboard");
const { createKeySessions } = require("./key_sessions");
const { createOps } = require("./ops");
const { createApiV1 } = require("./api_v1");
const { createReceipts } = require("./receipts");

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
const { OnChainBudget, newInvoiceId, ChainError, windowStatus } = client;

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

// ---- web-security building blocks, wired to this process's config ----------------------------
const serveStatic = createStaticServer(PUBLIC_DIR);
// Stored copies of the MCP's payment-receipt images, so the web UI can list and download them (an
// inline MCP image has no "download" affordance). Kept next to the state file. Presentation only.
const receipts = createReceipts({ dir: path.join(path.dirname(STATE_FILE), "receipts") });
function serveReceipt(req, res, urlPath) {
  const m = /^\/receipt\/([0-9a-z]+-[0-9a-f]{8})\.png$/.exec(urlPath);
  const fp = m && receipts.filePath(m[1]);
  if (!fp) return sendJson(res, 404, { error: "no such receipt" });
  fs.readFile(fp, (err, data) => {
    if (err) return sendJson(res, 404, { error: "no such receipt" });
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="${m[1]}.png"`,
    });
    res.end(data);
  });
}
const { revokedSids, pruneRevokedSids, signSession, verifySession, isAuthed, passwordMatches, setSessionCookie, clearSessionCookie } =
  createSessions({ secret: SESSION_SECRET, cookieName: COOKIE_NAME, authOn: AUTH_ON, password: DASHBOARD_PASSWORD });
const { csrfTokenFor, csrfTokenOk, originAllowed, hasRequestBody, contentTypeIsJson } = createCsrf({
  secret: SESSION_SECRET,
  allowedOrigins: ALLOWED_ORIGINS,
  allowedHosts: ALLOWED_HOSTS,
  hostCheckOn: HOST_CHECK_ON,
  hostnameOf,
});
const { clientIp, loginLocked, noteLoginFail, noteLoginOk, trustedProxyIps: TRUSTED_PROXY_IPS } = createLoginThrottle({
  trustedProxy: TRUSTED_PROXY,
  maxFails: LOGIN_MAX_FAILS,
  lockMs: LOGIN_LOCK_MS,
});
// `store` is declared further down; the getter runs only at confirm/verify time, never at load.
const { adminPasswordMatches, issueConfirmToken, verifyConfirmToken } = createStepUp({
  secret: SESSION_SECRET,
  adminPassword: ADMIN_PASSWORD,
  ttlMs: CONFIRM_TTL_MS,
  currentComponent: () => (store.budget && store.budget.component) || null,
});
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

// ---- persisted reference/config store (NOT the authority for money — see store.js) -----------
const { store, saveStore, nameByAddr, snapshotBudget } = createStore({ stateFile: STATE_FILE, budgetTemplate: BUDGET_TEMPLATE, txlog });

// ---- machine-to-machine API keys (independent of the browser session) ------------------------
// The /api/v1 integration surface authenticates third-party / agent callers with a bearer API key
// instead of a login cookie. Keys come from env (AGENTPAY_API_KEYS="role:id:secret, …"); the surface
// is DISABLED unless at least one key is configured. See apikeys.js and docs/api.md.
const apiKeys = createApiKeys({ raw: process.env.AGENTPAY_API_KEYS || "", store, save: saveStore, audit });

// ---- chain access: lazy walletd connection + serial mutex, merchant resolution, chain reads, the
// idempotent op runner and the dashboard projection (each in its own module) --------------------
const { conn, walletd, serialize, chainMessage } = createChainConn({
  client,
  url: WALLETD_URL,
  finalizeTries: FINALIZE_TRIES,
  finalizeDelayMs: FINALIZE_DELAY_MS,
  owner: OWNER,
});
const { resolveMerchant, lookupMerchant } = createMerchants({
  store, saveStore, nameByAddr, walletd, autoCreate: AUTO_CREATE_MERCHANTS, ChainError,
});
const { liveBudget, readChainBudget, journalTotals, journalLedger, firstPayEvent, chainPayScan } = createChainReads({
  store, walletd, conn, txlog, OnChainBudget, windowStatus, budgetTemplate: BUDGET_TEMPLATE,
});
const { idemKey, reconcileRecord, runChainOp, reconcileAll } = createChainOps({
  store, saveStore, snapshotBudget, txlog, claims, claimWaitMs: CLAIM_WAIT_MS, walletd, conn, OnChainBudget,
  budgetTemplate: BUDGET_TEMPLATE, firstPayEvent, chainMessage,
});
const { dashboardState, pendingResult } = createDashboard({
  store, nameByAddr, apiKeys, conn, txlog, readChainBudget, journalTotals, journalLedger, chainPayScan,
  walletdUrl: WALLETD_URL, budgetTemplate: BUDGET_TEMPLATE, owner: OWNER, tokenSymbol: TOKEN_SYMBOL, network: NETWORK,
  stepUpOn: STEP_UP_ON,
});
const { keySessionInfo, keysWithSessions, keySession } = createKeySessions({
  apiKeys, store, requireKeySessions: REQUIRE_KEY_SESSIONS,
});

// ---- restricted operation registry (ops.js) + the single audited gate in front of it ----------
const OPS = createOps({
  store, saveStore, snapshotBudget, txlog, walletd, conn, OnChainBudget, newInvoiceId, TIERS,
  budgetTemplate: BUDGET_TEMPLATE, resolveMerchant, lookupMerchant, liveBudget, readChainBudget, runChainOp, idemKey,
  dashboardState, pendingResult, keySession, chainMessage,
});

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
  "POST /api/merchants/remove": (body, ctx) => authz.execute("removeMerchant", body, ctx),
  "POST /api/limits": (body, ctx) => authz.execute("setLimits", body, ctx),
  "POST /api/withdraw": (body, ctx) => authz.execute("withdraw", body, ctx),
  "POST /api/top-up": (body, ctx) => authz.execute("topUp", body, ctx),
  "POST /api/revoke": (body, ctx) => authz.execute("revoke", body, ctx),
  "POST /api/sessions": (body, ctx) => authz.execute("issueSession", body, ctx),
  "POST /api/sessions/revoke": (body, ctx) => authz.execute("revokeSession", body, ctx),
  // Low-risk UI/receipt preferences (no funds, no chain) — set directly on the store, not via the
  // authorizer. Currently just the receipt-image language, which the MCP reads back from /api/state.
  async "POST /api/settings"(body) {
    if (body && body.receiptLang !== undefined) {
      if (!["zh", "en", "both"].includes(body.receiptLang)) {
        throw httpError(400, "receiptLang must be 'zh', 'en' or 'both'.");
      }
      store.receiptLang = body.receiptLang;
      saveStore();
    }
    return await dashboardState();
  },

  // Receipt images: the MCP uploads the PNG it renders (base64) so the dashboard can list + serve it
  // for download; the web UI reads the list. Presentation only — never a money authority.
  "GET /api/receipts": () => ({ receipts: receipts.list() }),
  async "POST /api/receipts"(body) {
    const b64 = body && typeof body.png_base64 === "string" ? body.png_base64 : "";
    if (!b64) throw httpError(400, "png_base64 is required.");
    let png;
    try {
      png = Buffer.from(b64, "base64");
    } catch {
      throw httpError(400, "png_base64 is not valid base64.");
    }
    let entry;
    try {
      entry = receipts.save(body, png);
    } catch (e) {
      throw httpError(400, e.message || "could not store the receipt.");
    }
    return { url: entry.url, id: entry.id };
  },

  "POST /api/reset": (body, ctx) => authz.execute("resetLocal", body, ctx),
  "POST /api/freeze": (body, ctx) => authz.execute("freeze", body, ctx),
  "POST /api/unfreeze": (body, ctx) => authz.execute("unfreeze", body, ctx),
};

// ---- machine-to-machine integration API (/api/v1/*), API-key authenticated — see api_v1.js ----
const { V1, handleApiV1 } = createApiV1({
  OPS, authz, apiKeys, store, txlog, audit, nameByAddr, clientIp, serialize, reconcileRecord, dashboardState, chainMessage,
  issueConfirmToken, stepUpOn: STEP_UP_ON, newInvoiceId, publicDir: PUBLIC_DIR, keySessionInfo, keysWithSessions,
});

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
  // Stored receipt images are served from their own dir (not PUBLIC_DIR), by a strict id pattern.
  if (req.method === "GET" && urlPath.startsWith("/receipt/")) return serveReceipt(req, res, urlPath);
  if (!urlPath.startsWith("/api/")) return serveStatic(req, res);

  const key = `${req.method} ${urlPath}`;

  // --- CSRF / cross-origin defense for ALL state-changing requests -----------------------------
  // UNCONDITIONAL — not gated on AUTH_ON. On a no-password localhost dashboard the network position
  // itself is the ambient credential: any web page can `fetch("http://127.0.0.1:PORT/api/withdraw")`,
  // so "no cookie ⇒ nothing to abuse" is false. Two independent guards (N-11):
  //   1) Origin/Referer must be same-origin. A browser sends Origin on every cross-site POST (no-cors
  //      and <form> included), so a forged cross-site request is refused outright. A POST with no
  //      Origin/Referer (a non-browser client) is let through — it is not a CSRF vector.
  //   2) A POST that carries a body must be application/json (see contentTypeIsJson) — blocks the
  //      forgeable <form>/no-cors body vector even if an Origin header were somehow absent.
  // The CSRF *token* is additionally required when a session cookie is present (AUTH_ON). Login is
  // exempt from the token check (no session yet) but NOT from Origin/Content-Type. Reads (GET) are exempt.
  if (req.method === "POST") {
    if (!originAllowed(req)) {
      audit.append({ actor: "?", ip: clientIp(req), op: "request", tier: "auth", status: "denied", reason: "bad_origin" });
      return sendJson(res, 403, { error: "Cross-origin request refused." });
    }
    if (hasRequestBody(req) && !contentTypeIsJson(req)) {
      audit.append({ actor: "?", ip: clientIp(req), op: "request", tier: "auth", status: "denied", reason: "bad_content_type" });
      return sendJson(res, 415, { error: "Content-Type must be application/json." });
    }
    const session = AUTH_ON ? verifySession(parseCookies(req)[COOKIE_NAME]) : null;
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
    // #11: serialize only STATE-CHANGING ops (POST). The serial lock exists to keep fund ops one at a
    // time (and so the shared walletd client's `lastTxId` is unambiguous); a GET read never submits or touches
    // lastTxId, so queueing reads behind an in-flight tx — up to minutes on a slow confirm — only
    // stalls the dashboard for no safety benefit. Reads (GET) now run concurrently, outside the lock.
    const result =
      req.method === "GET"
        ? await handler(body, ctx, query)
        : await serialize(() => handler(body, ctx, query));
    sendJson(res, 200, result);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`${key} failed:`, e);
    // pass through policy flags so the client can react (frozen / rate-limited / confirm needed)
    const payload = { error: chainMessage(e) };
    if (e.frozen) payload.frozen = true;
    if (e.rateLimited) payload.rateLimited = true;
    if (e.idempotencyConflict) payload.idempotencyConflict = true;
    if (e.inflightDuplicate) payload.inflightDuplicate = true;
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

// Single-instance security state: the login/op throttle, the logout token-revocation list and the
// step-up confirm tokens all live in THIS process's memory, and the double-spend guard coordinates
// through a local claims dir — none of it is shared across replicas. Running several instances would
// silently weaken the per-IP lockout and rate limits and make logout non-global. Until a shared store
// exists, refuse to start when the operator has explicitly asked for multiple instances, rather than
// degrade those protections silently. See docs/security.md "Operational assumptions".
const MULTI_INSTANCE = /^(1|true|yes|on)$/i.test(String(process.env.AGENTPAY_MULTI_INSTANCE || ""));
if (MULTI_INSTANCE) {
  console.error(
    `\nRefusing to start: AGENTPAY_MULTI_INSTANCE is set, but this build keeps the rate limits, logout\n` +
      `revocation and step-up tokens IN-MEMORY (single-instance) and coordinates the double-spend guard\n` +
      `through a local claims dir — none of it is shared across replicas, so multiple instances weaken\n` +
      `those protections silently.\n` +
      `Fix: run a SINGLE instance, or put a shared session/rate store + a shared claims volume in front\n` +
      `first (and enforce rate limits at the proxy/WAF). See docs/security.md "Operational assumptions".\n`,
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
  console.log(`  ├─ csrf    ${AUTH_ON ? "ON — Origin check + X-CSRF-Token on every POST" : "Origin + JSON-only on every POST (no token: no auth)"}`);
  console.log(
    `  ├─ host    ${
      HOST_CHECK_ON
        ? `allowlist ON — Host must be one of [${[...ALLOWED_HOSTS].join(", ")}] (anti DNS-rebinding)`
        : "allowlist OFF — exposed bind with no AGENTPAY_ALLOWED_HOSTS; set it to pin the public hostname(s)"
    }`,
  );
  console.log(
    `  ├─ proxy   ${
      !TRUSTED_PROXY || TRUSTED_PROXY.toLowerCase() === "false"
        ? "direct (X-Forwarded-For ignored; client IP = socket peer)"
        : TRUSTED_PROXY.toLowerCase() === "true"
          ? "trusted (right-most X-Forwarded-For = client IP)"
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
  if (apiKeys.configured()) {
    console.log(
      `  ├─ key sessions ${
        REQUIRE_KEY_SESSIONS
          ? "REQUIRED — a key pays only through its own on-chain session badge (key-<id>)"
          : "optional — a key without an issued badge pays via the \"default\" session (AGENTPAY_REQUIRE_KEY_SESSIONS=true to forbid)"
      }`,
    );
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
