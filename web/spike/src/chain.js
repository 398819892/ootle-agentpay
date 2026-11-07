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
 * 0.13 lifecycle: resolve input versions → sign (the user's key) → seal (throwaway seal key, WASM) →
 * submit → watch. The built-in watchTransaction now polls and does NOT throw on the early 404 or on a
 * Reject / FeeIntentCommit (0.11 did, which is why the old code had a custom waitFinalized loop).
 * Returns { txId, receipt }. Throws with the chain's reason on a non-Commit outcome.
 */
export async function signSealSubmit(provider, signers, unsignedTx, opts = {}) {
  const resolved = await resolveTransaction(provider, unsignedTx);
  const signed = await signTransaction(Array.isArray(signers) ? signers : [signers], resolved);
  const envelope = sealTransaction(signed);
  const txId = await submitTransaction(provider, envelope);
  const receipt = await watchTransaction(provider, txId, { timeoutMs: opts.timeoutMs ?? 90_000 });
  const c = classifyOutcome(receipt.result);
  // classifyOutcome (0.13) returns one of Commit / FeeIntentCommit / Reject — so a plain inequality
  // catches "fee charged but execution rejected" too, which 0.11 had to detect by hand.
  if (c && c.outcome && c.outcome !== "Commit") {
    const err = new Error(`transaction ${txId} ${c.outcome}: ${c.reason ?? ""}`);
    err.txId = txId;
    err.outcome = c.outcome;
    err.reason = c.reason;
    throw err;
  }
  return { txId, receipt };
}

/** Wait for a tx already submitted elsewhere (kept for callers that submit then wait separately). */
export async function waitFinalized(provider, txId, opts = {}) {
  return watchTransaction(provider, txId, { timeoutMs: opts.timeoutMs ?? 90_000 });
}
