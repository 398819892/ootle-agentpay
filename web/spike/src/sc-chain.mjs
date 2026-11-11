// sc-chain.mjs — the self-custody wallet's on-chain layer, run IN THE BROWSER.
//
// A fresh browser key has no on-chain account until it is funded (the account is created in the funding
// tx). On localnet the built-in faucet does both in one transaction, signed here by the user's own key
// and submitted straight to the indexer (CORS-open) — no backend custody. Balance is read the same way
// the backend does (sum the account's XTR vaults), but from the browser.
//
// Reuses the proven engine: chain.js (connect / maxEpoch / signSealSubmit) and the Flow-A faucet recipe
// from src/main.js. Signing still needs a live indexer (resolveTransaction stamps the signer + input
// versions) — the known L2 gate, satisfied by the running localnet.
import {
  TransactionBuilder, Network, amountLiteral, toHexStr,
  XTR_FAUCET_COMPONENT_ADDRESS, XTR_FAUCET_VAULT_ADDRESS, XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
} from "@tari-project/ootle";
import { publicKeyFromSecretKey } from "@tari-project/ootle-wasm";
import { decodeSubstateValue, decodeEvent, decodeExecuteResult } from "@tari-project/ootle-wasm-bor";
import {
  findNewComponent, transferTx, openBudgetTx, payTx, setLimitsTx, addMerchantTx, removeMerchantTx,
  topUpTx, withdrawTx, issueBadgeTx, revokeSessionTx, revokeTx, parseBudgetSubstate, XTR,
} from "./agentpay-tx.js";
import { connectIndexer, accountVaults, maxEpoch, signSealSubmit } from "./chain.js";

const XTR_HEX = XTR.replace(/^resource_/, "");

// The Ootle network these transactions are built and addressed for. Defaults to LocalNet so the localnet
// dev path is byte-for-byte unchanged; the in-page wallet calls setNetwork() with the configured network
// (resolved from /api/status) BEFORE it connects, so on mainnet every TransactionBuilder below is scoped
// to MainNet. One network per session (one wallet, one indexer), so a module-level value is the right scope.
let _net = Network.LocalNet;
export function setNetwork(net) { if (net != null) _net = net; }
export function currentNetwork() { return _net; }

/** Owner public key (hex) for createAccount, derived from the owner secret bytes. */
export function ownerPublicHex(ownerSecretBytes) {
  return toHexStr(publicKeyFromSecretKey(ownerSecretBytes));
}

export function connect(indexerUrl, net) {
  if (net != null) _net = net;
  return connectIndexer(indexerUrl, _net);
}

/**
 * Create + fund the account via the localnet faucet in one browser-signed tx (Flow A's recipe).
 * Returns { txId, account } where account is the new component address.
 */
export async function fundViaFaucet(provider, wallet, ownerPubHex) {
  const unsigned = new TransactionBuilder(_net, await maxEpoch(provider))
    .withFeeInstructionsBuilder((b) =>
      b
        .createAccount(ownerPubHex)
        .saveVar("account")
        .callMethod({ componentAddress: XTR_FAUCET_COMPONENT_ADDRESS, methodName: "take" }, [{ Workspace: "account" }])
        .callMethod({ fromWorkspace: "account", methodName: "pay_fee" }, [amountLiteral(20_000n)]),
    )
    .withInputs([
      { substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null },
      { substate_id: XTR_FAUCET_VAULT_ADDRESS, version: null },
      { substate_id: XTR_FAUCET_CLAIM_RESOURCE_ADDRESS, version: null },
    ])
    .buildUnsignedTransaction();
  const { txId, receipt } = await signSealSubmit(provider, [wallet], unsigned);
  return { txId, account: findNewComponent(receipt) };
}

/**
 * Send `amount` (XTR base units) from `fromAccount` to `toAccount`, signed in the browser by the
 * user's own key — the owner spending their real balance (transferTx's owner→recipient recipe, NOT
 * the AgentBudget). Both accounts' current vaults are declared as inputs (the bare indexer can't
 * auto-detect them); a brand-new recipient may have no vault yet, so a lookup failure there is fine —
 * the deposit creates the vault. Returns { txId }.
 */
