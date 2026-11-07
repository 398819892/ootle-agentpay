// Path B closed-loop harness — proves the 免确认 budget offline against a mock minotari gRPC wallet.
//
// Proves, with NO real wallet / funds / chain:
//   1. In-cap payments go straight through (gateway calls wallet.Transfer, no confirmation step exists).
//   2. Over-per-tx, over-daily, over-total, and non-whitelisted requests are REJECTED and NEVER reach the
//      wallet (the mock records every Transfer it got; rejected ones leave the count unchanged).
//   3. The rolling daily window resets with time (injected clock).
//   4. The same enforcement holds through the agent-facing HTTP API (POST /pay / GET /status).
//
// Run: node node/pathb-flow.mjs   (needs @grpc/grpc-js + @grpc/proto-loader installed)
import { startMockWallet } from "./mock-wallet-grpc.mjs";
import { BudgetGateway, loadWalletClient } from "../src/gateway.mjs";
import { createGatewayServer } from "../src/gateway-server.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS", m); } else { fail++; console.log("  FAIL", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

const MERCHANT = "merchant_good_address";
const OTHER = "merchant_not_whitelisted";

const mock = await startMockWallet();
const client = loadWalletClient(`127.0.0.1:${mock.port}`);

// injectable clock so we can test the rolling window deterministically
let now = 1_000_000;
const clock = () => now;

console.log("== 1. in-cap payments go through; over-quota never reach the wallet ==");
{
  const gw = new BudgetGateway({
    wallet: client, clock,
    quota: { total: 50_000, perTxCap: 1_000, dailyCap: 1_500, windowMs: 10_000, whitelist: [MERCHANT] },
  });

  const r1 = await gw.pay(MERCHANT, 700, "coffee");
  ok(r1.ok && r1.txId, "pay 700 in-cap -> sent, has txId");
  eq(mock.transfers.length, 1, "wallet received exactly 1 Transfer");
  eq(mock.transfers[0].address, MERCHANT, "Transfer went to the merchant");
  eq(mock.transfers[0].payment_type, "ONE_SIDED_TO_STEALTH_ADDRESS", "one-sided payment type used");
  eq(mock.transfers[0].amount, "700", "amount forwarded as µT string");

  const r2 = await gw.pay(MERCHANT, 700);
  ok(r2.ok, "pay 700 again in-cap (window 1400 <= 1500) -> sent");
  eq(mock.transfers.length, 2, "wallet received 2 Transfers");

  const r3 = await gw.pay(MERCHANT, 700);
  ok(!r3.ok && r3.code === "OVER_DAILY", "pay 700 (would be 2100) -> OVER_DAILY");
  eq(mock.transfers.length, 2, "OVER_DAILY did NOT reach the wallet (still 2)");

  const r4 = await gw.pay(MERCHANT, 5000);
  ok(!r4.ok && r4.code === "OVER_PER_TX", "pay 5000 -> OVER_PER_TX");
  eq(mock.transfers.length, 2, "OVER_PER_TX did NOT reach the wallet");

  const r5 = await gw.pay(OTHER, 100);
  ok(!r5.ok && r5.code === "NOT_WHITELISTED", "pay to non-whitelisted merchant -> NOT_WHITELISTED");
  eq(mock.transfers.length, 2, "NOT_WHITELISTED did NOT reach the wallet");

  const st = gw.status();
  eq(st.windowSpent, "1400", "status: windowSpent 1400");
  eq(st.totalSpent, "1400", "status: totalSpent 1400");

  console.log("== 2. rolling daily window resets with time ==");
  now += 10_001; // advance past windowMs
  const r6 = await gw.pay(MERCHANT, 900);
  ok(r6.ok, "after window elapses, pay 900 -> sent (daily window reset)");
  eq(gw.status().windowSpent, "900", "windowSpent reset to 900");
  eq(gw.status().totalSpent, "2300", "totalSpent accumulates across windows (2300)");
  eq(mock.transfers.length, 3, "wallet received 3 Transfers total");
  ok(mock.transfers.every((t) => t.address === MERCHANT), "every Transfer the wallet got was to the merchant");
}

console.log("== 3. total budget ceiling ==");
{
  const gw = new BudgetGateway({
    wallet: client, clock,
    quota: { total: 1_000, perTxCap: 1_000, dailyCap: 1_000_000, windowMs: 10_000, whitelist: [MERCHANT] },
  });
  const a = await gw.pay(MERCHANT, 1_000);
  ok(a.ok, "pay 1000 == total -> sent");
  const b = await gw.pay(MERCHANT, 1);
  ok(!b.ok && b.code === "OVER_TOTAL", "pay 1 more -> OVER_TOTAL");
}

console.log("== 4. same enforcement through the agent-facing HTTP API ==");
{
  const before = mock.transfers.length;
  const gw = new BudgetGateway({
    wallet: client, clock,
    quota: { total: 50_000, perTxCap: 1_000, dailyCap: 1_500, windowMs: 10_000, whitelist: [MERCHANT] },
  });
  const server = createGatewayServer(gw);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const payRes = await fetch(`${base}/pay`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ merchant: MERCHANT, amount: "700", memo: "http" }),
  });
  const payBody = await payRes.json();
  ok(payRes.status === 200 && payBody.ok && payBody.txId, "POST /pay in-cap -> 200 ok with txId");
  eq(mock.transfers.length, before + 1, "HTTP in-cap pay reached the wallet");

  const overRes = await fetch(`${base}/pay`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ merchant: MERCHANT, amount: "9999" }),
  });
  const overBody = await overRes.json();
  ok(overRes.status === 402 && overBody.code === "OVER_PER_TX", "POST /pay over cap -> 402 OVER_PER_TX");
  eq(mock.transfers.length, before + 1, "HTTP over-cap pay did NOT reach the wallet");

  const stRes = await fetch(`${base}/status`);
  const st = await stRes.json();
  ok(stRes.status === 200 && st.windowSpent === "700", "GET /status -> windowSpent 700");

  await new Promise((r) => server.close(r));
}

await mock.stop();
console.log(`\n==== ${fail === 0 ? "ALL PASS" : "FAILURES"} : ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
