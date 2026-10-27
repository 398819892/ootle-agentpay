"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentPayApiError = exports.AgentPayApiClient = exports.InvoiceError = exports.ChainError = exports.PolicyViolation = exports.AgentPayError = exports.MAX_MEMO_BYTES = exports.MEMO_PREFIX = exports.newInvoiceId = exports.encodeMemo = exports.EPOCH_MINUTES = exports.formatEta = exports.windowStatus = exports.XTR = exports.OnChainBudget = exports.rejectReason = exports.DEFAULT_WALLETD_URL = exports.WalletdClient = void 0;
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
var walletd_1 = require("./walletd");
Object.defineProperty(exports, "WalletdClient", { enumerable: true, get: function () { return walletd_1.WalletdClient; } });
Object.defineProperty(exports, "DEFAULT_WALLETD_URL", { enumerable: true, get: function () { return walletd_1.DEFAULT_WALLETD_URL; } });
Object.defineProperty(exports, "rejectReason", { enumerable: true, get: function () { return walletd_1.rejectReason; } });
var budget_1 = require("./budget");
Object.defineProperty(exports, "OnChainBudget", { enumerable: true, get: function () { return budget_1.OnChainBudget; } });
Object.defineProperty(exports, "XTR", { enumerable: true, get: function () { return budget_1.XTR; } });
var window_1 = require("./window");
Object.defineProperty(exports, "windowStatus", { enumerable: true, get: function () { return window_1.windowStatus; } });
Object.defineProperty(exports, "formatEta", { enumerable: true, get: function () { return window_1.formatEta; } });
Object.defineProperty(exports, "EPOCH_MINUTES", { enumerable: true, get: function () { return window_1.EPOCH_MINUTES; } });
var invoice_1 = require("./invoice");
Object.defineProperty(exports, "encodeMemo", { enumerable: true, get: function () { return invoice_1.encodeMemo; } });
Object.defineProperty(exports, "newInvoiceId", { enumerable: true, get: function () { return invoice_1.newInvoiceId; } });
Object.defineProperty(exports, "MEMO_PREFIX", { enumerable: true, get: function () { return invoice_1.MEMO_PREFIX; } });
Object.defineProperty(exports, "MAX_MEMO_BYTES", { enumerable: true, get: function () { return invoice_1.MAX_MEMO_BYTES; } });
var errors_1 = require("./errors");
Object.defineProperty(exports, "AgentPayError", { enumerable: true, get: function () { return errors_1.AgentPayError; } });
Object.defineProperty(exports, "PolicyViolation", { enumerable: true, get: function () { return errors_1.PolicyViolation; } });
Object.defineProperty(exports, "ChainError", { enumerable: true, get: function () { return errors_1.ChainError; } });
Object.defineProperty(exports, "InvoiceError", { enumerable: true, get: function () { return errors_1.InvoiceError; } });
// Thin client for the hosted integration API (/api/v1) — for third-party / agent callers who use
// the owner's hosted HTTP service with an API key and never touch walletd. See api.ts / docs/api.md.
var api_1 = require("./api");
Object.defineProperty(exports, "AgentPayApiClient", { enumerable: true, get: function () { return api_1.AgentPayApiClient; } });
Object.defineProperty(exports, "AgentPayApiError", { enumerable: true, get: function () { return api_1.AgentPayApiError; } });
