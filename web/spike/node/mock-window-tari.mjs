// Path C (window.tari) — offline contract harness.
//
// What this DOES verify, with NO wallet, NO funds, NO on-chain template:
//   1. The adapter (src/tari-window.js) drives the CONFIRMED window.tari request contract:
//      connect -> tari_requestAccounts + tari_getNetwork; raw AgentBudget instructions ->
//      tari_signAndSubmitTransaction { instructions, maxFee:"<string>" }; over-cap preview ->
//      the SAME method with dryRun:true and no approval; reads -> tari_getSubstate.
//   2. network normalisation accepts a name ("esmeralda") OR the numeric byte (38).
//   3. The real 0.49.2 WASM builders (src/agentpay-tx.js: openBudgetTx/payTx) produce non-empty,
//      structurally valid instruction arrays, and coreInstructions() keeps the fee OUT of the body.
//   4. The receipt/substate readers (findNewComponent / templateEvents / parseBudgetSubstate) and
//      the page's normaliseReceipt glue accept the shapes the integration docs describe.
//   5. describeTariError maps a { code, message } wallet rejection.
//
// What this CANNOT verify (only a live, funded esmeralda wallet can — the README `VERIFY:` items):
//   - the wallet's ACTUAL return/receipt/substate shapes (the canned shapes below are the documented
//     ASSUMPTIONS, not proof); whether dryRun truly suppresses the popup; the real numeric error codes;
//     and of course the on-chain hard-cap rejection itself. Those are the fund-dependent half.
//
// Run: node --experimental-wasm-modules node/mock-window-tari.mjs

// --- minimal browser globals the adapter touches (getTariProvider reads window.tari / addEventListener)
const listeners = {};
globalThis.window = {
  addEventListener: (k, fn) => { (listeners[k] ??= []).push(fn); },
  removeEventListener: (k, fn) => { listeners[k] = (listeners[k] ?? []).filter((f) => f !== fn); },
};

const { TariWindowWallet, coreInstructions, describeTariError, normaliseNetwork } =
  await import("../src/tari-window.js");
const { openBudgetTx, payTx, findNewComponent, templateEvents, parseBudgetSubstate } =
  await import("../src/agentpay-tx.js");

// --- test fixtures (structurally valid 64-hex ids; owner is the real walletd account from this session)
const h = (b) => b.repeat(32); // 64-hex
const OWNER = "component_f973833d3747d725c48a564d5b6bd4482259013d00722b28fd42814d4365d814";
const MERCHANT = "component_" + h("11");
const TEMPLATE = "template_" + h("22");
const NEWBUDGET = "component_" + h("33");
const VAULT = h("44"), OBADGE = h("55"), ABADGE = h("66");
const NETWORK_ID = 0x26; // esmeralda (window-tari-main.js)

