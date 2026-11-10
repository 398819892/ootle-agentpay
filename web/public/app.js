/* ============================================================================
   AgentPay dashboard — SPA (zero dependencies, no build step).
   Talks only to this project's backend (never to walletd directly).
   ========================================================================== */
"use strict";

/* ---- tiny DOM helpers ----------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Base-unit amounts are integers that can exceed JS's safe-integer range, so the backend sends
// them as decimal strings. Group an integer string exactly (no lossy Number); fall back to
// Number formatting for anything non-integer.
const fmt = (n) => {
  const s = n === null || n === undefined || n === "" ? "0" : String(n);
  if (/^-?\d+$/.test(s)) return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const x = Number(n || 0);
  return Number.isFinite(x) ? x.toLocaleString("en-US") : s;
};
// Read a form field as a non-negative decimal-integer STRING (base units), or null if it is not a
// whole number. Kept as a string end-to-end so large amounts never pass through a lossy float.
const readAmt = (id) => {
  const s = (el(id).value ?? "").trim();
  return /^\d+$/.test(s) ? s : null;
};
// Compare amount strings as BigInt; null-safe (a null/invalid amount is treated as 0).
const amtBig = (v) => {
  try { return BigInt(String(v ?? "").trim() || "0"); } catch { return 0n; }
};
// Display ticker for budget AMOUNTS. On-chain amounts (caps, treasury, spend, pay amounts) are
// stored as integer BASE UNITS — microTari (µT), where 1,000,000 µT = 1 whole token (tTARI / XTR).
// So every amount here is labelled µT, matching the SDK, the MCP tools and the validator (which all
// speak µT). Labelling the raw integers with the whole-token ticker (`tokenSymbol`) was wrong — it
// read e.g. "1000 tTARI" for a 1000 µT (0.001 tTARI) cap, so a human reading the dashboard and an
// agent reading the chain disagreed by 1e6. `config.tokenSymbol` still names the whole token for
// reference; the amount ticker stays µT (Tari's base unit, test and main alike). Display-only — the
// on-chain manifest keyword is handled separately in the SDK/client (TARI, XTR alias).
let UNIT = "µT";

/* ============================================================================
   i18n — a tiny, zero-dependency dictionary layer.
   Values are either strings (with {name} placeholders) or functions (p) => str.
   `t(key, params)` looks the key up for the active language, falls back to EN,
   then to the key itself, and substitutes {placeholders} from `params`.
   The whole UI re-renders on switch, so there is nothing to wire per string.
   ========================================================================== */
