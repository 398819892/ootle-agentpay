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
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const UNIT = "XTR";

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
    nav_create: "Create budget",
    nav_pay: "Payments",
    nav_governance: "Governance",

    /* overview */
    overview_sub: "A live view of your agent's on-chain spending budget.",
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
    wl_merchants: "Whitelisted merchants",
    no_wl_merchants: "No merchants whitelisted — any merchant is allowed.",
    add_merchant_placeholder: "Add merchant by name",
    gov_wl_hint: "Adds a merchant to the on-chain whitelist via the owner badge. ",
    gov_wl_hint_revoked: "<b>The agent is revoked, but the whitelist can still be edited.</b>",
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
      "This detaches the dashboard from the current budget so you can create a fresh one. The on-chain component itself is not deleted.",
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
    t_reset_msg: "Ready for a new budget.",
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
    t_topped_up: "Topped up",
    t_topped_up_msg: (p) => `${p.amount} ${p.unit} added to the budget's vault.`,
    t_topup_failed: "Top-up failed",
    t_badge_issued: "Session badge issued",
    t_badge_issued_msg: (p) => `“${p.session}” can now pay within the same on-chain rules.`,
    t_badge_failed: "Couldn't issue badge",
    t_withdrawn: "Withdrawn",
    t_withdrawn_msg: (p) => `${p.amount} ${p.unit} returned to the owner.`,
    t_withdraw_failed: "Withdraw failed",

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
    nav_create: "创建预算",
    nav_pay: "支付",
    nav_governance: "治理",

    /* overview */
    overview_sub: "实时查看代理的链上消费预算。",
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
    memo_placeholder: "invoice-042",
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
    wl_merchants: "白名单商户",
    no_wl_merchants: "尚未设置白名单——任意商户都可收款。",
    add_merchant_placeholder: "按名称添加商户",
    gov_wl_hint: "通过所有者凭证把商户加入链上白名单。",
    gov_wl_hint_revoked: "<b>代理虽已停用,但白名单仍可编辑。</b>",
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
    confirm_reset_body: "这会把仪表盘与当前预算解绑,方便你重新创建一个。链上组件本身不会被删除。",
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
    t_reset_msg: "可以创建新预算了。",
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
    t_topped_up: "充值成功",
    t_topped_up_msg: (p) => `已向预算金库追加 ${p.amount} ${p.unit}。`,
    t_topup_failed: "充值失败",
    t_badge_issued: "会话凭证已发放",
    t_badge_issued_msg: (p) => `「${p.session}」现在可以在相同的链上规则内付款了。`,
    t_badge_failed: "凭证发放失败",
    t_withdrawn: "已提现",
    t_withdrawn_msg: (p) => `${p.amount} ${p.unit} 已退回给所有者。`,
    t_withdraw_failed: "提现失败",

    dismiss: "关闭",
  },
};

