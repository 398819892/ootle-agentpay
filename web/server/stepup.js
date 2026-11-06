//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * Step-up confirmation tokens for high-risk owner actions: short-lived, single-use, HMAC-bound to the
 * exact funding parameters AND the current budget component (`currentComponent()` is read lazily).
 */
"use strict";

const crypto = require("node:crypto");
const { stableStringify: idempotencyStableStringify } = require("./idempotency");

function createStepUp({ secret: SESSION_SECRET, adminPassword: ADMIN_PASSWORD, ttlMs: CONFIRM_TTL_MS, currentComponent }) {
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
  // The FUNDING PARAMETERS a confirm token is bound to. A step-up token must authorise one SPECIFIC
  // action, not just "some withdraw": the amount, the payee/session, the caps and the budget it targets.
  // We extract exactly those from the request body into a canonical shape and fold them into the token;
  // at execute time we recompute the shape from the ACTUAL op arguments and require an exact match. So a
  // token minted to confirm "withdraw 100" cannot be replayed to withdraw 900, or redirected to another
  // payee, or reused after the budget was reset (a new budget has a different component id). The budget
  // component acts as the budget/authorisation "version": reset→new budget ⇒ old tokens are void.
  function confirmParams(op, body) {
    const b = body || {};
    const s = (v) => (v == null ? null : String(v));
    const f = { op, component: currentComponent() };
    switch (op) {
      case "createBudget": // no component yet (null on both mint+verify); bind the funding + caps
        f.fund = s(b.fund);
        f.perTxCap = s(b.perTxCap);
        f.dailyCap = s(b.dailyCap);
        f.epochsPerWindow = s(b.epochsPerWindow);
        f.whitelist = Array.isArray(b.whitelist) ? b.whitelist.map(String).sort() : [];
        break;
      case "withdraw":
        f.amount = s(b.amount);
        break;
      case "addMerchant":
      case "removeMerchant":
        f.merchant = s(b.merchant);
        break;
      case "setLimits": // a token for caps (100, 300) must not confirm caps (100, 900)
        f.perTxCap = s(b.perTxCap);
        f.dailyCap = s(b.dailyCap);
        break;
      case "issueSession":
        f.session = s(b.session);
        // Non-custodial provisioning mints the badge into the agent's OWN account; bind it so a
        // confirmation for account A can't be replayed to issue to account B. Omitted ⇒ null on both
        // mint and verify, so the custodial path (mint to the budget's own agent account) is unchanged.
        f.toAccount = s(b.toAccount);
        break;
      case "revokeSession":
        f.session = s(b.session);
        break;
      // revoke / freeze / unfreeze / resetLocal carry no funding params: op + component is the binding.
      default:
        break;
    }
    return f;
  }
  /** HMAC digest of the funding parameters a token is bound to (stable key order via idempotency.js). */
  function confirmDigest(op, body) {
    return crypto
      .createHmac("sha256", SESSION_SECRET)
      .update("confirm-params." + idempotencyStableStringify(confirmParams(op, body)))
      .digest("base64url");
  }
  function issueConfirmToken(op, body) {
    const payload = {
      op,
      pd: confirmDigest(op, body), // bind the token to THIS action's funding parameters
      exp: Date.now() + CONFIRM_TTL_MS,
      n: crypto.randomBytes(12).toString("hex"),
    };
    const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mac = crypto.createHmac("sha256", SESSION_SECRET).update("confirm." + b).digest("base64url");
    return `${b}.${mac}`;
  }
  function verifyConfirmToken(token, op, args) {
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
    // Re-derive the funding-parameter digest from the ACTUAL op arguments and require it to match the
    // one bound into the token. A token minted for different parameters (amount, payee, caps, budget)
    // is rejected — this is what stops a confirmation being replayed against a different action.
    if (p.pd !== confirmDigest(op, args || {})) return false;
    pruneConfirmNonces();
    if (usedConfirmNonces.has(p.n)) return false; // already spent (single-use)
    usedConfirmNonces.set(p.n, p.exp);
    return true;
  }
  return { adminPasswordMatches, confirmParams, confirmDigest, issueConfirmToken, verifyConfirmToken };
}

module.exports = { createStepUp };
