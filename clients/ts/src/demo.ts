/**
 * End-to-end demo against a REAL Ootle network — the TS mirror of the Python SDK's
 * `examples/demo_devnet.py`. It drives the on-chain AgentBudget template, so the per-tx cap,
 * daily cap, whitelist and kill switch are enforced by the validator, not by this client.
 *
 * Config (all optional; defaults target the local swarm):
 *   AGENTPAY_WALLETD_URL     wallet daemon JSON-RPC    (default http://127.0.0.1:12010/json_rpc)
 *   AGENTPAY_BUDGET_TEMPLATE AgentBudget template addr (default the localnet template)
 *   AGENTPAY_OWNER_ACCOUNT   funded owner account name (default "default")
 * The template may also be passed as the first CLI arg. See README.md for esmeralda settings.
 */
import {
  ChainError,
  DEFAULT_WALLETD_URL,
  newInvoiceId,
  OnChainBudget,
  WalletdClient,
} from "./index";

const WALLETD_URL = process.env.AGENTPAY_WALLETD_URL || DEFAULT_WALLETD_URL;
const BUDGET_TEMPLATE =
  process.argv[2] ||
  process.env.AGENTPAY_BUDGET_TEMPLATE ||
  "template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97";
const OWNER = process.env.AGENTPAY_OWNER_ACCOUNT || "default";

async function ensureAccount(c: WalletdClient, name: string): Promise<string> {
  try {
    return await c.accountAddress(name);
  } catch (e) {
    if (!(e instanceof ChainError)) throw e;
    const addr = await c.createAccount(name);
    await c.fund(name);
    return addr;
  }
}

async function main(): Promise<void> {
  const c = await new WalletdClient(WALLETD_URL).connect();
  const owner = await c.accountAddress(OWNER); // the funded swarm account = the owner
  const shop = await ensureAccount(c, "shop"); // a whitelisted merchant
  const scammer = await ensureAccount(c, "scammer"); // NOT whitelisted
  console.log(`owner=${owner.slice(0, 24)}…  shop=${shop.slice(0, 24)}…  scammer=${scammer.slice(0, 24)}…`);

  console.log("\n== Owner opens an on-chain budget: 10000 funded, per-tx 1000, daily 1500, whitelist=[shop] ==");
  const budget = await new OnChainBudget(c, BUDGET_TEMPLATE, owner).open({
    fund: 10_000, perTxCap: 1_000, dailyCap: 1_500, epochsPerWindow: 10, whitelist: [shop],
  });
  console.log(`  budget component = ${budget.component}`);
  const shopBefore = await c.balance("shop");

  console.log("\n== Agent pays an invoice to the shop (on chain, memo carries the invoice id) ==");
  const inv = newInvoiceId();
  const res = await budget.payInvoice({ merchant: shop, invoiceId: inv, amount: 700, agentTag: "shopper" });
  console.log(`  paid 700 — pay events read from chain: ${JSON.stringify(OnChainBudget.payEvents(res))}`);

  console.log("\n== The chain REJECTS what the rules forbid (the VALIDATOR decides, not the client) ==");
  console.log(`  over per-tx cap (1500 > 1000): rejected -> ${await budget.wouldReject(shop, 1500)}`);
  console.log(`  non-whitelisted merchant:      rejected -> ${await budget.wouldReject(scammer, 100)}`);

  console.log("\n== A second real pay (700) brings spend to 1400; the next 700 would break the daily cap ==");
  await budget.pay(shop, 700, { memo: "ap1|second|shopper" }); // spent on chain: 700 + 700 = 1400
  console.log(`  spent so far (daily cap 1500): ${budget.spent}`);
  console.log(`  another 700 (1400 + 700 > 1500): rejected -> ${await budget.wouldReject(shop, 700)}`);

  console.log("\n== Owner revokes the agent (kill switch) — further pays fail on chain ==");
  await budget.revoke();
  const reason = await budget.wouldReject(shop, 100);
  console.log(`  pay after revoke: ${reason ? "rejected -> " + reason : "UNEXPECTEDLY ACCEPTED"}`);

  console.log("\n== Owner withdraws the remaining balance ==");
  // budget.spent is an exact decimal string; stay in BigInt so large budgets never lose precision.
  const remaining = (10_000n - BigInt(budget.spent)).toString(); // 10000 funded − 1400 spent = 8600
  await budget.withdraw(remaining);
  console.log(`  withdrew ${remaining} back to owner`);

  console.log(`\n== Shop received: ${(await c.balance("shop")) - shopBefore} (expected 1400 = two 700 pays) ==`);
  console.log("== Local ledger rebuilt from on-chain pay events ==");
  for (const e of budget.ledger) {
    console.log(`  pay ${e.amount} -> ${e.merchant.slice(0, 20)}…  memo=${JSON.stringify(e.memo)}`);
  }
}

main().catch((e) => {
  console.error("\nDEMO FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
