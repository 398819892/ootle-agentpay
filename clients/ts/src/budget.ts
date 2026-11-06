/**
 * On-chain budget adapter — the phase-2 (on-chain conditions) path.
 *
 * Backs the budget with the **AgentBudget** Ootle template, so the per-transaction cap, the
 * per-window spending cap (fixed epoch window), the merchant whitelist and the kill switch are all enforced **on chain** by
 * the validator — the agent's client cannot override them. A 1:1 port of `OnChainBudget` in the
 * Python SDK's `agentpay/onchain.py`: identical RPC methods, manifest strings and event parsing.
 */
import { ChainError, PolicyViolation } from "./errors";
import { encodeMemo } from "./invoice";
import { finalizedOutcome, isTransient, WalletdClient } from "./walletd";
import { windowStatus, WindowStatus } from "./window";

/** Native Tari test token used as the (plaintext, countable) budget resource on a devnet. */
export const XTR = "XTR";
// Manifest keyword for the native token. `XTR` was a deprecated alias that tari-ootle 0.48 removed
// (#3076): a 0.48+ manifest parser resolves only `TARI`, while 0.47 accepts both — so every manifest
// splices `TARI`. The `XTR` constant stays as the API-level name for "the native token".
const NATIVE_KEYWORD = "TARI";
const NATIVE_ALIASES = new Set(["XTR", "TARI"]);

// Short retry budget for READ-ONLY status dry-runs (readInfo/readWindow): a jittery public-testnet
// indexer should stall a status query for a few seconds, not the full ~6 min a REAL submit tolerates.
// (6th-round review, batch 2)
const READ_DRYRUN_RETRY = { tries: 3, delayMs: 2_000 } as const;

/**
 * Whether owner-badge manifests open an explicit proof authorization window.
 *
 * tari-ootle 0.49 (#3206) changed the model: a proof left on the transaction workspace authorizes
 * NOTHING until `authorize!(proof)` opens a window over it (closed by `drop_authorize!`), and a
 * window is lent exactly one hop (the budget component). A 0.47 manifest parser does not know the
 * two macros and rejects the manifest outright, so the dialect is a switch: default ON (the repo
 * targets 0.49); set `AGENTPAY_PROOF_WINDOWS=0` (or `{ proofWindows: false }`) to keep the pre-0.49
 * dialect for a 0.47 walletd. The agent's `pay` proof is only *shown* to the template (passed as an
 * argument and read with `assert_resource`/`get_non_fungibles`), which needs no window on either.
 */
