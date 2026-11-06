//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * billing_hook.js — the gateway→billing client. Proves: the no-op shape when disabled; correct internal
 * requests when enabled; and, above all, that it is FAIL-OPEN and non-throwing on any billing failure so
 * a billing outage can never block or crash a fund operation. Zero deps. Run: node server/billing_hook.test.js
 */
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");

const { createBillingHook, noopHook } = require("./billing_hook");

/** A mock billing service that records requests and replies per a scripted handler. */
function mockBilling(handler) {
  const reqs = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "null"); } catch { /* */ }
      reqs.push({ method: req.method, url: req.url, key: req.headers["x-internal-key"], body });
      handler(req, res, { body });
    });
  });
  return { server, reqs, listen: () => new Promise((r) => server.listen(0, "127.0.0.1", r)), port: () => server.address().port, close: () => server.close() };
}

test("disabled config → inert no-op hook", async () => {
  for (const cfg of [{ enabled: false }, { enabled: true, baseUrl: "", internalKey: "k", tenantId: "t" }, { enabled: true, baseUrl: "http://x", internalKey: "", tenantId: "t" }, { enabled: true, baseUrl: "http://x", internalKey: "k", tenantId: "" }]) {
    const h = createBillingHook(cfg);
    assert.equal(h.enabled, false);
    assert.deepEqual(await h.reportUsage({ chainComponent: "c", type: "pay" }), { skipped: true });
    assert.deepEqual(await h.checkQuota({ op: "create_budget" }), { allow: true, degraded: false, skipped: true });
    // The merged-dashboard surface is inert too: overview reports unconfigured, actions refuse clearly.
    assert.deepEqual(await h.tenantOverview(), { ok: false, configured: false });
    await assert.rejects(() => h.subscriptionCheckout({ planCode: "pro" }), (e) => e.code === "billing_unconfigured");
    await assert.rejects(() => h.subscriptionPortal(), (e) => e.code === "billing_unconfigured");
  }
  assert.equal(noopHook().enabled, false);
});

test("enabled: tenantOverview reads this tenant's subscription view", async () => {
  const mock = mockBilling((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tenant: { id: "tenant-1", name: "Acme" }, subscription: { status: "active", plan_code: "pro" }, plan: { code: "pro" }, plans: [], invoices: [] }));
  });
  await mock.listen();
  const h = createBillingHook({ enabled: true, baseUrl: `http://127.0.0.1:${mock.port()}`, internalKey: "k", tenantId: "tenant-1" });
  const d = await h.tenantOverview();
  assert.equal(d.ok, true);
  assert.equal(d.configured, true);
  assert.equal(d.subscription.plan_code, "pro");
  assert.equal(mock.reqs[0].method, "GET");
  assert.equal(mock.reqs[0].url, "/internal/tenant/overview?tenant_id=tenant-1");
  assert.equal(mock.reqs[0].key, "k");
  mock.close();
});

test("tenantOverview is non-fatal when billing is down (ok:false, configured:true)", async () => {
  const h = createBillingHook({ enabled: true, baseUrl: "http://127.0.0.1:1", internalKey: "k", tenantId: "t1", timeoutMs: 200 });
  const d = await h.tenantOverview();
  assert.equal(d.ok, false);
  assert.equal(d.configured, true);
});

test("enabled: subscriptionCheckout posts the plan + tenant and returns the URL; surfaces errors", async () => {
  const mock = mockBilling((req, res) => {
    if (req.url === "/internal/subscription/checkout") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ checkout_url: "https://stripe.test/c/sess_1" }));
    }
    res.writeHead(200); res.end(JSON.stringify({ portal_url: "https://stripe.test/p/1" }));
  });
  await mock.listen();
  const h = createBillingHook({ enabled: true, baseUrl: `http://127.0.0.1:${mock.port()}`, internalKey: "k", tenantId: "tenant-1" });
  const out = await h.subscriptionCheckout({ planCode: "pro", userEmail: "a@b.c" });
  assert.equal(out.checkout_url, "https://stripe.test/c/sess_1");
  assert.equal(mock.reqs[0].body.tenant_id, "tenant-1");
  assert.equal(mock.reqs[0].body.plan_code, "pro");
  assert.equal(mock.reqs[0].body.user_email, "a@b.c");
  const portal = await h.subscriptionPortal();
  assert.equal(portal.portal_url, "https://stripe.test/p/1");
  mock.close();
});

