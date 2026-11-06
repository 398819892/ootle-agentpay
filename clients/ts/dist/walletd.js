"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletdClient = exports.DEFAULT_WALLETD_URL = void 0;
exports.isTransient = isTransient;
exports.finalizedOutcome = finalizedOutcome;
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
// A strict subset of auth errors raised by walletd's RPC auth middleware BEFORE the method is
// dispatched — the request never reached the handler, so nothing executed. Unlike a broader
// auth-looking error (e.g. the engine's "Access denied by a template access rule", an
// execution-level reject on a tx that DID run), an expired/invalid *token* on a real submit is safe
// to re-mint and retry: the manifest was never submitted, so the retry is a first-and-only
// submission, not a resubmission (H5-safe). (D-13)
const TOKEN_EXPIRY_MARKERS = ["Expired token", "Invalid token"];
function isTokenExpiry(message) {
    return !!message && TOKEN_EXPIRY_MARKERS.some((m) => message.includes(m));
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// --- structured transaction-result handling ---------------------------------------------------
// The Ootle returns a typed result tree; we navigate it by key instead of regex-matching the JSON
// string, so the accept/reject distinction and the reject reason (now an object, e.g.
// `ExecutionFailure { code, message }`) are read from the actual fields. Mirrors the Python SDK's
// `agentpay/onchain.py`. See the engine's `commit_result.rs`:
//   TransactionResult = { Accept: diff } | { Reject: reason } | { AcceptFeeRejectRest: [diff, reason] }
//   RejectReason      = { ExecutionFailure: { code, message } } | { "<Variant>": "<message>" } | "<Variant>"
const TX_RESULT_VARIANTS = ["Accept", "Reject", "AcceptFeeRejectRest"];
// Wallet-daemon TransactionStatus values that are TERMINAL failures carrying NO FinalizeResult (the
// typed result tree is null), so they can't be read from the result variants above — only from the
// top-level `status`. Without this, such a tx is polled as "pending" forever and never reconciles,
// wedging the in-flight guard. (D-12)
const TERMINAL_FAILURE_STATUSES = new Set(["InvalidTransaction", "Rejected"]);
/**
 * Locate the typed TransactionResult inside a walletd result, across both nesting shapes:
 * `transactions.get_result` nests it at `result.result`; a dry run (`submit_manifest`) nests it at
 * `result.result.finalize.result`. Descend the known wrapper keys rather than guessing.
 */
function transactionResult(rpcResult) {
    let node = rpcResult;
    for (let i = 0; i < 6; i++) {
        if (!node || typeof node !== "object" || Array.isArray(node))
            return null;
        if (TX_RESULT_VARIANTS.some((v) => v in node))
            return node;
        node = node.result != null ? node.result : node.finalize;
    }
    return null;
}
/** Clean the engine's instruction/panic framing off a template assertion message. */
function cleanPanic(message) {
    const m = message.match(/Panic(?:ked)?[:!]?\s*(.+)/);
    return m ? m[1].trim().replace(/\.$/, "") : message.trim();
}
/** Render a structured RejectReason (or a bare string) into a human message. */
function renderReject(reason) {
    if (reason == null)
        return "transaction rejected";
    if (typeof reason === "string")
        return reason;
    if (typeof reason === "object") {
        const [variant, payload] = Object.entries(reason)[0] ?? [];
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            const msg = payload.message;
            return msg ? cleanPanic(String(msg)) : String(variant ?? "transaction rejected");
        }
        if (typeof payload === "string")
            return payload;
        return String(variant ?? "transaction rejected");
    }
    return "transaction rejected";
}
/** `["accept", null]` / `["reject", reason]` once finalized, else null (still pending). */
function finalizedOutcome(rpcResult) {
    const tr = transactionResult(rpcResult);
    if (!tr)
        return null;
    if ("Accept" in tr)
        return ["accept", null];
    if ("Reject" in tr)
        return ["reject", renderReject(tr.Reject)];
    if ("AcceptFeeRejectRest" in tr) {
        const pair = tr.AcceptFeeRejectRest;
        return ["reject", renderReject(Array.isArray(pair) && pair.length > 1 ? pair[1] : null)];
    }
    return null;
}
/** Extract a human reject reason from a finalized-but-rejected result tree, or null if not rejected. */
function rejectReason(result) {
    const outcome = finalizedOutcome(result);
    return outcome && outcome[0] === "reject" ? outcome[1] : null;
}
class WalletdClient {
    constructor(url = exports.DEFAULT_WALLETD_URL, opts = {}) {
        this.token = null;
        /**
         * The transaction id of the most recent `run`/`submit` on this client. The dashboard server
         * serialises all chain ops, so right after an op resolves this is unambiguously that op's tx —
         * letting the caller journal the tx id even when the op later rejects or times out.
         */
        this.lastTxId = null;
        this.url = url;
        this.finalizeTries = opts.finalizeTries ?? 120;
        this.finalizeDelayMs = opts.finalizeDelayMs ?? 1500;
        // Canonical AGENTPAY_WALLETD_TOKEN (shared with the Python SDK); OOTLE_WALLETD_TOKEN is the
        // deprecated name, still honored so a mixed setup keeps working.
        const env = (typeof process !== "undefined" && process.env) || {};
        const envToken = env.AGENTPAY_WALLETD_TOKEN || env.OOTLE_WALLETD_TOKEN || undefined;
        this.token = opts.token ?? envToken ?? null;
        this.tokenIsExternal = this.token !== null;
        this.permissions = opts.permissions ?? ["Admin"];
        this.credentials = opts.credentials ?? "None";
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
            // Classify by HTTP STATUS first (F-6), never by the error text. A JSON-RPC daemon answers 200
            // even for RPC-level errors, so a non-2xx is a transport/server failure (overload / internal
            // fault → 5xx, bad token → 401 …), NOT a clean node verdict. Parse the body if there is one, then
            // TAG the status so the real-submit path can treat a 5xx as ambiguous (pending) rather than a
            // definitive rejection that would invite a double-spending resubmit.
            let body;
            let parseErr;
            try {
                body = await resp.json();
            }
            catch (e) {
                parseErr = e;
            }
            if (!resp.ok) {
                out = (body && typeof body === "object" ? body : {});
                out._httpStatus = resp.status;
            }
            else {
                if (parseErr)
                    throw parseErr; // a malformed 2xx body is a genuine failure, as before
                out = body;
            }
        }
        finally {
            clearTimeout(timer);
        }
        // If a previously-minted token has expired, re-mint it once and retry the call transparently,
        // so a long-lived client (the dashboard server) doesn't fail every op until it's restarted.
        // Two constraints (D-5 / D-13):
        //  • a REAL (state-changing) `submit_manifest` re-mints & retries ONLY on an unambiguous
        //    token-expiry error (`isTokenExpiry`) — rejected at the auth layer before dispatch, so nothing
        //    landed and the retry is a first-and-only submission. A broader auth-looking error (the
        //    engine's "Access denied by a template access rule") may be a reject on a tx that already ran,
        //    so it is surfaced, never resubmitted (double-spend / H5).
        //  • an externally-supplied token: re-minting would escalate a least-privilege token to the
        //    configured `permissions` (non-custodial). Surface it instead.
        const isRealSubmit = method === "transactions.submit_manifest" && params?.dry_run === false;
        const authRetryable = isRealSubmit
            ? isTokenExpiry(out.error?.message)
            : isAuthError(out.error?.message);
        if (!retriedAuth && this.token && !this.tokenIsExternal &&
            method !== "auth.request" && authRetryable) {
            this.token = null;
            await this.connect();
            return this.rpc(method, params, true);
        }
        return out;
    }
    /**
     * Obtain a token. If one was supplied (a least-privilege token minted out-of-band for this agent's
     * own walletd — the non-custodial path), use it as-is and request nothing. Otherwise mint one with
     * the configured `permissions`/`credentials` (devnet default: `Admin` on an `auth=none` daemon).
     */
    async connect() {
        if (this.token)
            return this;
        const r = await this.rpc("auth.request", {
            permissions: this.permissions, duration: null, credentials: this.credentials,
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
    /**
     * List the wallet account's transactions (read-only), each carrying its finalized `events`. The
     * dashboard uses this to rebuild the payment ledger from the CHAIN — every AgentBudget `pay`
     * event, including pays made by OTHER clients (the MCP / SDK / another dashboard) that left no
     * local-journal row here. The list is newest-first; `limit` is advisory (some walletd builds
     * return the full history regardless). Dry-run entries are included — the caller filters them out
     * via each entry's `is_dry_run`.
     */
    async listTransactions(opts = {}) {
        const r = await this.rpc("transactions.list", { offset: opts.offset ?? 0, limit: opts.limit ?? 1000 });
        if (r.error)
            throw new errors_1.ChainError(r.error.message ?? "transactions.list failed");
        const txs = r.result?.transactions;
        return Array.isArray(txs) ? txs : [];
    }
    // -- transactions ---------------------------------------------------------------
    async submitManifest(manifest, variables, maxFee, dryRun, retry) {
        const params = { manifest, variables, max_fee: maxFee, dry_run: dryRun };
        // A transient error (connection / 30s indexer timeout seen on esmeralda) is ambiguous for a
        // REAL submit: the manifest may already have reached the node and created a transaction, and
        // the response was merely lost. Re-submitting it would be a *new* transaction — a double-spend
        // (H5). So we retry transient errors ONLY for dry runs, which change no state. For a real submit
        // we do a single attempt and surface a transient failure as `pending` (unknown), leaving the
        // caller to reconcile by tx id rather than blindly resubmit. A template/policy rejection is
        // returned immediately either way. A local swarm never produces transient errors.
        if (dryRun) {
            // A dry run changes no state, so retrying a transient indexer error is safe. A REAL submit uses
            // the full `SUBMIT_RETRIES` budget (~6 min) because losing a write is costly; a READ-ONLY status
            // dry-run (readInfo/readWindow) passes a short budget so a jittery indexer stalls a status query
            // for seconds, not minutes. (6th-round review, batch 2 — read-only dry-run retry)
            const tries = retry?.tries ?? SUBMIT_RETRIES;
            const delayMs = retry?.delayMs ?? SUBMIT_RETRY_DELAY_MS;
            let last = {};
            for (let i = 0; i < tries; i++) {
                last = await this.rpc("transactions.submit_manifest", params);
                const err = last.error;
                if (!err || !isTransient(err.message ?? ""))
                    return last;
                if (i < tries - 1)
                    await sleep(delayMs);
            }
            return last;
        }
        let resp;
        try {
            resp = await this.rpc("transactions.submit_manifest", params);
        }
        catch (e) {
            // A THROWN error (network drop, 120s abort, ECONNRESET) on a REAL submit is ALSO ambiguous —
            // the request may already have reached the node and created a transaction. Surface it as
            // `pending` (unknown) too, so the caller reconciles rather than recording a hard `rejected`
            // for a tx that may have landed (#2 — the fetch-layer gap in the H5 guard).
            const err = new errors_1.ChainError(`submit may or may not have landed (request failed, not resubmitted): ${e?.message ?? e}`);
            err.pending = true;
            throw err;
        }
        // F-6: classify by HTTP STATUS before the error text. `rpc()` tags any non-2xx with `_httpStatus`.
        const httpStatus = resp._httpStatus;
        if (httpStatus !== undefined && !(httpStatus >= 200 && httpStatus < 300)) {
            if (httpStatus === 401 || httpStatus === 403) {
                // Auth layer rejected the request BEFORE dispatch (bad / expired token): the method never ran,
                // so a REAL submit that hits this definitely did NOT land → hard failure, never pending.
                const err = new errors_1.ChainError(`submit rejected: HTTP ${httpStatus}${resp.error?.message ? ": " + resp.error.message : ""}`);
                err.authFailed = true;
                throw err;
            }
            // 5xx / other non-2xx on a REAL submit: the server erred AFTER we handed it the manifest — the tx
            // may already exist → pending (reconcile by tx id), never a hard reject that invites a double-spend.
            const err = new errors_1.ChainError(`submit returned HTTP ${httpStatus}; outcome unknown${resp.error?.message ? ": " + resp.error.message : ""}`);
            err.pending = true;
            throw err;
        }
        if (resp.error && isTransient(resp.error.message ?? "")) {
            const err = new errors_1.ChainError(`submit may or may not have landed (transient error, not resubmitted): ${resp.error.message}`);
            err.pending = true; // unknown: reconcile, never auto-resubmit (H5)
            throw err;
        }
        return resp;
    }
    async dryRun(manifest, variables, maxFee = 200000, retry) {
        return this.submitManifest(manifest, variables, maxFee, true, retry);
    }
    /**
     * Submit a manifest for real (no waiting) and return its transaction id. Also records it as
     * `lastTxId`. Splitting submit from the finalize-wait lets a caller persist the tx id to a
     * journal *before* it blocks on finalization, so a crash mid-wait leaves a reconcilable record.
     */
    async submit(manifest, variables, maxFee = 200000) {
        const r = await this.submitManifest(manifest, variables, maxFee, false);
        if (r.error) {
            // Flag a TRANSPORT/token auth failure (401/403-equivalent: expired/invalid token, access
            // denied at the RPC auth layer) so an owner-call wrapper can tell it apart from a template-level
            // authorization reject. A dialect mismatch (0.47/0.49) surfaces as the latter, not this. Mirrors
            // the Python SDK's `err.auth_failed` attribute (used by `_run_owner`). (P1-3)
            const err = new errors_1.ChainError(r.error.message ?? "submit_manifest failed");
            if (isAuthError(r.error.message))
                err.authFailed = true;
            throw err;
        }
        const txId = r.result?.transaction_id ?? r.result?.hash;
        if (!txId) {
            // The submit returned 200 but we cannot identify the tx: it MAY have landed, so it is UNKNOWN
            // (pending) — reconcile by a later get_result scan — never a hard failure, which would invite a
            // blind, double-spending resubmit. Mirrors the Python SDK's `run()` no-tx-id guard. (P1 / H5)
            const err = new errors_1.ChainError("submit_manifest returned no usable transaction id; outcome unknown");
            err.pending = true;
            throw err;
        }
        this.lastTxId = String(txId);
        return this.lastTxId;
    }
    /**
     * Read-only: resolve a transaction id to `{ accept | reject | pending }` by a single
     * `get_result` call. Never submits or signs anything — this is what a reconciler uses on
     * startup to settle a previously-submitted (persisted) tx id against the chain's verdict.
     */
    async getResult(transactionId) {
        const got = await this.rpc("transactions.get_result", { transaction_id: transactionId });
        const outcome = finalizedOutcome(got.result);
        if (outcome) {
            return outcome[0] === "accept"
                ? { status: "accept", reason: null, result: got.result }
                : { status: "reject", reason: outcome[1], result: got.result };
        }
        // D-12: a tx rejected at consensus (InvalidTransaction / Rejected) has a terminal top-level
        // `status` but no FinalizeResult body, so finalizedOutcome returns null. Settle it as a definitive
        // reject rather than polling it as "pending" forever (which wedges the in-flight guard).
        const st = got.result?.status;
        if (typeof st === "string" && TERMINAL_FAILURE_STATUSES.has(st)) {
            return { status: "reject", reason: `transaction ${st}`, result: got.result ?? null };
        }
        return { status: "pending", reason: null, result: got.result ?? null };
    }
    /**
     * Submit a manifest for real and wait for it to finalize. Returns the finalized result
     * (a dict containing `Accept`). Throws ChainError on rejection. If it does not finalize within
     * the configured budget the thrown ChainError carries `pending = true` so the caller can record
     * the tx as *unknown* (submitted, not yet confirmed) and reconcile it later by `lastTxId` —
     * never as a success.
     */
    async run(manifest, variables, maxFee = 200000) {
        const txId = await this.submit(manifest, variables, maxFee);
        for (let i = 0; i < this.finalizeTries; i++) { // esmeralda finalization can be slow under congestion
            // Decide accept/reject from the structured TransactionResult, not by searching the JSON blob:
            // `AcceptFeeRejectRest` (fee taken, rest rejected) contains the substring "Accept" yet is a
            // FAILURE, and reject reasons are now objects a substring scan can't read.
            const got = await this.getResult(txId);
            if (got.status === "accept")
                return got.result;
            if (got.status === "reject") {
                // A finalized chain Reject is a DEFINITIVE verdict: the tx moved no funds, so the caller may
                // safely record it as a hard failure. Flag it `chainRejected` so the server can tell a real
                // chain rejection apart from a post-submit transport blip (which must stay UNKNOWN). (S-1)
                const err = new errors_1.ChainError(got.reason ?? "transaction rejected");
                err.chainRejected = true;
                throw err;
            }
            await sleep(this.finalizeDelayMs);
        }
        const err = new errors_1.ChainError(`transaction ${txId} did not finalize within the confirmation window`);
        err.pending = true;
        err.txId = txId;
        throw err;
    }
}
exports.WalletdClient = WalletdClient;