function proofWindowsDefault(): boolean {
  const v = (typeof process !== "undefined" && process.env && process.env.AGENTPAY_PROOF_WINDOWS) || "";
  return !["0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

/**
 * Whether the dialect was an explicit operator choice (`AGENTPAY_PROOF_WINDOWS` set) rather than the
 * defaulted guess. Read at instantiation, not import, so a late env change is respected. Used only to
 * decide whether an owner-call failure carries the "maybe a dialect mismatch" hint — walletd exposes
 * no version RPC here, so we cannot auto-detect, only avoid failing on a SILENT guess. (P1-3) */
function proofWindowsEnvSet(): boolean {
  const v = (typeof process !== "undefined" && process.env && process.env.AGENTPAY_PROOF_WINDOWS) || "";
  return v.trim() !== "";
}

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

const U64_MAX = (1n << 64n) - 1n;

/**
 * Normalise a `u64` field (e.g. `epochs_per_window`) to a plain decimal-integer string for a manifest
 * `…u64` literal, rejecting negatives, non-integers, NaN and anything outside the u64 range. Without
 * this, `Math.floor(epochsPerWindow)` would splice `-5u64` / `NaNu64` / `1e+21u64` and the failure
 * would only surface deep in the manifest parser. Mirrors `amt()`'s guard and the Python `_check_u64`.
 * (6th-round review, batch 2)
 */
function u64(x: number | bigint | string, field = "value"): string {
  if (typeof x === "bigint") {
    if (x < 0n) throw new ChainError(`${field} cannot be negative: ${x}`);
    if (x > U64_MAX) throw new ChainError(`${field} exceeds the u64 range: ${x}`);
    return x.toString();
  }
  if (typeof x === "string") {
    const s = x.trim();
    if (!/^\d+$/.test(s)) throw new ChainError(`invalid ${field} (expected a non-negative integer): ${x}`);
    if (BigInt(s) > U64_MAX) throw new ChainError(`${field} exceeds the u64 range: ${x}`);
    return s;
  }
  if (!Number.isInteger(x) || x < 0) throw new ChainError(`invalid ${field} (expected a non-negative integer): ${x}`);
  if (!Number.isSafeInteger(x)) throw new ChainError(`unsafe ${field} (pass large values as a string/bigint): ${x}`);
  return String(x);
}

// --- manifest value validation (injection guard, issue #7) ------------------------------------
// A transaction manifest is assembled as text, so EVERY value spliced into it is validated here, at
// the lowest layer (inside the manifest builders) — not only in `precheck`. A direct SDK caller
// (`pay`, `payInvoice`, `issueAgentBadge`, …) is therefore protected too: an attacker-controlled
// memo or address can never break out of its literal and inject extra manifest instructions (which,
// when the owner and agent share an account, could move the owner's funds / bypass the authorizer).
// Values handed to walletd as `variables` (accounts, the component) are parsed as typed values, not
// spliced into the manifest text, so they are not a vector; the ones below are. Mirrors the Python
// SDK's `_check_*` helpers in `agentpay/onchain.py`.
const COMPONENT_RE = /^component_[0-9a-f]{64}$/;
const RESOURCE_RE = /^resource_[0-9a-f]{64}$/;
const TEMPLATE_RE = /^template_[0-9a-f]{64}$/;
const SESSION_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
const MEMO_MAX_BYTES = 253; // Ootle Message-memo limit (see invoice.MAX_MEMO_BYTES)

/** Return `addr` if it is exactly `<kind>_<64 lowercase hex>`, else throw. */
function checkAddress(addr: unknown, kind: string, re: RegExp): string {
  if (typeof addr !== "string" || !re.test(addr)) {
    throw new ChainError(`invalid ${kind} address (expected ${kind}_ + 64 hex chars): ${String(addr)}`);
  }
  return addr;
}
const checkComponent = (a: unknown) => checkAddress(a, "component", COMPONENT_RE);
const checkResource = (a: unknown) => checkAddress(a, "resource", RESOURCE_RE);
const checkTemplate = (a: unknown) => checkAddress(a, "template", TEMPLATE_RE);

/**
 * Validate a free-text memo before it is spliced into a `"…"` manifest string literal. Rejects a
 * double-quote or backslash (so we never depend on the manifest parser's escape handling), any
 * control character (newline/tab/NUL…, which could smuggle in further manifest lines) and
 * over-length memos. Returns the memo unchanged when safe; empty is allowed. An accepted memo is
 * guaranteed to stay inside its literal, so it cannot inject manifest instructions.
 */
function checkMemo(memo: unknown): string {
  if (typeof memo !== "string") throw new ChainError(`memo must be a string, got ${typeof memo}`);
  if (memo.includes('"') || memo.includes("\\")) {
    throw new ChainError('memo must not contain a double-quote (") or backslash (\\)');
  }
  for (const ch of memo) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) throw new ChainError("memo must not contain control characters");
  }
  if (Buffer.byteLength(memo, "utf8") > MEMO_MAX_BYTES) {
    throw new ChainError(`memo too long (max ${MEMO_MAX_BYTES} bytes)`);
  }
  return memo;
}