export async function sendXtr(provider, wallet, fromAccount, toAccount, amount) {
  const ownerVaults = await accountVaults(provider, fromAccount);
  let recipientVaults = [];
  try { recipientVaults = await accountVaults(provider, toAccount); } catch { /* fresh recipient: no vault yet */ }
  const unsigned = transferTx({
    network: _net,
    maxEpoch: await maxEpoch(provider),
    owner: fromAccount,
    ownerVaults,
    recipient: toAccount,
    recipientVaults,
    amount: BigInt(amount),
    maxFee: 200_000,
  });
  const { txId } = await signSealSubmit(provider, [wallet], unsigned);
  return { txId };
}

// --- balance: sum the account's XTR-bearing vaults (same logic as the backend's ownerBalance) --------
async function vaultXtr(provider, vaultId) {
  let c = (await provider.getSubstate(vaultId))?.state?.up?.substate;
  if (typeof c === "string") c = JSON.parse(decodeSubstateValue(c));
  const s = JSON.stringify(c);
  if (!s.includes(XTR_HEX)) return null; // a badge/NFT vault, or another resource
  const m = s.match(/"revealed_amount":"?(\d+)"?/) || s.match(/"amount":"?(\d+)"?/);
  return m ? BigInt(m[1]) : null;
}

/** Total XTR balance (as a BigInt) held by `account`, read from the indexer. */
export async function balanceOf(provider, account) {
  const ids = await accountVaults(provider, account);
  let total = 0n;
  for (const v of ids) {
    const a = await vaultXtr(provider, v);
    if (a != null) total += a;
  }
  return total;
}

// --- real chain transaction history ----------------------------------------------------------------
// The indexer has no per-account transaction list, BUT it does index per-substate events
// (queryTransactionEvents, filterable by substate_id). Every XTR movement emits a vault event on the
// touched vault: `std.vault.deposit` (in), `std.vault.withdraw` (out), `std.vault.pay_fee` (the fee).
// So the account's REAL history — including transfers OTHERS sent in — can be rebuilt browser-side by
// querying each of the account's XTR vaults, aggregating events by tx, and stamping the shown rows with
// their on-chain finalized time + commit status (both immutable once committed, so cached forever).
//
// Caveats, honestly: the indexer answers event queries only within its retention window, only for the
// account's CURRENT vaults, and (if it runs with event filters) over a subset — absence is not proof.

const EV_IN = "std.vault.deposit";
const EV_OUT = "std.vault.withdraw";
const EV_FEE = "std.vault.pay_fee";

const _txMetaCache = new Map(); // txId -> { time:number|null, ok:boolean, fee:string|null }
/** On-chain finalized time (ms), commit status, and ACTUAL fee for a tx; cached (finalized = immutable). */
async function txMeta(provider, txId) {
  if (_txMetaCache.has(txId)) return _txMetaCache.get(txId);
  const meta = { time: null, ok: true, fee: null };
  try {
    const f = (await provider.getTransactionResult(txId))?.result?.Finalized;
    if (f) {
      meta.ok = f.final_decision === "Commit";
      // finalized_time is UTC with no zone suffix ("YYYY-MM-DD HH:MM:SS.s"); parse it AS UTC (append Z)
      // so the browser's relative times are right regardless of the viewer's local timezone.
      const t = typeof f.finalized_time === "string" ? Date.parse(f.finalized_time.replace(" ", "T") + "Z") : NaN;
      meta.time = Number.isFinite(t) ? t : null;
      // The pay_fee event records the RESERVED max fee, not what was charged; the real fee is
      // fee_receipt.total_fees_paid in the execution result (the unused reserve is refunded off-vault,
      // so it emits no deposit event — the balance delta only matches once we use this).
      if (typeof f.execution_result === "string") {
        try { const m = decodeExecuteResult(f.execution_result).match(/"total_fees_paid":(\d+)/); if (m) meta.fee = m[1]; }
        catch { /* undecodable → fall back to the event-sum (reserved) fee */ }
      }
    }
  } catch { /* leave defaults; a row with no meta still renders */ }
  _txMetaCache.set(txId, meta);
  return meta;
}

