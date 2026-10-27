/**
 * On-chain budget adapter — the phase-2 (on-chain conditions) path.
 *
 * Backs the budget with the **AgentBudget** Ootle template, so the per-transaction cap, the
 * rolling daily cap, the merchant whitelist and the kill switch are all enforced **on chain** by
 * the validator — the agent's client cannot override them. A 1:1 port of `OnChainBudget` in the
 * Python SDK's `agentpay/onchain.py`: identical RPC methods, manifest strings and event parsing.
 */
import { ChainError, PolicyViolation } from "./errors";
import { encodeMemo } from "./invoice";
import { finalizedOutcome, WalletdClient } from "./walletd";
import { windowStatus, WindowStatus } from "./window";

/** Native Tari test token used as the (plaintext, countable) budget resource on a devnet. */
export const XTR = "XTR";

/**
 * A base-unit amount. Accepted as a `bigint`, a decimal-integer `string`, or a `number` — but a
 * `number` is only safe below 2^53, so anything that large must be passed as a string/bigint.
 * Base-unit amounts are integers and can exceed JS's safe-integer range, so they are carried as
 * decimal strings and compared with BigInt; they NEVER pass through a lossy float.
 */
export type AmountInput = bigint | number | string;

/** Normalise an amount to a plain decimal-integer string for a manifest `amount!(…)` literal. */
function amt(x: AmountInput): string {
  if (typeof x === "bigint") {
    if (x < 0n) throw new ChainError(`amount cannot be negative: ${x}`);
    return x.toString();
  }
  if (typeof x === "string") {
    const s = x.trim();
    if (!/^\d+$/.test(s)) throw new ChainError(`invalid amount (expected a non-negative integer): ${x}`);
    return s;
  }
  // number: reject floats, negatives, and anything beyond the safe-integer range (would lose
  // precision or stringify in exponential form and corrupt the manifest).
  if (!Number.isInteger(x) || x < 0 || !Number.isSafeInteger(x)) {
    throw new ChainError(`unsafe amount (pass large values as a string/bigint): ${x}`);
  }
  return String(x);
}

/** Parse an amount to a BigInt (exact, no float rounding). */
function big(x: AmountInput): bigint {
  return BigInt(amt(x));
}

export interface LedgerEntry {
  merchant: string;
  /** Base-unit amount as a decimal-integer string (exact; may exceed 2^53). */
  amount: string;
  memo: string;
  txKind: "pay" | "pay_via_escrow";
}

function components(blob: string, exclude: Set<string>): string[] {
  const all = new Set(blob.match(/component_[0-9a-f]{64}/g) ?? []);
  return [...all].filter((c) => !exclude.has(c));
}

function badgeResources(blob: string): string[] {
  // Non-fungible badge resources minted by the template (exclude the native XTR resource 0101..
  // and the zero template address resource 0000..).
  const all = new Set(blob.match(/resource_[0-9a-f]{64}/g) ?? []);
  return [...all]
    .filter((x) => !x.startsWith("resource_0101") && !x.startsWith("resource_0000"))
    .sort();
}

/**
 * Extract the meaningful reason from a walletd RPC *error message* for a dry run. This is the ONE
 * place we parse a reject out of free text, and only because a dry-run rejection arrives as an RPC
 * error whose `message` is human text with no structured field — e.g. `Application error: 5:
 * Dry-run transaction rejected: Execution failure (AssertionFailed): At instruction #2: Panic!
 * Agent has been revoked`. Committed rejections and typed dry-run results go through
 * `finalizedOutcome` instead. Mirrors the Python SDK's `_clean_reason`.
 */
