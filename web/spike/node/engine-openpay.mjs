// Full AgentBudget product flow on a LIVE Ootle L2, driven entirely THROUGH the self-built
// non-custodial wallet engine (src/l2-wallet.mjs) — i.e. the exact `window.tari` provider path the
// dapp speaks, not signSealSubmit directly (that is flow-a). Proves chain-enforced caps end to end:
//
//   engine.request("tari_signAndSubmitTransaction", { unsignedTransaction: openBudgetTx(...) })  -> budget
//   engine.request("tari_getSubstate", { substate_id: budget })  -> parseBudgetSubstate (0.50 CBOR)
//   engine.request("tari_signAndSubmitTransaction", { ... payTx(700) ... })   -> in-cap, COMMITS, spent moves
//   engine.request("tari_signAndSubmitTransaction", { ... payTx(5000) ... })  -> over cap, chain ABORTS
//
// Verified on a local tari-ootle 0.50.1 swarm (indexer 127.0.0.1:12008). Run in WSL ext4:
//   node --experimental-wasm-modules --experimental-global-webcrypto node/engine-openpay.mjs
// Config via env: AGENT_TEMPLATE, MERCHANT (whitelisted payee); INDEXER_URL to override the indexer;
// BUDGET to reuse an existing budget instead of opening a fresh one.
//
// The dev key + funded account are loaded from ../.spike-key.json (shared with flow-a); the account
// must already exist and hold funds. 0.50.1's random keygen traps without Node webcrypto, hence the
// --experimental-global-webcrypto flag above (the SDK's internal seal keypair needs global crypto too).
import fs from "node:fs";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto; // 0.50.1 keygen/seal need global WebCrypto in Node
import { Network } from "@tari-project/ootle";
import { decodeExecuteResult } from "@tari-project/ootle-wasm-bor";
import { L2Wallet } from "../src/l2-wallet.mjs";
import { openBudgetTx, payTx, templateEvents, parseBudgetSubstate } from "../src/agentpay-tx.js";
import { connectIndexer, accountVaults } from "../src/chain.js";

const INDEXER_URL = process.env.INDEXER_URL ?? "http://127.0.0.1:12008";
const TEMPLATE = process.env.AGENT_TEMPLATE ?? "template_c4b58558181f19c17d6ccc75c93e0707e2c5b75d1ef4de96a70acd0fd2d40e47";
const MERCHANT = process.env.MERCHANT ?? "component_c5c2db90a8f9f02981617244b835fd36d4830bdcb80eb7f5cb092932896924e3";
let BUDGET = process.env.BUDGET || null;

// --- dev key + funded account (non-custodial: the secret stays local) ---------------------------
const KEY_FILE = new URL("../.spike-key.json", import.meta.url);
if (!fs.existsSync(KEY_FILE)) throw new Error(`need a funded dev key at ${KEY_FILE.pathname} (run flow-a once, or create/fund an account first)`);
const key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
if (!key.account) throw new Error(".spike-key.json has no account — fund one first (flow-a does this via the faucet)");
const ACCOUNT = key.account;

const w = new L2Wallet({ ownerSecretHex: key.owner, viewSecretHex: key.view, network: Network.LocalNet, indexerUrl: INDEXER_URL, account: ACCOUNT });
const provider = await connectIndexer(INDEXER_URL, Network.LocalNet);
console.log(`engine account ${ACCOUNT}\ntemplate ${TEMPLATE}\nmerchant ${MERCHANT}\nindexer  ${INDEXER_URL}\n`);

// recursively collect component_ addresses out of a (decoded) receipt execution result
const collect = (x, pfx, out = new Set()) => {
  if (!x) return out;
  if (typeof x === "string") { if (x.startsWith(pfx)) out.add(x); return out; }
  if (Array.isArray(x)) { x.forEach((v) => collect(v, pfx, out)); return out; }
  if (typeof x === "object") Object.values(x).forEach((v) => collect(v, pfx, out));
  return out;
};
const commit = (r, label) => {
  const d = r?.result?.Finalized?.final_decision;
  if (d !== "Commit") throw new Error(`${label} not committed (final_decision=${d}): ${JSON.stringify(r?.result?.Finalized).slice(0, 300)}`);
  return r;
};
const readBudget = async (b) => parseBudgetSubstate(await w.request("tari_getSubstate", { substate_id: b }));
const sign = (unsignedTransaction) => w.request("tari_signAndSubmitTransaction", { unsignedTransaction });

