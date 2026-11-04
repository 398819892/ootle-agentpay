//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/** Static file server for the SPA under `publicDir`: path-confined, SPA fallback, revalidate-always. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function createStaticServer(PUBLIC_DIR) {
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
  };

  function serveStatic(req, res) {
    let urlPath;
    try {
      // A malformed percent-escape (e.g. GET /%E0%A4%A) makes decodeURIComponent throw URIError;
      // without this guard that throw became an unhandled rejection and killed the process (H1).
      urlPath = decodeURIComponent((req.url.split("?")[0] || "/"));
    } catch {
      res.writeHead(400);
      return res.end("bad request");
    }
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        // SPA fallback to index.html for unknown non-asset routes
        if (!path.extname(filePath)) {
          return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, idx) => {
            if (e2) {
              res.writeHead(404);
              return res.end("not found");
            }
            res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
            res.end(idx);
          });
        }
        res.writeHead(404);
        return res.end("not found");
      }
      // no-cache (revalidate every load): the UI is served straight from disk with no build/hash, so a
      // CSS/JS change must show on the next refresh instead of being masked by the browser's heuristic cache.
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
  }
  return serveStatic;
}

module.exports = { createStaticServer };
