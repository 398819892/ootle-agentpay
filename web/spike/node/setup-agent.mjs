// Two-account setup for the non-custodial wallet demo.
//
// Creates a SEPARATE agent (session) account and opens a fresh AgentBudget whose agent badge is routed
// to that account — so the agent can pay (and pay its OWN gas) while the owner wallet balance never
// moves. wallet-server.mjs picks the result up from .spike-two-account.json and signs /api/pay with
// the agent key, leaving /api/account + /api/send on the owner key.
//
//   owner key (.spike-key.json, funded)  -- funds the budget, signs `open`
//   agent key (.spike-agent-key.json)    -- faucet-created account, holds the agent badge, pays `pay` gas
//
// Idempotent: reuses the agent key, account and budget if the files already exist.
// Run from the spike root in WSL ext4 against the local swarm:
//   node --experimental-wasm-modules --experimental-global-webcrypto node/setup-agent.mjs
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import fs from "node:fs";
import {
  TransactionBuilder,
  XTR_FAUCET_COMPONENT_ADDRESS, XTR_FAUCET_VAULT_ADDRESS, XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
  amountLiteral, toHexStr, fromHexStr, Network,
} from "@tari-project/ootle";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { decodeSubstateValue } from "@tari-project/ootle-wasm-bor";
import { openBudgetTx, parseBudgetSubstate, findNewComponent, XTR } from "../src/agentpay-tx.js";
import { connectIndexer, accountVaults, maxEpoch, signSealSubmit } from "../src/chain.js";

const INDEXER = process.env.INDEXER_URL || "http://127.0.0.1:12008";
const NET = Network.LocalNet;
const TEMPLATE = process.env.AGENT_TEMPLATE || "template_c4b58558181f19c17d6ccc75c93e0707e2c5b75d1ef4de96a70acd0fd2d40e47";
const MERCHANT = process.env.MERCHANT || "component_c5c2db90a8f9f02981617244b835fd36d4830bdcb80eb7f5cb092932896924e3";
const OWNER_KEY_FILE = new URL("../.spike-key.json", import.meta.url);
const AGENT_KEY_FILE = new URL("../.spike-agent-key.json", import.meta.url);
const CFG_FILE = new URL("../.spike-two-account.json", import.meta.url);
const XTR_HEX = XTR.replace(/^resource_/, "");

const provider = await connectIndexer(INDEXER, NET);
const log = (...a) => console.log(...a);

async function xtrBalance(account) {
  let total = 0n;
  for (const v of await accountVaults(provider, account)) {
    let c = (await provider.getSubstate(v))?.state?.up?.substate;
    if (typeof c === "string") c = JSON.parse(decodeSubstateValue(c));
    const s = JSON.stringify(c);
    if (!s.includes(XTR_HEX)) continue;
    const m = s.match(/"revealed_amount":"?(\d+)"?/) || s.match(/"amount":"?(\d+)"?/);
    if (m) total += BigInt(m[1]);
  }
  return total;
}

// --- owner key (funds the budget) ---
const ownerKey = JSON.parse(fs.readFileSync(OWNER_KEY_FILE, "utf8"));
const ownerW = SecretKeyWallet.fromSecretKey(fromHexStr(ownerKey.owner), NET, fromHexStr(ownerKey.view));
const OWNER = ownerKey.account;
log("owner account:", OWNER);

// --- 1. agent key + faucet-funded account (the builtin localnet faucet creates the account in-tx) ---
let agentKey;
if (fs.existsSync(AGENT_KEY_FILE)) {
  agentKey = JSON.parse(fs.readFileSync(AGENT_KEY_FILE, "utf8"));
  log("reusing agent key, account:", agentKey.account);
} else {
  const { generateOotleSecretKey, ootlePublicKeyFromSecretKey } = await import("@tari-project/ootle-wasm");
  const sk = generateOotleSecretKey();
  const pk = ootlePublicKeyFromSecretKey(sk.owner_key, sk.view_key);
  agentKey = { owner: toHexStr(sk.owner_key), view: toHexStr(sk.view_key), ownerPublic: toHexStr(pk.owner_key), account: null };
  fs.writeFileSync(AGENT_KEY_FILE, JSON.stringify(agentKey, null, 2));
  log("generated agent key pk", agentKey.ownerPublic);
}
const agentW = SecretKeyWallet.fromSecretKey(fromHexStr(agentKey.owner), NET, fromHexStr(agentKey.view));

if (!agentKey.account) {
  const unsigned = new TransactionBuilder(NET, await maxEpoch(provider))
    .withFeeInstructionsBuilder((b) =>
      b.createAccount(agentKey.ownerPublic).saveVar("account")
        .callMethod({ componentAddress: XTR_FAUCET_COMPONENT_ADDRESS, methodName: "take" }, [{ Workspace: "account" }])
        .callMethod({ fromWorkspace: "account", methodName: "pay_fee" }, [amountLiteral(20_000n)]))
    .withInputs([
      { substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null },
      { substate_id: XTR_FAUCET_VAULT_ADDRESS, version: null },
      { substate_id: XTR_FAUCET_CLAIM_RESOURCE_ADDRESS, version: null },
    ])
    .buildUnsignedTransaction();
  const { txId, receipt } = await signSealSubmit(provider, [agentW], unsigned);
  agentKey.account = findNewComponent(receipt);
  fs.writeFileSync(AGENT_KEY_FILE, JSON.stringify(agentKey, null, 2));
  log(`[faucet] tx ${txId} -> agent account ${agentKey.account}`);
}
const AGENT = agentKey.account;
log("agent account XTR:", (await xtrBalance(AGENT)).toString());

// --- 2. open a fresh budget: owner funds it, the agent badge (ret.2) is routed to the AGENT account ---
let cfg = fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, "utf8")) : null;
if (cfg && cfg.budget) {
  log("reusing two-account budget:", cfg.budget);
} else {
  const ownerBefore = await xtrBalance(OWNER);
  const unsigned = openBudgetTx({
    network: NET, maxEpoch: await maxEpoch(provider), template: TEMPLATE,
    owner: OWNER, agent: AGENT, ownerVaults: await accountVaults(provider, OWNER),
    fund: 50_000, perTxCap: 1_000, dailyCap: 15_000, epochsPerWindow: 10,
    whitelist: [MERCHANT], maxFee: 300_000,
  });
  const { txId, receipt } = await signSealSubmit(provider, [ownerW], unsigned);
  const budget = findNewComponent(receipt, [OWNER, AGENT, MERCHANT]);
  if (!budget) throw new Error("open committed but no new budget component found");
  const st = parseBudgetSubstate(await provider.getSubstate(budget));
  // `new` mints the agent badge with NFT id "default"; that is the session the agent proves on pay.
  cfg = { budget, agentBadge: st.agentBadge, budgetVault: st.vault, owner: OWNER, agent: AGENT, merchant: MERCHANT, template: TEMPLATE, session: "default" };
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
  log(`[open] tx ${txId} -> budget ${budget}`);
  log(`[open] agentBadge ${st.agentBadge}  vault ${st.vault}  caps ${st.perTxCap}/${st.dailyCap}`);
  log(`[open] owner XTR ${ownerBefore} -> ${await xtrBalance(OWNER)} (funded 50000 + fee)`);
}
log("\nCONFIG:", JSON.stringify(cfg, null, 2));
provider.stopWatcher?.();
process.exit(0);
