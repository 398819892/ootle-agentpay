/**
 * Shared AgentPay configuration source (TypeScript/Node reader).
 *
 * Mirrors the Python `agentpay.config` and the JS `web/server/config.js`: an optional
 * `agentpay.config.json` whose keys map one-to-one to the canonical `AGENTPAY_*` environment
 * variables, read with identical precedence so a user configures the wallet daemon / budget template
 * / account / hosted-API key ONCE and every surface agrees.
 *
 * Precedence, lowest -> highest:
 *   built-in default -> defaults.json (template addresses) -> agentpay.config.json
 *   -> AGENTPAY_* env var -> explicit argument.
 *
 * Node-only (reads the filesystem). In a browser (no `process`/`fs`) every lookup falls through to
 * its default, so importing this module is still safe — it just never finds a file.
 */
import { WalletdClient } from "./walletd";
import { OnChainBudget } from "./budget";
import type { OnChainBudgetOptions } from "./budget";
import { AgentPayApiClient } from "./api";
/** Canonical field -> AGENTPAY_* env var. Keep in lock-step with agentpay/config.py FIELDS. */
export declare const FIELDS: {
    readonly network: "AGENTPAY_NETWORK";
    readonly walletd_url: "AGENTPAY_WALLETD_URL";
    readonly walletd_token: "AGENTPAY_WALLETD_TOKEN";
    readonly budget_template: "AGENTPAY_BUDGET_TEMPLATE";
    readonly owner_account: "AGENTPAY_OWNER_ACCOUNT";
    readonly component: "AGENTPAY_COMPONENT";
    readonly agent_account: "AGENTPAY_AGENT_ACCOUNT";
    readonly agent_badge: "AGENTPAY_AGENT_BADGE";
    readonly proof_windows: "AGENTPAY_PROOF_WINDOWS";
    readonly api_url: "AGENTPAY_URL";
    readonly api_key: "AGENTPAY_API_KEY";
};
export type ConfigKey = keyof typeof FIELDS;
/** The config file this process would read, or `null` if none is present / not on Node. */
export declare function configPath(): string | null;
/** The parsed `agentpay.config.json` as an object, fail-soft to `{}`. Read fresh each call. */
export declare function loadConfig(): Record<string, unknown>;
export interface GetOptions {
    default?: string;
    explicit?: string;
    /** Layer `defaults.json` `templates[name]` just above `default` (used for `budget_template`). */
    templateName?: string;
}
/** Resolve a scalar field: explicit -> env -> file -> defaults.json template -> default. */
export declare function getConfig(key: ConfigKey, opts?: GetOptions): string;
export declare function getConfigBool(key: ConfigKey, dflt: boolean): boolean;
/** A `WalletdClient` built from the shared config (walletd_url + walletd_token); explicit wins. */
export declare function walletdFromConfig(opts?: {
    url?: string;
    token?: string;
    permissions?: string[];
    credentials?: string;
    finalizeTries?: number;
    finalizeDelayMs?: number;
}): WalletdClient;
/** An `OnChainBudget` built from the shared config; the `client` and caps stay caller-supplied. */
export declare function budgetFromConfig(client: WalletdClient, opts?: {
    budgetTemplate?: string;
    ownerAccount?: string;
} & OnChainBudgetOptions): OnChainBudget;
/** An `AgentPayApiClient` (hosted /api/v1) built from the shared config (api_url + api_key). */
export declare function apiClientFromConfig(opts?: {
    baseUrl?: string;
    apiKey?: string;
    fetch?: typeof fetch;
}): AgentPayApiClient;
