// Offline harness for the self-built L2 wallet (src/l2-wallet.mjs).
//
// What this CAN prove without a chain: the wallet holds a local key (non-custodial identity), exposes the
// exact window.tari provider contract the dapp speaks, and ROUTES signAndSubmit / getSubstate into the
// REAL Ootle lifecycle (chain.js) instead of returning canned data. It proves routing by injecting a
// "sentinel" indexer provider that throws the moment the real lifecycle touches it — so reaching that
// throw == the real path was entered.
//
// What it CANNOT prove offline, by design: a real signature. An Ootle tx is signed only after
// resolveTransaction stamps the signer + input versions against a live indexer (the builder leaves
// main_signer:"None"). So a real signature/payment needs a running indexer + a funded account — the known
// L2 gate, verified separately once a node is up. This harness asserts the engine is correct up to that
// boundary.
import assert from "node:assert";
import { Network, fromHexStr } from "@tari-project/ootle";
import { L2Wallet, networkName } from "../src/l2-wallet.mjs";
import { openBudgetTx } from "../src/agentpay-tx.js";

let pass = 0;
const ok = (name) => { pass++; console.log("  ✓", name); };
const h = (b) => b.repeat(32);

// Valid small sr25519 scalars (high byte 0 keeps them < group order; 0x11.. fails "Invalid canonical scalar").
const OWNER_SECRET = "01" + "00".repeat(31);
const VIEW_SECRET = "02" + "00".repeat(31);
const ACCOUNT = "component_" + h("ac");

// A provider that throws a tagged error the instant the real lifecycle calls into it. Any property read
// returns a thrower, so resolveTransaction / getSubstate trip it as soon as they reach the network.
const SENTINEL = "SENTINEL_PROVIDER_REACHED";
// Exclude `then` so the proxy is NOT a thenable — otherwise `await indexer()` would trip it before the
// handler actually calls a provider method. This way only a real resolve/getSubstate call throws.
const sentinelProvider = new Proxy({}, { get: (_t, prop) => prop === "then" ? undefined : (...a) => { throw new Error(`${SENTINEL}:${String(prop)}`); } });

// A real unsigned open-budget tx (what our dapp would hand the wallet).
const unsigned = openBudgetTx({
  network: Network.Esmeralda, maxEpoch: 1000, template: "template_" + h("22"),
  owner: ACCOUNT, ownerVaults: [], fund: 50_000, perTxCap: 1_000,
  dailyCap: 1_500, epochsPerWindow: 10, whitelist: ["component_" + h("11")], maxFee: 200_000,
});

console.log("L2 wallet engine — offline checks\n");

// 1. Non-custodial identity: the key is imported locally and the wallet constructs (no random keygen,
//    which 0.50.1 traps on).
console.log("1. local key → wallet");
const w = new L2Wallet({ ownerSecretHex: OWNER_SECRET, viewSecretHex: VIEW_SECRET, network: Network.Esmeralda, account: ACCOUNT, provider: sentinelProvider });
assert.ok(w.wallet, "SecretKeyWallet constructed from local bytes");
ok("constructs SecretKeyWallet from local secret bytes (non-custodial)");
assert.throws(() => new L2Wallet({ ownerSecretHex: "11".repeat(32), viewSecretHex: VIEW_SECRET, network: Network.Esmeralda }),
  /scalar|canonical/i, "rejects a non-canonical scalar");
ok("rejects an invalid (non-canonical) secret");

// 2. window.tari surface shape — what the dapp sees.
console.log("\n2. window.tari provider surface");
const tari = w.windowTari();
assert.equal(tari.isTariWallet, true, "advertises isTariWallet");
assert.equal(typeof tari.request, "function", "exposes request()");
ok("windowTari() = { isTariWallet:true, request() } (same shape as Tari Universe / Sapient)");

// 3. Pure (no-chain) RPCs answer correctly.
console.log("\n3. offline RPCs");
assert.equal(await tari.request({ method: "tari_getNetwork" }), "esmeralda");
ok("tari_getNetwork → \"esmeralda\"");
assert.equal(networkName(Network.LocalNet), "localnet");
assert.deepEqual(await tari.request({ method: "tari_requestAccounts" }), [ACCOUNT]);
ok("tari_requestAccounts → [account]");
const noAcct = new L2Wallet({ ownerSecretHex: OWNER_SECRET, viewSecretHex: VIEW_SECRET, network: Network.Esmeralda, provider: sentinelProvider });
await assert.rejects(() => noAcct.request("tari_requestAccounts"), /no account yet/, "requestAccounts before funding is refused");
ok("tari_requestAccounts before an account exists → refused");

// 4. Guards / error codes.
console.log("\n4. guards");
await assert.rejects(() => w.request("tari_signAndSubmitTransaction", {}), /unsignedTransaction/, "needs the built tx");
ok("signAndSubmit without a tx → clear error");
await assert.rejects(() => w.request("tari_totally_made_up"), (e) => e.code === 4200, "unknown method rejected");
ok("unsupported method → code 4200");

// 5. Routing: signAndSubmit and getSubstate enter the REAL lifecycle (hit the injected provider),
//    i.e. they are NOT canned. Reaching the sentinel == the real chain.js path ran.
console.log("\n5. routes into the real Ootle lifecycle (not canned)");
const reachedReal = async (fn) => {
  try { await fn(); return "returned-without-chain"; }
  catch (e) { return e.message; }
};
const subMsg = await reachedReal(() => w.request("tari_getSubstate", { substateId: ACCOUNT }));
assert.ok(subMsg.includes(SENTINEL), `getSubstate must reach the indexer (got: ${subMsg})`);
ok("tari_getSubstate → calls the real indexer provider");

// (a) own-stack shortcut: a full unsigned tx is signed as-is → resolve touches the provider.
const fullMsg = await reachedReal(() => w.request("tari_signAndSubmitTransaction", { unsignedTransaction: unsigned }));
assert.ok(fullMsg !== "returned-without-chain" && !/unsupported method/.test(fullMsg),
  `full-tx sign must enter resolve→sign→submit (got: ${fullMsg})`);
ok(`signAndSubmit { unsignedTransaction } → real lifecycle (boundary: "${fullMsg.slice(0, 48)}")`);

// (b) STANDARD window.tari contract: { instructions, maxFee, inputs } → wallet rebuilds, then signs.
//     The rebuild asks the indexer for the max epoch first, so the sentinel trips there.
const stdMsg = await reachedReal(() => w.request("tari_signAndSubmitTransaction",
  { instructions: unsigned.instructions, maxFee: 200_000, inputs: unsigned.inputs }));
assert.ok(stdMsg.includes(SENTINEL), `standard-contract sign must rebuild against the indexer (got: ${stdMsg})`);
ok(`signAndSubmit { instructions, maxFee, inputs } → rebuilds + enters real lifecycle (boundary: "${stdMsg.slice(0, 48)}")`);

console.log(`\n✔ ${pass}/${pass} offline checks passed.`);
console.log("ℹ Real signature/submit is gated on a live indexer + a funded account (resolveTransaction needs the chain); that is verified separately once a node is up.");
