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
/// <reference types="node" />
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
     *  Strongly recommended; defaults to a random key per call if omitted. */
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
     * failures throw AgentPayApiError. Pass `idempotencyKey` (or let it default) so a retry after a
     * network blip is safe: the same key returns the original receipt instead of paying twice.
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
    /** Remove a local merchant alias (admin key). See docs/api.md for the on-chain caveat. */
    removeMerchantAlias(name: string): Promise<{
        removedAlias: boolean;
        notice: string;
    }>;
    /** Recent audit entries (admin key). */
    getAudit(limit?: number): Promise<any[]>;
}
