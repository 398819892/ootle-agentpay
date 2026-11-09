// Regression tests for the dApp <-> wallet relay added on 2026-11-09 (the bridge that connects the
// :8787 dashboard, a dApp, to the :7777 non-custodial wallet). NO chain, NO engine, NO key: the relay
// is pure, so these run anywhere node does.
//
//   1) state machine  (src/dapp-bridge.mjs)          — enqueue/poll/resolve/getResult/unlink/linkedOrigin/CORS
//   2) end-to-end HTTP — the REAL tari-provider.js (window.tari) driving the REAL bridge.handle over a
//      real http server, with a fetch loop playing the wallet: connect links, pay passes through
//      committed / declined / error, exactly as the dashboard widget relies on.
//
// Run (from web/spike):  node --test node/dapp-bridge.test.mjs      (needs node >= 18 for global fetch)
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createDappBridge } from "../src/dapp-bridge.mjs";

// ---------------------------------------------------------------------------------------------------
// 1) state machine — no HTTP
// ---------------------------------------------------------------------------------------------------
test("enqueue returns incrementing ids starting at 1", () => {
  const b = createDappBridge({ dappOrigins: ["http://localhost:8787"] });
  assert.equal(b.enqueue({ method: "tari_requestAccounts", origin: "http://localhost:8787" }), 1);
  assert.equal(b.enqueue({ method: "tari_signAndSubmitTransaction", origin: "http://localhost:8787" }), 2);
});

test("poll drains only unclaimed requests and claims them", () => {
  const b = createDappBridge();
  b.enqueue({ method: "a", params: { x: 1 }, origin: "o1" });
  b.enqueue({ method: "b", origin: "o2" });
  const first = b.poll();
  assert.deepEqual(first.map((r) => r.method), ["a", "b"]);
  assert.deepEqual(first[0], { id: 1, method: "a", params: { x: 1 }, origin: "o1" });
  assert.deepEqual(b.poll(), []); // already claimed — a second drain gets nothing
  b.enqueue({ method: "c", origin: "o3" }); // a new one still appears
  assert.deepEqual(b.poll().map((r) => r.method), ["c"]);
});

test("getResult is not-done until resolve, then carries result", () => {
  const b = createDappBridge();
  const id = b.enqueue({ method: "tari_signAndSubmitTransaction", origin: "o" });
  assert.deepEqual(b.getResult(id), { done: false });
  b.resolve({ id, result: { committed: true, txid: "tx_abc" } });
  assert.deepEqual(b.getResult(id), { done: true, result: { committed: true, txid: "tx_abc" }, error: undefined });
});

test("resolve removes the request from the queue so it is never re-delivered", () => {
  const b = createDappBridge();
  const id = b.enqueue({ method: "tari_signAndSubmitTransaction", origin: "o" });
  b.poll();                       // wallet drained it
  b.resolve({ id, result: { ok: 1 } });
  b.enqueue({ method: "x", origin: "o" });
  assert.deepEqual(b.poll().map((r) => r.id), [2]); // only the new one, resolved id 1 is gone
});

test("linkedOrigin is set ONLY by an approved tari_requestAccounts connect", () => {
  const b = createDappBridge();
  // a pay resolve must never link the site
  const pay = b.enqueue({ method: "tari_signAndSubmitTransaction", origin: "http://evil.example" });
  b.resolve({ id: pay, result: { committed: true } });
  assert.equal(b.linkedOrigin, null);
  // a connect that errored (user rejected) must not link either
  const rej = b.enqueue({ method: "tari_requestAccounts", origin: "http://dapp.example" });
  b.resolve({ id: rej, error: "user rejected" });
  assert.equal(b.linkedOrigin, null);
  // an approved connect links exactly its origin
  const ok = b.enqueue({ method: "tari_requestAccounts", origin: "http://dapp.example" });
  b.resolve({ id: ok, result: ["component_abc"] });
  assert.equal(b.linkedOrigin, "http://dapp.example");
});

test("unlink clears the connected site", () => {
  const b = createDappBridge();
  const id = b.enqueue({ method: "tari_requestAccounts", origin: "http://dapp.example" });
  b.resolve({ id, result: ["component_abc"] });
  assert.equal(b.linkedOrigin, "http://dapp.example");
  b.unlink();
  assert.equal(b.linkedOrigin, null);
});

test("corsHeadersFor allows listed origins only", () => {
  const b = createDappBridge({ dappOrigins: ["http://127.0.0.1:8787", "http://localhost:8787"] });
  assert.equal(b.corsHeadersFor("http://localhost:8787")["access-control-allow-origin"], "http://localhost:8787");
  assert.equal(b.corsHeadersFor("http://evil.example"), null);
  assert.equal(b.corsHeadersFor(undefined), null);
});

test("dappOrigins accepts a comma string (env form) or an array", () => {
  assert.deepEqual(createDappBridge({ dappOrigins: "http://a,http://b" }).dappOrigins, ["http://a", "http://b"]);
  assert.deepEqual(createDappBridge({ dappOrigins: ["http://a"] }).dappOrigins, ["http://a"]);
  // default when unset
  assert.deepEqual(createDappBridge().dappOrigins, ["http://127.0.0.1:8787", "http://localhost:8787"]);
});

