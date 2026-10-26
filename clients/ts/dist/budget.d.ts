import { WalletdClient } from "./walletd";
import { WindowStatus } from "./window";
/** Native Tari test token used as the (plaintext, countable) budget resource on a devnet. */
export declare const XTR = "XTR";
export interface LedgerEntry {
    merchant: string;
    amount: number;
    memo: string;
    txKind: "pay" | "pay_via_escrow";
}
export interface OnChainBudgetOptions {
    /** Defaults to `ownerAccount` (devnet: one account acts as both owner and agent). */
    agentAccount?: string;
}
export declare class OnChainBudget {
    readonly client: WalletdClient;
    readonly budgetTemplate: string;
    readonly ownerAccount: string;
    readonly agentAccount: string;
    component: string | null;
    ownerBadge: string | null;
    agentBadge: string | null;
    perTxCap: number;
    dailyCap: number;
    whitelist: string[];
    revoked: boolean;
    spent: number;
    ledger: LedgerEntry[];
    constructor(client: WalletdClient, budgetTemplate: string, ownerAccount: string, opts?: OnChainBudgetOptions);
    open(params: {
        fund: number;
        perTxCap: number;
        dailyCap: number;
        epochsPerWindow: number;
        whitelist: string[];
    }): Promise<this>;
    revoke(): Promise<void>;
    withdraw(amount: number): Promise<void>;
    addMerchant(merchant: string): Promise<void>;
    private ownerCall;
    private payManifest;
    /**
     * The agent pays a whitelisted merchant. The client-side checks are only an early, friendly
     * error — the chain enforces the real limits regardless of what this client does. The local
     * ledger is updated from the on-chain `pay` event, not from the request.
     */
    pay(merchant: string, amount: number, opts?: {
        memo?: string;
    }): Promise<any>;
    /**
     * Ask the validator (via a dry run) whether this pay would be rejected, returning the on-chain
     * reason — used to show that the *chain*, not the client, enforces the rules. Returns null if
     * the pay would be accepted.
     */
    wouldReject(merchant: string, amount: number, opts?: {
        memo?: string;
    }): Promise<string | null>;
    /** Pay an invoice: the invoice id + agent tag ride along as the on-chain memo. */
    payInvoice(params: {
        merchant: string;
        invoiceId: string;
        amount: number;
        agentTag?: string;
    }): Promise<any>;
    private precheck;
    /**
     * Read the budget's live rolling-window status from chain and translate it into human-readable
     * numbers (how much is left this window, roughly how long until it resets). Read-only: it queries
     * the component substate and the current epoch, and changes nothing on chain.
     *
     * The "daily cap" is enforced over a rolling window of `epochs_per_window` chain epochs
     * (≈30 min each), reset lazily on the next payment — so the wall-clock figures are approximate.
     * See `window.ts` for the pure computation.
     */
    readWindow(): Promise<WindowStatus>;
    /**
     * Extract the AgentBudget `pay` events (payload: merchant/amount/memo/spent_in_window) from a
     * tx result — this is how a watcher keeps a local ledger in sync with the chain. The same event
     * is recorded in two places in the result, so we de-duplicate.
     */
    static payEvents(result: any): any[];
}
