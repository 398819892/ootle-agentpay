import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// The 0.47 swarm walletd sends NO CORS headers (verified: a preflight gets 200 with no
// access-control-allow-origin), so a browser cannot call it directly. Dev-only workaround: proxy
// `/walletd` through vite. The real fix is walletd's own `--enable-vite-dev-port <port>` flag
// (permissive CORS) or WebRTC (`--enable-webrtc`); see docs/wallet-integration.md. The indexer
// (:12008) does send `access-control-allow-origin: *`, so reads and submits go straight to it.
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/walletd": {
        target: process.env.WALLETD_ORIGIN ?? "http://127.0.0.1:12010",
        changeOrigin: true,
        rewrite: () => "/json_rpc",
      },
    },
  },
});
