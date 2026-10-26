/**
 * Exception hierarchy — mirrors `agentpay.errors` in the Python SDK.
 * Every failure the client raises derives from AgentPayError.
 */
export declare class AgentPayError extends Error {
    constructor(message: string);
}
/** A payment was refused by the session policy. `reasons` lists every rule broken. */
export declare class PolicyViolation extends AgentPayError {
    readonly reasons: readonly string[];
    constructor(reasons: readonly string[]);
}
/** The chain adapter failed (rejected transaction, indexer error...). */
export declare class ChainError extends AgentPayError {
}
/** Malformed, expired or otherwise unusable invoice / memo. */
export declare class InvoiceError extends AgentPayError {
}
