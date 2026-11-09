// wallet-connect.js — a self-mounting "connect your non-custodial AgentPay wallet" widget.
//
// The dashboard (this origin, :8787) holds NO key. It loads tari-provider.js (window.tari), which can
// only ENQUEUE a request on the wallet's relay (a separate origin, :7777). The wallet shows its own
// approval, signs with its key, enforces the owner's on-chain caps, and submits. This widget is the UI
// for that: connect (read the account) and pay (one AgentBudget payment the wallet must approve).
//
// Fully decoupled from app.js: it mounts its own floating launcher + panel on DOMContentLoaded, uses
// only the dashboard's design tokens, and talks to the chain exclusively through window.tari. It adds
// no inline <script> (CSP script-src 'self'); inline *styles* are allowed by the dashboard CSP.
(function () {
  "use strict";
  if (!window.tari) { console.warn("[wallet-connect] window.tari not found — is tari-provider.js loaded first?"); return; }
  var tari = window.tari;
  var WALLET = tari.walletOrigin || "http://127.0.0.1:7777";

  // ---- i18n (follow the dashboard's <html lang>) ----
  var L = (document.documentElement.lang || "zh").toLowerCase().indexOf("en") === 0 ? "en" : "zh";
  var T = {
    zh: {
      launch: "连接钱包", connected: "钱包已连接", title: "AgentPay 钱包", sub: "非托管 · 独立来源 :7777",
      connectBtn: "连接 AgentPay 钱包", connecting: "等待钱包批准…",
      connectNote: "点连接后,在你的 AgentPay 钱包(另一个来源 :7777)里批准。钱包没开就先打开它——面板不持有私钥,也不会碰这个页面。",
      noPopup: "钱包还没打开?", openWallet: "打开钱包 ↗",
      payFrom: "付款账户", choose: "选择金额", payBtn: "用钱包支付", paying: "等待钱包批准…",
      paid: "已支付", declined: "被钱包额度拒绝", overTx: "超单笔上限", overDaily: "超每日上限",
      idle: "选好金额点支付,钱包会请你批准。", connFail: "连接失败", disconnect: "断开连接", close: "关闭",
    },
    en: {
      launch: "Connect wallet", connected: "Wallet connected", title: "AgentPay Wallet", sub: "non-custodial · origin :7777",
      connectBtn: "Connect AgentPay Wallet", connecting: "Waiting for wallet approval…",
      connectNote: "After you connect, approve in your AgentPay wallet (a separate origin, :7777). Open it first if it isn't running — the dashboard holds no key and won't touch this page.",
      noPopup: "Wallet not open yet?", openWallet: "Open wallet ↗",
      payFrom: "Paying from", choose: "Choose amount", payBtn: "Pay with wallet", paying: "Waiting for wallet approval…",
      paid: "Paid", declined: "Declined by the wallet's caps", overTx: "over per-tx cap", overDaily: "over daily cap",
      idle: "Pick an amount and pay — the wallet will ask you to approve.", connFail: "Connect failed", disconnect: "Disconnect", close: "Close",
    },
  };
  var t = function (k) { return (T[L] && T[L][k]) || k; };
  var short = function (a) { if (!a) return ""; var i = a.indexOf("_") + 1; return a.slice(0, i) + a.slice(i, i + 8) + "…" + a.slice(-6); };

  // ---- styles (scoped under .apw-*) ----
  var css = ''
    + '.apw-fab{position:fixed;right:max(18px,env(safe-area-inset-right,0px));bottom:max(18px,env(safe-area-inset-bottom,0px));z-index:2147483000;'
    + 'display:inline-flex;align-items:center;gap:8px;font:600 13px/1 var(--font,sans-serif);color:var(--brand-contrast,#fff);'
    + 'background:var(--brand,#8b73ff);border:1px solid var(--brand-700,#6a51f0);border-radius:var(--radius,0px);padding:11px 15px;cursor:pointer;'
    + 'box-shadow:var(--shadow-lg,0 16px 40px rgba(20,20,40,.3));transition:filter .12s;}'
    + '.apw-fab:hover{filter:brightness(1.07);} .apw-fab .apw-dot{width:8px;height:8px;border-radius:50%;background:#fff6;}'
    + '.apw-fab.apw-on{background:var(--surface,#fff);color:var(--text,#172033);border-color:var(--border-strong,#d4dae3);font-family:var(--mono,monospace);}'
    + '.apw-fab.apw-on .apw-dot{background:var(--success,#16a36a);box-shadow:0 0 0 3px color-mix(in srgb,var(--success,#16a36a) 28%,transparent);}'
    + '.apw-panel{position:fixed;right:max(18px,env(safe-area-inset-right,0px));bottom:calc(max(18px,env(safe-area-inset-bottom,0px)) + 52px);z-index:2147483000;'
    + 'width:min(340px,calc(100vw - 32px));background:var(--bg-elev,#fff);color:var(--text,#172033);border:1px solid var(--border,#e7eaf0);'
    + 'border-radius:var(--radius,0px);box-shadow:var(--shadow-lg,0 16px 40px rgba(20,20,40,.3));font:400 13px/1.5 var(--font,sans-serif);overflow:hidden;}'
    + '.apw-hd{display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid var(--border,#e7eaf0);background:var(--surface-2,#f1f3f7);}'
    + '.apw-mark{width:26px;height:26px;border-radius:var(--radius,0px);background:var(--brand,#8b73ff);display:grid;place-items:center;color:#fff;font-weight:700;flex-shrink:0;}'
    + '.apw-hd h4{margin:0;font:600 13px/1.2 var(--font,sans-serif);} .apw-hd .apw-s{font-size:11px;color:var(--text-muted,#64748b);}'
    + '.apw-x{margin-left:auto;background:none;border:0;color:var(--text-faint,#94a3b8);font-size:17px;cursor:pointer;line-height:1;padding:2px 4px;}'
    + '.apw-bd{padding:14px;display:flex;flex-direction:column;gap:11px;}'
    + '.apw-lab{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint,#94a3b8);}'
    + '.apw-btn{font:600 13px/1 var(--font,sans-serif);color:var(--brand-contrast,#fff);background:var(--brand,#8b73ff);border:1px solid var(--brand-700,#6a51f0);'
    + 'border-radius:var(--radius,0px);padding:12px 14px;cursor:pointer;width:100%;transition:filter .12s;} .apw-btn:hover{filter:brightness(1.07);} .apw-btn:disabled{opacity:.55;cursor:progress;}'
    + '.apw-note{font-size:11px;color:var(--text-faint,#94a3b8);line-height:1.6;}'
    + '.apw-link{color:var(--brand,#8b73ff);text-decoration:none;font-weight:500;} .apw-link:hover{text-decoration:underline;}'
    + '.apw-acct{font-size:12px;color:var(--text-muted,#64748b);} .apw-acct b{color:var(--text,#172033);font-family:var(--mono,monospace);font-weight:600;}'
    + '.apw-presets{display:flex;flex-wrap:wrap;gap:6px;} .apw-preset{font:500 12px/1 var(--mono,monospace);color:var(--text-muted,#64748b);background:var(--surface-2,#f1f3f7);'
    + 'border:1px solid var(--border,#e7eaf0);border-radius:var(--radius,0px);padding:7px 11px;cursor:pointer;} .apw-preset:hover{color:var(--text,#172033);}'
    + '.apw-preset.apw-sel{color:var(--brand,#8b73ff);border-color:var(--brand,#8b73ff);background:color-mix(in srgb,var(--brand,#8b73ff) 10%,transparent);}'
    + '.apw-st{border:1px dashed var(--border-strong,#d4dae3);border-radius:var(--radius,0px);padding:10px 11px;font-size:12px;color:var(--text-muted,#64748b);display:flex;align-items:center;gap:8px;min-height:40px;}'
    + '.apw-st.apw-wait{border-style:solid;border-color:var(--brand,#8b73ff);color:var(--brand,#8b73ff);background:color-mix(in srgb,var(--brand,#8b73ff) 8%,transparent);}'
    + '.apw-st.apw-ok{border-style:solid;border-color:var(--success,#16a36a);color:var(--success,#16a36a);background:var(--success-tint,#e3f5ec);}'
    + '.apw-st.apw-no{border-style:solid;border-color:var(--danger,#dc4545);color:var(--danger,#dc4545);background:var(--danger-tint,#fdeaea);}'
    + '.apw-st .apw-mono{font-family:var(--mono,monospace);font-size:11px;opacity:.85;}'
    + '.apw-spin{width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:apw-sp .7s linear infinite;flex-shrink:0;}'
    + '@keyframes apw-sp{to{transform:rotate(360deg);}}'
    + '.apw-foot{display:flex;justify-content:flex-end;} .apw-dc{background:none;border:0;color:var(--text-faint,#94a3b8);font-size:11px;cursor:pointer;text-decoration:underline;}'
    + '.apw-hidden{display:none!important;}';
  var style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  // ---- state ----
  var account = null, amount = 700, open = false;

  // ---- DOM ----
  var fab = document.createElement("button");
  fab.className = "apw-fab"; fab.type = "button";
  fab.innerHTML = '<span class="apw-dot"></span><span class="apw-flab"></span>';

  var panel = document.createElement("div");
  panel.className = "apw-panel apw-hidden";
  panel.innerHTML =
    '<div class="apw-hd"><div class="apw-mark">⌁</div><div><h4>' + esc(t("title")) + '</h4><div class="apw-s">' + esc(t("sub")) + '</div></div><button class="apw-x" type="button" title="' + esc(t("close")) + '">✕</button></div>' +
    '<div class="apw-bd">' +
      '<div class="apw-connect">' +
        '<button class="apw-btn apw-connectBtn" type="button">' + esc(t("connectBtn")) + '</button>' +
        '<p class="apw-note" style="margin:9px 0 0">' + esc(t("connectNote")) + '</p>' +
        '<p class="apw-note" style="margin:3px 0 0">' + esc(t("noPopup")) + ' <a class="apw-link apw-openWallet" href="' + WALLET + '/wallet.html" target="_blank" rel="noopener">' + esc(t("openWallet")) + '</a></p>' +
      '</div>' +
      '<div class="apw-pay apw-hidden">' +
        '<div class="apw-acct"></div>' +
        '<div><div class="apw-lab" style="margin-bottom:6px">' + esc(t("choose")) + '</div><div class="apw-presets"></div></div>' +
        '<button class="apw-btn apw-payBtn" type="button">' + esc(t("payBtn")) + '</button>' +
        '<div class="apw-st"><span>' + esc(t("idle")) + '</span></div>' +
        '<div class="apw-foot"><button class="apw-dc" type="button">' + esc(t("disconnect")) + '</button></div>' +
      '</div>' +
    '</div>';

  var $ = function (sel) { return panel.querySelector(sel); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // presets
  [300, 700, 900, 5000].forEach(function (v) {
    var b = document.createElement("button");
    b.className = "apw-preset" + (v === amount ? " apw-sel" : ""); b.type = "button"; b.textContent = v; b.dataset.amt = v;
    b.addEventListener("click", function () {
      amount = v;
      panel.querySelectorAll(".apw-preset").forEach(function (p) { p.classList.toggle("apw-sel", p === b); });
    });
    $(".apw-presets").appendChild(b);
  });

  function setLaunch() {
    fab.classList.toggle("apw-on", !!account);
    fab.querySelector(".apw-flab").textContent = account ? short(account) : t("launch");
  }
  function setStatus(cls, text, sub) {
    var el = $(".apw-st"); el.className = "apw-st" + (cls ? " apw-" + cls : ""); el.innerHTML = "";
    if (cls === "wait") { var sp = document.createElement("span"); sp.className = "apw-spin"; el.appendChild(sp); }
    var s = document.createElement("span"); s.textContent = text; el.appendChild(s);
    if (sub) { var m = document.createElement("span"); m.className = "apw-mono"; m.textContent = sub; el.appendChild(document.createTextNode(" ")); el.appendChild(m); }
  }
  function showAccount() {
    var el = $(".apw-acct"); el.innerHTML = "";
    var s = document.createElement("span"); s.textContent = t("payFrom") + " ";
    var b = document.createElement("b"); b.textContent = short(account);
    el.append(s, b);
  }
  function toPayStep() { $(".apw-connect").classList.add("apw-hidden"); $(".apw-pay").classList.remove("apw-hidden"); showAccount(); }
  function toConnectStep() { $(".apw-pay").classList.add("apw-hidden"); $(".apw-connect").classList.remove("apw-hidden"); }

  function openPanel(o) { open = o; panel.classList.toggle("apw-hidden", !o); }

  // ---- actions ----
  fab.addEventListener("click", function () { openPanel(!open); });
  $(".apw-x").addEventListener("click", function () { openPanel(false); });

  $(".apw-connectBtn").addEventListener("click", function () {
    // Do NOT open the wallet from here. Opening a window from the dApp (window.open or even a
    // target=_blank anchor) navigates THIS tab in place in embedded webviews / when windows can't be
    // spawned, destroying the dApp and this pending connect(). We only ENQUEUE the connect; the wallet
    // (opened by the user via the "open wallet ↗" link below, or already running) drains + approves it.
    var btn = $(".apw-connectBtn"); btn.disabled = true; btn.textContent = t("connecting");
    tari.connect().then(function (accts) {
      account = Array.isArray(accts) ? accts[0] : accts;
      setLaunch(); toPayStep();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = t("connectBtn");
      toPayStep(); setStatus("no", "✕ " + t("connFail") + " — " + (e && e.message || e));
    });
  });

  $(".apw-payBtn").addEventListener("click", function () {
    var btn = $(".apw-payBtn"); btn.disabled = true; setStatus("wait", t("paying"));
    tari.request({ method: "tari_signAndSubmitTransaction", params: { pay: { amount: amount, memo: "AgentPay dashboard · demo pay" } } })
      .then(function (r) {
        if (r && r.committed) {
          setStatus("ok", "✓ " + t("paid"), r.txid ? String(r.txid).slice(0, 18) + "…" : "");
        } else {
          var why = /per-transaction/.test(r && r.reason || "") ? t("overTx") : /daily/.test(r && r.reason || "") ? t("overDaily") : "";
          setStatus("no", "✕ " + t("declined"), why);
        }
      }).catch(function (err) { setStatus("no", "✕ " + (err && err.message || err)); })
      .then(function () { btn.disabled = false; });
  });

  $(".apw-dc").addEventListener("click", function () {
    try { tari.disconnect(); } catch (e) {}
    fetch(WALLET + "/bridge/unlink", { method: "POST" }).catch(function () {});
    account = null; setLaunch(); toConnectStep(); openPanel(false);
    var cb = $(".apw-connectBtn"); cb.disabled = false; cb.textContent = t("connectBtn");
  });

  // ---- mount ----
  function mount() { setLaunch(); document.body.appendChild(fab); document.body.appendChild(panel); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
