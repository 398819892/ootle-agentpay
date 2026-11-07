import { defineConfig } from "vite";
import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// The 0.47 swarm walletd sends NO CORS headers (verified: a preflight gets 200 with no
// access-control-allow-origin), so a browser cannot call it directly. Dev-only workaround: proxy
// `/walletd` through vite. The real fix is walletd's own `--enable-vite-dev-port <port>` flag
// (permissive CORS) or WebRTC (`--enable-webrtc`); see docs/wallet-integration.md. The indexer
// (:12008) does send `access-control-allow-origin: *`, so reads and submits go straight to it.
// Tapplet embedding: Tari Universe loads a tapplet INSIDE a cross-origin iframe, so the page must
// permit being framed by the wallet. `frame-ancestors` lists who may embed us — the hosted wallet
// (universe.tari.mw) plus the local wallet origins used when developing (a locally-run Universe, or
// our mock-wallet.html stand-in at :5173). CSP `frame-ancestors` only works as a RESPONSE HEADER
// (a <meta> tag is ignored for it), so it's set here on both the dev server and `vite preview`.
const FRAME_ANCESTORS =
  "frame-ancestors 'self' https://universe.tari.mw http://localhost:5173 http://127.0.0.1:5173";
const tappletHeaders = { "Content-Security-Policy": FRAME_ANCESTORS };

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  build: {
    rollupOptions: {
      // Two entries: the combined A/B/C demo (index.html) and the standalone tapplet page
      // (tapplet/index.html), so `vite build` emits dist/tapplet/index.html for the dev/registry tapplet.
      input: {
        main: resolve(__dirname, "index.html"),
        tapplet: resolve(__dirname, "tapplet/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: tappletHeaders,
    proxy: {
      "/walletd": {
        target: process.env.WALLETD_ORIGIN ?? "http://127.0.0.1:12010",
        changeOrigin: true,
        rewrite: () => "/json_rpc",
      },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
    headers: tappletHeaders,
  },
});
