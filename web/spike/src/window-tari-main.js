// Spike flow C: user's OWN wallet via window.tari (Sapient extension or Tari Universe web wallet).
// No backend, no user-run walletd, no browser-held key. Reuses the SAME AgentBudget instruction mapping
// as flows A/B (agentpay-tx.js); only the signer/submit layer changes to the wallet's own popup.
import { openBudgetTx, payTx, findNewComponent, templateEvents, parseBudgetSubstate } from "./agentpay-tx.js";
import { TariWindowWallet, coreInstructions, describeTariError } from "./tari-window.js";

const $ = (id) => document.getElementById(id);
const short = (s) => (s ? s.slice(0, 14) + "…" + s.slice(-6) : "");
function logger(id) {
  const el = $(id);
  return (msg, cls = "") => {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  };
}
const enable = (ids, on = true) => ids.forEach((i) => ($(i).disabled = !on));
const log = logger("c-log");
const cfg = () => ({ template: $("cfg-template").value.trim(), merchant: $("cfg-merchant").value.trim() });

// The wallet rebuilds the transaction from our raw instructions (sets epochs, adds the fee, signs,
// submits), so the maxEpoch we pass to the builder is never used on this path — 0 is a placeholder.
const BUILD_EPOCH = 0;
const network = () => (C.wallet.network === "igor" ? "igor" : "esmeralda");
// Network enum value the instruction encoders need. VERIFY against @tari-project/ootle's Network enum
// for the running SDK version (Esmeralda 0x26 / Igor 0x24 at the versions we read).
const NETWORK_ID = () => (C.wallet.network === "igor" ? 0x24 : 0x26);

const C = { wallet: null, budget: null, state: null };

$("c-connect").onclick = async () => {
  enable(["c-connect"], false);
  try {
    C.wallet = await TariWindowWallet.connect();
    $("c-acct").textContent = `account ${C.wallet.account}\nnetwork ${C.wallet.network}`;
    log(`connected to ${C.wallet.network}; account ${short(C.wallet.account)} — the key stays in the wallet`, "ok");
    enable(["c-open"]);
  } catch (e) {
    log(`connect failed: ${describeTariError(e)}`, "bad");
    enable(["c-connect"]);
  }
};

$("c-open").onclick = async () => {
  enable(["c-open"], false);
  try {
    const c = cfg();
    // Owner = the connected account. We hand the wallet instructions only and let it discover inputs
    // (the integration docs say inputs are "purely an optimization"), so we pass empty vault lists.
    const unsigned = openBudgetTx({
      network: NETWORK_ID(), maxEpoch: BUILD_EPOCH, template: c.template, owner: C.wallet.account,
      ownerVaults: [], fund: 50_000, perTxCap: 1_000, dailyCap: 1_500, epochsPerWindow: 10,
      whitelist: [c.merchant], maxFee: 200_000,
    });
    const instructions = coreInstructions(unsigned);
    log(`open: ${instructions.length} instructions → approve in your wallet…`);
    const { result } = await C.wallet.createApproveSubmit(instructions, {
      maxFee: 200_000n,
      onPending: (id) => log(`request ${short(String(id))} is waiting for your approval in the wallet popup`),
    });
    // VERIFY: the wallet's result shape vs findNewComponent (expects receipt.result = {Finalized:…}).
    const receipt = normaliseReceipt(result);
    C.budget = findNewComponent(receipt, [C.wallet.account, c.merchant]);
    if (!C.budget) throw new Error("could not find the new budget component in the result (check receipt shape)");
    C.state = parseBudgetSubstate(await C.wallet.getSubstate(C.budget));
    log(`open COMMITTED → budget ${C.budget}`, "ok");
    log(`  ownerBadge ${short(C.state.ownerBadge)}  agentBadge ${short(C.state.agentBadge)}  caps ${C.state.perTxCap}/${C.state.dailyCap}`);
    enable(["c-pay", "c-over"]);
  } catch (e) {
    log(`open failed: ${describeTariError(e)}`, "bad");
    enable(["c-open"]);
  }
};

// In a pure self-custody model the agent runs its own wallet; for this one-account demo the same
// connected account also acts as the agent. The budget's agent badge is in the owner account here.
$("c-pay").onclick = () => doPay(700, true);
$("c-over").onclick = () => doPay(5_000, false);

async function doPay(amount, realSubmit) {
  enable(["c-pay", "c-over"], false);
  try {
    const c = cfg();
    const unsigned = payTx({
      network: NETWORK_ID(), maxEpoch: BUILD_EPOCH, agent: C.wallet.account, agentVaults: [],
      budget: C.budget, budgetVault: C.state.vault, agentBadge: C.state.agentBadge, session: "default",
      merchant: c.merchant, merchantVaults: [], amount, memo: `window.tari spike pay ${amount}`, maxFee: 200_000,
    });
    const instructions = coreInstructions(unsigned);
    if (!realSubmit) {
      log(`dry-run pay ${amount} (over the ${C.state.perTxCap} cap) → no popup…`);
      const res = await C.wallet.dryRun(instructions);
      const fin = normaliseReceipt(res)?.result?.Finalized?.execution_result?.finalize?.result ?? res;
      const accept = fin && typeof fin === "object" && "Accept" in fin;
      log(`dry-run → ${accept ? "ACCEPT (unexpected over cap)" : "REJECT (hard cap enforced on chain)"}`, accept ? "bad" : "ok");
      return;
    }
    log(`pay ${amount}: prove one session badge → approve in your wallet…`);
    const { result } = await C.wallet.createApproveSubmit(instructions, {
      maxFee: 200_000n,
      onPending: (id) => log(`request ${short(String(id))} waiting for approval`),
    });
    const receipt = normaliseReceipt(result);
    const evs = templateEvents(receipt, c.template).filter((e) => e.topic?.startsWith?.("AgentBudget."));
    log(`pay COMMITTED`, "ok");
    for (const e of evs) log(`  event ${e.topic} ${JSON.stringify(e.payload)}`);
    const after = parseBudgetSubstate(await C.wallet.getSubstate(C.budget));
    log(`  spent_in_window ${C.state.spentInWindow} → ${after.spentInWindow}`);
    C.state.spentInWindow = after.spentInWindow;
  } catch (e) {
    log(`pay failed: ${describeTariError(e)}`, "bad");
  } finally {
    enable(["c-pay", "c-over"]);
  }
}

// The wallet may return the finalize result directly, or wrapped. findNewComponent/templateEvents read
// `receipt.result` (= "Pending" | {Finalized:…}); normalise the common shapes. VERIFY on a live wallet.
function normaliseReceipt(result) {
  if (!result || typeof result !== "object") return { result };
  if ("result" in result) return result; // already {result: …}
  if ("Finalized" in result) return { result };
  return { result: { Finalized: result } }; // bare execution/finalize object
}
