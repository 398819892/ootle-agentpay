// dapp-bridge.mjs — the WalletConnect-style relay between a dApp (another origin, no key) and the
// wallet (this origin, holds the key). Extracted verbatim from wallet-server.mjs so the relay can be
// exercised on its own, with NO chain, NO engine and NO key: the dApp can only ENQUEUE a request, the
// wallet drains it, approves + signs elsewhere, and posts the answer back here.
//
// The dApp side (tari-provider.js) sees:
//   POST /bridge/req      {method, params}      -> { id }            enqueue a request
//   GET  /bridge/res?id=  -> { done, result?, error? }               poll for the wallet's answer
// The wallet side (same origin, the wallet page) sees:
//   GET  /bridge/poll     -> { reqs: [{id, method, params, origin}] } drain not-yet-claimed requests
//   POST /bridge/resolve  {id, result?, error?}  -> { ok:true }       post the answer
//   POST /bridge/unlink   -> { ok:true }                              revoke the connected site
//
// CORS is granted to the dApp origin(s) for the /bridge/* queue ONLY — /api/* gets NO CORS, so a
// cross-origin dApp physically cannot call the signing endpoints; it can only queue here.
//
// `createDappBridge({ dappOrigins })` returns both the raw state machine (enqueue / poll / resolve /
// getResult / unlink / linkedOrigin — unit-testable with no HTTP) and `handle(req, res)`, which routes
// a /bridge/* request exactly as wallet-server.mjs used to inline.

import { randomBytes } from "node:crypto";

const readBody = (req) =>
  new Promise((r) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try { r(JSON.parse(d || "{}")); } catch { r({}); }
    });
  });
const send = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