/**
 * Rebuild `account`'s XTR transfer history from the indexer's per-vault events. Returns up to `limit`
 * rows, newest first:
 *   { txId, dir: "in" | "out" | "fund" | "op", amount, fee, time, ok }
 * where `dir` is classified from the aggregated events:
 *   out  — a withdraw: WE sent XTR out (`amount` = sent amount, `fee` = fee we paid)
 *   in   — a deposit with no fee from us: someone sent XTR TO us (`amount` = received)
 *   fund — a deposit we paid a fee for: a faucet claim / self-funding (`amount` = received)
 *   op   — only a fee left our XTR vault, no XTR moved: a gas-only contract/owner op (`amount` = fee)
 * All amounts are base-unit decimal strings.
 */
export async function accountHistory(provider, account, { limit = 25, perVault = 200, stampMax = 30 } = {}) {
  const allVaults = await accountVaults(provider, account);
  const xtrVaults = [];
  for (const v of allVaults) { if ((await vaultXtr(provider, v)) != null) xtrVaults.push(v); }
  const client = provider.getClient();
  const byTx = new Map(); // txId -> { in, out, fee }
  for (const v of xtrVaults) {
    let resp;
    try { resp = await client.queryTransactionEvents({ topic: null, substate_id: v, limit: perVault, offset: 0 }); }
    catch { continue; } // one vault's query failing shouldn't lose the rest
    for (const [txId, evStr] of (resp?.events || [])) {
      let ev; try { ev = JSON.parse(decodeEvent(evStr)); } catch { continue; }
      const amt = BigInt(ev?.payload?.amount ?? 0);
      const row = byTx.get(txId) || { in: 0n, out: 0n, fee: 0n };
      if (ev.topic === EV_IN) row.in += amt;
      else if (ev.topic === EV_OUT) row.out += amt;
      else if (ev.topic === EV_FEE) row.fee += amt;
      byTx.set(txId, row);
    }
  }
  const rows = [...byTx.entries()].map(([txId, r]) => {
    let dir, amount;
    if (r.out > 0n) { dir = "out"; amount = r.out; }            // we sent
    else if (r.in > 0n) { dir = r.fee > 0n ? "fund" : "in"; amount = r.in; } // claim/self-fund, or receive
    else { dir = "op"; amount = r.fee; }                        // gas-only: only a fee left our XTR vault
    return { txId, dir, amount: amount.toString(), fee: r.fee.toString() };
  });
  // stamp a bounded, recent-biased superset with on-chain time, status + the ACTUAL fee, then sort by
  // time (desc). The receipt fee (when available) replaces the reserved pay_fee sum so the displayed
  // fee — and, for a gas-only op, its amount — match the real balance change.
  const top = rows.slice(0, Math.max(stampMax, limit));
  await Promise.all(top.map(async (row) => {
    const m = await txMeta(provider, row.txId);
    row.time = m.time; row.ok = m.ok;
    if (m.fee != null) { row.fee = m.fee; if (row.dir === "op") row.amount = m.fee; }
  }));
  top.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  return top.slice(0, limit);
}

// --- AgentBudget (the chain-enforced budget the self-custody wallet owns & a dApp drives) -----------
// The owner (this browser key) can open a real on-chain AgentBudget, read it, and pay a whitelisted
// merchant FROM it — all browser-signed. Single-account model (owner == agent), per the proven Flow-A
// driver in src/main.js: `new` mints an owner badge + an agent badge, both deposited into the owner
// account, so the same key both governs the budget (owner badge) and pays within caps (agent badge,
// proven by non-fungible id "default"). The chain enforces per-tx / daily caps + the whitelist.

