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
export const FIELDS = {
  network: "AGENTPAY_NETWORK",
  walletd_url: "AGENTPAY_WALLETD_URL",
  walletd_token: "AGENTPAY_WALLETD_TOKEN",
  budget_template: "AGENTPAY_BUDGET_TEMPLATE",
  owner_account: "AGENTPAY_OWNER_ACCOUNT",
  component: "AGENTPAY_COMPONENT",
  agent_account: "AGENTPAY_AGENT_ACCOUNT",
  agent_badge: "AGENTPAY_AGENT_BADGE",
  proof_windows: "AGENTPAY_PROOF_WINDOWS",
  api_url: "AGENTPAY_URL",
  api_key: "AGENTPAY_API_KEY",
} as const;

export type ConfigKey = keyof typeof FIELDS;

// Deprecated env aliases still honored (checked after the canonical name).
const ENV_ALIASES: Partial<Record<ConfigKey, string[]>> = { walletd_token: ["OOTLE_WALLETD_TOKEN"] };

const CONFIG_BASENAME = "agentpay.config.json";

// Fields that point the daemon at a wallet / carry its bearer token. An *implicit* working-directory
// `agentpay.config.json` is attacker-controllable: if it could set `walletd_url`, the Bearer token from
// the environment would be sent to that URL. So these are honored ONLY from an explicit AGENTPAY_CONFIG
// path or the per-user config directory, never a cwd file. Keep in lock-step with config.py
// `_SENSITIVE_FIELDS` / config.js `SENSITIVE_FIELDS`. (6th-round review, batch 2)
const SENSITIVE_FIELDS = new Set<ConfigKey>(["walletd_url", "walletd_token"]);

function env(): Record<string, string | undefined> {
  return (typeof process !== "undefined" && process.env) || {};
}

// Lazy, browser-safe Node built-ins.
function nodeMods(): { fs: any; path: any; os: any } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return { fs: require("node:fs"), path: require("node:path"), os: require("node:os") };
  } catch {
    return null;
  }
}

function userConfigPath(mods: { path: any; os: any }): string {
  const { path, os } = mods;
  const e = env();
  if (process.platform === "win32") {
    const base = e.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "agentpay", CONFIG_BASENAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "agentpay", CONFIG_BASENAME);
  }
  const base = e.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "agentpay", CONFIG_BASENAME);
}

/** The config file this process would read, or `null` if none is present / not on Node. */
export function configPath(): string | null {
  const mods = nodeMods();
  if (!mods) return null;
  const { fs, path } = mods;
  const e = env();
  if (e.AGENTPAY_CONFIG) return e.AGENTPAY_CONFIG;
  const local = path.join(process.cwd(), CONFIG_BASENAME);
  if (fs.existsSync(local)) return local;
  const user = userConfigPath(mods);
  if (fs.existsSync(user)) return user;
  return null;
}

