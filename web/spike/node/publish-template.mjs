// publish-template.mjs — publish the AgentBudget template to a network (MainNet by default). ONE-OFF admin.
//
// RUN THIS ONLY AFTER you have a FUNDED account on the target network. On mainnet that means: burn XTM in
// Tari Universe, wait ~24h for the TARI to arrive, fund this account, THEN run this. It pays a real
// on-chain publish fee. It is PREVIEW-first: it builds the tx and prints a summary, and will NOT submit
// unless you pass PUBLISH_CONFIRM=1 — so you can rehearse the whole flow on localnet (free) first.
//
// Inputs (env):
//   AGENTPAY_NETWORK   network name (default: mainnet). Resolved in src/net-config.mjs.
//   INDEXER_URL        indexer RPC (default: the network's indexer from net-config).
//   TEMPLATE_WASM      path to the COMPILED AgentBudget template .wasm (build it from the template crate;
//                      the localnet template was published by the swarm, so the .wasm is NOT in this repo).
//   PUBLISH_ACCOUNT    the funded source account component (component_…) that pays the publish fee.
//   PUBLISH_OWNER_HEX  32-byte hex owner secret of that account (signs the publish tx).
//   PUBLISH_VIEW_HEX   32-byte hex view secret.
//   PUBLISH_FEE        max fee in XTR base units (default 10_000_000; a ~300 KiB template costs ~5M, and
//                      any unused reserve is refunded — raise it if the chain reports InsufficientFeesPaid).
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
import { TransactionBuilder, fromHexStr } from "@tari-project/ootle";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { connectIndexer, maxEpoch, signSealSubmit, accountVaults, decodeExecResult } from "../src/chain.js";
import { netByName } from "../src/net-config.mjs";

const NETNAME = (process.env.AGENTPAY_NETWORK || "mainnet").toLowerCase();
const net = netByName(NETNAME);
const INDEXER = process.env.INDEXER_URL || net.indexerUrl;
const WASM = process.env.TEMPLATE_WASM;
const ACCOUNT = process.env.PUBLISH_ACCOUNT;
const OWNER = process.env.PUBLISH_OWNER_HEX, VIEW = process.env.PUBLISH_VIEW_HEX;
const FEE = BigInt(process.env.PUBLISH_FEE || "10000000");
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

// Declare the funded account + its current vaults as inputs (the bare indexer can't auto-detect them),
// pay the publish fee from the account, then publish the template blob. Mirrors agentpay-tx.js's fee+input
// idiom (feeTransactionPayFromComponent + asInput with is_write). Verified on localnet 2026-11-11.
const asInput = (id, is_write = true) => ({ substate_id: id, version: null, is_write });
const ownerVaults = await accountVaults(provider, ACCOUNT);
const unsigned = TransactionBuilder.new(net.network, await maxEpoch(provider))
  .withInputs([asInput(ACCOUNT), ...ownerVaults.map((v) => asInput(v))])
  .feeTransactionPayFromComponent(ACCOUNT, FEE)
  .publishTemplate(b64)
  .buildUnsignedTransaction();

// The published template's substate id lives in the DECODED (CBOR) execution_result, not the raw receipt.
// Decode it, then take the real template_<64hex> id — skipping the all-zeros template_address the
// std.vault.pay_fee event carries. Verified on localnet 2026-11-11.
function templateAddrOf(receipt) {
  const scan = (s) => (s.match(/template_[0-9a-f]{64}/gi) || []).filter((t) => !/^template_0+$/i.test(t));
  try {
    const enc = receipt?.result?.Finalized?.execution_result;
    const hits = enc ? scan(JSON.stringify(decodeExecResult(enc))) : [];
    if (hits.length) return hits[hits.length - 1];
  } catch { /* fall through to raw */ }
  const raw = scan(JSON.stringify(receipt ?? ""));
  return raw.length ? raw[raw.length - 1] : null;
}

if (!CONFIRM) {
  console.log(`[preview] built publish tx: ${1 + ownerVaults.length} input(s), fee<=${FEE}, wasm ~${Math.round(b64.length / 1365)} KiB. Not submitting.`);
  console.log("[preview] PUBLISH_CONFIRM!=1 — re-run with PUBLISH_CONFIRM=1 to publish for real.");
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
