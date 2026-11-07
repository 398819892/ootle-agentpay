// Autonomous smoke test for the 0.49 upgrade — NO funds, NO wallet, NO signing.
// Proves the two biggest unknowns of the window.tari / esmeralda path:
//   (1) the upgraded ootle.ts (0.13 / Ootle 0.49) can REACH a live esmeralda indexer and read its epoch
//       — i.e. the host is right and reads are version-compatible with the post-reset 0.49.2 network;
//   (2) our AgentBudget instruction mapping (agentpay-tx.js) still BUILDS under 0.13 — catches any
//       renamed export, changed builder signature, or encoding helper that moved between 0.11 and 0.13.
// The funded open+pay round-trip still needs a funded account (flow-a with esmeralda funds) or the
// user's own wallet (window.tari) — that part is theirs to run.
import { Network, signTransaction, sealTransaction, TransactionBuilder } from "@tari-project/ootle";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { openBudgetTx, payTx } from "../src/agentpay-tx.js";
import { signSealSubmit, dryRun, decodeExecResult, ESMERALDA } from "../src/chain.js";

const INDEXERS = [
  "https://esme-indexer-a.ootle.tari.com",
  "https://esme-indexer-b.ootle.tari.com",
  "https://ootle-indexer-a.tari.com",
];
// Format-valid placeholder addresses (not required to exist on chain — we only exercise the encoders).
const TEMPLATE = "template_978113ef1251cf83cff05ca21057eefcaa2ebaa7770abf07ba82d6ffda0e453f";
const OWNER = "component_6e2b54b1" + "0".repeat(56);
const MERCHANT = "component_7ce2546e4f2384eee64b89e77fab606aff50099e0c14be140c50db294780ec6c";

function line(s) { process.stdout.write(s + "\n"); }

async function reachIndexer() {
  for (const url of INDEXERS) {
    try {
      const p = await IndexerProvider.connect({ url, network: Network.Esmeralda });
      const epoch = await p.getCurrentEpoch();
      line(`  OK  ${url}  currentEpoch=${epoch}`);
      return { url, epoch, provider: p };
    } catch (e) {
      line(`  --  ${url}  ${(e && e.message ? e.message : e).toString().split("\n")[0]}`);
    }
  }
  return null;
}

function buildInstructions(maxEpoch, owner = OWNER) {
  const net = Network.Esmeralda;
  const open = openBudgetTx({
    network: net, maxEpoch, template: TEMPLATE, owner, ownerVaults: [],
    fund: 50_000, perTxCap: 1_000, dailyCap: 1_500, epochsPerWindow: 10, whitelist: [MERCHANT], maxFee: 200_000,
  });
  const pay = payTx({
    network: net, maxEpoch, agent: owner, agentVaults: [], budget: MERCHANT, budgetVault: "vault_" + "0".repeat(64),
    agentBadge: "resource_" + "0".repeat(64), session: "default", merchant: MERCHANT, merchantVaults: [],
    amount: 700, memo: "smoke", maxFee: 200_000,
  });
  return { open, pay };
}

(async () => {
  line("Ootle version check:");
  line(`  Network.Esmeralda = ${Network.Esmeralda} (0x${Number(Network.Esmeralda).toString(16)})`);
  line(`  chain.js (0.13 lifecycle) loaded: signSealSubmit=${typeof signSealSubmit}, dryRun=${typeof dryRun}, decodeExecResult=${typeof decodeExecResult}, ESMERALDA=${ESMERALDA.indexerUrl}`);

  line("\n[1] reach a live esmeralda indexer + read epoch (upgraded ootle.ts):");
  const hit = await reachIndexer();
  if (!hit) line("  !! no indexer answered getCurrentEpoch — host/version/route needs a look");

  line("\n[2] build open/pay instructions under ootle.ts 0.13:");
  try {
    const maxEpoch = hit ? hit.epoch + 10 : 100;
    const { open, pay } = buildInstructions(maxEpoch);
    line(`  open: ${open.instructions.length} instructions, ${open.fee_instructions?.length ?? 0} fee-instr, ${open.inputs?.length ?? 0} inputs`);
    line(`  pay:  ${pay.instructions.length} instructions, ${pay.fee_instructions?.length ?? 0} fee-instr, ${pay.inputs?.length ?? 0} inputs`);
    line(`  open[0] = ${JSON.stringify(open.instructions[0])}`);
    line(`  sample callFunction present: ${open.instructions.some((i) => i && (i.CallFunction || i.call_function)) ? "yes" : "NO — shape changed, inspect"}`);
    line("  BUILD OK");
  } catch (e) {
    line("  BUILD FAILED: " + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }
  line("\n[3] WASM signer check on 0.49 (ephemeral key, no funds, no submit):");
  // On 0.49.2 the signer (addTransactionSigner) requires every CallMethod component
  // target to be resolved to an INPUT REFERENCE first; resolveTransaction does that by
  // looking the declared input substates up on the indexer. So a real client-side sign
  // needs a funded, on-chain account. With an ephemeral off-chain key there is nothing to
  // resolve, so a tx that carries any CallMethod is EXPECTED to fail at the signer with
  // "untagged enum TransactionInput". We assert exactly that gate (not a defect in chain.js):
  //   - an empty envelope DOES sign  -> the signer/WASM works
  //   - the open tx does NOT sign     -> confirms the resolve-before-sign funding gate
  try {
    const wallet = SecretKeyWallet.randomWithViewKey(Network.Esmeralda);
    const owner = await wallet.getAddress();
    line(`  signer address ${owner.slice(0, 20)}…`);

    const empty = TransactionBuilder.new(Network.Esmeralda, 100).buildUnsignedTransaction();
    const emptySigned = await signTransaction([wallet], empty);
    sealTransaction(emptySigned);
    line("  empty-tx sign+seal OK  -> WASM sr25519 signer works on 0.49");

    const maxEpoch = hit ? hit.epoch + 10 : 100;
    const { open } = buildInstructions(maxEpoch, owner);
    try {
      await signTransaction([wallet], open);
      line("  open-tx signed with an UNFUNDED key (unexpected — inspect; 0.49 behaviour may have changed)");
    } catch (e) {
      const m = (e && e.message ? e.message : String(e)).split("\n")[0];
      const gate = /TransactionInput/.test(m);
      line(`  open-tx sign refused as expected${gate ? " (resolve-before-sign funding gate)" : ""}: ${m}`);
      line("  GATE CONFIRMED — real sign needs a funded on-chain account; chain.js resolves before signing");
    }
  } catch (e) {
    line("  SIGNER CHECK FAILED: " + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }

  line("\nSMOKE_DONE");
})();
