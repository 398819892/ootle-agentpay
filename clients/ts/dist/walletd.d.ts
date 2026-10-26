/** Default local-swarm wallet daemon endpoint (auth = none). */
export declare const DEFAULT_WALLETD_URL = "http://127.0.0.1:12010/json_rpc";
/** Extract a human reject reason from a finalized-but-rejected result tree. */
export declare function rejectReason(result: unknown): string | null;
type RpcResponse = {
    result?: any;
    error?: {
        code?: number;
        message?: string;
    };
};
export declare class WalletdClient {
    readonly url: string;
    private token;
    constructor(url?: string);
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
     * Submit a manifest for real and wait for it to finalize. Returns the finalized result
     * (a dict containing `Accept`). Throws ChainError on rejection.
     */
    run(manifest: string, variables: Record<string, string>, maxFee?: number): Promise<any>;
}
export {};
