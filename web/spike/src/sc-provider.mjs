// sc-provider.mjs — an IN-PAGE, same-origin window.tari backed by a browser-held self-custody key.
//
// This is the non-relay counterpart of web/public/tari-provider.js. There, the dApp and the wallet are
// SEPARATE origins and a request is relayed (POST /bridge/req → the wallet polls, signs, posts back).
// Here the dApp and the wallet are the SAME page: the keystore + signer live in this page, so a request
// is dispatched IN-PAGE and the Promise resolves directly — no relay, no second window. The private key
// never leaves the browser; every write is approved here and signed here (sc-chain → chain.signSealSubmit),
// submitted straight to the indexer. This is what turns the agentpay dashboard into one self-custody dApp.
//
// The module is DOM-agnostic: the host (the page) injects keystore-state accessors, an approval UI, and
// optionally the chain ops (defaulting to sc-chain) so the dispatch is unit-testable with stubs. It exposes
// the exact window.tari contract app.js already speaks (connect/request/account/connected + the
// tari#initialized / tari#connect / tari#disconnect window events), so the dashboard works unchanged.
import * as scChain from "./sc-chain.mjs";

const RE_COMPONENT = /^component_[0-9a-f]{64}$/;
const err = (m) => { throw new Error(m); };

/**
 * Build the in-page provider. `host`:
 *   getWallet()   -> the unlocked SecretKeyWallet, or null when the wallet is locked
 *   getAccount()  -> the active account's component address, or null when none is created yet
 *   getBudget()   -> { component, merchant, template, ownerBadge } for the active budget, or null
 *   getIndexer()  -> Promise<IndexerProvider> (connect + memoize in the host)
 *   approve({title, origin, approveLabel, rows:[{label,value,mono?}], check?:{ok,text}, note?}) -> Promise<boolean>
 *                 (the host's approval modal; rows are the DECODED intent, rendered as escaped text — no blind-signing)
 *   onChange?()   -> called after a committed write so the host can refresh its own views
 *   chain?        -> { balanceOf, readBudget, payBudget, setLimits, setMerchant, sendXtr } (defaults to sc-chain)
 *   network?      -> "localnet"
 */
