// dapp-server.mjs — the dApp's OWN origin, deliberately separate from the wallet.
//
// It is a pure static file server: shop.html + tari-provider.js, nothing else. There is NO key here,
// NO /api/pay, NO signing of any kind. That is the whole point — a dApp on this origin can do nothing
// but call window.tari and ask the wallet (a different origin, :7777) to sign. The two are independent
// individuals; this process could not spend even if it wanted to.
//
//   GET /                 -> shop.html
//   GET /shop.html        -> shop.html
//   GET /tari-provider.js -> tari-provider.js
//
// Run (any node; no deps):  PORT=7788 node node/dapp-server.mjs
import http from "node:http";
import fs from "node:fs";

const PORT = parseInt(process.env.PORT) || 7788;
const ROUTES = {
  "/": ["../shop.html", "text/html; charset=utf-8"],
  "/shop.html": ["../shop.html", "text/html; charset=utf-8"],
  "/index.html": ["../shop.html", "text/html; charset=utf-8"],
  "/tari-provider.js": ["../tari-provider.js", "application/javascript; charset=utf-8"],
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const route = ROUTES[url.pathname];
    if (req.method === "GET" && route) {
      const f = new URL(route[0], import.meta.url);
      res.writeHead(200, { "content-type": route[1], "cache-control": "no-store" });
      return res.end(fs.readFileSync(f));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found — this dApp origin serves only shop.html and tari-provider.js (no keys, no signing)");
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e.message || e));
  }
});
server.listen(PORT, "0.0.0.0", () => console.log(`dapp-server (no keys) on http://127.0.0.1:${PORT}  -> wallet at :7777`));
