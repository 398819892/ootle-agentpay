// Flow A — "the user's key lives in the client (SecretKeyWallet, WASM sr25519); no walletd at all".
//
//   client key (generated here, persisted to .spike-key.json next to this script)
//     -> builtin localnet faucet creates + funds the account   (CreateAccount + faucet.take, fee from the new account)
//     -> open  (withdraw XTR -> AgentBudget::new -> deposit badges)   signed by the client key
//     -> pay   (proof of ONE session badge by id -> budget.pay)      signed by the client key
//     -> AgentBudget.pay event read from the indexer receipt
//
// Run: NODE_OPTIONS=--experimental-wasm-modules node node/flow-a-browser-key.mjs [--dry-run]
import fs from "node:fs";
import {
  TransactionBuilder,
  XTR_FAUCET_COMPONENT_ADDRESS,
  XTR_FAUCET_VAULT_ADDRESS,
  XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
  amountLiteral,
  toHexStr,
  fromHexStr,
} from "@tari-project/ootle";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { openBudgetTx, payTx, findNewComponent, templateEvents, parseBudgetSubstate } from "../src/agentpay-tx.js";
import { connectIndexer, accountVaults, maxEpoch, dryRun, signSealSubmit, LOCALNET } from "../src/chain.js";

const TEMPLATE = process.env.AGENT_TEMPLATE ?? "template_978113ef1251cf83cff05ca21057eefcaa2ebaa7770abf07ba82d6ffda0e453f";
const MERCHANT = process.env.MERCHANT_ADDRESS ?? "component_7ce2546e4f2384eee64b89e77fab606aff50099e0c14be140c50db294780ec6c";
const KEY_FILE = new URL("../.spike-key.json", import.meta.url);
const DRY = process.argv.includes("--dry-run");
const log = (...a) => console.log(...a);

// --- 1. the client's own key -----------------------------------------------------------------
let key;
if (fs.existsSync(KEY_FILE)) {
  key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
} else {
  const w = SecretKeyWallet.randomWithViewKey(LOCALNET.network);
  // SecretKeyWallet has no secret export; regenerate deterministically via the WASM helpers instead.
  const { generateOotleSecretKey, ootlePublicKeyFromSecretKey } = await import("@tari-project/ootle-wasm");
  const sk = generateOotleSecretKey();
  const pk = ootlePublicKeyFromSecretKey(sk.owner_key, sk.view_key);
  key = { owner: toHexStr(sk.owner_key), view: toHexStr(sk.view_key), ownerPublic: toHexStr(pk.owner_key), account: null };
  void w;
  fs.writeFileSync(KEY_FILE, JSON.stringify(key, null, 2));
}
const wallet = SecretKeyWallet.fromSecretKey(fromHexStr(key.owner), LOCALNET.network, fromHexStr(key.view));
log(`client key: pk ${key.ownerPublic} (secret stays in ${KEY_FILE.pathname})`);

const provider = await connectIndexer();

// --- 2. fund via the builtin localnet faucet (creates the account in the same tx) ---------------
if (!key.account) {
  const unsigned = new TransactionBuilder(LOCALNET.network, await maxEpoch(provider))
    .withFeeInstructionsBuilder((b) =>
      b
        .createAccount(key.ownerPublic)
        .saveVar("account")
        .callMethod({ componentAddress: XTR_FAUCET_COMPONENT_ADDRESS, methodName: "take" }, [{ Workspace: "account" }])
        .callMethod({ fromWorkspace: "account", methodName: "pay_fee" }, [amountLiteral(20_000n)]),
    )
    .withInputs([
      { substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null },
      { substate_id: XTR_FAUCET_VAULT_ADDRESS, version: null },
      { substate_id: XTR_FAUCET_CLAIM_RESOURCE_ADDRESS, version: null },
    ])
    .buildUnsignedTransaction();
  const { txId, receipt } = await signSealSubmit(provider, [wallet], unsigned);
  key.account = findNewComponent(receipt);
  fs.writeFileSync(KEY_FILE, JSON.stringify(key, null, 2));
  log(`[faucet] tx ${txId} COMMITTED -> account ${key.account}`);
} else {
  log(`[faucet] reusing account ${key.account}`);
}
const vaults = await accountVaults(provider, key.account);

// --- 3. open ------------------------------------------------------------------------------------
const openParams = {
  network: LOCALNET.network,
  maxEpoch: await maxEpoch(provider),
  template: TEMPLATE,
  owner: key.account,
  ownerVaults: vaults,
  fund: 50_000,
  perTxCap: 1_000,
  dailyCap: 1_500,
  epochsPerWindow: 10,
  whitelist: [MERCHANT],
  maxFee: 200_000,
};
if (DRY) {
  const dr = await dryRun(provider, [wallet], openBudgetTx(openParams));
  const res = dr.result?.finalize?.result ?? dr;
  const reason = res.Reject ?? (res.AcceptFeeRejectRest ? res.AcceptFeeRejectRest[1] : null);
  log("[open] dry-run:", reason ? "REJECT " + JSON.stringify(reason) : "ACCEPT, fee " + JSON.stringify(dr.result?.finalize?.fee_receipt?.total_fees_paid));
  process.exit(0);
}
const open = await signSealSubmit(provider, [wallet], openBudgetTx(openParams));
const budget = findNewComponent(open.receipt, [key.account, MERCHANT]);
log(`[open] tx ${open.txId} COMMITTED -> budget ${budget}`);
const state = parseBudgetSubstate(await provider.getSubstate(budget));
log(`[open] ownerBadge ${state.ownerBadge}\n       agentBadge ${state.agentBadge}\n       caps ${state.perTxCap}/${state.dailyCap} whitelist ${state.whitelist.join(",")}`);

// --- 4. pay -------------------------------------------------------------------------------------
const payParams = {
  network: LOCALNET.network,
  maxEpoch: await maxEpoch(provider),
  agent: key.account,
  agentVaults: await accountVaults(provider, key.account),
  budget,
  budgetVault: state.vault,
  agentBadge: state.agentBadge,
  session: "default",
  merchant: MERCHANT,
  merchantVaults: await accountVaults(provider, MERCHANT),
  amount: 700,
  memo: "spike flow-a: client-key pay",
  maxFee: 200_000,
};
const pay = await signSealSubmit(provider, [wallet], payTx(payParams));
const events = templateEvents(pay.receipt, TEMPLATE);
log(`[pay] tx ${pay.txId} COMMITTED, ${events.length} AgentBudget event(s):`);
for (const e of events) log("   ", e.topic, JSON.stringify(e.payload));
const after = parseBudgetSubstate(await provider.getSubstate(budget));
log(`[pay] spent_in_window ${state.spentInWindow} -> ${after.spentInWindow}`);

// --- 5. over-cap pay rejected by the chain (indexer dry-run) -------------------------------------
const bad = await dryRun(provider, [wallet], payTx({ ...payParams, maxEpoch: await maxEpoch(provider), amount: 5_000, memo: "over cap" }));
const badRes = bad.result?.finalize?.result ?? {};
log(`[pay 5000 > cap] chain says:`, JSON.stringify(badRes.Reject ?? badRes.AcceptFeeRejectRest?.[1] ?? badRes).slice(0, 300));

provider.stopWatcher?.();
log("\nDONE flow-a");
