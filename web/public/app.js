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
/** A rough wall-clock label for a count of minutes, e.g. "≈5h", "≈2h 30m", "≈45 min". */
function formatApprox(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m <= 0) return "any moment";
  if (m < 60) return `≈${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `≈${h}h` : `≈${h}h ${rem}m`;
}
const UNIT = "XTR";

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
    <button class="icon-btn" data-copy="${esc(addr)}" id="${id}" aria-label="Copy full address" title="Copy">${icon("copy", 15)}</button>
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
  const t = document.createElement("div");
  t.className = `toast toast--${type}`;
  t.setAttribute("role", "status");
  const ic = type === "success" ? "check" : type === "error" ? "alert" : "info";
  t.innerHTML = `
    <span class="toast__icon">${icon(ic, 20)}</span>
    <div style="flex:1;min-width:0">
      <div class="toast__title">${esc(title)}</div>
      ${msg ? `<div class="toast__msg">${esc(msg)}</div>` : ""}
    </div>
    <button class="icon-btn toast__close" aria-label="Dismiss">${icon("x", 15)}</button>`;
  host.appendChild(t);
  const close = () => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 200);
  };
  $(".toast__close", t).addEventListener("click", close);
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
            <button class="btn btn--secondary" data-m="cancel">Cancel</button>
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
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "create", label: "Create budget", icon: "wallet" },
  { id: "pay", label: "Payments", icon: "send" },
  { id: "governance", label: "Governance", icon: "shield" },
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
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("agentpay-theme", t);
  } catch {
    /* private mode */
  }
  render();
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
      ${icon(n.icon)}<span class="lbl">${n.label}</span>${count}</button>`;
  }).join("");
  const themeBtn = (t, ic, lbl) =>
    `<button class="${theme === t ? "is-active" : ""}" data-theme-set="${t}" aria-label="${lbl} theme" title="${lbl}">${icon(ic, 15)}</button>`;
  return `<aside class="sidebar">
    <div class="brand">
      <div class="brand__mark">${icon("shield", 20)}</div>
      <div><div class="brand__name">AgentPay</div><div class="brand__sub">Agent budget console</div></div>
    </div>
    <nav class="nav" aria-label="Sections">${navHtml}</nav>
    <div class="sidebar__spacer"></div>
    <div class="sidebar__foot">
      <div class="conn">
        <span class="dot ${connected ? "dot--on" : "dot--off"}"></span>
        <span class="conn__txt">${connected ? "Connected to chain" : "Offline"}</span>
      </div>
      <div class="theme-toggle" role="group" aria-label="Theme">
        ${themeBtn("light", "sun", "Light")}${themeBtn("auto", "monitor", "System")}${themeBtn("dark", "moon", "Dark")}
      </div>
      ${
        d
          ? `<div class="meta"><b>walletd</b> ${esc(shorten(d.config.walletdUrl.replace(/^https?:\/\//, ""), 22, 8))}<br/>
             <b>template</b> ${esc(shorten(d.config.template.replace("template_", ""), 8, 6))}<br/>
             <b>owner</b> ${esc(d.config.ownerAccount)}</div>`
          : ""
      }
      ${
        S.authRequired
          ? `<button class="btn btn--ghost btn--sm logout-btn" data-action="logout" aria-label="Sign out">${icon("lock", 15)} Sign out</button>`
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
      pageHead("Overview", "A live view of your agent's on-chain spending budget.") +
      `<div class="card"><div class="empty">
        <div class="empty__icon">${icon("wallet", 26)}</div>
        <h3>No budget yet</h3>
        <p>Open an on-chain budget to give an AI agent a spending allowance that the Tari validators enforce — per-transaction and daily caps, a merchant whitelist, and a kill switch.</p>
        <button class="btn btn--primary" data-nav="create">${icon("plus", 16)} Create a budget</button>
      </div></div>`
    );
  }
  const status = b.revoked
    ? `<span class="badge badge--danger">${icon("ban", 13)} Revoked</span>`
    : `<span class="badge badge--ok">${icon("check", 13)} Active</span>`;
  // The "daily cap" is enforced over a rolling window of chain epochs (≈30 min each), reset lazily
  // — not a calendar day. `b.window` is the live, human-readable view of that (null if the chain
  // read failed; fall back to the lifetime `spent` so the card still renders).
  const w = b.window;
  const winSpent = w ? w.spentInWindow : b.spent;
  const winCap = w ? w.dailyCap : b.dailyCap;
  const winRemaining = w ? w.remaining : Math.max(0, b.dailyCap - b.spent);
  const dailyPct = winCap ? Math.min(100, (winSpent / winCap) * 100) : 0;
  const treasPct = b.funded ? Math.min(100, (b.treasury / b.funded) * 100) : 0;
  const dailyClass = dailyPct >= 100 ? "danger" : dailyPct >= 75 ? "warn" : "ok";
  const epochTip = w
    ? `The daily cap is enforced over a rolling window of ${w.epochsPerWindow} chain epochs ` +
      `(~${w.epochMinutes} min each, ${formatApprox(w.epochsPerWindow * w.epochMinutes)} in total), not a ` +
      `calendar day. It resets lazily — on the first payment after the window elapses — so these ` +
      `times are approximate.`
    : "";
  const resetNote = w
    ? w.windowElapsed
      ? `Window elapsed — the next payment starts a fresh ≈${w.epochsPerWindow}-epoch window.`
      : `${fmt(winRemaining)} ${UNIT} left this window · resets ${w.resetEta} (${w.epochsUntilReset} epoch${w.epochsUntilReset === 1 ? "" : "s"})`
    : "";

  const stats = [
    { label: "Treasury balance", icon: "coins", value: fmt(b.treasury), hint: `${fmt(b.funded)} funded · ${fmt(b.withdrawn)} withdrawn` },
    { label: "Spent (window)", icon: "trend", value: fmt(winSpent), hint: w ? `of ${fmt(winCap)} cap · ${fmt(winRemaining)} left` : `of ${fmt(b.dailyCap)} daily cap` },
    { label: "Transactions", icon: "activity", value: fmt(b.ledger.length), hint: "on-chain pay events" },
    { label: "Whitelisted", icon: "store", value: fmt(b.whitelist.length), hint: "approved merchants" },
  ]
    .map(
      (s) => `<div class="stat">
        <div class="stat__label">${icon(s.icon, 15)} ${s.label}</div>
        <div class="stat__value">${s.value} <span class="unit">${s.label.includes("Treasury") || s.label.includes("Spent") ? UNIT : ""}</span></div>
        <div class="stat__hint">${esc(s.hint)}</div>
      </div>`,
    )
    .join("");

  const meter = (label, used, max, suffix, cls) => {
    const pct = max ? Math.min(100, (used / max) * 100) : 0;
    return `<div>
      <div class="meter__row"><span class="lbl">${label}</span>
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
    : `<span class="muted" style="font-size:13px">Any merchant allowed (no whitelist set)</span>`;

  const recent = b.ledger
    .slice(-4)
    .reverse()
    .map((e) => ledgerRow(e))
    .join("");

  return (
    pageHead(
      "Overview",
      "A live view of your agent's on-chain spending budget.",
      `<button class="btn btn--secondary btn--sm" data-action="refresh">${icon("refresh", 15)} Refresh</button>
       <button class="btn btn--primary btn--sm" data-nav="pay">${icon("send", 15)} New payment</button>`,
    ) +
    `<div class="stack">
      <div class="hero">
        <div class="hero__top">
          <div>
            <div class="hero__title">On-chain budget</div>
            <div class="hero__addr">${addrPill(b.component, { lg: true })}</div>
          </div>
          ${status}
        </div>
        <div class="hero__meters">
          <div>
            ${meter("This window's spend", winSpent, winCap, UNIT, dailyClass)}
            ${resetNote ? `<div class="meter__note">${icon("clock", 12)} ${esc(resetNote)}</div>` : ""}
          </div>
          ${meter("Treasury remaining", b.treasury, b.funded, UNIT, "ok")}
        </div>
        <div class="hero__caps">
          <span class="badge badge--muted">${icon("zap", 13)} Per-tx cap ${fmt(b.perTxCap)} ${UNIT}</span>
          <span class="badge badge--muted"${epochTip ? ` title="${esc(epochTip)}"` : ""}>${icon("clock", 13)} Daily cap ${fmt(b.dailyCap)} ${UNIT}${w ? ` / ≈${w.epochsPerWindow}-epoch window` : ""}</span>
          <span class="badge badge--muted">${icon("lock", 13)} Validator-enforced</span>
        </div>
        ${
          w
            ? `<div class="hero__epochnote" title="${esc(epochTip)}">${icon("info", 14)}
                 <span><b>“Daily” is a rolling window of ${w.epochsPerWindow} chain epochs</b>
                 (~${w.epochMinutes} min each, ${formatApprox(w.epochsPerWindow * w.epochMinutes)} in total), not a calendar day —
                 and it resets lazily on the next payment. Times are approximate.</span>
               </div>`
            : ""
        }
      </div>

      <div class="grid grid--stats">${stats}</div>

      <div class="grid grid--2">
        <div class="card">
          <div class="card__head"><h3>Recent activity</h3>
            <button class="btn btn--ghost btn--sm" data-nav="pay">View all ${icon("send", 14)}</button></div>
          <div class="card__body" style="padding:8px 0 4px">
            ${
              recent
                ? `<div class="table-wrap"><table class="ledger"><tbody>${recent}</tbody></table></div>`
                : `<div class="empty" style="padding:30px"><p class="muted">No payments yet. Head to Payments to send the first one.</p></div>`
            }
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Whitelist</h3>
            <button class="btn btn--ghost btn--sm" data-nav="governance">Manage ${icon("shield", 14)}</button></div>
          <div class="card__body">
            <div class="row row--wrap" style="gap:8px">${chips}</div>
            <div class="callout mt-18">${icon("info", 18)}
              <div>These rules live in the budget's on-chain component. Even a compromised agent client can't exceed them — the <b>validators reject</b> any payment that breaks them.</div>
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
      <div><div style="font-weight:600">${name ? esc(name) : "Merchant"}</div>
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
      pageHead("Create budget", "You already have an open budget.") +
      `<div class="card"><div class="empty">
        <div class="empty__icon">${icon("check", 26)}</div>
        <h3>A budget is already open</h3>
        <p>This demo manages one budget at a time. Open it in the overview, or reset to start a fresh one.</p>
        <div class="row"><button class="btn btn--primary" data-nav="overview">Go to overview</button>
        <button class="btn btn--secondary" data-action="reset">Reset &amp; start over</button></div>
      </div></div>`
    );
  }
  return (
    pageHead("Create budget", "Fund an on-chain budget and set the rules the validators will enforce.") +
    `<div class="grid grid--2" style="align-items:start">
      <div class="card">
        <div class="card__head"><h3>Budget parameters</h3></div>
        <div class="card__body">
          <form id="create-form" novalidate>
            <div class="field">
              <label class="field__label" for="f-fund">Funding amount</label>
              <div class="input-affix">
                <input class="input" id="f-fund" type="number" min="1" value="10000" inputmode="numeric"/>
                <span class="affix">${UNIT}</span>
              </div>
              <div class="field__hint">Moved from the owner account into the budget's on-chain vault.</div>
              <div class="field__err">Enter a positive funding amount.</div>
            </div>
            <div class="form-grid">
              <div class="field">
                <label class="field__label" for="f-pertx">Per-transaction cap</label>
                <div class="input-affix"><input class="input" id="f-pertx" type="number" min="1" value="1000"/><span class="affix">${UNIT}</span></div>
                <div class="field__err">Required.</div>
              </div>
              <div class="field">
                <label class="field__label" for="f-daily">Daily cap</label>
                <div class="input-affix"><input class="input" id="f-daily" type="number" min="1" value="1500"/><span class="affix">${UNIT}</span></div>
                <div class="field__err">Must be ≥ per-transaction cap.</div>
              </div>
            </div>
            <div class="field">
              <label class="field__label" for="f-epochs">Daily window (epochs)</label>
              <input class="input" id="f-epochs" type="number" min="1" value="10"/>
              <div class="field__hint">The rolling window the daily cap is measured over, in chain epochs.</div>
            </div>
            <div class="field">
              <label class="field__label">Merchant whitelist</label>
              <div class="addrow">
                <input class="input" id="f-merchant" placeholder="Merchant name, e.g. shop" autocomplete="off"/>
                <button type="button" class="btn btn--secondary" id="f-add">${icon("plus", 16)} Add</button>
              </div>
              <div class="field__hint">Named merchants are created on the local devnet on first use. Leave empty to allow any merchant.</div>
              <div class="tag-list" id="f-tags"></div>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn btn--primary" id="f-submit">${icon("wallet", 16)} Open budget on chain</button>
            </div>
          </form>
        </div>
      </div>
      <div class="stack">
        <div class="card"><div class="card__body">
          <div class="callout">${icon("lock", 18)}
            <div><b>Hosted, but not trusted blindly.</b> The backend signs through walletd — but the caps and whitelist you set here are compiled into the budget's on-chain component and enforced by validators, not by this app.</div>
          </div>
        </div></div>
        <div class="card">
          <div class="card__head"><h3>What happens</h3></div>
          <div class="card__body">
            <ol class="muted" style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.9">
              <li>Owner withdraws the funding from their account.</li>
              <li>The <code>AgentBudget</code> template mints the budget component + owner/agent badges.</li>
              <li>Caps, window and whitelist are stored on chain.</li>
              <li>The agent can now pay — within the rules only.</li>
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
          <button type="button" data-rmtag="${i}" aria-label="Remove ${esc(m)}">${icon("x", 13)}</button></span>`,
    )
    .join("");
}

/* ---- views: PAY ----------------------------------------------------------- */
let lastVerdict = null;
function viewPay() {
  const d = S.data;
  const b = d.budget;
  if (!b) return noBudget("Payments", "Open a budget before sending payments.");
  // The merchant picker is driven by the budget's CURRENT on-chain whitelist (known names, or a
  // truncated address when the label is unknown) — so every whitelisted merchant is selectable and
  // the list stays in sync after one is added in Governance. Other known accounts are offered in a
  // separate group so the "watch the chain reject a non-whitelisted payee" demo still works.
  const wlAddrs = new Set(b.whitelist.map((m) => m.address));
  const wlOptions = b.whitelist
    .map(
      (m) =>
        `<option value="${esc(m.name || m.address)}">${m.name ? esc(m.name) : esc(shorten(m.address, 10, 6)) + " (address)"}</option>`,
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
    pageHead("Payments", "The agent pays whitelisted merchants — every payment is checked on chain.") +
    `<div class="grid grid--2" style="align-items:start">
      <div class="card">
        <div class="card__head"><h3>Send a payment</h3>
          ${b.revoked ? `<span class="badge badge--danger">${icon("ban", 13)} Agent revoked</span>` : ""}</div>
        <div class="card__body">
          <form id="pay-form" novalidate>
            <div class="field">
              <label class="field__label" for="p-merchant">Merchant</label>
              <div class="select-wrap">
                <select class="select" id="p-merchant">
                  ${
                    b.whitelist.length
                      ? `<optgroup label="Whitelisted — the agent can pay these">${wlOptions}</optgroup>`
                      : `<option value="" disabled selected>No whitelisted merchants yet — add one in Governance</option>`
                  }
                  ${otherOptions ? `<optgroup label="Not whitelisted — the chain will reject">${otherOptions}</optgroup>` : ""}
                </select>
              </div>
              <div class="field__hint">Every merchant on the budget's on-chain whitelist is listed here. Pick a non-whitelisted one (e.g. <code>scammer</code>) to watch the chain refuse it.</div>
              <div class="field__err">Pick a merchant.</div>
            </div>
            <div class="field">
              <label class="field__label" for="p-amount">Amount</label>
              <div class="input-affix"><input class="input" id="p-amount" type="number" min="1" value="700"/><span class="affix">${UNIT}</span></div>
              <div class="field__err">Enter a positive amount.</div>
            </div>
            <div class="field">
              <label class="field__label" for="p-memo">Invoice / memo <span class="muted" style="font-weight:400">(optional)</span></label>
              <input class="input" id="p-memo" placeholder="invoice-042" autocomplete="off"/>
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn--secondary" id="p-check">${icon("shield", 16)} Check on chain</button>
              <button type="submit" class="btn btn--primary" id="p-pay" ${b.revoked ? "disabled" : ""}>${icon("send", 16)} Pay</button>
            </div>
            <div id="verdict-slot"></div>
          </form>
          <div class="callout mt-18">${icon("info", 18)}
            <div><b>“Check on chain”</b> runs a validator dry-run: it asks the chain whether the payment would be accepted, and shows the validator's own reason if not — no transaction is submitted.</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card__head"><h3>Activity</h3><span class="sub">${fmt(b.ledger.length)} payments · rebuilt from chain events</span></div>
        <div class="card__body" style="padding:6px 0">
          ${
            ledger
              ? `<div class="table-wrap"><table class="ledger">
                  <thead><tr><th>Merchant</th><th>Amount</th><th>Memo</th></tr></thead>
                  <tbody>${ledger}</tbody></table></div>`
              : `<div class="empty" style="padding:40px"><div class="empty__icon">${icon("activity", 26)}</div>
                 <h3>No payments yet</h3><p>Payments you send appear here, read back from the chain's <code>pay</code> events.</p></div>`
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
      <div><div style="font-weight:600">${name ? esc(name) : "Merchant"}</div>
      <div class="muted" style="font-size:12px;font-family:var(--mono)">${esc(shorten(e.merchant, 8, 5))}</div></div>
    </div></td>
    <td class="amount">−${fmt(e.amount)} <span class="muted" style="font-weight:500">${UNIT}</span></td>
    <td><span class="memo" title="${esc(e.memo)}">${esc(e.memo || "—")}</span></td>
  </tr>`;
}

/* ---- views: GOVERNANCE ---------------------------------------------------- */
function viewGovernance() {
  const d = S.data;
  const b = d.budget;
  if (!b) return noBudget("Governance", "Open a budget to manage it.");
  const chips = b.whitelist.length
    ? b.whitelist
        .map(
          (m) => `<span class="chip"><span class="chip__dot" style="background:${avatarColor(m.name || m.address)}"></span>
          ${m.name ? `<b>${esc(m.name)}</b>` : ""}<code>${esc(shorten(m.address, 10, 6))}</code></span>`,
        )
        .join("")
    : `<span class="muted" style="font-size:13px">No merchants whitelisted — any merchant is allowed.</span>`;

  return (
    pageHead("Governance", "Owner controls. Changes are signed with the owner badge and committed on chain.") +
    `<div class="stack">
      <div class="grid grid--2" style="align-items:start">
        <div class="card">
          <div class="card__head"><h3>Whitelisted merchants</h3><span class="sub">${fmt(b.whitelist.length)}</span></div>
          <div class="card__body">
            <div class="row row--wrap" style="gap:8px;margin-bottom:16px">${chips}</div>
            <form id="merch-form" class="addrow" novalidate>
              <input class="input" id="g-merchant" placeholder="Add merchant by name" autocomplete="off"/>
              <button type="submit" class="btn btn--primary" id="g-add">${icon("plus", 16)} Add</button>
            </form>
            <div class="field__hint mt-12">Adds a merchant to the on-chain whitelist via the owner badge. ${b.revoked ? "<b>The agent is revoked, but the whitelist can still be edited.</b>" : ""}</div>
          </div>
        </div>
        <div class="card">
          <div class="card__head"><h3>Treasury</h3></div>
          <div class="card__body">
            <div class="stat__value" style="margin:0">${fmt(b.treasury)} <span class="unit">${UNIT}</span></div>
            <div class="stat__hint">available to withdraw · ${fmt(b.funded)} funded, ${fmt(b.spent)} spent</div>
            <form id="wd-form" class="mt-18" novalidate>
              <div class="field" style="margin-bottom:12px">
                <label class="field__label" for="g-amount">Withdraw amount</label>
                <div class="input-affix"><input class="input" id="g-amount" type="number" min="1" max="${b.treasury}" value="${b.treasury}"/><span class="affix">${UNIT}</span></div>
                <div class="field__err">Enter an amount within the treasury.</div>
              </div>
              <button type="submit" class="btn btn--secondary btn--block" id="g-withdraw" ${b.treasury <= 0 ? "disabled" : ""}>${icon("up", 16)} Withdraw to owner</button>
            </form>
          </div>
        </div>
      </div>

      <div class="card" style="border-color:color-mix(in srgb, var(--danger) 30%, var(--border))">
        <div class="card__head"><h3 style="color:var(--danger)">${icon("ban", 16)} Kill switch</h3>
          ${b.revoked ? `<span class="badge badge--danger">Revoked</span>` : `<span class="badge badge--ok">Active</span>`}</div>
        <div class="card__body">
          <div class="row spread row--wrap" style="gap:16px">
            <div style="max-width:52ch">
              <p style="font-weight:600;margin-bottom:4px">Revoke the agent's spending authority</p>
              <p class="muted" style="font-size:13.5px">Flips the on-chain kill switch. Every further payment is rejected by the validators — instantly and irreversibly. The owner can still withdraw the remaining treasury.</p>
            </div>
            <button class="btn btn--danger" id="g-revoke" data-action="revoke" ${b.revoked ? "disabled" : ""}>${icon("ban", 16)} ${b.revoked ? "Already revoked" : "Revoke agent"}</button>
          </div>
        </div>
      </div>

      <div class="row" style="justify-content:flex-end">
        <button class="btn btn--ghost btn--sm" data-action="reset">Reset demo (detach budget)</button>
      </div>
    </div>`
  );
}

function noBudget(title, sub) {
  return (
    pageHead(title, sub) +
    `<div class="card"><div class="empty">
      <div class="empty__icon">${icon("wallet", 26)}</div>
      <h3>No budget open</h3>
      <p>Create an on-chain budget first, then come back here.</p>
      <button class="btn btn--primary" data-nav="create">${icon("plus", 16)} Create a budget</button>
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
      <div class="auth__brand">
        <div class="brand__mark">${icon("shield", 22)}</div>
        <div><h1>AgentPay</h1><div class="auth__sub">Agent budget console</div></div>
      </div>
      <p class="muted" style="font-size:13.5px">This console operates a hosted wallet. Sign in to continue.</p>
      <form id="login-form" novalidate>
        <div class="field" style="margin:0">
          <label class="field__label" for="login-pw">Password</label>
          <input class="input" id="login-pw" type="password" autocomplete="current-password" placeholder="••••••••" autofocus/>
          <div class="field__err" id="login-err">Incorrect password.</div>
        </div>
        <button type="submit" class="btn btn--primary btn--block mt-18" id="login-submit">${icon("lock", 16)} Sign in</button>
      </form>
    </div>`;
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
    if (!password) return showErr("Enter your password.");
    await withPending(el("login-submit"), "Signing in…", async () => {
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
      let msg = "Incorrect password.";
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
      `<main class="main">${pageHead("Connection problem", "")}
        <div class="banner">${icon("alert", 20)}
          <div class="banner__text"><b>Can't reach the wallet daemon</b>${esc(S.connError)}</div>
          <button class="btn btn--secondary btn--sm" data-action="reconnect">${icon("refresh", 15)} Retry</button>
        </div>
        <div class="callout">${icon("info", 18)}<div>Make sure the local Tari swarm is running and <code>walletd</code> is reachable at <code>${esc(
          S.data ? S.data.config.walletdUrl : "the configured URL",
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
  };

  // theme toggle
  app.querySelectorAll("[data-theme-set]").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeSet));
  });

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
    await withPending(btn, "Refreshing", async () => {
      await refreshState(true);
      render();
      toast("info", "Up to date", "Reloaded from the chain.");
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
    await withPending(btn, "Connecting", async () => {
      try {
        S.data = await api("/api/connect", {});
        S.connError = null;
        render();
        toast("success", "Connected", "Wallet daemon is reachable.");
      } catch (e) {
        S.connError = e.message;
        render();
        toast("error", "Still offline", e.message);
      }
    });
    return;
  }
  if (action === "reset") {
    const ok = await confirmDialog({
      tone: "warn",
      icon: "refresh",
      title: "Reset the demo?",
      body: "This detaches the dashboard from the current budget so you can create a fresh one. The on-chain component itself is not deleted.",
      confirmLabel: "Reset",
    });
    if (!ok) return;
    try {
      S.data = await api("/api/reset", {});
      go("create");
      toast("info", "Reset", "Ready for a new budget.");
    } catch (e) {
      toast("error", "Reset failed", e.message);
    }
    return;
  }
  if (action === "revoke") {
    const ok = await confirmDialog({
      tone: "danger",
      icon: "ban",
      title: "Revoke the agent?",
      body: "The validators will reject <b>every future payment</b> from this agent. This flips the on-chain kill switch and <b>cannot be undone</b>.",
      requireAck: "I understand this permanently blocks the agent.",
      confirmLabel: "Revoke agent",
    });
    if (!ok) return;
    await withPending(btn, "Revoking", async () => {
      try {
        S.data = await api("/api/revoke", {});
        render();
        toast("success", "Agent revoked", "The kill switch is on. Further payments will be rejected on chain.");
      } catch (e) {
        toast("error", "Revoke failed", e.message);
      }
    });
    return;
  }
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

    await withPending(el("f-submit"), "Opening on chain…", async () => {
      try {
        S.data = await api("/api/budget", {
          fund,
          perTxCap,
          dailyCap,
          epochsPerWindow,
          whitelist: draftWhitelist,
        });
        toast("success", "Budget opened", `Funded ${fmt(fund)} ${UNIT} · live on chain.`);
        draftWhitelist = ["shop"];
        go("overview");
      } catch (err) {
        toast("error", "Couldn't open budget", err.message);
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
    await withPending(checkBtn, "Asking the chain…", async () => {
      try {
        const r = await api("/api/dry-run", { merchant: vals.merchant, amount: vals.amount });
        slot.innerHTML = r.ok
          ? `<div class="verdict verdict--ok">${icon("check", 18)}
              <div><div class="verdict__title">The chain would accept this</div>
              <div class="verdict__body">A validator dry-run of paying <b>${fmt(vals.amount)} ${UNIT}</b> to <b>${esc(vals.merchant)}</b> passes every on-chain rule. Hit <b>Pay</b> to submit it for real.</div></div></div>`
          : `<div class="verdict verdict--reject">${icon("ban", 18)}
              <div><div class="verdict__title">The validator would reject this</div>
              <div class="verdict__body">Reason from the chain: <code>${esc(r.reason)}</code><br/>
              This isn't the UI second-guessing you — the on-chain budget refuses it, so the payment can't be forced through.</div></div></div>`;
      } catch (e) {
        toast("error", "Dry-run failed", e.message);
      }
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const vals = readInputs();
    if (!validate(vals)) return;
    slot.innerHTML = "";
    await withPending(el("p-pay"), "Submitting…", async () => {
      try {
        const r = await api("/api/pay", { merchant: vals.merchant, amount: vals.amount, memo: vals.memo || undefined });
        S.data = r;
        toast("success", "Payment sent", `${fmt(vals.amount)} ${UNIT} to ${esc(vals.merchant)} — confirmed on chain.`);
        render();
      } catch (err) {
        if (err.status === 422) {
          // chain / policy rejection — show the friendly verdict inline, not just a toast
          el("verdict-slot") &&
            (el("verdict-slot").innerHTML = `<div class="verdict verdict--reject">${icon("ban", 18)}
              <div><div class="verdict__title">Payment rejected on chain</div>
              <div class="verdict__body">Reason: <code>${esc(err.message)}</code><br/>The validators enforced the budget's rules — nothing was spent.</div></div></div>`);
          toast("error", "Rejected on chain", err.message);
        } else {
          toast("error", "Payment failed", err.message);
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
    await withPending(el("g-add"), "Adding…", async () => {
      try {
        S.data = await api("/api/merchants", { merchant: name });
        render();
        toast("success", "Merchant whitelisted", `${esc(name)} can now receive payments.`);
      } catch (err) {
        toast("error", "Couldn't add merchant", err.message);
      }
    });
  });

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
      title: "Withdraw to owner?",
      body: `Move <b>${fmt(amount)} ${UNIT}</b> from the budget's on-chain vault back to the owner account.`,
      confirmLabel: `Withdraw ${fmt(amount)} ${UNIT}`,
    });
    if (!ok) return;
    await withPending(el("g-withdraw"), "Withdrawing…", async () => {
      try {
        S.data = await api("/api/withdraw", { amount });
        render();
        toast("success", "Withdrawn", `${fmt(amount)} ${UNIT} returned to the owner.`);
      } catch (err) {
        toast("error", "Withdraw failed", err.message);
      }
    });
  });
}

/* ---- boot ----------------------------------------------------------------- */
async function boot() {
  initTheme();
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
