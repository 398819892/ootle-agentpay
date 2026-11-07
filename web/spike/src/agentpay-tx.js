// AgentBudget transactions as ootle.ts instruction sequences (the equivalent of the manifest
// strings in clients/ts/src/budget.ts). Shared by the Node flows and the browser page.
//
// manifest (budget.ts)                               ->  instruction (this file)
// ------------------------------------------------------------------------------------------
// let funds = owner.withdraw(XTR, amount!(fund))     ->  CallMethod owner.withdraw(resource, amount) ; saveVar("funds")
// let (comp, ob, ab) = AgentBudget::new(funds, ...)  ->  CallFunction template::new(Workspace funds, ...) ; saveVar("ret")
// owner.deposit(owner_badge)                         ->  CallMethod owner.deposit(Workspace "ret.1")
// owner.deposit(agent_badge)                         ->  CallMethod owner.deposit(Workspace "ret.2")
// let proof = agent.create_proof_by_non_fungible_ids(badge, [non_fungible_id!("s")])
//                                                    ->  CallMethod agent.create_proof_by_non_fungible_ids(resource, [NonFungibleId]) ; saveVar("proof")
// budget.pay(proof, merchant, amount!(x), "memo")    ->  CallMethod budget.pay(Workspace proof, component, amount, string)
// drop_all_proofs!()                                 ->  DropAllProofsInWorkspace
// (fee: walletd adds it for a manifest)              ->  fee_instructions: CallMethod payer.pay_fee(amount)
import {
  TransactionBuilder,
  amountLiteral,
  intLiteral,
  stringLiteral,
  componentAddressLiteral,
  resourceAddressLiteral,
  TARI_RESOURCE_ADDRESS,
} from "@tari-project/ootle";
import { decodeSubstateValue } from "@tari-project/ootle-wasm-bor";

export const XTR = TARI_RESOURCE_ADDRESS;

// --- CBOR helpers for the two argument types the SDK has no literal helper for ----------------
function cborHead(major, n) {
  if (n < 24) return [major | n];
  if (n < 256) return [major | 24, n];
  if (n < 65536) return [major | 25, n >> 8, n & 0xff];
  throw new Error("cbor head: length too large for this helper");
}
const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

/** `Vec<ComponentAddress>` -> CBOR array of Tag(128, bytes(32)). */
export function componentListLiteral(addrs) {
  const items = addrs.map((a) => componentAddressLiteral(a).Literal);
  return { Literal: hex(cborHead(0x80, items.length)) + items.join("") };
}

/** `Vec<NonFungibleId>` of `NonFungibleId::String` ids -> CBOR array of `[1, ["id"]]` (minicbor enum form). */
export function nonFungibleStringIdListLiteral(ids) {
  const enc = new TextEncoder();
  const parts = ids.map((id) => {
    const utf8 = Array.from(enc.encode(id));
    return hex([...cborHead(0x80, 2), 0x01, ...cborHead(0x80, 1), ...cborHead(0x60, utf8.length), ...utf8]);
  });
  return { Literal: hex(cborHead(0x80, ids.length)) + parts.join("") };
}

const asInput = (id, is_write = true) => ({ substate_id: id, version: null, is_write });

/**
 * `open`: withdraw `fund` of `p.resource` (default native XTR; any L2 resource, e.g. a stablecoin) from
 * `owner`, instantiate AgentBudget, deposit both badges back into `owner`. The owner pays the fee (always
 * in native XTR). `ownerVaults` are the owner's vault ids (declared as inputs) — include the funding
 * resource's vault AND, when funding with a non-XTR resource, the owner's XTR vault for the fee.
 */
