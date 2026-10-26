"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletdClient = exports.DEFAULT_WALLETD_URL = void 0;
exports.rejectReason = rejectReason;
/**
 * Minimal JSON-RPC client for a Tari Ootle wallet daemon (auth = `none` devnet mode).
 *
 * A direct, 1:1 port of `WalletdClient` in the Python SDK's `agentpay/onchain.py`. It is
 * deliberately dependency-free: a template component is driven by submitting a transaction
 * *manifest*, which the daemon parses, signs (with the referenced account) and commits. No
 * client-side cryptography or signing is involved.
 */
const errors_1 = require("./errors");
/** Default local-swarm wallet daemon endpoint (auth = none). */
exports.DEFAULT_WALLETD_URL = "http://127.0.0.1:12010/json_rpc";
// Transient public-testnet (esmeralda) indexer errors worth retrying a manifest submit through.
// A local swarm never produces these, so the retry logic below stays dormant there.
const TRANSIENT_MARKERS = [
    "did not respond within", "Network interface", "timed out", "operation timed out",
    "http2", "stream error", "connection error", "Indexer client error",
    "Failed to send request", "SendRequest", "Failed to submit transaction",
];
const SUBMIT_RETRIES = 30;
const SUBMIT_RETRY_DELAY_MS = 12000;
function isTransient(message) {
    return TRANSIENT_MARKERS.some((m) => message.includes(m));
}
// An admin token has a finite lifetime, so a long-running host (e.g. the dashboard server) will
// eventually see these once its boot-time token lapses. We re-mint and retry transparently.
const AUTH_ERROR_MARKERS = ["Expired token", "Invalid token", "Access denied", "Unauthorized"];
function isAuthError(message) {
    return !!message && AUTH_ERROR_MARKERS.some((m) => message.includes(m));
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Extract a human reject reason from a finalized-but-rejected result tree. */
function rejectReason(result) {
    const blob = JSON.stringify(result);
    let m = blob.match(/"(?:ExecutionFailure|OneOrMoreInputsNotFound|[A-Za-z]*Error)":"([^"]+)"/);
    if (m)
        return m[1];
    m = blob.match(/Template error: ([^"]+)/);
    return m ? m[1] : null;
}
class WalletdClient {
    constructor(url = exports.DEFAULT_WALLETD_URL) {
        this.token = null;
        this.url = url;
    }
    async rpc(method, params, retriedAuth = false) {
        const headers = { "Content-Type": "application/json" };
        if (this.token)
            headers["Authorization"] = "Bearer " + this.token;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);
        let out;
        try {
            const resp = await fetch(this.url, {
                method: "POST",
                headers,
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
                signal: controller.signal,
            });
            out = (await resp.json());
        }
        finally {
            clearTimeout(timer);
        }
        // If a previously-minted token has expired, re-mint it once and retry the call transparently,
        // so a long-lived client (the dashboard server) doesn't fail every op until it's restarted.
        if (!retriedAuth && this.token && method !== "auth.request" && isAuthError(out.error?.message)) {
            this.token = null;
            await this.connect();
            return this.rpc(method, params, true);
        }
        return out;
    }
    /** Mint an admin token. On an `auth=none` devnet daemon this needs no credentials. */
    async connect() {
        const r = await this.rpc("auth.request", {
            permissions: ["Admin"], duration: null, credentials: "None",
        });
        if (r.error)
            throw new errors_1.ChainError(r.error.message ?? "auth.request failed");
        this.token = r.result.token;
        return this;
    }
    // -- accounts -------------------------------------------------------------------
    async accountAddress(name) {
        const r = await this.rpc("accounts.list", { offset: 0, limit: 50 });
        for (const a of r.result?.accounts ?? []) {
            if (a.account?.name === name)
                return a.account.component_address;
        }
        throw new errors_1.ChainError(`account ${JSON.stringify(name)} not found`);
    }
    async createAccount(name) {
        const r = await this.rpc("accounts.create", {
            account_name: name, custom_access_rules: null, max_fee: null, is_default: false, key_id: null,
        });
        if (r.error)
            throw new errors_1.ChainError(r.error.message ?? "accounts.create failed");
        return r.result.account.component_address;
    }
    /** Claim free test coins (localnet faucet) so the account exists on chain with a balance. */
    async fund(name, amount = 1000000, maxFee = 50000) {
        await this.rpc("accounts.create_free_test_coins", {
            account: { Name: name }, amount, max_fee: maxFee, key_id: null,
        });
    }
    async balance(name) {
        const r = await this.rpc("accounts.get_balances", { account: { Name: name }, refresh: true });
        for (const b of r.result?.balances ?? []) {
            if (b.token_symbol === "tTARI")
                return Number(b.balance);
        }
        return 0;
    }
    // -- chain reads (read-only; no signing) ----------------------------------------
    /**
     * The current chain epoch (via `settings.get`). Ootle measures time in epochs, not wall-clock,
     * so this is what the AgentBudget rolling window is compared against.
     */
    async currentEpoch() {
        const r = await this.rpc("settings.get", {});
        if (r.error)
            throw new errors_1.ChainError(r.error.message ?? "settings.get failed");
        const e = r.result?.current_epoch;
        if (typeof e !== "number")
            throw new errors_1.ChainError("settings.get did not return current_epoch");
        return e;
    }
    /** Fetch a substate (component / resource / vault) by its address. Read-only. */
    async getSubstate(substateId) {
        const r = await this.rpc("substates.get", { substate_id: substateId });
        if (r.error)
            throw new errors_1.ChainError(r.error.message ?? "substates.get failed");
        return r.result;
    }
    // -- transactions ---------------------------------------------------------------
    async submitManifest(manifest, variables, maxFee, dryRun) {
        // Retry ONLY on transient public-indexer errors (connection / 30s timeouts seen on
        // esmeralda). A local swarm never hits these; a template/policy rejection is returned
        // immediately (never retried).
        const params = { manifest, variables, max_fee: maxFee, dry_run: dryRun };
        let last = {};
        for (let i = 0; i < SUBMIT_RETRIES; i++) {
            last = await this.rpc("transactions.submit_manifest", params);
            const err = last.error;
            if (!err || !isTransient(err.message ?? ""))
                return last;
            await sleep(SUBMIT_RETRY_DELAY_MS);
        }
        return last; // exhausted: hand back the last (transient) error for the caller to surface
    }
    async dryRun(manifest, variables, maxFee = 200000) {
        return this.submitManifest(manifest, variables, maxFee, true);
    }
    /**
     * Submit a manifest for real and wait for it to finalize. Returns the finalized result
     * (a dict containing `Accept`). Throws ChainError on rejection.
     */
    async run(manifest, variables, maxFee = 200000) {
        const r = await this.submitManifest(manifest, variables, maxFee, false);
        if (r.error)
            throw new errors_1.ChainError(r.error.message ?? "submit_manifest failed");
        const txId = r.result?.transaction_id ?? r.result?.hash;
        for (let i = 0; i < 120; i++) { // esmeralda finalization can be slow under congestion
            const got = await this.rpc("transactions.get_result", { transaction_id: txId });
            const res = got.result;
            if (res) {
                const blob = JSON.stringify(res);
                if (blob.includes('"Reject"'))
                    throw new errors_1.ChainError(rejectReason(res) ?? "transaction rejected");
                if (blob.includes('"Accept"'))
                    return res;
            }
            await sleep(1500);
        }
        throw new errors_1.ChainError(`transaction ${txId} did not finalize in time`);
    }
}
exports.WalletdClient = WalletdClient;
