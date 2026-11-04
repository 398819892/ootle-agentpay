//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * Small HTTP helpers shared by the dashboard routes: cookie parsing, JSON responses, typed errors,
 * amount coercion and the size-capped JSON body reader. No application state lives here.
 */
"use strict";

const { COOKIE_SECURE_ENV } = require("./settings");

function cookieIsSecure(req) {
  if (COOKIE_SECURE_ENV === "true") return true;
  if (COOKIE_SECURE_ENV === "false") return false;
  return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra); // policy flags the handlers forward (idempotencyConflict, …)
  return e;
}
// Base-unit amounts are integers that can exceed JS's safe-integer range (2^53). We carry them as
// decimal-integer STRINGS and do all arithmetic with BigInt, so a large amount never loses
// precision or stringifies in exponential form (which would corrupt the on-chain manifest).
function toAmount(v, label) {
  const s = String(v == null ? "" : v).trim();
  if (!/^\d+$/.test(s)) throw httpError(400, `Invalid ${label} (whole number only).`);
  return s;
}
/** Coerce a stored amount (string, or legacy number) to BigInt. */
function big(x) {
  if (typeof x === "bigint") return x;
  const s = String(x == null ? "0" : x).trim();
  return BigInt(/^-?\d+$/.test(s) ? s : "0");
}
/** max(0, a) for BigInt, as a decimal string. */
function clampStr(a) {
  return (a < 0n ? 0n : a).toString();
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

const MAX_BODY_BYTES = 1e6; // 1 MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      // Stop accepting data AND tear the socket down, so a client streaming a huge body can't keep
      // growing our memory after we've rejected (H2: a 300 MB stream to /api/login pushed RSS to
      // ~410 MB because the old code only rejected the promise and kept appending).
      req.destroy();
      reject(err);
    };
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) return fail(httpError(413, "payload too large"));
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      if (size === 0) return resolve({});
      // Collect Buffers and concat once, so a multi-byte UTF-8 char split across chunks is not
      // corrupted (the old `raw += c` string concat could mangle it).
      const raw = Buffer.concat(chunks, size).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, "invalid JSON body"));
      }
    });
    req.on("error", fail);
  });
}

module.exports = { cookieIsSecure, parseCookies, httpError, toAmount, big, clampStr, sendJson, MAX_BODY_BYTES, readBody };