export function createInPageTari(host) {
  const chain = host.chain || scChain;
  const network = host.network || "localnet";
  const approve = host.approve || (async () => true);
  const changed = () => { try { host.onChange && host.onChange(); } catch { /* host UI hook is best-effort */ } };
  let connected = false;

  const requireUnlocked = () => host.getWallet() || err("钱包已锁定,请先解锁");
  const requireConnected = () => { if (!connected) err("请先连接钱包 (4100)"); };
  const requireAccount = () => host.getAccount() || err("钱包尚无链上账户,请先在钱包里创建/充值账户");
  const requireBudget = () => host.getBudget() || err("钱包尚未开通预算(请先在钱包里开预算)");
  const approveOrReject = async (spec) => { if (!(await approve(spec))) err("用户拒绝 (4001)"); };
  const amtInt = (v) => { const s = String(v); if (!/^\d+$/.test(s) || BigInt(s) <= 0n) err("金额必须为正整数"); return s; };
  // Decode a pending payment against the live budget so the approval shows a plain-language verdict instead
  // of a blind "approve". Mirrors the on-chain assertions (revoked / per-tx / daily / whitelist) best-effort;
  // the chain stays the source of truth — this only tells the user what WILL happen before they sign.
  const _big = (v) => { try { return BigInt(v); } catch { return null; } };
  function payWithinCaps(amount, merchant, state) {
    if (!state) return { ok: true, text: "将按链上额度校验。" };
    if (state.revoked) return { ok: false, text: "该预算已被停用,这笔付款会被链上拒绝。" };
    const perTx = _big(state.perTx), daily = _big(state.daily), spent = _big(state.spent);
    if (perTx != null && amount > perTx) return { ok: false, text: `金额超过单笔上限 ${state.perTx} XTR,将被链上拒绝。` };
    if (daily != null && spent != null && spent + amount > daily)
      return { ok: false, text: `将超过每日上限(已花 ${state.spent} + 本次 ${amount} > ${state.daily}),将被链上拒绝。` };
    if (Array.isArray(state.whitelist) && !state.whitelist.includes(merchant))
      return { ok: false, text: "商户不在白名单,将被链上拒绝。" };
    return { ok: true, text: "金额在单笔与每日额度内 ✓" };
  }

  async function dispatch(method, params) {
    const origin = location.origin;
    params = params || {};

    if (method === "tari_requestAccounts") {
      const account = requireAccount();
      await approveOrReject({ title: "连接请求", origin, approveLabel: "连接",
        rows: [{ label: "账户地址", value: account, mono: true }],
        note: "连接后该页面可看到你的账户地址并请求付款;每一笔仍需你在此单独批准、由本浏览器签名。" });
      connected = true;
      return [account];
    }

    if (method === "tari_getAccount") {
      requireConnected();
      const account = requireAccount();
      let balance = null;
      try { balance = (await chain.balanceOf(await host.getIndexer(), account)).toString(); } catch { /* leave null */ }
      return { account, network, balance };
    }

    // READ — the dashboard's budget view. No signing, no approval. budget:null when none is open.
    if (method === "tari_getBudget" || method === "tari_getState") {
      requireConnected();
      const account = requireAccount();
      const b = host.getBudget();
      if (!b) return { account, network, merchant: null, template: (b && b.template) || null, agentAccount: account, twoAccount: false, linkedOrigin: origin, budget: null };
      const wb = await chain.readBudget(await host.getIndexer(), b.component);
      // caps / spent / treasury / whitelist are live chain facts (readBudget). The history the chain can't
      // rebuild — lifetime funded/withdrawn, the pay feed, the issued-session set — comes from the wallet's
      // own browser journal (host.getJournal), so the dashboard view is whole with NO backend.
      const j = (host.getJournal && host.getJournal(b.component)) || { funded: null, withdrawn: null, ledger: [], sessions: [] };
      return {
        account, network, merchant: b.merchant, template: b.template || null, agentAccount: account, twoAccount: false, linkedOrigin: origin,
        budget: {
          address: wb.address, perTx: wb.perTx, daily: wb.daily, spent: wb.spent, vault: wb.vault,
          whitelist: wb.whitelist, revoked: wb.revoked,
          funded: j.funded, withdrawn: j.withdrawn, sessions: j.sessions || [], ledger: j.ledger || [],
        },
      };
    }

    // WRITE — budget payment: approved here, browser-signed with the agent badge, caps enforced on-chain.
    if (method === "tari_signAndSubmitTransaction" && params.pay) {
      requireConnected();
      const wallet = requireUnlocked();
      const account = requireAccount();
      const b = requireBudget();
      let amount;
      try { amount = BigInt(Math.trunc(Number(params.pay.amount))); } catch { err("金额无效"); }
      if (amount <= 0n) err("金额必须大于 0");
      const memo = params.pay.memo || "";
      // The payee is the whitelisted merchant the dApp picked (params.pay.merchant); budgets are no longer
      // bound to a single merchant at open — the whitelist is managed separately, so a pay names its target.
      // Fall back to the budget's legacy single merchant for older budgets opened with one baked in.
      const merchant = (params.pay.merchant && String(params.pay.merchant).trim()) || b.merchant;
      if (!RE_COMPONENT.test(merchant || "")) err("请选择一个有效的收款商户地址(component_ 开头的 64 位十六进制)");
      // Read the live budget BEFORE approval so the modal shows the DECODED intent — amount, merchant and
      // the on-chain caps — and a self-check of this payment against them, so the user never blind-signs.
      // The same fresh state is reused for the signed pay (one read, not two).
      const provider = await host.getIndexer();
      const state = await chain.readBudget(provider, b.component);
      const check = payWithinCaps(amount, merchant, state);
      const rows = [
        { label: "预算", value: b.component, mono: true },
        { label: "商户", value: merchant, mono: true },
        { label: "金额", value: `${amount.toString()} XTR` },
      ];
      if (memo) rows.push({ label: "备注", value: String(memo) });
      rows.push({ label: "单笔上限", value: `${state.perTx} XTR` });
      rows.push({ label: "每日上限", value: `${state.daily} XTR` });
      rows.push({ label: "本窗口已花", value: `${state.spent} XTR` });
      await approveOrReject({ title: "预算付款请求", origin, approveLabel: "确认付款", rows, check,
        note: "链上强制额度;即便你批准,超限或非白名单仍会被链上拒绝。" });
      const r = await chain.payBudget(provider, wallet, { account, budget: b.component, state, merchant, amount, memo });
      if (r.committed) {
        // append the pay to this budget's browser journal — the chain keeps spend totals but not a per-pay feed
        if (host.recordPay) host.recordPay({ component: b.component, merchant, amount: amount.toString(), memo, txid: r.txid || null });
        changed();
      }
      return { committed: !!r.committed, txid: r.txid || null, amount: amount.toString(), reason: r.reason || "" };
    }

    // WRITE (owner-gated) — change caps / whitelist: owner-badge proof, browser-signed, approved here.
    if (method === "tari_signAndSubmitTransaction" && (params.setLimits || params.addMerchant || params.removeMerchant)) {
      requireConnected();
      const wallet = requireUnlocked();
      const account = requireAccount();
      const b = requireBudget();
      const provider = await host.getIndexer();
      const common = { owner: account, budget: b.component, ownerBadge: b.ownerBadge };
      if (params.setLimits) {
        const { perTxCap, dailyCap } = params.setLimits;
        if (!/^\d+$/.test(String(perTxCap)) || !/^\d+$/.test(String(dailyCap))) err("额度必须是整数");
        await approveOrReject({ title: "修改额度", origin, approveLabel: "确认",
          rows: [{ label: "单笔上限", value: `${perTxCap} XTR` }, { label: "每日上限", value: `${dailyCap} XTR` }, { label: "预算", value: b.component, mono: true }] });
        const r = await chain.setLimits(provider, wallet, { ...common, perTxCap: String(perTxCap), dailyCap: String(dailyCap) });
        if (r.committed) changed();
        return { committed: !!r.committed, txid: r.txid || null, reason: r.reason || "" };
      }
      const add = !!params.addMerchant;
      const merchant = ((params.addMerchant || params.removeMerchant) || {}).merchant;
      if (!RE_COMPONENT.test(merchant || "")) err("商户地址应为 component_ 开头的 64 位十六进制");
      await approveOrReject({ title: add ? "加入白名单" : "移出白名单", origin, approveLabel: "确认",
        rows: [{ label: "商户", value: merchant, mono: true }, { label: "预算", value: b.component, mono: true }],
        note: add ? "加入后该商户可从本预算收款。" : "移出后该商户将无法再从本预算收款。" });
      const r = await chain.setMerchant(provider, wallet, { ...common, merchant, add });
      if (r.committed) changed();
      return { committed: !!r.committed, txid: r.txid || null, reason: r.reason || "" };
    }

    // WRITE (owner-gated lifecycle) — fund / withdraw the vault, issue / revoke session badges, kill switch.
    // Each is owner-badge proven, browser-signed, approved here. topUp funds / withdraw pulls the vault and
    // the browser journal mirrors the lifetime totals; issue/revoke session update the journal's session set
    // (the chain substate doesn't list it); revoke flips the on-chain global kill switch (read live from chain).
    if (method === "tari_signAndSubmitTransaction" && (params.topUp || params.withdraw || params.issueSession || params.revokeSession || params.revoke)) {
      requireConnected();
      const wallet = requireUnlocked();
      const account = requireAccount();
      const b = requireBudget();
      const provider = await host.getIndexer();
      const owner = account;

      if (params.topUp) {
        const amount = amtInt(params.topUp.amount);
        await approveOrReject({ title: "注资预算", origin, approveLabel: "确认注资",
          rows: [{ label: "预算", value: b.component, mono: true }, { label: "注入金额", value: `${amount} XTR` }],
          note: "从你的账户余额支付(手续费另计)。" });
        const r = await chain.topUp(provider, wallet, { owner, budget: b.component, amount });
        if (r.committed) { if (host.recordFunded) host.recordFunded(b.component, amount); changed(); }
        return { committed: !!r.committed, txid: r.txid || null, reason: r.reason || "" };
      }
      if (params.withdraw) {
        const amount = amtInt(params.withdraw.amount);
        await approveOrReject({ title: "从预算提款", origin, approveLabel: "确认提款",
          rows: [{ label: "预算", value: b.component, mono: true }, { label: "提取金额", value: `${amount} XTR` }],
          note: "owner 权限;提回你的账户,浏览器签名。" });
        const r = await chain.withdraw(provider, wallet, { owner, budget: b.component, amount });
        if (r.committed) { if (host.recordWithdrawn) host.recordWithdrawn(b.component, amount); changed(); }
        return { committed: !!r.committed, txid: r.txid || null, reason: r.reason || "" };
      }
      if (params.issueSession) {
        const session = String((params.issueSession.session || "")).trim();
        if (!session) err("会话名称不能为空");
        await approveOrReject({ title: "发放 Agent 会话", origin, approveLabel: "确认发放",
          rows: [{ label: "预算", value: b.component, mono: true }, { label: "会话徽章", value: session }],
          note: "该会话可在同样的额度内付款。" });
        const r = await chain.issueSession(provider, wallet, { owner, agent: owner, budget: b.component, session });
        if (r.committed) { if (host.recordSessionIssued) host.recordSessionIssued(b.component, session); changed(); }
        return { committed: !!r.committed, txid: r.txid || null, reason: r.reason || "" };
      }
      if (params.revokeSession) {
        const session = String((params.revokeSession.session || "")).trim();
        if (!session) err("会话名称不能为空");
        await approveOrReject({ title: "撤销 Agent 会话", origin, approveLabel: "确认撤销",
          rows: [{ label: "预算", value: b.component, mono: true }, { label: "会话徽章", value: session }],
          note: "该会话将无法再付款;其他会话不受影响。" });
        const r = await chain.revokeSession(provider, wallet, { owner, budget: b.component, session });
        if (r.committed) { if (host.recordSessionRevoked) host.recordSessionRevoked(b.component, session); changed(); }
        return { committed: !!r.committed, txid: r.txid || null, reason: r.reason || "" };
      }
      // params.revoke — the global kill switch (every further pay rejected on chain)
      await approveOrReject({ title: "停用预算", origin, approveLabel: "确认停用",
        rows: [{ label: "预算", value: b.component, mono: true }],
        check: { ok: false, text: "停用后这个预算的所有付款都会被链上拒绝(不可逆于本预算)。" } });
      const r = await chain.revoke(provider, wallet, { owner, budget: b.component });
      if (r.committed) changed();
      return { committed: !!r.committed, txid: r.txid || null, reason: r.reason || "" };
    }

    // WRITE — plain XTR transfer from the owner's own balance.
    if (method === "tari_sendTransaction" || (method === "tari_signAndSubmitTransaction" && params.transfer)) {
      requireConnected();
      const wallet = requireUnlocked();
      const from = requireAccount();
      const p = params.transfer || params;
      const to = p.to;
      if (!RE_COMPONENT.test(to || "")) err("收款地址无效(应为 component_ 开头的 64 位十六进制)");
      if (to === from) err("不能给自己转账");
      let amount;
      try { amount = BigInt(p.amount); } catch { err("金额无效"); }
      if (amount <= 0n) err("金额必须大于 0");
      await approveOrReject({ title: "付款请求", origin, approveLabel: "确认付款",
        rows: [{ label: "收款地址", value: to, mono: true }, { label: "金额", value: `${amount.toString()} XTR` }, { label: "付款账户", value: from, mono: true }],
        note: "从你的自持余额支付(手续费另计)。" });
      const { txId } = await chain.sendXtr(await host.getIndexer(), wallet, from, to, amount);
      changed();
      return { txId };
    }

    err("不支持的方法 " + method);
  }

  const provider = {
    isTari: true,
    inPage: true,
    get connected() { return connected; },
    get account() { return host.getAccount(); },
    async connect() {
      const accts = await dispatch("tari_requestAccounts", null);
      window.dispatchEvent(new CustomEvent("tari#connect", { detail: { account: host.getAccount() } }));
      return accts;
    },
    // Same-origin merged page: once the user has unlocked the wallet on THIS page, linking the in-page
    // dashboard to it is not a cross-site authorization — so connect silently, no approval modal. Every
    // payment is still approved individually. Returns false (stays disconnected) until an account exists.
    _autoConnect() {
      if (connected) return true;
      const account = host.getAccount();
      if (!account) return false;
      connected = true;
      window.dispatchEvent(new CustomEvent("tari#connect", { detail: { account } }));
      return true;
    },
    request(args) { args = args || {}; return dispatch(args.method, args.params); },
    disconnect() { connected = false; window.dispatchEvent(new CustomEvent("tari#disconnect")); },
    openWallet() { try { return !!(host.openWallet && host.openWallet()); } catch { return false; } },
    // the host calls this when it locks/forgets the wallet, so a linked dApp sees the drop
    _notifyLocked() { connected = false; window.dispatchEvent(new CustomEvent("tari#disconnect")); },
  };
  return provider;
}

/** Install the in-page provider as window.tari and announce it (matches tari-provider.js's boot event). */
export function installInPageTari(host, win = (typeof window !== "undefined" ? window : undefined)) {
  const provider = createInPageTari(host);
  if (win) { win.tari = provider; win.dispatchEvent(new Event("tari#initialized")); }
  return provider;
}
