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

export function createDappBridge({ dappOrigins } = {}) {
  const DAPP_ORIGINS = Array.isArray(dappOrigins)
    ? dappOrigins
    : (dappOrigins || "http://127.0.0.1:8787,http://localhost:8787").split(",");

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
  function resolve({ id, result, error }) {
    bridge.res[id] = { result, error };
    bridge.q = bridge.q.filter((e) => e.id !== id);
    const m = bridge.meta[id]; // a connect the user approved links the site
    if (m && m.method === "tari_requestAccounts" && !error && result) bridge.linkedOrigin = m.origin;
    delete bridge.meta[id];
  }
  function getResult(id) {
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
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
    if (req.method === "POST" && url.pathname === "/bridge/req") {        // dApp -> enqueue
      const p = await readBody(req);
      if (!p.method) { send(res, 400, { error: "method required" }); return true; }
      const id = enqueue({ method: p.method, params: p.params, origin: req.headers.origin });
      send(res, 200, { id });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/bridge/res") {         // dApp -> poll for answer
      send(res, 200, getResult(Number(url.searchParams.get("id"))));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/bridge/poll") {        // wallet -> drain new requests
      send(res, 200, { reqs: poll() });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/bridge/resolve") {    // wallet -> post the answer
      const p = await readBody(req);
      resolve({ id: p.id, result: p.result, error: p.error });
      send(res, 200, { ok: true });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/bridge/unlink") {     // wallet -> revoke the connected site
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
    corsHeadersFor, cors, handle, dappOrigins: DAPP_ORIGINS,
  };
}
