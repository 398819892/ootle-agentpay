//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
"use strict";

const { cookieIsSecure } = require("./http_util");

// ---- security response headers ---------------------------------------------------------------
// Applied to EVERY response (static assets and API). The CSP is strict on scripts — `script-src
// 'self'`, no inline/eval — which this zero-dependency SPA satisfies (no inline <script>, no inline
// handlers, no eval; app.js and styles.css are same-origin files). Inline *style attributes* are used
// throughout the hand-written markup, so `style-src` permits 'unsafe-inline'; this does NOT enable
// script injection. Google Fonts are the only third-party origin (style + font). `frame-ancestors
// 'none'` + X-Frame-Options block clickjacking; `object-src`/`base-uri 'none'` close common injection
// vectors; `connect-src 'self'` keeps the SPA talking only to its own backend.
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
].join("; ");
function applySecurityHeaders(req, res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  // HSTS only when the connection is (or terminates as) HTTPS, so we never pin plain-http localhost.
  if (cookieIsSecure(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
}

module.exports = { applySecurityHeaders, CSP };