const LANGS = { zh: "中文", en: "EN" };
function getLang() {
  try {
    const s = localStorage.getItem("agentpay-lang");
    if (s === "en" || s === "zh") return s;
  } catch {
    /* private mode */
  }
  return "zh"; // the operator is a Chinese user — default to 中文
}
let LANG = getLang();
function setLang(l) {
  if (l !== "en" && l !== "zh") return;
  LANG = l;
  try {
    localStorage.setItem("agentpay-lang", l);
  } catch {
    /* private mode */
  }
  applyStaticI18n();
  if (S.authRequired && !S.authed) renderLogin();
  else render();
}
function t(key, p) {
  const dict = I18N[LANG] || I18N.en;
  let v = dict[key];
  if (v == null) v = I18N.en[key] != null ? I18N.en[key] : key;
  if (typeof v === "function") return v(p || {});
  if (p) v = String(v).replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? p[k] : m));
  return v;
}
// Non-custodial-aware lookup: when the deployment runs non-custodial, prefer a `${key}_nc` string if
// one exists, else fall back to the base key. Lets the interface tell the "connect your wallet" story
// without disturbing custodial deployments (flag off → always the base key).
function tnc(key, p) {
  if (S && S.nonCustodial && ((I18N[LANG] && I18N[LANG][key + "_nc"] != null) || I18N.en[key + "_nc"] != null)) {
    return t(key + "_nc", p);
  }
  return t(key, p);
}
/** A rough wall-clock label for a count of minutes, localized. */
function formatApprox(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (LANG === "zh") {
    if (m <= 0) return "随时";
    if (m < 60) return `约 ${m} 分钟`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `约 ${h} 小时` : `约 ${h} 小时 ${rem} 分`;
  }
  if (m <= 0) return "any moment";
  if (m < 60) return `≈${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `≈${h}h` : `≈${h}h ${rem}m`;
}
/** ETA to window reset, derived from the chain's own minute estimate (localized). */
function resetEta(w) {
  return formatApprox(w ? w.approxMinutesUntilReset : 0);
}

/* ---- dictionaries --------------------------------------------------------- */
const I18N = {
  en: {
    /* static page chrome */
    meta_title: "AgentPay — on-chain budgets for AI agents",
    meta_desc:
      "AgentPay — a hosted dashboard for managing on-chain, validator-enforced spending budgets for AI agents on Tari Ootle.",
    boot_connecting: "Connecting to the chain…",
    lang_aria: "Language",

    /* brand / sidebar */
    brand_sub: "Agent budget console",
    conn_online: "Connected to chain",
    conn_offline: "Offline",
    wallet_only_no_backend: "This page is self-custody — connect your wallet and approve on-chain actions there. There is no custodial backend here.",
    theme_group: "Theme",
    theme_light: "Light",
    theme_system: "System",
    theme_dark: "Dark",
    theme_aria: (p) => `${p.name} theme`,
    meta_template: "template",
    meta_owner: "owner",
    signout: "Sign out",
    copy_full: "Copy full address",
    copy: "Copy",

    /* nav */
    nav_overview: "Overview",
    nav_start: "Get started",
    nav_wallet: "Wallet",
    wallet_view_sub: "Your browser-held key — create or unlock it here, then connect it to the dashboard.",
    start_sub: "First steps for a new user — from signing in to your agent's first payment.",
    start_custodial_note: "This is a hosted (custodial) console: the wallet is held and signed server-side by walletd, and the dashboard is already connected to the chain. You do not connect a wallet in the browser.",
    /* non-custodial single-mode (S.nonCustodial) — the owner unlocks the browser-held wallet on this same page */
    start_sub_nc: "First steps — unlock your AgentPay wallet, set your limits and whitelist, then make a payment. Every change is approved in your wallet.",
    nco_note: "Non-custodial: your AgentPay wallet holds the keys in this browser. The dashboard reads this budget from the wallet and routes every change — payments, limits, merchants, lifecycle — through the wallet for your approval; the chain enforces the caps. The backend never signs for you.",
    nco_s1_t: "1 · Unlock your AgentPay wallet",
    nco_s1_b: "Unlock your AgentPay wallet in the “Wallet” view on this page and connect it here. The dashboard then reads this budget from the wallet, and every owner action is approved there — the browser never drives a custodial signer.",
    nco_connect_cta: "Connect wallet",
    nco_connect_hint: "Approve the connect request in the “Wallet” view — it waits there for your approval.",
    nco_connected: "Wallet connected · {acct}",
    nco_not_connected: "Wallet not connected",
    nco_s2_t: "2 · Your budget",
    nco_s2_b: "Once connected, the overview, balances and activity all come from your wallet's budget — not a server-side copy.",
    nco_budget_ready: "Budget loaded from your wallet",
    nco_budget_wait: "Connect your wallet to load the budget",
    nco_s3_t: "3 · Set limits & whitelist",
    nco_s3_b: "In Manage set the per-transaction and daily caps; in Merchants add the payees the agent may pay. Each change pops a wallet approval and is enforced on-chain.",
    nco_s4_t: "4 · Make a payment",
    nco_s4_b: "Send a payment from the Pay page; your wallet approves it and the chain enforces the cap and whitelist. Receipts land on the Receipts page.",
    meta_desc_nc: "AgentPay — a non-custodial console for on-chain, validator-enforced AI-agent spending budgets on Tari Ootle. Your wallet holds the keys and approves every change.",
    about_body_nc: "AgentPay is a non-custodial, on-chain hard-limit wallet and gateway for AI agents. Your wallet holds the keys and approves each change; the real spending limits are enforced by the on-chain validator, which never lets anyone move funds beyond them.",
    create_trust_title_nc: "Non-custodial, enforced on-chain.",
    create_trust_body_nc: "You approve every change in your own wallet — the backend never holds your keys. The caps and whitelist you set here are compiled into the budget's on-chain component and enforced by the validators, not by this app.",
    login_intro_nc: "Sign in to your AgentPay console. On-chain actions are approved in your connected wallet — the console never holds your keys.",
    start_s1_t: "1 · Sign in",
    start_s1_b: "You reach this console with the password your provider gave you — there is no self-serve sign-up. Keep that password private.",
    start_s1_done: "Signed in",
    start_s2_t: "2 · Wallet is ready",
    start_s2_b: "The custodial wallet is set up on the server; there is nothing to connect here. When the dashboard shows it is connected to the chain, you are ready.",
    start_chain_on: "Connected to chain · {net}",
    start_chain_off: "Not connected to the chain",
    start_owner: "Custodial account {acct}",
    start_s3_t: "3 · Connect your AI",
    start_s3_b: "On the Connect page, copy the MCP config or an API key and wire your AI agent to this budget. The agent attaches to the on-chain budget — it never receives the owner key.",
    start_connected_n: "{n} access credential(s)",
    start_not_connected: "No agent connected yet",
    start_cta_connect: "Go to Connect",
    start_s4_t: "4 · Set limits & whitelist",
    start_s4_b: "In Manage, set the per-transaction and daily caps; in Merchants, add the payees the agent may pay. The on-chain hard cap is the real boundary.",
    start_wl_n: "{n} whitelisted merchant(s)",
    start_wl_none: "No merchants whitelisted yet",
    start_cta_manage: "Set limits",
    start_cta_merchants: "Whitelist",
    start_s5_t: "5 · Let the agent pay",
    start_s5_b: "Your agent calls pay_merchant; every payment is enforced against the on-chain hard cap and whitelist. Receipts land on the Receipts page.",
    start_cta_pay: "Try a payment",
    start_cta_receipts: "View receipts",
    start_mode_label: "Choose how you'll hold the keys",
    start_mode_custodial: "Custodial (hosted)",
    start_mode_noncustodial: "Non-custodial (self-hosted)",
    start_mode_hint_cus: "The simplest start: walletd holds and signs server-side. You sign in and manage limits here; your agent connects to the hosted budget.",
    start_mode_hint_nc: "You run your own walletd and keep your own keys. The owner issues your agent an on-chain badge with a least-privilege token — the agent can send within the on-chain caps but never holds the owner key or Admin rights.",
    start_noncustodial_note: "Non-custodial setup: you keep your keys in your OWN walletd. Below, request an agent badge minted into your account; then paste the returned config into your walletd. The agent token is send-only (TransactionSend, TransactionGet) — never Admin.",
    nc_s2_t: "2 · Run your own walletd & account",
    nc_s2_b: "Start a Tari Ootle walletd that you control and create (or pick) the account that will hold your agent badge. This account's address is what you enter below — the owner keys and funds stay separate, on the owner side.",
    nc_s2_env: "Your keys never leave your walletd",
    nc_s3_t: "3 · Get your agent badge",
    nc_s3_b: "Enter your agent account address and a label. The owner (operator) mints an agent badge into THAT account — a self-serve, owner-signed on-chain action, gated by the same step-up confirmation as every high-risk operation.",
    nc_account_label: "Your agent account address",
    nc_account_ph: "account_… (your own walletd account)",
    nc_account_err: "Enter the account address to mint the badge into.",
    nc_label_label: "Session label",
    nc_label_ph: "e.g. prod-agent-1",
    nc_label_err: "Use letters, numbers, dot, dash or underscore (max 64).",
    nc_issue_btn: "Request agent badge",
    nc_issue_hint: "Requires operator confirmation (step-up). The badge is minted to your account, not held here.",
    nc_s4_t: "4 · Configure your walletd",
    nc_s4_b: "Once the badge is issued, paste this into your agent's environment. Fill in your own walletd URL and token; the permissions are send-only by design.",
    nc_s4_pre: "Your config appears here after the badge is issued in step 3.",
    nc_env_walletd_ph: "https://your-own-walletd:18000",
    nc_env_note: "Set AGENTPAY_WALLETD_TOKEN to a token your walletd issues for this account with only TransactionSend and TransactionGet — never Admin.",
    nc_issued_ok: "Badge issued to {acct}",
    nc_s5_t: "5 · Let the agent pay",
    nc_s5_b: "Your agent now signs with its own badge inside your walletd. Every payment is still enforced against the on-chain hard cap and whitelist; receipts land on the Receipts page.",
    nc_revoke_note: "The owner can revoke the badge at any time",
    nav_create: "Create budget",
    nav_manage: "Manage",
    nav_pay: "Payments",
    nav_governance: "Governance",
    nav_merchants: "Merchants",
    manage_sub: "Owner controls — funds, spending limits, agent sessions, and the kill switch.",
    merchants_sub: "The on-chain whitelist of merchants this agent is allowed to pay.",
    merchants_nobudget_sub: "Open a budget first, then manage its merchant whitelist here.",

    /* connect */
    nav_connect: "Connect AI",
    nav_receipts: "Receipts",
    receipts_sub: "The payment receipts the AI agent was given, saved here to view and download.",
    receipts_empty: "No receipts yet. They appear here after the agent makes a payment over MCP.",
    receipt_download: "Download",
    receipt_to: "Paid to",
    receipt_from: "Payer",
    receipt_at: "Time",
    receipts_load_failed: "Could not load receipts",
    nav_subscription: "Subscription",
    sub_sub: "Your AgentPay plan, usage this period, and invoices. Billing meters activity only — it never holds keys or moves funds.",
    sub_unconfigured_title: "Billing is not set up",
    sub_unconfigured_body: "This deployment has no billing backend configured. Set AGENTPAY_BILLING_URL, AGENTPAY_BILLING_KEY and AGENTPAY_BILLING_TENANT to enable subscriptions.",
    sub_unavailable_title: "Billing is temporarily unavailable",
    sub_unavailable_body: "Could not reach the billing service. Your on-chain budget and payments are unaffected — only this subscription view is offline.",
    sub_plan: "Current plan",
    sub_status: "Status",
    sub_free: "Free",
    sub_price_month: "/mo",
    sub_renews: "Renews",
    sub_seats: "Active budgets",
    sub_usage_title: "This period",
    sub_payments: "Payments",
    sub_volume: "Volume (µT)",
    sub_dues: "Amount due",
    sub_invoices_title: "Invoices",
    sub_invoices_empty: "No invoices yet.",
    sub_inv_period: "Period",
    sub_inv_amount: "Amount",
    sub_inv_status: "Status",
    sub_change_plan: "Change plan",
    sub_manage_billing: "Manage billing",
    sub_choose: "Choose",
    sub_current: "Current",
    sub_redirecting: "Opening billing…",
    sub_action_failed: "Could not start billing",
    sub_custom: "Custom",
    sub_feat_budgets: "{n} active budgets",
    sub_feat_budgets_unlimited: "Unlimited active budgets",
    sub_feat_included_gmv: "{v} µT included volume",
    sub_feat_gmv_overage: "{pct} GMV overage fee",
    sub_feat_seat_overage: "{price} per extra budget",
    nav_settings: "Settings",
    settings_sub: "Defaults for this dashboard and the agent's payment receipts.",
    set_ui_lang: "Interface language",
    set_ui_lang_hint: "The language of this dashboard — applies right away, remembered in this browser.",
    set_receipt_lang: "Receipt language",
    set_receipt_lang_hint: "The language of the payment-receipt image the AI agent gets back over MCP (takes effect on the next payment).",
    set_pay_confirm: "Payment confirmation",
    set_pay_confirm_intro: "Every payment is already confirmed by your AI app's own \"Allow pay_merchant?\" prompt (it shows the merchant and amount). Keep that tool set to \"Ask every time\" — don't \"Always allow\" it — and that one click is your per-payment confirmation. Nothing is typed into the chat.",
    set_pay_required: "Also require a pay passphrase (advanced)",
    set_pay_required_hint: "Optional extra layer: the agent must also supply your pay passphrase, verified here (never leaves this dashboard). It needs an AI client that can prompt for a secret securely (MCP elicitation). Claude Desktop does not support that yet, so leave this OFF there and rely on its Allow prompt above.",
    pay_pass_set_ph: "Enter a new passphrase to replace the current one",
    pay_pass_unset_ph: "Set a pay passphrase",
    pay_pass_save: "Save passphrase",
    pay_pass_is_set: "A pay passphrase is set.",
    pay_pass_not_set: "No pay passphrase set yet.",
    pay_pass_saved: "Pay passphrase saved",
    pay_pass_cleared: "Pay passphrase cleared",
    pay_need_pass_first: "Set a pay passphrase first",
    lang_zh: "中文",
    lang_en: "English",
    lang_both: "Bilingual · 中文 / English",
    settings_saved: "Saved",
    settings_save_failed: "Could not save",
    connect_sub: "Copy a ready-made config and paste it into your AI — Claude Desktop, Cursor, any MCP host, or an HTTP framework like OpenClaw.",
    connect_no_budget: "No budget is open yet, so the block below uses a placeholder component. Open a budget (Manage) to fill in the real one.",
    connect_mcp_title: "MCP host — Claude Desktop / Cursor",
    connect_mcp_how: "Paste this into Claude Desktop's claude_desktop_config.json (under mcpServers), then restart Claude Desktop.",
    connect_cursor_how: "Cursor: paste the same block into ~/.cursor/mcp.json (or a project .cursor/mcp.json), then enable \"agentpay\" in Settings → MCP.",
    connect_generic_title: "Any other MCP host",
    connect_generic_how: "A bare stdio entry for any MCP client that takes a command + env.",
    connect_http_title: "HTTP — OpenClaw or any framework",
    connect_http_how: "For an agent that calls the hosted /api/v1 with an API key (it never touches the wallet). Drop these into the framework's environment.",
    connect_http_keyph: "<paste your agent key>",
    connect_http_keys: (p) => `/api/v1 is enabled. Use the secret of one of your agent keys: ${p.ids} (the server never shows the secret).`,
    connect_http_nokeys: "/api/v1 is enabled but no agent key is configured yet. Add one to AGENTPAY_API_KEYS (role \"agent\").",
    connect_http_disabled: "/api/v1 is not enabled on this server. Set AGENTPAY_API_KEYS to turn it on, then an agent key here will work.",
    connect_cli_hint: "Or run this once instead",
    connect_copy: "Copy config",

    /* overview */
    overview_sub: "A live view of your agent's on-chain spending budget.",
    hero_balance_label: "Available balance",
    onchain_live: "On-chain · live",
    onchain_offline: "On-chain · offline",
    last_synced: "Updated {t}",
    stat_active: "Active agents",
    stat_active_hint: "Sessions able to spend",
    cap_whitelist: "{n} whitelisted payees",
    sec_policy: "Spending policy",
    sec_policy_sub: "Per-transaction and daily caps, and the spend window.",
    sec_treasury_sub: "On-chain funds — top up or withdraw to the owner.",
    sec_sessions_sub: "Agent identities allowed to spend from this budget.",
    sec_security: "Security controls",
    sec_security_sub: "High-risk actions — each asks for a second confirmation.",
    treasury_onchain_note: "On-chain balance; the local view can lag a pending transaction.",
    window_rule: "Rolling window · {n} epochs",
    merchant_limits_link: "Manage merchant whitelist",
    pay_preview: "Payment preview",
    pay_preview_sub: "Local pre-check",
    pay_preview_note_title: "On-chain is final.",
    pay_preview_note_body: "This panel is a local estimate. The on-chain pre-check and the validator decide the outcome — submitted is not confirmed.",
    risk_whitelist: "Whitelist",
    risk_wl_ok: "Payee is on the on-chain whitelist.",
    risk_wl_bad: "Not whitelisted — the validator will reject this.",
    risk_awaiting: "Select a payee.",
    risk_pertx: "Per-transaction cap",
    risk_pertx_detail: "Cap {cap} {unit}.",
    risk_window: "Window allowance",
    risk_window_detail: "{left} {unit} left in this window.",
    risk_authority: "Authority",
    risk_authority_detail: "Owner-initiated (manual) payment.",
    risk_confirm: "Human confirmation",
    risk_confirm_detail: "Required before the payment is submitted.",
    m_stat_total: "Merchants",
    m_stat_enabled: "Enabled",
    m_stat_pending: "Pending",
    view_detail: "View detail",
    merchant_detail: "Merchant detail",
    merchant_status_active: "Approved",
    drawer_status: "Status",
    drawer_name: "Name",
    drawer_address: "Address",
    drawer_authorization: "Authorization",
    merchant_auth_note: "On the on-chain payee whitelist, added by the owner.",
    merchant_detail_note: "Payments to this payee pass the validator's whitelist check.",
    receipts_title: "Receipts",
    receipts_search: "Search by merchant, payer, or ID",
    rcpt_stat_count: "Receipts",
    rcpt_stat_total: "Total amount",
    rcpt_stat_latest: "Latest",
    rcpt_showing: "{n} of {total}",
    rcpt_th_receipt: "Receipt",
    rcpt_th_payer: "Payer",
    rcpt_no_match: "No receipts match your search.",
    receipt_detail: "Receipt detail",
    receipt_id: "Receipt ID",
    receipt_detail_note: "A receipt image the MCP generated as proof of this payment — verify on-chain status in the ledger.",
    connect_st_network: "Network: {n}",
    connect_st_api_on: "HTTP API on",
    connect_st_api_off: "HTTP API off",
    connect_st_keys: "{n} agent keys",
    connect_st_comp_ok: "Budget ready",
    connect_st_comp_none: "No budget yet",
    connect_steps_title: "How to connect",
    connect_step1_t: "Pick a method.",
    connect_step1_b: "MCP for Claude/Cursor, STDIO for other agents, or the HTTP API.",
    connect_step2_t: "Copy the config.",
    connect_step2_b: "Use the copy button on the block below — it is generated from this deployment.",
    connect_step3_t: "Start the service.",
    connect_step3_b: "Run agentpay-mcp (or point your HTTP client at this origin).",
    connect_step4_t: "Verify the connection.",
    connect_step4_b: "List tools / call get_server_info; the status above reflects the live server.",
    set_sec_general: "General",
    set_sec_general_sub: "Dashboard language and receipt language.",
    set_sec_wallet: "Wallet",
    set_sec_wallet_sub: "The owner account and on-chain budget component.",
    set_sec_network: "Network",
    set_sec_network_sub: "Chain endpoint and budget template (server-configured).",
    set_sec_security: "Security",
    set_sec_security_sub: "Step-up confirmation for high-risk actions.",
    set_sec_about: "About",
    set_sec_about_sub: "What this dashboard is.",
    set_owner: "Owner account",
    set_component: "Budget component",
    set_no_budget: "No budget yet",
    set_network: "Network",
    set_walletd: "walletd URL",
    set_template: "Budget template",
    set_network_note: "These come from the server environment and are set server-side — the dashboard shows them read-only and never changes them from the UI.",
    about_body: "AgentPay is an on-chain, hard-limit wallet and gateway for AI agents. This hosted dashboard meters and displays; the real spending limits are enforced by the on-chain validator, which never lets the dashboard move funds beyond them.",
    nobudget_title: "No budget yet",
    overview_empty_body:
      "Open an on-chain budget to give an AI agent a spending allowance that the Tari validators enforce — per-transaction and daily caps, a merchant whitelist, and a kill switch.",
    create_budget: "Create a budget",
    status_revoked: "Revoked",
    status_active: "Active",
    stat_treasury: "Treasury balance",
    stat_spent_window: "Spent (window)",
    stat_tx: "Transactions",
    stat_whitelisted: "Whitelisted",
    stat_treasury_hint: (p) => `${p.funded} funded · ${p.withdrawn} withdrawn`,
    stat_spent_hint_window: (p) => `of ${p.cap} cap · ${p.left} left`,
    stat_spent_hint_daily: (p) => `of ${p.cap} daily cap`,
    stat_tx_hint: "on-chain pay events",
    stat_whitelisted_hint: "approved merchants",
    stat_go: (p) => `Go to ${p.page}`,
    meter_window: "This window's spend",
    meter_treasury: "Treasury remaining",
    cap_pertx: (p) => `Per-tx cap ${p.n} ${p.unit}`,
    cap_daily: (p) => `Daily cap ${p.n} ${p.unit}`,
    cap_daily_window: (p) => ` / ≈${p.n}-epoch window`,
    cap_validator: "Validator-enforced",
    hero_title: "On-chain budget",
    epoch_tip: (p) =>
      `The daily cap is enforced over a rolling window of ${p.n} chain epochs ` +
      `(~${p.min} min each, ${p.total} in total), not a calendar day. It resets lazily — on the ` +
      `first payment after the window elapses — so these times are approximate.`,
    reset_elapsed: (p) => `Window elapsed — the next payment starts a fresh ≈${p.n}-epoch window.`,
    reset_active: (p) =>
      `${p.left} ${p.unit} left this window · resets ${p.eta} (${p.n} epoch${p.n === 1 ? "" : "s"})`,
    hero_epoch_note: (p) =>
      `<b>“Daily” is a rolling window of ${p.n} chain epochs</b> (~${p.min} min each, ${p.total} in total), ` +
      `not a calendar day — and it resets lazily on the next payment. Times are approximate.`,
    recent_activity: "Recent activity",
    view_all: "View all",
    overview_no_payments: "No payments yet. Head to Payments to send the first one.",
    whitelist: "Whitelist",
    manage: "Manage",
    any_merchant: "Any merchant allowed (no whitelist set)",
    overview_callout:
      "These rules live in the budget's on-chain component. Even a compromised agent client can't exceed them — the <b>validators reject</b> any payment that breaks them.",
    refresh: "Refresh",
    new_payment: "New payment",
    merchant_fallback: "Merchant",

    /* create */
    create_sub: "Fund an on-chain budget and set the rules the validators will enforce.",
    create_have_sub: "You already have an open budget.",
    create_have_title: "A budget is already open",
    create_have_body:
      "This demo manages one budget at a time. Open it in the overview, or reset to start a fresh one.",
    go_overview: "Go to overview",
    reset_start_over: "Reset & start over",
    budget_params: "Budget parameters",
    fund_amount: "Funding amount",
    fund_hint: "Moved from the owner account into the budget's on-chain vault.",
    fund_err: "Enter a positive funding amount.",
    pertx_cap: "Per-transaction cap",
    required: "Required.",
    daily_cap: "Daily cap",
    daily_cap_err: "Must be ≥ per-transaction cap.",
    daily_cap_worst: (p) => `Worst case ≈ 2× across a window boundary = <b>${p.n}</b> ${p.unit} — fixed window, not sliding`,
    daily_cap_worst_tip: (p) => `Worst case ≈ 2× across a window boundary = ${p.n} ${p.unit} (fixed window, not sliding).`,
    daily_window: "Daily window (epochs)",
    daily_window_hint: "The rolling window the daily cap is measured over, in chain epochs.",
    merchant_whitelist: "Merchant whitelist",
    merchant_placeholder: "Merchant name, e.g. shop",
    add: "Add",
    merchant_wl_hint:
      "Named merchants are created on the local devnet on first use. Leave empty to allow any merchant.",
    open_on_chain: "Open budget on chain",
    create_trust_title: "Hosted, but not trusted blindly.",
    create_trust_body:
      "The backend signs through walletd — but the caps and whitelist you set here are compiled into the budget's on-chain component and enforced by validators, not by this app.",
    what_happens: "What happens",
    step_withdraw: "Owner withdraws the funding from their account.",
    step_mint: "The <code>AgentBudget</code> template mints the budget component + owner/agent badges.",
    step_store: "Caps, window and whitelist are stored on chain.",
    step_pay: "The agent can now pay — within the rules only.",
    remove_tag: (p) => `Remove ${p.name}`,

    /* pay */
    pay_sub: "The agent pays whitelisted merchants — every payment is checked on chain.",
    pay_nobudget_sub: "Open a budget before sending payments.",
    send_payment: "Send a payment",
    agent_revoked_badge: "Agent revoked",
    merchant_label: "Merchant",
    optgroup_wl: "Whitelisted — the agent can pay these",
    optgroup_other: "Not whitelisted — the chain will reject",
    no_wl_option: "No whitelisted merchants yet — add one in Governance",
    address_suffix: "(address)",
    pay_merchant_hint:
      "Every merchant on the budget's on-chain whitelist is listed here. Pick a non-whitelisted one (e.g. <code>scammer</code>) to watch the chain refuse it.",
    pick_merchant_err: "Pick a merchant.",
    amount: "Amount",
    amount_err: "Enter a positive amount.",
    memo_label: "Invoice / memo",
    optional: "(optional)",
    memo_placeholder: "invoice-042",
    check_on_chain: "Check on chain",
    pay: "Pay",
    pay_callout_title: "“Check on chain”",
    pay_callout_body:
      " runs a validator dry-run: it asks the chain whether the payment would be accepted, and shows the validator's own reason if not — no transaction is submitted.",
    activity: "Activity",
    activity_sub: (p) => `${p.n} payments · rebuilt from chain events`,
    pay_no_payments_title: "No payments yet",
    pay_no_payments_body: "Payments you send appear here, read back from the chain's <code>pay</code> events.",
    th_merchant: "Merchant",
    th_amount: "Amount",
    th_memo: "Memo",
    th_time: "Time",
    th_source: "Source",
    via_manual: "Manual",
    via_api: "API",
    via_chain: "On-chain",
    via_manual_tip: "Sent from this dashboard (owner / web UI).",
    via_api_tip: "Sent through the Integration API (agent key).",
    via_chain_tip: "Discovered on chain — an external client (MCP / SDK / another dashboard).",
    verdict_ok_title: "The chain would accept this",
    verdict_ok_body: (p) =>
      `A validator dry-run of paying <b>${p.amount} ${p.unit}</b> to <b>${p.merchant}</b> passes every on-chain rule. Hit <b>Pay</b> to submit it for real.`,
    verdict_reject_title: "The validator would reject this",
    verdict_reject_body: (p) =>
      `Reason from the chain: <code>${p.reason}</code><br/>This isn't the UI second-guessing you — the on-chain budget refuses it, so the payment can't be forced through.`,
    verdict_paid_reject_title: "Payment rejected on chain",
    verdict_paid_reject_body: (p) =>
      `Reason: <code>${p.reason}</code><br/>The validators enforced the budget's rules — nothing was spent.`,

    /* governance */
    gov_sub: "Owner controls. Changes are signed with the owner badge and committed on chain.",
    gov_nobudget_sub: "Open a budget to manage it.",
    danger_zone: "Danger zone",
    wl_merchants: "Whitelisted merchants",
    no_wl_merchants: "No merchants whitelisted — any merchant is allowed.",
    add_merchant_placeholder: "Add merchant by name",
    gov_wl_hint: "Adds a merchant to the on-chain whitelist via the owner badge. ",
    gov_wl_hint_revoked: "<b>The agent is revoked, but the whitelist can still be edited.</b>",
    remove_merchant: "Remove from whitelist",
    confirm_remove_merchant_title: (p) => `Remove “${p.name}” from the whitelist?`,
    confirm_remove_merchant_body:
      "The owner badge signs the template's on-chain <code>remove_merchant</code>. Once the transaction finalizes the agent can no longer pay this address — the validators refuse it. You can add it back later.",
    confirm_remove_merchant_ok: "Remove merchant",
    limits_title: "Spending limits",
    limits_hint:
      "Signs an on-chain <code>set_limits</code> with the owner badge. The new per-transaction cap binds on the very next payment; the daily cap applies to the current window (spend already counted in it is kept).",
    limits_pertx_err: "Enter a per-transaction cap of at least 1.",
    limits_unchanged: "These are already the current limits.",
    update_limits: "Update limits",
    treasury: "Treasury",
    treasury_hint: (p) => `available to withdraw · ${p.funded} funded, ${p.spent} spent`,
    topup_label: "Top up (add funds)",
    topup: "Top up",
    topup_hint: (p) =>
      `Moves ${p.unit} from the owner account into the budget's on-chain vault. A keeper can do this on its own cadence — the chain has no timer.`,
    withdraw_amount: "Withdraw amount",
    withdraw_amount_err: "Enter an amount within the treasury.",
    withdraw_to_owner: "Withdraw to owner",
    agent_sessions: "Agent sessions",
    badge_count: (p) => `${p.n} badge${p.n === 1 ? "" : "s"}`,
    revoke: "Revoke",
    revoked: "Revoked",
    session_default_sub: "created with the budget",
    session_issued_sub: "issued session badge",
    new_session_placeholder: "New session label, e.g. agent-2",
    issue_badge: "Issue badge",
    sessions_hint:
      "Each session is a separate agent badge of the same on-chain resource. Issue one per agent/session and revoke any single one without touching the others. <b>Revoke agent</b> below is the global kill switch for all of them.",
    kill_switch: "Kill switch",
    revoke_authority: "Revoke the agent's spending authority",
    revoke_authority_body:
      "Flips the on-chain kill switch. Every further payment is rejected by the validators — instantly and irreversibly. The owner can still withdraw the remaining treasury.",
    already_revoked: "Already revoked",
    revoke_agent: "Revoke agent",
    reset_demo: "Reset demo (detach budget)",

    /* no-budget generic */
    nobudget_open_title: "No budget open",
    nobudget_open_body: "Create an on-chain budget first, then come back here.",

    /* login */
    login_sub: "Agent budget console",
    login_intro: "This console operates a hosted wallet. Sign in to continue.",
    password: "Password",
    incorrect_password: "Incorrect password.",
    enter_password: "Enter your password.",
    signin: "Sign in",
    signing_in: "Signing in…",

    /* connection problem */
    conn_problem: "Connection problem",
    conn_cant_reach: "Can't reach the wallet daemon",
    retry: "Retry",
    conn_hint_pre: "Make sure the local Tari swarm is running and ",
    conn_hint_mid: " is reachable at ",
    conn_hint_url_fallback: "the configured URL",

    /* confirm modal */
    cancel: "Cancel",
    confirm_reset_title: "Reset the demo?",
    confirm_reset_body:
      "This only clears the dashboard's <b>local view</b> so you can open a fresh budget. Nothing on chain changes — the budget component, its vault and any remaining treasury stay exactly as they are. It does <b>not</b> withdraw or refund funds. Use <b>Withdraw</b> first if you want the treasury back.",
    confirm_reset_ok: "Reset",
    confirm_revoke_title: "Revoke the agent?",
    confirm_revoke_body:
      "The validators will reject <b>every future payment</b> from this agent. This flips the on-chain kill switch and <b>cannot be undone</b>.",
    confirm_revoke_ack: "I understand this permanently blocks the agent.",
    confirm_revoke_session_title: (p) => `Revoke session “${p.session}”?`,
    confirm_revoke_session_body:
      "The validators will reject <b>every future payment</b> from this agent session. Other sessions keep working. This cannot be undone (you can issue a fresh badge with the same label later).",
    confirm_revoke_session_ack: "I understand this blocks this session on chain.",
    confirm_revoke_session_ok: "Revoke session",
    confirm_withdraw_title: "Withdraw to owner?",
    confirm_withdraw_body: (p) =>
      `Move <b>${p.amount} ${p.unit}</b> from the budget's on-chain vault back to the owner account.`,
    confirm_withdraw_ok: (p) => `Withdraw ${p.amount} ${p.unit}`,

    /* pending button labels */
    p_refreshing: "Refreshing",
    p_connecting: "Connecting",
    p_opening: "Opening on chain…",
    p_asking: "Asking the chain…",
    p_submitting: "Submitting…",
    p_adding: "Adding…",
    p_removing: "Removing…",
    p_updating_limits: "Updating…",
    p_topping: "Topping up…",
    p_issuing: "Issuing…",
    p_withdrawing: "Withdrawing…",
    p_revoking: "Revoking",

    /* toasts */
    t_uptodate: "Up to date",
    t_uptodate_msg: "Reloaded from the chain.",
    t_connected: "Connected",
    t_connected_msg: "Wallet daemon is reachable.",
    t_still_offline: "Still offline",
    t_reset: "Reset",
    t_reset_msg: "Local view cleared. The previous budget still exists on chain — funds were not withdrawn.",
    t_reset_failed: "Reset failed",
    t_agent_revoked: "Agent revoked",
    t_agent_revoked_msg: "The kill switch is on. Further payments will be rejected on chain.",
    t_revoke_failed: "Revoke failed",
    t_session_revoked: "Session revoked",
    t_session_revoked_msg: (p) => `“${p.session}” can no longer pay. Other sessions are unaffected.`,
    t_budget_opened: "Budget opened",
    t_budget_opened_msg: (p) => `Funded ${p.amount} ${p.unit} · live on chain.`,
    t_open_failed: "Couldn't open budget",
    t_dryrun_failed: "Dry-run failed",
    t_payment_sent: "Payment sent",
    t_payment_sent_msg: (p) => `${p.amount} ${p.unit} to ${p.merchant} — confirmed on chain.`,
    t_rejected_onchain: "Rejected on chain",
    t_payment_failed: "Payment failed",
    t_merchant_wl: "Merchant whitelisted",
    t_merchant_wl_msg: (p) => `${p.name} can now receive payments.`,
    t_merchant_failed: "Couldn't add merchant",
    t_merchant_removed: "Merchant removed",
    t_merchant_removed_msg: (p) => `${p.name} is no longer whitelisted on chain.`,
    t_merchant_remove_failed: "Couldn't remove merchant",
    t_limits_updated: "Limits updated",
    t_limits_updated_msg: (p) => `Per-tx ${p.perTx} ${p.unit} · daily ${p.daily} ${p.unit} — enforced on chain.`,
    t_limits_failed: "Couldn't update limits",
    t_topped_up: "Topped up",
    t_topped_up_msg: (p) => `${p.amount} ${p.unit} added to the budget's vault.`,
    t_topup_failed: "Top-up failed",
    t_badge_issued: "Session badge issued",
    t_badge_issued_msg: (p) => `“${p.session}” can now pay within the same on-chain rules.`,
    t_badge_failed: "Couldn't issue badge",
    t_withdrawn: "Withdrawn",
    t_withdrawn_msg: (p) => `${p.amount} ${p.unit} returned to the owner.`,
    t_withdraw_failed: "Withdraw failed",
    /* submitted-but-unknown (journaled "pending"): the tx MAY have landed — never say "confirmed",
     * and tell the user not to resubmit (a retry reuses the idempotency key; the server dedups). */
    t_pending: "Submitted — not yet confirmed",
    t_pending_pay_msg: (p) => `${p.amount} ${p.unit} to ${p.merchant} was submitted but hasn't confirmed yet. Don't resubmit — it may already be on chain; it will settle on its own.`,
    t_pending_topup_msg: (p) => `Top-up of ${p.amount} ${p.unit} was submitted but hasn't confirmed yet. Don't resubmit — it may already be on chain.`,
    t_pending_open_msg: (p) => `Opening the budget (${p.amount} ${p.unit}) was submitted but hasn't confirmed yet. Don't resubmit — it may already be on chain.`,
    t_pending_withdraw_msg: (p) => `Withdrawal of ${p.amount} ${p.unit} was submitted but hasn't confirmed yet. Don't resubmit — it may already be on chain.`,

    /* step-up confirmation */
    stepup_title: "Confirm this action",
    stepup_body:
      "This is a high-risk action. Re-enter the admin password to authorize it — this second factor is separate from your login, so a stolen session alone can't move funds.",
    stepup_password_label: "Admin password",
    stepup_confirm: "Confirm",

    /* emergency stop (dashboard-wide freeze) */
    emergency_stop: "Emergency stop",
    freeze_title: "Freeze the dashboard (global kill switch)",
    freeze_body:
      "Blocks every fund-moving action — payments, top-ups, withdrawals, new budgets — across the whole dashboard at once. Read-only views keep working. Use this if you suspect the server or an operator account is compromised. It is separate from a single budget's on-chain revoke, and it is reversible.",
    freeze_btn: "Freeze everything",
    unfreeze_btn: "Unfreeze",
    frozen_badge: "Frozen",
    confirm_freeze_title: "Freeze the whole dashboard?",
    confirm_freeze_body:
      "Every fund-moving action will be refused until you unfreeze. Read-only views stay available. Use this as an emergency stop.",
    confirm_unfreeze_title: "Unfreeze the dashboard?",
    confirm_unfreeze_body: "Fund-moving actions will be enabled again. Only do this once you're sure it's safe.",
    frozen_banner_title: "Dashboard frozen — ",
    frozen_banner_body: "the emergency stop is engaged, so every fund-moving action is blocked. Unfreeze it in Governance.",
    p_freezing: "Freezing…",
    p_unfreezing: "Unfreezing…",
    t_frozen: "Dashboard frozen",
    t_frozen_msg: "Every fund-moving action is now blocked. Read-only views still work.",
    t_unfrozen: "Dashboard unfrozen",
    t_unfrozen_msg: "Fund-moving actions are enabled again.",
    t_freeze_failed: "Couldn't change the freeze state",

    dismiss: "Dismiss",
  },

  zh: {
    /* static page chrome */
    meta_title: "AgentPay — 为 AI 代理设置的链上预算",
    meta_desc: "AgentPay —— 一个托管式仪表盘,用于管理 Tari Ootle 上由验证节点强制执行的 AI 代理链上消费预算。",
    boot_connecting: "正在连接到链…",
    lang_aria: "语言",

    /* brand / sidebar */
    brand_sub: "代理预算控制台",
    conn_online: "已连接到链",
    conn_offline: "未连接",
    wallet_only_no_backend: "此页为自托管模式:链上操作请连接并通过你的钱包完成、在钱包内批准。这里没有托管后端。",
    theme_group: "主题",
    theme_light: "浅色",
    theme_system: "跟随系统",
    theme_dark: "深色",
    theme_aria: (p) => `${p.name}主题`,
    meta_template: "模板",
    meta_owner: "所有者",
    signout: "退出登录",
    copy_full: "复制完整地址",
    copy: "复制",

    /* nav */
    nav_overview: "总览",
    nav_start: "开始使用",
    nav_wallet: "钱包",
    wallet_view_sub: "你的浏览器持钥 —— 在此创建或解锁,即可管理预算。",
    start_sub: "新手第一步 —— 从登录到你的 AI 完成第一笔付款。",
    start_custodial_note: "这是托管式控制台:钱包由服务端的 walletd 持有并签名,面板已经连接到链。你无需在浏览器里连接钱包。",
    /* 非托管单模式(S.nonCustodial)—— 所有者在本页解锁浏览器持钥钱包 */
    start_sub_nc: "起步几步 —— 解锁你的 AgentPay 钱包、设好额度与白名单,然后发起一笔支付。每次变更都在你的钱包里批准。",
    nco_note: "非托管:密钥由你的 AgentPay 钱包在本浏览器持有。仪表盘从钱包读取这个预算,并把每一次变更 —— 付款、额度、商户、生命周期 —— 都交给钱包弹窗批准;额度由链上强制。后端不再替你签名。",
    nco_s1_t: "1 · 解锁你的 AgentPay 钱包",
    nco_s1_b: "在本页『钱包』里解锁你的 AgentPay 钱包并在此连接。连接后仪表盘从钱包读取这个预算,所有者的每一步操作都在钱包里批准 —— 浏览器不再驱动托管签名器。",
    nco_connect_cta: "连接钱包",
    nco_connect_hint: "在『钱包』里批准连接请求 —— 它会在那里等你批准。",
    nco_connected: "钱包已连接 · {acct}",
    nco_not_connected: "钱包未连接",
    nco_s2_t: "2 · 你的预算",
    nco_s2_b: "连接之后,总览、余额和动态都来自你钱包里的这个预算,而不是服务端的副本。",
    nco_budget_ready: "已从你的钱包载入预算",
    nco_budget_wait: "连接钱包后载入预算",
    nco_s3_t: "3 · 设置额度与白名单",
    nco_s3_b: "在「管理」里设置单笔与每日上限;在「商户」里添加代理可付款的收款人。每次变更都会弹出钱包批准,并由链上强制执行。",
    nco_s4_t: "4 · 发起支付",
    nco_s4_b: "在「支付」页发起一笔付款;你的钱包批准,链上强制额度与白名单。回执出现在「回执」页。",
    meta_desc_nc: "AgentPay —— 一个非托管控制台,用于管理 Tari Ootle 上由验证节点强制执行的 AI 代理链上消费预算。密钥由你的钱包持有,每次变更都经钱包批准。",
    about_body_nc: "AgentPay 是面向 AI 代理的非托管链上硬额度钱包与网关。密钥由你的钱包持有、每次变更由你批准;真正的额度由链上验证节点强制执行,任何人都无法越过额度动用资金。",
    create_trust_title_nc: "非托管,且由链上强制。",
    create_trust_body_nc: "每一次变更都由你在自己的钱包里批准 —— 后端绝不持有你的密钥。你在这里设定的上限与白名单,会被编译进预算的链上组件,由验证节点强制执行,而不是靠这个应用本身。",
    login_intro_nc: "登录你的 AgentPay 控制台。链上操作在你连接的钱包里批准 —— 控制台绝不持有你的密钥。",
    start_s1_t: "1 · 登录",
    start_s1_b: "用部署方发给你的口令进入本控制台——没有自助注册。请妥善保管这个口令。",
    start_s1_done: "已登录",
    start_s2_t: "2 · 钱包已就绪",
    start_s2_b: "托管钱包已在服务端配置好,这里无需连接。当面板显示已连接到链,即可开始。",
    start_chain_on: "已连接到链 · {net}",
    start_chain_off: "尚未连接到链",
    start_owner: "托管账户 {acct}",
    start_s3_t: "3 · 接入你的 AI",
    start_s3_b: "在「接入」页复制 MCP 配置或 API key,把你的 AI 代理接到这个预算。代理只连到链上预算(component),绝不会拿到所有者钥匙。",
    start_connected_n: "已接入 {n} 个凭证",
    start_not_connected: "还没有代理接入",
    start_cta_connect: "去接入",
    start_s4_t: "4 · 设额度与白名单",
    start_s4_b: "在「管理」页设单笔/每日上限,在「商户」页添加代理可付款的白名单。链上硬额度才是真正的边界。",
    start_wl_n: "{n} 个白名单商户",
    start_wl_none: "还没有白名单商户",
    start_cta_manage: "设额度",
    start_cta_merchants: "设白名单",
    start_s5_t: "5 · 让代理付款",
    start_s5_b: "让你的代理调用 pay_merchant;每一笔都按链上硬额度和白名单强制校验。付款回执会出现在「回执」页。",
    start_cta_pay: "试一笔付款",
    start_cta_receipts: "看回执",
    start_mode_label: "先选择由谁持有密钥",
    start_mode_custodial: "托管(平台持有)",
    start_mode_noncustodial: "非托管(自持)",
    start_mode_hint_cus: "最简单的起步方式:walletd 在服务端持有并签名。你在这里登录、设置额度;你的代理接入托管预算即可。",
    start_mode_hint_nc: "你自行运行 walletd、自己保管密钥。所有者为你的代理在链上发放一枚权限最小化的凭证——代理可在链上额度内付款,但不持有所有者密钥,也没有 Admin 权限。",
    start_noncustodial_note: "非托管模式:密钥保存在你自己的 walletd 里。下面申请把代理凭证发放到你的账户,然后把返回的配置粘贴到你的 walletd。代理令牌仅限发送(TransactionSend、TransactionGet)——绝不含 Admin。",
    nc_s2_t: "2 · 运行你自己的 walletd 和账户",
    nc_s2_b: "启动一个你自己掌控的 Tari Ootle walletd,并创建(或选定)用来持有代理凭证的账户。这个账户地址就是下面要填的内容——所有者的密钥和资金留在所有者一侧,互相隔离。",
    nc_s2_env: "密钥不会离开你的 walletd",
    nc_s3_t: "3 · 领取你的代理凭证",
    nc_s3_b: "填入你的代理账户地址和一个标签。所有者(运维)会把一枚代理凭证发放到该账户——这是一次自助、由所有者签名的链上操作,受与所有高风险操作相同的二次确认(step-up)门控。",
    nc_account_label: "你的代理账户地址",
    nc_account_ph: "account_…(你自己 walletd 的账户)",
    nc_account_err: "请填入要发放凭证的账户地址。",
    nc_label_label: "会话标签",
    nc_label_ph: "例如 prod-agent-1",
    nc_label_err: "只能用字母、数字、点、短横或下划线(最多 64 位)。",
    nc_issue_btn: "申请代理凭证",
    nc_issue_hint: "需要运维二次确认(step-up)。凭证发放到你的账户,不在此托管。",
    nc_s4_t: "4 · 配置你的 walletd",
    nc_s4_b: "凭证发放后,把下面的内容粘贴到你代理的环境变量里。填上你自己的 walletd 地址和令牌;权限按设计仅限发送。",
    nc_s4_pre: "在第 3 步发放凭证后,你的配置会出现在这里。",
    nc_env_walletd_ph: "https://your-own-walletd:18000",
    nc_env_note: "把 AGENTPAY_WALLETD_TOKEN 设为你的 walletd 为该账户签发的令牌,只含 TransactionSend 和 TransactionGet——绝不含 Admin。",
    nc_issued_ok: "凭证已发放到 {acct}",
    nc_s5_t: "5 · 让代理付款",
    nc_s5_b: "现在你的代理在自己的 walletd 里用自己的凭证签名。每一笔付款仍按链上硬额度和白名单强制校验;回执会出现在「回执」页。",
    nc_revoke_note: "所有者可随时吊销该凭证",
    nav_create: "创建预算",
    nav_manage: "管理",
    nav_pay: "支付",
    nav_governance: "治理",
    nav_merchants: "商户",
    manage_sub: "所有者控制——资金、支出限额、代理会话与紧急停止。",
    merchants_sub: "代理被允许支付的链上商户白名单。",
    merchants_nobudget_sub: "请先创建预算，再在此管理商户白名单。",

    /* connect */
    nav_connect: "接入",
    nav_receipts: "回执",
    receipts_sub: "AI 代理收到的付款回执,存在这里可查看和下载。",
    receipts_empty: "还没有回执。代理通过 MCP 付款后,回执会出现在这里。",
    receipt_download: "下载",
    receipt_to: "收款方",
    receipt_from: "付款方",
    receipt_at: "时间",
    receipts_load_failed: "加载回执失败",
    nav_subscription: "订阅",
    sub_sub: "你的 AgentPay 套餐、本周期用量与账单。计费只做用量统计 —— 从不持有密钥,也不动用资金。",
    sub_unconfigured_title: "尚未配置计费",
    sub_unconfigured_body: "本部署未配置计费后端。设置 AGENTPAY_BILLING_URL、AGENTPAY_BILLING_KEY 和 AGENTPAY_BILLING_TENANT 即可启用订阅。",
    sub_unavailable_title: "计费暂时不可用",
    sub_unavailable_body: "无法连接计费服务。你的链上预算与支付不受影响 —— 只是订阅视图暂时离线。",
    sub_plan: "当前套餐",
    sub_status: "状态",
    sub_free: "免费",
    sub_price_month: "/月",
    sub_renews: "续费日",
    sub_seats: "活跃预算",
    sub_usage_title: "本周期",
    sub_payments: "支付笔数",
    sub_volume: "金额(µT)",
    sub_dues: "应付金额",
    sub_invoices_title: "账单",
    sub_invoices_empty: "暂无账单。",
    sub_inv_period: "周期",
    sub_inv_amount: "金额",
    sub_inv_status: "状态",
    sub_change_plan: "更换套餐",
    sub_manage_billing: "管理账单",
    sub_choose: "选择",
    sub_current: "当前",
    sub_redirecting: "正在打开计费…",
    sub_action_failed: "无法开始计费",
    sub_custom: "定制",
    sub_feat_budgets: "{n} 个活跃预算",
    sub_feat_budgets_unlimited: "活跃预算不限",
    sub_feat_included_gmv: "包含交易额 {v} µT",
    sub_feat_gmv_overage: "超额交易额费率 {pct}",
    sub_feat_seat_overage: "每增加一个预算 {price}",
    nav_settings: "设置",
    settings_sub: "设置本控制台与代理付款回执的默认项。",
    set_ui_lang: "界面语言",
    set_ui_lang_hint: "本控制台的显示语言 —— 即时生效,记在本浏览器。",
    set_receipt_lang: "回执单语言",
    set_receipt_lang_hint: "AI 代理通过 MCP 收到的付款回执图的语言(下一笔付款起生效)。",
    set_pay_confirm: "支付确认",
    set_pay_confirm_intro: "每笔付款都已经由你的 AI 应用自带的「允许运行 pay_merchant?」弹窗来确认(弹窗会显示商户和金额)。把该工具保持为「每次询问」、不要设成「始终允许」,点一下允许就是你对这笔付款的确认 —— 口令不会进聊天。",
    set_pay_required: "额外再要一道支付口令(进阶)",
    set_pay_required_hint: "可选的加强层:代理还必须提供你的支付口令,在本控制台校验(绝不离开本机)。它需要 AI 客户端能安全地弹框收口令(MCP elicitation)。Claude Desktop 目前不支持,所以在它上面请保持关闭,改用上面的「允许」弹窗即可。",
    pay_pass_set_ph: "输入新口令以替换当前口令",
    pay_pass_unset_ph: "设置支付口令",
    pay_pass_save: "保存口令",
    pay_pass_is_set: "已设置支付口令。",
    pay_pass_not_set: "尚未设置支付口令。",
    pay_pass_saved: "支付口令已保存",
    pay_pass_cleared: "支付口令已清除",
    pay_need_pass_first: "请先设置支付口令",
    lang_zh: "中文",
    lang_en: "English",
    lang_both: "双语 · 中文 / English",
    settings_saved: "已保存",
    settings_save_failed: "保存失败",
    connect_sub: "复制一份现成配置，直接粘贴到你的 AI —— Claude Desktop、Cursor、任意 MCP 宿主，或 OpenClaw 这类 HTTP 框架。",
    connect_no_budget: "当前还没有开预算，下面的配置用的是占位组件地址。到「管理」开一个预算后，这里会自动填入真实地址。",
    connect_mcp_title: "MCP 宿主 —— Claude Desktop / Cursor",
    connect_mcp_how: "粘贴到 Claude Desktop 的 claude_desktop_config.json（放在 mcpServers 下），然后重启 Claude Desktop。",
    connect_cursor_how: "Cursor：把同一段粘贴到 ~/.cursor/mcp.json（或项目里的 .cursor/mcp.json），再到 设置 → MCP 启用 “agentpay”。",
    connect_generic_title: "其他 MCP 宿主",
    connect_generic_how: "适用于任何接受 command + env 的 MCP 客户端的裸 stdio 配置。",
    connect_http_title: "HTTP —— OpenClaw 或任意框架",
    connect_http_how: "给用 API key 调用托管 /api/v1 的代理（它不碰钱包）。把这两行丢进框架的环境变量即可。",
    connect_http_keyph: "<粘贴你的 agent key>",
    connect_http_keys: (p) => `/api/v1 已启用。用你某个 agent key 的密钥：${p.ids}（密钥由你保管，服务端从不显示）。`,
    connect_http_nokeys: "/api/v1 已启用，但还没有配置 agent key。在 AGENTPAY_API_KEYS 里加一个（角色 “agent”）。",
    connect_http_disabled: "本服务端未启用 /api/v1。设置 AGENTPAY_API_KEYS 开启后，这里的 agent key 就能用了。",
    connect_cli_hint: "或者改成跑一次这条命令",
    connect_copy: "复制配置",

    /* overview */
    overview_sub: "实时查看代理的链上消费预算。",
    hero_balance_label: "可用余额",
    onchain_live: "链上 · 实时",
    onchain_offline: "链上 · 离线",
    last_synced: "更新于 {t}",
    stat_active: "活跃 Agent",
    stat_active_hint: "可发起支付的会话",
    cap_whitelist: "{n} 个白名单收款人",
    sec_policy: "支出策略",
    sec_policy_sub: "单笔与每日限额，以及支出窗口规则。",
    sec_treasury_sub: "链上资金——充值或提现到所有者。",
    sec_sessions_sub: "被授权从该预算支付的 Agent 身份。",
    sec_security: "安全控制",
    sec_security_sub: "高风险操作——每项都需二次确认。",
    treasury_onchain_note: "链上余额；本地显示可能滞后于待确认交易。",
    window_rule: "滚动窗口 · {n} 个纪元",
    merchant_limits_link: "管理商户白名单",
    pay_preview: "支付预览",
    pay_preview_sub: "本地预检",
    pay_preview_note_title: "以链上为准。",
    pay_preview_note_body: "此面板为本地估算。最终结果以链上预检与验证节点为准——已提交不等于已确认。",
    risk_whitelist: "白名单",
    risk_wl_ok: "收款人已在链上白名单。",
    risk_wl_bad: "不在白名单——将被验证节点拒绝。",
    risk_awaiting: "请选择收款对象。",
    risk_pertx: "单笔上限",
    risk_pertx_detail: "上限 {cap} {unit}。",
    risk_window: "窗口额度",
    risk_window_detail: "本窗口还剩 {left} {unit}。",
    risk_authority: "预算权限",
    risk_authority_detail: "所有者发起（人工）支付。",
    risk_confirm: "人工确认",
    risk_confirm_detail: "提交前需人工确认。",
    m_stat_total: "商户总数",
    m_stat_enabled: "已启用",
    m_stat_pending: "待处理",
    view_detail: "查看详情",
    merchant_detail: "商户详情",
    merchant_status_active: "已批准",
    drawer_status: "状态",
    drawer_name: "名称",
    drawer_address: "地址",
    drawer_authorization: "授权",
    merchant_auth_note: "位于链上收款白名单，由所有者添加。",
    merchant_detail_note: "向该收款人的支付可通过验证节点的白名单校验。",
    receipts_title: "交易回执",
    receipts_search: "按商户、付款方或 ID 搜索",
    rcpt_stat_count: "回执数量",
    rcpt_stat_total: "合计金额",
    rcpt_stat_latest: "最近",
    rcpt_showing: "{n} / {total}",
    rcpt_th_receipt: "回执",
    rcpt_th_payer: "付款方",
    rcpt_no_match: "没有匹配的回执。",
    receipt_detail: "回执详情",
    receipt_id: "回执 ID",
    receipt_detail_note: "由 MCP 生成的支付凭证图片——链上状态请在交易记录中核对。",
    connect_st_network: "网络：{n}",
    connect_st_api_on: "HTTP API 已开启",
    connect_st_api_off: "HTTP API 未开启",
    connect_st_keys: "{n} 个代理密钥",
    connect_st_comp_ok: "预算就绪",
    connect_st_comp_none: "尚未创建预算",
    connect_steps_title: "接入步骤",
    connect_step1_t: "选择接入方式。",
    connect_step1_b: "Claude/Cursor 用 MCP，其他代理用 STDIO，或使用 HTTP API。",
    connect_step2_t: "复制配置。",
    connect_step2_b: "用下方代码块的复制按钮——配置由本部署实时生成。",
    connect_step3_t: "启动服务。",
    connect_step3_b: "运行 agentpay-mcp（或让 HTTP 客户端指向本地址）。",
    connect_step4_t: "验证连接。",
    connect_step4_b: "列出工具 / 调用 get_server_info；上方状态反映真实服务器。",
    set_sec_general: "通用",
    set_sec_general_sub: "仪表盘语言与回执语言。",
    set_sec_wallet: "钱包",
    set_sec_wallet_sub: "所有者账户与链上预算组件。",
    set_sec_network: "网络",
    set_sec_network_sub: "链节点与预算模板（由服务端配置）。",
    set_sec_security: "安全",
    set_sec_security_sub: "高风险操作的二次确认。",
    set_sec_about: "关于",
    set_sec_about_sub: "关于这个仪表盘。",
    set_owner: "所有者账户",
    set_component: "预算组件",
    set_no_budget: "尚未创建预算",
    set_network: "网络",
    set_walletd: "walletd 地址",
    set_template: "预算模板",
    set_network_note: "这些来自服务端环境、由服务端配置——仪表盘只读展示，绝不通过界面修改它们。",
    about_body: "AgentPay 是面向 AI 代理的链上硬额度钱包与网关。托管仪表盘负责计量与展示；真正的额度由链上验证节点强制执行，绝不允许仪表盘越过额度动用资金。",
    nobudget_title: "还没有预算",
    overview_empty_body:
      "开一个链上预算,给 AI 代理一份由 Tari 验证节点强制执行的消费额度:单笔上限、每日上限、商户白名单,以及一键停用开关。",
    create_budget: "创建预算",
    status_revoked: "已停用",
    status_active: "生效中",
    stat_treasury: "资金余额",
    stat_spent_window: "本窗口已花",
    stat_tx: "交易笔数",
    stat_whitelisted: "白名单商户",
    stat_treasury_hint: (p) => `已注资 ${p.funded} · 已提现 ${p.withdrawn}`,
    stat_spent_hint_window: (p) => `上限 ${p.cap} · 剩余 ${p.left}`,
    stat_spent_hint_daily: (p) => `每日上限 ${p.cap}`,
    stat_tx_hint: "链上支付事件",
    stat_whitelisted_hint: "已批准的商户",
    stat_go: (p) => `前往${p.page}`,
    meter_window: "本窗口消费",
    meter_treasury: "资金余额",
    cap_pertx: (p) => `单笔上限 ${p.n} ${p.unit}`,
    cap_daily: (p) => `每日上限 ${p.n} ${p.unit}`,
    cap_daily_window: (p) => ` / 约 ${p.n} 个纪元的窗口`,
    cap_validator: "验证节点强制",
    hero_title: "链上预算",
    epoch_tip: (p) =>
      `每日上限是按 ${p.n} 个链纪元(epoch)组成的滚动窗口来统计的(每个约 ${p.min} 分钟,合计${p.total}),` +
      `并非自然日。窗口到期后,它要等下一笔支付时才会重置,所以这里的时间都是估算值。`,
    reset_elapsed: (p) => `窗口已结束——下一笔支付会开启新的、约 ${p.n} 个纪元的窗口。`,
    reset_active: (p) => `本窗口还剩 ${p.left} ${p.unit} · ${p.eta}后重置(还差 ${p.n} 个纪元)`,
    hero_epoch_note: (p) =>
      `<b>这里的“每日”是 ${p.n} 个链纪元组成的滚动窗口</b>(每个约 ${p.min} 分钟,合计${p.total}),` +
      `并非自然日;而且要到下一笔支付时才会重置。时间均为估算。`,
    recent_activity: "最近动态",
    view_all: "查看全部",
    overview_no_payments: "还没有支付记录。到「支付」页发起第一笔吧。",
    whitelist: "白名单",
    manage: "管理",
    any_merchant: "未设白名单,任意商户都可收款",
    overview_callout:
      "这些规则保存在预算的链上组件里。即便代理客户端被攻陷,也无法突破——任何违规的支付都会<b>被验证节点拒绝</b>。",
    refresh: "刷新",
    new_payment: "发起支付",
    merchant_fallback: "商户",

    /* create */
    create_sub: "为链上预算注资,并设定由验证节点强制执行的规则。",
    create_have_sub: "你已经开过一个预算了。",
    create_have_title: "已有一个预算在运行",
    create_have_body: "本演示一次只管理一个预算。可以到总览里打开它,或者重置后重新创建。",
    go_overview: "前往总览",
    reset_start_over: "重置并重新开始",
    budget_params: "预算参数",
    fund_amount: "注资金额",
    fund_hint: "将从所有者账户转入预算的链上金库。",
    fund_err: "请输入大于零的注资金额。",
    pertx_cap: "单笔上限",
    required: "必填。",
    daily_cap: "每日上限",
    daily_cap_err: "不能小于单笔上限。",
    daily_cap_worst: (p) => `跨窗口边界最坏可花 ≈ 2× = <b>${p.n}</b> ${p.unit}——固定窗口，非滑动`,
    daily_cap_worst_tip: (p) => `跨窗口边界最坏可花 ≈ 2× = ${p.n} ${p.unit}（固定窗口，非滑动）。`,
    daily_window: "每日窗口(纪元数)",
    daily_window_hint: "每日上限所统计的滚动窗口长度,以链纪元为单位。",
    merchant_whitelist: "商户白名单",
    merchant_placeholder: "商户名称,例如 shop",
    add: "添加",
    merchant_wl_hint: "具名商户会在首次使用时于本地开发网创建。留空则表示允许任意商户收款。",
    open_on_chain: "在链上开通预算",
    create_trust_title: "虽是托管,但并非盲目信任。",
    create_trust_body:
      "后端通过 walletd 签名——但你在这里设定的各项上限和白名单,会被编译进预算的链上组件,由验证节点强制执行,而不是靠这个应用本身。",
    what_happens: "背后发生了什么",
    step_withdraw: "所有者从自己的账户中取出注资金额。",
    step_mint: "<code>AgentBudget</code> 模板铸造出预算组件,以及所有者/代理凭证。",
    step_store: "各项上限、窗口和白名单都写入链上。",
    step_pay: "代理从此可以付款——但只能在规则之内。",
    remove_tag: (p) => `移除 ${p.name}`,

    /* pay */
    pay_sub: "代理向白名单商户付款——每一笔都会在链上接受校验。",
    pay_nobudget_sub: "发起支付前,请先开通一个预算。",
    send_payment: "发起支付",
    agent_revoked_badge: "代理已停用",
    merchant_label: "商户",
    optgroup_wl: "白名单——代理可向这些商户付款",
    optgroup_other: "非白名单——链上将会拒绝",
    no_wl_option: "还没有白名单商户——请到「治理」页添加",
    address_suffix: "(地址)",
    pay_merchant_hint:
      "预算链上白名单里的每个商户都列在这里。挑一个不在白名单里的(例如 <code>scammer</code>),就能看到链上当场拒绝它。",
    pick_merchant_err: "请选择一个商户。",
    amount: "金额",
    amount_err: "请输入大于零的金额。",
    memo_label: "发票 / 备注",
    optional: "(选填)",
    memo_placeholder: "例如 invoice-042",
    check_on_chain: "链上预检",
    pay: "付款",
    pay_callout_title: "「链上预检」",
    pay_callout_body:
      "会做一次验证节点的试算:它向链询问这笔支付是否会被接受,若被拒则原样显示验证节点给出的理由——全程不提交任何交易。",
    activity: "动态",
    activity_sub: (p) => `${p.n} 笔支付 · 依据链上事件重建`,
    pay_no_payments_title: "还没有支付记录",
    pay_no_payments_body: "你发起的支付会显示在这里,数据回读自链上的 <code>pay</code> 事件。",
    th_merchant: "商户",
    th_amount: "金额",
    th_memo: "备注",
    th_time: "时间",
    th_source: "来源",
    via_manual: "人工",
    via_api: "API",
    via_chain: "链上",
    via_manual_tip: "通过本面板发起(所有者 / 网页端)。",
    via_api_tip: "通过集成 API 发起(Agent 密钥)。",
    via_chain_tip: "链上发现 —— 外部客户端(MCP / SDK / 其他面板)。",
    verdict_ok_title: "链上会接受这笔支付",
    verdict_ok_body: (p) =>
      `对向 <b>${p.merchant}</b> 支付 <b>${p.amount} ${p.unit}</b> 做验证节点试算,结果通过了全部链上规则。点「付款」即可真正提交。`,
    verdict_reject_title: "验证节点会拒绝这笔支付",
    verdict_reject_body: (p) =>
      `链上给出的理由:<code>${p.reason}</code><br/>这并不是界面在为难你——是链上预算本身拒绝了它,所以这笔支付无法被强行通过。`,
    verdict_paid_reject_title: "支付在链上被拒绝",
    verdict_paid_reject_body: (p) =>
      `理由:<code>${p.reason}</code><br/>验证节点强制执行了预算规则——没有花出任何一分钱。`,

    /* governance */
    gov_sub: "所有者的控制项。每项变更都会用所有者凭证签名并提交到链上。",
    gov_nobudget_sub: "请先开通一个预算再来管理。",
    danger_zone: "危险操作",
    wl_merchants: "白名单商户",
    no_wl_merchants: "尚未设置白名单——任意商户都可收款。",
    add_merchant_placeholder: "按名称添加商户",
    gov_wl_hint: "通过所有者凭证把商户加入链上白名单。",
    gov_wl_hint_revoked: "<b>代理虽已停用,但白名单仍可编辑。</b>",
    remove_merchant: "移出白名单",
    confirm_remove_merchant_title: (p) => `要把「${p.name}」移出白名单吗?`,
    confirm_remove_merchant_body:
      "将用所有者凭证签名并调用模板的链上 <code>remove_merchant</code>。交易确认后,代理就无法再向这个地址付款——验证节点会直接拒绝。以后可以再加回来。",
    confirm_remove_merchant_ok: "移除商户",
    limits_title: "支出限额",
    limits_hint:
      "用所有者凭证签名并调用链上 <code>set_limits</code>。新的单笔上限从下一笔付款起生效;每日上限作用于当前窗口(窗口内已计入的花费保留)。",
    limits_pertx_err: "单笔上限至少为 1。",
    limits_unchanged: "这已经是当前的限额了。",
    update_limits: "更新限额",
    treasury: "资金",
    treasury_hint: (p) => `可提现 · 已注资 ${p.funded},已花费 ${p.spent}`,
    topup_label: "充值(追加资金)",
    topup: "充值",
    topup_hint: (p) => `把 ${p.unit} 从所有者账户转入预算的链上金库。守护程序可按自己的节奏充值——链上没有定时器。`,
    withdraw_amount: "提现金额",
    withdraw_amount_err: "请输入不超过资金余额的金额。",
    withdraw_to_owner: "提现到所有者",
    agent_sessions: "代理会话",
    badge_count: (p) => `${p.n} 张凭证`,
    revoke: "停用",
    revoked: "已停用",
    session_default_sub: "随预算一同创建",
    session_issued_sub: "后发的会话凭证",
    new_session_placeholder: "新会话标签,例如 agent-2",
    issue_badge: "发放凭证",
    sessions_hint:
      "每个会话都是同一链上资源下的一张独立代理凭证。可以给每个代理/会话各发一张,单独停用其中任意一张而不影响其他。下方的<b>停用代理</b>则是对所有会话的一键停用开关。",
    kill_switch: "紧急停用开关",
    revoke_authority: "撤销代理的消费权限",
    revoke_authority_body:
      "拨动链上的紧急停用开关。此后每一笔支付都会被验证节点拒绝——即时生效,且不可撤销。所有者仍可提走金库里剩余的资金。",
    already_revoked: "已停用",
    revoke_agent: "停用代理",
    reset_demo: "重置演示(解除预算绑定)",

    /* no-budget generic */
    nobudget_open_title: "尚未开通预算",
    nobudget_open_body: "请先创建一个链上预算,再回到这里。",

    /* login */
    login_sub: "代理预算控制台",
    login_intro: "本控制台操作的是一个托管钱包。请登录后继续。",
    password: "密码",
    incorrect_password: "密码不正确。",
    enter_password: "请输入密码。",
    signin: "登录",
    signing_in: "正在登录…",

    /* connection problem */
    conn_problem: "连接出了问题",
    conn_cant_reach: "无法连接到钱包守护进程",
    retry: "重试",
    conn_hint_pre: "请确认本地 Tari swarm 正在运行,且 ",
    conn_hint_mid: " 可以在 ",
    conn_hint_url_fallback: "所配置的地址",

    /* confirm modal */
    cancel: "取消",
    confirm_reset_title: "要重置演示吗?",
    confirm_reset_body: "这只清空仪表盘的<b>本地视图</b>,方便你新建预算。链上不发生任何变化——预算组件、其金库以及剩余余额都原样保留;<b>不会</b>提现或退款。如需取回余额,请先执行「提现」。",
    confirm_reset_ok: "重置",
    confirm_revoke_title: "要停用这个代理吗?",
    confirm_revoke_body:
      "验证节点将拒绝该代理<b>此后的每一笔支付</b>。这会拨动链上的紧急停用开关,且<b>无法撤销</b>。",
    confirm_revoke_ack: "我明白这会永久封停该代理。",
    confirm_revoke_session_title: (p) => `要停用会话「${p.session}」吗?`,
    confirm_revoke_session_body:
      "验证节点将拒绝该代理会话<b>此后的每一笔支付</b>,其他会话照常运作。此操作无法撤销(但之后可以用相同标签再发一张新凭证)。",
    confirm_revoke_session_ack: "我明白这会在链上封停这个会话。",
    confirm_revoke_session_ok: "停用会话",
    confirm_withdraw_title: "要提现到所有者吗?",
    confirm_withdraw_body: (p) =>
      `把 <b>${p.amount} ${p.unit}</b> 从预算的链上金库退回到所有者账户。`,
    confirm_withdraw_ok: (p) => `提现 ${p.amount} ${p.unit}`,

    /* pending button labels */
    p_refreshing: "刷新中",
    p_connecting: "连接中",
    p_opening: "正在链上开通…",
    p_asking: "正在询问链上…",
    p_submitting: "提交中…",
    p_adding: "添加中…",
    p_removing: "移除中…",
    p_updating_limits: "更新中…",
    p_topping: "充值中…",
    p_issuing: "发放中…",
    p_withdrawing: "提现中…",
    p_revoking: "停用中",

    /* toasts */
    t_uptodate: "已是最新",
    t_uptodate_msg: "已从链上重新加载。",
    t_connected: "已连接",
    t_connected_msg: "钱包守护进程可以访问。",
    t_still_offline: "仍未连接",
    t_reset: "已重置",
    t_reset_msg: "已清空本地视图。原预算仍在链上——资金未被提现。",
    t_reset_failed: "重置失败",
    t_agent_revoked: "代理已停用",
    t_agent_revoked_msg: "紧急停用开关已打开。此后的支付都会在链上被拒绝。",
    t_revoke_failed: "停用失败",
    t_session_revoked: "会话已停用",
    t_session_revoked_msg: (p) => `「${p.session}」已无法再付款,其他会话不受影响。`,
    t_budget_opened: "预算已开通",
    t_budget_opened_msg: (p) => `已注资 ${p.amount} ${p.unit} · 已在链上生效。`,
    t_open_failed: "预算开通失败",
    t_dryrun_failed: "预检失败",
    t_payment_sent: "支付已发出",
    t_payment_sent_msg: (p) => `向 ${p.merchant} 支付 ${p.amount} ${p.unit}——已在链上确认。`,
    t_rejected_onchain: "链上已拒绝",
    t_payment_failed: "支付失败",
    t_merchant_wl: "商户已加入白名单",
    t_merchant_wl_msg: (p) => `${p.name} 现在可以收款了。`,
    t_merchant_failed: "商户添加失败",
    t_merchant_removed: "商户已移除",
    t_merchant_removed_msg: (p) => `${p.name} 已不在链上白名单中。`,
    t_merchant_remove_failed: "商户移除失败",
    t_limits_updated: "限额已更新",
    t_limits_updated_msg: (p) => `单笔 ${p.perTx} ${p.unit} · 每日 ${p.daily} ${p.unit}——已在链上生效。`,
    t_limits_failed: "限额更新失败",
    t_topped_up: "充值成功",
    t_topped_up_msg: (p) => `已向预算金库追加 ${p.amount} ${p.unit}。`,
    t_topup_failed: "充值失败",
    t_badge_issued: "会话凭证已发放",
    t_badge_issued_msg: (p) => `「${p.session}」现在可以在相同的链上规则内付款了。`,
    t_badge_failed: "凭证发放失败",
    t_withdrawn: "已提现",
    t_withdrawn_msg: (p) => `${p.amount} ${p.unit} 已退回给所有者。`,
    t_withdraw_failed: "提现失败",
    /* 已提交但结果未知(记为 pending):交易可能已经上链——绝不能说“已确认”,并提示用户不要重复提交
     * (重试会复用同一幂等键,服务端据此去重)。 */
    t_pending: "已提交——尚未确认",
    t_pending_pay_msg: (p) => `向 ${p.merchant} 支付 ${p.amount} ${p.unit} 已提交,但尚未确认。请勿重复提交——它可能已经上链,稍后会自动结算。`,
    t_pending_topup_msg: (p) => `充值 ${p.amount} ${p.unit} 已提交,但尚未确认。请勿重复提交——它可能已经上链。`,
    t_pending_open_msg: (p) => `开通预算(${p.amount} ${p.unit})已提交,但尚未确认。请勿重复提交——它可能已经上链。`,
    t_pending_withdraw_msg: (p) => `提现 ${p.amount} ${p.unit} 已提交,但尚未确认。请勿重复提交——它可能已经上链。`,

    /* step-up confirmation */
    stepup_title: "确认此操作",
    stepup_body:
      "这是高风险操作。请重新输入管理员密码以授权——这一第二因子独立于你的登录会话,因此即便会话被盗,也无法单凭它动用资金。",
    stepup_password_label: "管理员密码",
    stepup_confirm: "确认",

    /* emergency stop (dashboard-wide freeze) */
    emergency_stop: "紧急停机",
    freeze_title: "冻结仪表盘(全局停机开关)",
    freeze_body:
      "一次性阻断整个仪表盘上所有动用资金的操作——付款、充值、提现、新建预算,只读视图照常可用。若怀疑服务器或某个操作员账户已被攻陷,请使用它。它独立于单个预算的链上撤销,且可以恢复。",
    freeze_btn: "全部冻结",
    unfreeze_btn: "解除冻结",
    frozen_badge: "已冻结",
    confirm_freeze_title: "要冻结整个仪表盘吗?",
    confirm_freeze_body: "在你解除冻结之前,所有动用资金的操作都会被拒绝,只读视图仍可用。请将其作为紧急停机手段。",
    confirm_unfreeze_title: "要解除仪表盘冻结吗?",
    confirm_unfreeze_body: "动用资金的操作将被重新启用。请在确认安全之后再操作。",
    frozen_banner_title: "仪表盘已冻结——",
    frozen_banner_body: "紧急停机已启用,所有动用资金的操作都被阻断。请到「治理」页解除冻结。",
    p_freezing: "冻结中…",
    p_unfreezing: "解除中…",
    t_frozen: "仪表盘已冻结",
    t_frozen_msg: "所有动用资金的操作现已被阻断,只读视图仍可用。",
    t_unfrozen: "已解除冻结",
    t_unfrozen_msg: "动用资金的操作已重新启用。",
    t_freeze_failed: "冻结状态变更失败",

    dismiss: "关闭",
  },
};