test("subscriptionCheckout throws a shaped error on a billing 4xx", async () => {
  const mock = mockBilling((req, res) => { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { code: "plan_not_purchasable", message: "no price" } })); });
  await mock.listen();
  const h = createBillingHook({ enabled: true, baseUrl: `http://127.0.0.1:${mock.port()}`, internalKey: "k", tenantId: "t1" });
  await assert.rejects(() => h.subscriptionCheckout({ planCode: "pro" }), (e) => e.code === "plan_not_purchasable" && e.status === 400);
  mock.close();
});

test("enabled: reportUsage posts the right body + internal key", async () => {
  const mock = mockBilling((req, res) => { res.writeHead(201, { "Content-Type": "application/json" }); res.end(JSON.stringify({ inserted: true, budget_id: "b1" })); });
  await mock.listen();
  const h = createBillingHook({ enabled: true, baseUrl: `http://127.0.0.1:${mock.port()}`, internalKey: "secret", tenantId: "tenant-1" });

  const out = await h.reportUsage({ chainComponent: "component_" + "a".repeat(64), type: "pay", amount: 500, txId: "tx1" });
  assert.equal(out.ok, true);
  assert.equal(out.inserted, true);
  assert.equal(mock.reqs.length, 1);
  assert.equal(mock.reqs[0].url, "/internal/usage");
  assert.equal(mock.reqs[0].key, "secret");
  assert.equal(mock.reqs[0].body.tenant_id, "tenant-1");
  assert.equal(mock.reqs[0].body.type, "pay");
  assert.equal(mock.reqs[0].body.amount, "500");
  mock.close();
});

test("enabled: bindBudget and checkQuota parse the service response", async () => {
  const mock = mockBilling((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.startsWith("/internal/quota/check")) return res.end(JSON.stringify({ allow: false, reason: "quota_exceeded", upgradeTo: "starter" }));
    return res.end(JSON.stringify({ budget_id: "bud-9" }));
  });
  await mock.listen();
  const h = createBillingHook({ enabled: true, baseUrl: `http://127.0.0.1:${mock.port()}`, internalKey: "k", tenantId: "t1" });

  const bind = await h.bindBudget({ chainComponent: "component_x", label: "bot" });
  assert.equal(bind.ok, true);
  assert.equal(bind.budgetId, "bud-9");

  const q = await h.checkQuota({ op: "create_budget" });
  assert.equal(q.allow, false);
  assert.equal(q.reason, "quota_exceeded");
  assert.equal(q.degraded, false);
  mock.close();
});

test("FAIL-OPEN: a 500 from billing → checkQuota allows (degraded), reportUsage non-fatal", async () => {
  const mock = mockBilling((req, res) => { res.writeHead(500); res.end("boom"); });
  await mock.listen();
  const h = createBillingHook({ enabled: true, baseUrl: `http://127.0.0.1:${mock.port()}`, internalKey: "k", tenantId: "t1" });

  const q = await h.checkQuota({ op: "create_budget" });
  assert.equal(q.allow, true);
  assert.equal(q.degraded, true);

  const u = await h.reportUsage({ chainComponent: "c", type: "pay", amount: "1", txId: "tx" });
  assert.equal(u.ok, false); // recorded as failed, but did NOT throw
  mock.close();
});

test("FAIL-OPEN: an unreachable billing service never throws", async () => {
  // Nothing listening on this port.
  const h = createBillingHook({ enabled: true, baseUrl: "http://127.0.0.1:1", internalKey: "k", tenantId: "t1", timeoutMs: 300 });
  const q = await h.checkQuota({ op: "create_budget" });
  assert.equal(q.allow, true);
  assert.equal(q.degraded, true);
  const u = await h.reportUsage({ chainComponent: "c", type: "pay", amount: "1", txId: "tx" });
  assert.equal(u.ok, false);
});

test("FAIL-OPEN: a slow billing service times out without blocking", async () => {
  const mock = mockBilling(() => { /* never responds */ });
  await mock.listen();
  const h = createBillingHook({ enabled: true, baseUrl: `http://127.0.0.1:${mock.port()}`, internalKey: "k", tenantId: "t1", timeoutMs: 250 });
  const started = Date.now();
  const u = await h.reportUsage({ chainComponent: "c", type: "pay", amount: "1", txId: "tx" });
  assert.equal(u.ok, false);
  assert.ok(Date.now() - started < 2000, "should give up near the timeout, not hang");
  mock.close();
});