/** The parsed `agentpay.config.json` as an object, fail-soft to `{}`. Read fresh each call. */
export function loadConfig(): Record<string, unknown> {
  const mods = nodeMods();
  const p = configPath();
  if (!mods || !p) return {};
  try {
    const data = JSON.parse(mods.fs.readFileSync(p, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** True when the config file in effect is the IMPLICIT working-directory file (no explicit
 * AGENTPAY_CONFIG). Such a file is untrusted, so sensitive fields are not read from it. */
function fromImplicitCwd(): boolean {
  const mods = nodeMods();
  if (!mods) return false;
  if (env().AGENTPAY_CONFIG) return false;
  const p = configPath();
  if (!p) return false;
  const { path } = mods;
  return path.resolve(p) === path.resolve(path.join(process.cwd(), CONFIG_BASENAME));
}

/** The config-file value for `key`, except a sensitive field is ignored when it would come from an
 * implicit working-directory file (see SENSITIVE_FIELDS). */
function fileValue(key: ConfigKey): unknown {
  if (SENSITIVE_FIELDS.has(key) && fromImplicitCwd()) return undefined;
  return loadConfig()[key];
}

function defaultsTemplates(): Record<string, string> {
  const mods = nodeMods();
  if (!mods) return {};
  try {
    // dist/config.js -> repo root (three levels up); only a dev checkout has defaults.json.
    const p = mods.path.resolve(__dirname, "..", "..", "..", "defaults.json");
    return JSON.parse(mods.fs.readFileSync(p, "utf8")).templates || {};
  } catch {
    return {};
  }
}

function envValue(key: ConfigKey): string | undefined {
  const e = env();
  const direct = e[FIELDS[key]];
  if (direct) return direct;
  for (const alias of ENV_ALIASES[key] || []) {
    if (e[alias]) return e[alias];
  }
  return undefined;
}

export interface GetOptions {
  default?: string;
  explicit?: string;
  /** Layer `defaults.json` `templates[name]` just above `default` (used for `budget_template`). */
  templateName?: string;
}

/** Resolve a scalar field: explicit -> env -> file -> defaults.json template -> default. */
export function getConfig(key: ConfigKey, opts: GetOptions = {}): string {
  if (opts.explicit !== undefined && opts.explicit !== null && opts.explicit !== "") return String(opts.explicit);
  const e = envValue(key);
  if (e) return e;
  const file = fileValue(key);
  if (file !== undefined && file !== null && file !== "") return String(file);
  if (opts.templateName) {
    const tmpl = defaultsTemplates()[opts.templateName];
    if (tmpl) return String(tmpl);
  }
  return opts.default ?? "";
}

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

export function getConfigBool(key: ConfigKey, dflt: boolean): boolean {
  const e = envValue(key);
  if (e !== undefined) {
    const low = String(e).trim().toLowerCase();
    if (TRUE.has(low)) return true;
    if (FALSE.has(low)) return false;
  }
  const file = loadConfig()[key];
  if (typeof file === "boolean") return file;
  if (typeof file === "string") {
    const low = file.trim().toLowerCase();
    if (TRUE.has(low)) return true;
    if (FALSE.has(low)) return false;
  }
  return dflt;
}

// ---- convenience factories (mirror the Python SDK's from_config) ------------------------------

/** A `WalletdClient` built from the shared config (walletd_url + walletd_token); explicit wins. */
export function walletdFromConfig(
  opts: { url?: string; token?: string; permissions?: string[]; credentials?: string;
          finalizeTries?: number; finalizeDelayMs?: number } = {},
): WalletdClient {
  const { url, token, ...rest } = opts;
  const resolvedToken = getConfig("walletd_token", { explicit: token });
  return new WalletdClient(getConfig("walletd_url", { default: "http://127.0.0.1:12010/json_rpc", explicit: url }), {
    token: resolvedToken || undefined,
    ...rest,
  });
}

/** An `OnChainBudget` built from the shared config; the `client` and caps stay caller-supplied. */
export function budgetFromConfig(
  client: WalletdClient,
  opts: { budgetTemplate?: string; ownerAccount?: string } & OnChainBudgetOptions = {},
): OnChainBudget {
  const { budgetTemplate, ownerAccount, ...rest } = opts;
  const bt = getConfig("budget_template", { explicit: budgetTemplate, templateName: "agent_budget" });
  const owner = getConfig("owner_account", { default: "default", explicit: ownerAccount });
  const budgetOpts: OnChainBudgetOptions = { ...rest };
  if (budgetOpts.agentAccount === undefined) {
    const ac = getConfig("agent_account");
    if (ac) budgetOpts.agentAccount = ac;
  }
  if (budgetOpts.proofWindows === undefined && envValue("proof_windows") === undefined) {
    const file = loadConfig()["proof_windows"];
    if (typeof file === "boolean" || typeof file === "string") budgetOpts.proofWindows = getConfigBool("proof_windows", true);
  }
  const b = new OnChainBudget(client, bt, owner, budgetOpts);
  const comp = getConfig("component");
  if (comp) b.component = comp;
  const badge = getConfig("agent_badge");
  if (badge) b.agentBadge = badge;
  return b;
}

/** An `AgentPayApiClient` (hosted /api/v1) built from the shared config (api_url + api_key). */
export function apiClientFromConfig(opts: { baseUrl?: string; apiKey?: string; fetch?: typeof fetch } = {}): AgentPayApiClient {
  return new AgentPayApiClient({
    baseUrl: getConfig("api_url", { default: "http://localhost:8787", explicit: opts.baseUrl }),
    apiKey: getConfig("api_key", { explicit: opts.apiKey }),
    fetch: opts.fetch,
  });
}
