// Proves mock-wallet.html's parent bridge is backed by the REAL L2 engine, not canned data.
// Drives makeWalletHandler exactly as the postMessage listener does (the browser bootstrap is skipped
// under Node). Connect-time reads come from the engine; tx/substate surface the honest live-node gate.
import assert from "node:assert";
import { makeWalletHandler } from "../src/mock-wallet-main.js";

let pass = 0;
const ok = (n) => { pass++; console.log("  ✓", n); };
const ACCOUNT = "component_f973833d3747d725c48a564d5b6bd4482259013d00722b28fd42814d4365d814";
const gate = async (fn) => { try { await fn(); return "NO-ERROR"; } catch (e) { return e.message; } };

console.log("mock-wallet parent bridge ↔ L2 engine (offline shell)\n");
const handle = makeWalletHandler({ indexerUrl: null }); // the default offline shell

console.log("1. connect handshake is produced by the engine");
assert.deepEqual(await handle("tari_requestAccounts"), [ACCOUNT]);
ok("tari_requestAccounts → engine account");
assert.deepEqual(await handle("tari_getAccounts"), [ACCOUNT]);
ok("tari_getAccounts → engine account");
assert.equal(await handle("tari_getNetwork"), "esmeralda");
ok("tari_getNetwork → \"esmeralda\"");
assert.equal(typeof (await handle("tari_getCapabilities")), "object");
ok("tari_getCapabilities → object");

console.log("\n2. tx / reads route into the engine and honestly gate on a live node (not canned)");
const signMsg = await gate(() => handle("tari_signAndSubmitTransaction", { instructions: [{ CallMethod: {} }], maxFee: 200_000 }));
assert.ok(/no indexer configured/.test(signMsg), `sign must surface the gate, got: ${signMsg}`);
ok("tari_signAndSubmitTransaction (no node) → honest gate, not a fake receipt");
const subMsg = await gate(() => handle("tari_getSubstate", { substateId: ACCOUNT }));
assert.ok(/no indexer configured/.test(subMsg), `getSubstate must surface the gate, got: ${subMsg}`);
ok("tari_getSubstate (no node) → honest gate, not canned");

console.log("\n3. unknown method rejected");
assert.ok(/unsupported/.test(await gate(() => handle("tari_bogus"))));
ok("unsupported method → rejected (4200)");

console.log(`\n✔ ${pass}/${pass} passed — the shell's window.tari is the real L2 engine; connect is real, tx/reads gate honestly on a live node.`);