/** Keep the document chrome (title, meta, boot text, <html lang>) in sync. */
function applyStaticI18n() {
  try {
    document.documentElement.setAttribute("lang", LANG === "zh" ? "zh-CN" : "en");
    document.title = t("meta_title");
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", tnc("meta_desc"));
    const bootP = document.querySelector(".boot p");
    if (bootP) bootP.textContent = t("boot_connecting");
  } catch {
    /* ignore */
  }
}

/* ---- feather-style icons -------------------------------------------------- */
const P = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  wallet:
    '<path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1"/><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2Z"/><circle cx="16.5" cy="12.5" r="1.1" fill="currentColor" stroke="none"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-3Z"/><path d="M9.2 12.3l2 2 3.6-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  store:
    '<path d="M4 9h16l-1-5H5L4 9Z"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 20v-5h6v5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  coins:
    '<ellipse cx="9" cy="6" rx="6" ry="2.6"/><path d="M3 6v5c0 1.4 2.7 2.6 6 2.6s6-1.2 6-2.6V6"/><path d="M15 11.3c2.9.2 6 1.3 6 2.7v5c0 1.4-2.7 2.6-6 2.6-1.4 0-2.7-.2-3.7-.6"/><path d="M3 13c0 1.4 2.7 2.6 6 2.6"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v4h-4"/>',
  trend: '<path d="M3 17l6-6 4 4 7-7"/><path d="M21 8v5h-5"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z"/><path d="M12 17v4"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-2.6-1.5L14.3 3h-3.6l-.3 2.1a7.6 7.6 0 0 0-2.6 1.5l-2-.8-1.8 3.1 1.7 1.3a7.6 7.6 0 0 0 0 3l-1.7 1.3 1.8 3.1 2-.8a7.6 7.6 0 0 0 2.6 1.5l.3 2.1h3.6l.3-2.1a7.6 7.6 0 0 0 2.6-1.5l2 .8 1.8-3.1-1.7-1.3Z"/>',
  receipt:
    '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2Z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
};
function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;
}

/* ---- address + avatar ----------------------------------------------------- */
function shorten(addr, head = 10, tail = 6) {
  if (!addr) return "—";
  const s = String(addr);
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}
const AV_COLORS = ["#6d54ff", "#1a9d63", "#b7791f", "#2563c9", "#d23b48", "#0d9488", "#db2777", "#7c3aed"];
function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function initials(name, addr) {
  if (name) return name.slice(0, 2).toUpperCase();
  return (addr || "?").replace("component_", "").slice(0, 2).toUpperCase();
}
function addrPill(addr, { lg = false } = {}) {
  const id = "a" + Math.random().toString(36).slice(2, 8);
  return `<span class="addr ${lg ? "addr--lg" : ""}">
    <span class="addr__text" title="${esc(addr)}">${esc(shorten(addr, lg ? 14 : 10, lg ? 8 : 6))}</span>
    <button class="icon-btn" data-copy="${esc(addr)}" id="${id}" aria-label="${esc(t("copy_full"))}" title="${esc(t("copy"))}">${icon("copy", 15)}</button>
  </span>`;
}

/* ---- state ---------------------------------------------------------------- */
const S = {
  view: "overview",
  data: null,
  // Wall-clock of the last successful state fetch — shown as "updated HH:MM:SS" on Overview so the
  // freshness of the displayed (cached) data is explicit. Not chain time; just when we last read.
  lastSync: Date.now(),
  booting: true,
  connError: null,
  authRequired: false,
  authed: true,
  // Whether high-risk actions need a step-up confirmation (set from /api/session; true iff auth on).
  stepUpRequired: false,
  // Non-custodial mode (set from /api/session): the backend refuses browser chain-writes; use the wallet.
  nonCustodial: false,
  // CSRF synchronizer token for this session (from /api/session or the login response). Echoed in the
  // X-CSRF-Token header on every POST so the cookie alone is not enough to drive a state change.
  csrf: null,
  // Non-custodial wallet link (window.tari / :7777). When connected, the budget the dashboard READS and
  // PAYS against is the WALLET's on-chain budget (chain-enforced), not the backend's custodial one. The
  // connect UI is wallet-connect.js; app.js only observes the link (tari#connect/#disconnect) and, when
  // linked, overlays the wallet's budget + routes pay over the relay. See the wallet transport below.
  wallet: { connected: false, account: null, error: null },
};

