// A self-built, non-custodial L2 (Ootle) wallet engine for our own dapp.
//
// It holds the user's Ootle key LOCALLY (SecretKeyWallet, imported from secret bytes — not generated,
// because 0.50.1's random keygen traps) and exposes the SAME `window.tari` provider contract the dapp
// already speaks (tari_requestAccounts / tari_getNetwork / tari_signAndSubmitTransaction /
// tari_getSubstate). So the dapp connects to THIS instead of Tari Universe / Sapient, and we own both
// sides — no dev-tapplet, no hosted wallet dependency.
//
// Signing path = flow A's proven lifecycle (chain.js signSealSubmit: resolve → sign → seal → submit →
// watch). NOTE: an Ootle tx cannot be signed purely offline — `resolveTransaction` needs a live indexer
// to stamp the signer + input versions (the builder leaves main_signer:"None"). So a REAL signature /
// payment needs a running indexer + a funded account; that is the known L2 gate, not a code gap. The
// non-network parts (local-key identity, the provider surface, routing) are exercised offline by
// node/l2-wallet-flow.mjs.
import { Network, TransactionBuilder, resolveMaxEpoch, fromHexStr } from "@tari-project/ootle";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { connectIndexer, signSealSubmit, dryRun } from "./chain.js";

export function networkName(net) {
  if (net === Network.MainNet) return "mainnet";
  if (net === Network.StageNet) return "stagenet";
  if (net === Network.NextNet) return "nextnet";
  if (net === Network.Esmeralda) return "esmeralda";
  if (net === Network.Igor) return "igor";
  if (net === Network.LocalNet) return "localnet";
  return String(net);
}

export class L2Wallet {
  /**
   * @param {object} o
   * @param {string} o.ownerSecretHex  32-byte hex sr25519 owner secret (imported; non-custodial — stays here)
   * @param {string} o.viewSecretHex   32-byte hex view secret
   * @param {number} [o.network=Network.Esmeralda]
   * @param {string|null} [o.account]  the account component address (known after it is created/funded)
   * @param {string} [o.indexerUrl]
   * @param {object} [o.provider]       inject an indexer provider (tests); else lazily connected
   */
  constructor({ ownerSecretHex, viewSecretHex, network = Network.Esmeralda, account = null, indexerUrl, provider = null }) {
    this.wallet = SecretKeyWallet.fromSecretKey(fromHexStr(ownerSecretHex), network, fromHexStr(viewSecretHex));
    this.network = network;
    this.account = account;
    this.indexerUrl = indexerUrl;
    this._provider = provider;
  }

  async indexer() {
    if (this._provider) return this._provider;
    if (!this.indexerUrl) throw Object.assign(new Error("no indexer configured — real signing/reads need a live Ootle node"), { code: -32603 });
    return (this._provider = await connectIndexer(this.indexerUrl, this.network));
  }

  /** The object the dapp sees as `window.tari`. Same shape Tari Universe / Sapient expose. */
  windowTari() {
    return { isTariWallet: true, request: ({ method, params }) => this.request(method, params ?? {}) };
  }

  /** Handle one window.tari RPC. */
  async request(method, params = {}) {
    switch (method) {
      case "tari_requestAccounts":
        if (!this.account) throw Object.assign(new Error("no account yet — create/fund one first"), { code: 4100 });
        return [this.account];

      case "tari_getNetwork":
        return networkName(this.network);

      case "tari_getSubstate": {
        const p = await this.indexer();
        return p.getSubstate(params.substateId ?? params.substate_id ?? params);
      }

      case "tari_signAndSubmitTransaction": {
        // Two accepted shapes:
        //  (a) STANDARD window.tari contract: { instructions, maxFee, inputs?, dryRun? } — the wallet
        //      rebuilds the tx (fee + epoch + inputs), exactly as Tari Universe / Sapient do.
        //  (b) our own-stack shortcut: { unsignedTransaction } — sign the fully built tx as-is.
        // Either way the signature needs a live indexer (resolve stamps the signer + input versions).
        const p = await this.indexer();
        const unsigned = params.unsignedTransaction ?? params.unsigned_transaction ?? await this.#rebuild(p, params);
        if (params.dryRun) return dryRun(p, [this.wallet], unsigned);
        const { receipt } = await signSealSubmit(p, [this.wallet], unsigned);
        return receipt; // dapp's normaliseReceipt accepts this
      }

      default:
        throw Object.assign(new Error("unsupported method " + method), { code: 4200 });
    }
  }

  // Rebuild a full unsigned tx from the standard bridge payload { instructions, maxFee, inputs }.
  // The fee is paid from this wallet's account; the epoch window comes from the live indexer. On the bare
  // indexer the dapp must DECLARE inputs (walletd's detect_inputs isn't available), so we pass them through.
  async #rebuild(provider, params) {
    if (!Array.isArray(params.instructions) || params.instructions.length === 0)
      throw Object.assign(new Error("signAndSubmit needs params.instructions (or params.unsignedTransaction)"), { code: 4200 });
    if (!this.account) throw Object.assign(new Error("wallet has no account to pay the fee from"), { code: 4100 });
    const maxEpoch = await resolveMaxEpoch(provider);
    return TransactionBuilder.new(this.network, maxEpoch)
      .withInputs(params.inputs ?? [])
      .feeTransactionPayFromComponent(this.account, BigInt(params.maxFee ?? 200_000))
      .withInstructions(params.instructions)
      .buildUnsignedTransaction();
  }

  // convenience for a page/driver that wants the max epoch (same as the builders use)
  async maxEpoch() { return resolveMaxEpoch(await this.indexer()); }
}
