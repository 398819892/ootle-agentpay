/**
 * @agentpay/client — TypeScript/JS client for AgentPay on Tari Ootle.
 *
 * A thin JSON-RPC + transaction-manifest layer over a Tari Ootle wallet daemon. The on-chain
 * AgentBudget template enforces the per-tx cap, daily cap, merchant whitelist and kill switch;
 * this client never signs or holds keys — the wallet daemon signs with the referenced account.
 *
 * Mirrors the Python SDK's `agentpay.onchain` module 1:1 (same RPC methods, manifest strings and
 * event parsing).
 */
export { WalletdClient, DEFAULT_WALLETD_URL, rejectReason } from "./walletd";
export type { TxResult, WalletdClientOptions } from "./walletd";
export { OnChainBudget, XTR } from "./budget";
export type { LedgerEntry, OnChainBudgetOptions } from "./budget";
export { windowStatus, formatEta, EPOCH_MINUTES } from "./window";
export type { WindowStatus, BudgetWindowInput } from "./window";
export { encodeMemo, newInvoiceId, MEMO_PREFIX, MAX_MEMO_BYTES } from "./invoice";
export { AgentPayError, PolicyViolation, ChainError, InvoiceError } from "./errors";

// Thin client for the hosted integration API (/api/v1) — for third-party / agent callers who use
// the owner's hosted HTTP service with an API key and never touch walletd. See api.ts / docs/api.md.
export { AgentPayApiClient, AgentPayApiError } from "./api";
export type { Receipt, Merchant, Budget, PayParams, ApiRole, AgentPayApiOptions } from "./api";
