// Flow B — "the user's wallet is a walletd; the dApp builds, the wallet signs on approval,
// the dApp seals and submits via the indexer".
//
//   dApp (this script, holds NO key)                    user's walletd (:12010, owns `default`)
//   ---------------------------------                   ------------------------------------
//   build open tx (ootle.ts builder)   --signing_requests.create-->  queued (status Pending)
//                                      <--- owner approves (UI / approve RPC) --- returns signature
//   seal with throwaway key (WASM) -> POST indexer /transactions -> watch -> parse receipt
//   build pay tx (proof by nft id) ... same loop ... read AgentBudget.pay event
//
// Run: NODE_OPTIONS=--experimental-wasm-modules node node/flow-b-walletd-approve.mjs
import { openBudgetTx, payTx, findNewComponent, templateEvents, parseBudgetSubstate } from "../src/agentpay-tx.js";
import { connectIndexer, accountVaults, maxEpoch, signSealSubmit, LOCALNET } from "../src/chain.js";
import { WalletdRpc } from "../src/walletd-rpc.js";
import { WalletdSigningRequestSigner } from "../src/walletd-signer.js";

const WALLETD = process.env.WALLETD_URL ?? "http://127.0.0.1:12010/json_rpc";
const TEMPLATE = process.env.AGENT_TEMPLATE ?? "template_978113ef1251cf83cff05ca21057eefcaa2ebaa7770abf07ba82d6ffda0e453f";
const OWNER_NAME = process.env.OWNER ?? "default";
const MERCHANT_NAME = process.env.MERCHANT ?? "e2e_merchant";

const log = (...a) => console.log(...a);

// --- two walletd sessions with DIFFERENT permissions, to make the trust boundary explicit ---------
// (1) the dApp's token: may only queue signing requests and read them back. It cannot submit, sign
//     or read balances (verified: accounts.* / transactions.submit_manifest are refused for it).
const dapp = await new WalletdRpc(WALLETD, { permissions: [{ SigningRequests: "Create" }, { SigningRequests: "Read" }] }).connect();
// (2) the wallet OWNER's session (what the wallet UI holds). Used here only to look up the account
//     and to play the "Approve" click.
const owner = await new WalletdRpc(WALLETD, { permissions: ["Admin"] }).connect();

const accounts = (await owner.call("accounts.list", { offset: 0, limit: 50 })).accounts;
const find = (name) => {
  const a = accounts.find((x) => x.account.name === name);
  if (!a) throw new Error(`account ${name} not found in walletd`);
  return a.account;
};
const ownerAcct = find(OWNER_NAME);
const merchantAcct = find(MERCHANT_NAME);
log(`owner    ${ownerAcct.name} ${ownerAcct.component_address} key ${JSON.stringify(ownerAcct.owner_key_id)} pk ${ownerAcct.owner_public_key}`);
log(`merchant ${merchantAcct.name} ${merchantAcct.component_address}`);

const provider = await connectIndexer();
const ownerVaults = await accountVaults(provider, ownerAcct.component_address);
const merchantVaults = await accountVaults(provider, merchantAcct.component_address);

const approve = async (requestId) => {
  const pending = (await owner.call("signing_requests.get", { request_id: requestId })).request;
  log(`  [wallet] signing request #${requestId} pending: ${pending.transaction.V1.instructions.length} instructions, signer ${pending.signer_public_key.slice(0, 12)}… -> owner approves`);
  const r = await owner.call("signing_requests.approve", { request_id: requestId });
  log(`  [wallet] -> ${r.status}`);
};
const signer = new WalletdSigningRequestSigner(dapp, {
  keyId: ownerAcct.owner_key_id,
  publicKey: ownerAcct.owner_public_key,
  onRequest: approve,
});

// --- 1. open -----------------------------------------------------------------------------------
const openParams = {
  network: LOCALNET.network,
  maxEpoch: await maxEpoch(provider),
  template: TEMPLATE,
  owner: ownerAcct.component_address,
  ownerVaults,
  fund: 50_000,
  perTxCap: 1_000,
  dailyCap: 1_500,
  epochsPerWindow: 10,
  whitelist: [merchantAcct.component_address],
  maxFee: 200_000,
};
const openTx = openBudgetTx(openParams);
log(`\n[open] built ${openTx.instructions.length} instructions + ${openTx.fee_instructions.length} fee instruction, ${openTx.inputs.length} inputs`);
// No dry run on this path: walletd refuses to co-sign a dry-run tx ("a dry-run transaction cannot be
// committed, so it is never co-signed"), and its own raw `transactions.submit_dry_run` for an
// SDK-built tx fails in the 0.47 indexer with "Transaction must have at least one authorized
// signature" (indexer stdout.log). A wallet-side preview needs the 0.48 `transactions.sign` path.
const open = await signSealSubmit(provider, [signer], openTx);
const budget = findNewComponent(open.receipt, [ownerAcct.component_address, merchantAcct.component_address]);
log(`[open] tx ${open.txId} COMMITTED -> budget component ${budget}`);
const state = parseBudgetSubstate(await provider.getSubstate(budget));
log(`[open] on-chain state: ownerBadge ${state.ownerBadge}\n                      agentBadge ${state.agentBadge}\n                      caps ${state.perTxCap}/${state.dailyCap} whitelist ${state.whitelist.length} revoked ${state.revoked}`);

// --- 2. pay ------------------------------------------------------------------------------------
const payParams = {
  network: LOCALNET.network,
  maxEpoch: await maxEpoch(provider),
  agent: ownerAcct.component_address,
  agentVaults: await accountVaults(provider, ownerAcct.component_address),
  budget,
  budgetVault: state.vault,
  agentBadge: state.agentBadge,
  session: "default",
  merchant: merchantAcct.component_address,
  merchantVaults,
  amount: 700,
  memo: "spike flow-b: wallet-approved pay",
  maxFee: 200_000,
};
const pay = await signSealSubmit(provider, [signer], payTx(payParams));
const events = templateEvents(pay.receipt, TEMPLATE);
log(`[pay] tx ${pay.txId} COMMITTED, ${events.length} AgentBudget event(s):`);
for (const e of events) log("   ", e.topic, JSON.stringify(e.payload));
const after = parseBudgetSubstate(await provider.getSubstate(budget));
log(`[pay] spent_in_window now ${after.spentInWindow} (was ${state.spentInWindow})`);

// --- 3. over-cap pay must be rejected BY THE CHAIN (dry-run) -----------------------------------
// A REAL over-cap submit (the wallet owner approves it, the CHAIN still refuses it).
let badReason = "(accepted?!)";
try {
  await signSealSubmit(provider, [signer], payTx({ ...payParams, maxEpoch: await maxEpoch(provider), amount: 5_000, memo: "over cap" }));
} catch (e) {
  badReason = `${e.outcome ?? "error"}: ${e.reason ?? e.message}`;
}
log(`[pay 5000 > cap] chain says:`, badReason.slice(0, 300));

provider.stopWatcher?.();
log("\nDONE flow-b");