/* ---- API client ----------------------------------------------------------- */
async function api(path, body) {
  // Self-custody page (the merged one-page dApp): there is NO dashboard backend and NO custodial signer
  // here — every chain write goes through the connected in-page wallet (window.tari), approved and signed
  // in the browser. So the classic /api/* custodial path is retired: refuse it with a clear message rather
  // than fire a dead request. On the hosted :8787 dashboard __AP_WALLET_ONLY is unset, so nothing changes.
  if (typeof window !== "undefined" && window.__AP_WALLET_ONLY === true) {
    const e = new Error(t("wallet_only_no_backend"));
    e.status = 0; e.handled = true;
    throw e;
  }
  const headers = body ? { "Content-Type": "application/json" } : {};
  if (body && S.csrf) headers["X-CSRF-Token"] = S.csrf; // CSRF token on every state-changing call
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error(payload.error || `Request failed (${res.status})`);
    err.status = res.status;
    if (res.status === 401 && S.authRequired) {
      // session expired or missing — bounce to the login screen
      S.authed = false;
      renderLogin();
      err.handled = true;
    }
    throw err;
  }
  return payload;
}

/* ---- idempotency keys for no-token money ops ------------------------------
 * A money op that is NOT behind a single-use step-up token (pay, top-up) must carry a STABLE
 * idempotency key so a manual retry after an AMBIGUOUS failure (timeout, dropped connection, a
 * journaled "unknown") reuses the key and the server dedups it — instead of spending twice. The key
 * is bound to the op + its exact parameters and rotates only once an attempt FINISHES one way or the
 * other: an identical retry reuses it (dedup), while a deliberate identical repeat after success — or
 * the same op with edited inputs — gets a fresh key. Token-gated ops (open budget, withdraw, revoke,
 * add merchant, issue/revoke session, reset) don't need this; their single-use token blocks replay.
 *
 * The LIVE slot (one with an unresolved attempt) is mirrored to localStorage so it survives a page
 * RELOAD — the single most likely thing a user does to a tx that looks stuck — and is shared across
 * tabs. Without that the reload would drop the in-memory key, the retry would mint a fresh one, and the
 * server (which has no other dedup for pay/top-up) would submit a second real tx. A slot is cleared
 * from storage the moment its attempt resolves, so a later deliberate repeat still gets a fresh key.
 * All access is wrapped: a browser with storage disabled simply falls back to in-memory (reload-fragile
 * again, but no worse than before). The server's in-flight guard still backs up top-up regardless. */
