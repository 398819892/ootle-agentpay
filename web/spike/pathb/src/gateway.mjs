// The budget gateway — the software "執法官" for Path B.
//
// It is the ONLY thing that can reach the wallet's gRPC. The agent calls `pay(merchant, amount)`; the
// gateway checks the quota (whitelist / per-tx cap / rolling daily cap / total budget) and ONLY if every
// check passes does it call the headless minotari wallet's `Transfer` (a one-sided XTM send that signs +
// broadcasts with NO confirmation). Over-quota or non-whitelisted requests are rejected WITHOUT ever
// touching the wallet — so a rogue/looping agent can never sign a payment itself or exceed the caps.
//
// Enforcement here is software (the gateway + the dedicated wallet's balance as a hard ceiling), not an
// on-chain contract — that's the Path B trade-off. See web/spike/pathb/README.md.
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO = join(HERE, "..", "wallet.proto");

/** Load a Wallet gRPC client bound to `address` (e.g. "127.0.0.1:18143"). Insecure = local only. */
export function loadWalletClient(address, creds = grpc.credentials.createInsecure()) {
  const def = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, enums: String, defaults: true });
  const pkg = grpc.loadPackageDefinition(def).tari.rpc;
  return new pkg.Wallet(address, creds);
}

/** Promisify a unary gRPC call: unary(client, "Transfer", req) -> Promise<resp>. */
export function unary(client, method, req) {
  return new Promise((res, rej) => client[method](req, (err, resp) => (err ? rej(err) : res(resp))));
}

export class BudgetGateway {
  /**
   * @param {object} o
   * @param {object} o.wallet   a Wallet gRPC client (loadWalletClient) or any {Transfer(req,cb)} stub
   * @param {object} o.quota    { total, perTxCap, dailyCap, windowMs, whitelist:string[], paymentType? }
   * @param {number|string} [o.feePerGram=5]
   * @param {()=>number} [o.clock=Date.now]  injectable clock (ms) for testing the rolling window
   */
  constructor({ wallet, quota, feePerGram = 5, clock = Date.now }) {
    this.wallet = wallet;
    this.quota = {
      total: BigInt(quota.total),
      perTxCap: BigInt(quota.perTxCap),
      dailyCap: BigInt(quota.dailyCap),
      windowMs: Number(quota.windowMs),
      whitelist: new Set(quota.whitelist),
      paymentType: quota.paymentType ?? "ONE_SIDED_TO_STEALTH_ADDRESS",
    };
    this.feePerGram = String(feePerGram);
    this.clock = clock;
    this.spends = []; // [{ t:number(ms), amount:BigInt }] within the rolling window
    this.totalSpent = 0n;
  }

  _prune(now) {
    const cutoff = now - this.quota.windowMs;
    this.spends = this.spends.filter((s) => s.t >= cutoff);
  }

  windowSpent(now = this.clock()) {
    this._prune(now);
    return this.spends.reduce((a, s) => a + s.amount, 0n);
  }

  status() {
    const now = this.clock();
    const win = this.windowSpent(now);
    return {
      perTxCap: this.quota.perTxCap.toString(),
      dailyCap: this.quota.dailyCap.toString(),
      windowSpent: win.toString(),
      dailyRemaining: (this.quota.dailyCap - win).toString(),
      total: this.quota.total.toString(),
      totalSpent: this.totalSpent.toString(),
      totalRemaining: (this.quota.total - this.totalSpent).toString(),
      whitelist: [...this.quota.whitelist],
    };
  }

  /**
   * Pay a merchant. Returns { ok:true, txId, amount } on a sent payment, or
   * { ok:false, code, reason } on a quota/validation rejection (NOTHING is sent in that case).
   */
  async pay(merchant, amount, memo = "") {
    let amt;
    try { amt = BigInt(amount); } catch { return { ok: false, code: "BAD_AMOUNT", reason: `amount ${amount} is not an integer (µT)` }; }
    const now = this.clock();

    // ---- quota checks; any failure returns WITHOUT calling the wallet ----
    if (!this.quota.whitelist.has(merchant))
      return { ok: false, code: "NOT_WHITELISTED", reason: `merchant ${merchant} is not whitelisted` };
    if (amt <= 0n)
      return { ok: false, code: "BAD_AMOUNT", reason: "amount must be > 0" };
    if (amt > this.quota.perTxCap)
      return { ok: false, code: "OVER_PER_TX", reason: `amount ${amt} exceeds per-tx cap ${this.quota.perTxCap}` };
    const win = this.windowSpent(now);
    if (win + amt > this.quota.dailyCap)
      return { ok: false, code: "OVER_DAILY", reason: `would exceed daily cap ${this.quota.dailyCap} (already ${win} in window)` };
    if (this.totalSpent + amt > this.quota.total)
      return { ok: false, code: "OVER_TOTAL", reason: `would exceed total budget ${this.quota.total} (spent ${this.totalSpent})` };

    // ---- within quota: send a one-sided payment, NO confirmation ----
    let resp;
    try {
      resp = await unary(this.wallet, "Transfer", {
        recipients: [{
          address: merchant,
          amount: amt.toString(),
          fee_per_gram: this.feePerGram,
          payment_type: this.quota.paymentType,
          user_payment_id: memo,
        }],
        single_tx: true,
      });
    } catch (e) {
      return { ok: false, code: "WALLET_ERROR", reason: String(e?.message ?? e) };
    }
    const r = resp?.results?.[0];
    if (!r || !r.is_success)
      return { ok: false, code: "SEND_FAILED", reason: r?.failure_message || "transfer reported no success" };

    // record the spend only after a successful send
    this.spends.push({ t: now, amount: amt });
    this.totalSpent += amt;
    return { ok: true, txId: String(r.transaction_id), amount: amt.toString(), merchant };
  }
}
