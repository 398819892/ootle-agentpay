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
 *   approve({title, origin, lines[]}) -> Promise<boolean>   (the host's approval modal)
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

  async function dispatch(method, params) {
    const origin = location.origin;
    params = params || {};

    if (method === "tari_requestAccounts") {
      const account = requireAccount();
      await approveOrReject({ title: "连接请求", origin, approveLabel: "连接",
        lines: ["该页面请求连接你的自持钱包。", "连接后它将看到你的账户地址:", `<b class="mono">${account}</b>`] });
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
      return {
        account, network, merchant: b.merchant, template: b.template || null, agentAccount: account, twoAccount: false, linkedOrigin: origin,
        budget: { address: wb.address, perTx: wb.perTx, daily: wb.daily, spent: wb.spent, vault: wb.vault, whitelist: wb.whitelist, funded: null, withdrawn: null, sessions: [], ledger: [] },
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
      await approveOrReject({ title: "预算付款请求", origin, approveLabel: "确认付款",
        lines: [`从预算 <b class="mono">${b.component}</b>`, `向商户 <b class="mono">${b.merchant}</b>`, `支付 <b>${amount.toString()} XTR</b>`, `<span class="mut">链上强制额度;超限或非白名单将被拒。</span>`] });
      const provider = await host.getIndexer();
      const state = await chain.readBudget(provider, b.component); // fresh vault + badge ids
      const r = await chain.payBudget(provider, wallet, { account, budget: b.component, state, merchant: b.merchant, amount, memo });
      if (r.committed) changed();
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
          lines: [`单笔上限 <b>${perTxCap} XTR</b>`, `每日上限 <b>${dailyCap} XTR</b>`, `<span class="mut">预算 ${b.component}</span>`] });
        const r = await chain.setLimits(provider, wallet, { ...common, perTxCap: String(perTxCap), dailyCap: String(dailyCap) });
        if (r.committed) changed();
        return { committed: !!r.committed, txid: r.txid || null, reason: r.reason || "" };
      }
      const add = !!params.addMerchant;
      const merchant = ((params.addMerchant || params.removeMerchant) || {}).merchant;
      if (!RE_COMPONENT.test(merchant || "")) err("商户地址应为 component_ 开头的 64 位十六进制");
      await approveOrReject({ title: add ? "加入白名单" : "移出白名单", origin, approveLabel: "确认",
        lines: [`商户 <b class="mono">${merchant}</b>`, `<span class="mut">预算 ${b.component}</span>`] });
      const r = await chain.setMerchant(provider, wallet, { ...common, merchant, add });
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
        lines: [`向 <b class="mono">${to}</b>`, `发送 <b>${amount.toString()} XTR</b>`, `<span class="mut">从 ${from} 的自持余额支付(手续费另计)</span>`] });
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
