"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OnChainBudget = exports.XTR = void 0;
/**
 * On-chain budget adapter — the phase-2 (on-chain conditions) path.
 *
 * Backs the budget with the **AgentBudget** Ootle template, so the per-transaction cap, the
 * rolling daily cap, the merchant whitelist and the kill switch are all enforced **on chain** by
 * the validator — the agent's client cannot override them. A 1:1 port of `OnChainBudget` in the
 * Python SDK's `agentpay/onchain.py`: identical RPC methods, manifest strings and event parsing.
 */
const errors_1 = require("./errors");
const invoice_1 = require("./invoice");
const walletd_1 = require("./walletd");
const window_1 = require("./window");
/** Native Tari test token used as the (plaintext, countable) budget resource on a devnet. */
exports.XTR = "XTR";
function components(blob, exclude) {
    const all = new Set(blob.match(/component_[0-9a-f]{64}/g) ?? []);
    return [...all].filter((c) => !exclude.has(c));
}
function badgeResources(blob) {
    // Non-fungible badge resources minted by the template (exclude the native XTR resource 0101..
    // and the zero template address resource 0000..).
    const all = new Set(blob.match(/resource_[0-9a-f]{64}/g) ?? []);
    return [...all]
        .filter((x) => !x.startsWith("resource_0101") && !x.startsWith("resource_0000"))
        .sort();
}
function cleanReason(message) {
    let m = message.match(/Template error: (.+?)(?:"|$)/);
    if (m)
        return m[1];
    m = message.match(/rejected: (.+?)(?:"|$)/);
    return m ? m[1] : message;
}
/**
 * Find the AgentBudget component's state array anywhere in a `substates.get` result tree. The
 * state is a positional array matching the struct's fields (vault, badges, then the scalar caps).
 */
function findComponentState(node) {
    if (!node || typeof node !== "object")
        return null;
    if (Array.isArray(node)) {
        for (const v of node) {
            const r = findComponentState(v);
            if (r)
                return r;
        }
        return null;
    }
    if (Array.isArray(node.Component?.body?.state))
        return node.Component.body.state;
    for (const v of Object.values(node)) {
        const r = findComponentState(v);
        if (r)
            return r;
    }
    return null;
}
/** Yield every event-shaped object (has a `payload`) anywhere in a result tree. */
function* iterEvents(result) {
    if (result && typeof result === "object" && !Array.isArray(result)) {
        if ("payload" in result && ("topic" in result || "substate_id" in result))
            yield result;
        for (const v of Object.values(result))
            yield* iterEvents(v);
    }
    else if (Array.isArray(result)) {
        for (const v of result)
            yield* iterEvents(v);
    }
}
class OnChainBudget {
    constructor(client, budgetTemplate, ownerAccount, opts = {}) {
        this.component = null;
        this.ownerBadge = null;
        this.agentBadge = null;
        this.perTxCap = 0;
        this.dailyCap = 0;
        this.whitelist = [];
        this.revoked = false;
        this.spent = 0;
        this.ledger = [];
        this.client = client;
        this.budgetTemplate = budgetTemplate;
        this.ownerAccount = ownerAccount;
        this.agentAccount = opts.agentAccount ?? ownerAccount;
    }
    // -- owner -----------------------------------------------------------------------
    async open(params) {
        const { fund, perTxCap, dailyCap, epochsPerWindow, whitelist } = params;
        const wl = whitelist.map((m) => `address!("${m}")`).join(", ");
        const manifest = `use ${this.budgetTemplate} as AgentBudget;\n` +
            "fn main() {\n" +
            '    let mut owner = var!["owner"];\n' +
            `    let funds = owner.withdraw(XTR, amount!(${fund}));\n` +
            `    let (comp, owner_badge, agent_badge) = AgentBudget::new(` +
            `funds, amount!(${perTxCap}), amount!(${dailyCap}), ${epochsPerWindow}u64, [${wl}]);\n` +
            "    owner.deposit(owner_badge);\n" +
            "    owner.deposit(agent_badge);\n" +
            "}\n";
        const res = await this.client.run(manifest, { owner: this.ownerAccount });
        const blob = JSON.stringify(res);
        const comps = components(blob, new Set([this.ownerAccount, this.agentAccount, ...whitelist]));
        const badges = badgeResources(blob);
        if (comps.length === 0 || badges.length < 2) {
            throw new errors_1.ChainError("could not locate the new budget component / badges in the result");
        }
        this.component = comps[0];
        // owner badge minted first, agent badge second; sort is stable but not creation order,
        // so for devnet (one account holds both) either proof authorizes. Record both.
        [this.ownerBadge, this.agentBadge] = [badges[0], badges[1]];
        this.perTxCap = perTxCap;
        this.dailyCap = dailyCap;
        this.whitelist = [...whitelist];
        return this;
    }
    async revoke() {
        await this.ownerCall("revoke()");
        this.revoked = true;
    }
    async withdraw(amount) {
        const manifest = "fn main() {\n" +
            '    let mut owner = var!["owner"];\n' +
            `    let proof = owner.create_proof_for_resource(address!("${this.ownerBadge}"));\n` +
            '    let mut budget = var!["budget"];\n' +
            `    let coins = budget.withdraw(amount!(${amount}));\n` +
            "    owner.deposit(coins);\n" +
            "    drop_all_proofs!();\n" +
            "}\n";
        await this.client.run(manifest, { owner: this.ownerAccount, budget: this.component });
    }
    async addMerchant(merchant) {
        await this.ownerCall(`add_merchant(address!("${merchant}"))`);
        if (!this.whitelist.includes(merchant))
            this.whitelist.push(merchant);
    }
    async ownerCall(call) {
        const manifest = "fn main() {\n" +
            '    let mut owner = var!["owner"];\n' +
            `    let proof = owner.create_proof_for_resource(address!("${this.ownerBadge}"));\n` +
            '    let mut budget = var!["budget"];\n' +
            `    budget.${call};\n` +
            "    drop_all_proofs!();\n" +
            "}\n";
        await this.client.run(manifest, { owner: this.ownerAccount, budget: this.component });
    }
    // -- agent -----------------------------------------------------------------------
    payManifest(merchant, amount, memo) {
        return ("fn main() {\n" +
            '    let mut agent = var!["agent"];\n' +
            `    let proof = agent.create_proof_for_resource(address!("${this.agentBadge}"));\n` +
            '    let mut budget = var!["budget"];\n' +
            `    budget.pay(address!("${merchant}"), amount!(${amount}), "${memo}");\n` +
            "    drop_all_proofs!();\n" +
            "}\n");
    }
    /**
     * The agent pays a whitelisted merchant. The client-side checks are only an early, friendly
     * error — the chain enforces the real limits regardless of what this client does. The local
     * ledger is updated from the on-chain `pay` event, not from the request.
     */
    async pay(merchant, amount, opts = {}) {
        const memo = opts.memo ?? "";
        this.precheck(merchant, amount);
        const res = await this.client.run(this.payManifest(merchant, amount, memo), {
            agent: this.agentAccount,
            budget: this.component,
        });
        for (const ev of OnChainBudget.payEvents(res)) { // ledger follows the chain's events
            const paid = Number(ev.amount ?? amount);
            this.spent += paid;
            this.ledger.push({ merchant: ev.merchant ?? merchant, amount: paid, memo: ev.memo ?? memo, txKind: "pay" });
        }
        return res;
    }
    /**
     * Ask the validator (via a dry run) whether this pay would be rejected, returning the on-chain
     * reason — used to show that the *chain*, not the client, enforces the rules. Returns null if
     * the pay would be accepted.
     */
    async wouldReject(merchant, amount, opts = {}) {
        const memo = opts.memo ?? "forced";
        const r = await this.client.dryRun(this.payManifest(merchant, amount, memo), {
            agent: this.agentAccount,
            budget: this.component,
        });
        if (r.error)
            return cleanReason(r.error.message ?? "rejected");
        if (JSON.stringify(r.result ?? {}).includes('"Reject"'))
            return (0, walletd_1.rejectReason)(r.result) ?? "rejected";
        return null;
    }
    /** Pay an invoice: the invoice id + agent tag ride along as the on-chain memo. */
    async payInvoice(params) {
        const memo = (0, invoice_1.encodeMemo)(params.invoiceId, params.agentTag ?? "").Message;
        return this.pay(params.merchant, params.amount, { memo });
    }
    precheck(merchant, amount) {
        if (this.revoked) {
            throw new errors_1.PolicyViolation(["budget revoked (client pre-check; chain also rejects)"]);
        }
        if (amount <= 0 || amount > this.perTxCap) {
            throw new errors_1.PolicyViolation([`amount ${amount} over per-tx cap ${this.perTxCap} (client pre-check)`]);
        }
        if (this.whitelist.length > 0 && !this.whitelist.includes(merchant)) {
            throw new errors_1.PolicyViolation(["merchant not whitelisted (client pre-check)"]);
        }
        if (this.spent + amount > this.dailyCap) {
            throw new errors_1.PolicyViolation([`would exceed daily cap ${this.dailyCap} (client pre-check)`]);
        }
    }
    // -- read-only window view -------------------------------------------------------
    /**
     * Read the budget's live rolling-window status from chain and translate it into human-readable
     * numbers (how much is left this window, roughly how long until it resets). Read-only: it queries
     * the component substate and the current epoch, and changes nothing on chain.
     *
     * The "daily cap" is enforced over a rolling window of `epochs_per_window` chain epochs
     * (≈30 min each), reset lazily on the next payment — so the wall-clock figures are approximate.
     * See `window.ts` for the pure computation.
     */
    async readWindow() {
        if (!this.component)
            throw new errors_1.ChainError("budget component is not set");
        const [sub, currentEpoch] = await Promise.all([
            this.client.getSubstate(this.component),
            this.client.currentEpoch(),
        ]);
        const state = findComponentState(sub);
        if (!state)
            throw new errors_1.ChainError("could not read the budget component state");
        // The leading entries (vault + two badge resources) are CBOR-tagged objects; the next scalar
        // fields are plain integers in struct order: per_tx_cap, daily_cap, spent_in_window,
        // window_start_epoch, epochs_per_window. Take the first five numbers at the top level.
        const nums = state.filter((x) => typeof x === "number");
        if (nums.length < 5)
            throw new errors_1.ChainError("unexpected budget component layout");
        const [, dailyCap, spentInWindow, windowStartEpoch, epochsPerWindow] = nums;
        return (0, window_1.windowStatus)({ dailyCap, spentInWindow, windowStartEpoch, epochsPerWindow, currentEpoch });
    }
    // -- events / ledger -------------------------------------------------------------
    /**
     * Extract the AgentBudget `pay` events (payload: merchant/amount/memo/spent_in_window) from a
     * tx result — this is how a watcher keeps a local ledger in sync with the chain. The same event
     * is recorded in two places in the result, so we de-duplicate.
     */
    static payEvents(result) {
        const out = [];
        const seen = new Set();
        for (const ev of iterEvents(result)) {
            const p = ev.payload;
            if (p && typeof p === "object" && "merchant" in p && "memo" in p) {
                const key = JSON.stringify([p.merchant, p.amount, p.memo]);
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push(p);
                }
            }
        }
        return out;
    }
}
exports.OnChainBudget = OnChainBudget;