/**
 * Open + fund a new AgentBudget, owner-signed in the browser. Returns { budget, state } where `state`
 * is the parsed substate (vault id, owner/agent badge resources, caps, whitelist). `fund`/caps are XTR
 * base-unit numbers; `epochsPerWindow` sizes the daily-cap window. `merchant` is OPTIONAL: opening a
 * budget delegates spending authority to the agent and sets the caps — the merchant whitelist starts
 * EMPTY and is managed afterwards via setMerchant (add/remove), per the "AgentPay manages merchants"
 * model. Pass a `merchant` only to seed the whitelist with one entry at open time.
 */
export async function openBudget(provider, wallet, { owner, template, merchant, fund, perTxCap, dailyCap, epochsPerWindow = 10 }) {
  const unsigned = openBudgetTx({
    network: _net,
    maxEpoch: await maxEpoch(provider),
    template,
    owner,
    ownerVaults: await accountVaults(provider, owner),
    fund: BigInt(fund),
    perTxCap: BigInt(perTxCap),
    dailyCap: BigInt(dailyCap),
    epochsPerWindow: BigInt(epochsPerWindow),
    whitelist: merchant ? [merchant] : [],
    maxFee: 200_000,
  });
  const { txId, receipt } = await signSealSubmit(provider, [wallet], unsigned);
  const budget = findNewComponent(receipt, merchant ? [owner, merchant] : [owner]);
  if (!budget) throw new Error("开预算成功提交,但未能在回执中找到新预算组件");
  const state = parseBudgetSubstate(await provider.getSubstate(budget));
  return { txId, budget, state };
}

/**
 * Read a budget's live on-chain state in the shape the dashboard's overlay expects:
 *   { address, perTx, daily, spent, vault, whitelist, ownerBadge, agentBadge, vaultId, revoked }
 * `vault` is the budget vault's REAL balance (treasury), read like balanceOf; `vaultId` is the vault
 * substate id kept for pay/owner ops. All amounts are base-unit decimal strings.
 */
export async function readBudget(provider, budget) {
  const s = parseBudgetSubstate(await provider.getSubstate(budget));
  const treasury = await vaultXtr(provider, s.vault); // the budget vault's XTR balance
  return {
    address: budget,
    perTx: String(s.perTxCap),
    daily: String(s.dailyCap),
    spent: String(s.spentInWindow),
    vault: (treasury ?? 0n).toString(),
    whitelist: s.whitelist,
    ownerBadge: s.ownerBadge,
    agentBadge: s.agentBadge,
    vaultId: s.vault,
    revoked: s.revoked,
  };
}

/**
 * Pay `amount` (base units) to `merchant` FROM the budget, agent-signed in the browser (single-account:
 * the owner IS the agent). The agent's vaults are re-fetched NOW (they hold the agent-badge vault minted
 * at open — a stale list would silently no-op the pay). Returns { committed, txid?, reason? }: the chain
 * enforces the caps + whitelist, so an over-cap / non-whitelisted pay commits only the fee and surfaces
 * here as committed:false (signSealSubmit throws FeeIntentCommit), not an exception to the caller.
 */
export async function payBudget(provider, wallet, { account, budget, state, merchant, amount, memo }) {
  // Snapshot spent BEFORE: an over-cap / non-whitelisted / revoked pay commits ONLY the fee
  // (AcceptFeeRejectRest) — the receipt still reads final_decision=Commit and signSealSubmit does NOT
  // throw, yet budget.pay never ran and spent_in_window is unchanged. So "committed" is decided by
  // whether spent actually moved, not by the absence of an exception (the silent-no-op trap).
  const before = (() => { try { return BigInt(state.spent); } catch { return null; } })();
  const unsigned = payTx({
    network: _net,
    maxEpoch: await maxEpoch(provider),
    agent: account,
    agentVaults: await accountVaults(provider, account), // re-fetched: must include the agent-badge vault
    budget,
    budgetVault: state.vaultId ?? state.vault,
    agentBadge: state.agentBadge,
    session: "default",
    merchant,
    merchantVaults: await accountVaults(provider, merchant).catch(() => []),
    amount: BigInt(amount),
    memo: memo ?? "",
    maxFee: 200_000,
  });
  let txid = null;
  try {
    const r = await signSealSubmit(provider, [wallet], unsigned);
    txid = r.txId;
  } catch (e) {
    // A hard reject (not even the fee committed) throws here.
    return { committed: false, reason: e?.reason || e?.message || String(e), outcome: e?.outcome || "Reject" };
  }
  // Fee committed — now confirm the pay itself landed by re-reading spent_in_window.
  let after = before;
  try { after = BigInt((await readBudget(provider, budget)).spent); } catch { /* keep before */ }
  if (before == null || after > before) return { committed: true, txid };
  return { committed: false, txid, reason: "链上拒绝:超出额度或商户不在白名单" };
}

