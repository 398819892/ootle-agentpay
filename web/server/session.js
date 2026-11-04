//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * Browser login sessions: stateless HMAC-signed cookies plus an in-memory revocation list so logout
 * really invalidates a token on this instance. With `authOn` false (no password) everyone is authed.
 */
"use strict";

const crypto = require("node:crypto");
const { parseCookies, cookieIsSecure } = require("./http_util");

function createSessions({ secret: SESSION_SECRET, cookieName: COOKIE_NAME, authOn: AUTH_ON, password: DASHBOARD_PASSWORD }) {
  // Server-side revocation of session ids. Sessions are stateless signed tokens, so a logout cannot
  // "unsign" a cookie; instead we remember the revoked sid until its own expiry and reject it here.
  // This genuinely invalidates a logged-out token ON THIS INSTANCE. NOTE: like the rate limiter this
  // is in-memory and per-process — it does not span replicas or survive a restart (see docs/security.md
  // "Operational assumptions"). Keep SESSION_TTL modest and front multi-instance deploys with a shared
  // session store if you need cross-replica revocation.
  const revokedSids = new Map(); // sid -> exp (ms)
  function pruneRevokedSids() {
    const now = Date.now();
    for (const [sid, exp] of revokedSids) if (exp <= now) revokedSids.delete(sid);
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
      if (p && typeof p.exp === "number" && Date.now() < p.exp) {
        if (p.sid && revokedSids.has(p.sid)) return null; // explicitly logged out on this instance
        return p;
      }
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
  return { revokedSids, pruneRevokedSids, signSession, verifySession, isAuthed, passwordMatches, setSessionCookie, clearSessionCookie };
}

module.exports = { createSessions };
