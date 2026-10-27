/** Default local-swarm wallet daemon endpoint (auth = none). */
export declare const DEFAULT_WALLETD_URL = "http://127.0.0.1:12010/json_rpc";
/** `["accept", null]` / `["reject", reason]` once finalized, else null (still pending). */
export declare function finalizedOutcome(rpcResult: unknown): ["accept", null] | ["reject", string] | null;
/** Extract a human reject reason from a finalized-but-rejected result tree, or null if not rejected. */
export declare function rejectReason(result: unknown): string | null;
type RpcResponse = {
    result?: any;
    error?: {
        code?: number;
        message?: string;
    };
};
/** A resolved on-chain outcome for a single transaction id. `pending` = not finalized yet. */
export interface TxResult {
    status: "pending" | "accept" | "reject";
    /** The human reject reason when `status === "reject"`, else null. */
    reason: string | null;
    /** The raw walletd result tree (for event extraction on accept), or null if none yet. */
    result: any;
}
export interface WalletdClientOptions {
    /** How many times `run` polls `get_result` before giving up (→ a `pending` ChainError). */
    finalizeTries?: number;
    /** Delay between `get_result` polls, in milliseconds. */
    finalizeDelayMs?: number;
}
export declare class WalletdClient {
    readonly url: string;
    private token;
    readonly finalizeTries: number;
    readonly finalizeDelayMs: number;
    /**
     * The transaction id of the most recent `run`/`submit` on this client. The dashboard server
     * serialises all chain ops, so right after an op resolves this is unambiguously that op's tx —
     * letting the caller journal the tx id even when the op later rejects or times out.
     */
    lastTxId: string | null;
    constructor(url?: string, opts?: WalletdClientOptions);
    private rpc;
    /** Mint an admin token. On an `auth=none` devnet daemon this needs no credentials. */
    connect(): Promise<this>;
    accountAddress(name: string): Promise<string>;
    createAccount(name: string): Promise<string>;
    /** Claim free test coins (localnet faucet) so the account exists on chain with a balance. */
    fund(name: string, amount?: number, maxFee?: number): Promise<void>;
    balance(name: string): Promise<number>;
    /**
     * The current chain epoch (via `settings.get`). Ootle measures time in epochs, not wall-clock,
     * so this is what the AgentBudget rolling window is compared against.
     */
    currentEpoch(): Promise<number>;
    /** Fetch a substate (component / resource / vault) by its address. Read-only. */
    getSubstate(substateId: string): Promise<any>;
    private submitManifest;
    dryRun(manifest: string, variables: Record<string, string>, maxFee?: number): Promise<RpcResponse>;
    /**
     * Submit a manifest for real (no waiting) and return its transaction id. Also records it as
     * `lastTxId`. Splitting submit from the finalize-wait lets a caller persist the tx id to a
     * journal *before* it blocks on finalization, so a crash mid-wait leaves a reconcilable record.
     */
    submit(manifest: string, variables: Record<string, string>, maxFee?: number): Promise<string>;
    /**
     * Read-only: resolve a transaction id to `{ accept | reject | pending }` by a single
     * `get_result` call. Never submits or signs anything — this is what a reconciler uses on
     * startup to settle a previously-submitted (persisted) tx id against the chain's verdict.
     */
    getResult(transactionId: string): Promise<TxResult>;
    /**
     * Submit a manifest for real and wait for it to finalize. Returns the finalized result
     * (a dict containing `Accept`). Throws ChainError on rejection. If it does not finalize within
     * the configured budget the thrown ChainError carries `pending = true` so the caller can record
     * the tx as *unknown* (submitted, not yet confirmed) and reconcile it later by `lastTxId` —
     * never as a success.
     */
    run(manifest: string, variables: Record<string, string>, maxFee?: number): Promise<any>;
}
export {};