const _IDEM_NS = "agentpay.idem.";
function _idemLoad(slot) {
  try { return window.localStorage.getItem(_IDEM_NS + slot) || undefined; } catch { return undefined; }
}
function _idemStore(slot, key) {
  try { window.localStorage.setItem(_IDEM_NS + slot, key); } catch { /* storage disabled: in-memory only */ }
}
function _idemClear(slot) {
  try { window.localStorage.removeItem(_IDEM_NS + slot); } catch { /* ignore */ }
}
const _idemSlots = Object.create(null);
function _rid() {
  return (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
function _idemRotate(slot) {
  delete _idemSlots[slot];
  _idemClear(slot);
}
async function idemPost(path, body, op, sig) {
  const slot = op + "|" + sig;
  // Reuse an in-memory key, else a persisted one from a prior page load, else mint a fresh one.
  if (!_idemSlots[slot]) _idemSlots[slot] = _idemLoad(slot) || op + ":" + _rid();
  _idemStore(slot, _idemSlots[slot]); // persist the live key so a reload can reuse it
  try {
    const r = await api(path, { ...body, idempotencyKey: _idemSlots[slot] });
    // A journaled "unknown" comes back HTTP 200 with {pending:true}: the tx MAY have landed. That is
    // the AMBIGUOUS case — keep the key so a manual retry reuses it and the server dedups, instead of
    // minting a fresh key and paying twice. Only a DEFINITIVE success rotates it. (Once the op resolves,
    // the next identical submit returns the server's cached result — not pending — and rotates here.) (N-3)
    if (!(r && r.pending === true)) _idemRotate(slot);
    return r;
  } catch (err) {
    // Definitive "it did not happen" statuses let the key rotate, so the user can fix the input and
    // resubmit without a stale-key conflict. A network throw or a 5xx is AMBIGUOUS — keep the key so
    // the retry carries it and the server collapses a duplicate.
    if (err && [400, 401, 403, 404, 409, 422].includes(err.status)) _idemRotate(slot);
    throw err;
  }
}

/* ---- toasts --------------------------------------------------------------- */
function toast(type, title, msg) {
  const host = el("toasts");
  const t2 = document.createElement("div");
  t2.className = `toast toast--${type}`;
  t2.setAttribute("role", "status");
  const ic = type === "success" ? "check" : type === "error" ? "alert" : "info";
  t2.innerHTML = `
    <span class="toast__icon">${icon(ic, 20)}</span>
    <div style="flex:1;min-width:0">
      <div class="toast__title">${esc(title)}</div>
      ${msg ? `<div class="toast__msg">${esc(msg)}</div>` : ""}
    </div>
    <button class="icon-btn toast__close" aria-label="${esc(t("dismiss"))}">${icon("x", 15)}</button>`;
  host.appendChild(t2);
  const close = () => {
    t2.classList.add("out");
    setTimeout(() => t2.remove(), 200);
  };
  $(".toast__close", t2).addEventListener("click", close);
  setTimeout(close, type === "error" ? 7000 : 4200);
}

/* ---- confirm modal -------------------------------------------------------- */
// `stepUp` (an operation name) turns the dialog into a step-up confirmation: it adds a password
// field and, on OK, exchanges the password for a short-lived, single-use confirm token via
// /api/confirm. It then resolves to `{ token }` (or `false` on cancel). Without `stepUp` it resolves
// to `true`/`false` as before, so existing call sites keep working.
function confirmDialog({ tone = "danger", icon: ic = "alert", title, body, confirmLabel, requireAck, stepUp = null, stepUpParams = null }) {
  return new Promise((resolve) => {
    const root = el("modal-root");
    const prevFocus = document.activeElement;
    root.innerHTML = `
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="m-title">
        <div class="modal">
          <div class="modal__icon modal__icon--${tone}">${icon(ic, 22)}</div>
          <h3 id="m-title">${esc(title)}</h3>
          <p>${body}</p>
          ${
            requireAck
              ? `<label class="confirm-box row" style="gap:10px;cursor:pointer;font-size:13.5px">
                   <input type="checkbox" id="m-ack" style="width:16px;height:16px;accent-color:var(--danger)"/>
                   <span>${esc(requireAck)}</span>
                 </label>`
              : ""
          }
          ${
            stepUp
              ? `<div class="field" style="margin-top:14px;margin-bottom:0">
                   <label class="field__label" for="m-pw">${icon("lock", 14)} ${esc(t("stepup_password_label"))}</label>
                   <input class="input" id="m-pw" type="password" autocomplete="off" placeholder="••••••••"/>
                   <div class="field__err" id="m-pw-err" style="display:none"></div>
                 </div>`
              : ""
          }
          <div class="modal__actions">
            <button class="btn btn--secondary" data-m="cancel">${esc(t("cancel"))}</button>
            <button class="btn btn--${tone}" data-m="ok" ${requireAck ? "disabled" : ""}>${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    const backdrop = $(".modal-backdrop", root);
    const okBtn = $('[data-m="ok"]', root);
    const ack = $("#m-ack", root);
    const pw = $("#m-pw", root);
    const pwErr = $("#m-pw-err", root);
    if (ack) ack.addEventListener("change", () => (okBtn.disabled = !ack.checked));
    const showPwErr = (msg) => {
      if (!pwErr) return;
      pwErr.textContent = msg;
      pwErr.style.display = "block";
    };
    const done = (val) => {
      root.innerHTML = "";
      document.removeEventListener("keydown", onKey);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(val);
    };
    const confirmOk = async () => {
      if (!stepUp) return done(true);
      const password = pw ? pw.value : "";
      if (!password) return showPwErr(t("enter_password"));
      okBtn.disabled = true;
      const orig = okBtn.innerHTML;
      okBtn.innerHTML = `<span class="spinner"></span><span>${esc(t("signing_in"))}</span>`;
      try {
        const res = await fetch("/api/confirm", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(S.csrf ? { "X-CSRF-Token": S.csrf } : {}),
          },
          // Send the funding parameters so the server binds the token to THIS action (same amount /
          // payee / caps / budget). The op call below must send the identical fields.
          body: JSON.stringify({ op: stepUp, password, ...(stepUpParams || {}) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showPwErr(data.error || t("incorrect_password"));
          okBtn.disabled = false;
          okBtn.innerHTML = orig;
          if (pw) pw.select();
          return;
        }
        done({ token: data.token });
      } catch (e) {
        showPwErr(t("incorrect_password"));
        okBtn.disabled = false;
        okBtn.innerHTML = orig;
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
      if (e.key === "Tab") {
        const f = root.querySelectorAll("button, input");
        const list = [...f].filter((x) => !x.disabled);
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) done(false);
    });
    $('[data-m="cancel"]', root).addEventListener("click", () => done(false));
    okBtn.addEventListener("click", confirmOk);
    if (pw)
      pw.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (!okBtn.disabled) confirmOk();
        }
      });
    document.addEventListener("keydown", onKey);
    (pw || ack || okBtn).focus();
  });
}

/**
 * Obtain a step-up confirm token for a high-risk op when the server requires one. Returns
 * `{ token }` to proceed (token is `undefined` when no step-up is needed), or `null` if cancelled.
 * Used for high-risk actions that don't already show their own confirm dialog.
 */
async function stepUpToken(op, stepUpParams = null) {
  if (!S.stepUpRequired) return { token: undefined };
  const res = await confirmDialog({
    tone: "danger",
    icon: "lock",
    title: t("stepup_title"),
    body: t("stepup_body"),
    confirmLabel: t("stepup_confirm"),
    stepUp: op,
    stepUpParams,
  });
  return res ? { token: res.token } : null;
}

/* ---- button pending state ------------------------------------------------- */
async function withPending(btn, label, fn) {
  if (!btn) return fn();
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span><span>${esc(label)}</span>`;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

/* ---- navigation ----------------------------------------------------------- */
const NAV = [
  { id: "start", key: "nav_start", icon: "zap" },
  { id: "overview", key: "nav_overview", icon: "grid" },
  { id: "manage", key: "nav_manage", icon: "shield" },
  { id: "pay", key: "nav_pay", icon: "send" },
  { id: "merchants", key: "nav_merchants", icon: "store" },
  { id: "connect", key: "nav_connect", icon: "plug" },
  { id: "receipts", key: "nav_receipts", icon: "receipt" },
  { id: "subscription", key: "nav_subscription", icon: "wallet" },
  { id: "settings", key: "nav_settings", icon: "settings" },
];

// On the merged self-custody page only (window.__AP_WALLET_ONLY, set by dapp-main before this module loads),
// the in-page wallet is a first-class nav entry like the rest — same format — at the top of the sidebar.
// Its view is just a mount point; dapp-main's wallet DOM (#apw2) is moved into it on render (see render()).
if (typeof window !== "undefined" && window.__AP_WALLET_ONLY) {
  NAV.unshift({ id: "wallet", key: "nav_wallet", icon: "lock" });
}

function go(view) {
  S.view = view;
  render();
  const m = $(".main");
  if (m) m.scrollTop = 0;
  window.scrollTo(0, 0);
}

/* ---- theme ---------------------------------------------------------------- */
function initTheme() {
  const saved = localStorage.getItem("agentpay-theme") || "auto";
  document.documentElement.setAttribute("data-theme", saved);
}
function setTheme(t2) {
  document.documentElement.setAttribute("data-theme", t2);
  try {
    localStorage.setItem("agentpay-theme", t2);
  } catch {
    /* private mode */
  }
  render();
}

/* ---- language toggle ------------------------------------------------------ */
function langToggle() {
  const btn = (l) =>
    `<button class="${LANG === l ? "is-active" : ""}" data-lang-set="${l}" lang="${l === "zh" ? "zh-CN" : "en"}" aria-pressed="${LANG === l}">${LANGS[l]}</button>`;
  return `<div class="theme-toggle lang-toggle" role="group" aria-label="${esc(t("lang_aria"))}">
    ${btn("zh")}${btn("en")}
  </div>`;
}
function wireLangToggle(root = el("app")) {
  if (!root) return;
  root.querySelectorAll("[data-lang-set]").forEach((btn) => {
    btn.addEventListener("click", () => setLang(btn.dataset.langSet));
  });
}

/* ---- shell ---------------------------------------------------------------- */
function sidebar() {
  const theme = localStorage.getItem("agentpay-theme") || "auto";
  const d = S.data;
  const connected = d && d.connected;
  const wlCount = d && d.budget ? d.budget.whitelist.length : 0;
  const navHtml = NAV.map((n) => {
    const count = n.id === "merchants" && wlCount ? `<span class="count">${wlCount}</span>` : "";
    return `<button class="nav__item ${S.view === n.id ? "is-active" : ""}" data-nav="${n.id}">
      ${icon(n.icon)}<span class="lbl">${esc(t(n.key))}</span>${count}</button>`;
  }).join("");
  const themeBtn = (val, ic, lbl) =>
    `<button class="${theme === val ? "is-active" : ""}" data-theme-set="${val}" aria-label="${esc(
      t("theme_aria", { name: lbl }),
    )}" title="${esc(lbl)}">${icon(ic, 15)}</button>`;
  return `<aside class="sidebar">
    <div class="brand">
      <div class="brand__mark">${icon("shield", 20)}</div>
      <div><div class="brand__name">AgentPay</div><div class="brand__sub">${esc(t("brand_sub"))}</div></div>
    </div>
    <nav class="nav" aria-label="${esc(t("theme_group"))}">${navHtml}</nav>
    <div class="sidebar__spacer"></div>
    <div class="sidebar__foot">
      <div class="conn">
        <span class="dot ${connected ? "dot--on" : "dot--off"}"></span>
        <span class="conn__txt">${connected ? esc(t("conn_online")) : esc(t("conn_offline"))}</span>
      </div>
      <div class="toggle-row">
        ${langToggle()}
        <div class="theme-toggle" role="group" aria-label="${esc(t("theme_group"))}">
          ${themeBtn("light", "sun", t("theme_light"))}${themeBtn("auto", "monitor", t("theme_system"))}${themeBtn("dark", "moon", t("theme_dark"))}
        </div>
      </div>
      ${
        d && d.config && d.config.walletdUrl
          ? `<div class="meta"><b>walletd</b> ${esc(shorten(d.config.walletdUrl.replace(/^https?:\/\//, ""), 22, 8))}<br/>
             <b>${esc(t("meta_template"))}</b> ${esc(shorten(d.config.template.replace("template_", ""), 8, 6))}<br/>
             <b>${esc(t("meta_owner"))}</b> ${esc(d.config.ownerAccount)}</div>`
          : ""
      }
      ${
        S.authRequired
          ? `<button class="btn btn--ghost btn--sm logout-btn" data-action="logout" aria-label="${esc(t("signout"))}">${icon("lock", 15)} ${esc(t("signout"))}</button>`
          : ""
      }
    </div>
  </aside>`;
}

function pageHead(title, sub, actions = "") {
  return `<header class="page-head">
    <div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ""}</div>
    ${actions ? `<div class="row">${actions}</div>` : ""}
  </header>`;
}

/* ---- views: SETTINGS ------------------------------------------------------ */
// Two defaults in one place: the dashboard's own interface language (client-side, remembered in this
// browser via setLang/localStorage) and the language of the payment-receipt image the MCP hands back
// to the agent (server-side in the store, read by the separate MCP process over /api/state).
function viewSettings() {
  const d = S.data || {};
  const cfg = d.config || {};
  const comp = d.budget ? d.budget.component : null;
  const rl = ["zh", "en", "both"].includes(d.receiptLang) ? d.receiptLang : "both";
  const opt = (val, label, cur) => `<option value="${val}"${val === cur ? " selected" : ""}>${esc(label)}</option>`;
  // Read-only config row — surfaces a real, server-set value; never an editable control that would
  // imply the UI can change wallet/network wiring (§3.7: don't bypass the backend).
  const infoRow = (label, value, copyable) =>
    `<div class="set-row">
      <div class="set-row__k">${esc(label)}</div>
      <div class="set-row__v">${
        copyable && value
          ? `<span class="addr"><span class="addr__text">${esc(value)}</span><button class="icon-btn" data-copy="${esc(value)}" aria-label="${esc(t("copy"))}">${icon("copy", 14)}</button></span>`
          : `<span>${esc(value || "—")}</span>`
      }</div>
    </div>`;

  return (
    pageHead(t("nav_settings"), t("settings_sub")) +
    `<div class="stack" style="max-width:720px">
      <div class="section-head"><h2>${esc(t("set_sec_general"))}</h2><p>${esc(t("set_sec_general_sub"))}</p></div>
      <div class="card"><div class="card__body">
        <div class="field">
          <label class="field__label" for="set-ui-lang">${esc(t("set_ui_lang"))}</label>
          <div class="select-wrap">
            <select class="select" id="set-ui-lang">${opt("zh", t("lang_zh"), LANG)}${opt("en", t("lang_en"), LANG)}</select>
          </div>
          <div class="field__hint">${esc(t("set_ui_lang_hint"))}</div>
        </div>
        <div class="field" style="margin-bottom:0">
          <label class="field__label" for="set-receipt-lang">${esc(t("set_receipt_lang"))}</label>
          <div class="select-wrap">
            <select class="select" id="set-receipt-lang">${opt("zh", t("lang_zh"), rl)}${opt("en", t("lang_en"), rl)}${opt("both", t("lang_both"), rl)}</select>
          </div>
          <div class="field__hint">${esc(t("set_receipt_lang_hint"))}</div>
        </div>
      </div></div>

      <div class="section-head"><h2>${esc(t("set_sec_wallet"))}</h2><p>${esc(t("set_sec_wallet_sub"))}</p></div>
      <div class="card"><div class="card__body">
        ${infoRow(t("set_owner"), cfg.ownerAccount, false)}
        ${infoRow(t("set_component"), comp || t("set_no_budget"), !!comp)}
      </div></div>

      <div class="section-head"><h2>${esc(t("set_sec_network"))}</h2><p>${esc(t("set_sec_network_sub"))}</p></div>
      <div class="card"><div class="card__body">
        ${infoRow(t("set_network"), cfg.network || "local", false)}
        ${infoRow(t("set_walletd"), cfg.walletdUrl, true)}
        ${infoRow(t("set_template"), cfg.template, true)}
        <div class="callout mt-18">${icon("info", 18)}<div>${esc(t("set_network_note"))}</div></div>
      </div></div>

      <div class="section-head"><h2>${esc(t("set_sec_security"))}</h2><p>${esc(t("set_sec_security_sub"))}</p></div>
      <div class="card"><div class="card__body">
        <div class="field" style="margin-bottom:0">
          <label class="field__label">${esc(t("set_pay_confirm"))}</label>
          <div class="field__hint" style="margin-top:0">${esc(t("set_pay_confirm_intro"))}</div>
          <label class="switch-row" style="margin-top:12px">
            <input type="checkbox" id="set-pay-required"${d.payConfirmRequired ? " checked" : ""}/>
            <span>${esc(t("set_pay_required"))}</span>
          </label>
          <div class="field__hint">${esc(t("set_pay_required_hint"))}</div>
          <div class="addrow" style="margin-top:12px">
            <input class="input" id="set-pay-pass" type="password" autocomplete="new-password"
                   placeholder="${esc(d.payPassphraseSet ? t("pay_pass_set_ph") : t("pay_pass_unset_ph"))}"/>
            <button type="button" class="btn btn--secondary" id="set-pay-save">${icon("shield", 15)} ${esc(t("pay_pass_save"))}</button>
          </div>
          <div class="field__hint" id="pay-pass-status">${esc(d.payPassphraseSet ? t("pay_pass_is_set") : t("pay_pass_not_set"))}</div>
        </div>
      </div></div>

      <div class="section-head"><h2>${esc(t("set_sec_about"))}</h2><p>${esc(t("set_sec_about_sub"))}</p></div>
      <div class="card"><div class="card__body">
        <div class="row" style="gap:12px;margin-bottom:12px">
          <div class="brand__mark" style="width:38px;height:38px">${icon("shield", 20)}</div>
          <div><div style="font-weight:700">AgentPay</div><div class="muted" style="font-size:13px">${esc(t("brand_sub"))}</div></div>
        </div>
        <p class="muted" style="font-size:13.5px;line-height:1.6;margin:0">${esc(tnc("about_body"))}</p>
      </div></div>
    </div>`
  );
}

/* ---- views: RECEIPTS ------------------------------------------------------ */
// The payment-receipt images the MCP rendered and uploaded. The list comes from /api/receipts
// (fetched in wireReceipts); each card previews the PNG and offers it for download.
let receiptsAll = [];
function viewReceipts() {
  return (
    pageHead(t("nav_receipts"), t("receipts_sub")) +
    `<div class="stack">
      <div class="grid grid--3" id="rcpt-stats"></div>
      <div class="card">
        <div class="card__head"><h3>${esc(t("receipts_title"))}</h3><span class="sub" id="rcpt-count"></span></div>
        <div class="card__body">
          <div class="input-affix" style="margin-bottom:14px">
            <input class="input" id="rcpt-search" placeholder="${esc(t("receipts_search"))}" autocomplete="off"/>
          </div>
          <div id="receipts-list" aria-busy="true"><div class="muted" style="padding:8px 2px">…</div></div>
        </div>
      </div>
    </div>`
  );
}

function receiptWhen(r) {
  const when = r.paid_at ? new Date(r.paid_at) : null;
  return when && !isNaN(when) ? when.toLocaleString() : r.paid_at || r.saved_at || "—";
}

/* One receipt as a table row (§3.6). Only fields the receipt actually carries are shown — no
   fabricated on-chain status or agent column. Clicking the row opens the detail drawer. */
function receiptRow(r) {
  const amount = r.amount != null ? fmt(String(r.amount)) : "—";
  return `<tr class="rcpt-tr" data-receipt-detail="${esc(String(r.id))}">
    <td><div class="merchant">
      <span class="rcpt-thumb-sm"><img src="${esc(r.url)}" alt="" loading="lazy"/></span>
      <div style="min-width:0"><div class="memo" style="font-weight:600">${esc(shorten(String(r.id), 8, 5))}</div></div>
    </div></td>
    <td>${esc(r.merchant || "—")}</td>
    <td class="amount">${amount} <span class="muted" style="font-weight:500">${esc(r.unit || UNIT)}</span></td>
    <td><span class="memo">${esc(shorten(String(r.payer || "—"), 8, 5))}</span></td>
    <td class="muted" style="font-size:12px;white-space:nowrap">${esc(receiptWhen(r))}</td>
    <td style="text-align:right"><button class="btn btn--ghost btn--sm" data-receipt-detail="${esc(String(r.id))}">${esc(t("view_detail"))}</button></td>
  </tr>`;
}

function openReceiptDrawer(id) {
  const r = receiptsAll.find((x) => String(x.id) === String(id));
  if (!r) return;
  const root = ensureDrawerRoot();
  const amount = r.amount != null ? fmt(String(r.amount)) : "—";
  const kv = (k, v, mono) =>
    `<div class="drawer__row"><div class="drawer__k">${esc(k)}</div><div class="drawer__v"${mono ? ' style="font-family:var(--mono);font-size:12.5px"' : ""}>${esc(v)}</div></div>`;
  root.innerHTML = `
    <div class="drawer-backdrop">
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(t("receipt_detail"))}">
        <div class="drawer__head">
          <div><div style="font-weight:700">${esc(t("receipt_detail"))}</div>
            <div class="muted" style="font-size:12px">${esc(amount)} ${esc(r.unit || UNIT)}</div></div>
          <button class="icon-btn drawer__close" aria-label="${esc(t("dismiss"))}">${icon("x", 18)}</button>
        </div>
        <div class="drawer__body">
          <a class="rcpt__thumb" href="${esc(r.url)}" target="_blank" rel="noopener" style="border:1px solid var(--border);border-radius:var(--radius);margin-bottom:14px"><img src="${esc(r.url)}" alt="" loading="lazy" style="width:100%;display:block;border-radius:var(--radius)"/></a>
          ${kv(t("receipt_id"), r.id || "—", true)}
          ${kv(t("receipt_to"), r.merchant || "—")}
          ${kv(t("receipt_from"), r.payer || "—", true)}
          ${kv(t("receipt_at"), receiptWhen(r))}
          <div class="callout mt-18">${icon("info", 18)}<div>${esc(t("receipt_detail_note"))}</div></div>
        </div>
        <div class="drawer__foot">
          <a class="btn btn--primary btn--block" href="${esc(r.url)}" download="receipt-${esc(String(r.id))}.png">${icon("download", 16)} ${esc(t("receipt_download"))}</a>
        </div>
      </aside>
    </div>`;
  const bd = $(".drawer-backdrop", root);
  if (bd) bd.addEventListener("click", (e) => { if (e.target === bd) closeDrawer(); });
  const cl = $(".drawer__close", root);
  if (cl) cl.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", _drawerKey);
}

async function wireReceipts() {
  const box = el("receipts-list");
  if (!box) return;
  const statsBox = el("rcpt-stats");
  const countEl = el("rcpt-count");
  const search = el("rcpt-search");
  const renderList = () => {
    const q = (search && search.value.trim().toLowerCase()) || "";
    const list = receiptsAll.filter(
      (r) => !q || [r.merchant, r.payer, r.id].some((v) => String(v || "").toLowerCase().includes(q)),
    );
    if (countEl) countEl.textContent = t("rcpt_showing", { n: list.length, total: receiptsAll.length });
    box.innerHTML = list.length
      ? `<div class="table-wrap"><table class="ledger ledger--receipts">
          <thead><tr><th>${esc(t("rcpt_th_receipt"))}</th><th>${esc(t("th_merchant"))}</th><th>${esc(t("th_amount"))}</th><th>${esc(t("rcpt_th_payer"))}</th><th>${esc(t("th_time"))}</th><th></th></tr></thead>
          <tbody>${list.map(receiptRow).join("")}</tbody></table></div>`
      : `<div class="empty" style="padding:40px"><div class="empty__icon">${icon("receipt", 26)}</div><p>${esc(receiptsAll.length ? t("rcpt_no_match") : t("receipts_empty"))}</p></div>`;
  };
  try {
    const r = await api("/api/receipts");
    receiptsAll = (r && r.receipts) || [];
    box.removeAttribute("aria-busy");
    const total = receiptsAll.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const latest = receiptsAll.map((x) => x.paid_at).filter(Boolean).sort().slice(-1)[0];
    const latestStr = latest ? (isNaN(new Date(latest)) ? latest : new Date(latest).toLocaleDateString()) : "—";
    if (statsBox)
      statsBox.innerHTML =
        subStat(t("rcpt_stat_count"), "receipt", "var(--brand)", fmt(String(receiptsAll.length)), "") +
        subStat(t("rcpt_stat_total"), "coins", "var(--success)", `${fmt(String(total))} <span class="unit">${UNIT}</span>`, "") +
        subStat(t("rcpt_stat_latest"), "clock", "var(--warn)", esc(latestStr), "");
    renderList();
    if (search) search.addEventListener("input", renderList);
    box.addEventListener("click", (e) => {
      const d = e.target.closest("[data-receipt-detail]");
      if (d) openReceiptDrawer(d.dataset.receiptDetail);
    });
  } catch (e) {
    box.removeAttribute("aria-busy");
    box.innerHTML = `<div class="banner">${icon("alert", 20)}<div class="banner__text"><b>${esc(t("receipts_load_failed"))}</b>${esc(e.message || "")}</div></div>`;
  }
}

/* ---- views: SUBSCRIPTION --------------------------------------------------- */
// This deployment's own AgentPay subscription, merged into the dashboard. The data comes from the
// SEPARATE billing service via the server-side proxy (/api/subscription) — billing meters usage only
// and never touches keys or funds. Fetched lazily in wireSubscription, like receipts.
function viewSubscription() {
  return (
    pageHead(t("nav_subscription"), t("sub_sub")) +
    `<div id="sub-root" aria-busy="true"><div class="muted" style="padding:8px 2px">…</div></div>`
  );
}

function subMoney(cents) {
  const n = Number(cents || 0) / 100;
  return "$" + n.toFixed(2);
}

function subStatusBadge(status) {
  const map = { active: "ok", trialing: "ok", open: "warn", past_due: "danger", canceled: "danger", unpaid: "danger", suspended: "danger", invoiced: "ok", closed: "ok" };
  const mod = map[status];
  return `<span class="badge${mod ? " badge--" + mod : " badge--muted"}">${esc(status || "—")}</span>`;
}

function subStat(label, icn, color, value, hint) {
  return `<div class="stat">
    <div class="stat__top">
      <span class="stat__icon" style="--c:${color}">${icon(icn, 17)}</span>
      <div class="stat__label">${esc(label)}</div>
    </div>
    <div class="stat__value">${value}</div>
    <div class="stat__hint">${hint || ""}</div>
  </div>`;
}

function subRender(d) {
  const plan = d.plan || {};
  const sub = d.subscription || {};
  const u = d.usage_summary || {};
  const planName = plan.name || (plan.code === "free" ? t("sub_free") : plan.code || t("sub_free"));
  const fee = plan.monthly_fee_cents ? `${subMoney(plan.monthly_fee_cents)}${t("sub_price_month")}` : t("sub_free");
  const maxSeats = u.maxActiveBudgets != null ? (u.maxActiveBudgets < 0 ? "∞" : u.maxActiveBudgets) : "—";
  const gmv = u.gmv != null ? fmt(String(u.gmv)) : "0";
  const renews = sub.current_period_end ? new Date(sub.current_period_end) : null;
  const renewsStr = renews && !isNaN(renews) ? renews.toLocaleDateString() : "";

  const cards = `<div class="grid grid--stats">
    ${subStat(t("sub_plan"), "wallet", "var(--brand)", `${esc(planName)} <span class="unit">${esc(fee)}</span>`, "")}
    ${subStat(t("sub_status"), "shield", "var(--success)", subStatusBadge(sub.status || "active"), renewsStr ? esc(`${t("sub_renews")} ${renewsStr}`) : "")}
    ${subStat(t("sub_seats"), "grid", "var(--brand)", `${esc(String(u.activeCount != null ? u.activeCount : 0))} <span class="unit">/ ${esc(String(maxSeats))}</span>`, "")}
    ${subStat(t("sub_volume"), "activity", "var(--brand)", esc(gmv), "")}
  </div>`;

  // Plan chooser — one pricing card per available plan; "Choose" starts a Stripe checkout (or applies
  // free). Every line is derived from the plan's own real fields (fee, seat cap, overage rates) — no
  // fabricated features. The current plan is highlighted and its button is the disabled "Current".
  // Order by monthly fee, but push custom/unlimited tiers (enterprise, uncapped seats) to the end.
  const planRank = (p) => (p.code === "enterprise" || (p.max_active_budgets != null && p.max_active_budgets < 0) ? Infinity : (p.monthly_fee_cents || 0));
  const plans = (d.plans || []).slice().sort((a, b) => planRank(a) - planRank(b));
  const curCode = sub.plan_code || plan.code || "free";
  const planFeats = (p) => {
    const li = (txt) => `<li>${icon("check", 15)}<span>${esc(txt)}</span></li>`;
    const out = [];
    const seats = p.max_active_budgets;
    out.push(li(seats != null && seats < 0 ? t("sub_feat_budgets_unlimited") : t("sub_feat_budgets", { n: seats != null ? seats : 0 })));
    if (Number(p.included_gmv || 0) > 0) out.push(li(t("sub_feat_included_gmv", { v: fmt(String(p.included_gmv)) })));
    if (p.gmv_overage_bps > 0) out.push(li(t("sub_feat_gmv_overage", { pct: p.gmv_overage_bps / 100 + "%" })));
    if (p.seat_overage_cents > 0) out.push(li(t("sub_feat_seat_overage", { price: subMoney(p.seat_overage_cents) })));
    return out.join("");
  };
  const planCards = plans.map((p) => {
    const cur = p.code === curCode;
    const isEnt = p.code === "enterprise";
    const priceBig = isEnt ? esc(t("sub_custom")) : (p.monthly_fee_cents ? esc(subMoney(p.monthly_fee_cents)) : esc(t("sub_free")));
    const per = !isEnt && p.monthly_fee_cents ? `<span class="per">${esc(t("sub_price_month"))}</span>` : "";
    return `<div class="price-card${cur ? " price-card--current" : ""}">
      <div class="price-card__head">
        <span class="price-card__name">${esc(p.name || p.code)}</span>
        ${cur ? `<span class="badge badge--ok">${esc(t("sub_current"))}</span>` : ""}
      </div>
      <div class="price-card__price">${priceBig} ${per}</div>
      <div class="price-card__cta">
        <button class="btn ${cur ? "btn--secondary" : "btn--primary"} btn--block" data-sub-choose="${esc(p.code)}"${cur ? " disabled" : ""}>
          ${cur ? esc(t("sub_current")) : esc(t("sub_choose"))}
        </button>
      </div>
      <ul class="price-feats">${planFeats(p)}</ul>
    </div>`;
  }).join("");

  // Invoices (immutable period snapshots from settlement), newest first.
  const invoices = (d.invoices || []).slice().reverse();
  const invRows = invoices.map((p) => {
    const start = p.period_start ? new Date(p.period_start) : null;
    const end = p.period_end ? new Date(p.period_end) : null;
    const period = start && !isNaN(start)
      ? `${start.toLocaleDateString()}${end && !isNaN(end) ? " – " + end.toLocaleDateString() : ""}`
      : esc(p.period_start || "—");
    return `<tr>
      <td>${esc(period)}</td>
      <td style="text-align:right">${subMoney(p.total_cents)}</td>
      <td>${subStatusBadge(p.status)}</td>
    </tr>`;
  }).join("");
  const invTable = invoices.length
    ? `<div class="table-wrap"><table class="ledger">
        <thead><tr><th>${esc(t("sub_inv_period"))}</th><th style="text-align:right">${esc(t("sub_inv_amount"))}</th><th>${esc(t("sub_inv_status"))}</th></tr></thead>
        <tbody>${invRows}</tbody>
      </table></div>`
    : `<div class="card"><div class="empty"><p>${esc(t("sub_invoices_empty"))}</p></div></div>`;

  const actions = `<button class="btn btn--secondary btn--sm" data-sub-portal>${icon("wallet", 15)} ${esc(t("sub_manage_billing"))}</button>`;

  return `<div class="stack">
    ${cards}
    <section>
      <div class="page-head"><div><h2 style="margin:0;font-size:1.05rem">${esc(t("sub_change_plan"))}</h2></div><div class="row">${actions}</div></div>
      <div class="price-grid">${planCards}</div>
    </section>
    <section>
      <h2 style="margin:0 0 12px;font-size:1.05rem">${esc(t("sub_invoices_title"))}</h2>
      ${invTable}
    </section>
  </div>`;
}

async function wireSubscription() {
  const box = el("sub-root");
  if (!box) return;
  const infoCard = (titleKey, bodyKey, ic) =>
    `<div class="card"><div class="empty"><div class="empty__icon">${icon(ic, 26)}</div><h3>${esc(t(titleKey))}</h3><p>${esc(t(bodyKey))}</p></div></div>`;
  try {
    const d = await api("/api/subscription");
    box.removeAttribute("aria-busy");
    if (!d || d.configured === false) { box.innerHTML = infoCard("sub_unconfigured_title", "sub_unconfigured_body", "wallet"); return; }
    if (d.ok === false) { box.innerHTML = infoCard("sub_unavailable_title", "sub_unavailable_body", "alert"); return; }
    box.innerHTML = subRender(d);
    box.querySelectorAll("[data-sub-choose]").forEach((b) => b.addEventListener("click", () => subChoose(b.dataset.subChoose)));
    const portal = box.querySelector("[data-sub-portal]");
    if (portal) portal.addEventListener("click", subPortal);
  } catch (e) {
    box.removeAttribute("aria-busy");
    box.innerHTML = `<div class="banner">${icon("alert", 20)}<div class="banner__text"><b>${esc(t("sub_unavailable_title"))}</b>${esc(e.message || "")}</div></div>`;
  }
}

async function subChoose(planCode) {
  try {
    const r = await api("/api/subscription/checkout", { planCode });
    if (r && r.checkout_url) { toast("info", t("sub_redirecting")); window.location.href = r.checkout_url; return; }
    // free downgrade (no redirect) — just refresh the panel
    toast("success", t("nav_subscription"));
    wireSubscription();
  } catch (e) {
    toast("error", t("sub_action_failed"), e.message || "");
  }
}

async function subPortal() {
  try {
    const r = await api("/api/subscription/portal");
    if (r && r.portal_url) { toast("info", t("sub_redirecting")); window.location.href = r.portal_url; return; }
    toast("error", t("sub_action_failed"));
  } catch (e) {
    toast("error", t("sub_action_failed"), e.message || "");
  }
}

/* ---- views: OVERVIEW ------------------------------------------------------ */
function viewOverview() {
  const d = S.data;
  const b = d.budget;
  if (!b) {
    return (
      pageHead(t("nav_overview"), t("overview_sub")) +
      `<div class="card"><div class="empty">
        <div class="empty__icon">${icon("wallet", 26)}</div>
        <h3>${esc(t("nobudget_title"))}</h3>
        <p>${esc(t("overview_empty_body"))}</p>
        <button class="btn btn--primary" data-nav="manage">${icon("plus", 16)} ${esc(t("create_budget"))}</button>
      </div></div>`
    );
  }
  const status = b.revoked
    ? `<span class="badge badge--danger">${icon("ban", 13)} ${esc(t("status_revoked"))}</span>`
    : `<span class="badge badge--ok">${icon("check", 13)} ${esc(t("status_active"))}</span>`;
  // The "daily cap" is enforced over a rolling window of chain epochs (≈30 min each), reset lazily
  // — not a calendar day. `b.window` is the live, human-readable view of that (null if the chain
  // read failed; fall back to the lifetime `spent` so the card still renders).
  const w = b.window;
  const winSpent = w ? w.spentInWindow : b.spent;
  const winCap = w ? w.dailyCap : b.dailyCap;
  const winRemaining = w
    ? w.remaining
    : (() => { const r = amtBig(b.dailyCap) - amtBig(b.spent); return (r < 0n ? 0n : r).toString(); })();
  const dailyPct = amtBig(winCap) > 0n ? Math.min(100, (Number(winSpent) / Number(winCap)) * 100) : 0;
  const dailyClass = dailyPct >= 100 ? "danger" : dailyPct >= 75 ? "warn" : "ok";
  const epochTip = w
    ? t("epoch_tip", {
        n: w.epochsPerWindow,
        min: w.epochMinutes,
        total: formatApprox(w.epochsPerWindow * w.epochMinutes),
      })
    : "";
  // The daily cap is a fixed-window rate guard — spend can reach ~2× across a boundary. Surface the
  // worst case on the badge tooltip so the owner doesn't have to work it out (see agent_budget/lib.rs).
  const dailyCapTip = [epochTip, t("daily_cap_worst_tip", { n: fmt((amtBig(b.dailyCap) * 2n).toString()), unit: UNIT })]
    .filter(Boolean)
    .join(" · ");
  const resetNote = w
    ? w.windowElapsed
      ? t("reset_elapsed", { n: w.epochsPerWindow })
      : t("reset_active", {
          left: fmt(winRemaining),
          unit: UNIT,
          eta: resetEta(w),
          n: w.epochsUntilReset,
        })
    : "";

  // Active agents: sessions that can still spend (a fully-revoked budget has none). Real data from the
  // on-chain budget's session set — the default session counts when nothing else has been issued.
  const sessions = b.sessions && b.sessions.length ? b.sessions : [{ session: "default", revoked: b.revoked }];
  const activeAgents = b.revoked ? 0 : sessions.filter((s) => !s.revoked).length;

  // Secondary stats (§3.1): spend, transaction count, active agents, whitelisted payees. The treasury
  // balance is promoted to the hero headline below, so it is not repeated as a tile here.
  const stats = [
    { label: t("stat_spent_window"), icon: "trend", color: "var(--info)", value: fmt(winSpent), unit: true, hint: w ? t("stat_spent_hint_window", { cap: fmt(winCap), left: fmt(winRemaining) }) : t("stat_spent_hint_daily", { cap: fmt(b.dailyCap) }), nav: "pay" },
    { label: t("stat_tx"), icon: "activity", color: "var(--success)", value: fmt(b.ledger.length), unit: false, hint: t("stat_tx_hint") },
    { label: t("stat_active"), icon: "shield", color: "var(--brand)", value: fmt(activeAgents), unit: false, hint: t("stat_active_hint"), nav: "manage" },
    { label: t("stat_whitelisted"), icon: "store", color: "var(--warn)", value: fmt(b.whitelist.length), unit: false, hint: t("stat_whitelisted_hint"), nav: "merchants" },
  ]
    .map(
      (s) => `<div class="stat${s.nav ? " stat--link" : ""}"${s.nav ? ` data-nav="${s.nav}" role="button" tabindex="0" title="${esc(t("stat_go", { page: t("nav_" + s.nav) }))}"` : ""}>
        <div class="stat__top">
          <span class="stat__icon" style="--c:${s.color}">${icon(s.icon, 17)}</span>
          <div class="stat__label">${esc(s.label)}</div>
        </div>
        <div class="stat__value">${s.value} <span class="unit">${s.unit ? UNIT : ""}</span></div>
        <div class="stat__hint">${esc(s.hint)}</div>
      </div>`,
    )
    .join("");

  const meter = (label, used, max, suffix, cls) => {
    const pct = Number(max) > 0 ? Math.min(100, (Number(used) / Number(max)) * 100) : 0;
    return `<div>
      <div class="meter__row"><span class="lbl">${esc(label)}</span>
        <span class="val">${fmt(used)} <span class="max">/ ${fmt(max)} ${suffix}</span></span></div>
      <div class="meter"><div class="meter__fill meter__fill--${cls}" style="width:${pct}%"></div></div>
    </div>`;
  };

  const recent = b.ledger
    .slice(-4)
    .reverse()
    .map((e) => fullLedgerRow(e))
    .join("");

  return (
    pageHead(
      t("nav_overview"),
      t("overview_sub"),
      `<button class="btn btn--secondary btn--sm" data-action="refresh">${icon("refresh", 15)} ${esc(t("refresh"))}</button>
       <button class="btn btn--primary btn--sm" data-nav="pay">${icon("send", 15)} ${esc(t("new_payment"))}</button>`,
    ) +
    `<div class="stack">
      <div class="grid grid--stats">${stats}</div>

      <div class="hero">
        <div class="hero__top">
          <div>
            <div class="hero__title">${esc(t("hero_balance_label"))}</div>
            <div class="hero__balance">${fmt(b.treasury)} <span class="unit">${UNIT}</span></div>
            <div class="hero__addr">${addrPill(b.component, { lg: true })}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
            ${status}
            <span class="sync-meta"><span class="dot ${d.connected ? "dot--on" : "dot--off"}"></span>${esc(d.connected ? t("onchain_live") : t("onchain_offline"))}</span>
          </div>
        </div>
        <div class="hero__meters">
          <div>
            ${meter(t("meter_window"), winSpent, winCap, UNIT, dailyClass)}
            ${resetNote ? `<div class="meter__note">${icon("clock", 12)} ${esc(resetNote)}</div>` : ""}
          </div>
          ${meter(t("meter_treasury"), b.treasury, b.funded, UNIT, "ok")}
        </div>
        <div class="hero__caps">
          <span class="badge badge--muted">${icon("zap", 13)} ${esc(t("cap_pertx", { n: fmt(b.perTxCap), unit: UNIT }))}</span>
          <span class="badge badge--muted" title="${esc(dailyCapTip)}">${icon("clock", 13)} ${esc(t("cap_daily", { n: fmt(b.dailyCap), unit: UNIT }))}${w ? esc(t("cap_daily_window", { n: w.epochsPerWindow })) : ""}</span>
          <span class="badge badge--muted">${icon("store", 13)} ${esc(t("cap_whitelist", { n: fmt(b.whitelist.length) }))}</span>
          <span class="badge badge--muted">${icon("lock", 13)} ${esc(t("cap_validator"))}</span>
        </div>
        ${
          w
            ? `<div class="hero__epochnote" title="${esc(epochTip)}">${icon("info", 14)}
                 <span>${t("hero_epoch_note", {
                   n: w.epochsPerWindow,
                   min: w.epochMinutes,
                   total: formatApprox(w.epochsPerWindow * w.epochMinutes),
                 })}</span>
               </div>`
            : ""
        }
      </div>

      <div class="card">
        <div class="card__head"><h3>${esc(t("recent_activity"))}</h3>
          <div class="row">
            <span class="sync-meta"><span class="dot ${d.connected ? "dot--on" : "dot--off"}"></span>${esc(t("last_synced", { t: fmtClock(S.lastSync) || "—" }))}</span>
            <button class="btn btn--ghost btn--sm" data-action="refresh">${icon("refresh", 14)} ${esc(t("refresh"))}</button>
            <button class="btn btn--ghost btn--sm" data-nav="pay">${esc(t("view_all"))} ${icon("send", 14)}</button>
          </div></div>
        <div class="card__body" style="padding:8px 0 4px">
          ${
            recent
              ? `<div class="table-wrap"><table class="ledger">
                  <thead><tr><th>${esc(t("th_merchant"))}</th><th>${esc(t("th_amount"))}</th><th>${esc(t("th_memo"))}</th><th>${esc(t("th_source"))} / ${esc(t("th_time"))}</th></tr></thead>
                  <tbody>${recent}</tbody></table></div>`
              : `<div class="empty" style="padding:30px"><p class="muted">${esc(t("overview_no_payments"))}</p></div>`
          }
        </div>
      </div>
    </div>`
  );
}

// Format an epoch-ms timestamp as a full local "YYYY-MM-DD HH:MM:SS" ("—" when unknown).
function fmtTs(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// Split the full timestamp into its date ("YYYY-MM-DD") and clock ("HH:MM:SS") halves.
function fmtDate(ts) { const s = fmtTs(ts); return s === "—" ? "—" : s.split(" ")[0]; }
function fmtClock(ts) { const s = fmtTs(ts); return s === "—" ? "" : s.split(" ")[1]; }

// A small tag showing how a pay was initiated: 人工 (dashboard/owner), API (integration key),
// or 链上 (external client — MCP/SDK/another dashboard — found on chain, not journaled here).
function viaBadge(via) {
  const mod = via === "api" ? "badge--ok" : via === "chain" ? "badge--warn" : "badge--muted";
  const label = via === "api" ? t("via_api") : via === "chain" ? t("via_chain") : t("via_manual");
  const tip = via === "api" ? t("via_api_tip") : via === "chain" ? t("via_chain_tip") : t("via_manual_tip");
  return `<span class="badge badge--src ${mod}" title="${esc(tip)}">${esc(label)}</span>`;
}

/* ---- views: CREATE -------------------------------------------------------- */
let draftWhitelist = ["shop"];
function viewCreate() {
  const d = S.data;
  if (d.budget) {
    return (
      pageHead(t("nav_create"), t("create_have_sub")) +
      `<div class="card"><div class="empty">
        <div class="empty__icon">${icon("check", 26)}</div>
        <h3>${esc(t("create_have_title"))}</h3>
        <p>${esc(t("create_have_body"))}</p>
        <div class="row"><button class="btn btn--primary" data-nav="overview">${esc(t("go_overview"))}</button>
        <button class="btn btn--secondary" data-action="reset">${esc(t("reset_start_over"))}</button></div>
      </div></div>`
    );
  }
  return (
    pageHead(t("nav_create"), t("create_sub")) +
    `<div class="grid grid--2" style="align-items:start">
      <div class="card">
        <div class="card__head"><h3>${esc(t("budget_params"))}</h3></div>
        <div class="card__body">
          <form id="create-form" novalidate>
            <div class="field">
              <label class="field__label" for="f-fund">${esc(t("fund_amount"))}</label>
              <div class="input-affix">
                <input class="input" id="f-fund" type="number" min="1" value="10000" inputmode="numeric"/>
                <span class="affix">${UNIT}</span>
              </div>
              <div class="field__hint">${esc(t("fund_hint"))}</div>
              <div class="field__err">${esc(t("fund_err"))}</div>
            </div>
            <div class="form-grid">
              <div class="field">
                <label class="field__label" for="f-pertx">${esc(t("pertx_cap"))}</label>
                <div class="input-affix"><input class="input" id="f-pertx" type="number" min="1" value="1000"/><span class="affix">${UNIT}</span></div>
                <div class="field__err">${esc(t("required"))}</div>
              </div>
              <div class="field">
                <label class="field__label" for="f-daily">${esc(t("daily_cap"))}</label>
                <div class="input-affix"><input class="input" id="f-daily" type="number" min="1" value="1500"/><span class="affix">${UNIT}</span></div>
                <div class="field__err">${esc(t("daily_cap_err"))}</div>
              </div>
            </div>
            <div class="field">
              <label class="field__label" for="f-epochs">${esc(t("daily_window"))}</label>
              <input class="input" id="f-epochs" type="number" min="1" value="10"/>
              <div class="field__hint">${esc(t("daily_window_hint"))}</div>
            </div>
            <div class="field">
              <label class="field__label">${esc(t("merchant_whitelist"))}</label>
              <div class="addrow">
                <input class="input" id="f-merchant" placeholder="${esc(t("merchant_placeholder"))}" autocomplete="off"/>
                <button type="button" class="btn btn--secondary" id="f-add">${icon("plus", 16)} ${esc(t("add"))}</button>
              </div>
              <div class="field__hint">${esc(t("merchant_wl_hint"))}</div>
              <div class="tag-list" id="f-tags"></div>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn btn--primary" id="f-submit">${icon("wallet", 16)} ${esc(t("open_on_chain"))}</button>
            </div>
          </form>
        </div>
      </div>
      <div class="stack">
        <div class="card"><div class="card__body">
          <div class="callout">${icon("lock", 18)}
            <div><b>${esc(tnc("create_trust_title"))}</b> ${esc(tnc("create_trust_body"))}</div>
          </div>
        </div></div>
        <div class="card">
          <div class="card__head"><h3>${esc(t("what_happens"))}</h3></div>
          <div class="card__body">
            <ol class="muted" style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.9">
              <li>${t("step_withdraw")}</li>
              <li>${t("step_mint")}</li>
              <li>${t("step_store")}</li>
              <li>${t("step_pay")}</li>
            </ol>
          </div>
        </div>
      </div>
    </div>`
  );
}

function renderTags() {
  const host = el("f-tags");
  if (!host) return;
  host.innerHTML = draftWhitelist
    .map(
      (m, i) =>
        `<span class="tag"><span class="chip__dot" style="width:7px;height:7px;border-radius:50%;background:${avatarColor(m)}"></span>${esc(m)}
          <button type="button" data-rmtag="${i}" aria-label="${esc(t("remove_tag", { name: m }))}">${icon("x", 13)}</button></span>`,
    )
    .join("");
}

/* ---- views: PAY ----------------------------------------------------------- */
let lastVerdict = null;

/* Live, client-side pre-check shown beside the Pay form (§3.3). An ESTIMATE only — the on-chain
   dry-run (/api/dry-run) and the validator stay authoritative, status semantics are never softened
   (submitted ≠ confirmed), and nothing here moves funds or writes state. */
function payRiskHtml(b, merchantVal, amount) {
  const w = b.window;
  const winRemaining = w
    ? w.remaining
    : (() => { const r = amtBig(b.dailyCap) - amtBig(b.spent); return (r < 0n ? 0n : r).toString(); })();
  const found = merchantVal ? b.whitelist.find((m) => (m.name || m.address) === merchantVal) : null;
  const other = !found && merchantVal ? (S.data.merchants || []).find((m) => m.name === merchantVal) : null;
  const payeeName = found ? found.name || t("merchant_fallback") : other ? other.name : merchantVal || "—";
  const payeeAddr = found ? found.address : other ? other.address : "";
  const has = amount !== null && amtBig(amount) > 0n;

  const row = (label, state, detail) => {
    const ic = state === "ok" ? icon("check", 14) : state === "bad" ? icon("ban", 14) : icon("minus", 14);
    return `<div class="risk-item risk-item--${state}"><span class="risk-item__ic">${ic}</span>
      <div><div class="risk-item__label">${esc(label)}</div>${detail ? `<div class="risk-item__detail">${detail}</div>` : ""}</div></div>`;
  };

  const wlState = !merchantVal ? "idle" : found ? "ok" : "bad";
  const wlDetail = !merchantVal ? esc(t("risk_awaiting")) : found ? esc(t("risk_wl_ok")) : esc(t("risk_wl_bad"));
  const perTxState = !has ? "idle" : amtBig(amount) <= amtBig(b.perTxCap) ? "ok" : "bad";
  const winState = !has ? "idle" : amtBig(amount) <= amtBig(winRemaining) ? "ok" : "bad";

  return `
    <div class="preview-head">
      <div class="preview-amt">${has ? fmt(amount) : "—"} <span class="unit">${UNIT}</span></div>
      <div class="preview-payee">${icon("store", 14)} <span>${esc(payeeName)}</span>${payeeAddr ? ` <code>${esc(shorten(payeeAddr, 8, 5))}</code>` : ""}</div>
    </div>
    <div class="risk-list">
      ${row(t("risk_whitelist"), wlState, wlDetail)}
      ${row(t("risk_pertx"), perTxState, esc(t("risk_pertx_detail", { cap: fmt(b.perTxCap), unit: UNIT })))}
      ${row(t("risk_window"), winState, esc(t("risk_window_detail", { left: fmt(winRemaining), unit: UNIT })))}
      ${row(t("risk_authority"), "ok", esc(t("risk_authority_detail")))}
      ${row(t("risk_confirm"), "idle", esc(t("risk_confirm_detail")))}
    </div>`;
}

function viewPay() {
  const d = S.data;
  const b = d.budget;
  if (!b) return noBudget(t("nav_pay"), t("pay_nobudget_sub"));
  // The merchant picker is driven by the budget's CURRENT on-chain whitelist (known names, or a
  // truncated address when the label is unknown) — so every whitelisted merchant is selectable and
  // the list stays in sync after one is added in Governance. Other known accounts are offered in a
  // separate group so the "watch the chain reject a non-whitelisted payee" demo still works.
  const wlAddrs = new Set(b.whitelist.map((m) => m.address));
  const wlOptions = b.whitelist
    .map(
      (m) =>
        `<option value="${esc(m.name || m.address)}">${m.name ? esc(m.name) : esc(shorten(m.address, 10, 6)) + " " + t("address_suffix")}</option>`,
    )
    .join("");
  const otherOptions = d.merchants
    .filter((m) => !wlAddrs.has(m.address))
    .map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`)
    .join("");
  const initialMerchant = b.whitelist.length ? b.whitelist[0].name || b.whitelist[0].address : "";

  return (
    pageHead(t("nav_pay"), t("pay_sub")) +
    `<div class="grid grid--2">
      <div class="card">
        <div class="card__head"><h3>${esc(t("send_payment"))}</h3>
          ${b.revoked ? `<span class="badge badge--danger">${icon("ban", 13)} ${esc(t("agent_revoked_badge"))}</span>` : ""}</div>
        <div class="card__body">
          <form id="pay-form" novalidate>
            <div class="field">
              <label class="field__label" for="p-merchant">${esc(t("merchant_label"))}</label>
              <div class="select-wrap">
                <select class="select" id="p-merchant">
                  ${
                    b.whitelist.length
                      ? `<optgroup label="${esc(t("optgroup_wl"))}">${wlOptions}</optgroup>`
                      : `<option value="" disabled selected>${esc(t("no_wl_option"))}</option>`
                  }
                  ${otherOptions ? `<optgroup label="${esc(t("optgroup_other"))}">${otherOptions}</optgroup>` : ""}
                </select>
              </div>
              <div class="field__hint">${t("pay_merchant_hint")}</div>
              <div class="field__err">${esc(t("pick_merchant_err"))}</div>
            </div>
            <div class="field">
              <label class="field__label" for="p-amount">${esc(t("amount"))}</label>
              <div class="input-affix"><input class="input" id="p-amount" type="number" min="1" placeholder="0" autocomplete="off"/><span class="affix">${UNIT}</span></div>
              <div class="field__err">${esc(t("amount_err"))}</div>
            </div>
            <div class="field">
              <label class="field__label" for="p-memo">${esc(t("memo_label"))} <span class="muted" style="font-weight:400">${esc(t("optional"))}</span></label>
              <input class="input" id="p-memo" placeholder="${esc(t("memo_placeholder"))}" autocomplete="off"/>
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn--secondary" id="p-check">${icon("shield", 16)} ${esc(t("check_on_chain"))}</button>
              <button type="submit" class="btn btn--primary" id="p-pay" ${b.revoked ? "disabled" : ""}>${icon("send", 16)} ${esc(t("pay"))}</button>
            </div>
          </form>
          <div class="callout mt-18">${icon("info", 18)}
            <div><b>${esc(t("pay_callout_title"))}</b>${esc(t("pay_callout_body"))}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card__head"><h3>${esc(t("pay_preview"))}</h3><span class="sub">${esc(t("pay_preview_sub"))}</span></div>
        <div class="card__body">
          <div id="pay-preview">${payRiskHtml(b, initialMerchant, null)}</div>
          <div id="verdict-slot"></div>
          <div class="callout callout--warn mt-18">${icon("shield", 18)}
            <div><b>${esc(t("pay_preview_note_title"))}</b> ${esc(t("pay_preview_note_body"))}</div>
          </div>
        </div>
      </div>
    </div>`
  );
}
function fullLedgerRow(e) {
  const name = e.merchantName;
  return `<tr>
    <td><div class="merchant">
      <span class="avatar" style="background:${avatarColor(name || e.merchant)}">${initials(name, e.merchant)}</span>
      <div><div style="font-weight:600">${name ? esc(name) : esc(t("merchant_fallback"))}</div>
      <div class="muted" style="font-size:12px;font-family:var(--mono)">${esc(shorten(e.merchant, 8, 5))}</div></div>
    </div></td>
    <td class="amount">−${fmt(e.amount)} <span class="muted" style="font-weight:500">${UNIT}</span></td>
    <td><span class="memo" title="${esc(e.onchainMemo || e.memo)}">${esc(e.memo || "—")}</span></td>
    <td><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
      ${viaBadge(e.via)}
      <div class="muted" style="font-size:12px;font-family:var(--mono);line-height:1.35">
        <div style="white-space:nowrap">${esc(fmtClock(e.ts))}</div>
        <div style="white-space:nowrap">${esc(fmtDate(e.ts))}</div>
      </div></div></td>
  </tr>`;
}

/* Agent sessions card: one badge per agent/session, each revocable on its own. */
function sessionsCard(b) {
  const sessions = b.sessions && b.sessions.length ? b.sessions : [{ session: "default", revoked: false }];
  const rows = sessions
    .map((s) => {
      const revoked = s.revoked;
      const status = revoked
        ? `<span class="badge badge--danger">${icon("ban", 13)} ${esc(t("revoked"))}</span>`
        : `<span class="badge badge--ok">${icon("check", 13)} ${esc(t("status_active"))}</span>`;
      const action = revoked
        ? `<button class="btn btn--ghost btn--sm" disabled>${esc(t("revoked"))}</button>`
        : `<button class="btn btn--danger btn--sm" data-revoke-session="${esc(s.session)}">${icon("ban", 14)} ${esc(t("revoke"))}</button>`;
      return `<tr>
        <td><div class="merchant">
          <span class="avatar" style="background:${avatarColor(s.session)}">${initials(s.session, s.session)}</span>
          <div><div style="font-weight:600">${esc(s.session)}</div>
          <div class="muted" style="font-size:12px">${s.session === "default" ? esc(t("session_default_sub")) : esc(t("session_issued_sub"))}</div></div>
        </div></td>
        <td>${status}</td>
        <td style="text-align:right">${action}</td>
      </tr>`;
    })
    .join("");
  return `<div class="card">
    <div class="card__head"><h3>${esc(t("agent_sessions"))}</h3><span class="sub">${esc(t("badge_count", { n: sessions.length }))}</span></div>
    <div class="card__body">
      <div class="table-wrap"><table class="ledger"><tbody>${rows}</tbody></table></div>
      <form id="session-form" class="addrow mt-18" novalidate>
        <input class="input" id="g-session" placeholder="${esc(t("new_session_placeholder"))}" autocomplete="off" maxlength="48"/>
        <button type="submit" class="btn btn--primary" id="g-session-add">${icon("plus", 16)} ${esc(t("issue_badge"))}</button>
      </form>
      <div class="field__hint mt-12">${t("sessions_hint")}</div>
    </div>
  </div>`;
}

/* ---- views: MANAGE -------------------------------------------------------- */
/* "创建预算" and the owner controls live under one nav item: with no budget this is
   the open-a-budget form; once a budget exists it is the owner's control panel —
   funds, spending limits, agent sessions, and the danger zone. The merchant
   whitelist moved to its own "商户" page. Layout mirrors the balanced governance
   grid: the tall treasury card fills the left column, limits + sessions stack on
   the right, so the two columns top-align and read as a balanced pair. */
function viewManage() {
  const d = S.data;
  const b = d.budget;
  if (!b) return viewCreate();

  return (
    pageHead(t("nav_manage"), t("manage_sub")) +
    `<div class="stack">
      <div class="section-head"><h2>${esc(t("sec_policy"))}</h2><p>${esc(t("sec_policy_sub"))}</p></div>
      <div class="card">
        <div class="card__head"><h3>${esc(t("limits_title"))}</h3></div>
        <div class="card__body">
          <form id="limits-form" novalidate>
            <div class="form-grid">
              <div class="field">
                <label class="field__label" for="g-pertx">${esc(t("pertx_cap"))}</label>
                <div class="input-affix"><input class="input" id="g-pertx" type="number" min="1" value="${esc(String(b.perTxCap))}"/><span class="affix">${UNIT}</span></div>
                <div class="field__err">${esc(t("limits_pertx_err"))}</div>
              </div>
              <div class="field">
                <label class="field__label" for="g-daily">${esc(t("daily_cap"))}</label>
                <div class="input-affix"><input class="input" id="g-daily" type="number" min="1" value="${esc(String(b.dailyCap))}"/><span class="affix">${UNIT}</span></div>
                <div class="field__err">${esc(t("daily_cap_err"))}</div>
                <div class="field__hint" id="daily-worst">${t("daily_cap_worst", { n: fmt((amtBig(b.dailyCap) * 2n).toString()), unit: UNIT })}</div>
              </div>
            </div>
            <button type="submit" class="btn btn--primary btn--block" id="g-limits">${icon("zap", 16)} ${esc(t("update_limits"))}</button>
          </form>
          <div class="field__hint mt-12">${t("limits_hint")}</div>
          <div class="row row--wrap mt-12" style="justify-content:space-between">
            <span class="field__hint" style="margin:0">${esc(t("window_rule", { n: b.window ? b.window.epochsPerWindow : "—" }))}</span>
            <button type="button" class="btn btn--ghost btn--sm" data-nav="merchants">${icon("store", 14)} ${esc(t("merchant_limits_link"))}</button>
          </div>
        </div>
      </div>
      <div class="section-head"><h2>${esc(t("treasury"))}</h2><p>${esc(t("sec_treasury_sub"))}</p></div>
      <div class="card">
        <div class="card__head"><h3>${esc(t("treasury"))}</h3></div>
        <div class="card__body">
          <div class="stat__value" style="margin:0">${fmt(b.treasury)} <span class="unit">${UNIT}</span></div>
          <div class="stat__hint">${esc(t("treasury_hint", { funded: fmt(b.funded), spent: fmt(b.spent) }))}</div>
          <div class="field__hint mt-12" style="display:flex;align-items:flex-start;gap:7px">${icon("info", 13)}<span>${esc(t("treasury_onchain_note"))}</span></div>
          <div class="form-grid mt-18">
            <form id="topup-form" novalidate>
              <div class="field" style="margin-bottom:0">
                <label class="field__label" for="g-topup">${esc(t("topup_label"))}</label>
                <div class="addrow">
                  <div class="input-affix" style="flex:1"><input class="input" id="g-topup" type="number" min="1" value="5000"/><span class="affix">${UNIT}</span></div>
                  <button type="submit" class="btn btn--primary" id="g-topup-btn">${icon("plus", 16)} ${esc(t("topup"))}</button>
                </div>
                <div class="field__hint">${esc(t("topup_hint", { unit: UNIT }))}</div>
                <div class="field__err">${esc(t("amount_err"))}</div>
              </div>
            </form>
            <form id="wd-form" novalidate>
              <div class="field" style="margin-bottom:0">
                <label class="field__label" for="g-amount">${esc(t("withdraw_amount"))}</label>
                <div class="addrow">
                  <div class="input-affix" style="flex:1"><input class="input" id="g-amount" type="number" min="1" max="${b.treasury}" value="${b.treasury}"/><span class="affix">${UNIT}</span></div>
                  <button type="submit" class="btn btn--secondary" id="g-withdraw" ${amtBig(b.treasury) <= 0n ? "disabled" : ""}>${icon("up", 16)} ${esc(t("withdraw_to_owner"))}</button>
                </div>
                <div class="field__err">${esc(t("withdraw_amount_err"))}</div>
              </div>
            </form>
          </div>
        </div>
      </div>
      <div class="section-head"><h2>${esc(t("agent_sessions"))}</h2><p>${esc(t("sec_sessions_sub"))}</p></div>
      ${sessionsCard(b)}

      <div class="section-head"><h2>${esc(t("sec_security"))}</h2><p>${esc(t("sec_security_sub"))}</p></div>
      <div class="danger-zone">
        <div class="danger-zone__head">${icon("ban", 14)} ${esc(t("danger_zone"))}</div>
        <div class="danger-row">
          <div class="danger-row__text">
            <h4>${icon("ban", 15)} ${esc(t("revoke_authority"))}
              ${b.revoked ? `<span class="badge badge--danger">${esc(t("revoked"))}</span>` : `<span class="badge badge--ok">${esc(t("status_active"))}</span>`}</h4>
            <p>${esc(t("revoke_authority_body"))}</p>
          </div>
          <button class="btn btn--danger" id="g-revoke" data-action="revoke" ${b.revoked ? "disabled" : ""}>${icon("ban", 16)} ${b.revoked ? esc(t("already_revoked")) : esc(t("revoke_agent"))}</button>
        </div>
        <div class="danger-row">
          <div class="danger-row__text">
            <h4>${icon("lock", 15)} ${esc(t("freeze_title"))}
              ${d.frozen ? `<span class="badge badge--danger">${esc(t("frozen_badge"))}</span>` : `<span class="badge badge--ok">${esc(t("status_active"))}</span>`}</h4>
            <p>${esc(t("freeze_body"))}</p>
          </div>
          ${
            d.frozen
              ? `<button class="btn btn--primary" data-action="unfreeze">${icon("check", 16)} ${esc(t("unfreeze_btn"))}</button>`
              : `<button class="btn btn--danger" data-action="freeze">${icon("ban", 16)} ${esc(t("freeze_btn"))}</button>`
          }
        </div>
      </div>

      <div class="row" style="justify-content:flex-end">
        <button class="btn btn--ghost btn--sm" data-action="reset">${esc(t("reset_demo"))}</button>
      </div>
    </div>`
  );
}

/* ---- views: MERCHANTS ----------------------------------------------------- */
/* The on-chain payee whitelist, split out of governance into its own section. */
function viewMerchants() {
  const d = S.data;
  const b = d.budget;
  if (!b) return noBudget(t("nav_merchants"), t("merchants_nobudget_sub"));
  const rows = b.whitelist.length
    ? b.whitelist
        .map(
          (m) => `<div class="merch-row merch-row--link" data-merchant-detail="${esc(m.address)}" role="button" tabindex="0" title="${esc(t("view_detail"))}">
            <span class="chip__dot" style="background:${avatarColor(m.name || m.address)}"></span>
            ${m.name ? `<b class="merch-row__name">${esc(m.name)}</b>` : ""}<code class="merch-row__addr">${esc(shorten(m.address, 10, 6))}</code>
            <span class="badge badge--ok merch-row__st" style="margin-left:auto">${icon("check", 12)} ${esc(t("merchant_status_active"))}</span>
            <button type="button" class="chip__rm merch-row__rm" data-remove-merchant="${esc(m.address)}" data-merchant-name="${esc(m.name || "")}" title="${esc(t("remove_merchant"))}" aria-label="${esc(t("remove_merchant"))}">${icon("x", 12)}</button>
          </div>`,
        )
        .join("")
    : `<div class="merch-empty muted">${esc(t("no_wl_merchants"))}</div>`;

  const mstat = (label, ic, c, val) =>
    `<div class="stat"><div class="stat__top"><span class="stat__icon" style="--c:${c}">${icon(ic, 17)}</span><div class="stat__label">${esc(label)}</div></div><div class="stat__value">${val}</div></div>`;

  return (
    pageHead(t("nav_merchants"), t("merchants_sub")) +
    `<div class="stack">
      <div class="grid grid--3">
        ${mstat(t("m_stat_total"), "store", "var(--brand)", fmt(b.whitelist.length))}
        ${mstat(t("m_stat_enabled"), "check", "var(--success)", fmt(b.whitelist.length))}
        ${mstat(t("m_stat_pending"), "clock", "var(--warn)", "0")}
      </div>
      <div class="card">
        <div class="card__head"><h3>${esc(t("wl_merchants"))}</h3><span class="sub">${fmt(b.whitelist.length)}</span></div>
        <div class="card__body">
          <form id="merch-form" class="addrow" novalidate>
            <input class="input" id="g-merchant" placeholder="${esc(t("add_merchant_placeholder"))}" autocomplete="off"/>
            <button type="submit" class="btn btn--primary" id="g-add">${icon("plus", 16)} ${esc(t("add"))}</button>
          </form>
          <div class="field__hint mt-12">${esc(t("gov_wl_hint"))}${b.revoked ? t("gov_wl_hint_revoked") : ""}</div>
          <div class="merch-list mt-16">${rows}</div>
        </div>
      </div>
      <div class="callout">${icon("info", 18)}
        <div>${t("overview_callout")}</div>
      </div>
    </div>`
  );
}

/** A dashboard-wide banner shown while the emergency stop (freeze) is engaged. */
function frozenBanner() {
  if (!(S.data && S.data.frozen)) return "";
  return `<div class="banner banner--danger" role="alert" style="border-color:color-mix(in srgb, var(--danger) 45%, var(--border))">
    ${icon("ban", 20)}
    <div class="banner__text"><b>${esc(t("frozen_banner_title"))}</b>${esc(t("frozen_banner_body"))}</div>
    <button class="btn btn--secondary btn--sm" data-nav="manage">${esc(t("manage"))}</button>
  </div>`;
}

// Non-custodial banner: on every view, say plainly when the dashboard's budget + payments are coming
// from the connected wallet (and warn if that wallet is linked but unreachable). Bilingual inline to
// avoid widening the I18N table for a Phase-1 status strip.
function walletBanner() {
  const zh = (document.documentElement.lang || "zh").toLowerCase().indexOf("en") !== 0;
  if (!S.wallet.connected) {
    // In non-custodial mode the backend refuses browser chain-writes, so prompt to connect the wallet.
    if (S.nonCustodial) {
      return `<div class="banner banner--warn" role="status">${icon("wallet", 20)}
        <div class="banner__text"><b>${esc(zh ? "非托管模式 " : "Non-custodial mode ")}</b>${esc(
          zh ? "在本页『钱包』里解锁并连接你的 AgentPay 钱包来管理这个预算 —— 链上写操作都经钱包批准,后端不再代签。"
             : "Unlock and connect your AgentPay wallet in the “Wallet” view to manage this budget — on-chain writes go through the wallet; the backend no longer co-signs.",
        )}</div></div>`;
    }
    return "";
  }
  if (S.wallet.error) {
    return `<div class="banner banner--danger" role="alert">${icon("alert", 20)}
      <div class="banner__text"><b>${esc(zh ? "钱包未连上 " : "Wallet unreachable ")}</b>${esc(
        zh ? "在本页『钱包』里解锁你的 AgentPay 钱包并保持解锁;此刻显示的是后端缓存视图。"
           : "Unlock your AgentPay wallet in the “Wallet” view and keep it unlocked; showing the backend view meanwhile.",
      )}</div></div>`;
  }
  const wb = S.data && S.data._walletBacked;
  const comp = wb && wb.component;
  const acct = (wb && wb.account) || S.wallet.account;
  const tail = (comp ? " · " + shorten(comp, 12, 6) : "") + (acct ? " · " + shorten(acct, 10, 6) : "");
  return `<div class="banner" role="status">${icon("wallet", 20)}
    <div class="banner__text"><b>${esc(zh ? "非托管 · 由你的钱包担保" : "Non-custodial · backed by your wallet")}</b>${esc(
      (zh ? "预算与支付来自你的钱包" : "Budget & payments come from your wallet") + tail,
    )}</div></div>`;
}

function noBudget(title, sub) {
  return (
    pageHead(title, sub) +
    `<div class="card"><div class="empty">
      <div class="empty__icon">${icon("wallet", 26)}</div>
      <h3>${esc(t("nobudget_open_title"))}</h3>
      <p>${esc(t("nobudget_open_body"))}</p>
      <button class="btn btn--primary" data-nav="manage">${icon("plus", 16)} ${esc(t("create_budget"))}</button>
    </div></div>`
  );
}

/* ---- login screen --------------------------------------------------------- */
function renderLogin() {
  const app = el("app");
  app.removeAttribute("aria-busy");
  app.className = "auth";
  app.innerHTML = `
    <div class="auth__card">
      <div class="auth__top">${langToggle()}</div>
      <div class="auth__brand">
        <div class="brand__mark">${icon("shield", 22)}</div>
        <div><h1>AgentPay</h1><div class="auth__sub">${esc(t("login_sub"))}</div></div>
      </div>
      <p class="muted" style="font-size:13.5px">${esc(tnc("login_intro"))}</p>
      <form id="login-form" novalidate>
        <div class="field" style="margin:0">
          <label class="field__label" for="login-pw">${esc(t("password"))}</label>
          <input class="input" id="login-pw" type="password" autocomplete="current-password" placeholder="••••••••" autofocus/>
          <div class="field__err" id="login-err">${esc(t("incorrect_password"))}</div>
        </div>
        <button type="submit" class="btn btn--primary btn--block mt-18" id="login-submit">${icon("lock", 16)} ${esc(t("signin"))}</button>
      </form>
    </div>`;
  wireLangToggle();
  const form = el("login-form");
  const errSlot = el("login-err");
  const field = el("login-pw").closest(".field");
  const showErr = (msg) => {
    errSlot.textContent = msg;
    field.classList.add("has-error");
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    field.classList.remove("has-error");
    const password = el("login-pw").value;
    if (!password) return showErr(t("enter_password"));
    await withPending(el("login-submit"), t("signing_in"), async () => {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        S.authed = true;
        try {
          S.csrf = (await res.json()).csrfToken || null; // use the token immediately
        } catch {
          /* boot() re-fetches /api/session which also returns it */
        }
        boot(); // re-enter: connect + render the dashboard
        return;
      }
      let msg = t("incorrect_password");
      try {
        msg = (await res.json()).error || msg;
      } catch {
        /* ignore */
      }
      showErr(msg);
      el("login-pw").select();
    });
  });
}

/* ---- render --------------------------------------------------------------- */
function render() {
  const app = el("app");
  app.removeAttribute("aria-busy");
  // The merged page's in-page wallet (#apw2) lives OUTSIDE #app so that rebuilding app.innerHTML below can
  // never destroy it (and its bound handlers / unlocked state). Park it on <body> before the rebuild; if the
  // active view is the wallet, it is moved into the view's mount point after wire() (below). On the hosted
  // dashboard there is no #apw2, so this is a no-op.
  const _apw = typeof document !== "undefined" ? document.getElementById("apw2") : null;
  if (_apw && _apw.parentNode !== document.body) document.body.appendChild(_apw);
  // Amounts are base units (µT) regardless of the token's whole-unit ticker, so UNIT stays "µT"
  // (see its declaration). `config.tokenSymbol` names the whole token but must NOT relabel the
  // base-unit amounts — doing that was the 1e6 unit mismatch this fixes.

  if (S.connError && !S.data) {
    app.className = "app";
    app.innerHTML =
      sidebar() +
      `<main class="main">${pageHead(t("conn_problem"), "")}
        <div class="banner">${icon("alert", 20)}
          <div class="banner__text"><b>${esc(t("conn_cant_reach"))}</b>${esc(S.connError)}</div>
          <button class="btn btn--secondary btn--sm" data-action="reconnect">${icon("refresh", 15)} ${esc(t("retry"))}</button>
        </div>
        <div class="callout">${icon("info", 18)}<div>${esc(t("conn_hint_pre"))}<code>walletd</code>${esc(t("conn_hint_mid"))}<code>${esc(
          S.data ? S.data.config.walletdUrl : t("conn_hint_url_fallback"),
        )}</code>.</div></div>
      </main>`;
    wire();
    return;
  }

  app.className = "app";
  let body;
  switch (S.view) {
    case "manage":
      body = viewManage();
      break;
    case "pay":
      body = viewPay();
      break;
    case "merchants":
      body = viewMerchants();
      break;
    case "start":
      body = viewStart();
      break;
    case "connect":
      body = viewConnect();
      break;
    case "settings":
      body = viewSettings();
      break;
    case "receipts":
      body = viewReceipts();
      break;
    case "subscription":
      body = viewSubscription();
      break;
    case "wallet":
      // the in-page self-custody wallet UI (#apw2) is moved into this mount after wire()
      body = `${pageHead(t("nav_wallet"), t("wallet_view_sub"))}<div id="apw2-mount" class="wallet-mount"></div>`;
      break;
    default:
      body = viewOverview();
  }
  app.innerHTML = sidebar() + `<main class="main">${frozenBanner()}${walletBanner()}${body}</main>`;
  wire();
  if (S.view === "wallet" && _apw) {
    const m = document.getElementById("apw2-mount");
    if (m) m.appendChild(_apw);
  }
}

/* ---- views: GET STARTED --------------------------------------------------- */
// A first-run guide for someone who has never used the console. The customer first picks a MODE
// (custodial / non-custodial) and the steps branch to the REAL flow for that mode — custodial status
// is read live from the already-loaded /api/state; non-custodial lets the customer request an agent
// badge minted into THEIR OWN account (an owner-signed, step-up-gated op) and hands back the config
// to put in their own walletd. No fabricated flow.
function startMode() {
  try {
    return localStorage.getItem("agentpay-mode") === "noncustodial" ? "noncustodial" : "custodial";
  } catch {
    return "custodial";
  }
}
let ncProvisioned = null; // {account,label} of the last badge issued in this tab, to re-show the handoff

function startStep(n, done, title, bodyTxt, statusHtml, extraHtml) {
  return `
    <li class="start-step${done ? " start-step--done" : ""}">
      <div class="start-step__num">${done ? icon("check", 16) : n}</div>
      <div class="start-step__main">
        <div class="start-step__title">${esc(title)}</div>
        <p class="start-step__body">${esc(bodyTxt)}</p>
        ${statusHtml ? `<div class="start-step__status">${statusHtml}</div>` : ""}
        ${extraHtml || ""}
      </div>
    </li>`;
}
const startChip = (mod, ic, txt) => `<span class="badge badge--${mod}">${icon(ic, 13)} ${esc(txt)}</span>`;

// The env the customer pastes into THEIR OWN walletd after a badge is issued to their account. Built
// from real config + the account/label they provisioned; the walletd URL + least-privilege token are
// theirs to fill. Never grants Admin.
function ncEnvBlock(account, label) {
  const d = S.data || {};
  const cfg = d.config || {};
  const b = d.budget || null;
  const comp = (b && b.component) || "component_…";
  const net = cfg.network || "local";
  const lines = [
    "AGENTPAY_COMPONENT=" + comp,
    "AGENTPAY_AGENT_ACCOUNT=" + account,
    "AGENTPAY_WALLETD_URL=" + t("nc_env_walletd_ph"),
    "AGENTPAY_WALLETD_PERMISSIONS=TransactionSend,TransactionGet",
  ];
  if (net !== "local") {
    lines.push("AGENTPAY_NETWORK=" + net);
    if (cfg.template) lines.push("AGENTPAY_BUDGET_TEMPLATE=" + cfg.template);
  }
  const text = lines.join("\n");
  return `
    <div class="start-step__status"><span class="badge badge--ok">${icon("check", 13)} ${esc(t("nc_issued_ok", { acct: shorten(account, 10, 6) }))}</span></div>
    <div class="codeblock mt-12">
      <div class="codeblock__head">
        <span class="codeblock__label">.env · ${esc(label)}</span>
        <button class="icon-btn" data-copy="${esc(text)}" title="${esc(t("copy"))}">${icon("copy", 15)}</button>
      </div>
      <pre class="codeblock__body"><code>${esc(text)}</code></pre>
    </div>
    <p class="start-step__body" style="margin-top:8px">${esc(t("nc_env_note"))}</p>`;
}

function startCustodialSteps() {
  const d = S.data || {};
  const cfg = d.config || {};
  const b = d.budget || null;
  const api = d.api || {};
  const connected = !!d.connected;
  const wl = b && Array.isArray(b.whitelist) ? b.whitelist.length : 0;
  const keys = (api.agentKeys || []).length;
  const sessions = b && Array.isArray(b.sessions) ? b.sessions.filter((s) => !s.revoked).length : 0;
  const connectedAgents = keys || sessions;
  const net = cfg.network || "local";
  const owner = cfg.ownerAccount || "—";
  const nav = (navTo, ic, label, variant) => `<div class="start-step__cta row row--wrap"><button class="btn btn--${variant || "primary"} btn--sm" data-nav="${navTo}">${icon(ic, 15)} ${esc(label)}</button>`;

  const s1 = startStep(1, true, t("start_s1_t"), t("start_s1_b"), startChip("ok", "check", t("start_s1_done")), "");
  const s2status = connected
    ? startChip("ok", "plug", t("start_chain_on", { net })) + startChip("muted", "wallet", t("start_owner", { acct: owner }))
    : startChip("warn", "plug", t("start_chain_off"));
  const s2 = startStep(2, connected, t("start_s2_t"), t("start_s2_b"), s2status, "");
  const s3status = connectedAgents
    ? startChip("ok", "check", t("start_connected_n", { n: connectedAgents }))
    : startChip("muted", "lock", t("start_not_connected"));
  const s3 = startStep(3, !!connectedAgents, t("start_s3_t"), t("start_s3_b"), s3status,
    `<div class="start-step__cta row row--wrap"><button class="btn btn--primary btn--sm" data-nav="connect">${icon("plug", 15)} ${esc(t("start_cta_connect"))}</button></div>`);
  const s4status = wl > 0 ? startChip("ok", "check", t("start_wl_n", { n: wl })) : startChip("muted", "store", t("start_wl_none"));
  const s4 = startStep(4, wl > 0, t("start_s4_t"), t("start_s4_b"), s4status,
    `<div class="start-step__cta row row--wrap"><button class="btn btn--primary btn--sm" data-nav="manage">${icon("shield", 15)} ${esc(t("start_cta_manage"))}</button><button class="btn btn--secondary btn--sm" data-nav="merchants">${icon("store", 15)} ${esc(t("start_cta_merchants"))}</button></div>`);
  const s5 = startStep(5, false, t("start_s5_t"), t("start_s5_b"), "",
    `<div class="start-step__cta row row--wrap"><button class="btn btn--primary btn--sm" data-nav="pay">${icon("send", 15)} ${esc(t("start_cta_pay"))}</button><button class="btn btn--secondary btn--sm" data-nav="receipts">${icon("receipt", 15)} ${esc(t("start_cta_receipts"))}</button></div>`);
  return s1 + s2 + s3 + s4 + s5;
}

function startNonCustodialSteps() {
  const s1 = startStep(1, true, t("start_s1_t"), t("start_s1_b"), startChip("ok", "check", t("start_s1_done")), "");
  const s2 = startStep(2, false, t("nc_s2_t"), t("nc_s2_b"), startChip("muted", "lock", t("nc_s2_env")), "");
  // Step 3 — provisioning form: enter YOUR agent account + a session label; the owner (operator) mints
  // an agent badge into that account after the step-up confirmation. The handoff appears in step 4.
  const provForm = `
    <div class="start-prov">
      <div class="field"><label class="field__label" for="nc-account">${esc(t("nc_account_label"))}</label>
        <input class="input" id="nc-account" placeholder="${esc(t("nc_account_ph"))}" autocomplete="off"/>
        <div class="field__err" id="nc-account-err">${esc(t("nc_account_err"))}</div></div>
      <div class="field"><label class="field__label" for="nc-label">${esc(t("nc_label_label"))}</label>
        <input class="input" id="nc-label" placeholder="${esc(t("nc_label_ph"))}" autocomplete="off" maxlength="48"/>
        <div class="field__err" id="nc-label-err">${esc(t("nc_label_err"))}</div></div>
      <button class="btn btn--primary btn--sm" id="nc-issue">${icon("shield", 15)} ${esc(t("nc_issue_btn"))}</button>
      <p class="start-step__body" style="margin-top:8px">${esc(t("nc_issue_hint"))}</p>
    </div>`;
  const s3 = startStep(3, false, t("nc_s3_t"), t("nc_s3_b"), "", provForm);
  const s4 = startStep(4, false, t("nc_s4_t"), t("nc_s4_b"), "", `<div id="nc-env"><p class="start-step__body muted">${esc(t("nc_s4_pre"))}</p></div>`);
  const s5 = startStep(5, false, t("nc_s5_t"), t("nc_s5_b"), startChip("muted", "shield", t("nc_revoke_note")), "");
  return s1 + s2 + s3 + s4 + s5;
}

// Non-custodial OWNER onboarding (single-mode): the owner connects their :7777 AgentPay wallet; the
// dashboard then reads the budget from it and routes every owner action through it for approval. No
// custodial/self-hosted-agent mode toggle here — this is the whole flow when S.nonCustodial is on.
function startNonCustodialOwnerSteps() {
  const d = S.data || {};
  const b = d.budget || null;
  const connected = !!(S.wallet && S.wallet.connected);
  const acct = (S.wallet && S.wallet.account) || null;
  const wl = b && Array.isArray(b.whitelist) ? b.whitelist.length : 0;
  const hasBudget = connected && !!(b && b.component);

  const s1status = connected
    ? startChip("ok", "wallet", t("nco_connected", { acct: acct ? shorten(acct, 8, 5) : "—" }))
    : startChip("warn", "plug", t("nco_not_connected"));
  const s1extra = connected
    ? ""
    : `<div class="start-step__cta row row--wrap"><button class="btn btn--primary btn--sm" id="nco-connect">${icon("plug", 15)} ${esc(t("nco_connect_cta"))}</button></div><p class="start-step__body muted" style="margin-top:8px">${esc(t("nco_connect_hint"))}</p>`;
  const s1 = startStep(1, connected, t("nco_s1_t"), t("nco_s1_b"), s1status, s1extra);

  const s2status = hasBudget
    ? startChip("ok", "check", t("nco_budget_ready"))
    : startChip("muted", "lock", t("nco_budget_wait"));
  const s2 = startStep(2, hasBudget, t("nco_s2_t"), t("nco_s2_b"), s2status, "");

  const s3status = wl > 0 ? startChip("ok", "check", t("start_wl_n", { n: wl })) : startChip("muted", "store", t("start_wl_none"));
  const s3 = startStep(3, wl > 0, t("nco_s3_t"), t("nco_s3_b"), s3status,
    `<div class="start-step__cta row row--wrap"><button class="btn btn--primary btn--sm" data-nav="manage">${icon("shield", 15)} ${esc(t("start_cta_manage"))}</button><button class="btn btn--secondary btn--sm" data-nav="merchants">${icon("store", 15)} ${esc(t("start_cta_merchants"))}</button></div>`);

  const s4 = startStep(4, false, t("nco_s4_t"), t("nco_s4_b"), "",
    `<div class="start-step__cta row row--wrap"><button class="btn btn--primary btn--sm" data-nav="pay">${icon("send", 15)} ${esc(t("start_cta_pay"))}</button><button class="btn btn--secondary btn--sm" data-nav="receipts">${icon("receipt", 15)} ${esc(t("start_cta_receipts"))}</button></div>`);
  return s1 + s2 + s3 + s4;
}

function viewStart() {
  // Non-custodial single-mode: no custodial/self-hosted toggle — one flow, centered on the wallet.
  if (S.nonCustodial) {
    return (
      pageHead(t("nav_start"), t("start_sub_nc")) +
      `<div class="callout">${icon("info", 18)}<div>${esc(t("nco_note"))}</div></div>` +
      `<div class="card"><div class="card__body"><ol class="start-steps">${startNonCustodialOwnerSteps()}</ol></div></div>`
    );
  }
  const mode = startMode();
  const seg = (m, label) =>
    `<button class="seg__btn ${mode === m ? "is-active" : ""}" data-start-mode="${m}">${esc(label)}</button>`;
  const chooser = `
    <div class="start-mode">
      <div class="start-mode__label">${esc(t("start_mode_label"))}</div>
      <div class="seg" role="group" aria-label="${esc(t("start_mode_label"))}">
        ${seg("custodial", t("start_mode_custodial"))}${seg("noncustodial", t("start_mode_noncustodial"))}
      </div>
      <p class="start-mode__hint">${esc(mode === "noncustodial" ? t("start_mode_hint_nc") : t("start_mode_hint_cus"))}</p>
    </div>`;
  const note = mode === "noncustodial" ? t("start_noncustodial_note") : t("start_custodial_note");
  const steps = mode === "noncustodial" ? startNonCustodialSteps() : startCustodialSteps();
  return (
    pageHead(t("nav_start"), t("start_sub")) +
    chooser +
    `<div class="callout">${icon("info", 18)}<div>${esc(note)}</div></div>` +
    `<div class="card"><div class="card__body"><ol class="start-steps">${steps}</ol></div></div>`
  );
}

// Mode toggle + (non-custodial) badge-provisioning form. The issuance is the real owner-signed
// `issueSession` op with `toAccount` = the customer's account, gated by the same step-up confirmation
// as every other high-risk action; on success we show the env handoff for their own walletd.
function wireStart() {
  document.querySelectorAll("[data-start-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      try {
        localStorage.setItem("agentpay-mode", btn.dataset.startMode);
      } catch {
        /* ignore */
      }
      go("start");
    }));

  // Non-custodial single-mode: the "connect wallet" step enqueues window.tari.connect(); the wallet
  // (:7777) drains + approves it, then tari#connect flips S.wallet.connected and re-renders.
  const ncoConnect = el("nco-connect");
  if (ncoConnect) {
    ncoConnect.addEventListener("click", () => {
      if (!window.tari || typeof window.tari.connect !== "function") {
        toast("error", t("nco_connect_cta"), "window.tari ×");
        return;
      }
      ncoConnect.disabled = true;
      Promise.resolve(window.tari.connect()).catch((e) => {
        ncoConnect.disabled = false;
        toast("error", t("nco_connect_cta"), (e && e.message) || String(e));
      });
    });
  }

  const issueBtn = el("nc-issue");
  if (!issueBtn) return;
  // re-show the handoff if a badge was already issued in this tab
  if (ncProvisioned) {
    const slot = el("nc-env");
    if (slot) slot.innerHTML = ncEnvBlock(ncProvisioned.account, ncProvisioned.label);
  }
  const labelOk = (v) => /^[A-Za-z0-9_.\-]{1,64}$/.test(v);
  issueBtn.addEventListener("click", async () => {
    const account = (el("nc-account").value || "").trim();
    const label = (el("nc-label").value || "").trim();
    setErr("nc-account", !account);
    setErr("nc-label", !labelOk(label));
    if (!account || !labelOk(label)) return;
    const gate = await stepUpToken("issueSession", { session: label, toAccount: account });
    if (!gate) return;
    await withPending(issueBtn, t("p_issuing"), async () => {
      try {
        S.data = await api("/api/sessions", { session: label, toAccount: account, confirmToken: gate.token });
        ncProvisioned = { account, label };
        const slot = el("nc-env");
        if (slot) slot.innerHTML = ncEnvBlock(account, label);
        toast("success", t("t_badge_issued"), t("nc_issued_ok", { acct: shorten(account, 10, 6) }));
      } catch (err) {
        toast("error", t("t_badge_failed"), err.message);
      }
    });
  });
}

/* ---- views: CONNECT ------------------------------------------------------- */
// "Connect your AI" — ready-to-paste wiring for each target, assembled from the live budget. The
// agent attaches to the on-chain budget (component); it never gets the owner key. Mirrors the CLI
// `agentpay-mcp --emit-config --host …` so copy-paste here == the generated config there.
function viewConnect() {
  const d = S.data || {};
  const cfg = d.config || {};
  const comp = d.budget ? d.budget.component : null;
  const origin = window.location.origin;
  const network = cfg.network || "local";
  const isLocal = network === "local";

  // Attach-mode env: just the component on local (the target's preset supplies the rest); explicit
  // network/walletd/template otherwise so a non-local block is self-contained.
  const env = { AGENTPAY_COMPONENT: comp || "component_… (open a budget first)" };
  if (!isLocal) {
    env.AGENTPAY_NETWORK = network;
    if (cfg.walletdUrl) env.AGENTPAY_WALLETD_URL = cfg.walletdUrl;
    if (cfg.template) env.AGENTPAY_BUDGET_TEMPLATE = cfg.template;
  }
  const mcpBlock = JSON.stringify({ mcpServers: { agentpay: { command: "agentpay-mcp", env } } }, null, 2);
  const genericBlock = JSON.stringify({ command: "agentpay-mcp", env }, null, 2);
  const httpBlock = `AGENTPAY_URL=${origin}\nAGENTPAY_API_KEY=${t("connect_http_keyph")}`;

  const block = (label, text) => `
    <div class="codeblock">
      <div class="codeblock__head">
        <span class="codeblock__label">${esc(label)}</span>
        <button class="icon-btn" data-copy="${esc(text)}" title="${esc(t("copy"))}" aria-label="${esc(t("connect_copy"))}">${icon("copy", 15)}</button>
      </div>
      <pre class="codeblock__body"><code>${esc(text)}</code></pre>
    </div>`;
  const cliHint = (cmd) => `
    <div class="codeblock codeblock--cli">
      <div class="codeblock__head">
        <span class="codeblock__label">${esc(t("connect_cli_hint"))}</span>
        <button class="icon-btn" data-copy="${esc(cmd)}" title="${esc(t("copy"))}">${icon("copy", 15)}</button>
      </div>
      <pre class="codeblock__body"><code>${esc(cmd)}</code></pre>
    </div>`;

  const needBudget = comp
    ? ""
    : `<div class="callout">${icon("info", 18)}<div>${esc(t("connect_no_budget"))}</div></div>`;

  const api = d.api || {};
  let httpNote;
  if (!api.enabled) {
    httpNote = `<div class="callout">${icon("info", 18)}<div>${esc(t("connect_http_disabled"))}</div></div>`;
  } else if (api.agentKeys && api.agentKeys.length) {
    httpNote = `<div class="callout">${icon("info", 18)}<div>${esc(t("connect_http_keys", { ids: api.agentKeys.join(", ") }))}</div></div>`;
  } else {
    httpNote = `<div class="callout">${icon("info", 18)}<div>${esc(t("connect_http_nokeys"))}</div></div>`;
  }

  return (
    pageHead(t("nav_connect"), t("connect_sub")) +
    `<div class="connect-status row row--wrap">
       <span class="badge badge--muted">${icon("plug", 13)} ${esc(t("connect_st_network", { n: network }))}</span>
       <span class="badge badge--${api.enabled ? "ok" : "muted"}">${icon(api.enabled ? "check" : "lock", 13)} ${esc(api.enabled ? t("connect_st_api_on") : t("connect_st_api_off"))}</span>
       <span class="badge badge--muted">${icon("wallet", 13)} ${esc(t("connect_st_keys", { n: (api.agentKeys || []).length }))}</span>
       <span class="badge badge--${comp ? "ok" : "warn"}">${icon("shield", 13)} ${esc(comp ? t("connect_st_comp_ok") : t("connect_st_comp_none"))}</span>
     </div>` +
    needBudget +
    `<div class="card connect-card">
       <div class="connect-card__head">${icon("grid", 18)}<h3>${esc(t("connect_steps_title"))}</h3></div>
       <ol class="connect-steps">
         <li><b>${esc(t("connect_step1_t"))}</b> ${esc(t("connect_step1_b"))}</li>
         <li><b>${esc(t("connect_step2_t"))}</b> ${esc(t("connect_step2_b"))}</li>
         <li><b>${esc(t("connect_step3_t"))}</b> ${esc(t("connect_step3_b"))}</li>
         <li><b>${esc(t("connect_step4_t"))}</b> ${esc(t("connect_step4_b"))}</li>
       </ol>
     </div>` +
    `<div class="card connect-card">
       <div class="connect-card__head">${icon("shield", 18)}<h3>${esc(t("connect_mcp_title"))}</h3></div>
       <p class="connect-card__how">${esc(t("connect_mcp_how"))}</p>
       ${block("mcpServers", mcpBlock)}
       <p class="connect-card__how sm">${esc(t("connect_cursor_how"))}</p>
       ${cliHint("agentpay-mcp --install --host claude")}
     </div>` +
    `<div class="card connect-card">
       <div class="connect-card__head">${icon("plug", 18)}<h3>${esc(t("connect_generic_title"))}</h3></div>
       <p class="connect-card__how">${esc(t("connect_generic_how"))}</p>
       ${block("stdio", genericBlock)}
     </div>` +
    `<div class="card connect-card">
       <div class="connect-card__head">${icon("send", 18)}<h3>${esc(t("connect_http_title"))}</h3></div>
       <p class="connect-card__how">${esc(t("connect_http_how"))}</p>
       ${block(".env", httpBlock)}
       ${httpNote}
       ${cliHint("agentpay-mcp --emit-config --host http-env")}
     </div>`
  );
}

/* ---- wiring (event delegation + per-view listeners) ----------------------- */
function wire() {
  const app = el("app");

  // delegated clicks
  app.onclick = async (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) return go(nav.dataset.nav);

    const copy = e.target.closest("[data-copy]");
    if (copy) return doCopy(copy);

    const act = e.target.closest("[data-action]");
    if (act) return handleAction(act.dataset.action, act);

    const rm = e.target.closest("[data-rmtag]");
    if (rm) {
      draftWhitelist.splice(Number(rm.dataset.rmtag), 1);
      renderTags();
    }

    const rs = e.target.closest("[data-revoke-session]");
    if (rs) return revokeSession(rs.dataset.revokeSession, rs);

    const rmm = e.target.closest("[data-remove-merchant]");
    if (rmm) return removeMerchant(rmm.dataset.removeMerchant, rmm.dataset.merchantName, rmm);

    const md = e.target.closest("[data-merchant-detail]");
    if (md) return openMerchantDrawer(md.dataset.merchantDetail);
  };

  // theme toggle
  app.querySelectorAll("[data-theme-set]").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeSet));
  });
  // language toggle
  wireLangToggle(app);

  if (S.view === "manage" && !S.data.budget) wireCreate();
  if (S.view === "manage" && S.data.budget) wireManage();
  if (S.view === "pay" && S.data.budget) wirePay();
  if (S.view === "merchants" && S.data.budget) wireMerchants();
  if (S.view === "settings") wireSettings();
  if (S.view === "receipts") wireReceipts();
  if (S.view === "subscription") wireSubscription();
  if (S.view === "start") wireStart();
}

function wireSettings() {
  const ui = el("set-ui-lang");
  if (ui) ui.onchange = () => setLang(ui.value); // client-side; re-renders in the chosen language
  const rc = el("set-receipt-lang");
  if (rc) {
    rc.onchange = async () => {
      const prev = S.data && S.data.receiptLang;
      try {
        S.data = await api("/api/settings", { receiptLang: rc.value });
        toast("success", t("settings_saved"));
      } catch (e) {
        rc.value = prev || "both"; // revert the control if the save failed
        toast("error", t("settings_save_failed"), e.message);
      }
    };
  }

  // Pay confirmation: the toggle requires a passphrase to be set first (guarded client-side AND on the
  // server), and the passphrase input is masked (type="password") and never pre-filled or echoed back.
  const req = el("set-pay-required");
  if (req) {
    req.onchange = async () => {
      const want = req.checked;
      if (want && !(S.data && S.data.payPassphraseSet)) {
        req.checked = false; // can't require what isn't set yet
        toast("error", t("pay_need_pass_first"));
        return;
      }
      try {
        S.data = await api("/api/settings", { payConfirmRequired: want });
        toast("success", t("settings_saved"));
      } catch (e) {
        req.checked = !want; // revert the toggle if the save failed
        toast("error", t("settings_save_failed"), e.message);
      }
    };
  }
  const saveP = el("set-pay-save");
  const passIn = el("set-pay-pass");
  if (saveP && passIn) {
    saveP.onclick = async () => {
      const val = passIn.value;
      try {
        S.data = await api("/api/settings", { payPassphrase: val });
        passIn.value = ""; // never keep the plaintext around in the field
        // Feedback after input: say whether it was set or cleared, then re-render the status line.
        toast("success", val.length ? t("pay_pass_saved") : t("pay_pass_cleared"));
        render();
      } catch (e) {
        toast("error", t("settings_save_failed"), e.message);
      }
    };
    passIn.onkeydown = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); saveP.click(); }
    };
  }
}

async function doCopy(btn) {
  const text = btn.dataset.copy;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    ta.remove();
  }
  const orig = btn.innerHTML;
  btn.classList.add("copied");
  btn.innerHTML = icon("check", 15);
  setTimeout(() => {
    btn.classList.remove("copied");
    btn.innerHTML = orig;
  }, 1200);
}

/* ---- non-custodial wallet transport (window.tari / :7777) ------------------
 * When a wallet is connected, the money the dashboard shows and spends is the WALLET's on-chain budget,
 * read + paid over the WalletConnect-style relay (the dApp holds no key). We still fetch the backend
 * /api/state for the page's full shape (agents, ledger, tx health — Phase 3 moves those too), but the
 * budget's caps/spent/treasury/whitelist and the component identity are OVERLAID from the wallet, and
 * `pay` is routed through window.tari so the wallet approves + signs and the chain enforces the caps. */
function walletProvider() { return (typeof window !== "undefined" && window.tari) || null; }

async function walletReadBudget(timeoutMs = 9000) {
  const tari = walletProvider();
  if (!tari) throw new Error("window.tari not available");
  // A READ over the relay: the wallet auto-resolves it (no approval) with the budget it is displaying.
  return tari.request({ method: "tari_getBudget", timeoutMs });
}

// Route an owner op (set limits / add-remove merchant) through the connected wallet: the wallet pops its
// OWN approval, signs with the owner badge, and the chain enforces it — so no dashboard step-up is needed.
// On an on-chain commit, re-read the wallet budget into the view. Returns {ok, reason?}.
async function walletOwnerOp(params) {
  const r = await walletProvider().request({ method: "tari_signAndSubmitTransaction", params });
  if (r && r.committed) { await refreshState(true); return { ok: true }; }
  return { ok: false, reason: (r && r.reason) || "" };
}

// Overlay the wallet's authoritative budget onto a backend-shaped state object, so every tile keeps
// rendering (backend shape) while the money figures + component identity become the wallet's. Degraded
// fields (funded/withdrawn/ledger/sessions) stay from the backend until Phase 3 serves them from the
// wallet. `_walletBacked` lets the UI say, honestly, where the numbers come from.
function overlayWalletBudget(base, w) {
  const out = base && typeof base === "object" ? { ...base } : {};
  const wb = w && w.budget;
  out._walletBacked = { account: (w && w.account) || null, component: (wb && wb.address) || null, merchant: (w && w.merchant) || null };
  if (!wb) return out; // linked but no budget open in the wallet — show the shell + the connect hint
  const prev = out.budget || {};
  const perTxCap = String(wb.perTx);
  const dailyCap = String(wb.daily);
  const spent = String(wb.spent);
  // Treasury = the budget vault's real on-chain balance (the wallet reads it). `funded` (a lifetime
  // total) isn't on-chain, so approximate "money in this window" as vault+spent — enough for the
  // treasury meter's denominator; the exact lifetime totals are a Phase-3 wallet read.
  const vault = wb.vault != null ? String(wb.vault) : null;
  const treasury = vault != null ? vault : prev.treasury;
  // Phase 3: the wallet now serves funded/withdrawn + the pay ledger + the session set from its OWN
  // journal (the indexer can't rebuild a budget's history from chain). Use those when present; fall back
  // to the vault+spent approximation / the backend shell only if an older wallet omits them.
  const funded = wb.funded != null ? String(wb.funded)
    : (vault != null ? String((Number(vault) || 0) + (Number(spent) || 0)) : prev.funded);
  const withdrawn = wb.withdrawn != null ? String(wb.withdrawn) : prev.withdrawn;
  const names = {};
  (out.merchants || []).forEach((m) => { if (m && m.address) names[m.address] = m.name; });
  const walletLedger = Array.isArray(wb.ledger)
    ? wb.ledger.map((row) => ({ ...row, merchantName: row.merchantName || names[row.merchant] || null }))
    : null;
  out.budget = {
    ...prev,
    component: wb.address,
    revoked: wb.revoked != null ? wb.revoked : prev.revoked,
    perTxCap, dailyCap, spent, treasury, funded, withdrawn,
    dailyRemaining: String(Math.max(0, (Number(dailyCap) || 0) - (Number(spent) || 0))),
    whitelist: (wb.whitelist || []).map((address) => ({ address, name: names[address] || null })),
    sessions: Array.isArray(wb.sessions) ? wb.sessions : prev.sessions,
    ledger: walletLedger != null ? walletLedger : prev.ledger,
    // The wallet read doesn't carry the window-RESET timing (epoch length, reset countdown), so drop the
    // live window object and let the card fall back to the window spent/remaining computed from the caps.
    window: null,
    source: {
      ...(prev.source || {}),
      treasury: vault != null ? "wallet" : (prev.source && prev.source.treasury) || "unavailable",
      spent: "wallet", caps: "wallet", whitelist: "wallet",
      sessions: Array.isArray(wb.sessions) ? "wallet" : (prev.source && prev.source.sessions) || "backend",
      ledger: walletLedger != null ? "wallet" : (prev.source && prev.source.ledger) || "backend",
      fundedWithdrawn: wb.funded != null ? "wallet" : "estimate",
      chainRead: true, backedBy: "wallet",
    },
  };
  return out;
}

// The merged one-page self-custody dApp (agentpay.html) sets window.__AP_WALLET_ONLY before this script
// boots: there is NO dashboard backend on that origin, so every /api read is skipped and the page is
// driven entirely by the connected in-page wallet (window.tari) + the chain. On the hosted :8787 dashboard
// the flag is unset, so nothing below changes. walletOnlyBase() is the minimal page shell the wallet
// overlay (overlayWalletBudget) then fills with the budget's caps/spent/treasury/whitelist/etc.
const WALLET_ONLY = typeof window !== "undefined" && window.__AP_WALLET_ONLY === true;
function walletOnlyBase() {
  // Mirror the backend /api/state "disconnected, no budget" shape so every existing render path finds
  // its fields — the page is driven by the in-page wallet overlay (overlayWalletBudget), not a backend.
  // The custodial-only surfaces (walletd URL, owner account, agent keys, tx journal) are empty: in
  // self-custody there is no walletd and no server journal, and the sidebar hides the walletd meta when
  // its URL is blank. tokenSymbol names the whole token; amounts stay in base units (UNIT = "µT").
  return {
    config: { walletdUrl: "", template: "", ownerAccount: "", tokenSymbol: "XTR", network: "" },
    api: { enabled: false, agentKeys: [] },
    connected: false, owner: null, merchants: [], frozen: false,
    stepUpRequired: false, receiptLang: "both", payConfirmRequired: false, payPassphraseSet: false,
    tx: { counts: { pending: 0, confirmed: 0, rejected: 0, unknown: 0 }, needsAttention: [] },
    budget: null,
  };
}

async function refreshState(silent) {
  try {
    const base = WALLET_ONLY ? walletOnlyBase() : await api("/api/state");
    if (S.wallet.connected && walletProvider()) {
      try {
        const w = await walletReadBudget();
        S.wallet.account = (w && w.account) || S.wallet.account;
        S.wallet.error = null;
        S.data = overlayWalletBudget(base, w);
      } catch (e) {
        // the wallet is linked but unreachable (closed / not draining): keep the backend shell visible
        // and flag the stale link in the banner, rather than blanking the page.
        S.wallet.error = e.message;
        S.data = overlayWalletBudget(base, null);
      }
    } else {
      S.data = base;
    }
    S.lastSync = Date.now();
    S.connError = null;
    if (!silent) render();
  } catch (e) {
    S.connError = e.message;
    render();
  }
}

async function handleAction(action, btn) {
  if (action === "refresh") {
    await withPending(btn, t("p_refreshing"), async () => {
      await refreshState(true);
      render();
      toast("info", t("t_uptodate"), t("t_uptodate_msg"));
    });
    return;
  }
  if (action === "logout") {
    try {
      await api("/api/logout", {});
    } catch {
      /* ignore */
    }
    S.authed = false;
    S.data = null;
    S.csrf = null;
    renderLogin();
    return;
  }
  if (action === "reconnect") {
    await withPending(btn, t("p_connecting"), async () => {
      try {
        S.data = await api("/api/connect", {});
        S.connError = null;
        render();
        toast("success", t("t_connected"), t("t_connected_msg"));
      } catch (e) {
        S.connError = e.message;
        render();
        toast("error", t("t_still_offline"), e.message);
      }
    });
    return;
  }
  if (action === "reset") {
    const res = await confirmDialog({
      tone: "warn",
      icon: "refresh",
      title: t("confirm_reset_title"),
      body: t("confirm_reset_body"),
      confirmLabel: t("confirm_reset_ok"),
      stepUp: S.stepUpRequired ? "resetLocal" : null,
    });
    if (!res) return;
    try {
      S.data = await api("/api/reset", { confirmToken: res.token });
      go("manage");
      toast("info", t("t_reset"), t("t_reset_msg"));
    } catch (e) {
      toast("error", t("t_reset_failed"), e.message);
    }
    return;
  }
  if (action === "revoke") {
    // Non-custodial: the wallet flips the on-chain kill switch under its owner-badge approval.
    if (S.wallet.connected && walletProvider()) {
      await withPending(btn, t("p_revoking"), async () => {
        try {
          const wr = await walletOwnerOp({ revoke: {} });
          if (wr.ok) { render(); toast("success", t("t_agent_revoked"), t("t_agent_revoked_msg")); }
          else toast("error", t("t_revoke_failed"), wr.reason);
        } catch (e) { toast("error", t("t_revoke_failed"), e.message); }
      });
      return;
    }
    const res = await confirmDialog({
      tone: "danger",
      icon: "ban",
      title: t("confirm_revoke_title"),
      body: t("confirm_revoke_body"),
      requireAck: t("confirm_revoke_ack"),
      confirmLabel: t("revoke_agent"),
      stepUp: S.stepUpRequired ? "revoke" : null,
    });
    if (!res) return;
    await withPending(btn, t("p_revoking"), async () => {
      try {
        S.data = await api("/api/revoke", { confirmToken: res.token });
        render();
        toast("success", t("t_agent_revoked"), t("t_agent_revoked_msg"));
      } catch (e) {
        toast("error", t("t_revoke_failed"), e.message);
      }
    });
    return;
  }
  if (action === "freeze" || action === "unfreeze") {
    const freezing = action === "freeze";
    const res = await confirmDialog({
      tone: freezing ? "danger" : "warn",
      icon: freezing ? "ban" : "check",
      title: freezing ? t("confirm_freeze_title") : t("confirm_unfreeze_title"),
      body: freezing ? t("confirm_freeze_body") : t("confirm_unfreeze_body"),
      confirmLabel: freezing ? t("freeze_btn") : t("unfreeze_btn"),
      stepUp: S.stepUpRequired ? action : null,
    });
    if (!res) return;
    await withPending(btn, freezing ? t("p_freezing") : t("p_unfreezing"), async () => {
      try {
        S.data = await api(freezing ? "/api/freeze" : "/api/unfreeze", { confirmToken: res.token });
        render();
        if (freezing) toast("error", t("t_frozen"), t("t_frozen_msg"));
        else toast("success", t("t_unfrozen"), t("t_unfrozen_msg"));
      } catch (e) {
        toast("error", t("t_freeze_failed"), e.message);
      }
    });
    return;
  }
}

async function revokeSession(session, btn) {
  // Non-custodial: the wallet blocks just this session badge under its owner-badge approval.
  if (S.wallet.connected && walletProvider()) {
    await withPending(btn, t("p_revoking"), async () => {
      try {
        const wr = await walletOwnerOp({ revokeSession: { session } });
        if (wr.ok) { render(); toast("success", t("t_session_revoked"), t("t_session_revoked_msg", { session })); }
        else toast("error", t("t_revoke_failed"), wr.reason);
      } catch (e) { toast("error", t("t_revoke_failed"), e.message); }
    });
    return;
  }
  const res = await confirmDialog({
    tone: "danger",
    icon: "ban",
    title: t("confirm_revoke_session_title", { session: esc(session) }),
    body: t("confirm_revoke_session_body"),
    requireAck: t("confirm_revoke_session_ack"),
    confirmLabel: t("confirm_revoke_session_ok"),
    stepUp: S.stepUpRequired ? "revokeSession" : null,
    stepUpParams: { session },
  });
  if (!res) return;
  await withPending(btn, t("p_revoking"), async () => {
    try {
      S.data = await api("/api/sessions/revoke", { session, confirmToken: res.token });
      render();
      toast("success", t("t_session_revoked"), t("t_session_revoked_msg", { session }));
    } catch (e) {
      toast("error", t("t_revoke_failed"), e.message);
    }
  });
}

async function removeMerchant(address, name, btn) {
  const label = name || shorten(address, 10, 6);
  // Non-custodial: the wallet's own approval modal IS the confirmation; skip the dashboard step-up.
  if (S.wallet.connected && walletProvider()) {
    await withPending(btn, t("p_removing"), async () => {
      try {
        const wr = await walletOwnerOp({ removeMerchant: { merchant: address } });
        if (wr.ok) { render(); toast("success", t("t_merchant_removed"), t("t_merchant_removed_msg", { name: esc(label) })); }
        else toast("error", t("t_merchant_remove_failed"), wr.reason);
      } catch (e) { toast("error", t("t_merchant_remove_failed"), e.message); }
    });
    return;
  }
  const res = await confirmDialog({
    tone: "warn",
    icon: "x",
    title: t("confirm_remove_merchant_title", { name: label }),
    body: t("confirm_remove_merchant_body"),
    confirmLabel: t("confirm_remove_merchant_ok"),
    stepUp: S.stepUpRequired ? "removeMerchant" : null,
    // Bound into the step-up token; the op call below sends the SAME address (see confirmParams).
    stepUpParams: { merchant: address },
  });
  if (!res) return;
  await withPending(btn, t("p_removing"), async () => {
    try {
      S.data = await api("/api/merchants/remove", { merchant: address, confirmToken: res.token });
      render();
      toast("success", t("t_merchant_removed"), t("t_merchant_removed_msg", { name: esc(label) }));
    } catch (e) {
      toast("error", t("t_merchant_remove_failed"), e.message);
    }
  });
}

/* ---- merchant detail drawer (§3.4) ---------------------------------------- */
function ensureDrawerRoot() {
  let r = el("drawer-root");
  if (!r) {
    r = document.createElement("div");
    r.id = "drawer-root";
    document.body.appendChild(r);
  }
  return r;
}
function _drawerKey(e) {
  if (e.key === "Escape") closeDrawer();
}
function closeDrawer() {
  const r = el("drawer-root");
  if (r) r.innerHTML = "";
  document.removeEventListener("keydown", _drawerKey);
}
function openMerchantDrawer(address) {
  const b = S.data && S.data.budget;
  if (!b) return;
  const m = b.whitelist.find((x) => x.address === address);
  if (!m) return;
  const root = ensureDrawerRoot();
  const name = m.name || t("merchant_fallback");
  root.innerHTML = `
    <div class="drawer-backdrop">
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(name)}">
        <div class="drawer__head">
          <div class="row" style="gap:10px;min-width:0">
            <span class="avatar" style="background:${avatarColor(m.name || m.address)}">${initials(m.name, m.address)}</span>
            <div style="min-width:0"><div style="font-weight:700">${esc(name)}</div>
              <div class="muted" style="font-size:12px">${esc(t("merchant_detail"))}</div></div>
          </div>
          <button class="icon-btn drawer__close" aria-label="${esc(t("dismiss"))}">${icon("x", 18)}</button>
        </div>
        <div class="drawer__body">
          <div class="drawer__row"><div class="drawer__k">${esc(t("drawer_status"))}</div>
            <div class="drawer__v"><span class="badge badge--ok">${icon("check", 13)} ${esc(t("merchant_status_active"))}</span></div></div>
          <div class="drawer__row"><div class="drawer__k">${esc(t("drawer_name"))}</div>
            <div class="drawer__v">${esc(name)}</div></div>
          <div class="drawer__row"><div class="drawer__k">${esc(t("drawer_address"))}</div>
            <div class="drawer__v"><span class="addr addr--lg"><span class="addr__text">${esc(m.address)}</span>
              <button class="icon-btn" data-copy="${esc(m.address)}" aria-label="${esc(t("copy"))}">${icon("copy", 15)}</button></span></div></div>
          <div class="drawer__row"><div class="drawer__k">${esc(t("drawer_authorization"))}</div>
            <div class="drawer__v">${esc(t("merchant_auth_note"))}</div></div>
          <div class="callout mt-18">${icon("info", 18)}<div>${esc(t("merchant_detail_note"))}</div></div>
        </div>
        <div class="drawer__foot">
          <button class="btn btn--danger-soft btn--block" data-drawer-remove="${esc(m.address)}" data-merchant-name="${esc(m.name || "")}">${icon("x", 16)} ${esc(t("remove_merchant"))}</button>
        </div>
      </aside>
    </div>`;
  const bd = $(".drawer-backdrop", root);
  if (bd) bd.addEventListener("click", (e) => { if (e.target === bd) closeDrawer(); });
  const cl = $(".drawer__close", root);
  if (cl) cl.addEventListener("click", closeDrawer);
  root.querySelectorAll("[data-copy]").forEach((btn) => btn.addEventListener("click", () => doCopy(btn)));
  const rm = $("[data-drawer-remove]", root);
  if (rm)
    rm.addEventListener("click", () => {
      const addr = rm.dataset.drawerRemove;
      const nm = rm.dataset.merchantName;
      closeDrawer();
      const rowBtn = document.querySelector(`[data-remove-merchant="${addr}"]`) || document.createElement("button");
      removeMerchant(addr, nm, rowBtn);
    });
  document.addEventListener("keydown", _drawerKey);
}

/* ---- create wiring -------------------------------------------------------- */
function wireCreate() {
  renderTags();
  const form = el("create-form");
  const addBtn = el("f-add");
  const merchantInput = el("f-merchant");
  const addMerchant = () => {
    const v = merchantInput.value.trim().toLowerCase();
    if (!v) return;
    if (!draftWhitelist.includes(v)) draftWhitelist.push(v);
    merchantInput.value = "";
    merchantInput.focus();
    renderTags();
  };
  addBtn.addEventListener("click", addMerchant);
  merchantInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addMerchant();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fund = readAmt("f-fund");
    const perTxCap = readAmt("f-pertx");
    const dailyCap = readAmt("f-daily");
    const epochsPerWindow = Number(el("f-epochs").value);
    const fundOk = fund !== null && amtBig(fund) > 0n;
    const perTxOk = perTxCap !== null && amtBig(perTxCap) > 0n;
    const dailyOk = dailyCap !== null && amtBig(dailyCap) > 0n && amtBig(dailyCap) >= amtBig(perTxCap);
    setErr("f-fund", !fundOk);
    setErr("f-pertx", !perTxOk);
    setErr("f-daily", !dailyOk);
    if (!(fundOk && perTxOk && dailyOk)) return;

    const gate = await stepUpToken("createBudget", { fund, perTxCap, dailyCap, epochsPerWindow, whitelist: draftWhitelist });
    if (!gate) return;
    await withPending(el("f-submit"), t("p_opening"), async () => {
      try {
        const r = await api("/api/budget", {
          fund,
          perTxCap,
          dailyCap,
          epochsPerWindow,
          whitelist: draftWhitelist,
          confirmToken: gate.token,
        });
        S.data = r;
        if (r && r.pending) {
          // The open was submitted but hasn't confirmed, so no budget is mounted yet. Stay on the form
          // with a pending notice rather than navigating to an empty overview that invites a re-open.
          toast("info", t("t_pending"), t("t_pending_open_msg", { amount: fmt(fund), unit: UNIT }));
          render();
        } else {
          toast("success", t("t_budget_opened"), t("t_budget_opened_msg", { amount: fmt(fund), unit: UNIT }));
          draftWhitelist = ["shop"];
          go("overview");
        }
      } catch (err) {
        toast("error", t("t_open_failed"), err.message);
      }
    });
  });
}
function setErr(id, isErr) {
  const field = el(id).closest(".field");
  if (field) field.classList.toggle("has-error", isErr);
}

/* ---- pay wiring ----------------------------------------------------------- */
function wirePay() {
  const form = el("pay-form");
  const checkBtn = el("p-check");
  const slot = el("verdict-slot");

  const readInputs = () => ({
    merchant: el("p-merchant").value.trim(),
    amount: readAmt("p-amount"),
    memo: el("p-memo").value.trim(),
  });
  const validate = ({ merchant, amount }) => {
    const amountOk = amount !== null && amtBig(amount) > 0n;
    setErr("p-merchant", !merchant);
    setErr("p-amount", !amountOk);
    return merchant && amountOk;
  };

  // Live client-side pre-check beside the form; a stale dry-run verdict is cleared when inputs change.
  const preview = el("pay-preview");
  const refreshPreview = () => {
    if (!preview) return;
    const { merchant, amount } = readInputs();
    preview.innerHTML = payRiskHtml(S.data.budget, merchant, amount);
    if (slot) slot.innerHTML = "";
  };
  const mSel = el("p-merchant");
  const aInp = el("p-amount");
  if (mSel) mSel.addEventListener("change", refreshPreview);
  if (aInp) aInp.addEventListener("input", refreshPreview);

  checkBtn.addEventListener("click", async () => {
    const vals = readInputs();
    if (!validate(vals)) return;
    slot.innerHTML = "";
    await withPending(checkBtn, t("p_asking"), async () => {
      try {
        const r = await api("/api/dry-run", { merchant: vals.merchant, amount: vals.amount });
        slot.innerHTML = r.ok
          ? `<div class="verdict verdict--ok">${icon("check", 18)}
              <div><div class="verdict__title">${esc(t("verdict_ok_title"))}</div>
              <div class="verdict__body">${t("verdict_ok_body", { amount: fmt(vals.amount), unit: UNIT, merchant: esc(vals.merchant) })}</div></div></div>`
          : `<div class="verdict verdict--reject">${icon("ban", 18)}
              <div><div class="verdict__title">${esc(t("verdict_reject_title"))}</div>
              <div class="verdict__body">${t("verdict_reject_body", { reason: esc(r.reason) })}</div></div></div>`;
      } catch (e) {
        toast("error", t("t_dryrun_failed"), e.message);
      }
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const vals = readInputs();
    if (!validate(vals)) return;
    slot.innerHTML = "";
    // Non-custodial: route the pay through the connected wallet (window.tari). The wallet pops its own
    // approval, signs, and the chain enforces the caps — the dashboard's custodial walletd path is never
    // touched. (The wallet pays its OWN whitelisted merchant; the banner says so. Phase 2 adds owner ops.)
    if (S.wallet.connected && walletProvider()) {
      const payee = (S.data && S.data._walletBacked && S.data._walletBacked.merchant) || vals.merchant;
      await withPending(el("p-pay"), t("p_submitting"), async () => {
        try {
          const r = await walletProvider().request({
            method: "tari_signAndSubmitTransaction",
            // amount as a NUMBER: the wallet's own cap self-check does arithmetic (spent + amount), so a
            // string would concat and mis-flag it. The chain enforcement is unaffected either way.
            params: { pay: { amount: Number(vals.amount), memo: vals.memo || undefined } },
          });
          if (r && r.committed) {
            toast("success", t("t_payment_sent"), t("t_payment_sent_msg", { amount: fmt(r.amount != null ? r.amount : vals.amount), unit: UNIT, merchant: esc(payee) }));
          } else {
            const reason = (r && r.reason) || "";
            el("verdict-slot") &&
              (el("verdict-slot").innerHTML = `<div class="verdict verdict--reject">${icon("ban", 18)}
                <div><div class="verdict__title">${esc(t("verdict_paid_reject_title"))}</div>
                <div class="verdict__body">${t("verdict_paid_reject_body", { reason: esc(reason || t("t_payment_failed")) })}</div></div></div>`);
            toast("error", t("t_rejected_onchain"), reason || t("t_payment_failed"));
          }
          await refreshState(true);
          render();
        } catch (err) {
          toast("error", t("t_payment_failed"), err.message);
        }
      });
      return;
    }
    await withPending(el("p-pay"), t("p_submitting"), async () => {
      try {
        const r = await idemPost(
          "/api/pay",
          { merchant: vals.merchant, amount: vals.amount, memo: vals.memo || undefined },
          "pay",
          vals.merchant + "|" + vals.amount + "|" + (vals.memo || ""),
        );
        S.data = r;
        if (r && r.pending) {
          // Submitted but UNKNOWN — do not claim it was paid; the retry path keeps the idem key.
          toast("info", t("t_pending"), t("t_pending_pay_msg", { amount: fmt(vals.amount), unit: UNIT, merchant: esc(vals.merchant) }));
        } else {
          toast("success", t("t_payment_sent"), t("t_payment_sent_msg", { amount: fmt(vals.amount), unit: UNIT, merchant: esc(vals.merchant) }));
        }
        render();
      } catch (err) {
        if (err.status === 422) {
          // chain / policy rejection — show the friendly verdict inline, not just a toast
          el("verdict-slot") &&
            (el("verdict-slot").innerHTML = `<div class="verdict verdict--reject">${icon("ban", 18)}
              <div><div class="verdict__title">${esc(t("verdict_paid_reject_title"))}</div>
              <div class="verdict__body">${t("verdict_paid_reject_body", { reason: esc(err.message) })}</div></div></div>`);
          toast("error", t("t_rejected_onchain"), err.message);
        } else {
          toast("error", t("t_payment_failed"), err.message);
        }
      }
    });
  });
}

/* ---- governance wiring ---------------------------------------------------- */
function wireMerchants() {
  const merchForm = el("merch-form");
  if (!merchForm) return;
  merchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el("g-merchant").value.trim();
    setErr("g-merchant", !name);
    if (!name) return;
    // Non-custodial: route the whitelist add through the wallet's owner-badge approval; no step-up here.
    if (S.wallet.connected && walletProvider()) {
      await withPending(el("g-add"), t("p_adding"), async () => {
        try {
          const wr = await walletOwnerOp({ addMerchant: { merchant: name } });
          if (wr.ok) { render(); toast("success", t("t_merchant_wl"), t("t_merchant_wl_msg", { name: esc(name) })); }
          else toast("error", t("t_merchant_failed"), wr.reason);
        } catch (err) { toast("error", t("t_merchant_failed"), err.message); }
      });
      return;
    }
    const gate = await stepUpToken("addMerchant", { merchant: name });
    if (!gate) return;
    await withPending(el("g-add"), t("p_adding"), async () => {
      try {
        S.data = await api("/api/merchants", { merchant: name, confirmToken: gate.token });
        render();
        toast("success", t("t_merchant_wl"), t("t_merchant_wl_msg", { name: esc(name) }));
      } catch (err) {
        toast("error", t("t_merchant_failed"), err.message);
      }
    });
  });
}

function wireManage() {
  const limitsForm = el("limits-form");
  if (limitsForm) {
    // Keep the "worst case ≈ 2× across a window boundary" hint in sync as the owner edits the cap,
    // so they never have to double the number in their head (fixed window — see agent_budget/lib.rs).
    const dailyInput = el("g-daily");
    const worst = el("daily-worst");
    if (dailyInput && worst) {
      dailyInput.addEventListener("input", () => {
        const v = readAmt("g-daily");
        worst.innerHTML = v !== null && amtBig(v) > 0n
          ? t("daily_cap_worst", { n: fmt((amtBig(v) * 2n).toString()), unit: UNIT })
          : "";
      });
    }
    limitsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const perTxCap = readAmt("g-pertx");
      const dailyCap = readAmt("g-daily");
      const perTxOk = perTxCap !== null && amtBig(perTxCap) > 0n;
      const dailyOk = dailyCap !== null && amtBig(dailyCap) > 0n && amtBig(dailyCap) >= amtBig(perTxCap);
      setErr("g-pertx", !perTxOk);
      setErr("g-daily", !dailyOk);
      if (!perTxOk || !dailyOk) return;
      const cur = S.data.budget;
      if (amtBig(perTxCap) === amtBig(cur.perTxCap) && amtBig(dailyCap) === amtBig(cur.dailyCap)) {
        toast("info", t("limits_title"), t("limits_unchanged"));
        return;
      }
      // Non-custodial: the connected wallet approves + signs with the owner badge; no step-up here.
      if (S.wallet.connected && walletProvider()) {
        await withPending(el("g-limits"), t("p_updating_limits"), async () => {
          try {
            const wr = await walletOwnerOp({ setLimits: { perTxCap, dailyCap } });
            if (wr.ok) { render(); toast("success", t("t_limits_updated"), t("t_limits_updated_msg", { perTx: fmt(perTxCap), daily: fmt(dailyCap), unit: UNIT })); }
            else toast("error", t("t_limits_failed"), wr.reason);
          } catch (err) { toast("error", t("t_limits_failed"), err.message); }
        });
        return;
      }
      // The step-up token is bound to this exact (perTxCap, dailyCap) pair; the op call sends the same.
      const gate = await stepUpToken("setLimits", { perTxCap, dailyCap });
      if (!gate) return;
      await withPending(el("g-limits"), t("p_updating_limits"), async () => {
        try {
          S.data = await api("/api/limits", { perTxCap, dailyCap, confirmToken: gate.token });
          render();
          toast("success", t("t_limits_updated"), t("t_limits_updated_msg", { perTx: fmt(perTxCap), daily: fmt(dailyCap), unit: UNIT }));
        } catch (err) {
          toast("error", t("t_limits_failed"), err.message);
        }
      });
    });
  }

  const topupForm = el("topup-form");
  if (topupForm) {
    topupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const amount = readAmt("g-topup");
      const ok = amount !== null && amtBig(amount) > 0n;
      setErr("g-topup", !ok);
      if (!ok) return;
      // Non-custodial: fund the vault through the wallet's own approval (top_up is open on chain, but
      // the funds leave the wallet owner's account, so the wallet still signs + approves).
      if (S.wallet.connected && walletProvider()) {
        await withPending(el("g-topup-btn"), t("p_topping"), async () => {
          try {
            const wr = await walletOwnerOp({ topUp: { amount } });
            if (wr.ok) { render(); toast("success", t("t_topped_up"), t("t_topped_up_msg", { amount: fmt(amount), unit: UNIT })); }
            else toast("error", t("t_topup_failed"), wr.reason);
          } catch (err) { toast("error", t("t_topup_failed"), err.message); }
        });
        return;
      }
      await withPending(el("g-topup-btn"), t("p_topping"), async () => {
        try {
          const r = await idemPost("/api/top-up", { amount }, "topUp", String(amount));
          S.data = r;
          render();
          if (r && r.pending) toast("info", t("t_pending"), t("t_pending_topup_msg", { amount: fmt(amount), unit: UNIT }));
          else toast("success", t("t_topped_up"), t("t_topped_up_msg", { amount: fmt(amount), unit: UNIT }));
        } catch (err) {
          toast("error", t("t_topup_failed"), err.message);
        }
      });
    });
  }

  const sessionForm = el("session-form");
  if (sessionForm) {
    sessionForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const session = el("g-session").value.trim();
      setErr("g-session", !session);
      if (!session) return;
      // Non-custodial: the wallet mints the session badge under its owner-badge approval.
      if (S.wallet.connected && walletProvider()) {
        await withPending(el("g-session-add"), t("p_issuing"), async () => {
          try {
            const wr = await walletOwnerOp({ issueSession: { session } });
            if (wr.ok) { render(); toast("success", t("t_badge_issued"), t("t_badge_issued_msg", { session: esc(session) })); }
            else toast("error", t("t_badge_failed"), wr.reason);
          } catch (err) { toast("error", t("t_badge_failed"), err.message); }
        });
        return;
      }
      const gate = await stepUpToken("issueSession", { session });
      if (!gate) return;
      await withPending(el("g-session-add"), t("p_issuing"), async () => {
        try {
          S.data = await api("/api/sessions", { session, confirmToken: gate.token });
          render();
          toast("success", t("t_badge_issued"), t("t_badge_issued_msg", { session: esc(session) }));
        } catch (err) {
          toast("error", t("t_badge_failed"), err.message);
        }
      });
    });
  }

  const wdForm = el("wd-form");
  wdForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = readAmt("g-amount");
    const max = S.data.budget.treasury;
    const valid = amount !== null && amtBig(amount) > 0n && amtBig(amount) <= amtBig(max);
    setErr("g-amount", !valid);
    if (!valid) return;
    // Non-custodial: the wallet pulls the vault back to the owner under its owner-badge approval.
    if (S.wallet.connected && walletProvider()) {
      await withPending(el("g-withdraw"), t("p_withdrawing"), async () => {
        try {
          const wr = await walletOwnerOp({ withdraw: { amount } });
          if (wr.ok) { render(); toast("success", t("t_withdrawn"), t("t_withdrawn_msg", { amount: fmt(amount), unit: UNIT })); }
          else toast("error", t("t_withdraw_failed"), wr.reason);
        } catch (err) { toast("error", t("t_withdraw_failed"), err.message); }
      });
      return;
    }
    const res = await confirmDialog({
      tone: "warn",
      icon: "up",
      title: t("confirm_withdraw_title"),
      body: t("confirm_withdraw_body", { amount: fmt(amount), unit: UNIT }),
      confirmLabel: t("confirm_withdraw_ok", { amount: fmt(amount), unit: UNIT }),
      stepUp: S.stepUpRequired ? "withdraw" : null,
      stepUpParams: { amount },
    });
    if (!res) return;
    await withPending(el("g-withdraw"), t("p_withdrawing"), async () => {
      try {
        const r = await api("/api/withdraw", { amount, confirmToken: res.token });
        S.data = r;
        render();
        if (r && r.pending) toast("info", t("t_pending"), t("t_pending_withdraw_msg", { amount: fmt(amount), unit: UNIT }));
        else toast("success", t("t_withdrawn"), t("t_withdrawn_msg", { amount: fmt(amount), unit: UNIT }));
      } catch (err) {
        toast("error", t("t_withdraw_failed"), err.message);
      }
    });
  });
}

/* ---- boot ----------------------------------------------------------------- */
async function boot() {
  initTheme();
  applyStaticI18n();
  if (WALLET_ONLY) {
    // self-custody merged page: no backend. Force the non-custodial shape and let the in-page wallet be
    // the source of truth; the budget appears once the user connects (tari#connect -> refreshState).
    S.authRequired = false; S.authed = true; S.nonCustodial = true;
    applyStaticI18n();
    const linked = S.wallet.connected && walletProvider();
    let w = null;
    if (linked) { try { w = await walletReadBudget(); S.wallet.account = (w && w.account) || S.wallet.account; } catch { /* not yet reachable */ } }
    S.data = overlayWalletBudget(walletOnlyBase(), w);
    S.connError = null; S.booting = false;
    render();
    return;
  }
  // Is auth required, and are we already signed in?
  try {
    const sess = await api("/api/session");
    S.authRequired = Boolean(sess.authRequired);
    S.authed = Boolean(sess.authed);
    S.stepUpRequired = Boolean(sess.stepUpRequired);
    S.nonCustodial = Boolean(sess.nonCustodial);
    S.csrf = sess.csrfToken || null;
  } catch {
    S.authRequired = false;
    S.authed = true;
  }
  applyStaticI18n(); // re-apply now that S.nonCustodial is known, so static chrome (meta description) picks the non-custodial copy
  if (S.authRequired && !S.authed) {
    S.booting = false;
    renderLogin();
    return;
  }
  try {
    S.data = await api("/api/connect", {}); // lazily connects walletd + resolves owner
    S.connError = null;
  } catch (e) {
    if (e.handled) return; // 401 already routed to login

    try {
      S.data = await api("/api/state"); // still show the shell if connect failed
    } catch {
      /* ignore */
    }
    S.connError = e.message;
  }
  S.booting = false;
  render();
}

/* ---- observe the non-custodial wallet link (the connect UI lives in wallet-connect.js) ---------
 * app.js doesn't own the connect button — the floating widget does. We just listen for the provider's
 * link events: on connect, flip to wallet-backed reads/pay and refresh; on disconnect, fall back to the
 * backend view. (If the provider is already connected — e.g. a hot reload — pick that up on load.) */
function initWalletLink() {
  if (typeof window === "undefined") return;
  const zh = () => (document.documentElement.lang || "zh").toLowerCase().indexOf("en") !== 0;
  window.addEventListener("tari#connect", (e) => {
    S.wallet.connected = true;
    S.wallet.account = (e && e.detail && e.detail.account) || (window.tari && window.tari.account) || null;
    S.wallet.error = null;
    toast("success", zh() ? "钱包已连接" : "Wallet linked",
      zh() ? "预算与支付现在都来自你的非托管钱包。" : "The budget and payments now come from your non-custodial wallet.");
    refreshState();
  });
  window.addEventListener("tari#disconnect", () => {
    S.wallet.connected = false; S.wallet.account = null; S.wallet.error = null;
    refreshState();
  });
  if (window.tari && window.tari.connected) {
    S.wallet.connected = true;
    S.wallet.account = window.tari.account || null;
  }
}
initWalletLink();

boot();
