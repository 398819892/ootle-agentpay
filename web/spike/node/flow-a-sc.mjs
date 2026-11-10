// flow-a-sc — self-custody browser-KEY smoke against a LIVE localnet indexer.
//
// Proves the exact in-browser path the wallet uses (src/agentpay-tx.js builders + src/chain.js
// signSealSubmit, the same modules src/sc-chain.mjs drives) end to end on Ootle 0.49:
//   browser-generated key  ->  faucet create+fund  ->  open budget  ->  pay  ->  AgentBudget.pay event
//   ->  over-cap pay is REJECTED by the template (per_tx_cap), surfaced as a thrown error.
//
// This is an INTEGRATION smoke, not a unit test: it needs a running localnet (indexer + builtin faucet)
// and the budget template + a whitelisted merchant for that localnet. Run:
//   AGENT_TEMPLATE=template_… MERCHANT_ADDRESS=component_… \
//   NODE_OPTIONS=--experimental-wasm-modules node node/flow-a-sc.mjs
//
// The key is generated the way the browser wallet does (src/self-custody.mjs): the installed ootle-wasm
// RNG traps, so entropy is CSPRNG bytes wide-reduced mod the group order. That reduction is inlined here
// (verbatim from self-custody.mjs generateKeyMaterial/randomScalar) so this smoke depends only on
// @tari-project/* and runs against any install; the reduction itself is unit-tested in self-custody.test.mjs.
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
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18 shim; browsers have globalThis.crypto natively
import { openBudgetTx, payTx, findNewComponent, templateEvents, parseBudgetSubstate } from "../src/agentpay-tx.js";
import { connectIndexer, accountVaults, maxEpoch, signSealSubmit, LOCALNET } from "../src/chain.js";

const TEMPLATE = process.env.AGENT_TEMPLATE;
const MERCHANT = process.env.MERCHANT_ADDRESS;
const log = (...a) => console.log(...a);
if (!TEMPLATE || !MERCHANT) { console.error("set AGENT_TEMPLATE + MERCHANT_ADDRESS (the running localnet's values)"); process.exit(1); }

// --- browser-style key material (mirrors src/self-custody.mjs; the WASM RNG traps) ---
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const toHex = (bytes) => { let s = ""; for (const b of bytes) s += b.toString(16).padStart(2, "0"); return s; };
function randomScalar() {
  const wide = new Uint8Array(64); globalThis.crypto.getRandomValues(wide);
  let n = 0n; for (let i = wide.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(wide[i]);
  n %= GROUP_ORDER;
  const b = new Uint8Array(32); for (let i = 0; i < 32; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b;
}
const km = { owner: randomScalar(), view: randomScalar() };
const { ootlePublicKeyFromSecretKey } = await import("@tari-project/ootle-wasm");
const pk = ootlePublicKeyFromSecretKey(km.owner, km.view); // derivation WASM works; only the RNG traps
const key = { owner: toHex(km.owner), view: toHex(km.view), ownerPublic: toHexStr(pk.owner_key) };
const wallet = SecretKeyWallet.fromSecretKey(fromHexStr(key.owner), LOCALNET.network, fromHexStr(key.view));
log(`[key] browser-generated pk ${key.ownerPublic}`);

const provider = await connectIndexer();

// --- faucet create + fund (creates the account in the same tx) ---
const fundTx = new TransactionBuilder(LOCALNET.network, await maxEpoch(provider))
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
const f = await signSealSubmit(provider, [wallet], fundTx);
const account = findNewComponent(f.receipt);
log(`[faucet] tx ${f.txId} COMMITTED -> account ${account}`);

// --- open budget (signed by the browser key) ---
const open = await signSealSubmit(provider, [wallet], openBudgetTx({
  network: LOCALNET.network, maxEpoch: await maxEpoch(provider), template: TEMPLATE,
  owner: account, ownerVaults: await accountVaults(provider, account),
  fund: 50_000, perTxCap: 1_000, dailyCap: 1_500, epochsPerWindow: 10, whitelist: [MERCHANT], maxFee: 200_000,
}));
const budget = findNewComponent(open.receipt, [account, MERCHANT]);
const state = parseBudgetSubstate(await provider.getSubstate(budget));
log(`[open] tx ${open.txId} COMMITTED -> budget ${budget} caps ${state.perTxCap}/${state.dailyCap}`);

// --- pay within cap (signed by the browser key) ---
const pay = await signSealSubmit(provider, [wallet], payTx({
  network: LOCALNET.network, maxEpoch: await maxEpoch(provider),
  agent: account, agentVaults: await accountVaults(provider, account),
  budget, budgetVault: state.vault, agentBadge: state.agentBadge, session: "default",
  merchant: MERCHANT, merchantVaults: await accountVaults(provider, MERCHANT),
  amount: 700, memo: "flow-a-sc browser-key pay", maxFee: 200_000,
}));
const events = templateEvents(pay.receipt, TEMPLATE);
const after = parseBudgetSubstate(await provider.getSubstate(budget));
log(`[pay] tx ${pay.txId} COMMITTED, ${events.length} event(s); spent_in_window ${state.spentInWindow} -> ${after.spentInWindow}`);
if (String(after.spentInWindow) !== "700") { console.error("FAIL: spent_in_window did not advance to 700"); process.exit(2); }

// --- over-cap pay: the template MUST reject it (signSealSubmit surfaces the inner AcceptFeeRejectRest) ---
let rejected = false, reason = "";
try {
  await signSealSubmit(provider, [wallet], payTx({
    network: LOCALNET.network, maxEpoch: await maxEpoch(provider),
    agent: account, agentVaults: await accountVaults(provider, account),
    budget, budgetVault: state.vault, agentBadge: state.agentBadge, session: "default",
    merchant: MERCHANT, merchantVaults: await accountVaults(provider, MERCHANT),
    amount: 5_000, memo: "over cap (must reject)", maxFee: 200_000,
  }));
} catch (e) { rejected = true; reason = (e && (e.reason || e.message)) || String(e); }
const afterOver = parseBudgetSubstate(await provider.getSubstate(budget));
if (!rejected || String(afterOver.spentInWindow) !== "700") {
  console.error(`FAIL: over-cap pay was not rejected (rejected=${rejected}, spent=${afterOver.spentInWindow})`);
  process.exit(2);
}
log(`[over-cap] REJECTED by chain (good): ${reason.slice(0, 160)}`);

provider.stopWatcher?.();
log("\nPASS flow-a-sc (browser-key sign+submit + on-chain cap enforcement on live localnet)");
