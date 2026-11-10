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
import { decodeSubstateValue, decodeExecuteResult } from "@tari-project/ootle-wasm-bor";

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

/** A substate may be declared as an input only ONCE — duplicates fail to deserialize at submit. Dedupe by
 *  substate_id, keeping is_write if ANY occurrence is writable. (Single-account budgets pass owner==agent,
 *  so issue's owner/agent inputs collide; this makes that case well-formed.) */
const dedupeInputs = (inputs) => {
  const by = new Map();
  for (const i of inputs) {
    const prev = by.get(i.substate_id);
    if (!prev) by.set(i.substate_id, { ...i });
    else if (i.is_write) prev.is_write = true;
  }
  return [...by.values()];
};

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
 * `transfer`: a plain owner→recipient payment straight from the OWNER account's own funds — the
 * wallet owner spending their real balance, NOT the AgentBudget. `owner.withdraw(resource, amount)`
 * into a bucket, `recipient.deposit(bucket)`; the owner pays the fee (native XTR). This is the model
 * boundary the UI needs: the owner's Send decrements the owner account, while the agent budget's
 * `pay` (below) decrements the budget vault — two independent pools that never move together.
 *
 * Inputs mirror `openBudgetTx`: owner + its vaults (written), recipient + its vaults (written, it
 * receives the bucket), the transferred resource + native XTR for the fee (read). `ownerVaults` /
 * `recipientVaults` are the CURRENT vault ids (via getVaultIdsForAccount) — the bare indexer cannot
 * auto-detect inputs, so every vault the transfer touches must be declared.
 */
