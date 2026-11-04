/**
 * Shared AgentPay configuration source (server-side reader).
 *
 * Mirrors the Python `agentpay.config` and the TS `clients/ts/src/config.ts`: an optional
 * `agentpay.config.json` whose keys map one-to-one to the canonical `AGENTPAY_*` env vars, read with
 * identical precedence so a user configures the wallet daemon / budget template / account ONCE and
 * every surface (this HTTP server, the MCP server, the SDK) agrees.
 *
 * Precedence, lowest -> highest:
 *   built-in default -> defaults.json (template addresses) -> agentpay.config.json
 *   -> AGENTPAY_* env var -> explicit argument.
 *
 * Only the chain/identity fields are shared here. Web-ops knobs (PORT, HOST, SESSION_SECRET,
 * DASHBOARD_PASSWORD, AGENTPAY_API_KEYS, rate limits, file paths, ...) stay env-only — they are
 * deployment concerns, not agent-identity config, and are deliberately NOT in the shared schema.
 *
 * Zero runtime dependencies (Node built-ins only), matching the rest of web/server.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Canonical field -> AGENTPAY_* env var. Keep in lock-step with agentpay/config.py FIELDS.
const FIELDS = {
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
};

// Deprecated env aliases still honored (checked after the canonical name).
const ENV_ALIASES = { walletd_token: ["OOTLE_WALLETD_TOKEN"] };

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_BASENAME = "agentpay.config.json";

function userConfigPath() {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "agentpay", CONFIG_BASENAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "agentpay", CONFIG_BASENAME);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "agentpay", CONFIG_BASENAME);
}

function configPath() {
  if (process.env.AGENTPAY_CONFIG) return process.env.AGENTPAY_CONFIG;
  const local = path.join(process.cwd(), CONFIG_BASENAME);
  if (fs.existsSync(local)) return local;
  const user = userConfigPath();
  if (fs.existsSync(user)) return user;
  return null;
}

function loadFile() {
  const p = configPath();
  if (!p) return {};
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function defaultsTemplates() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "defaults.json"), "utf8")).templates || {};
  } catch {
    return {};
  }
}

function envValue(key) {
  const direct = process.env[FIELDS[key]];
  if (direct) return direct;
  for (const alias of ENV_ALIASES[key] || []) {
    if (process.env[alias]) return process.env[alias];
  }
  return undefined;
}

/** Resolve a scalar field: explicit -> env -> file -> defaults.json template (if templateName) -> default. */
function get(key, { default: dflt = "", explicit = undefined, templateName = undefined } = {}) {
  if (explicit !== undefined && explicit !== null && explicit !== "") return String(explicit);
  const env = envValue(key);
  if (env) return env;
  const file = loadFile()[key];
  if (file !== undefined && file !== null && file !== "") return String(file);
  if (templateName) {
    const tmpl = defaultsTemplates()[templateName];
    if (tmpl) return String(tmpl);
  }
  return dflt;
}

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

function getBool(key, dflt) {
  const env = envValue(key);
  if (env !== undefined) {
    const low = String(env).trim().toLowerCase();
    if (TRUE.has(low)) return true;
    if (FALSE.has(low)) return false;
  }
  const file = loadFile()[key];
  if (typeof file === "boolean") return file;
  if (typeof file === "string") {
    const low = file.trim().toLowerCase();
    if (TRUE.has(low)) return true;
    if (FALSE.has(low)) return false;
  }
  return dflt;
}

module.exports = { FIELDS, configPath, loadFile, get, getBool };