export function createDappBridge({ dappOrigins, maxPending = 64, resultTtlMs = 5 * 60_000, sessionToken } = {}) {
  const DAPP_ORIGINS = Array.isArray(dappOrigins)
    ? dappOrigins
    : (dappOrigins || "http://127.0.0.1:8787,http://localhost:8787").split(",");

  // A per-process pairing secret the same-origin wallet page fetches from GET /bridge/session and then
  // sends (x-wallet-token) on the wallet-only routes. It stops a CROSS-ORIGIN page from forging an answer
  // via a no-preflight POST /bridge/resolve (CORS hides the response body but not the side effect). It does
  // NOT stop a local non-browser process, which can read /bridge/session the same way the wallet page does
  // — that is inherent to a loopback service and is out of this layer's scope.
  const SESSION_TOKEN = sessionToken || randomBytes(24).toString("hex");

  // `linkedOrigin` is the connected dApp site, kept HERE (not just in the wallet page) so the link
  // survives a wallet reload — like a real wallet's "connected sites". `meta` lets resolve() tell a
  // connect apart from a pay by the original request's method.
  const bridge = { q: [], res: {}, seq: 0, meta: {}, linkedOrigin: null };

  // ---- state machine (no HTTP) -------------------------------------------------------------------
  function enqueue({ method, params, origin = "(unknown)" }) {
    const id = ++bridge.seq;
    bridge.q.push({ id, method, params, origin, claimed: false });
    bridge.meta[id] = { origin, method };
    return id;
  }
  function poll() {
    const out = bridge.q.filter((e) => !e.claimed);
    out.forEach((e) => { e.claimed = true; });
    return out.map((e) => ({ id: e.id, method: e.method, params: e.params, origin: e.origin }));
  }
  // Results are swept after `resultTtlMs` so a dApp that never reads its answer can't grow bridge.res
  // without bound (each answer carries the ts it was resolved at). A live dApp polls within seconds.
  function sweepResults() {
    const cutoff = Date.now() - resultTtlMs;
    for (const [id, r] of Object.entries(bridge.res)) if (r.ts <= cutoff) delete bridge.res[id];
  }
  function resolve({ id, result, error }) {
    bridge.res[id] = { result, error, ts: Date.now() };
    bridge.q = bridge.q.filter((e) => e.id !== id);
    const m = bridge.meta[id]; // a connect the user approved links the site
    if (m && m.method === "tari_requestAccounts" && !error && result) bridge.linkedOrigin = m.origin;
    delete bridge.meta[id];
    sweepResults();
  }
  function getResult(id) {
    sweepResults();
    const r = bridge.res[id];
    return r ? { done: true, result: r.result, error: r.error } : { done: false };
  }
  function unlink() { bridge.linkedOrigin = null; }

  // ---- HTTP glue ---------------------------------------------------------------------------------
  function corsHeadersFor(origin) {
    if (origin && DAPP_ORIGINS.includes(origin)) {
      return {
        "access-control-allow-origin": origin,
        vary: "origin",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      };
    }
    return null;
  }
  function cors(req, res) {
    const h = corsHeadersFor(req.headers.origin);
    if (h) for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
  }

  // Route a /bridge/* request. Returns true once it has answered (always, for any /bridge/* path).
  // Origin policy lives HERE (not in enqueue, which stays a pure primitive the tests drive directly):
  //  - a cross-origin dApp request always carries an Origin; if present it MUST be allow-listed, and once
  //    a site is linked only THAT site may enqueue (a connect may still come from elsewhere to re-link).
  //  - an absent Origin is a same-origin / non-browser caller; a pairing token (added separately) is what
  //    will guard the wallet-only routes, so this slice intentionally does not reject absent-Origin enqueues.
  // CORS is sent ONLY on the dApp-facing routes (/bridge/req, /bridge/res); the wallet-only routes
  // (poll/resolve/unlink) are same-origin and never get CORS, so their payloads can't be read cross-origin.
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const origin = req.headers.origin;
    const dappFacing = path === "/bridge/req" || path === "/bridge/res";
    if (dappFacing || req.method === "OPTIONS") cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
    if (req.method === "POST" && path === "/bridge/req") {               // dApp -> enqueue
      const p = await readBody(req);
      if (!p.method) { send(res, 400, { error: "method required" }); return true; }
      if (origin && !DAPP_ORIGINS.includes(origin)) { send(res, 403, { error: "origin not allowed" }); return true; }
      if (origin && bridge.linkedOrigin && origin !== bridge.linkedOrigin && p.method !== "tari_requestAccounts") {
        send(res, 403, { error: "another site is connected to this wallet" }); return true;
      }
      if (bridge.q.length >= maxPending) { send(res, 429, { error: "too many pending requests" }); return true; }
      const id = enqueue({ method: p.method, params: p.params, origin });
      send(res, 200, { id });
      return true;
    }
    if (req.method === "GET" && path === "/bridge/res") {                // dApp -> poll for answer
      send(res, 200, getResult(Number(url.searchParams.get("id"))));
      return true;
    }
    // GET /bridge/session: hand the SAME-ORIGIN wallet page its pairing token. A same-origin GET sends no
    // Origin header; a cross-origin page's fetch carries one (and CORS would hide the body anyway) -> 403.
    if (req.method === "GET" && path === "/bridge/session") {            // wallet (same origin) -> pairing token
      if (origin) { send(res, 403, { error: "forbidden" }); return true; }
      send(res, 200, { token: SESSION_TOKEN, linkedOrigin: bridge.linkedOrigin });
      return true;
    }
    // The wallet-only routes below mutate the relay (drain the queue, post an answer, revoke the link), so
    // each needs the pairing token — a cross-origin page can't read it, so it can't forge these calls.
    if (path === "/bridge/poll" || path === "/bridge/resolve" || path === "/bridge/unlink") {
      if ((req.headers["x-wallet-token"] || url.searchParams.get("token")) !== SESSION_TOKEN) {
        send(res, 401, { error: "bad or missing wallet token" }); return true;
      }
    }
    if (req.method === "GET" && path === "/bridge/poll") {               // wallet -> drain new requests
      send(res, 200, { reqs: poll() });
      return true;
    }
    if (req.method === "POST" && path === "/bridge/resolve") {           // wallet -> post the answer
      const p = await readBody(req);
      resolve({ id: p.id, result: p.result, error: p.error });
      send(res, 200, { ok: true });
      return true;
    }
    if (req.method === "POST" && path === "/bridge/unlink") {            // wallet -> revoke the connected site
      unlink();
      send(res, 200, { ok: true });
      return true;
    }
    send(res, 404, { error: "unknown bridge route" });
    return true;
  }

  return {
    enqueue, poll, resolve, getResult, unlink,
    get linkedOrigin() { return bridge.linkedOrigin; },
    sessionToken: SESSION_TOKEN,
    corsHeadersFor, cors, handle, dappOrigins: DAPP_ORIGINS,
  };
}
