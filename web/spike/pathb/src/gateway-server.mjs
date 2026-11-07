// The agent-facing surface: a tiny local HTTP API in front of the BudgetGateway. The agent calls these;
// it never sees the wallet key or the gRPC. Keep this bound to localhost and reachable ONLY by the agent.
//
//   POST /pay    { "merchant": "<address>", "amount": "<µT>", "memo"?: "<string>" }
//                -> 200 { ok:true, txId, amount }  |  402 { ok:false, code, reason }
//   GET  /status -> 200 { perTxCap, dailyCap, windowSpent, dailyRemaining, total, totalSpent, ... }
//
// Env:
//   WALLET_GRPC   gRPC address of the headless minotari wallet (default 127.0.0.1:18143)
//   GATEWAY_PORT  HTTP port for this API (default 8799)
//   QUOTA_JSON    path to a JSON quota file { total, perTxCap, dailyCap, windowMs, whitelist[], paymentType? }
import http from "node:http";
import { readFileSync } from "node:fs";
import { BudgetGateway, loadWalletClient } from "./gateway.mjs";

export function createGatewayServer(gateway) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === "GET" && req.url === "/status") return send(200, gateway.status());
      if (req.method === "POST" && req.url === "/pay") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { merchant, amount, memo } = JSON.parse(body || "{}");
        if (!merchant || amount == null) return send(400, { ok: false, code: "BAD_REQUEST", reason: "merchant and amount are required" });
        const result = await gateway.pay(merchant, amount, memo ?? "");
        return send(result.ok ? 200 : 402, result); // 402 Payment Required for a quota rejection
      }
      send(404, { ok: false, code: "NOT_FOUND", reason: "use POST /pay or GET /status" });
    } catch (e) {
      send(500, { ok: false, code: "SERVER_ERROR", reason: String(e?.message ?? e) });
    }
  });
}

// Run standalone against a REAL (or mock) wallet gRPC.
if (import.meta.url === `file://${process.argv[1]}`) {
  const quota = JSON.parse(readFileSync(process.env.QUOTA_JSON ?? new URL("./quota.example.json", import.meta.url), "utf8"));
  const wallet = loadWalletClient(process.env.WALLET_GRPC ?? "127.0.0.1:18143");
  const gateway = new BudgetGateway({ wallet, quota });
  const port = Number(process.env.GATEWAY_PORT ?? 8799);
  createGatewayServer(gateway).listen(port, "127.0.0.1", () =>
    console.log(`budget gateway on http://127.0.0.1:${port}  ->  wallet ${process.env.WALLET_GRPC ?? "127.0.0.1:18143"}`));
}
