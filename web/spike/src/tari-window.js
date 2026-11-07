// A thin adapter over the `window.tari` provider — the de-facto standard injected by the Sapient
// Ootle browser extension AND by the Tari Universe web wallet (via universe.tari.mw/tari-connector.js,
// "one interface, every Tari wallet"). It is the "connect like MetaMask, no user-run walletd" path for
// an Ootle dApp: the wallet holds the key, signs, and submits to its own indexer; the dApp only hands
// over an instruction list and polls for the result. Per-transaction approval is the user's, in the
// wallet's own popup — that replaces our server-side step-up for owner operations.
//
// Scope: reference adapter written to the DOCUMENTED window.tari API (Sapient provider-api.md +
// universe.tari.mw/integration). Points marked `VERIFY:` could not be checked against a live wallet
// from here and must be confirmed on esmeralda before this is trusted. See window-tari.html.

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

/** Normalise the two error dialects: Sapient throws plain Error(message); Universe uses numeric codes. */
export function describeTariError(e) {
  const code = e && (e.code ?? e.data?.code);
  const byCode = { 4001: "User rejected the request", 4100: "Wallet not connected", 4200: "Unsupported in this wallet", "-32603": "Internal / network rejection" };
  if (code != null && byCode[code]) return `${byCode[code]} (${code})`;
  return (e && e.message) || String(e);
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
    w.network = await w.req("tari_getNetwork");
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
    // VERIFY: returns a raw Substate in the same JSON shape our agentpay-tx.js parsers expect
    // (parseBudgetSubstate reads resp.state.up.substate.Component.body.state). Not tied to the account.
    return this.req("tari_getSubstate", version == null ? { substateId } : { substateId, version });
  }

  getTransactionResult(transactionId) {
    return this.req("tari_getTransactionResult", { transactionId });
  }

  /**
   * Local dry-run: synchronous, no approval, no popup. `instructions` is a raw Instruction[]; we let the
   * wallet discover inputs (the integration docs say inputs are "purely an optimization" and warn NOT to
   * pin cached substate versions). Returns the indexer's dry-run result for client-side preview.
   */
  dryRun(instructions, { inputs } = {}) {
    // tari_signAndSubmitTransaction is deprecated-but-supported; with dryRun:true it never prompts.
    return this.req("tari_signAndSubmitTransaction", { instructions, inputs, dryRun: true });
  }

  /**
   * The real submit: create a transaction request (opens the approval popup), poll until the user
   * decides, then submit. Returns the operation's indexer result. The human approval in the popup IS
   * the second factor — the dApp cannot suppress or customise that screen.
   *
   * @param instructions raw Instruction[]  (we hand the wallet instructions only; it builds the tx,
   *                      adds the fee from maxFee, signs, and submits — so our builder's own fee/epoch
   *                      are not used on this path)
   * @param opts.inputs  optional SubstateRequirement[] (optimization only; omit to let the wallet resolve)
   * @param opts.maxFee  bigint/string max fee the wallet may spend (default 200000 µT)
   * @param opts.onPending(requestId) called once the request is queued (to show "approve in your wallet")
   * @param opts.pollMs / opts.timeoutMs
   */
  async createApproveSubmit(instructions, opts = {}) {
    const { inputs, maxFee = 200_000n, onPending, pollMs = 800, timeoutMs = 180_000 } = opts;
    // VERIFY: exact operation shape for tari_createTransactionRequest. Docs give the discriminator
    // "instructions" with { instructions, maxFee?, inputs? }; whether it is passed flat or under `kind`
    // is not certain from the docs — confirm against the live wallet.
    const op = { kind: "instructions", instructions, maxFee: String(maxFee) };
    if (inputs) op.inputs = inputs;
    const { requestId } = await this.req("tari_createTransactionRequest", op);
    if (onPending) try { onPending(requestId); } catch { /* ignore */ }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.req("tari_getTransactionRequest", { requestId });
      const status = r && r.status;
      if (status === "approved") {
        // Human approved; submission is atomic and throws on a duplicate submit.
        return { requestId, result: await this.req("tari_submitTransactionRequest", { requestId }) };
      }
      if (status === "submitted") return { requestId, result: r.result };
      if (status === "rejected" || status === "failed") {
        throw new Error(`transaction ${status}: ${r.error || "(no detail)"}`);
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for wallet approval");
      await new Promise((res) => setTimeout(res, pollMs)); // status === "pending" | "submitting"
    }
  }
}

/** The core instructions of a built unsigned tx — what we hand window.tari (its wallet adds fee+epoch). */
export function coreInstructions(unsignedTx) {
  // buildUnsignedTransaction() keeps pay-fee calls in `.fee_instructions`, so `.instructions` is the
  // AgentBudget body alone (withdraw/new/deposit, or proof/pay/drop). The wallet re-wraps + fees it.
  return unsignedTx.instructions;
}
