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
export { OnChainBudget, XTR } from "./budget";
export type { LedgerEntry, OnChainBudgetOptions } from "./budget";
export { encodeMemo, newInvoiceId, MEMO_PREFIX, MAX_MEMO_BYTES } from "./invoice";
export { AgentPayError, PolicyViolation, ChainError, InvoiceError } from "./errors";
