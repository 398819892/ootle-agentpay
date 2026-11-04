//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { httpError, sendJson, readBody } = require("./http_util");

function createApiV1({
  OPS, authz, apiKeys, store, txlog, audit, nameByAddr, clientIp, serialize, reconcileRecord, dashboardState, chainMessage,
  issueConfirmToken, stepUpOn: STEP_UP_ON, newInvoiceId, publicDir: PUBLIC_DIR, keySessionInfo, keysWithSessions,
}) {
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
  //   • an `admin` key may additionally open a budget, add/remove merchants, change the caps and read
  //     the audit log.
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

  // --- per-key idempotency namespacing (S-2/S-3) ----------------------------------------------
  // The v1 journal key is namespaced by the CALLING API key, so the same Idempotency-Key value sent by
  // two different keys gets two independent journal entries instead of colliding — which would either
  // leak one key's receipt to the other or wrongly 409 a legitimate payment. The caller only ever sees
  // the raw Idempotency-Key it chose; the namespace is internal.
  const PAY_KEY_SEP = "\u0000"; // NUL: never valid in a caller-supplied Idempotency-Key
  function payKeyFor(keyId, rawId) {
    return `${keyId}${PAY_KEY_SEP}${rawId}`;
  }
  // How much of a caller's Idempotency-Key we keep, sized so the namespaced key stays within idemKey's
  // 128-char bound and so the split below is always lossless.
  function rawIdemLimit(keyId) {
    return Math.max(16, 128 - String(keyId).length - PAY_KEY_SEP.length);
  }
  // The public payment id = the caller's own raw Idempotency-Key (namespace stripped). Dashboard/owner
  // pays carry no namespace, so their key is returned unchanged.
  function publicPayId(recKey) {
    if (typeof recKey !== "string") return recKey;
    const i = recKey.indexOf(PAY_KEY_SEP);
    return i === -1 ? recKey : recKey.slice(i + 1);
  }
  // Does this journal record belong to the given API key? (Only namespaced pay records can.)
  function ownsPayRecord(rec, keyId) {
    return !!rec && typeof rec.key === "string" && rec.key.startsWith(`${keyId}${PAY_KEY_SEP}`);
  }

  /** Build a public payment receipt from a tx-journal record (status is chain-authoritative). */
  function receiptOf(rec) {
    if (!rec) return null;
    const names = nameByAddr();
    const p = rec.params || {};
    const ev = rec.event || null;
    const merchant = (ev && ev.merchant) || p.merchant || null;
    return {
      id: publicPayId(rec.key), // the caller's own Idempotency-Key is the stable payment id (namespace stripped)
      status: rec.status, // pending | confirmed | rejected | unknown
      txId: rec.txId || null,
      amount: ev && ev.amount != null ? String(ev.amount) : p.amount != null ? String(p.amount) : null,
      merchant,
      merchantName: merchant ? names[merchant] || null : null,
      memo: (ev && ev.memo) || p.memo || null,
      invoiceId: p.invoiceId || null,
      session: (ev && ev.session) || p.session || null, // which agent session badge paid (chain event first)
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
          "DELETE /api/v1/merchants/:name (admin) — remove a merchant from the ON-CHAIN whitelist",
          "POST   /api/v1/budgets         (admin) — open/fund a budget",
          "POST   /api/v1/budget/limits   (admin) — change the per-tx / daily caps on chain",
          "GET    /api/v1/audit           (admin) — recent audit entries",
          "GET    /api/v1/keys            (admin) — list API keys (id/role/revoked + on-chain session)",
          "POST   /api/v1/keys/:id/revoke (admin) — revoke an API key at runtime (server-side)",
          "POST   /api/v1/keys/:id/session        (admin) — issue the key's own on-chain session badge (key-<id>)",
          "POST   /api/v1/keys/:id/session/revoke (admin) — revoke that session ON CHAIN (validators refuse the key's pays)",
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
        // Payment id = the caller's Idempotency-Key, namespaced by the calling API key (S-2). A repeat
        // with the same key never re-submits to chain (txlog enforces it); a repeat with different
        // funding params is a hard conflict. The public receipt id strips the namespace (publicPayId).
        const rawId = idemHeader.slice(0, rawIdemLimit(who.id));
        const key = payKeyFor(who.id, rawId);
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
        // S-3: a key sees only the payments it made; an admin key keeps the full cross-key view.
        const isAdmin = who.role === apiKeys.ROLES.ADMIN;
        const payments = txlog
          .list()
          .filter((r) => r.op === "pay" && (isAdmin || ownsPayRecord(r, who.id)))
          .map(receiptOf);
        return sendJson(res, 200, { payments });
      }
      if (sub.startsWith("/payments/") && method === "GET") {
        const rawId = decodeURIComponent(sub.slice("/payments/".length));
        const isAdmin = who.role === apiKeys.ROLES.ADMIN;
        // S-3: look the record up WITHIN the caller's own namespace first, so one key cannot read
        // another key's receipt by guessing its Idempotency-Key. Admin keys may also resolve a raw or
        // namespaced key directly (cross-key observability).
        let rec = txlog.get(payKeyFor(who.id, rawId));
        if (!rec && isAdmin) rec = txlog.get(rawId);
        // This is the payments endpoint: only ever expose `pay` records. Looking a record up by its
        // idempotency key could otherwise return any op (e.g. a withdraw), leaking it on this route.
        if (rec && rec.op !== "pay") rec = null;
        if (!rec) {
          rec = txlog.list().find(
            (r) => r.op === "pay" && r.txId === rawId && (isAdmin || ownsPayRecord(r, who.id)),
          ) || null;
        }
        // Status tracking: advance an open record by settling it against chain (read-only get_result).
        if (rec && txlog.isOpen(rec.status) && rec.txId) {
          try {
            rec = await serialize(() => reconcileRecord(rec));
          } catch {
            /* leave it open; the caller can poll again */
          }
        }
        // Defence in depth: never hand back a record the caller does not own (unless admin).
        if (rec && !isAdmin && !ownsPayRecord(rec, who.id)) rec = null;
        if (!rec) return sendJson(res, 404, { error: "No payment with that id." });
        return sendJson(res, 200, { receipt: receiptOf(rec) });
      }

      // ---- budget ---------------------------------------------------------------------------------
      if (sub === "/budget" && method === "GET") {
        const st = await dashboardState(); // #11: read — no serial lock
        return sendJson(res, 200, { budget: v1Budget(st) });
      }
      if (sub === "/budgets" && method === "POST") {
        if (denyIfNotAdmin("createBudget")) return;
        await serialize(() => executeAsKey("createBudget", body, ctx));
        const st = await dashboardState();
        return sendJson(res, 201, { budget: v1Budget(st) });
      }
      if (sub === "/budget/limits" && method === "POST") {
        if (denyIfNotAdmin("setLimits")) return;
        const r = await serialize(() =>
          executeAsKey("setLimits", { perTxCap: body.perTxCap, dailyCap: body.dailyCap }, ctx),
        );
        const st = await dashboardState();
        // 200 once the chain confirmed; 202 when submitted but not yet confirmed (reconciled later).
        return sendJson(res, r && r.pending ? 202 : 200, {
          budget: v1Budget(st),
          ...(r && r.pending ? { pending: true, txId: r.txId || null, notice: r.notice } : {}),
        });
      }

      // ---- merchants (whitelist) ------------------------------------------------------------------
      if (sub === "/merchants" && method === "GET") {
        const st = await dashboardState(); // #11: read — no serial lock
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
        // The REAL on-chain removal: the owner badge signs the template's `remove_merchant`, so the
        // address stops being payable once the tx finalizes. Goes through the same authorizer / step-up
        // binding / idempotent journal as the dashboard. The local name→address alias is kept so the
        // merchant can be re-added by name later (it is only a label, not an authorization).
        if (denyIfNotAdmin("removeMerchant")) return;
        const merchant = decodeURIComponent(sub.slice("/merchants/".length)).trim();
        const r = await serialize(() => executeAsKey("removeMerchant", { merchant }, ctx));
        const st = await dashboardState();
        return sendJson(res, r && r.pending ? 202 : 200, {
          removed: (r && r.removed) || null,
          merchants: (st.budget && st.budget.whitelist) || [],
          ...(r && r.pending
            ? { pending: true, txId: r.txId || null, notice: r.notice }
            : { notice: "Removed from the on-chain whitelist via the owner badge; the agent can no longer pay this address." }),
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
        return sendJson(res, 200, { keys: keysWithSessions() });
      }
      // ---- API key -> on-chain session (one agent session badge per key) -------------------------
      // Issue: mints the badge `key-<id>` into the agent account via the owner badge (same high-risk
      // op + step-up/audit path as the dashboard's "issue session"); from then on that key's payments
      // prove this badge. Revoke: `revoke_session` on chain — the validators themselves refuse every
      // further pay from this key, independent of the server-side key revoke above. Both are idempotent.
      if (sub.startsWith("/keys/") && sub.endsWith("/session") && method === "POST") {
        if (denyIfNotAdmin("issueKeySession")) return;
        const id = decodeURIComponent(sub.slice("/keys/".length, -"/session".length));
        if (!apiKeys.has(id)) return sendJson(res, 404, { error: `No API key with id ${JSON.stringify(id)}.` });
        const session = apiKeys.sessionLabel(id);
        const before = keySessionInfo(store.budget, id);
        if (!store.budget) return sendJson(res, 409, { error: "No budget is open." });
        if (before.issued && !before.revoked) {
          return sendJson(res, 200, { id, session: before, issued: true, already: true });
        }
        // first badge = key-<id>; after an on-chain revoke the next generation (key-<id>.2, …) is minted
        const next = before.revoked ? apiKeys.sessionLabel(id, before.generation + 1) : session;
        const r = await serialize(() => executeAsKey("issueSession", { session: next }, ctx));
        return sendJson(res, r && r.pending ? 202 : 201, {
          id,
          session: keySessionInfo(store.budget, id),
          issued: !(r && r.pending),
          ...(r && r.pending ? { pending: true, txId: r.txId || null, notice: r.notice } : {}),
        });
      }
      if (sub.startsWith("/keys/") && sub.endsWith("/session/revoke") && method === "POST") {
        if (denyIfNotAdmin("revokeKeySession")) return;
        const id = decodeURIComponent(sub.slice("/keys/".length, -"/session/revoke".length));
        if (!apiKeys.has(id)) return sendJson(res, 404, { error: `No API key with id ${JSON.stringify(id)}.` });
        const session = apiKeys.sessionLabel(id);
        const before = keySessionInfo(store.budget, id);
        if (!store.budget) return sendJson(res, 409, { error: "No budget is open." });
        if (!before.issued) return sendJson(res, 404, { error: `API key ${JSON.stringify(id)} has no on-chain session to revoke.` });
        if (before.revoked) return sendJson(res, 200, { id, session: before, revoked: true, already: true });
        const r = await serialize(() => executeAsKey("revokeSession", { session }, ctx));
        return sendJson(res, r && r.pending ? 202 : 200, {
          id,
          session: keySessionInfo(store.budget, id),
          revoked: !(r && r.pending),
          ...(r && r.pending ? { pending: true, txId: r.txId || null, notice: r.notice } : {}),
        });
      }
      if (sub.startsWith("/keys/") && sub.endsWith("/revoke") && method === "POST") {
        if (denyIfNotAdmin("revokeApiKey")) return;
        const id = decodeURIComponent(sub.slice("/keys/".length, -"/revoke".length));
        const ok = apiKeys.revoke(id);
        if (!ok) return sendJson(res, 404, { error: `No API key with id ${JSON.stringify(id)}.` });
        return sendJson(res, 200, { id, revoked: true, keys: keysWithSessions() });
      }

      return sendJson(res, 404, { error: "Unknown API endpoint. GET /api/v1 lists the available ones." });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(`v1 ${method} ${sub} failed:`, e);
      const payload = { error: chainMessage(e) };
      if (e.frozen) payload.frozen = true;
      if (e.rateLimited) payload.rateLimited = true;
      if (e.idempotencyConflict) payload.idempotencyConflict = true;
      if (e.inflightDuplicate) payload.inflightDuplicate = true;
      if (e.auditUnavailable) payload.auditUnavailable = true;
      if (e.confirmRequired) payload.confirmRequired = true; // not expected for admin keys (token auto-minted)
      return sendJson(res, status, payload);
    }
  }

  return { V1, handleApiV1 };
}

module.exports = { createApiV1 };
