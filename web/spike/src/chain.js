// Read + submit side: the indexer REST API via ootle.ts's IndexerProvider. No keys here.
// Upgraded to ootle.ts 0.13 / Ootle 0.49: the transaction lifecycle is now
//   resolveTransaction → signTransaction → sealTransaction → submitTransaction → watchTransaction,
// and 0.48+ indexers return CBOR-encoded execution results / substate values, decoded with the
// @tari-project/ootle-wasm-bor helpers. (0.47 used a flat JSON result and a manual /dry-run POST.)
import {
  Network,
  getVaultIdsForAccount,
  resolveMaxEpoch,
  resolveTransaction,
  signTransaction,
  sealTransaction,
  submitTransaction,
  sendDryRun,
  watchTransaction,
  classifyOutcome,
} from "@tari-project/ootle";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { decodeExecuteResult, decodeSubstateValue } from "@tari-project/ootle-wasm-bor";

export const LOCALNET = { network: Network.LocalNet, indexerUrl: "http://127.0.0.1:12008" };
// Post-reset esmeralda (0.49.2). The DNS moved from ootle-indexer-a.tari.com to the esme-* hosts;
// smoke-esmeralda.mjs confirmed esme-indexer-a answers getCurrentEpoch.
export const ESMERALDA = { network: Network.Esmeralda, indexerUrl: "https://esme-indexer-a.ootle.tari.com" };

export async function connectIndexer(url = LOCALNET.indexerUrl, network = LOCALNET.network) {
  return IndexerProvider.connect({ url, network });
}

export async function accountVaults(provider, account) {
  return getVaultIdsForAccount(provider, account);
}

export async function maxEpoch(provider) {
  return resolveMaxEpoch(provider);
}

// --- CBOR decode (0.48+) ---------------------------------------------------------------------------
// The wasm-bor decoders take a base64/hex CBOR string and return a JSON string. The indexer provider
// may already hand back decoded JSON for some fields, so decode defensively: a value that is not an
// encoded string is passed through unchanged. VERIFY the exact wrapping against a live esmeralda
// receipt — which field is CBOR vs JSON is the one thing a no-funds smoke cannot pin down.
export function decodeExecResult(encoded) {
  return typeof encoded === "string" ? JSON.parse(decodeExecuteResult(encoded)) : encoded;
}
export function decodeSubstate(encoded) {
  return typeof encoded === "string" ? JSON.parse(decodeSubstateValue(encoded)) : encoded;
}

/** Dry-run via the SDK (0.13): resolve → sign → seal → POST /transactions/dry-run. Returns the result. */
export async function dryRun(provider, signers, unsignedTx) {
  return sendDryRun(provider, Array.isArray(signers) ? signers : [signers], unsignedTx);
}

/**
 * A chain-side execution rejection that the top-level outcome masks. On 0.49, a transaction whose fee is
 * charged but whose body is rejected by a template (e.g. `pay` over the per-tx/daily cap, or a merchant
 * not whitelisted) finalizes with `final_decision: "Commit"` and an inner
 * `execution_result.finalize.result` of `AcceptFeeRejectRest` — so `classifyOutcome`, which reads only the
 * top level, reports `{outcome:"Commit"}` and NO funds moved. Decode the inner result and return the
 * reject reason (or null if the body was accepted), so a rejected payment is never reported as success.
 * Verified live: an over-cap `pay` yields AcceptFeeRejectRest with spent_in_window unchanged.
 */
export function executionReject(receipt) {
  try {
    const enc = receipt?.result?.Finalized?.execution_result;
    if (!enc) return null;
    const r = decodeExecResult(enc)?.finalize?.result;
    if (r && typeof r === "object") {
      if ("AcceptFeeRejectRest" in r) {
        const why = r.AcceptFeeRejectRest?.[1];
        return typeof why === "string" ? why : JSON.stringify(why ?? "execution rejected (fee charged)");
      }
      if ("Reject" in r) {
        const why = r.Reject;
        return typeof why === "string" ? why : JSON.stringify(why);
      }
    }
  } catch {
    /* best-effort decode — fall back to the top-level classifyOutcome below */
  }
  return null;
}

/**
 * 0.13 lifecycle: resolve input versions → sign (the user's key) → seal (throwaway seal key, WASM) →
 * submit → watch. The built-in watchTransaction now polls and does NOT throw on the early 404 or on a
 * Reject / FeeIntentCommit (0.11 did, which is why the old code had a custom waitFinalized loop).
 * Returns { txId, receipt }. Throws with the chain's reason on a non-Commit outcome OR on an inner
 * execution rejection (AcceptFeeRejectRest) that the top-level "Commit" hides — see executionReject.
 */
export async function signSealSubmit(provider, signers, unsignedTx, opts = {}) {
  const resolved = await resolveTransaction(provider, unsignedTx);
  const signed = await signTransaction(Array.isArray(signers) ? signers : [signers], resolved);
  const envelope = sealTransaction(signed);
  const txId = await submitTransaction(provider, envelope);
  const receipt = await watchTransaction(provider, txId, { timeoutMs: opts.timeoutMs ?? 90_000 });
  const c = classifyOutcome(receipt.result);
  // classifyOutcome reads only the top-level final_decision, so it reports a fee-charged-but-body-rejected
  // tx as "Commit". Check the inner execution result too, and fail on EITHER signal.
  const innerReject = executionReject(receipt);
  if (innerReject || (c && c.outcome && c.outcome !== "Commit")) {
    const outcome = innerReject ? "ExecutionRejected" : c.outcome;
    const reason = innerReject ?? c.reason ?? "";
    const err = new Error(`transaction ${txId} ${outcome}: ${reason}`);
    err.txId = txId;
    err.outcome = outcome;
    err.reason = reason;
    throw err;
  }
  return { txId, receipt };
}

/** Wait for a tx already submitted elsewhere (kept for callers that submit then wait separately). */
export async function waitFinalized(provider, txId, opts = {}) {
  return watchTransaction(provider, txId, { timeoutMs: opts.timeoutMs ?? 90_000 });
}