function cleanReason(message: string): string {
  const m = message.match(/rejected:\s*(.+?)(?:"|$)/);
  const tail = (m ? m[1] : message).trim();
  const panic = tail.match(/Panic(?:ked)?[:!]?\s*(.+)/);
  return panic ? panic[1].trim().replace(/\.$/, "") : tail;
}

/**
 * Find the AgentBudget component's state array anywhere in a `substates.get` result tree. The
 * state is a positional array matching the struct's fields (vault, badges, then the scalar caps).
 */
function findComponentState(node: any): any[] | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findComponentState(v);
      if (r) return r;
    }
    return null;
  }
  if (Array.isArray(node.Component?.body?.state)) return node.Component.body.state;
  for (const v of Object.values(node)) {
    const r = findComponentState(v);
    if (r) return r;
  }
  return null;
}

// Addresses in a component's state are CBOR-tagged: tag 131 = ResourceAddress, 132 = VaultId,
// 128 = ComponentAddress. The AgentBudget struct lays its two ResourceAddress fields out in order
// (owner_badge, agent_badge), so the two tag-131 entries are, in order, owner then agent.
const CBOR_TAG_RESOURCE = 131;

/** ResourceAddresses (CBOR tag 131) in a state array, in struct order: [ownerBadge, agentBadge]. */
function taggedResources(state: any[]): string[] {
  const out: string[] = [];
  for (const x of state) {
    if (x && typeof x === "object" && x.tag === CBOR_TAG_RESOURCE && typeof x.value?.hex === "string") {
      out.push("resource_" + x.value.hex);
    }
  }
  return out;
}

/** Yield every event-shaped object (has a `payload`) anywhere in a result tree. */
function* iterEvents(result: any): Generator<any> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    if ("payload" in result && ("topic" in result || "substate_id" in result)) yield result;
    for (const v of Object.values(result)) yield* iterEvents(v);
  } else if (Array.isArray(result)) {
    for (const v of result) yield* iterEvents(v);
  }
}

export interface OnChainBudgetOptions {
  /** Defaults to `ownerAccount` (devnet: one account acts as both owner and agent). */
  agentAccount?: string;
}

export class OnChainBudget {
  readonly client: WalletdClient;
  readonly budgetTemplate: string;
  readonly ownerAccount: string;
  readonly agentAccount: string;

  component: string | null = null;
  ownerBadge: string | null = null;
  agentBadge: string | null = null;
  // Caps and running spend are base-unit integers held as decimal strings (exact beyond 2^53).
  perTxCap = "0";
  dailyCap = "0";
  whitelist: string[] = [];
  revoked = false;
  spent = "0";
  ledger: LedgerEntry[] = [];
  // Agent session badges issued for this budget (the first, "default", comes from `open`). Tracked
  // client-side for convenience; the chain is the source of truth for what each can do.
  sessions: string[] = ["default"];
  revokedSessions: string[] = [];

  constructor(
    client: WalletdClient,
    budgetTemplate: string,
    ownerAccount: string,
    opts: OnChainBudgetOptions = {},
  ) {
    this.client = client;
    this.budgetTemplate = budgetTemplate;
    this.ownerAccount = ownerAccount;
    this.agentAccount = opts.agentAccount ?? ownerAccount;
  }

