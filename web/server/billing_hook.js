//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * Billing integration hook (spec §11). A thin, fire-and-forget client from the fund-handling gateway to
 * the SEPARATE billing service's internal API (X-Internal-Key). It reports confirmed usage, binds newly
 * opened budgets to a tenant, and (optionally) checks plan quota before a budget is opened.
 *
 * SAFETY — this module must NEVER affect the money path:
 *   • It holds no keys and signs nothing; it only POSTs metering facts to the billing service.
 *   • Every reporting call swallows its own errors and resolves — a billing outage is logged, not thrown.
 *   • Callers invoke reportUsage/bindBudget WITHOUT awaiting, so billing latency never delays a payment.
 *   • checkQuota is FAIL-OPEN: any error, timeout, or non-200 resolves to { allow: true, degraded: true },
 *     so a billing outage can never block an on-chain operation.
 *   • When billing is not configured, createBillingHook returns an inert no-op with the identical shape,
 *     so the gateway behaves exactly as before and existing tests are unaffected.
 *
 * Zero runtime dependencies (Node built-ins only), matching the rest of web/server.
 */
"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

function noopHook() {
  return {
    enabled: false,
    reportUsage: async () => ({ skipped: true }),
    bindBudget: async () => ({ skipped: true }),
    checkQuota: async () => ({ allow: true, degraded: false, skipped: true }),
    tenantOverview: async () => ({ ok: false, configured: false }),
    subscriptionCheckout: async () => { throw Object.assign(new Error("Billing is not configured."), { code: "billing_unconfigured", status: 503 }); },
    subscriptionPortal: async () => { throw Object.assign(new Error("Billing is not configured."), { code: "billing_unconfigured", status: 503 }); },
  };
}

function createBillingHook({ enabled = false, baseUrl = "", internalKey = "", tenantId = "", timeoutMs = 2000, logger = console } = {}) {
  if (!enabled || !baseUrl || !internalKey || !tenantId) return noopHook();
  const base = String(baseUrl).replace(/\/+$/, "");
  const warn = (msg) => { try { (logger.warn || logger.log || (() => {}))(`[billing] ${msg}`); } catch { /* logging must never throw */ } };

  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(base + path); } catch (e) { return reject(e); }
      const data = body !== undefined ? JSON.stringify(body) : null;
      const mod = u.protocol === "https:" ? https : http;
      const headers = { "X-Internal-Key": internalKey, Accept: "application/json" };
      if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
      const req = mod.request({
        method, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, headers,
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { /* non-json */ }
          resolve({ status: res.statusCode, json });
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("billing request timed out"), { code: "ETIMEDOUT" })));
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /** Report a confirmed usage event. Fire-and-forget: resolves even on failure, never throws. */
  async function reportUsage({ chainComponent, type, amount, txId = null, occurredAt = null, tenantIdOverride = null }) {
    const tid = tenantIdOverride || tenantId;
    if (!chainComponent || !type || !tid) return { skipped: true };
    try {
      const r = await request("POST", "/internal/usage", {
        tenant_id: tid, chain_component: chainComponent, type,
        amount: amount != null ? String(amount) : undefined, tx_id: txId, occurred_at: occurredAt,
      });
      if (r.status >= 200 && r.status < 300) return { ok: true, inserted: r.json && r.json.inserted };
      warn(`reportUsage ${type} → HTTP ${r.status} (ignored)`);
      return { ok: false, status: r.status };
    } catch (e) {
      warn(`reportUsage ${type} failed: ${e.message} (ignored)`);
      return { ok: false, error: e.message };
    }
  }

  /** Bind a newly opened on-chain budget to the tenant. Fire-and-forget. */
  async function bindBudget({ chainComponent, label = null, tenantIdOverride = null }) {
    const tid = tenantIdOverride || tenantId;
    if (!chainComponent || !tid) return { skipped: true };
    try {
      const r = await request("POST", "/internal/budgets/bind", { tenant_id: tid, chain_component: chainComponent, label });
      if (r.status >= 200 && r.status < 300) return { ok: true, budgetId: r.json && r.json.budget_id };
      warn(`bindBudget → HTTP ${r.status} (ignored)`);
      return { ok: false, status: r.status };
    } catch (e) {
      warn(`bindBudget failed: ${e.message} (ignored)`);
      return { ok: false, error: e.message };
    }
  }

  /** Check plan quota before an op. FAIL-OPEN: any problem resolves to allow:true, degraded:true. */
  async function checkQuota({ op, tenantIdOverride = null }) {
    const tid = tenantIdOverride || tenantId;
    if (!tid || !op) return { allow: true, degraded: false };
    try {
      const r = await request("GET", `/internal/quota/check?tenant_id=${encodeURIComponent(tid)}&op=${encodeURIComponent(op)}`);
      if (r.status === 200 && r.json && typeof r.json.allow === "boolean") return { ...r.json, degraded: false };
      warn(`checkQuota ${op} → HTTP ${r.status} (failing open)`);
      return { allow: true, degraded: true };
    } catch (e) {
      warn(`checkQuota ${op} failed: ${e.message} (failing open)`);
      return { allow: true, degraded: true };
    }
  }

  /**
   * Read this gateway's own tenant subscription view for the dashboard "Subscription" panel.
   * Read-only and non-fatal: on any error (or billing down) resolves to { ok:false, configured:true }
   * so the dashboard can show "temporarily unavailable" without breaking the page.
   */
  async function tenantOverview() {
    try {
      const r = await request("GET", `/internal/tenant/overview?tenant_id=${encodeURIComponent(tenantId)}`);
      if (r.status === 200 && r.json) return { ok: true, configured: true, ...r.json };
      warn(`tenantOverview → HTTP ${r.status}`);
      return { ok: false, configured: true, status: r.status };
    } catch (e) {
      warn(`tenantOverview failed: ${e.message}`);
      return { ok: false, configured: true, error: e.message };
    }
  }

  /**
   * Start a Stripe Checkout for a plan change. Unlike the metering calls this is user-initiated and its
   * result (a redirect URL) matters, so it surfaces errors instead of swallowing them.
   */
  async function subscriptionCheckout({ planCode, userEmail = null } = {}) {
    const r = await request("POST", "/internal/subscription/checkout", { tenant_id: tenantId, plan_code: planCode, user_email: userEmail });
    if (r.status >= 200 && r.status < 300 && r.json) return r.json;
    const e = new Error((r.json && r.json.error && r.json.error.message) || `Billing returned HTTP ${r.status}.`);
    e.code = (r.json && r.json.error && r.json.error.code) || "billing_error";
    e.status = r.status >= 400 && r.status < 500 ? r.status : 502;
    throw e;
  }

  /** Open the Stripe billing portal for this tenant. User-initiated; surfaces errors. */
  async function subscriptionPortal() {
    const r = await request("POST", "/internal/subscription/portal", { tenant_id: tenantId });
    if (r.status >= 200 && r.status < 300 && r.json) return r.json;
    const e = new Error((r.json && r.json.error && r.json.error.message) || `Billing returned HTTP ${r.status}.`);
    e.code = (r.json && r.json.error && r.json.error.code) || "billing_error";
    e.status = r.status >= 400 && r.status < 500 ? r.status : 502;
    throw e;
  }

  return { enabled: true, reportUsage, bindBudget, checkQuota, tenantOverview, subscriptionCheckout, subscriptionPortal };
}

module.exports = { createBillingHook, noopHook };
