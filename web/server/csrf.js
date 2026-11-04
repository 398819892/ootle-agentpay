//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/** Cross-site request defenses: session-bound CSRF token, Origin/Referer check, JSON-only bodies. */
"use strict";

const crypto = require("node:crypto");

function createCsrf({ secret: SESSION_SECRET, allowedOrigins: ALLOWED_ORIGINS }) {
  // ---- CSRF (synchronizer token bound to the session) ------------------------------------------
  // A cookie-authenticated API is exposed to CSRF: a malicious page can make the browser POST with the
  // session cookie attached. We defend with TWO independent checks on every state-changing request
  // (enforced only when AUTH_ON — in open local-dev there is no ambient credential to abuse):
  //   1. Origin/Referer must match (below) — a cross-site POST is refused outright.
  //   2. a CSRF token derived from the session's sid must be presented in the X-CSRF-Token header.
  // The token is NOT a secret cookie (so it is immune to a sibling-subdomain cookie-injection), it is an
  // HMAC over the sid that only a holder of a valid session (who can also read it from /api/session or
  // the login response) can produce. A stolen *token* without the cookie is useless, and a stolen
  // *cookie* without the token (the CSRF case) is refused.
  function csrfTokenFor(sid) {
    return crypto.createHmac("sha256", SESSION_SECRET).update("csrf:" + String(sid)).digest("base64url");
  }
  function csrfTokenOk(req, sid) {
    if (!sid) return false;
    const sent = String(req.headers["x-csrf-token"] || "");
    const expected = csrfTokenFor(sid);
    const a = Buffer.from(sent);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---- Origin / Referer check ------------------------------------------------------------------
  // Browsers always send `Origin` on cross-origin POSTs (and modern ones on same-origin POSTs too), so a
  // cross-site forgery is caught here even before the CSRF token. A request with neither header is a
  // non-browser client (curl, server-to-server) which is not subject to ambient-cookie CSRF — it is
  // allowed through to the token/auth checks, which still apply.
  function hostMatches(urlStr, host) {
    try {
      const u = new URL(urlStr);
      if (ALLOWED_ORIGINS.includes((u.protocol + "//" + u.host).toLowerCase())) return true;
      return u.host.toLowerCase() === host; // host includes the port
    } catch {
      return false;
    }
  }
  function originAllowed(req) {
    const host = String(req.headers.host || "").toLowerCase();
    if (!host) return false;
    const origin = req.headers.origin;
    if (origin) return origin !== "null" && hostMatches(origin, host);
    const ref = req.headers.referer || req.headers.referrer;
    if (ref) return hostMatches(ref, host);
    return true; // no Origin/Referer: not a browser cross-site POST
  }
  // A request carries an entity body when it declares a non-zero Content-Length or a chunked encoding.
  function hasRequestBody(req) {
    return Number(req.headers["content-length"] || 0) > 0 || Boolean(req.headers["transfer-encoding"]);
  }
  // The body (if any) must be JSON. A cross-site <form> or a `no-cors` fetch can only send a "simple"
  // content type (text/plain / x-www-form-urlencoded / multipart) — never application/json without a
  // CORS preflight we never answer — so requiring JSON blocks the forgeable cross-site body vector. (N-11)
  function contentTypeIsJson(req) {
    return String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() === "application/json";
  }
  return { csrfTokenFor, csrfTokenOk, hostMatches, originAllowed, hasRequestBody, contentTypeIsJson };
}

module.exports = { createCsrf };
