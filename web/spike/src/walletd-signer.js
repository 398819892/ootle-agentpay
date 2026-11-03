// A `Signer` (ootle.ts 0.11 interface) backed by a 0.47 wallet daemon's SIGNING-REQUEST queue.
//
// The dApp never sees the key: it posts the unsigned transaction + the seal public key as a
// `signing_requests.create`, the wallet owner approves it (wallet UI, or `signing_requests.approve`
// with an owner token), and walletd returns the account-key signature. The dApp then seals the
// transaction itself (WASM, throwaway seal key) and submits it to the indexer. This is the 0.47
// counterpart of the `transactions.sign` JRPC that ootle.ts 0.12's WalletDaemonSigner uses on 0.48+.
import { toHexStr } from "@tari-project/ootle";

export class WalletdSigningRequestSigner {
  /**
   * @param rpc  a WalletdRpc holding at least {SigningRequests:"Create"} (+ "Read" to poll)
   * @param opts.keyId      the wallet key to sign with, e.g. {Derived:{index:1,key_branch:"account"}}
   * @param opts.publicKey  hex public key of that key (the account's owner_public_key)
   * @param opts.onRequest  called with the request id once it is queued (the demo auto-approves here)
   * @param opts.pollMs / opts.timeoutMs  how long to wait for the owner's decision
   */
  constructor(rpc, opts) {
    this.rpc = rpc;
    this.keyId = opts.keyId;
    this.publicKey = opts.publicKey;
    this.onRequest = opts.onRequest ?? (() => {});
    this.pollMs = opts.pollMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.lastRequestId = null;
  }
  async getPublicKey() {
    return Uint8Array.from(this.publicKey.match(/../g).map((h) => parseInt(h, 16)));
  }
  async getAddress() {
    return this.publicKey;
  }
  async signTransaction(unsignedTx, sealPublicKey) {
    const created = await this.rpc.call("signing_requests.create", {
      transaction: { V1: unsignedTx },
      seal_public_key: toHexStr(sealPublicKey),
      key_id: this.keyId,
    });
    this.lastRequestId = created.request_id;
    await this.onRequest(created.request_id);
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const { request } = await this.rpc.call("signing_requests.get", { request_id: created.request_id });
      if (request.status === "Signed" && request.signature) return [request.signature];
      if (request.status !== "Pending") throw new Error(`signing request ${created.request_id} was ${request.status}`);
      if (Date.now() > deadline) throw new Error("timed out waiting for the wallet owner to approve the signing request");
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }
}