export function openBudgetTx(p) {
  // "No-confirm" (免确认) two-account model: when `p.agent` (a separate agent account address) is set,
  // the agent badge (ret.2) is deposited into the AGENT's own account instead of the owner's, so the
  // agent can later `pay` with its OWN key — no owner wallet popup per payment, the chain enforces the
  // caps. Omit `p.agent` for the single-account demo (owner == agent), which is unchanged. The owner
  // still signs THIS open once (funding + handing over the badge).
  const agentAccount = p.agent ?? p.owner;
  const routesToAgent = p.agent && p.agent !== p.owner;
  // Asset-generic: the budget locks whatever resource it is funded with (the AgentBudget template's vault
  // + caps are resource-agnostic — see templates/agent_budget/src/lib.rs). `p.resource` is the FUNDING
  // resource; it defaults to native XTR (= TARI_RESOURCE_ADDRESS) and can be any L2 resource, e.g. a
  // stablecoin, for the same open flow. The transaction FEE is always paid in native XTR (Ootle fees are
  // native), independent of the funding resource — so when they differ we declare both as read inputs.
  const resource = p.resource ?? XTR;
  const b = TransactionBuilder.new(p.network, p.maxEpoch)
    // Inputs are explicit on this path (walletd's `detect_inputs` is not available via the indexer):
    // the owner account + its vaults (written), the agent account when distinct (written — it receives
    // the badge), the funding resource + native XTR (fee) + template (read), and every whitelisted
    // merchant (read) — the engine rejects an undeclared component referenced from template args with
    // "Template referenced root substate but it was not found".
    .withInputs([
      asInput(p.owner),
      ...(routesToAgent ? [asInput(p.agent)] : []),
      ...p.ownerVaults.map((v) => asInput(v)),
      asInput(resource, false),
      ...(resource !== XTR ? [asInput(XTR, false)] : []),
      asInput(p.template, false),
      ...p.whitelist.map((m) => asInput(m, false)),
    ])
    .feeTransactionPayFromComponent(p.owner, BigInt(p.maxFee ?? 200_000))
    .callMethod({ componentAddress: p.owner, methodName: "withdraw" }, [
      resourceAddressLiteral(resource),
      amountLiteral(BigInt(p.fund)),
    ])
    .saveVar("funds")
    .callFunction({ templateAddress: p.template, functionName: "new" }, [
      { Workspace: "funds" },
      amountLiteral(BigInt(p.perTxCap)),
      amountLiteral(BigInt(p.dailyCap)),
      intLiteral(BigInt(p.epochsPerWindow)),
      componentListLiteral(p.whitelist),
    ])
    .saveVar("ret")
    .callMethod({ componentAddress: p.owner, methodName: "deposit" }, [{ Workspace: "ret.1" }])        // owner badge -> owner
    .callMethod({ componentAddress: agentAccount, methodName: "deposit" }, [{ Workspace: "ret.2" }]);  // agent badge -> agent (or owner)
  return b.buildUnsignedTransaction();
}

/**
 * `pay`: the agent proves exactly ONE session badge by id (`create_proof_by_non_fungible_ids`),
 * calls `budget.pay`, then drops the proof. The agent pays the fee.
 *
 * CONTRACT — `p.agentVaults` must be the agent account's CURRENT vault ids, re-fetched (via
 * `getVaultIdsForAccount`) AFTER any transaction that mutated the account — in particular after
 * `open`, which mints the agent-badge vault that `create_proof_by_non_fungible_ids` needs here.
 * The bare indexer cannot auto-detect inputs, so every vault the pay touches must be declared.
 * If a STALE (e.g. pre-open) list is passed, the badge vault is missing, the proof cannot be
 * created, and on 0.50 the chain commits only the fee and rejects `budget.pay` (AcceptFeeRejectRest):
 * the receipt still reads `final_decision: Commit` while `spent_in_window` stays unchanged — a
 * silent no-op pay. Pass the merchant's current vaults in `p.merchantVaults` for the same reason.
 * (The offline mock harnesses pass `agentVaults: []` deliberately: they only inspect the instruction
 * bytes and never submit, so this is not enforced at runtime.)
 */