// --- a mock window.tari that records every request and returns documented-shaped canned data
function makeMock({ account = OWNER, network = "esmeralda", failWith = null } = {}) {
  const calls = [];
  const openReceipt = { Finalized: { execution_result: { finalize: { result: {
    Accept: { up_substates: [[OWNER, {}], [MERCHANT, {}], [NEWBUDGET, {}]] }, events: [],
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
  let submitN = 0;
  const provider = {
    isTariWallet: true,
    async request({ method, params }) {
      calls.push({ method, params });
      if (failWith) throw failWith;
      switch (method) {
        case "tari_requestAccounts": return [account];
        case "tari_getNetwork": return network;
        case "tari_signAndSubmitTransaction":
          if (params?.dryRun) return dryRunReject;
          return (submitN++ === 0) ? openReceipt : payReceipt;
        case "tari_getSubstate": return substate;
        default: throw new Error("mock: unexpected method " + method);
      }
    },
  };
  return { provider, calls };
}

// --- tiny assert harness
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  PASS", msg); } else { fail++; console.log("  FAIL", msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

// normaliseReceipt is page glue in window-tari-main.js (not exported); copied verbatim to test it.
function normaliseReceipt(result) {
  if (!result || typeof result !== "object") return { result };
  if ("result" in result) return result;
  if ("Finalized" in result) return { result };
  return { result: { Finalized: result } };
}

console.log("== 1. connect: request contract + network normalisation ==");
{
  const { provider, calls } = makeMock({ network: "esmeralda" });
  window.tari = provider;
  const w = await TariWindowWallet.connect();
  eq(calls[0].method, "tari_requestAccounts", "first call is tari_requestAccounts");
  eq(calls[1].method, "tari_getNetwork", "second call is tari_getNetwork");
  eq(w.account, OWNER, "connected account pinned to accounts[0]");
  eq(w.network, "esmeralda", "network name normalised");
}
{
  const { provider } = makeMock({ network: 38 }); // numeric byte
  window.tari = provider;
  const w = await TariWindowWallet.connect();
  eq(w.network, "esmeralda", "numeric network byte 38 -> esmeralda");
  eq(normaliseNetwork(36), "igor", "numeric network byte 36 -> igor");
}

console.log("== 2. open: real WASM builder + signAndSubmit request shape ==");
let openInstructions;
{
  const { provider, calls } = makeMock();
  window.tari = provider;
  const w = await TariWindowWallet.connect();
  const unsigned = openBudgetTx({
    network: NETWORK_ID, maxEpoch: 0, template: TEMPLATE, owner: w.account,
    ownerVaults: [], fund: 50_000, perTxCap: 1_000, dailyCap: 1_500, epochsPerWindow: 10,
    whitelist: [MERCHANT], maxFee: 200_000,
  });
  openInstructions = coreInstructions(unsigned);
  ok(Array.isArray(openInstructions) && openInstructions.length >= 4, "open body is a non-empty instruction array");
  ok(Array.isArray(unsigned.fee_instructions) && unsigned.fee_instructions.length >= 1, "fee kept in fee_instructions");
  const bodyJson = JSON.stringify(openInstructions);
  ok(!bodyJson.includes("pay_fee"), "coreInstructions excludes the pay_fee call from the body");

  const result = await w.signAndSubmit(openInstructions, { maxFee: 200_000n });
  const last = calls[calls.length - 1];
  eq(last.method, "tari_signAndSubmitTransaction", "submit uses tari_signAndSubmitTransaction");
  ok(last.params.instructions === openInstructions, "instructions forwarded verbatim");
  eq(last.params.maxFee, "200000", "maxFee is a decimal STRING (not JS number/bigint)");
  ok(!("dryRun" in last.params), "real submit sets no dryRun flag (wallet will prompt)");

  const receipt = normaliseReceipt(result);
  const budget = findNewComponent(receipt, [OWNER, MERCHANT]);
  eq(budget, NEWBUDGET, "findNewComponent returns the new budget component, excluding owner+merchant");
  const state = parseBudgetSubstate(await w.getSubstate(budget));
  eq(state.perTxCap, 1000, "parseBudgetSubstate reads perTxCap");
  eq(state.dailyCap, 1500, "parseBudgetSubstate reads dailyCap");
  eq(state.vault, "vault_" + VAULT, "parseBudgetSubstate reads vault address");
  eq(state.whitelist, ["component_" + h("11")], "parseBudgetSubstate reads whitelist");
}

console.log("== 3. pay 700: builder + signAndSubmit + event read ==");
{
  const { provider, calls } = makeMock();
  window.tari = provider;
  const w = await TariWindowWallet.connect();
  await w.signAndSubmit([], {}); // consume the first submit slot (open) so pay uses payReceipt
  const unsigned = payTx({
    network: NETWORK_ID, maxEpoch: 0, agent: w.account, agentVaults: [],
    budget: NEWBUDGET, budgetVault: "vault_" + VAULT, agentBadge: "resource_" + ABADGE,
    session: "default", merchant: MERCHANT, merchantVaults: [], amount: 700, memo: "pay 700", maxFee: 200_000,
  });
  const instr = coreInstructions(unsigned);
  ok(Array.isArray(instr) && instr.length >= 3, "pay body is a non-empty instruction array");
  const result = await w.signAndSubmit(instr, { maxFee: 200_000n });
  eq(calls[calls.length - 1].method, "tari_signAndSubmitTransaction", "pay uses tari_signAndSubmitTransaction");
  const evs = templateEvents(normaliseReceipt(result), TEMPLATE).filter((e) => e.topic?.startsWith?.("AgentBudget."));
  eq(evs.length, 1, "templateEvents finds the AgentBudget.pay event for this template");
  eq(evs[0].topic, "AgentBudget.pay", "event topic is AgentBudget.pay");
}

console.log("== 4. over-cap dry-run: dryRun:true, no prompt, REJECT shown ==");
{
  const { provider, calls } = makeMock();
  window.tari = provider;
  const w = await TariWindowWallet.connect();
  const unsigned = payTx({
    network: NETWORK_ID, maxEpoch: 0, agent: w.account, agentVaults: [],
    budget: NEWBUDGET, budgetVault: "vault_" + VAULT, agentBadge: "resource_" + ABADGE,
    session: "default", merchant: MERCHANT, merchantVaults: [], amount: 5000, memo: "over", maxFee: 200_000,
  });
  const res = await w.dryRun(coreInstructions(unsigned));
  const last = calls[calls.length - 1];
  eq(last.method, "tari_signAndSubmitTransaction", "dry-run uses tari_signAndSubmitTransaction");
  eq(last.params.dryRun, true, "dry-run sets dryRun:true (no popup path)");
  // page logic: dig to finalize.result and check for Accept
  const fin = normaliseReceipt(res)?.result?.Finalized?.execution_result?.finalize?.result ?? res;
  const accept = fin && typeof fin === "object" && "Accept" in fin;
  ok(!accept, "over-cap dry-run result has no Accept -> page shows REJECT (hard cap)");
}

console.log("== 5. error mapping: { code, message } rejection ==");
{
  const { provider } = makeMock({ failWith: Object.assign(new Error("User rejected"), { code: 4001 }) });
  window.tari = provider;
  let msg;
  try { await TariWindowWallet.connect(); } catch (e) { msg = describeTariError(e); }
  eq(msg, "User rejected the request (4001)", "describeTariError maps code 4001");
}

console.log(`\n==== ${fail === 0 ? "ALL PASS" : "FAILURES"} : ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
