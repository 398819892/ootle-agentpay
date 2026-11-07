// Path C (window.tari) — "免确认" (no-confirm) TWO-ACCOUNT contract harness.
//
// The design the user asked for: the dApp is a holding spot ("寄存"). The owner funds a budget ONCE
// and sets a per-tx / daily cap; below that cap the agent pays with NO wallet confirmation. This is
// the AgentBudget delegation model, not an owner-wallet "skip my own popup" hack (window.tari has no
// such flag). Concretely:
//
//   - OWNER signs exactly ONE transaction (open): withdraw + AgentBudget::new + hand the agent badge to
//     a SEPARATE agent account. One Universe popup, ever.
//   - The agent later calls budget.pay with ITS OWN key, from ITS OWN signer — the owner's wallet is
//     never asked again. The chain (not the wallet UI) enforces per_tx_cap / daily_cap / whitelist.
//   - An over-cap payment is refused by the engine (shown here via the dryRun:true preview REJECT),
//     without any popup on either side.
//
// What this DOES verify, offline, with the REAL adapter + REAL 0.50.1 WASM builders:
//   1. openBudgetTx({..., agent}) routes the owner badge -> owner and the agent badge -> the SEPARATE
//      agent account (two deposits, two distinct componentAddresses), and declares the agent account
//      as a written input. (Backward compat: no `agent` => both badges to owner, same as before.)
//   2. The owner's window.tari signAndSubmit is called EXACTLY ONCE across the whole flow (the open).
//   3. Every agent payment goes through the AGENT's own signer; the owner signer is never touched again.
//   4. In-cap pays submit for real (no dryRun); the over-cap pay is previewed with dryRun:true and comes
//      back REJECT — the "hard limit" the owner never has to watch.
//
// What this CANNOT verify (fund-gated, live esmeralda only): the real receipt/substate shapes, that the
// agent key actually authorises pay on-chain, and the real on-chain cap rejection. Those stay pending.
//
// Run: node --experimental-wasm-modules node/no-confirm-flow.mjs

// --- minimal browser globals the adapter touches
const listeners = {};
globalThis.window = {
  addEventListener: (k, fn) => { (listeners[k] ??= []).push(fn); },
  removeEventListener: (k, fn) => { listeners[k] = (listeners[k] ?? []).filter((f) => f !== fn); },
};

const { TariWindowWallet, coreInstructions, describeTariError } =
  await import("../src/tari-window.js");
const { openBudgetTx, payTx, findNewComponent, templateEvents, parseBudgetSubstate } =
  await import("../src/agentpay-tx.js");

// --- fixtures: a distinct OWNER account and AGENT account (the whole point of this flow)
const h = (b) => b.repeat(32); // 64-hex
const OWNER = "component_f973833d3747d725c48a564d5b6bd4482259013d00722b28fd42814d4365d814";
const AGENT = "component_" + h("a7"); // the agent's OWN account (separate key / signer)
const MERCHANT = "component_" + h("11");
const TEMPLATE = "template_" + h("22");
const NEWBUDGET = "component_" + h("33");
const VAULT = h("44"), OBADGE = h("55"), ABADGE = h("66");
const NETWORK_ID = 0x26; // esmeralda

