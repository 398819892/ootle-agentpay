// A thin adapter over the `window.tari` provider — the de-facto standard injected by the Sapient
// Ootle browser extension AND by the Tari Universe web wallet (via universe.tari.mw/tari-connector.js,
// "one interface, every Tari wallet"). It is the "connect like MetaMask, no user-run walletd" path for
// an Ootle dApp: the wallet holds the key, signs, and submits to its own indexer; the dApp only hands
// over an instruction list and polls for the result. Per-transaction approval is the user's, in the
// wallet's own popup — that replaces our server-side step-up for owner operations.
//
// Scope: adapter pinned against the live, unminified `https://universe.tari.mw/tari-connector.js`
// (read 2026-11-07) — the Tari Universe bridge that states it mirrors the Sapient extension's injected
// provider ({ isTariWallet: true, request({ method, params }) }, same `tari_*` method names). CONFIRMED
// from that source: the request convention, all method-name strings, the create→poll→submit status set,
// and that both the single-call submit and the 3-step flow exist. The connector is a thin postMessage
// bridge that forwards params verbatim, so wallet-side param/return shapes it does NOT define are marked
// `VERIFY:` and must be confirmed on a live wallet (esmeralda) before this is trusted. See window-tari.html.

/** Resolve the injected provider, waiting for the `tari#initialized` event if it is not there yet. */
export function getTariProvider({ timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof window !== "undefined" && window.tari && window.tari.isTariWallet) return resolve(window.tari);
    let done = false;
    const onReady = () => {
      if (done) return;
      if (window.tari && window.tari.isTariWallet) {
        done = true;
        window.removeEventListener("tari#initialized", onReady);
        resolve(window.tari);
      }
    };
    // Injection happens slightly after document_start; the docs say to listen for the ready event too.
    window.addEventListener("tari#initialized", onReady);
    setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener("tari#initialized", onReady);
      if (window.tari && window.tari.isTariWallet) resolve(window.tari);
      else reject(new Error("No Tari wallet detected. Install the Sapient extension, or open this dApp inside the Tari Universe web wallet."));
    }, timeoutMs);
  });
}

// CONFIRMED (tari-connector.js lines 135-138): the wallet replies with a JSON-RPC-style { code, message }
// and the bridge throws an Error carrying err.code (numeric) + err.message; a local "wallet unavailable"
// failure is a plain Error with no .code. So reading err.code is structurally right.
// VERIFY on a live wallet: the specific NUMBERS below are the EIP-1193 convention and are NOT defined in
// the connector — confirm the real codes; the err.message fallback always holds regardless.
export function describeTariError(e) {
  const code = e && (e.code ?? e.data?.code);
  const byCode = { 4001: "User rejected the request", 4100: "Wallet not connected", 4200: "Unsupported in this wallet", "-32603": "Internal / network rejection" };
  if (code != null && byCode[code]) return `${byCode[code]} (${code})`;
  return (e && e.message) || String(e);
}

/** Normalise what tari_getNetwork reports: it may be a lowercase name ("esmeralda"/"igor") or the numeric
 *  network byte (38 Esmeralda / 36 Igor, per @tari-project/ootle's Network enum). Return the lowercase name. */
export function normaliseNetwork(raw) {
  if (typeof raw === "number") return raw === 36 ? "igor" : raw === 38 ? "esmeralda" : String(raw);
  const s = String(raw == null ? "" : raw).toLowerCase();
  if (s.includes("igor")) return "igor";
  if (s.includes("esmeralda") || s.includes("esme")) return "esmeralda";
  return s || "esmeralda";
}

export class TariWindowWallet {
  constructor(provider) {
    this.p = provider;
    this.account = null; // the connected account's component address (component_…)
    this.network = null; // "esmeralda" | "igor"
  }

  static async connect(opts) {
    const provider = await getTariProvider(opts);
    const w = new TariWindowWallet(provider);
    await w.requestAccounts();
    w.network = normaliseNetwork(await w.req("tari_getNetwork"));
    return w;
  }

  req(method, params) {
    // Every call is window.tari.request({ method, params }); read calls need no popup.
    return this.p.request(params === undefined ? { method } : { method, params });
  }

  /** First connect: one approval popup per origin; afterwards a no-op. Returns the connected account. */
  async requestAccounts() {
    const accounts = await this.req("tari_requestAccounts"); // string[] of component addresses
    if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("Wallet returned no account");
    this.account = accounts[0]; // connection is pinned to the active account at connect time
    return this.account;
  }