// --- owner governance ops (owner-badge gated), signed in the browser -------------------------------
// set_limits / add_merchant / remove_merchant put an OWNER-BADGE proof in the auth zone (see
// agentpay-tx.js). Like pay, a rule rejection can commit only the fee (receipt reads Commit, no throw),
// so each op VERIFIES its effect by re-reading the budget and reports committed:false if it didn't take.
async function ownerOpCommon(provider, owner, budget, ownerBadge) {
  return {
    network: _net,
    maxEpoch: await maxEpoch(provider),
    owner,
    ownerVaults: await accountVaults(provider, owner), // hold the owner badge the proof needs + the fee XTR
    budget,
    ownerBadge,
    maxFee: 200_000,
  };
}

/** owner: update the per-tx + daily caps. Verifies by re-reading the caps. */
export async function setLimits(provider, wallet, { owner, budget, ownerBadge, perTxCap, dailyCap }) {
  const tx = setLimitsTx({ ...(await ownerOpCommon(provider, owner, budget, ownerBadge)), perTxCap: BigInt(perTxCap), dailyCap: BigInt(dailyCap) });
  let txid = null;
  try { txid = (await signSealSubmit(provider, [wallet], tx)).txId; }
  catch (e) { return { committed: false, reason: e?.reason || e?.message || String(e) }; }
  try { const b = await readBudget(provider, budget); if (b.perTx === String(perTxCap) && b.daily === String(dailyCap)) return { committed: true, txid }; } catch { /* fall through */ }
  return { committed: false, txid, reason: "链上未生效(可能被合约规则拒绝)" };
}

/** owner: add or remove `merchant` from the whitelist (`add` true = add). Verifies by re-reading it. */
export async function setMerchant(provider, wallet, { owner, budget, ownerBadge, merchant, add }) {
  const common = await ownerOpCommon(provider, owner, budget, ownerBadge);
  const tx = add ? addMerchantTx({ ...common, merchant }) : removeMerchantTx({ ...common, merchant });
  let txid = null;
  try { txid = (await signSealSubmit(provider, [wallet], tx)).txId; }
  catch (e) { return { committed: false, reason: e?.reason || e?.message || String(e) }; }
  try { const b = await readBudget(provider, budget); const has = b.whitelist.includes(merchant); if (add ? has : !has) return { committed: true, txid }; } catch { /* fall through */ }
  return { committed: false, txid, reason: add ? "链上未加入白名单" : "链上未移出白名单" };
}

// --- lifecycle ops (fund / withdraw / session badges / kill switch), signed in the browser ----------
// Each reads the budget's live state NOW for the vault id + badge resources (a stale value silently
// no-ops), builds the proven manifest tx (agentpay-tx.js), and submits it browser-signed. Where the
// chain exposes the effect it is VERIFIED by re-reading (the AcceptFeeRejectRest fee-only-commit trap,
// as in pay/setLimits); the per-session badge set is NOT in the positional substate, so issue/revoke of a
// session report committed on a clean submit and the wallet journal is the source of truth for that set.
const _reason = (e) => e?.reason || e?.message || String(e);