  // -- owner -----------------------------------------------------------------------
  async open(params: {
    fund: AmountInput;
    perTxCap: AmountInput;
    dailyCap: AmountInput;
    epochsPerWindow: number;
    whitelist: string[];
  }): Promise<this> {
    const { fund, perTxCap, dailyCap, epochsPerWindow, whitelist } = params;
    const wl = whitelist.map((m) => `address!("${m}")`).join(", ");
    const manifest =
      `use ${this.budgetTemplate} as AgentBudget;\n` +
      "fn main() {\n" +
      '    let mut owner = var!["owner"];\n' +
      `    let funds = owner.withdraw(XTR, amount!(${amt(fund)}));\n` +
      `    let (comp, owner_badge, agent_badge) = AgentBudget::new(` +
      `funds, amount!(${amt(perTxCap)}), amount!(${amt(dailyCap)}), ${Math.floor(epochsPerWindow)}u64, [${wl}]);\n` +
      "    owner.deposit(owner_badge);\n" +
      "    owner.deposit(agent_badge);\n" +
      "}\n";
    const res = await this.client.run(manifest, { owner: this.ownerAccount });
    const blob = JSON.stringify(res);
    const comps = components(blob, new Set([this.ownerAccount, this.agentAccount, ...whitelist]));
    const badges = badgeResources(blob);
    if (comps.length === 0 || badges.length < 2) {
      throw new ChainError("could not locate the new budget component / badges in the result");
    }
    this.component = comps[0];
    // Resolve which badge is which from the component's on-chain state, NOT from address sort order.
    // The owner and agent badges are two distinct non-fungible resources; `pay` asserts the *agent*
    // badge resource specifically, so proving the wrong one is rejected on chain ("Proof of resource
    // did not match"). The struct lays them out as (owner_badge, agent_badge).
    [this.ownerBadge, this.agentBadge] = await this.readBadges();
    this.perTxCap = amt(perTxCap);
    this.dailyCap = amt(dailyCap);
    this.whitelist = [...whitelist];
    return this;
  }

  /** Read `[ownerBadge, agentBadge]` authoritatively from the component's on-chain state. */
  private async readBadges(): Promise<[string, string]> {
    const state = findComponentState(await this.client.getSubstate(this.component!));
    if (!state) throw new ChainError("could not read the budget component state to resolve badges");
    const resources = taggedResources(state);
    if (resources.length < 2) {
      throw new ChainError("budget component state did not expose the owner and agent badges");
    }
    return [resources[0], resources[1]]; // struct order: owner_badge, agent_badge
  }

  async revoke(): Promise<void> {
    await this.ownerCall("revoke()");
    this.revoked = true;
  }

  async withdraw(amount: AmountInput): Promise<void> {
    const manifest =
      "fn main() {\n" +
      '    let mut owner = var!["owner"];\n' +
      `    let proof = owner.create_proof_for_resource(address!("${this.ownerBadge}"));\n` +
      '    let mut budget = var!["budget"];\n' +
      `    let coins = budget.withdraw(amount!(${amt(amount)}));\n` +
      "    owner.deposit(coins);\n" +
      "    drop_all_proofs!();\n" +
      "}\n";
    await this.client.run(manifest, { owner: this.ownerAccount, budget: this.component! });
  }

  async addMerchant(merchant: string): Promise<void> {
    await this.ownerCall(`add_merchant(address!("${merchant}"))`);
    if (!this.whitelist.includes(merchant)) this.whitelist.push(merchant);
  }

  /**
   * Owner mints a new agent session badge labelled `session` and deposits it into `toAccount`
   * (defaults to this budget's agent account). The new badge can `pay` within the same on-chain
   * caps/whitelist until the owner revokes that session. Returns the session label.
   */
  async issueAgentBadge(session: string, opts: { toAccount?: string } = {}): Promise<string> {
    const target = opts.toAccount ?? this.agentAccount;
    const manifest =
      "fn main() {\n" +
      '    let mut owner = var!["owner"];\n' +
      `    let proof = owner.create_proof_for_resource(address!("${this.ownerBadge}"));\n` +
      '    let mut budget = var!["budget"];\n' +
      `    let badge = budget.issue_agent_badge("${session}");\n` +
      '    let mut agent = var!["agent"];\n' +
      "    agent.deposit(badge);\n" +
      "    drop_all_proofs!();\n" +
      "}\n";
    await this.client.run(manifest, {
      owner: this.ownerAccount,
      budget: this.component!,
      agent: target,
    });
    if (!this.sessions.includes(session)) this.sessions.push(session);
    this.revokedSessions = this.revokedSessions.filter((s) => s !== session); // re-issue clears revoke
    return session;
  }