/** Keep the document chrome (title, meta, boot text, <html lang>) in sync. */
function applyStaticI18n() {
  try {
    document.documentElement.setAttribute("lang", LANG === "zh" ? "zh-CN" : "en");
    document.title = t("meta_title");
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", t("meta_desc"));
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
  booting: true,
  connError: null,
  authRequired: false,
  authed: true,
};

/* ---- API client ----------------------------------------------------------- */
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
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
function confirmDialog({ tone = "danger", icon: ic = "alert", title, body, confirmLabel, requireAck }) {
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
          <div class="modal__actions">
            <button class="btn btn--secondary" data-m="cancel">${esc(t("cancel"))}</button>
            <button class="btn btn--${tone}" data-m="ok" ${requireAck ? "disabled" : ""}>${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    const backdrop = $(".modal-backdrop", root);
    const okBtn = $('[data-m="ok"]', root);
    const ack = $("#m-ack", root);
    if (ack) ack.addEventListener("change", () => (okBtn.disabled = !ack.checked));
    const done = (val) => {
      root.innerHTML = "";
      document.removeEventListener("keydown", onKey);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(val);
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
    okBtn.addEventListener("click", () => done(true));
    document.addEventListener("keydown", onKey);
    (ack || okBtn).focus();
  });
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
  { id: "overview", key: "nav_overview", icon: "grid" },
  { id: "create", key: "nav_create", icon: "wallet" },
  { id: "pay", key: "nav_pay", icon: "send" },
  { id: "governance", key: "nav_governance", icon: "shield" },
];

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
    const count = n.id === "governance" && wlCount ? `<span class="count">${wlCount}</span>` : "";
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
        d
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
        <button class="btn btn--primary" data-nav="create">${icon("plus", 16)} ${esc(t("create_budget"))}</button>
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
  const winRemaining = w ? w.remaining : Math.max(0, b.dailyCap - b.spent);
  const dailyPct = winCap ? Math.min(100, (winSpent / winCap) * 100) : 0;
  const dailyClass = dailyPct >= 100 ? "danger" : dailyPct >= 75 ? "warn" : "ok";
  const epochTip = w
    ? t("epoch_tip", {
        n: w.epochsPerWindow,
        min: w.epochMinutes,
        total: formatApprox(w.epochsPerWindow * w.epochMinutes),
      })
    : "";
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

  const stats = [
    { label: t("stat_treasury"), icon: "coins", value: fmt(b.treasury), unit: true, hint: t("stat_treasury_hint", { funded: fmt(b.funded), withdrawn: fmt(b.withdrawn) }) },
    { label: t("stat_spent_window"), icon: "trend", value: fmt(winSpent), unit: true, hint: w ? t("stat_spent_hint_window", { cap: fmt(winCap), left: fmt(winRemaining) }) : t("stat_spent_hint_daily", { cap: fmt(b.dailyCap) }) },
    { label: t("stat_tx"), icon: "activity", value: fmt(b.ledger.length), unit: false, hint: t("stat_tx_hint") },
    { label: t("stat_whitelisted"), icon: "store", value: fmt(b.whitelist.length), unit: false, hint: t("stat_whitelisted_hint") },
  ]
    .map(
      (s) => `<div class="stat">
        <div class="stat__label">${icon(s.icon, 15)} ${esc(s.label)}</div>
        <div class="stat__value">${s.value} <span class="unit">${s.unit ? UNIT : ""}</span></div>
        <div class="stat__hint">${esc(s.hint)}</div>
      </div>`,
    )
    .join("");

  const meter = (label, used, max, suffix, cls) => {
    const pct = max ? Math.min(100, (used / max) * 100) : 0;
    return `<div>
      <div class="meter__row"><span class="lbl">${esc(label)}</span>
        <span class="val">${fmt(used)} <span class="max">/ ${fmt(max)} ${suffix}</span></span></div>
      <div class="meter"><div class="meter__fill meter__fill--${cls}" style="width:${pct}%"></div></div>
    </div>`;
  };

  const chips = b.whitelist.length
    ? b.whitelist
        .map(
          (m) => `<span class="chip"><span class="chip__dot" style="background:${avatarColor(m.name || m.address)}"></span>
            ${m.name ? `<b>${esc(m.name)}</b>` : ""}<code>${esc(shorten(m.address, 8, 5))}</code></span>`,
        )
        .join("")
    : `<span class="muted" style="font-size:13px">${esc(t("any_merchant"))}</span>`;

  const recent = b.ledger
    .slice(-4)
    .reverse()
    .map((e) => ledgerRow(e))
    .join("");

  return (
    pageHead(
      t("nav_overview"),
      t("overview_sub"),
      `<button class="btn btn--secondary btn--sm" data-action="refresh">${icon("refresh", 15)} ${esc(t("refresh"))}</button>
       <button class="btn btn--primary btn--sm" data-nav="pay">${icon("send", 15)} ${esc(t("new_payment"))}</button>`,
    ) +
    `<div class="stack">
      <div class="hero">
        <div class="hero__top">
          <div>
            <div class="hero__title">${esc(t("hero_title"))}</div>
            <div class="hero__addr">${addrPill(b.component, { lg: true })}</div>
          </div>
          ${status}
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
          <span class="badge badge--muted"${epochTip ? ` title="${esc(epochTip)}"` : ""}>${icon("clock", 13)} ${esc(t("cap_daily", { n: fmt(b.dailyCap), unit: UNIT }))}${w ? esc(t("cap_daily_window", { n: w.epochsPerWindow })) : ""}</span>
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

      <div class="grid grid--stats">${stats}</div>

      <div class="grid grid--2">
        <div class="card">
          <div class="card__head"><h3>${esc(t("recent_activity"))}</h3>
            <button class="btn btn--ghost btn--sm" data-nav="pay">${esc(t("view_all"))} ${icon("send", 14)}</button></div>
          <div class="card__body" style="padding:8px 0 4px">
            ${
              recent
                ? `<div class="table-wrap"><table class="ledger"><tbody>${recent}</tbody></table></div>`
                : `<div class="empty" style="padding:30px"><p class="muted">${esc(t("overview_no_payments"))}</p></div>`
            }
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>${esc(t("whitelist"))}</h3>
            <button class="btn btn--ghost btn--sm" data-nav="governance">${esc(t("manage"))} ${icon("shield", 14)}</button></div>
          <div class="card__body">
            <div class="row row--wrap" style="gap:8px">${chips}</div>
            <div class="callout mt-18">${icon("info", 18)}
              <div>${t("overview_callout")}</div>
            </div>
          </div>
        </div>
      </div>
    </div>`
  );
}

