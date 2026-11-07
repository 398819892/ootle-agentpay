// Proves openBudgetTx is asset-generic: it funds with p.resource (default native XTR, or any L2
// resource such as a stablecoin), while the AgentBudget template already locks whatever resource it is
// given (templates/agent_budget/src/lib.rs: "locks whatever resource it is funded with … not bound to a
// single token"). Offline — just inspects the built instruction + input shapes.
import assert from "node:assert";
import { Network, resourceAddressLiteral } from "@tari-project/ootle";
import { openBudgetTx, XTR } from "../src/agentpay-tx.js";

let pass = 0;
const ok = (n) => { pass++; console.log("  ✓", n); };
const h = (b) => b.repeat(32);
const STABLE = "resource_" + h("5c"); // a hypothetical L2 stablecoin resource

const base = {
  network: Network.Esmeralda, maxEpoch: 1000, template: "template_" + h("22"),
  owner: "component_" + h("f9"), ownerVaults: ["vault_" + h("a1")], fund: 50_000,
  perTxCap: 1_000, dailyCap: 1_500, epochsPerWindow: 10, whitelist: ["component_" + h("11")], maxFee: 200_000,
};
const withdrawArg = (tx) => {
  const ins = tx.instructions.find((i) => i.CallMethod && i.CallMethod.method === "withdraw");
  assert.ok(ins, "an open tx must contain a withdraw CallMethod");
  return ins.CallMethod.args[0]; // the resource literal
};
const inputIds = (tx) => tx.inputs.map((i) => i.substate_id);

console.log("openBudgetTx asset-generic check\n");

// 1. default = native XTR, and byte-for-byte identical to passing resource: XTR explicitly (back-compat).
console.log("1. default funding resource = native XTR");
const def = openBudgetTx(base);
assert.deepEqual(withdrawArg(def), resourceAddressLiteral(XTR));
ok("withdraw uses XTR when p.resource is omitted");
const xtrExplicit = openBudgetTx({ ...base, resource: XTR });
assert.deepEqual(def.instructions, xtrExplicit.instructions, "omitting resource == resource:XTR");
assert.deepEqual(def.inputs, xtrExplicit.inputs);
ok("omitting p.resource is identical to p.resource = XTR (unchanged default)");
assert.ok(inputIds(def).filter((id) => id === XTR).length === 1, "XTR declared exactly once");
ok("XTR declared as a read input exactly once (no duplicate)");

// 2. a stablecoin resource flows through the withdraw + inputs; fee still declares native XTR.
console.log("\n2. funding with a stablecoin resource");
const stable = openBudgetTx({ ...base, resource: STABLE });
assert.deepEqual(withdrawArg(stable), resourceAddressLiteral(STABLE));
ok("withdraw uses the stablecoin resource when p.resource is set");
assert.ok(inputIds(stable).includes(STABLE), "stablecoin declared as a read input");
ok("stablecoin resource declared as a read input");
assert.ok(inputIds(stable).includes(XTR), "native XTR still declared for the fee");
ok("native XTR still declared as an input (the fee is always paid in XTR)");

// 3. everything else (caps, badges, deposits, whitelist) is unchanged by the resource swap.
console.log("\n3. only the funding resource changed");
const methods = (tx) => tx.instructions.map((i) => i.CallMethod?.method ?? i.CallFunction?.function ?? Object.keys(i)[0]);
assert.deepEqual(methods(stable), methods(def));
ok("instruction sequence (withdraw/new/deposit×2) is the same shape");

console.log(`\n✔ ${pass}/${pass} passed — budget is asset-generic: XTR today, a stablecoin by passing p.resource; template already resource-agnostic.`);