export function payTx(p) {
  const inputs = [
    asInput(p.agent),
    ...p.agentVaults.map((v) => asInput(v)),
    asInput(p.budget),
    asInput(p.budgetVault),
    asInput(p.merchant),
    ...(p.merchantVaults ?? []).map((v) => asInput(v)),
    asInput(p.agentBadge, false),
    asInput(XTR, false),
  ];
  const b = TransactionBuilder.new(p.network, p.maxEpoch)
    .withInputs(inputs)
    .feeTransactionPayFromComponent(p.agent, BigInt(p.maxFee ?? 200_000))
    .callMethod({ componentAddress: p.agent, methodName: "create_proof_by_non_fungible_ids" }, [
      resourceAddressLiteral(p.agentBadge),
      nonFungibleStringIdListLiteral([p.session ?? "default"]),
    ])
    .saveVar("proof")
    .callMethod({ componentAddress: p.budget, methodName: "pay" }, [
      { Workspace: "proof" },
      componentAddressLiteral(p.merchant),
      amountLiteral(BigInt(p.amount)),
      stringLiteral(p.memo ?? ""),
    ])
    .dropAllProofsInWorkspace();
  return b.buildUnsignedTransaction();
}

// --- receipt / substate readers ----------------------------------------------------------------
function acceptDiff(receipt) {
  const r = receipt?.result;
  if (!r || r === "Pending" || !("Finalized" in r)) return null;
  const tx = r.Finalized.execution_result?.finalize?.result;
  if (tx && typeof tx === "object" && "Accept" in tx) return tx.Accept;
  if (tx && typeof tx === "object" && "AcceptFeeRejectRest" in tx) return tx.AcceptFeeRejectRest[0];
  return null;
}

/** First new `component_…` in the receipt's up-substates that is not in `exclude`. */
export function findNewComponent(receipt, exclude = []) {
  const diff = acceptDiff(receipt);
  if (!diff) return null;
  const skip = new Set(exclude);
  for (const [id] of diff.up_substates) if (id.startsWith("component_") && !skip.has(id)) return id;
  return null;
}

/** Events emitted by the AgentBudget template in a receipt (topic `AgentBudget.pay` etc.). */
export function templateEvents(receipt, template) {
  const r = receipt?.result;
  if (!r || r === "Pending" || !("Finalized" in r)) return [];
  const events = r.Finalized.execution_result?.finalize?.events ?? [];
  const tpl = template.replace(/^template_/, "");
  return events.filter((e) => e.template_address === tpl);
}

/** Positional AgentBudget state (same layout as web/server/substate.js) from an indexer substate response. */
export function parseBudgetSubstate(resp) {
  // Three shapes are accepted:
  //  - indexer transaction-diff / already-decoded substate (flows A/B via chain.js): an object at
  //    `resp.state.up.substate` with `.Component.body.state`;
  //  - window.tari `tari_getSubstate` with an already-decoded component (flow C / offline mock):
  //    an object at `resp.substate` with `.Component.body.state`;
  //  - the live 0.50 indexer/engine `getSubstate`: `resp.state.up.substate` is a base64 CBOR STRING
  //    that must be run through wasm-bor `decodeSubstateValue` before it has a `.Component`.
  // In the 0.50 shape each address field is CBOR-tagged `{tag, value:{hex}}` (tag 132=vault_,
  // 131=resource_, 128=component_); the older shapes use `{value:{hex}}`. Both expose `value.hex`,
  // so once the CBOR string is decoded the positional `addr()` reader below handles every shape.
  let container = resp?.state?.up?.substate ?? resp?.substate ?? resp;
  if (typeof container === "string") container = JSON.parse(decodeSubstateValue(container));
  const state = container?.Component?.body?.state;
  if (!Array.isArray(state) || state.length < 10) throw new Error("unexpected budget component layout");
  const addr = (x, prefix) => {
    if (!x || typeof x !== "object" || typeof x.value?.hex !== "string") throw new Error("expected an address at " + prefix);
    return prefix + x.value.hex;
  };
  return {
    vault: addr(state[0], "vault_"),
    ownerBadge: addr(state[1], "resource_"),
    agentBadge: addr(state[2], "resource_"),
    perTxCap: state[3],
    dailyCap: state[4],
    spentInWindow: state[5],
    windowStartEpoch: state[6],
    epochsPerWindow: state[7],
    whitelist: state[8].map((x) => addr(x, "component_")),
    revoked: state[9],
  };
}
