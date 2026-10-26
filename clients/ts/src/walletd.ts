/**
 * Minimal JSON-RPC client for a Tari Ootle wallet daemon (auth = `none` devnet mode).
 *
 * A direct, 1:1 port of `WalletdClient` in the Python SDK's `agentpay/onchain.py`. It is
 * deliberately dependency-free: a template component is driven by submitting a transaction
 * *manifest*, which the daemon parses, signs (with the referenced account) and commits. No
 * client-side cryptography or signing is involved.
 */
import { ChainError } from "./errors";

/** Default local-swarm wallet daemon endpoint (auth = none). */
export const DEFAULT_WALLETD_URL = "http://127.0.0.1:12010/json_rpc";

// Transient public-testnet (esmeralda) indexer errors worth retrying a manifest submit through.
// A local swarm never produces these, so the retry logic below stays dormant there.
const TRANSIENT_MARKERS = [
  "did not respond within", "Network interface", "timed out", "operation timed out",
  "http2", "stream error", "connection error", "Indexer client error",
  "Failed to send request", "SendRequest", "Failed to submit transaction",
];
const SUBMIT_RETRIES = 30;
const SUBMIT_RETRY_DELAY_MS = 12_000;

function isTransient(message: string): boolean {
  return TRANSIENT_MARKERS.some((m) => message.includes(m));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract a human reject reason from a finalized-but-rejected result tree. */
export function rejectReason(result: unknown): string | null {
  const blob = JSON.stringify(result);
  let m = blob.match(/"(?:ExecutionFailure|OneOrMoreInputsNotFound|[A-Za-z]*Error)":"([^"]+)"/);
  if (m) return m[1];
  m = blob.match(/Template error: ([^"]+)/);
  return m ? m[1] : null;
}

type RpcResponse = { result?: any; error?: { code?: number; message?: string } };

export class WalletdClient {
  readonly url: string;
  private token: string | null = null;

  constructor(url: string = DEFAULT_WALLETD_URL) {
    this.url = url;
  }

  private async rpc(method: string, params: unknown): Promise<RpcResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = "Bearer " + this.token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const resp = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      return (await resp.json()) as RpcResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Mint an admin token. On an `auth=none` devnet daemon this needs no credentials. */
  async connect(): Promise<this> {
    const r = await this.rpc("auth.request", {
      permissions: ["Admin"], duration: null, credentials: "None",
    });
    if (r.error) throw new ChainError(r.error.message ?? "auth.request failed");
    this.token = r.result.token;
    return this;
  }

  // -- accounts -------------------------------------------------------------------
  async accountAddress(name: string): Promise<string> {
    const r = await this.rpc("accounts.list", { offset: 0, limit: 50 });
    for (const a of r.result?.accounts ?? []) {
      if (a.account?.name === name) return a.account.component_address;
    }
    throw new ChainError(`account ${JSON.stringify(name)} not found`);
  }

  async createAccount(name: string): Promise<string> {
    const r = await this.rpc("accounts.create", {
      account_name: name, custom_access_rules: null, max_fee: null, is_default: false, key_id: null,
    });
    if (r.error) throw new ChainError(r.error.message ?? "accounts.create failed");
    return r.result.account.component_address;
  }

  /** Claim free test coins (localnet faucet) so the account exists on chain with a balance. */
  async fund(name: string, amount = 1_000_000, maxFee = 50_000): Promise<void> {
    await this.rpc("accounts.create_free_test_coins", {
      account: { Name: name }, amount, max_fee: maxFee, key_id: null,
    });
  }

  async balance(name: string): Promise<number> {
    const r = await this.rpc("accounts.get_balances", { account: { Name: name }, refresh: true });
    for (const b of r.result?.balances ?? []) {
      if (b.token_symbol === "tTARI") return Number(b.balance);
    }
    return 0;
  }

  // -- transactions ---------------------------------------------------------------
  private async submitManifest(
    manifest: string, variables: Record<string, string>, maxFee: number, dryRun: boolean,
  ): Promise<RpcResponse> {
    // Retry ONLY on transient public-indexer errors (connection / 30s timeouts seen on
    // esmeralda). A local swarm never hits these; a template/policy rejection is returned
    // immediately (never retried).
    const params = { manifest, variables, max_fee: maxFee, dry_run: dryRun };
    let last: RpcResponse = {};
    for (let i = 0; i < SUBMIT_RETRIES; i++) {
      last = await this.rpc("transactions.submit_manifest", params);
      const err = last.error;
      if (!err || !isTransient(err.message ?? "")) return last;
      await sleep(SUBMIT_RETRY_DELAY_MS);
    }
    return last; // exhausted: hand back the last (transient) error for the caller to surface
  }

  async dryRun(
    manifest: string, variables: Record<string, string>, maxFee = 200_000,
  ): Promise<RpcResponse> {
    return this.submitManifest(manifest, variables, maxFee, true);
  }

  /**
   * Submit a manifest for real and wait for it to finalize. Returns the finalized result
   * (a dict containing `Accept`). Throws ChainError on rejection.
   */
  async run(
    manifest: string, variables: Record<string, string>, maxFee = 200_000,
  ): Promise<any> {
    const r = await this.submitManifest(manifest, variables, maxFee, false);
    if (r.error) throw new ChainError(r.error.message ?? "submit_manifest failed");
    const txId = r.result?.transaction_id ?? r.result?.hash;
    for (let i = 0; i < 120; i++) { // esmeralda finalization can be slow under congestion
      const got = await this.rpc("transactions.get_result", { transaction_id: txId });
      const res = got.result;
      if (res) {
        const blob = JSON.stringify(res);
        if (blob.includes('"Reject"')) throw new ChainError(rejectReason(res) ?? "transaction rejected");
        if (blob.includes('"Accept"')) return res;
      }
      await sleep(1_500);
    }
    throw new ChainError(`transaction ${txId} did not finalize in time`);
  }
}
