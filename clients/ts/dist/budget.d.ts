import { WalletdClient } from "./walletd";
import { WindowStatus } from "./window";
/** Native Tari test token used as the (plaintext, countable) budget resource on a devnet. */
export declare const XTR = "XTR";
/**
 * A base-unit amount. Accepted as a `bigint`, a decimal-integer `string`, or a `number` — but a
 * `number` is only safe below 2^53, so anything that large must be passed as a string/bigint.
 * Base-unit amounts are integers and can exceed JS's safe-integer range, so they are carried as
 * decimal strings and compared with BigInt; they NEVER pass through a lossy float.
 */
export type AmountInput = bigint | number | string;
export interface LedgerEntry {
    merchant: string;
    /** Base-unit amount as a decimal-integer string (exact; may exceed 2^53). */
    amount: string;
    memo: string;
    txKind: "pay" | "pay_via_escrow";
}
/** Live budget state decoded from the name-keyed `AgentBudget.info` event (#1). Amount/epoch fields
 * are kept as exact decimal strings (the event payload is strings — no lossy JS-number round-trip). */
export interface BudgetInfo {
    revoked: boolean;
    balance: string;
    perTxCap: string;
    dailyCap: string;
    spentInWindow: string;
    windowStartEpoch: string;
    epochsPerWindow: string;
}
export interface OnChainBudgetOptions {
    /** Defaults to `ownerAccount` (devnet: one account acts as both owner and agent). */
    agentAccount?: string;
    /** Manifest dialect for owner-badge calls (see `proofWindowsDefault`). Default: env / `true`. */
    proofWindows?: boolean;
}
export declare class OnChainBudget {
    readonly client: WalletdClient;
    readonly budgetTemplate: string;
    readonly ownerAccount: string;
    readonly agentAccount: string;
    /** Open an `authorize!` window around owner-badge calls (0.49+ dialect) or not (0.47). */
    readonly proofWindows: boolean;
    component: string | null;
    ownerBadge: string | null;
    agentBadge: string | null;
    /**
     * The resource the budget is denominated in. `"XTR"` (the native test token) by default so the
     * devnet flow is unchanged; a non-XTR budget passes a `resource_…` address to `open` (the template
     * itself is resource-agnostic — it locks whatever it is funded with). `topUp` reuses it. Mirrors
     * the Python SDK's `OnChainBudget.resource`.
     */
    resource: string;
    perTxCap: string;
    dailyCap: string;
    whitelist: string[];
    revoked: boolean;
    spent: string;
    ledger: LedgerEntry[];
    sessions: string[];
    revokedSessions: string[];
    /**
     * The agent session badge this client proves when it pays (label of one non-fungible of the
     * agent-badge resource). `"default"` is the badge minted by `open`; set it to a label issued with
     * `issueAgentBadge` to pay as that session, or pass `{ session }` per call. The proof is built with
     * `create_proof_by_non_fungible_ids` so it carries EXACTLY this one token: the template rejects a
     * proof with several session tokens ("Present exactly one agent session badge"), which is what a
     * plain `create_proof_for_resource` produces once an account holds more than one session badge.
     */
    session: string;
    constructor(client: WalletdClient, budgetTemplate: string, ownerAccount: string, opts?: OnChainBudgetOptions);
    /**
     * Manifest expression for the budget's resource: the `XTR` keyword for the native token, else a
     * strictly-validated `address!("resource_…")` — so the resource never reaches the manifest as a raw
     * string splice (same injection guard as every other spliced value).
     */
    private resourceArg;
    open(params: {
        fund: AmountInput;
        perTxCap: AmountInput;
        dailyCap: AmountInput;
        epochsPerWindow: number;
        whitelist: string[];
        /** Resource to fund the budget with: `"XTR"` (default) or a `resource_…` address. */
        resource?: string;
    }): Promise<this>;
    /**
     * Recover the budget this instance opened from a CONFIRMED open-tx result, when the open itself
     * came back ambiguous ("unknown") and the caller never learned the component. Locate the new
     * component in the finalized result and resolve its badges from chain, exactly as `open()` does,
     * then populate this instance. `exclude` lists component addresses that are NOT the new budget
     * (the owner and agent accounts are always excluded; pass known merchant/whitelist addresses too,
     * so a whitelisted merchant mentioned in the result is never mistaken for the budget). Returns the
     * component address, or null if the result created no new component (so the caller can leave the
     * record open rather than mount the wrong thing).
     */
    attachFromOpenResult(result: unknown, exclude?: string[]): Promise<string | null>;
    /** Read `[ownerBadge, agentBadge]` authoritatively from the component's on-chain state. */
    private readBadges;
    revoke(): Promise<void>;
    withdraw(amount: AmountInput): Promise<void>;
    addMerchant(merchant: string): Promise<void>;
    /**
     * Owner removes `merchant` from the on-chain whitelist (template `remove_merchant`, owner-badge
     * gated). The address stops being payable the moment the tx finalizes; the local mirror is
     * updated only after the chain accepted the call. Removing an address that is not whitelisted is
     * a no-op on chain (the template's set-remove is idempotent).
     */
    removeMerchant(merchant: string): Promise<void>;
    /**
     * Owner changes both caps in one on-chain call (template `set_limits`, owner-badge gated). The
     * chain enforces the new per-transaction cap on the very next `pay`; the daily cap applies to the
     * current rolling window (spend already counted in the window is kept, not reset). Amounts are
     * normalised through the same guard as every other `amount!(…)` literal.
     */
    setLimits(perTxCap: AmountInput, dailyCap: AmountInput): Promise<void>;
    /**
     * Owner mints a new agent session badge labelled `session` and deposits it into `toAccount`
     * (defaults to this budget's agent account). The new badge can `pay` within the same on-chain
     * caps/whitelist until the owner revokes that session. Returns the session label.
     */
    issueAgentBadge(session: string, opts?: {
        toAccount?: string;
    }): Promise<string>;
    /**
     * Owner revokes a single agent session badge. Other sessions keep working; use `revoke()` for the
     * global kill switch.
     */
    revokeSession(session: string): Promise<void>;
    /**
     * Owner reconfigures the rolling allowance window (and restarts it now). The daily cap is the
     * recurring per-window allowance — there is no on-chain timer (see the template docs).
     */
    setWindow(epochsPerWindow: number): Promise<void>;
    /**
     * Add `amount` to the budget's vault, funded from `fromAccount` (defaults to the owner). `top_up`
     * is open on the template, so a keeper account can replenish on its own cadence — the chain has no
     * scheduler to do it automatically.
     */
    topUp(amount: AmountInput, opts?: {
        fromAccount?: string;
    }): Promise<void>;
    /**
     * Manifest lines that prove the owner badge — and, in the 0.49 dialect, open the authorization
     * window the budget's owner-gated methods are reached through.
     */
    private ownerProofOpen;
    /** Closes the window opened by `ownerProofOpen` (0.49 dialect) and drops the proof. */
    private ownerProofClose;
    private ownerCall;
    private payManifest;
    /**
     * The agent pays a whitelisted merchant. The client-side checks are only an early, friendly
     * error — the chain enforces the real limits regardless of what this client does. The local
     * ledger is updated from the on-chain `pay` event, not from the request.
     */
    pay(merchant: string, amount: AmountInput, opts?: {
        memo?: string;
        session?: string;
    }): Promise<any>;
    /**
     * Ask the validator (via a dry run) whether this pay would be rejected, returning the on-chain
     * reason — used to show that the *chain*, not the client, enforces the rules. Returns null if
     * the pay would be accepted.
     */
    wouldReject(merchant: string, amount: AmountInput, opts?: {
        memo?: string;
        session?: string;
    }): Promise<string | null>;
    /** Pay an invoice: the invoice id + agent tag ride along as the on-chain memo. `session` selects
     *  which issued session badge pays (defaults to this client's `session`). */
    payInvoice(params: {
        merchant: string;
        invoiceId: string;
        amount: AmountInput;
        agentTag?: string;
        session?: string;
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
    /**
     * Read live budget state by dry-running `get_info` and decoding its name-keyed `info` event (#1):
     * `revoked`, `balance`, `perTxCap`, `dailyCap`, `spentInWindow`, `windowStartEpoch`,
     * `epochsPerWindow` — amount/epoch fields as exact decimal strings. Because fields are keyed by
     * NAME, a same-type field swap in the component struct is caught here (the positional read cannot
     * see it). The dry run charges no real fee. Mirrors the Python SDK's `read_info`.
     */
    readInfo(): Promise<BudgetInfo>;
    readWindow(): Promise<WindowStatus>;
    /**
     * Extract the AgentBudget `pay` events (payload: merchant/amount/memo/spent_in_window) from a
     * tx result — this is how a watcher keeps a local ledger in sync with the chain. The same event
     * is recorded in two places in the result, so we de-duplicate.
     */
    static payEvents(result: any): any[];
}