// --- a mock window.tari (one per signer) that records every request and returns documented shapes
function makeSigner({ account, network = "esmeralda" } = {}) {
  const calls = [];
  const openReceipt = { Finalized: { execution_result: { finalize: { result: {
    Accept: { up_substates: [[OWNER, {}], [AGENT, {}], [MERCHANT, {}], [NEWBUDGET, {}]] }, events: [],
  } } } } };
  const payReceipt = { result: { Finalized: { execution_result: { finalize: {
    result: { Accept: { up_substates: [] } },
    events: [{ template_address: h("22"), topic: "AgentBudget.pay", payload: { amount: "700" } }],
  } } } } };
  const dryRunReject = { Finalized: { execution_result: { finalize: { result: {
    Reject: { reason: "Amount exceeds the per-transaction cap" },
  } } } } };
  const substate = { substate: { Component: { body: { state: [
    { value: { hex: VAULT } }, { value: { hex: OBADGE } }, { value: { hex: ABADGE } },
    1000, 1500, 0, 12920, 10, [{ value: { hex: h("11") } }], false,
  ] } } } };
  // An "open" tx carries a CallFunction (AgentBudget::new); a "pay" tx is CallMethods only. Return the
  // matching canned receipt by shape, so a signer that only ever pays never gets an open receipt.
  const isOpen = (instructions) => (instructions ?? []).some((i) => i && typeof i === "object" && "CallFunction" in i);
  const provider = {
    isTariWallet: true,
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case "tari_requestAccounts": return [account];
        case "tari_getNetwork": return network;
        case "tari_signAndSubmitTransaction":
          if (params?.dryRun) return dryRunReject;
          return isOpen(params?.instructions) ? openReceipt : payReceipt;
        case "tari_getSubstate": return substate;
        default: throw new Error("mock: unexpected method " + method);
      }
    },
  };
  // how many times THIS signer was asked to actually sign+submit a real (non-dry-run) tx — i.e. popups
  provider.realSubmits = () => calls.filter(
    (c) => c.method === "tari_signAndSubmitTransaction" && !c.params?.dryRun).length;
  provider.dryRuns = () => calls.filter(
    (c) => c.method === "tari_signAndSubmitTransaction" && c.params?.dryRun).length;
  return { provider, calls };
}

// --- tiny assert harness
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  PASS", msg); } else { fail++; console.log("  FAIL", msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

function normaliseReceipt(result) {
  if (!result || typeof result !== "object") return { result };
  if ("result" in result) return result;
  if ("Finalized" in result) return { result };
  return { result: { Finalized: result } };
}

// Pull the target address of every `deposit` CallMethod out of a built instruction array.
// Builder shape: { CallMethod: { call: { Address: "component_…" }, method: "deposit", args: [...] } }.
function depositTargets(instructions) {
  const out = [];
  for (const ins of instructions) {
    const cm = ins?.CallMethod;
    if (cm && cm.method === "deposit") out.push(cm.call?.Address);
  }
  return out;
}

console.log("== 1. open routes the agent badge to the SEPARATE agent account ==");
let openInstructions;
{
  // two independent signers: the owner's wallet and the agent's wallet
  const owner = makeSigner({ account: OWNER });
  window.tari = owner.provider;
  const ownerWallet = await TariWindowWallet.connect();
  eq(ownerWallet.account, OWNER, "owner wallet connected to the owner account");

  const unsigned = openBudgetTx({
    network: NETWORK_ID, maxEpoch: 0, template: TEMPLATE,
    owner: OWNER, agent: AGENT, ownerVaults: [],
    fund: 50_000, perTxCap: 1_000, dailyCap: 1_500, epochsPerWindow: 10,
    whitelist: [MERCHANT], maxFee: 200_000,
  });
  openInstructions = coreInstructions(unsigned);

  const deposits = depositTargets(openInstructions);
  eq(deposits.length, 2, "open makes exactly two deposits (owner badge + agent badge)");
  eq(deposits[0], OWNER, "first deposit (owner badge) -> owner account");
  eq(deposits[1], AGENT, "second deposit (agent badge) -> the SEPARATE agent account");

  // the agent account must be a declared, writable input (it receives the badge)
  const inputIds = (unsigned.inputs ?? []).map((i) => i.substate_id ?? i.SubstateId ?? i);
  ok(JSON.stringify(inputIds).includes(AGENT), "agent account declared as an input of the open tx");

  // OWNER signs this open — exactly once
  const result = await ownerWallet.signAndSubmit(openInstructions, { maxFee: 200_000n });
  eq(owner.provider.realSubmits(), 1, "owner signed exactly ONE real tx (the open)");
  const budget = findNewComponent(normaliseReceipt(result), [OWNER, AGENT, MERCHANT]);
  eq(budget, NEWBUDGET, "new budget component identified from the open receipt");
}

