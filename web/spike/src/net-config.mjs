// net-config.mjs — the single source of truth for which Ootle network the wallet talks to.
//
// Everything network-scoped (the WASM Network enum used to build/address transactions, the default
// indexer URL, whether a built-in XTR faucet exists) is resolved from one place keyed by a short network
// NAME ("localnet" | "mainnet" | ...). The name is what travels through config: the server's
// AGENTPAY_NETWORK env → /api/status.network → the wallet's persisted settings.network. Callers map the
// name to the enum via netByName(name).network and never hardcode a specific net.
//
// Indexer URLs here are DEFAULTS only — /api/status.indexer or the wallet's saved settings.indexer
// override them. The mainnet endpoint is the Tari public indexer (verified live 2026-11-11:
// GET https://indexer-a.ootle.tari.com/network -> {"network":"mainnet","network_byte":0,...}); -b is its
// peer. Faucet-less networks (main/stage/next) have no built-in XTR faucet: an account is funded by
// receiving a real transfer to its (key-derived) address — on mainnet, your Tari Universe burn payout.
import { Network } from "@tari-project/ootle";

export const NETWORKS = {
  mainnet:   { network: Network.MainNet,   indexerUrl: "https://indexer-a.ootle.tari.com",     hasFaucet: false, label: "MainNet" },
  stagenet:  { network: Network.StageNet,  indexerUrl: "",                                      hasFaucet: false, label: "StageNet" },
  nextnet:   { network: Network.NextNet,   indexerUrl: "",                                      hasFaucet: false, label: "NextNet" },
  esmeralda: { network: Network.Esmeralda, indexerUrl: "https://esme-indexer-a.ootle.tari.com", hasFaucet: true,  label: "Esmeralda" },
  localnet:  { network: Network.LocalNet,  indexerUrl: "http://127.0.0.1:12008",                hasFaucet: true,  label: "LocalNet" },
};

export const DEFAULT_NETWORK = "localnet";

/** Resolve a network NAME (case-insensitive) to its config. Unknown/empty → the default (localnet). */
export function netByName(name) {
  return NETWORKS[String(name || "").trim().toLowerCase()] || NETWORKS[DEFAULT_NETWORK];
}

/** Map a WASM Network enum back to its short name. */
export function networkName(net) {
  for (const [k, v] of Object.entries(NETWORKS)) if (v.network === net) return k;
  return String(net);
}

/** The WASM Network enum for a name (localnet default). */
export function networkEnum(name) {
  return netByName(name).network;
}

/** Whether a network has a built-in XTR faucet (localnet/esmeralda) vs needs a real deposit (main/stage/next). */
export function hasFaucet(name) {
  return netByName(name).hasFaucet;
}
