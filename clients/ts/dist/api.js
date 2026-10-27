"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentPayApiClient = exports.AgentPayApiError = void 0;
/** An error from the API carrying the HTTP status and any policy flags (frozen / rateLimited). */
class AgentPayApiError extends Error {
    constructor(status, message, body) {
        super(message);
        this.name = "AgentPayApiError";
        this.status = status;
        this.body = body;
        this.frozen = Boolean(body && body.frozen);
        this.rateLimited = Boolean(body && body.rateLimited);
    }
}
exports.AgentPayApiError = AgentPayApiError;
/** 16 lowercase hex chars — a safe default idempotency key / invoice id. */
function randomId() {
    const bytes = new Uint8Array(8);
    const g = globalThis;
    if (g.crypto && typeof g.crypto.getRandomValues === "function")
        g.crypto.getRandomValues(bytes);
    if (!bytes.some((b) => b))
        for (let i = 0; i < 8; i++)
            bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
class AgentPayApiClient {
    constructor(opts) {
        if (!opts || !opts.baseUrl)
            throw new Error("AgentPayApiClient: baseUrl is required");
        if (!opts.apiKey)
            throw new Error("AgentPayApiClient: apiKey is required");
        this.base = opts.baseUrl.replace(/\/+$/, "");
        this.apiKey = opts.apiKey;
        this._fetch = opts.fetch || globalThis.fetch;
        if (!this._fetch)
            throw new Error("AgentPayApiClient: no fetch available (Node 18+ or pass opts.fetch)");
    }
    async request(method, path, body, headers = {}) {
        const res = await this._fetch(`${this.base}/api/v1${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let data = undefined;
        try {
            data = text ? JSON.parse(text) : undefined;
        }
        catch {
            data = { error: text };
        }
        if (!res.ok) {
            throw new AgentPayApiError(res.status, (data && data.error) || `HTTP ${res.status}`, data);
        }
        return data;
    }
    /**
     * Make a capped payment. Returns the receipt even when the chain REJECTS it (receipt.status
     * === "rejected" with a reason) — a 402 is a verdict, not a transport error. Transport/validation
     * failures throw AgentPayApiError. Pass `idempotencyKey` (or let it default) so a retry after a
     * network blip is safe: the same key returns the original receipt instead of paying twice.
     */
    async pay(params) {
        const idem = params.idempotencyKey || `pay_${randomId()}`;
        const body = { merchant: params.merchant, amount: String(params.amount) };
        if (params.memo !== undefined)
            body.memo = params.memo;
        if (params.invoiceId !== undefined)
            body.invoiceId = params.invoiceId;
        if (params.agentTag !== undefined)
            body.agentTag = params.agentTag;
        try {
            return await this.request("POST", "/payments", body, { "Idempotency-Key": idem });
        }
        catch (e) {
            // A 402 (chain rejection) carries a receipt in its body — surface it as a receipt, not a throw.
            if (e instanceof AgentPayApiError && e.status === 402 && e.body && e.body.receipt) {
                return { receipt: e.body.receipt, replayed: Boolean(e.body.replayed) };
            }
            throw e;
        }
    }
    /** Fetch one receipt by payment id (the idempotency key). The server settles it against chain. */
    async getPayment(id) {
        const r = await this.request("GET", `/payments/${encodeURIComponent(id)}`);
        return r.receipt;
    }
    /** List all payment receipts. */
    async listPayments() {
        const r = await this.request("GET", "/payments");
        return r.payments;
    }
    /**
     * Poll a payment until it reaches a terminal status (confirmed/rejected) or the attempts run out.
     * Returns the last receipt seen (which may still be pending/unknown — inspect `.status`).
     */
    async waitForPayment(id, opts = {}) {
        const tries = opts.tries ?? 20;
        const delayMs = opts.delayMs ?? 1500;
        let last = await this.getPayment(id);
        for (let i = 0; i < tries && (last.status === "pending" || last.status === "unknown"); i++) {
            await new Promise((r) => setTimeout(r, delayMs));
            last = await this.getPayment(id);
        }
        return last;
    }
    /** Budget status (caps, remaining this window, treasury) — all chain-derived. */
    async getBudget() {
        const r = await this.request("GET", "/budget");
        return r.budget;
    }
    /** The on-chain merchant whitelist. */
    async listMerchants() {
        const r = await this.request("GET", "/merchants");
        return r.merchants;
    }
    // ---- admin-key operations (throw 403 with an agent key) --------------------------------------
    /** Open/fund a budget (admin key). */
    async openBudget(params) {
        const r = await this.request("POST", "/budgets", {
            fund: String(params.fund),
            perTxCap: String(params.perTxCap),
            dailyCap: String(params.dailyCap),
            epochsPerWindow: params.epochsPerWindow,
            whitelist: params.whitelist || [],
        });
        return r.budget;
    }
    /** Add a merchant to the whitelist (admin key). Returns the updated whitelist. */
    async addMerchant(merchant) {
        const r = await this.request("POST", "/merchants", { merchant });
        return r.merchants;
    }
    /** Remove a local merchant alias (admin key). See docs/api.md for the on-chain caveat. */
    async removeMerchantAlias(name) {
        return await this.request("DELETE", `/merchants/${encodeURIComponent(name)}`);
    }
    /** Recent audit entries (admin key). */
    async getAudit(limit = 100) {
        const r = await this.request("GET", `/audit?limit=${encodeURIComponent(String(limit))}`);
        return r.entries;
    }
}
exports.AgentPayApiClient = AgentPayApiClient;
