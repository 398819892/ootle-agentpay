"use strict";
/**
 * Exception hierarchy — mirrors `agentpay.errors` in the Python SDK.
 * Every failure the client raises derives from AgentPayError.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoiceError = exports.ChainError = exports.PolicyViolation = exports.AgentPayError = void 0;
class AgentPayError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
        // Keep `instanceof` working when compiled down to ES5-ish targets.
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.AgentPayError = AgentPayError;
/** A payment was refused by the session policy. `reasons` lists every rule broken. */
class PolicyViolation extends AgentPayError {
    constructor(reasons) {
        super(reasons.join("; "));
        this.reasons = reasons;
    }
}
exports.PolicyViolation = PolicyViolation;
/** The chain adapter failed (rejected transaction, indexer error...). */
class ChainError extends AgentPayError {
}
exports.ChainError = ChainError;
/** Malformed, expired or otherwise unusable invoice / memo. */
class InvoiceError extends AgentPayError {
}
exports.InvoiceError = InvoiceError;