console.log("\n== 2. backward compat: no `agent` => both badges to owner ==");
{
  const unsigned = openBudgetTx({
    network: NETWORK_ID, maxEpoch: 0, template: TEMPLATE,
    owner: OWNER, ownerVaults: [], // no agent
    fund: 50_000, perTxCap: 1_000, dailyCap: 1_500, epochsPerWindow: 10,
    whitelist: [MERCHANT], maxFee: 200_000,
  });
  const deposits = depositTargets(coreInstructions(unsigned));
  eq(deposits, [OWNER, OWNER], "single-account open still deposits both badges to the owner");
  const inputIds = JSON.stringify((unsigned.inputs ?? []));
  ok(!inputIds.includes(h("a7")), "single-account open does not add a stray agent input");
}

console.log("\n== 3. agent pays IN-CAP with its OWN signer — owner wallet is never asked again ==");
{
  const owner = makeSigner({ account: OWNER });
  const agent = makeSigner({ account: AGENT });

  // owner connects + opens (one popup) ...
  window.tari = owner.provider;
  const ownerWallet = await TariWindowWallet.connect();
  await ownerWallet.signAndSubmit(openInstructions, { maxFee: 200_000n });

  // ... then the AGENT connects to ITS OWN wallet and pays. The owner provider is now untouched.
  window.tari = agent.provider;
  const agentWallet = await TariWindowWallet.connect();
  eq(agentWallet.account, AGENT, "agent wallet connected to the agent account (its own key)");

  for (const amount of [700, 300]) {
    const unsigned = payTx({
      network: NETWORK_ID, maxEpoch: 0, agent: AGENT, agentVaults: [],
      budget: NEWBUDGET, budgetVault: "vault_" + VAULT, agentBadge: "resource_" + ABADGE,
      session: "default", merchant: MERCHANT, merchantVaults: [], amount, memo: "pay " + amount, maxFee: 200_000,
    });
    const result = await agentWallet.signAndSubmit(coreInstructions(unsigned), { maxFee: 200_000n });
    const evs = templateEvents(normaliseReceipt(result), TEMPLATE).filter((e) => e.topic?.startsWith?.("AgentBudget."));
    eq(evs.length, 1, `pay ${amount}: AgentBudget.pay event present`);
  }

  eq(agent.provider.realSubmits(), 2, "agent signed its own two payments");
  eq(owner.provider.realSubmits(), 1, "owner STILL at one signature — zero owner popups for the payments");
}

console.log("\n== 4. over-cap pay is refused by the engine, no popup on either side ==");
{
  const agent = makeSigner({ account: AGENT });
  window.tari = agent.provider;
  const agentWallet = await TariWindowWallet.connect();

  const unsigned = payTx({
    network: NETWORK_ID, maxEpoch: 0, agent: AGENT, agentVaults: [],
    budget: NEWBUDGET, budgetVault: "vault_" + VAULT, agentBadge: "resource_" + ABADGE,
    session: "default", merchant: MERCHANT, merchantVaults: [], amount: 5000, memo: "over", maxFee: 200_000,
  });
  const res = await agentWallet.dryRun(coreInstructions(unsigned));
  const fin = normaliseReceipt(res)?.result?.Finalized?.execution_result?.finalize?.result ?? res;
  const accept = fin && typeof fin === "object" && "Accept" in fin;
  ok(!accept, "over-cap preview returns no Accept -> engine rejects (hard cap)");
  eq(agent.provider.dryRuns(), 1, "over-cap used a dryRun preview (no popup)");
  eq(agent.provider.realSubmits(), 0, "over-cap never asked the agent wallet to sign for real");
}

console.log(`\n==== ${fail === 0 ? "ALL PASS" : "FAILURES"} : ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
