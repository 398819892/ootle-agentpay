//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * Per-IP login throttle / lockout, and the trusted-proxy policy that decides which address counts
 * as the client (X-Forwarded-For is only honoured per `trustedProxy`). In-memory, per process.
 */
"use strict";

function createLoginThrottle({ trustedProxy: TRUSTED_PROXY, maxFails: LOGIN_MAX_FAILS, lockMs: LOGIN_LOCK_MS }) {
  const loginFails = new Map(); // ip -> { fails, lockUntil }
  function normalizeIp(ip) {
    // Strip the IPv4-mapped-IPv6 prefix so "::ffff:1.2.3.4" and "1.2.3.4" compare equal.
    return String(ip || "").replace(/^::ffff:/i, "").trim();
  }
  const TRUSTED_PROXY_IPS =
    TRUSTED_PROXY && TRUSTED_PROXY.toLowerCase() !== "true" && TRUSTED_PROXY.toLowerCase() !== "false"
      ? new Set(TRUSTED_PROXY.split(",").map((s) => normalizeIp(s)).filter(Boolean))
      : null;
  /**
   * The client IP used for rate-limiting / lockout. Trusts X-Forwarded-For ONLY per TRUSTED_PROXY, so
   * a forged XFF cannot be used to evade the per-IP throttle on a directly-exposed deployment.
   */
  function clientIp(req) {
    const peer = normalizeIp(req.socket && req.socket.remoteAddress);
    const mode = TRUSTED_PROXY.toLowerCase();
    if (!TRUSTED_PROXY || mode === "false") return peer || "?"; // default: ignore XFF entirely
    const xff = req.headers["x-forwarded-for"];
    if (!xff) return peer || "?";
    const chain = String(xff).split(",").map((s) => normalizeIp(s)).filter(Boolean);
    // Single trusted hop: our proxy APPENDS the real client to any client-supplied XFF
    // (nginx `$proxy_add_x_forwarded_for`, Caddy), so the RIGHT-most entry is the address the proxy
    // actually observed. Taking the left-most would let a client forge its own entry and so choose its
    // rate-limit/lockout key — evading the throttle, or locking out a victim's IP. (N-2)
    if (mode === "true") return chain[chain.length - 1] || peer || "?";
    // IP-list mode: only honour XFF when the direct peer is a configured proxy, then walk right-to-left
    // past any further trusted proxies to the first address we did not place there ourselves.
    if (TRUSTED_PROXY_IPS && TRUSTED_PROXY_IPS.has(peer)) {
      for (let i = chain.length - 1; i >= 0; i--) {
        if (!TRUSTED_PROXY_IPS.has(chain[i])) return chain[i];
      }
    }
    return peer || "?";
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
  return { clientIp, normalizeIp, loginLocked, noteLoginFail, noteLoginOk, trustedProxyIps: TRUSTED_PROXY_IPS };
}

module.exports = { createLoginThrottle };