/** top_up: fund the budget vault from the owner's account (not owner-gated). Verifies the vault grew. */
export async function topUp(provider, wallet, { owner, budget, amount }) {
  const state = await readBudget(provider, budget);
  const before = (() => { try { return BigInt(state.vault); } catch { return null; } })();
  const tx = topUpTx({
    network: _net, maxEpoch: await maxEpoch(provider),
    owner, ownerVaults: await accountVaults(provider, owner),
    budget, budgetVault: state.vaultId, amount: BigInt(amount), maxFee: 200_000,
  });
  let txid = null;
  try { txid = (await signSealSubmit(provider, [wallet], tx)).txId; }
  catch (e) { return { committed: false, reason: _reason(e) }; }
  let after = before;
  try { after = BigInt((await readBudget(provider, budget)).vault); } catch { /* keep before */ }
  if (before == null || after > before) return { committed: true, txid };
  return { committed: false, txid, reason: "链上未增加预算余额(top_up 未生效)" };
}

/** withdraw: owner pulls `amount` from the budget vault back to their account (owner-gated). Verifies drop. */
export async function withdraw(provider, wallet, { owner, budget, amount }) {
  const state = await readBudget(provider, budget);
  const before = (() => { try { return BigInt(state.vault); } catch { return null; } })();
  const tx = withdrawTx({
    network: _net, maxEpoch: await maxEpoch(provider),
    owner, ownerVaults: await accountVaults(provider, owner),
    budget, budgetVault: state.vaultId, ownerBadge: state.ownerBadge,
    amount: BigInt(amount), maxFee: 200_000,
  });
  let txid = null;
  try { txid = (await signSealSubmit(provider, [wallet], tx)).txId; }
  catch (e) { return { committed: false, reason: _reason(e) }; }
  let after = before;
  try { after = BigInt((await readBudget(provider, budget)).vault); } catch { /* keep before */ }
  if (before == null || after < before) return { committed: true, txid };
  return { committed: false, txid, reason: "链上未从预算提款(withdraw 未生效)" };
}

/** issue_agent_badge: owner mints a session badge `session` into the agent account (owner-gated). The
 *  positional substate doesn't list sessions, so a clean submit is reported committed. */
export async function issueSession(provider, wallet, { owner, agent, budget, session }) {
  const recv = agent || owner; // single-account model: owner is the agent/session account
  const state = await readBudget(provider, budget);
  const tx = issueBadgeTx({
    network: _net, maxEpoch: await maxEpoch(provider),
    owner, ownerVaults: await accountVaults(provider, owner),
    budget, agent: recv, agentVaults: await accountVaults(provider, recv),
    agentBadge: state.agentBadge, ownerBadge: state.ownerBadge, session, maxFee: 200_000,
  });
  let txid = null;
  try { txid = (await signSealSubmit(provider, [wallet], tx)).txId; }
  catch (e) { return { committed: false, reason: _reason(e) }; }
  return { committed: true, txid };
}

/** revoke_session: owner blocks one session badge on chain (owner-gated). Not in the positional substate
 *  to re-read, so a clean submit is reported committed. */
export async function revokeSession(provider, wallet, { owner, budget, session }) {
  const state = await readBudget(provider, budget);
  const tx = revokeSessionTx({ ...(await ownerOpCommon(provider, owner, budget, state.ownerBadge)), session });
  let txid = null;
  try { txid = (await signSealSubmit(provider, [wallet], tx)).txId; }
  catch (e) { return { committed: false, reason: _reason(e) }; }
  return { committed: true, txid };
}

/** revoke: owner flips the global kill switch (owner-gated). Verifies the revoked flag on chain. */
export async function revoke(provider, wallet, { owner, budget }) {
  const state = await readBudget(provider, budget);
  const tx = revokeTx(await ownerOpCommon(provider, owner, budget, state.ownerBadge));
  let txid = null;
  try { txid = (await signSealSubmit(provider, [wallet], tx)).txId; }
  catch (e) { return { committed: false, reason: _reason(e) }; }
  try { if ((await readBudget(provider, budget)).revoked) return { committed: true, txid }; } catch { /* fall through */ }
  return { committed: false, txid, reason: "链上未进入停用状态(revoke 未生效)" };
}