/** Validate an agent session label before it is spliced into a `"…"` literal. */
function checkSession(session: unknown): string {
  if (typeof session !== "string" || !SESSION_RE.test(session)) {
    throw new ChainError("session label must match [A-Za-z0-9_.-]{1,64}");
  }
  return session;
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

/**
 * The component this tx CREATED from `template`, read from the engine's `std.component.created`
 * event (its `template_address` identifies the creating template) — authoritative, rather than
 * guessing "the first unknown component_… address" in the result blob. `template` is a
 * `template_<hex>` address; the event carries the bare hex, so compare on that. Mirrors the Python
 * SDK's `_created_component`. (#2)
 */
function createdComponent(result: any, template: string): string | null {
  const tmplHex = template.includes("_") ? template.slice(template.indexOf("_") + 1) : template;
  for (const ev of iterEvents(result)) {
    const topic = typeof ev.topic === "string" ? ev.topic : "";
    const leaf = topic.includes(".") ? topic.slice(topic.lastIndexOf(".") + 1) : topic;
    const sid = ev.substate_id;
    if (leaf === "created" && typeof sid === "string" && sid.startsWith("component_") && ev.template_address === tmplHex) {
      return sid;
    }
  }
  return null;
}

/** Live budget state decoded from the name-keyed `AgentBudget.info` event (#1). Amount/epoch fields
 * are kept as exact decimal strings (the event payload is strings — no lossy JS-number round-trip). */
export interface BudgetInfo {
  revoked: boolean;
  balance: string;
  perTxCap: string;
  dailyCap: string;
  spentInWindow: string;
  windowStartEpoch: string;
  epochsPerWindow: string;
}

/** The payload of the `info` event emitted by `AgentBudget::get_info` (topic `AgentBudget.info`) — a
 * NAME-keyed map — or null if absent. Mirrors the Python SDK's `_info_event_payload`. (#1) */
function infoEventPayload(result: any): Record<string, any> | null {
  for (const ev of iterEvents(result)) {
    const topic = typeof ev.topic === "string" ? ev.topic : "";
    const leaf = topic.includes(".") ? topic.slice(topic.lastIndexOf(".") + 1) : topic;
    if (leaf === "info") return ev.payload && typeof ev.payload === "object" ? ev.payload : null;
  }
  return null;
}

/**
 * Decode the name-keyed `info` payload (every value is a string) into typed fields. Because the read
 * is keyed by NAME, a same-type field swap in the component struct is caught here — the gap the
 * positional reader cannot see (#1). Throws on a missing/mistyped field so a caller can fall back.
 * Mirrors the Python SDK's `_parse_info_payload`.
 */
function parseInfoPayload(p: Record<string, any>): BudgetInfo {
  const str = (name: string): string => {
    const v = p[name];
    if (typeof v !== "string" || !/^\d+$/.test(v)) {
      throw new Error(`info event field '${name}' missing or not a non-negative integer string: ${JSON.stringify(v)}`);
    }
    return v;
  };
  const revoked = p.revoked;
  if (revoked !== "true" && revoked !== "false") {
    throw new Error(`info event field 'revoked' is not a boolean: ${JSON.stringify(revoked)}`);
  }
  return {
    revoked: revoked === "true",
    balance: str("balance"),
    perTxCap: str("per_tx_cap"),
    dailyCap: str("daily_cap"),
    spentInWindow: str("spent_in_window"),
    windowStartEpoch: str("window_start_epoch"),
    epochsPerWindow: str("epochs_per_window"),
  };
}

export interface OnChainBudgetOptions {
  /** Defaults to `ownerAccount` (devnet: one account acts as both owner and agent). */
  agentAccount?: string;
  /** Manifest dialect for owner-badge calls (see `proofWindowsDefault`). Default: env / `true`. */
  proofWindows?: boolean;
}

export class OnChainBudget {
  readonly client: WalletdClient;
  readonly budgetTemplate: string;
  readonly ownerAccount: string;
  readonly agentAccount: string;
  /** Open an `authorize!` window around owner-badge calls (0.49+ dialect) or not (0.47). */
  readonly proofWindows: boolean;
  /**
   * True when `proofWindows` was a DEFAULTED guess (neither `{ proofWindows }` nor
   * `AGENTPAY_PROOF_WINDOWS` was set), so an owner-call failure should carry the dialect hint — we
   * cannot auto-detect the walletd version, only avoid failing on a silent guess. (P1-3)
   */
  readonly proofWindowsGuessed: boolean;

  component: string | null = null;
  ownerBadge: string | null = null;
  agentBadge: string | null = null;
  /**
   * The resource the budget is denominated in. `"XTR"` (the native test token) by default so the
   * devnet flow is unchanged; a non-XTR budget passes a `resource_…` address to `open` (the template
   * itself is resource-agnostic — it locks whatever it is funded with). `topUp` reuses it. Mirrors
   * the Python SDK's `OnChainBudget.resource`.
   */
  resource: string = XTR;
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
  /**
   * The agent session badge this client proves when it pays (label of one non-fungible of the
   * agent-badge resource). `"default"` is the badge minted by `open`; set it to a label issued with
   * `issueAgentBadge` to pay as that session, or pass `{ session }` per call. The proof is built with
   * `create_proof_by_non_fungible_ids` so it carries EXACTLY this one token: the template rejects a
   * proof with several session tokens ("Present exactly one agent session badge"), which is what a
   * plain `create_proof_for_resource` produces once an account holds more than one session badge.
   */
  session = "default";

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
    this.proofWindows = opts.proofWindows ?? proofWindowsDefault();
    // A guess only when the caller gave neither an explicit option nor the env var — an explicit
    // choice is never second-guessed with a hint. (P1-3)
    this.proofWindowsGuessed = opts.proofWindows === undefined && !proofWindowsEnvSet();
  }

  // -- owner -----------------------------------------------------------------------
  /**
   * Manifest expression for the budget's resource: the `XTR` keyword for the native token, else a
   * strictly-validated `address!("resource_…")` — so the resource never reaches the manifest as a raw
   * string splice (same injection guard as every other spliced value).
   */
  private resourceArg(): string {
    return NATIVE_ALIASES.has(this.resource) ? NATIVE_KEYWORD : `address!("${checkResource(this.resource)}")`;
  }

  async open(params: {
    fund: AmountInput;
    perTxCap: AmountInput;
    dailyCap: AmountInput;
    epochsPerWindow: number;
    whitelist: string[];
    /** Resource to fund the budget with: `"XTR"` (default) or a `resource_…` address. */
    resource?: string;
  }): Promise<this> {
    const { fund, perTxCap, dailyCap, epochsPerWindow, whitelist } = params;
    this.resource = params.resource ?? XTR;
    const wl = whitelist.map((m) => `address!("${checkComponent(m)}")`).join(", ");
    const manifest =
      `use ${checkTemplate(this.budgetTemplate)} as AgentBudget;\n` +
      "fn main() {\n" +
      '    let mut owner = var!["owner"];\n' +
      `    let funds = owner.withdraw(${this.resourceArg()}, amount!(${amt(fund)}));\n` +
      `    let (comp, owner_badge, agent_badge) = AgentBudget::new(` +
      `funds, amount!(${amt(perTxCap)}), amount!(${amt(dailyCap)}), ${u64(epochsPerWindow, "epochs_per_window")}u64, [${wl}]);\n` +
      "    owner.deposit(owner_badge);\n" +
      "    owner.deposit(agent_badge);\n" +
      "}\n";
    const res = await this.client.run(manifest, { owner: this.ownerAccount });
    // Locate the new component from the engine's `std.component.created` event (its template address
    // identifies it), not by scanning for "the first unknown component address" in the result blob.
    // Fall back to that scan only if the event is ever absent, so discovery never regresses. (#2)
    let comp = createdComponent(res, this.budgetTemplate);
    if (!comp) {
      const blob = JSON.stringify(res);
      const comps = components(blob, new Set([this.ownerAccount, this.agentAccount, ...whitelist]));
      comp = comps.length > 0 ? comps[0] : null;
    }
    if (!comp) throw new ChainError("could not locate the new budget component in the result");
    this.component = comp;
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

  /**
   * Recover the budget this instance opened from a CONFIRMED open-tx result, when the open itself
   * came back ambiguous ("unknown") and the caller never learned the component. Locate the new
   * component in the finalized result and resolve its badges from chain, exactly as `open()` does,
   * then populate this instance. `exclude` lists component addresses that are NOT the new budget
   * (the owner and agent accounts are always excluded; pass known merchant/whitelist addresses too,
   * so a whitelisted merchant mentioned in the result is never mistaken for the budget). Returns the
   * component address, or null if the result created no new component (so the caller can leave the
   * record open rather than mount the wrong thing).
   */
  async attachFromOpenResult(result: unknown, exclude: string[] = []): Promise<string | null> {
    let comp = createdComponent(result, this.budgetTemplate);
    if (!comp) {
      const blob = JSON.stringify(result ?? null);
      const skip = new Set([this.ownerAccount, this.agentAccount, ...exclude]);
      const comps = components(blob, skip);
      comp = comps.length > 0 ? comps[0] : null;
    }
    if (!comp) return null;
    this.component = comp;
    [this.ownerBadge, this.agentBadge] = await this.readBadges();
    return this.component;
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
      this.ownerProofOpen() +
      '    let mut budget = var!["budget"];\n' +
      `    let coins = budget.withdraw(amount!(${amt(amount)}));\n` +
      "    owner.deposit(coins);\n" +
      this.ownerProofClose() +
      "}\n";
    await this.runOwner(manifest, { owner: this.ownerAccount, budget: this.component! });
  }

  async addMerchant(merchant: string): Promise<void> {
    await this.ownerCall(`add_merchant(address!("${checkComponent(merchant)}"))`);
    if (!this.whitelist.includes(merchant)) this.whitelist.push(merchant);
  }

  /**
   * Owner removes `merchant` from the on-chain whitelist (template `remove_merchant`, owner-badge
   * gated). The address stops being payable the moment the tx finalizes; the local mirror is
   * updated only after the chain accepted the call. Removing an address that is not whitelisted is
   * a no-op on chain (the template's set-remove is idempotent).
   */
  async removeMerchant(merchant: string): Promise<void> {
    await this.ownerCall(`remove_merchant(address!("${checkComponent(merchant)}"))`);
    this.whitelist = this.whitelist.filter((m) => m !== merchant);
  }

  /**
   * Owner changes both caps in one on-chain call (template `set_limits`, owner-badge gated). The
   * chain enforces the new per-transaction cap on the very next `pay`; the daily cap applies to the
   * current rolling window (spend already counted in the window is kept, not reset). Amounts are
   * normalised through the same guard as every other `amount!(…)` literal.
   */
  async setLimits(perTxCap: AmountInput, dailyCap: AmountInput): Promise<void> {
    const p = amt(perTxCap);
    const d = amt(dailyCap);
    await this.ownerCall(`set_limits(amount!(${p}), amount!(${d}))`);
    this.perTxCap = p;
    this.dailyCap = d;
  }

  /**
   * Owner mints a new agent session badge labelled `session` and deposits it into `toAccount`
   * (defaults to this budget's agent account). The new badge can `pay` within the same on-chain
   * caps/whitelist until the owner revokes that session. Returns the session label.
   */
  async issueAgentBadge(session: string, opts: { toAccount?: string } = {}): Promise<string> {
    const target = opts.toAccount ?? this.agentAccount;
    checkSession(session);
    const manifest =
      "fn main() {\n" +
      '    let mut owner = var!["owner"];\n' +
      this.ownerProofOpen() +
      '    let mut budget = var!["budget"];\n' +
      `    let badge = budget.issue_agent_badge("${session}");\n` +
      '    let mut agent = var!["agent"];\n' +
      "    agent.deposit(badge);\n" +
      this.ownerProofClose() +
      "}\n";
    await this.client.run(manifest, {
      owner: this.ownerAccount,
      budget: this.component!,
      agent: target,
    });
    if (!this.sessions.includes(session)) this.sessions.push(session);
    // Mirrors the template, which drops the label from its revoked list on a successful mint. Note a
    // REVOKED badge's label can only be re-minted after that badge was burned: the engine refuses to
    // re-create an NFT that still exists — re-enable with a new label instead.
    this.revokedSessions = this.revokedSessions.filter((s) => s !== session);
    return session;
  }

  /**
   * Owner revokes a single agent session badge. Other sessions keep working; use `revoke()` for the
   * global kill switch.
   */
  async revokeSession(session: string): Promise<void> {
    await this.ownerCall(`revoke_session("${checkSession(session)}")`);
    if (!this.revokedSessions.includes(session)) this.revokedSessions.push(session);
  }

  /**
   * Owner reconfigures the rolling allowance window (and restarts it now). The daily cap is the
   * recurring per-window allowance — there is no on-chain timer (see the template docs).
   */
  async setWindow(epochsPerWindow: number): Promise<void> {
    await this.ownerCall(`set_window(${u64(epochsPerWindow, "epochs_per_window")}u64)`);
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
      `    let funds = funder.withdraw(${this.resourceArg()}, amount!(${amt(amount)}));\n` +
      '    let mut budget = var!["budget"];\n' +
      "    budget.top_up(funds);\n" +
      "}\n";
    await this.client.run(manifest, { funder, budget: this.component! });
  }

  /**
   * Manifest lines that prove the owner badge — and, in the 0.49 dialect, open the authorization
   * window the budget's owner-gated methods are reached through.
   */
  private ownerProofOpen(): string {
    const line = `    let proof = owner.create_proof_for_resource(address!("${checkResource(this.ownerBadge)}"));\n`;
    return line + (this.proofWindows ? "    authorize!(proof);\n" : "");
  }

  /** Closes the window opened by `ownerProofOpen` (0.49 dialect) and drops the proof. */
  private ownerProofClose(): string {
    return (this.proofWindows ? "    drop_authorize!(proof);\n" : "") + "    drop_all_proofs!();\n";
  }

  /**
   * A remediation hint appended to an owner-call failure when the manifest dialect was a DEFAULTED
   * guess (walletd exposes no version RPC to auto-detect it). Owner-badge manifests use
   * `authorize!`/`drop_authorize!` on the 0.49 dialect and omit them on 0.47; a parser that does not
   * know the macro rejects the whole manifest, and even when it parses, the wrong dialect leaves the
   * authorization window unopened — both otherwise hard to attribute. Mirrors the Python SDK's
   * `_dialect_hint`. (P1-3)
   */
  private dialectHint(): string {
    const assumed = this.proofWindows ? "0.49 (proof-window)" : "0.47 (pre-window)";
    const flip = this.proofWindows ? "0" : "1";
    return (
      ` [owner-badge manifests assume the ${assumed} walletd dialect, DEFAULTED and not verified ` +
      `against the daemon version; if walletd rejected this as a manifest-parse/authorization ` +
      `mismatch, set AGENTPAY_PROOF_WINDOWS=${flip} to match your walletd.]`
    );
  }

  /**
   * Submit an owner-badge manifest, enriching a failure with the dialect hint when the dialect was a
   * silent default — so a 0.47/0.49 mismatch is attributable instead of a bare rejection. A clean
   * transport/token auth failure (`authFailed`) is left untouched; its cause is not the manifest
   * dialect. Mirrors the Python SDK's `_run_owner`. (P1-3)
   */
  private async runOwner(manifest: string, variables: Record<string, string>): Promise<any> {
    try {
      return await this.client.run(manifest, variables);
    } catch (e) {
      if (this.proofWindowsGuessed && e instanceof Error && !(e as any).authFailed) {
        e.message += this.dialectHint();
      }
      throw e;
    }
  }

  private async ownerCall(call: string): Promise<void> {
    const manifest =
      "fn main() {\n" +
      '    let mut owner = var!["owner"];\n' +
      this.ownerProofOpen() +
      '    let mut budget = var!["budget"];\n' +
      `    budget.${call};\n` +
      this.ownerProofClose() +
      "}\n";
    await this.runOwner(manifest, { owner: this.ownerAccount, budget: this.component! });
  }

  // -- agent -----------------------------------------------------------------------
  private payManifest(merchant: string, amount: AmountInput, memo: string, session: string = this.session): string {
    // The agent presents a proof of ONE session badge (selected by its non-fungible id — see the
    // `session` field); `pay` reads it to identify (and, if revoked, refuse) the session before
    // moving funds. The label is validated before it is spliced into the `non_fungible_id!("…")` literal.
    return (
      "fn main() {\n" +
      '    let mut agent = var!["agent"];\n' +
      `    let proof = agent.create_proof_by_non_fungible_ids(address!("${checkResource(this.agentBadge)}"), [non_fungible_id!("${checkSession(session)}")]);\n` +
      '    let mut budget = var!["budget"];\n' +
      `    budget.pay(proof, address!("${checkComponent(merchant)}"), amount!(${amt(amount)}), "${checkMemo(memo)}");\n` +
      "    drop_all_proofs!();\n" +
      "}\n"
    );
  }

  /**
   * The agent pays a whitelisted merchant. The client-side checks are only an early, friendly
   * error — the chain enforces the real limits regardless of what this client does. The local
   * ledger is updated from the on-chain `pay` event, not from the request.
   */
  async pay(merchant: string, amount: AmountInput, opts: { memo?: string; session?: string } = {}): Promise<any> {
    const memo = opts.memo ?? "";
    this.precheck(merchant, amount);
    const res = await this.client.run(this.payManifest(merchant, amount, memo, opts.session ?? this.session), {
      agent: this.agentAccount,
      budget: this.component!,
    });
    for (const ev of OnChainBudget.payEvents(res)) { // ledger follows the chain's events
      const paid = big(ev.amount ?? amount); // exact, from the on-chain event
      // Track spend from the chain's OWN running total (`spent_in_window`), not by accumulating
      // locally. The on-chain window resets lazily, so a local accumulator keeps growing past a window
      // roll (and misses spends by OTHER sessions of this budget), making the `#precheck` daily-cap
      // guard wrongly reject payments the chain would accept. Fall back to accumulation only if an
      // event lacks the field. Mirrors the Python SDK (onchain.py). (D-4)
      this.spent = ev.spent_in_window != null ? big(ev.spent_in_window).toString() : (big(this.spent) + paid).toString();
      this.ledger.push({ merchant: ev.merchant ?? merchant, amount: paid.toString(), memo: ev.memo ?? memo, txKind: "pay" });
    }
    return res;
  }

  /**
   * Ask the validator (via a dry run) whether this pay would be rejected, returning the on-chain
   * reason — used to show that the *chain*, not the client, enforces the rules. Returns null if
   * the pay would be accepted.
   */
  async wouldReject(merchant: string, amount: AmountInput, opts: { memo?: string; session?: string } = {}): Promise<string | null> {
    const memo = opts.memo ?? "forced";
    let r;
    try {
      r = await this.client.dryRun(this.payManifest(merchant, amount, memo, opts.session ?? this.session), {
        agent: this.agentAccount,
        budget: this.component!,
      });
    } catch (e) {
      // The dry run never reached a verdict — a transport drop, timeout or malformed response thrown
      // by the fetch layer. The validator did NOT rule, so this is NOT a rejection; flag it
      // `transient` so the caller falls through to the real submit instead of reporting a phantom
      // "validator rejected". (#3)
      const err = e instanceof ChainError
        ? e
        : new ChainError(`could not verify with the validator (transient): ${(e as any)?.message ?? e}`);
      if (!(err as any).authFailed) (err as any).transient = true;
      throw err;
    }
    // walletd surfaces a dry-run rejection either as an RPC error (plain message — parsed in the one
    // place cleanReason lives) or as a finalized result whose TransactionResult is Reject (structural).
    if (r.error) {
      const msg = r.error.message ?? "rejected";
      // A TRANSIENT indexer error that survived dryRun's retry loop is not a verdict either — raise it
      // `transient` rather than parse it into a fake reject reason. (#3)
      if (isTransient(msg)) {
        const err = new ChainError(`could not verify with the validator (transient): ${msg}`);
        (err as any).transient = true;
        throw err;
      }
      return cleanReason(msg);
    }
    const outcome = finalizedOutcome(r.result);
    return outcome && outcome[0] === "reject" ? outcome[1] : null;
  }

  /** Pay an invoice: the invoice id + agent tag ride along as the on-chain memo. `session` selects
   *  which issued session badge pays (defaults to this client's `session`). */
  async payInvoice(params: {
    merchant: string;
    invoiceId: string;
    amount: AmountInput;
    agentTag?: string;
    session?: string;
  }): Promise<any> {
    const memo = encodeMemo(params.invoiceId, params.agentTag ?? "").Message;
    return this.pay(params.merchant, params.amount, { memo, session: params.session });
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
  /**
   * Read live budget state by dry-running `get_info` and decoding its name-keyed `info` event (#1):
   * `revoked`, `balance`, `perTxCap`, `dailyCap`, `spentInWindow`, `windowStartEpoch`,
   * `epochsPerWindow` — amount/epoch fields as exact decimal strings. Because fields are keyed by
   * NAME, a same-type field swap in the component struct is caught here (the positional read cannot
   * see it). The dry run charges no real fee. Mirrors the Python SDK's `read_info`.
   */
  async readInfo(): Promise<BudgetInfo> {
    if (!this.component) throw new ChainError("budget component is not set");
    const manifest = 'fn main() {\n    let budget = var!["budget"];\n    budget.get_info();\n}\n';
    // A status read must not inherit the real-submit retry budget (~6 min): give the read-only dry-run
    // a short budget so a jittery indexer stalls it for seconds, not minutes. (6th-round review, batch 2)
    const r = await this.client.dryRun(manifest, { budget: this.component }, undefined, READ_DRYRUN_RETRY);
    const payload = infoEventPayload(r);
    if (!payload) throw new ChainError("get_info dry-run did not expose an info event");
    return parseInfoPayload(payload);
  }

  async readWindow(): Promise<WindowStatus> {
    if (!this.component) throw new ChainError("budget component is not set");
    const currentEpoch = await this.client.currentEpoch();
    // Prefer the name-keyed info-event read (catches a same-type field swap, #1); fall back to the
    // positional component-state read if the event is unavailable (older template / changed shape).
    try {
      const info = await this.readInfo();
      return windowStatus({
        dailyCap: Number(info.dailyCap),
        spentInWindow: Number(info.spentInWindow),
        windowStartEpoch: Number(info.windowStartEpoch),
        epochsPerWindow: Number(info.epochsPerWindow),
        currentEpoch,
      });
    } catch {
      const sub = await this.client.getSubstate(this.component);
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
      // Filter by the event topic, not merely "payload has merchant+memo" — a `pay_via_escrow` event
      // carries those too and would otherwise be miscounted. The engine NAMESPACES a template event
      // topic as "<Struct>.<event>", so the on-chain topic is "AgentBudget.pay" (and escrow is
      // "AgentBudget.pay_via_escrow"); match the final segment == "pay" so both the namespaced form
      // and a bare "pay" are accepted while "pay_via_escrow"/"pay_fee" are still excluded. (A bare
      // "pay" check silently dropped EVERY real pay event, emptying the ledger.) The de-dup key
      // includes `spent_in_window` (strictly increasing per pay): two COPIES of one event share it and
      // collapse, two DISTINCT pays in a tx differ and are both kept. See docs/audit-notes.md.
      const topic = typeof ev.topic === "string" ? ev.topic : "";
      const leaf = topic.includes(".") ? topic.slice(topic.lastIndexOf(".") + 1) : topic;
      if (leaf !== "pay") continue;
      const p = ev.payload;
      if (p && typeof p === "object" && "merchant" in p && "memo" in p) {
        const key = JSON.stringify([p.merchant, p.amount, p.memo, p.spent_in_window]);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(p);
        }
      }
    }
    return out;
  }
}
