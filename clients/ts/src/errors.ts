/**
 * Exception hierarchy — mirrors `agentpay.errors` in the Python SDK.
 * Every failure the client raises derives from AgentPayError.
 */

export class AgentPayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Keep `instanceof` working when compiled down to ES5-ish targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A payment was refused by the session policy. `reasons` lists every rule broken. */
export class PolicyViolation extends AgentPayError {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join("; "));
    this.reasons = reasons;
  }
}

/** The chain adapter failed (rejected transaction, indexer error...). */
export class ChainError extends AgentPayError {}

/** Malformed, expired or otherwise unusable invoice / memo. */
export class InvoiceError extends AgentPayError {}
