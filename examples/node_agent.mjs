#!/usr/bin/env node
/**
 * AgentPay integration example — Node, zero dependencies, no build step.
 *
 * Shows the whole third-party / agent flow against a hosted AgentPay service:
 *   1. read the budget (caps + what's left this window),
 *   2. make a capped payment with an Idempotency-Key,
 *   3. poll the receipt until it settles on chain,
 *   4. prove failure-recovery: re-send the SAME Idempotency-Key → the first receipt comes back,
 *      the chain is NOT charged twice.
 *
 * The agent never touches the wallet daemon. The on-chain AgentBudget enforces the limits — if the
 * payment is over a cap / not whitelisted / revoked, you get a receipt with status "rejected".
 *
 * Run (Node 18+):
 *   AGENTPAY_URL=http://localhost:8787 AGENTPAY_API_KEY=sk_agent_... \
 *     node examples/node_agent.mjs shop 250
 */

const BASE = (process.env.AGENTPAY_URL || "http://localhost:8787").replace(/\/+$/, "");
const KEY = process.env.AGENTPAY_API_KEY;
const merchant = process.argv[2] || "shop";
const amount = process.argv[3] || "100";

if (!KEY) {
  console.error("Set AGENTPAY_API_KEY (an agent key issued by the service owner).");
  process.exit(1);
}

async function api(method, path, { body, idempotencyKey } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function main() {
  // 1. budget
  const b = await api("GET", "/budget");
  if (b.status !== 200) throw new Error(`budget read failed: ${b.status} ${JSON.stringify(b.data)}`);
  const bud = b.data.budget;
  if (!bud) throw new Error("no budget is open on the service yet");
  console.log(`Budget: perTx=${bud.perTxCap} daily=${bud.dailyCap} remaining=${bud.dailyRemaining} treasury=${bud.treasury}`);

  // 2. pay (with an idempotency key we keep for the retry demo)
  const idem = `demo_${randomId()}`;
  console.log(`\nPaying ${amount} to "${merchant}" (Idempotency-Key: ${idem}) …`);
  const p1 = await api("POST", "/payments", { body: { merchant, amount: String(amount), memo: "node example" }, idempotencyKey: idem });
  const r1 = p1.data.receipt;
  console.log(`  → HTTP ${p1.status}  id=${r1?.id}  status=${r1?.status}  tx=${r1?.txId || "-"}${r1?.reason ? `  reason=${r1.reason}` : ""}`);

  // 3. poll until it settles
  let receipt = r1;
  for (let i = 0; receipt && (receipt.status === "pending" || receipt.status === "unknown") && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const g = await api("GET", `/payments/${encodeURIComponent(receipt.id)}`);
    receipt = g.data.receipt;
    console.log(`  … status=${receipt?.status}`);
  }
  console.log(`  settled: status=${receipt?.status}`);

  // 4. failure-recovery: resend the SAME key → same receipt, no second charge
  console.log(`\nResending the same Idempotency-Key (simulating a client retry) …`);
  const p2 = await api("POST", "/payments", { body: { merchant, amount: String(amount), memo: "node example" }, idempotencyKey: idem });
  const r2 = p2.data.receipt;
  console.log(`  → HTTP ${p2.status}  id=${r2?.id}  status=${r2?.status}  replayed=${p2.data.replayed}`);
  console.log(`  same payment id: ${r1?.id === r2?.id ? "YES — not double-spent ✓" : "NO (unexpected)"}`);
}

main().catch((e) => {
  console.error("error:", e.message);
  process.exit(1);
});
