// Engine-backed parent frame for the path-C embedding harness.
//
// mock-wallet.html is the WALLET (parent); the real dApp runs in the child iframe and talks to us over
// the "tari-dapp-bridge/1" postMessage protocol. Previously this parent answered with CANNED data. Now it
// answers with the REAL self-built L2 wallet engine (src/l2-wallet.mjs): the key lives only in this page
// (non-custodial), the connect handshake (requestAccounts / getNetwork) is produced by the engine, and
// sign/substate route into the real Ootle lifecycle. With no indexer configured, those tx/read methods
// surface the HONEST live-node gate instead of a fake receipt. Point at a node with ?indexer=esme (or a
// full URL) to drive real calls; override the account with ?account=component_…
import { L2Wallet } from "./l2-wallet.mjs";
import { ESMERALDA } from "./chain.js";
import { Network } from "@tari-project/ootle";

// A dev identity for the shell. Valid small sr25519 scalars (non-canonical ones throw). The key never
// leaves this page; with no indexer it never signs anything real.
const DEV = {
  ownerSecretHex: "01" + "00".repeat(31),
  viewSecretHex: "02" + "00".repeat(31),
  account: "component_f973833d3747d725c48a564d5b6bd4482259013d00722b28fd42814d4365d814",
};

/** Build the bridge handler the parent uses to answer each window.tari method, backed by L2Wallet. */
export function makeWalletHandler(opts = {}) {
  const wallet = new L2Wallet({
    ownerSecretHex: opts.ownerSecretHex ?? DEV.ownerSecretHex,
    viewSecretHex: opts.viewSecretHex ?? DEV.viewSecretHex,
    network: opts.network ?? Network.Esmeralda,
    account: opts.account ?? DEV.account,
    indexerUrl: opts.indexerUrl ?? null, // null = offline shell: tx/reads report the live-node gate
  });
  return async function handle(method, params = {}) {
    switch (method) {
      case "tari_requestAccounts":
      case "tari_getAccounts":
        return wallet.request("tari_requestAccounts");
      case "tari_getNetwork":
        return wallet.request("tari_getNetwork");
      case "tari_getCapabilities":
        return { transactionRequests: true, dryRunIsLocal: true, walletAddress: true };
      case "tari_getSubstate":
        return wallet.request("tari_getSubstate", params);
      case "tari_signAndSubmitTransaction":
        return wallet.request("tari_signAndSubmitTransaction", params);
      default:
        throw Object.assign(new Error("mock wallet: unsupported method " + method), { code: 4200 });
    }
  };
}

// --- browser bootstrap: wire the postMessage bridge + logging (skipped under Node) -------------------
if (typeof window !== "undefined" && typeof document !== "undefined") {
  const PROTOCOL = "tari-dapp-bridge/1";
  const q = new URLSearchParams(window.location.search);
  const ind = q.get("indexer");
  const indexerUrl = ind === "esme" || ind === "esmeralda" ? ESMERALDA.indexerUrl : ind || null;
  const handle = makeWalletHandler({ account: q.get("account") || undefined, indexerUrl });

  const wlog = document.getElementById("wlog");
  const log = (cls, msg) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = new Date().toLocaleTimeString() + "  " + msg;
    wlog.appendChild(d);
    wlog.scrollTop = wlog.scrollHeight;
  };

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || data.protocol !== PROTOCOL || !data.id) return;
    log("in", "→ req " + data.method + (data.params && Object.keys(data.params).length ? " " + JSON.stringify(data.params).slice(0, 80) : ""));
    const reply = { protocol: PROTOCOL, id: data.id };
    try { reply.result = await handle(data.method, data.params || {}); }
    catch (e) { reply.error = { code: e.code || -32603, message: e.message || String(e) }; }
    event.source.postMessage(reply, event.origin);
    log("out", "← " + (reply.error ? "error " + reply.error.code + " — " + reply.error.message : "ok " + data.method));
  });

  log("warn", "engine-backed mock wallet ready — window.tari served by src/l2-wallet.mjs");
  log("warn", "indexer = " + (indexerUrl || "none (tx/reads report the live-node gate); add ?indexer=esme to drive real calls"));
  log("warn", "embedding /window-tari.html (parent origin " + window.location.origin + ")");
}
