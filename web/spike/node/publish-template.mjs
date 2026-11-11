// publish-template.mjs — publish the AgentBudget template to a network (MainNet by default). ONE-OFF admin.
//
// RUN THIS ONLY AFTER you have a FUNDED account on the target network. On mainnet that means: burn XTM in
// Tari Universe, wait ~24h for the TARI to arrive, fund this account, THEN run this. It pays a real
// on-chain publish fee. It is dry-run-first and will NOT submit unless you pass PUBLISH_CONFIRM=1, so you
// can validate the shape on localnet/stagenet (free) before spending on mainnet.
//
// Inputs (env):
//   AGENTPAY_NETWORK   network name (default: mainnet). Resolved in src/net-config.mjs.
//   INDEXER_URL        indexer RPC (default: the network's indexer from net-config).
//   TEMPLATE_WASM      path to the COMPILED AgentBudget template .wasm (build it from the template crate;
//                      the localnet template was published by the swarm, so the .wasm is NOT in this repo).
//   PUBLISH_ACCOUNT    the funded source account component (component_…) that pays the publish fee.
//   PUBLISH_OWNER_HEX  32-byte hex owner secret of that account (signs the publish tx).
//   PUBLISH_VIEW_HEX   32-byte hex view secret.
//   PUBLISH_FEE        max fee in XTR base units (default 2_000_000).
//   PUBLISH_CONFIRM=1  actually submit (otherwise: dry-run only, prints the result and exits).
//
// On success it prints the published template_ address — paste it into AGENT_TEMPLATE
// (deploy/agentpay-wallet-mainnet.conf.example) and restart the service.
//
// API: TransactionBuilder.publishTemplate(binaryBase64, metadataHash?) stores the WASM as a tx blob and
// emits a PublishTemplate instruction (ootle 0.14 d.ts). The new template substate shows up in the receipt.
import fs from "node:fs";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto; // Node 18 shim; browsers have globalThis.crypto
import { TransactionBuilder, amountLiteral } from "@tari-project/ootle";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { fromHexStr } from "@tari-project/ootle";
import { connectIndexer, maxEpoch, signSealSubmit, dryRun } from "../src/chain.js";
import { netByName } from "../src/net-config.mjs";

const NETNAME = (process.env.AGENTPAY_NETWORK || "mainnet").toLowerCase();
const net = netByName(NETNAME);
const INDEXER = process.env.INDEXER_URL || net.indexerUrl;
const WASM = process.env.TEMPLATE_WASM;
const ACCOUNT = process.env.PUBLISH_ACCOUNT;
const OWNER = process.env.PUBLISH_OWNER_HEX, VIEW = process.env.PUBLISH_VIEW_HEX;
const FEE = BigInt(process.env.PUBLISH_FEE || "2000000");
const CONFIRM = process.env.PUBLISH_CONFIRM === "1";

const die = (m) => { console.error("error: " + m); process.exit(1); };
if (!WASM || !ACCOUNT || !OWNER || !VIEW) die("set TEMPLATE_WASM, PUBLISH_ACCOUNT, PUBLISH_OWNER_HEX, PUBLISH_VIEW_HEX");
if (!INDEXER) die(`no indexer for ${NETNAME}; set INDEXER_URL`);
if (!fs.existsSync(WASM)) die(`TEMPLATE_WASM not found: ${WASM}`);

const b64 = fs.readFileSync(WASM).toString("base64");
const wallet = SecretKeyWallet.fromSecretKey(fromHexStr(OWNER), net.network, fromHexStr(VIEW));
const provider = await connectIndexer(INDEXER, net.network);
console.log(`[publish] network=${NETNAME} indexer=${INDEXER}`);
console.log(`[publish] account=${ACCOUNT} wasm=${WASM} (${b64.length} base64 chars) fee<=${FEE} confirm=${CONFIRM}`);

// Pay the publish fee from the funded account, then publish the template blob.
const unsigned = new TransactionBuilder(net.network, await maxEpoch(provider))
  .withFeeInstructionsBuilder((b) =>
    b.callMethod({ componentAddress: ACCOUNT, methodName: "pay_fee" }, [amountLiteral(FEE)]),
  )
  .publishTemplate(b64)
  .withInputs([{ substate_id: ACCOUNT, version: null }])
  .buildUnsignedTransaction();

// Pull any template_ address out of a receipt's up-substates (the published template's new substate id).
function templateAddrOf(receipt) {
  const s = JSON.stringify(receipt ?? "");
  const m = s.match(/template_[0-9a-f]{64}/i);
  return m ? m[0] : null;
}

if (!CONFIRM) {
  console.log("[dry-run] PUBLISH_CONFIRM!=1 — simulating only, NOT submitting.");
  const r = await dryRun(provider, [wallet], unsigned);
  console.log("[dry-run] result:\n" + JSON.stringify(r, null, 2).slice(0, 4000));
  console.log("\n[dry-run] looks right? re-run with PUBLISH_CONFIRM=1 to publish for real.");
  process.exit(0);
}

console.log("[submit] publishing for real…");
const { txId, receipt } = await signSealSubmit(provider, [wallet], unsigned, { timeoutMs: 120_000 });
const tpl = templateAddrOf(receipt);
console.log(`[submit] tx ${txId} committed.`);
if (tpl) {
  console.log(`\n✅ published template: ${tpl}\n   -> set AGENT_TEMPLATE=${tpl} in the mainnet drop-in, then restart agentpay-wallet.`);
} else {
  console.log("\n⚠ could not auto-extract the template_ address — full receipt below; grab the template_ id:");
  console.log(JSON.stringify(receipt, null, 2).slice(0, 6000));
}