  /**
   * Owner revokes a single agent session badge. Other sessions keep working; use `revoke()` for the
   * global kill switch.
   */
  async revokeSession(session: string): Promise<void> {
    await this.ownerCall(`revoke_session("${session}")`);
    if (!this.revokedSessions.includes(session)) this.revokedSessions.push(session);
  }

  /**
   * Owner reconfigures the rolling allowance window (and restarts it now). The daily cap is the
   * recurring per-window allowance — there is no on-chain timer (see the template docs).
   */
  async setWindow(epochsPerWindow: number): Promise<void> {
    await this.ownerCall(`set_window(${Math.floor(epochsPerWindow)}u64)`);
    this.spent = "0";
  }

  /**
   * Add `amount` to the budget's vault, funded from `fromAccount` (defaults to the owner). `top_up`
   * is open on the template, so a keeper account can replenish on its own cadence — the chain has no
   * scheduler to do it automatically.
   */
  async topUp(amount: AmountInput, opts: { fromAccount?: string } = {}): Promise<void> {
    const funder = opts.fromAccount ?? this.ownerAccount;
    const manifest =
      "fn main() {\n" +
      '    let mut funder = var!["funder"];\n' +
      `    let funds = funder.withdraw(XTR, amount!(${amt(amount)}));\n` +
      '    let mut budget = var!["budget"];\n' +
      "    budget.top_up(funds);\n" +
      "}\n";
    await this.client.run(manifest, { funder, budget: this.component! });
  }

  private async ownerCall(call: string): Promise<void> {
    const manifest =
      "fn main() {\n" +
      '    let mut owner = var!["owner"];\n' +
      `    let proof = owner.create_proof_for_resource(address!("${this.ownerBadge}"));\n` +
      '    let mut budget = var!["budget"];\n' +
      `    budget.${call};\n` +
      "    drop_all_proofs!();\n" +
      "}\n";
    await this.client.run(manifest, { owner: this.ownerAccount, budget: this.component! });
  }

  // -- agent -----------------------------------------------------------------------
  private payManifest(merchant: string, amount: AmountInput, memo: string): string {
    // The agent presents a proof of its session badge; `pay` reads it to identify (and, if revoked,
    // refuse) the session before moving funds.
    return (
      "fn main() {\n" +
      '    let mut agent = var!["agent"];\n' +
      `    let proof = agent.create_proof_for_resource(address!("${this.agentBadge}"));\n` +
      '    let mut budget = var!["budget"];\n' +
      `    budget.pay(proof, address!("${merchant}"), amount!(${amt(amount)}), "${memo}");\n` +
      "    drop_all_proofs!();\n" +
      "}\n"
    );
  }

  /**
   * The agent pays a whitelisted merchant. The client-side checks are only an early, friendly
   * error — the chain enforces the real limits regardless of what this client does. The local
   * ledger is updated from the on-chain `pay` event, not from the request.
   */
  async pay(merchant: string, amount: AmountInput, opts: { memo?: string } = {}): Promise<any> {
    const memo = opts.memo ?? "";
    this.precheck(merchant, amount);
    const res = await this.client.run(this.payManifest(merchant, amount, memo), {
      agent: this.agentAccount,
      budget: this.component!,
    });
    for (const ev of OnChainBudget.payEvents(res)) { // ledger follows the chain's events
      const paid = big(ev.amount ?? amount); // exact, from the on-chain event
      this.spent = (big(this.spent) + paid).toString();
      this.ledger.push({ merchant: ev.merchant ?? merchant, amount: paid.toString(), memo: ev.memo ?? memo, txKind: "pay" });
    }
    return res;
  }