// --- OPEN (unless reusing $BUDGET) --------------------------------------------------------------
if (!BUDGET) {
  console.log("== OPEN (fund 5000, caps 1000/1500, whitelist=merchant) ==");
  const openReceipt = commit(await sign(openBudgetTx({
    network: Network.LocalNet, maxEpoch: await w.maxEpoch(), template: TEMPLATE, owner: ACCOUNT,
    ownerVaults: await accountVaults(provider, ACCOUNT), fund: 5_000, perTxCap: 1_000, dailyCap: 1_500,
    epochsPerWindow: 10, whitelist: [MERCHANT], maxFee: 200_000,
  })), "open");
  // 0.50 CBOR-encodes execution_result; decode before scanning for the new component.
  let exec = openReceipt.result.Finalized.execution_result;
  if (typeof exec === "string") exec = JSON.parse(decodeExecuteResult(exec));
  BUDGET = [...collect(exec, "component_")].find((c) => c !== ACCOUNT && c !== MERCHANT);
  if (!BUDGET) throw new Error("open committed but no new budget component found in the receipt");
  console.log("  budget:", BUDGET);
} else {
  console.log("== reusing budget", BUDGET, "==");
}

const b0 = await readBudget(BUDGET);
console.log(`  vault ${b0.vault}\n  agentBadge ${b0.agentBadge}\n  caps ${b0.perTxCap}/${b0.dailyCap}  spent ${b0.spentInWindow}  whitelist ${b0.whitelist.join(",")}`);

// --- PAY 700 (in cap) ---------------------------------------------------------------------------
// CONTRACT: re-fetch the agent's vaults AFTER open — the open minted the agent-badge vault that
// create_proof_by_non_fungible_ids needs here. A stale pre-open list makes the chain commit only the
// fee and silently reject budget.pay (final_decision still reads Commit, but spent_in_window is unchanged).
const payParams = {
  network: Network.LocalNet, maxEpoch: await w.maxEpoch(), agent: ACCOUNT,
  agentVaults: await accountVaults(provider, ACCOUNT), budget: BUDGET, budgetVault: b0.vault,
  agentBadge: b0.agentBadge, session: "default", merchant: MERCHANT,
  merchantVaults: await accountVaults(provider, MERCHANT), amount: 700, memo: "engine pay 700", maxFee: 200_000,
};
console.log("\n== PAY 700 (in-cap) through the engine ==");
const payReceipt = commit(await sign(payTx(payParams)), "pay 700");
const events = templateEvents(payReceipt, TEMPLATE);
const b1 = await readBudget(BUDGET);
console.log(`  COMMITTED; AgentBudget events: ${events.map((e) => e.topic).join(",") || "(none)"}`);
console.log(`  spent_in_window ${b0.spentInWindow} -> ${b1.spentInWindow}`);
if (b1.spentInWindow <= b0.spentInWindow) throw new Error("in-cap pay committed but spent did not move — stale vault list? (see payTx contract)");

// --- PAY 5000 (over cap) — submit for REAL, the chain aborts the pay -----------------------------
console.log("\n== PAY 5000 (> perTxCap 1000) — submit for real, expect CHAIN ABORT ==");
let aborted = false, reason = "";
try {
  const oc = await sign(payTx({ ...payParams, maxEpoch: await w.maxEpoch(), amount: 5_000, memo: "over cap" }));
  const ad = oc?.result?.Finalized?.abort_details;
  reason = typeof ad === "string" ? ad : JSON.stringify(ad);
  console.log("  final_decision:", oc?.result?.Finalized?.final_decision, "abort_details:", String(reason).slice(0, 220));
} catch (e) {
  // signSealSubmit throws on a non-Commit outcome (AcceptFeeRejectRest): the fee committed, the pay was rejected.
  aborted = true;
  reason = (e.outcome ? e.outcome + ": " : "") + (e.reason ?? e.message);
  console.log("  chain refused the pay:", String(reason).slice(0, 220));
}
const b2 = await readBudget(BUDGET);
const held = b2.spentInWindow === b1.spentInWindow;
console.log(`  spent_in_window ${b1.spentInWindow} -> ${b2.spentInWindow} ${held ? "(cap HELD — over-cap pay had no effect)" : "(!! moved — cap NOT enforced)"}`);

const capProven = held && /per-transaction cap|exceed|reject|abort|FeeIntentCommit|AcceptFeeRejectRest/i.test(reason || (aborted ? "abort" : ""));
console.log(b1.spentInWindow > b0.spentInWindow && capProven
  ? "\n✔✔ OPEN + in-cap PAY committed on the live chain; over-cap PAY aborted (spent unchanged) — all through the self-built non-custodial engine."
  : "\n(partial — see above)");
provider.stopWatcher?.();
