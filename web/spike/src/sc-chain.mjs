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
import { findNewComponent, transferTx, XTR } from "./agentpay-tx.js";
import { connectIndexer, accountVaults, maxEpoch, signSealSubmit } from "./chain.js";

const XTR_HEX = XTR.replace(/^resource_/, "");

/** Owner public key (hex) for createAccount, derived from the owner secret bytes. */
export function ownerPublicHex(ownerSecretBytes) {
  return toHexStr(publicKeyFromSecretKey(ownerSecretBytes));
}

export function connect(indexerUrl) {
  return connectIndexer(indexerUrl, Network.LocalNet);
}

/**
 * Create + fund the account via the localnet faucet in one browser-signed tx (Flow A's recipe).
 * Returns { txId, account } where account is the new component address.
 */
export async function fundViaFaucet(provider, wallet, ownerPubHex) {
  const unsigned = new TransactionBuilder(Network.LocalNet, await maxEpoch(provider))
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
    network: Network.LocalNet,
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