function ledgerRow(e) {
  const name = e.merchantName;
  return `<tr>
    <td><div class="merchant">
      <span class="avatar" style="background:${avatarColor(name || e.merchant)}">${initials(name, e.merchant)}</span>
      <div><div style="font-weight:600">${name ? esc(name) : esc(t("merchant_fallback"))}</div>
        <div class="muted" style="font-size:12px;font-family:var(--mono)">${esc(shorten(e.merchant, 8, 5))}</div></div>
    </div></td>
    <td class="amount">−${fmt(e.amount)} <span class="muted" style="font-weight:500">${UNIT}</span></td>
    <td><span class="memo" title="${esc(e.memo)}">${esc(e.memo || "—")}</span></td>
  </tr>`;
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
            <div><b>${esc(t("create_trust_title"))}</b> ${esc(t("create_trust_body"))}</div>
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
  const ledger = b.ledger
    .slice()
    .reverse()
    .map((e) => fullLedgerRow(e))
    .join("");

  return (
    pageHead(t("nav_pay"), t("pay_sub")) +
    `<div class="grid grid--2" style="align-items:start">
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
              <div class="input-affix"><input class="input" id="p-amount" type="number" min="1" value="700"/><span class="affix">${UNIT}</span></div>
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
            <div id="verdict-slot"></div>
          </form>
          <div class="callout mt-18">${icon("info", 18)}
            <div><b>${esc(t("pay_callout_title"))}</b>${esc(t("pay_callout_body"))}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card__head"><h3>${esc(t("activity"))}</h3><span class="sub">${esc(t("activity_sub", { n: fmt(b.ledger.length) }))}</span></div>
        <div class="card__body" style="padding:6px 0">
          ${
            ledger
              ? `<div class="table-wrap"><table class="ledger">
                  <thead><tr><th>${esc(t("th_merchant"))}</th><th>${esc(t("th_amount"))}</th><th>${esc(t("th_memo"))}</th></tr></thead>
                  <tbody>${ledger}</tbody></table></div>`
              : `<div class="empty" style="padding:40px"><div class="empty__icon">${icon("activity", 26)}</div>
                 <h3>${esc(t("pay_no_payments_title"))}</h3><p>${t("pay_no_payments_body")}</p></div>`
          }
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
    <td><span class="memo" title="${esc(e.memo)}">${esc(e.memo || "—")}</span></td>
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

/* ---- views: GOVERNANCE ---------------------------------------------------- */
function viewGovernance() {
  const d = S.data;
  const b = d.budget;
  if (!b) return noBudget(t("nav_governance"), t("gov_nobudget_sub"));
  const chips = b.whitelist.length
    ? b.whitelist
        .map(
          (m) => `<span class="chip"><span class="chip__dot" style="background:${avatarColor(m.name || m.address)}"></span>
          ${m.name ? `<b>${esc(m.name)}</b>` : ""}<code>${esc(shorten(m.address, 10, 6))}</code></span>`,
        )
        .join("")
    : `<span class="muted" style="font-size:13px">${esc(t("no_wl_merchants"))}</span>`;

  return (
    pageHead(t("nav_governance"), t("gov_sub")) +
    `<div class="stack">
      <div class="grid grid--2" style="align-items:start">
        <div class="card">
          <div class="card__head"><h3>${esc(t("wl_merchants"))}</h3><span class="sub">${fmt(b.whitelist.length)}</span></div>
          <div class="card__body">
            <div class="row row--wrap" style="gap:8px;margin-bottom:16px">${chips}</div>
            <form id="merch-form" class="addrow" novalidate>
              <input class="input" id="g-merchant" placeholder="${esc(t("add_merchant_placeholder"))}" autocomplete="off"/>
              <button type="submit" class="btn btn--primary" id="g-add">${icon("plus", 16)} ${esc(t("add"))}</button>
            </form>
            <div class="field__hint mt-12">${esc(t("gov_wl_hint"))}${b.revoked ? t("gov_wl_hint_revoked") : ""}</div>
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>${esc(t("treasury"))}</h3></div>
          <div class="card__body">
            <div class="stat__value" style="margin:0">${fmt(b.treasury)} <span class="unit">${UNIT}</span></div>
            <div class="stat__hint">${esc(t("treasury_hint", { funded: fmt(b.funded), spent: fmt(b.spent) }))}</div>
            <form id="topup-form" class="mt-18" novalidate>
              <div class="field" style="margin-bottom:12px">
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
              <div class="field" style="margin-bottom:12px">
                <label class="field__label" for="g-amount">${esc(t("withdraw_amount"))}</label>
                <div class="input-affix"><input class="input" id="g-amount" type="number" min="1" max="${b.treasury}" value="${b.treasury}"/><span class="affix">${UNIT}</span></div>
                <div class="field__err">${esc(t("withdraw_amount_err"))}</div>
              </div>
              <button type="submit" class="btn btn--secondary btn--block" id="g-withdraw" ${b.treasury <= 0 ? "disabled" : ""}>${icon("up", 16)} ${esc(t("withdraw_to_owner"))}</button>
            </form>
          </div>
        </div>
      </div>

      ${sessionsCard(b)}

      <div class="card" style="border-color:color-mix(in srgb, var(--danger) 30%, var(--border))">
        <div class="card__head"><h3 style="color:var(--danger)">${icon("ban", 16)} ${esc(t("kill_switch"))}</h3>
          ${b.revoked ? `<span class="badge badge--danger">${esc(t("revoked"))}</span>` : `<span class="badge badge--ok">${esc(t("status_active"))}</span>`}</div>
        <div class="card__body">
          <div class="row spread row--wrap" style="gap:16px">
            <div style="max-width:52ch">
              <p style="font-weight:600;margin-bottom:4px">${esc(t("revoke_authority"))}</p>
              <p class="muted" style="font-size:13.5px">${esc(t("revoke_authority_body"))}</p>
            </div>
            <button class="btn btn--danger" id="g-revoke" data-action="revoke" ${b.revoked ? "disabled" : ""}>${icon("ban", 16)} ${b.revoked ? esc(t("already_revoked")) : esc(t("revoke_agent"))}</button>
          </div>
        </div>
      </div>

      <div class="row" style="justify-content:flex-end">
        <button class="btn btn--ghost btn--sm" data-action="reset">${esc(t("reset_demo"))}</button>
      </div>
    </div>`
  );
}

function noBudget(title, sub) {
  return (
    pageHead(title, sub) +
    `<div class="card"><div class="empty">
      <div class="empty__icon">${icon("wallet", 26)}</div>
      <h3>${esc(t("nobudget_open_title"))}</h3>
      <p>${esc(t("nobudget_open_body"))}</p>
      <button class="btn btn--primary" data-nav="create">${icon("plus", 16)} ${esc(t("create_budget"))}</button>
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
      <p class="muted" style="font-size:13.5px">${esc(t("login_intro"))}</p>
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
    case "create":
      body = viewCreate();
      break;
    case "pay":
      body = viewPay();
      break;
    case "governance":
      body = viewGovernance();
      break;
    default:
      body = viewOverview();
  }
  app.innerHTML = sidebar() + `<main class="main">${body}</main>`;
  wire();
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
  };

  // theme toggle
  app.querySelectorAll("[data-theme-set]").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeSet));
  });
  // language toggle
  wireLangToggle(app);

  if (S.view === "create" && !S.data.budget) wireCreate();
  if (S.view === "pay" && S.data.budget) wirePay();
  if (S.view === "governance" && S.data.budget) wireGovernance();
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