// ---------------------------------------------------------------------------------------------------
// 2) end-to-end: the real tari-provider.js (window.tari) over real HTTP against bridge.handle
// ---------------------------------------------------------------------------------------------------

// The provider is an IIFE that binds its wallet origin once (from document.currentScript) and assigns
// window.tari on load. Node's ESM loader won't re-evaluate it per test (a ?query bust doesn't force a
// re-run), so we load it EXACTLY ONCE against a single shared relay server and reuse it. node:test runs
// top-level tests sequentially, so sharing the bridge/provider across the e2e cases is safe.
let shared = null;
async function ensureShared() {
  if (shared) return shared;
  const bridge = createDappBridge({ dappOrigins: ["http://localhost:8787"] });
  const server = http.createServer((req, res) => {
    if (new URL(req.url, "http://x").pathname.startsWith("/bridge/")) return void bridge.handle(req, res);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Minimal browser globals the provider IIFE touches, pointing it at `base` as the wallet origin.
  globalThis.Event = class { constructor(type) { this.type = type; } };
  globalThis.CustomEvent = class extends globalThis.Event { constructor(type, o) { super(type); this.detail = o && o.detail; } };
  globalThis.location = { search: "" };
  globalThis.window = { tari: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, open() { return null; } };
  globalThis.document = { currentScript: { getAttribute: (k) => (k === "data-wallet-origin" ? base : "/wallet.html") } };
  await import("../tari-provider.js"); // runs the IIFE; it assigns window.tari bound to `base`
  const tari = globalThis.window.tari;
  assert.ok(tari, "provider failed to define window.tari");
  shared = { bridge, server, base, tari };
  return shared;
}
after(() => { if (shared) shared.server.close(); });

// Play the wallet: poll the relay until a request shows up, then resolve it with `answer(req)`.
function walletResponder(bridge, answer) {
  let stop = false;
  (async function loop() {
    while (!stop) {
      for (const r of bridge.poll()) {
        const a = answer(r);
        bridge.resolve({ id: r.id, result: a.result, error: a.error });
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  return () => { stop = true; };
}

// A fresh per-test relay server (no provider) for the raw-HTTP CORS check.
async function withServer(fn) {
  const bridge = createDappBridge({ dappOrigins: ["http://localhost:8787"] });
  const server = http.createServer((req, res) => {
    if (new URL(req.url, "http://x").pathname.startsWith("/bridge/")) return void bridge.handle(req, res);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ bridge, base }); } finally { server.close(); }
}

test("e2e: provider.connect() round-trips the account the wallet approves", async () => {
  const { bridge, tari } = await ensureShared();
  const stop = walletResponder(bridge, (r) =>
    r.method === "tari_requestAccounts" ? { result: ["component_owner1"] } : { error: "unexpected " + r.method }
  );
  try {
    const accts = await tari.connect();
    assert.deepEqual(accts, ["component_owner1"]);
    assert.equal(tari.account, "component_owner1");
    assert.equal(tari.connected, true);
  } finally { stop(); }
});

test("e2e: a committed pay passes through unchanged to the dApp", async () => {
  const { bridge, tari } = await ensureShared();
  const receipt = { committed: true, amount: 700, spent: 700, txid: "tx_deadbeef", events: ["AgentBudget.pay"] };
  const stop = walletResponder(bridge, () => ({ result: receipt }));
  try {
    const r = await tari.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 700 } } });
    assert.deepEqual(r, receipt);
  } finally { stop(); }
});

test("e2e: an over-cap decline is delivered as a non-committed result, not an error", async () => {
  const { bridge, tari } = await ensureShared();
  const declined = { committed: false, amount: 5000, reason: "Amount exceeds the per-transaction cap" };
  const stop = walletResponder(bridge, () => ({ result: declined }));
  try {
    const r = await tari.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 5000 } } });
    assert.equal(r.committed, false);
    assert.match(r.reason, /per-transaction cap/);
  } finally { stop(); }
});

test("e2e: a wallet error rejects the dApp promise", async () => {
  const { bridge, tari } = await ensureShared();
  const stop = walletResponder(bridge, () => ({ error: "user rejected in wallet" }));
  try {
    await assert.rejects(
      () => tari.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: 1 } } }),
      /user rejected in wallet/
    );
  } finally { stop(); }
});

test("e2e: CORS preflight is granted to a listed dApp origin and withheld from others", async () => {
  await withServer(async ({ base }) => {
    const ok = await fetch(base + "/bridge/req", { method: "OPTIONS", headers: { Origin: "http://localhost:8787" } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:8787");
    const no = await fetch(base + "/bridge/req", { method: "OPTIONS", headers: { Origin: "http://evil.example" } });
    assert.equal(no.status, 204);
    assert.equal(no.headers.get("access-control-allow-origin"), null);
  });
});
