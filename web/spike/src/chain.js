// Read + submit side: the indexer REST API via ootle.ts's IndexerProvider. No keys here.
import {
  Network,
  getVaultIdsForAccount,
  resolveMaxEpoch,
  signTransaction,
  sealTransaction,
  submitTransaction,
  classifyOutcome,
} from "@tari-project/ootle";
import { IndexerProvider } from "@tari-project/ootle-indexer";

export const LOCALNET = { network: Network.LocalNet, indexerUrl: "http://127.0.0.1:12008" };

export async function connectIndexer(url = LOCALNET.indexerUrl, network = LOCALNET.network) {
  return IndexerProvider.connect({ url, network });
}

export async function accountVaults(provider, account) {
  return getVaultIdsForAccount(provider, account);
}

export async function maxEpoch(provider) {
  return resolveMaxEpoch(provider);
}

/** Dry-run through the indexer's /transactions/dry-run endpoint (returns the raw ExecuteResult). */
export async function dryRun(provider, signers, unsignedTx, indexerUrl = LOCALNET.indexerUrl) {
  const signed = await signTransaction(signers, { ...unsignedTx, dry_run: true });
  const envelope = sealTransaction(signed);
  const r = await fetch(`${indexerUrl.replace(/\/$/, "")}/transactions/dry-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: envelope }),
  });
  if (!r.ok) throw new Error(`dry-run HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

/**
 * Poll the indexer until `txId` is finalized. ootle.ts 0.11's `watchTransaction` throws on the
 * 404 the indexer returns in the first ~second after a submit (the tx is not indexed yet), so
 * this loop treats 404 as "pending". Throws with the chain's reason on Reject / FeeIntentCommit.
 */
export async function waitFinalized(provider, txId, { timeoutMs = 90_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let response = null;
    try {
      response = await provider.getTransactionResult(txId);
    } catch (e) {
      if (e?.status !== 404) throw e;
    }
    const result = response?.result;
    if (result && result !== "Pending" && "Finalized" in result) {
      const c = classifyOutcome(result);
      // `final_decision` is "Commit" even when only the FEE intent committed and execution was
      // rejected (AcceptFeeRejectRest), so also read the engine's own TransactionResult.
      const exec = result.Finalized.execution_result?.finalize?.result;
      const execReject = exec && typeof exec === "object" ? (exec.Reject ?? exec.AcceptFeeRejectRest?.[1] ?? null) : null;
      if (c && c.outcome === "Commit" && !execReject) return response;
      if (c) {
        const outcome = execReject && c.outcome === "Commit" ? "FeeIntentCommit" : c.outcome;
        const reason = c.reason ?? (execReject ? JSON.stringify(execReject) : "");
        const err = new Error(`transaction ${txId} ${outcome}: ${reason}`);
        err.txId = txId;
        err.reason = reason;
        err.outcome = outcome;
        throw err;
      }
    }
    if (Date.now() > deadline) throw new Error(`transaction ${txId} did not finalize within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** sign (by the given signers) -> seal (throwaway key, WASM) -> submit -> wait. Returns {txId, receipt}. */
export async function signSealSubmit(provider, signers, unsignedTx, opts = {}) {
  const signed = await signTransaction(signers, unsignedTx);
  const envelope = sealTransaction(signed);
  const txId = await submitTransaction(provider, envelope);
  const receipt = await waitFinalized(provider, txId, { timeoutMs: opts.timeoutMs ?? 90_000 });
  return { txId, receipt };
}
