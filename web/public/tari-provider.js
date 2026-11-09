// tari-provider.js — the injected wallet provider a dApp loads to reach an INDEPENDENT wallet.
//
// This is the "一种方式" (the mechanism). The dApp (its own origin) never holds a key and has no
// signing backend. It loads this script, which defines window.tari. A request is placed on a RELAY
// the wallet hosts (WalletConnect-style): the dApp can only ENQUEUE a request, it can never sign.
// The wallet (a different origin, in its own window/tab) polls the relay, shows its own approval,
// signs with its key and submits, then posts the result back. The two are fully independent browsing
// contexts — no shared window handle, no iframe — which is exactly what keeps the dApp non-custodial.
//
// Why a relay and not window.postMessage? Because the wallet and the dApp are separate windows the
// dApp does not own. A relay lets them be truly independent (even different tabs opened by hand, or in
// principle different devices) and needs no popup/opener coupling.
//
//   window.tari.connect()                      -> [account]   (wallet must be open; user approves the link)
//   window.tari.request({ method, params })     -> result      (wallet approves + signs each call)
//   window.tari.openWallet()                    -> opens the wallet's own window (best effort)
//   window.tari.connected / .account            -> current link state
//   events on window: "tari#initialized", "tari#connect"
//
// Configure the wallet origin on the <script> tag:
//   <script src="tari-provider.js" data-wallet-origin="http://127.0.0.1:7777" data-wallet-path="/wallet.html"></script>
(function () {
  "use strict";
  const self = document.currentScript;
  const WALLET_ORIGIN = (self && self.getAttribute("data-wallet-origin")) || "http://127.0.0.1:7777";
  const WALLET_PATH = (self && self.getAttribute("data-wallet-path")) || "/wallet.html";

  let connected = false;
  let account = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function currentLang() {
    try { return new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh"; } catch { return "zh"; }
  }

  // Enqueue one request on the wallet's relay, then poll for the wallet's answer.
  async function relayRequest(method, params, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 180000;
    let posted;
    try {
      posted = await fetch(WALLET_ORIGIN + "/bridge/req", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
    } catch (e) {
      throw new Error("cannot reach the wallet relay at " + WALLET_ORIGIN);
    }
    if (!posted.ok) throw new Error("wallet relay refused the request (" + posted.status + ")");
    const { id } = await posted.json();

    const deadline = Date.now() + timeoutMs; // default 3min to let the human approve; reads pass a short one
    while (Date.now() < deadline) {
      await sleep(700);
      let r;
      try { r = await fetch(WALLET_ORIGIN + "/bridge/res?id=" + id); } catch { continue; }
      if (!r.ok) continue;
      const j = await r.json();
      if (j.done) {
        if (j.error) throw new Error(j.error);
        return j.result;
      }
    }
    throw new Error("timed out waiting for the wallet to answer");
  }

  window.tari = {
    isTari: true,
    walletOrigin: WALLET_ORIGIN,
    get connected() { return connected; },
    get account() { return account; },
    // Open the wallet in its own window. Best effort: in a normal browser this is a popup/tab; some
    // embedded webviews navigate in place instead, so the dApp should also let the user open it by hand.
    openWallet() {
      // Open the wallet in ITS OWN browsing context — never the dApp's. `window.open(url, name,
      // features)` makes some embedded webviews (and popup blockers) navigate THIS tab in place, which
      // destroys the dApp page and its pending connect()/request() — the connect then hangs forever. A
      // named-target anchor click always targets a SEPARATE context (new tab, or the existing
      // "tari-wallet" one reused), so the dApp page is preserved whether the wallet opens, is reused, or
      // is suppressed. Returns true on a best-effort open; the dApp should still offer a manual link.
      const url = WALLET_ORIGIN + WALLET_PATH + "?lang=" + encodeURIComponent(currentLang());
      try {
        const a = document.createElement("a");
        a.href = url; a.target = "tari-wallet"; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        return true;
      } catch { return false; }
    },
    async connect() {
      const accts = await relayRequest("tari_requestAccounts");
      account = Array.isArray(accts) ? accts[0] : accts;
      connected = true;
      window.dispatchEvent(new CustomEvent("tari#connect", { detail: { account } }));
      return accts;
    },
    request(args) {
      args = args || {};
      return relayRequest(args.method, args.params, { timeoutMs: args.timeoutMs });
    },
    disconnect() { connected = false; account = null; window.dispatchEvent(new CustomEvent("tari#disconnect")); },
  };

  window.dispatchEvent(new Event("tari#initialized"));
})();