  getSubstate(substateId, version = null) {
    // CONFIRMED (tari-connector.js): request("tari_getSubstate", { substateId, version }). The return for a
    // component is `resp.substate.Component.body.state` — NOT `state.up.substate.*`, which is a transaction
    // DIFF shape, not a getSubstate shape (verifyFunds reads `substate.substate.Utxo`). parseBudgetSubstate()
    // now accepts both shapes. VERIFY on a live component: the `.Component.body.state` tail, and whether the
    // value is plain JSON or CBOR-base64 (indexers may serve CBOR needing decodeSubstateValue).
    return this.req("tari_getSubstate", version == null ? { substateId } : { substateId, version });
  }

  getTransactionResult(transactionId) {
    return this.req("tari_getTransactionResult", { transactionId });
  }

  /**
   * Local dry-run via the single-call path: no popup, no submit. `instructions` is a raw Instruction[]; we
   * let the wallet discover inputs (the integration docs say inputs are "purely an optimization" and warn
   * NOT to pin cached substate versions). Returns the indexer's dry-run result for client-side preview.
   * VERIFY on a live wallet: that `dryRun:true` is honoured as no-popup, and the exact param shape — the
   * connector forwards params verbatim and does not define them.
   */
  dryRun(instructions, { inputs } = {}) {
    const params = inputs ? { instructions, inputs, dryRun: true } : { instructions, dryRun: true };
    return this.req("tari_signAndSubmitTransaction", params);
  }

  /**
   * The real submit of RAW AgentBudget instructions: `tari_signAndSubmitTransaction`. This IS the right
   * channel for raw Instruction[] — the 3-step `tari_createTransactionRequest` (createApproveSubmit below)
   * takes high-level named *operation kinds* (shield / unshield / sendPrivately / htlc*, per tari-connector.js),
   * not raw instructions. The wallet pops its OWN approval (that human approval is our second factor — the
   * dApp cannot suppress it), builds the tx (fee from maxFee, epochs), signs, and submits to its own indexer.
   * We hand the wallet instructions only; our builder's fee/epoch are not used on this path.
   *
   * @param instructions raw Instruction[]
   * @param opts.inputs  optional SubstateRequirement[] (optimization only; omit to let the wallet resolve)
   * @param opts.maxFee  bigint/string max fee the wallet may spend (default 200000 µT)
   * VERIFY on a live wallet: the exact param shape AND the return/receipt shape (the connector forwards
   * params and returns data.result unchanged, so neither is defined in source; see normaliseReceipt).
   */
  async signAndSubmit(instructions, opts = {}) {
    const { inputs, maxFee = 200_000n } = opts;
    const params = { instructions, maxFee: String(maxFee) };
    if (inputs) params.inputs = inputs;
    return this.req("tari_signAndSubmitTransaction", params);
  }

  /**
   * ALTERNATIVE submit path for the wallet's HIGH-LEVEL named operations (shield / unshield / sendPrivately /
   * htlc*), NOT for our raw AgentBudget instructions — kept for completeness. `operation` is a flat object
   * with a `kind` discriminator (CONFIRMED by tari-connector.js `proveFunds`: { kind:"shield", ... }).
   * 3 steps: create → returns { requestId } and opens the popup → poll getTransactionRequest → on "approved"
   * call submit. Statuses CONFIRMED from tari-connector.js: "approved" (now call submit), "submitted" (result
   * at summary.result), "rejected"/"failed" (error at summary.error); any other status just keeps polling.
   */
  async createApproveSubmit(operation, opts = {}) {
    const { onPending, pollMs = 800, timeoutMs = 180_000 } = opts;
    const { requestId } = await this.req("tari_createTransactionRequest", operation);
    if (onPending) try { onPending(requestId); } catch { /* ignore */ }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.req("tari_getTransactionRequest", { requestId });
      const status = r && r.status;
      if (status === "approved") return { requestId, result: await this.req("tari_submitTransactionRequest", { requestId }) };
      if (status === "submitted") return { requestId, result: r.result };
      if (status === "rejected" || status === "failed") throw new Error(`transaction ${status}: ${r.error || "(no detail)"}`);
      if (Date.now() > deadline) throw new Error("timed out waiting for wallet approval");
      await new Promise((res) => setTimeout(res, pollMs)); // keep polling on any non-terminal status
    }
  }
}

/** The core instructions of a built unsigned tx — what we hand window.tari (its wallet adds fee+epoch). */
export function coreInstructions(unsignedTx) {
  // buildUnsignedTransaction() keeps pay-fee calls in `.fee_instructions`, so `.instructions` is the
  // AgentBudget body alone (withdraw/new/deposit, or proof/pay/drop). The wallet re-wraps + fees it.
  return unsignedTx.instructions;
}