export function transferTx(p) {
  const resource = p.resource ?? XTR;
  const b = TransactionBuilder.new(p.network, p.maxEpoch)
    .withInputs([
      asInput(p.owner),
      ...p.ownerVaults.map((v) => asInput(v)),
      asInput(p.recipient),
      ...(p.recipientVaults ?? []).map((v) => asInput(v)),
      asInput(resource, false),
      ...(resource !== XTR ? [asInput(XTR, false)] : []),
    ])
    .feeTransactionPayFromComponent(p.owner, BigInt(p.maxFee ?? 200_000))
    .callMethod({ componentAddress: p.owner, methodName: "withdraw" }, [
      resourceAddressLiteral(resource),
      amountLiteral(BigInt(p.amount)),
    ])
    .saveVar("bucket")
    .callMethod({ componentAddress: p.recipient, methodName: "deposit" }, [{ Workspace: "bucket" }]);
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

// --- owner governance ops (owner-badge gated) --------------------------------------------------
// set_limits / add_merchant / remove_merchant are gated by the component access rule
// `rule!(resource(owner_badge))` (see templates/agent_budget/src/lib.rs) — they take NO proof arg, so
// the transaction must put an OWNER-BADGE proof in the auth zone. The instruction equivalent of the
// manifest `owner.create_proof_for_resource(owner_badge); budget.<op>(...); drop_all_proofs!()` is
// `createProof(owner, ownerBadge).saveVar("p").withAuthorizedProof("p", b => b.callMethod(<op>)).
// dropAllProofsInWorkspace()`. The OWNER signs + pays the fee (native XTR). `ownerVaults` are the
// owner account's CURRENT vault ids (declared as inputs — the bare indexer can't auto-detect them):
// they hold the owner badge the proof needs and the XTR the fee is paid from.
const ownerOpInputs = (p, extra = []) => [
  asInput(p.owner),
  ...p.ownerVaults.map((v) => asInput(v)),
  asInput(p.budget),
  asInput(p.ownerBadge, false),
  asInput(XTR, false),
  ...extra,
];

function ownerOpTx(p, methodName, args, extraInputs = []) {
  return TransactionBuilder.new(p.network, p.maxEpoch)
    .withInputs(ownerOpInputs(p, extraInputs))
    .feeTransactionPayFromComponent(p.owner, BigInt(p.maxFee ?? 200_000))
    .createProof(p.owner, p.ownerBadge)
    .saveVar("ownerProof")
    .withAuthorizedProof("ownerProof", (b) =>
      b.callMethod({ componentAddress: p.budget, methodName }, args))
    .dropAllProofsInWorkspace()
    .buildUnsignedTransaction();
}

/** `set_limits`: owner updates the per-transaction and daily caps (base-unit strings/bigints). */
export function setLimitsTx(p) {
  return ownerOpTx(p, "set_limits", [amountLiteral(BigInt(p.perTxCap)), amountLiteral(BigInt(p.dailyCap))]);
}

/** `add_merchant`: owner whitelists `p.merchant` (declared as a read input — it is an arg address). */
export function addMerchantTx(p) {
  return ownerOpTx(p, "add_merchant", [componentAddressLiteral(p.merchant)], [asInput(p.merchant, false)]);
}

/** `remove_merchant`: owner removes `p.merchant` from the whitelist. */
export function removeMerchantTx(p) {
  return ownerOpTx(p, "remove_merchant", [componentAddressLiteral(p.merchant)], [asInput(p.merchant, false)]);
}

// --- lifecycle ops: fund / withdraw / session badges / kill switch --------------------------------
// Mirror the proven manifests in clients/ts/src/budget.ts. `top_up` is OPEN on the template (anyone may
// fund), so it carries NO owner-badge proof — the owner just withdraws from their own account into a
// bucket and the budget deposits it. `withdraw` / `issue_agent_badge` / `revoke_session` / `revoke` ARE
// owner-badge gated (same auth-zone pattern as the governance ops above). For withdraw + issue the gated
// call RETURNS a Bucket; per the manifests both the call AND the deposit of its bucket live inside the
// proof scope (`ownerProofOpen … ownerProofClose`), so the deposit goes in the withAuthorizedProof body.

/** `top_up`: fund the budget vault — `owner.withdraw(resource, amount)` into a bucket, then
 *  `budget.top_up(bucket)`. Not owner-gated. `budgetVault` is the budget's vault (declared write). */
export function topUpTx(p) {
  const resource = p.resource ?? XTR;
  return TransactionBuilder.new(p.network, p.maxEpoch)
    .withInputs([
      asInput(p.owner),
      ...p.ownerVaults.map((v) => asInput(v)),
      asInput(p.budget),
      asInput(p.budgetVault),
      asInput(resource, false),
      ...(resource !== XTR ? [asInput(XTR, false)] : []),
    ])
    .feeTransactionPayFromComponent(p.owner, BigInt(p.maxFee ?? 200_000))
    .callMethod({ componentAddress: p.owner, methodName: "withdraw" }, [
      resourceAddressLiteral(resource),
      amountLiteral(BigInt(p.amount)),
    ])
    .saveVar("funds")
    .callMethod({ componentAddress: p.budget, methodName: "top_up" }, [{ Workspace: "funds" }])
    .buildUnsignedTransaction();
}

/** `withdraw`: owner pulls `amount` from the budget vault back into the OWNER account. Owner-gated;
 *  the withdraw bucket is captured and deposited inside the auth-proof scope (per the manifest). */
export function withdrawTx(p) {
  return TransactionBuilder.new(p.network, p.maxEpoch)
    .withInputs([
      asInput(p.owner),
      ...p.ownerVaults.map((v) => asInput(v)),
      asInput(p.budget),
      asInput(p.budgetVault),
      asInput(p.ownerBadge, false),
      asInput(XTR, false),
    ])
    .feeTransactionPayFromComponent(p.owner, BigInt(p.maxFee ?? 200_000))
    .createProof(p.owner, p.ownerBadge)
    .saveVar("ownerProof")
    .withAuthorizedProof("ownerProof", (b) =>
      b
        .callMethod({ componentAddress: p.budget, methodName: "withdraw" }, [amountLiteral(BigInt(p.amount))])
        .saveVar("funds")
        .callMethod({ componentAddress: p.owner, methodName: "deposit" }, [{ Workspace: "funds" }]))
    .dropAllProofsInWorkspace()
    .buildUnsignedTransaction();
}

/** `issue_agent_badge`: owner mints a session badge labelled `p.session` and deposits it into the agent/
 *  session account (`p.agent`), which can then `pay` within the same caps. Owner-gated. `agentBadge`
 *  (the minted resource), `agent` (the receiver) and `p.agentVaults` (the agent account's CURRENT vault
 *  ids — the bare indexer can't auto-detect inputs, so the agent-badge vault the deposit lands in MUST be
 *  declared, or instruction #N `agent.deposit` aborts with "vault … not found") are declared write. */
export function issueBadgeTx(p) {
  return TransactionBuilder.new(p.network, p.maxEpoch)
    .withInputs(dedupeInputs([
      asInput(p.owner),
      ...p.ownerVaults.map((v) => asInput(v)),
      asInput(p.budget),
      asInput(p.agent),
      ...(p.agentVaults ?? []).map((v) => asInput(v)),
      asInput(p.agentBadge),
      asInput(p.ownerBadge, false),
      asInput(XTR, false),
    ]))
    .feeTransactionPayFromComponent(p.owner, BigInt(p.maxFee ?? 200_000))
    .createProof(p.owner, p.ownerBadge)
    .saveVar("ownerProof")
    .withAuthorizedProof("ownerProof", (b) =>
      b
        .callMethod({ componentAddress: p.budget, methodName: "issue_agent_badge" }, [stringLiteral(p.session)])
        .saveVar("badge")
        .callMethod({ componentAddress: p.agent, methodName: "deposit" }, [{ Workspace: "badge" }]))
    .dropAllProofsInWorkspace()
    .buildUnsignedTransaction();
}

/** `revoke_session`: owner blocks the single session badge `p.session` on chain; others unaffected. */
export function revokeSessionTx(p) {
  return ownerOpTx(p, "revoke_session", [stringLiteral(p.session)]);
}

/** `revoke`: owner flips the global kill switch — every further `pay` is rejected on chain. */
export function revokeTx(p) {
  return ownerOpTx(p, "revoke", []);
}

// --- receipt / substate readers ----------------------------------------------------------------
/**
 * The `finalize` object (result + events + up_substates) of a committed receipt. On 0.50 the
 * `execution_result` is a base64 CBOR STRING that must go through wasm-bor `decodeExecuteResult`
 * before it has a `.finalize`; older indexers already hand back a decoded object. Returns null for a
 * pending / non-finalized receipt. (Without this decode, `findNewComponent` and `templateEvents`
 * silently see nothing on a raw 0.50 receipt.)
 */
function finalizeOf(receipt) {
  const r = receipt?.result;
  if (!r || r === "Pending" || !("Finalized" in r)) return null;
  let exec = r.Finalized.execution_result;
  if (typeof exec === "string") exec = JSON.parse(decodeExecuteResult(exec));
  return exec?.finalize ?? null;
}

function acceptDiff(receipt) {
  const tx = finalizeOf(receipt)?.result;
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
  const events = finalizeOf(receipt)?.events ?? [];
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
