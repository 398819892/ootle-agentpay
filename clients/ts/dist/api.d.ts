/**
 * @agentpay/client — thin client for the hosted AgentPay integration API (`/api/v1`).
 *
 * This is NOT the on-chain client. `OnChainBudget` / `WalletdClient` (this package's other exports)
 * talk directly to a Tari wallet daemon and are for the OWNER/operator who runs the hosted service.
 * A third-party developer or an autonomous agent should NOT touch walletd — they call the owner's
 * hosted HTTP API with an API key, and the on-chain AgentBudget enforces the spending limits. This
 * class is a tiny, dependency-free wrapper over `fetch` for exactly that: get a key → make a capped
 * payment → poll the receipt → recover from a failure via the idempotency key.
 *
 * Node 18+ (global fetch) or any modern browser. Zero runtime dependencies.
 */
export type ApiRole = "agent" | "admin";
export interface Receipt {
    id: string;
    status: "pending" | "confirmed" | "rejected" | "unknown";
    txId: string | null;
    amount: string | null;
    merchant: string | null;
    merchantName: string | null;
    memo: string | null;
    invoiceId: string | null;
    reason: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}
export interface Merchant {
    address: string;
    name: string | null;
}
export interface Budget {
    component: string;
    perTxCap: string;
    dailyCap: string;
    spent: string;
    dailyRemaining: string;
    treasury: string;
    balance: string;
    revoked: boolean;
    frozen: boolean;
    window: unknown;
    whitelist: Merchant[];
    funded: string;
    withdrawn: string;
    source: Record<string, unknown>;
}
/** An error from the API carrying the HTTP status and any policy flags (frozen / rateLimited). */
export declare class AgentPayApiError extends Error {
    status: number;
    frozen: boolean;
    rateLimited: boolean;
    body: any;
    constructor(status: number, message: string, body?: any);
}
export interface AgentPayApiOptions {
    /** Base URL of the hosted dashboard, e.g. "https://pay.example.com" (no trailing /api/v1). */
    baseUrl: string;
    /** The bearer API key issued by the owner (agent or admin). */
    apiKey: string;
    /** Override the fetch implementation (tests, custom agents). Defaults to global fetch. */
    fetch?: typeof fetch;
}
export interface PayParams {
    merchant: string;
    amount: string | number | bigint;
    memo?: string;
    invoiceId?: string;
    agentTag?: string;
    /** Idempotency key — a repeat with the same key never double-spends and returns the first receipt.
     *  If omitted it is derived from `invoiceId` (so a retry with the same invoiceId is safe); if BOTH
     *  are omitted a fresh random key is used per call, which is NOT retry-safe — pass one for retries. */
    idempotencyKey?: string;
}
export declare class AgentPayApiClient {
    private base;
    private apiKey;
    private _fetch;
    constructor(opts: AgentPayApiOptions);
    private request;
    /**
     * Make a capped payment. Returns the receipt even when the chain REJECTS it (receipt.status
     * === "rejected" with a reason) — a 402 is a verdict, not a transport error. Transport/validation
     * failures throw AgentPayApiError. The idempotency key makes a retry after a network blip safe (the
     * same key returns the original receipt instead of paying twice): pass `idempotencyKey` explicitly,
     * or an `invoiceId` from which it is derived deterministically. With NEITHER, a fresh random key is
     * used per call — so an identical retry would pay twice; never rely on the random default for retries.
     */
    pay(params: PayParams): Promise<{
        receipt: Receipt;
        replayed: boolean;
    }>;
    /** Fetch one receipt by payment id (the idempotency key). The server settles it against chain. */
    getPayment(id: string): Promise<Receipt>;
    /** List all payment receipts. */
    listPayments(): Promise<Receipt[]>;
    /**
     * Poll a payment until it reaches a terminal status (confirmed/rejected) or the attempts run out.
     * Returns the last receipt seen (which may still be pending/unknown — inspect `.status`).
     */
    waitForPayment(id: string, opts?: {
        tries?: number;
        delayMs?: number;
    }): Promise<Receipt>;
    /** Budget status (caps, remaining this window, treasury) — all chain-derived. */
    getBudget(): Promise<Budget>;
    /** The on-chain merchant whitelist. */
    listMerchants(): Promise<Merchant[]>;
    /** Open/fund a budget (admin key). */
    openBudget(params: {
        fund: string | number | bigint;
        perTxCap: string | number | bigint;
        dailyCap: string | number | bigint;
        epochsPerWindow?: number;
        whitelist?: string[];
    }): Promise<Budget>;
    /** Add a merchant to the whitelist (admin key). Returns the updated whitelist. */
    addMerchant(merchant: string): Promise<Merchant[]>;
    /**
     * Remove a merchant from the ON-CHAIN whitelist (admin key): the owner badge signs the template's
     * `remove_merchant`, so the address stops being payable once the tx finalizes. `merchant` is a
     * friendly name the service already knows, or a `component_…` address. Returns the updated
     * whitelist; `pending: true` + `txId` when the chain has not confirmed yet (poll `getBudget`).
     */
    removeMerchant(merchant: string): Promise<{
        removed: {
            name: string | null;
            address: string;
        } | null;
        merchants: Merchant[];
        pending?: boolean;
        txId?: string | null;
        notice?: string;
    }>;
    /** @deprecated Renamed `removeMerchant` — the endpoint now removes the merchant ON CHAIN. */
    removeMerchantAlias(name: string): Promise<{
        removed: {
            name: string | null;
            address: string;
        } | null;
        merchants: Merchant[];
    }>;
    /**
     * Change both on-chain caps in one owner-badge call (admin key; template `set_limits`). The new
     * per-transaction cap binds on the very next payment. Returns the updated (chain-read) budget.
     */
    setLimits(perTxCap: string | number | bigint, dailyCap: string | number | bigint): Promise<Budget>;
    /** Recent audit entries (admin key). */
    getAudit(limit?: number): Promise<any[]>;
}