  /**
   * Ask the validator (via a dry run) whether this pay would be rejected, returning the on-chain
   * reason — used to show that the *chain*, not the client, enforces the rules. Returns null if
   * the pay would be accepted.
   */
  async wouldReject(merchant: string, amount: AmountInput, opts: { memo?: string } = {}): Promise<string | null> {
    const memo = opts.memo ?? "forced";
    const r = await this.client.dryRun(this.payManifest(merchant, amount, memo), {
      agent: this.agentAccount,
      budget: this.component!,
    });
    // walletd surfaces a dry-run rejection either as an RPC error (plain message — parsed in the one
    // place cleanReason lives) or as a finalized result whose TransactionResult is Reject (structural).
    if (r.error) return cleanReason(r.error.message ?? "rejected");
    const outcome = finalizedOutcome(r.result);
    return outcome && outcome[0] === "reject" ? outcome[1] : null;
  }

  /** Pay an invoice: the invoice id + agent tag ride along as the on-chain memo. */
  async payInvoice(params: {
    merchant: string;
    invoiceId: string;
    amount: AmountInput;
    agentTag?: string;
  }): Promise<any> {
    const memo = encodeMemo(params.invoiceId, params.agentTag ?? "").Message;
    return this.pay(params.merchant, params.amount, { memo });
  }

  private precheck(merchant: string, amount: AmountInput): void {
    const a = big(amount);
    if (this.revoked) {
      throw new PolicyViolation(["budget revoked (client pre-check; chain also rejects)"]);
    }
    if (a <= 0n || a > big(this.perTxCap)) {
      throw new PolicyViolation([`amount ${a} over per-tx cap ${this.perTxCap} (client pre-check)`]);
    }
    if (this.whitelist.length > 0 && !this.whitelist.includes(merchant)) {
      throw new PolicyViolation(["merchant not whitelisted (client pre-check)"]);
    }
    if (big(this.spent) + a > big(this.dailyCap)) {
      throw new PolicyViolation([`would exceed daily cap ${this.dailyCap} (client pre-check)`]);
    }
  }

  // -- read-only window view -------------------------------------------------------
  /**
   * Read the budget's live rolling-window status from chain and translate it into human-readable
   * numbers (how much is left this window, roughly how long until it resets). Read-only: it queries
   * the component substate and the current epoch, and changes nothing on chain.
   *
   * The "daily cap" is enforced over a rolling window of `epochs_per_window` chain epochs
   * (≈30 min each), reset lazily on the next payment — so the wall-clock figures are approximate.
   * See `window.ts` for the pure computation.
   */
  async readWindow(): Promise<WindowStatus> {
    if (!this.component) throw new ChainError("budget component is not set");
    const [sub, currentEpoch] = await Promise.all([
      this.client.getSubstate(this.component),
      this.client.currentEpoch(),
    ]);
    const state = findComponentState(sub);
    if (!state) throw new ChainError("could not read the budget component state");
    // The leading entries (vault + two badge resources) are CBOR-tagged objects; the next scalar
    // fields are plain integers in struct order: per_tx_cap, daily_cap, spent_in_window,
    // window_start_epoch, epochs_per_window. Take the first five numbers at the top level.
    const nums = state.filter((x) => typeof x === "number") as number[];
    if (nums.length < 5) throw new ChainError("unexpected budget component layout");
    const [, dailyCap, spentInWindow, windowStartEpoch, epochsPerWindow] = nums;
    return windowStatus({ dailyCap, spentInWindow, windowStartEpoch, epochsPerWindow, currentEpoch });
  }

  // -- events / ledger -------------------------------------------------------------
  /**
   * Extract the AgentBudget `pay` events (payload: merchant/amount/memo/spent_in_window) from a
   * tx result — this is how a watcher keeps a local ledger in sync with the chain. The same event
   * is recorded in two places in the result, so we de-duplicate.
   */
  static payEvents(result: any): any[] {
    const out: any[] = [];
    const seen = new Set<string>();
    for (const ev of iterEvents(result)) {
      const p = ev.payload;
      if (p && typeof p === "object" && "merchant" in p && "memo" in p) {
        const key = JSON.stringify([p.merchant, p.amount, p.memo]);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(p);
        }
      }
    }
    return out;
  }
}