async function refreshState(silent) {
  try {
    S.data = await api("/api/state");
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
    const ok = await confirmDialog({
      tone: "warn",
      icon: "refresh",
      title: t("confirm_reset_title"),
      body: t("confirm_reset_body"),
      confirmLabel: t("confirm_reset_ok"),
    });
    if (!ok) return;
    try {
      S.data = await api("/api/reset", {});
      go("create");
      toast("info", t("t_reset"), t("t_reset_msg"));
    } catch (e) {
      toast("error", t("t_reset_failed"), e.message);
    }
    return;
  }
  if (action === "revoke") {
    const ok = await confirmDialog({
      tone: "danger",
      icon: "ban",
      title: t("confirm_revoke_title"),
      body: t("confirm_revoke_body"),
      requireAck: t("confirm_revoke_ack"),
      confirmLabel: t("revoke_agent"),
    });
    if (!ok) return;
    await withPending(btn, t("p_revoking"), async () => {
      try {
        S.data = await api("/api/revoke", {});
        render();
        toast("success", t("t_agent_revoked"), t("t_agent_revoked_msg"));
      } catch (e) {
        toast("error", t("t_revoke_failed"), e.message);
      }
    });
    return;
  }
}

async function revokeSession(session, btn) {
  const ok = await confirmDialog({
    tone: "danger",
    icon: "ban",
    title: t("confirm_revoke_session_title", { session: esc(session) }),
    body: t("confirm_revoke_session_body"),
    requireAck: t("confirm_revoke_session_ack"),
    confirmLabel: t("confirm_revoke_session_ok"),
  });
  if (!ok) return;
  await withPending(btn, t("p_revoking"), async () => {
    try {
      S.data = await api("/api/sessions/revoke", { session });
      render();
      toast("success", t("t_session_revoked"), t("t_session_revoked_msg", { session }));
    } catch (e) {
      toast("error", t("t_revoke_failed"), e.message);
    }
  });
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
    const fund = Number(el("f-fund").value);
    const perTxCap = Number(el("f-pertx").value);
    const dailyCap = Number(el("f-daily").value);
    const epochsPerWindow = Number(el("f-epochs").value);
    let bad = false;
    setErr("f-fund", !(fund > 0));
    setErr("f-pertx", !(perTxCap > 0));
    setErr("f-daily", !(dailyCap >= perTxCap && dailyCap > 0));
    bad = !(fund > 0) || !(perTxCap > 0) || !(dailyCap >= perTxCap && dailyCap > 0);
    if (bad) return;

    await withPending(el("f-submit"), t("p_opening"), async () => {
      try {
        S.data = await api("/api/budget", {
          fund,
          perTxCap,
          dailyCap,
          epochsPerWindow,
          whitelist: draftWhitelist,
        });
        toast("success", t("t_budget_opened"), t("t_budget_opened_msg", { amount: fmt(fund), unit: UNIT }));
        draftWhitelist = ["shop"];
        go("overview");
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
    amount: Number(el("p-amount").value),
    memo: el("p-memo").value.trim(),
  });
  const validate = ({ merchant, amount }) => {
    setErr("p-merchant", !merchant);
    setErr("p-amount", !(amount > 0));
    return merchant && amount > 0;
  };

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
    await withPending(el("p-pay"), t("p_submitting"), async () => {
      try {
        const r = await api("/api/pay", { merchant: vals.merchant, amount: vals.amount, memo: vals.memo || undefined });
        S.data = r;
        toast("success", t("t_payment_sent"), t("t_payment_sent_msg", { amount: fmt(vals.amount), unit: UNIT, merchant: esc(vals.merchant) }));
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
function wireGovernance() {
  const merchForm = el("merch-form");
  merchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el("g-merchant").value.trim();
    setErr("g-merchant", !name);
    if (!name) return;
    await withPending(el("g-add"), t("p_adding"), async () => {
      try {
        S.data = await api("/api/merchants", { merchant: name });
        render();
        toast("success", t("t_merchant_wl"), t("t_merchant_wl_msg", { name: esc(name) }));
      } catch (err) {
        toast("error", t("t_merchant_failed"), err.message);
      }
    });
  });

  const topupForm = el("topup-form");
  if (topupForm) {
    topupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const amount = Number(el("g-topup").value);
      setErr("g-topup", !(amount > 0));
      if (!(amount > 0)) return;
      await withPending(el("g-topup-btn"), t("p_topping"), async () => {
        try {
          S.data = await api("/api/top-up", { amount });
          render();
          toast("success", t("t_topped_up"), t("t_topped_up_msg", { amount: fmt(amount), unit: UNIT }));
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
      await withPending(el("g-session-add"), t("p_issuing"), async () => {
        try {
          S.data = await api("/api/sessions", { session });
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
    const amount = Number(el("g-amount").value);
    const max = S.data.budget.treasury;
    setErr("g-amount", !(amount > 0 && amount <= max));
    if (!(amount > 0 && amount <= max)) return;
    const ok = await confirmDialog({
      tone: "warn",
      icon: "up",
      title: t("confirm_withdraw_title"),
      body: t("confirm_withdraw_body", { amount: fmt(amount), unit: UNIT }),
      confirmLabel: t("confirm_withdraw_ok", { amount: fmt(amount), unit: UNIT }),
    });
    if (!ok) return;
    await withPending(el("g-withdraw"), t("p_withdrawing"), async () => {
      try {
        S.data = await api("/api/withdraw", { amount });
        render();
        toast("success", t("t_withdrawn"), t("t_withdrawn_msg", { amount: fmt(amount), unit: UNIT }));
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
  // Is auth required, and are we already signed in?
  try {
    const sess = await api("/api/session");
    S.authRequired = Boolean(sess.authRequired);
    S.authed = Boolean(sess.authed);
  } catch {
    S.authRequired = false;
    S.authed = true;
  }
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
boot();
