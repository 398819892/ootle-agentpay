# Contract security audit — identity binding, authorization & fund conservation

**Scope:** the three on-chain templates — `templates/agent_budget`, `templates/escrow`,
`templates/otc_board` — read as of this pass. This is a *systematic* re-audit (not a feature round):
every state-changing / fund-moving function was walked function-by-function against four questions —
**who may call it**, **what state it requires**, **what funds move**, **what event is emitted** — and
then checked for the five classic failure modes the improvement roadmap called out:

1. caller identity bound to the *recorded* principal (buyer/seller/arbiter/owner/agent), not merely
   passed in as an argument;
2. an unauthorized account cannot change order state / release / refund / resolve;
3. pay / release / refund / dispute / resolve cannot be **replayed**;
4. state transitions are confined to the legal path;
5. an arbiter cannot pull their stake while they are still on the hook for a live dispute;
6. no race between *revoke / change-limits* and an in-flight payment.

plus the cross-product question: **can the budget caps be bypassed by routing through
`pay_via_escrow`?**

**Headline result:** no *new* exploitable fund-theft or authorization-bypass bug was found in this
pass. The genuinely exploitable issues were found and fixed in earlier rounds (arbiter unstake during
dispute, txId attribution, multi-instance double-spend in the web layer, confirmed-payment badge
mismatch, idempotency-key binding — see the side-session notes). What this pass adds is (a) the
function-by-function tables below, (b) two documented *trust / liveness* limitations that are inherent
to the design rather than bugs, and (c) a large batch of **"unauthorized must fail AND move nothing"**
regression tests + the **budget-cannot-be-bypassed-via-escrow** integration tests that pin all of the
above so a regression would turn a suite red.

Identity model across all three: callers are authenticated by
`CallerContext::transaction_signer_public_key()` compared to the public key **recorded on the
component/listing at creation / take time**, or by a **badge proof** (`Proof::assert_resource` +
component `AccessRules`). Amounts are the engine's **unsigned** `Amount`; fees truncate down.

---

## 1. AgentBudget (`templates/agent_budget/src/lib.rs`)

Owner holds the **owner badge** (component access rules gate every owner method); the agent holds a
non-fungible **agent-badge session token** and authorizes `pay` / `pay_via_escrow` by presenting a
proof of that resource, checked *inside* the method (`authorize_session`).

| fn | legal caller | pre-state | funds move | event | notes |
|----|--------------|-----------|------------|-------|-------|
| `new` | anyone (becomes owner) | — | locks `funds` into vault | — | mints owner + first agent ("default") badge; caps must be ≥0, window >0 |
| `pay` | holder of a non-revoked agent-badge session (proof) | not globally revoked | vault → merchant, `amount` | `pay` | `amount>0`, `≤per_tx_cap`, merchant whitelisted, `spent+amount≤daily_cap`; **counter incremented before withdraw** (CEI) |
| `pay_via_escrow` | same as `pay` | same + escrow configured | vault → new Escrow, `amount` | `pay_via_escrow` | **same four checks + same daily counter** as `pay`; opens an Escrow with payer = tx signer (agent), refund target = owner, payee = merchant |
| `configure_escrow` | owner badge | — | none | `configure_escrow` | `fee_bps≤10000` |
| `set_limits` | owner badge | — | none | `set_limits` | caps ≥0 |
| `add_merchant` / `remove_merchant` | owner badge | — | none | resp. | idempotent add |
| `issue_agent_badge` | owner badge | — | none (mints a badge NFT) | `issue_agent_badge` | re-issuing a label clears its revoked flag; label uniqueness enforced by mint |
| `revoke_session` | owner badge | — | none | `revoke_session` | adds the session id to the deny list |
| `top_up` | **anyone** (owner/keeper) | — | caller → vault | `top_up` | must be the vault's resource; open by design (external keeper) |
| `set_window` | owner badge | — | none | `set_window` | resets window + spent counter now |
| `revoke` | owner badge | — | none | `revoke` | global kill switch |
| `withdraw` | owner badge | — | vault → caller, `amount` | `withdraw` | owner pulls remaining; `vault.withdraw` reverts if > balance |
| `get_badges` / `get_info` | anyone (read) | — | none | — | read-only |

**Findings / confirmations**
- **Caps cannot be bypassed through the escrow route.** `pay` and `pay_via_escrow` route through the
  *same* `authorize_session` + the *same* `amount>0 / per_tx_cap / whitelist / roll_window / daily_cap`
  gate, and both increment the *same* `spent_in_window` before moving funds. There is no code path that
  puts funds into an escrow without passing the budget gate. Pinned by the new
  `tests/escrow_integration.rs` (per-tx, daily, whitelist, global-revoke, session-revoke, and a
  *shared-counter* test where a direct `pay` consumes part of the daily cap and a following
  `pay_via_escrow` over the remainder is rejected with the vault unchanged).
- **No revoke/limit vs in-flight-pay race at the contract layer.** The Ootle serializes transactions
  that touch a component's substate (single-writer lock), so there is no intra-method TOCTOU: a
  `revoke` / `set_limits` either commits before a `pay` (which then fails / uses the new caps) or after
  it. Cross-transaction ordering is consensus, not a contract race. (The *web* layer's idempotency/
  double-submit concerns are handled separately — see the stability notes.)
- **`top_up` is intentionally open** (a keeper tops the budget up on its own cadence; there is no
  on-chain scheduler). It can only *add* the vault's own resource; a wrong resource reverts. Not a
  vector to move funds *out*.
- **CEI ordering is correct in `pay`:** `spent_in_window += amount` happens *before* the external
  `merchant.deposit`, and the vault `withdraw` reduces the balance before the invoke, so a reentrant
  `pay` via a malicious merchant `deposit` cannot double-spend (and the engine's component lock blocks
  reentry into the same component anyway).

---

## 2. Escrow (`templates/escrow/src/lib.rs`)

Identity recorded at `new`: `payer` = tx signer, plus `payee`, optional `arbiter`, and the
`payer_account` / `payee_account` / `treasury_account`. Access rules are `allow_all`; every method
enforces identity internally.

| fn | legal caller | pre-state | funds move | event | notes |
|----|--------------|-----------|------------|-------|-------|
| `new` | anyone (becomes payer) | — | locks `funds` | — | `funds>0`, `timeout>0`, `fee_bps≤10000` |
| `release` | payer, **or** anyone with the hashlock preimage | Open | fee → treasury, remainder → payee | `released` | preimage is a crypto condition, **not** a payment receipt (see trust note) |
| `refund` | payer only | Open, `epoch≥deadline` | all → payer_account | `refunded` | no fee on refund |
| `dispute` | payer or payee | Open | none | `disputed` | freezes to Disputed |
| `resolve` | the recorded arbiter only | **Disputed** | split: payee_net + fee + payer | `resolved` | `0≤to_payee≤balance`; fee on payee share only |
| `get_state` / `get_info` | anyone (read) | — | none | — | read-only |

**Findings / confirmations**
- Every exit (`release` / `refund` / `resolve`) is **single-use**: it asserts the entry state and sets
  a terminal state, so it cannot be replayed (`double_release_fails`, and the new
  `resolve_requires_disputed_state` / `release_by_stranger_without_hashlock_fails`).
- Conservation holds across release/refund/resolve including boundary splits and fee truncation
  (existing `conservation.rs` fuzz + `edge.rs`). `illegal_transitions_reject_and_move_no_funds` already
  asserts a rejected call moves nothing.
- `resolve` reads `balance` live and bounds `to_payee_amount ≤ balance`, so it cannot over-pay.

---

## 3. OtcBoard (`templates/otc_board/src/lib.rs`)

Per-listing escrow with an **explicit OTC role model**: `seller` (+ `seller_account`) recorded at
`list`, `buyer` (+ `buyer_account`, optional `hashlock`) recorded at `take`, `arbiter` chosen from the
owner's whitelist. Owner methods are gated by the **owner badge** via component access rules.

| fn | legal caller | pre-state | funds move | event | notes |
|----|--------------|-----------|------------|-------|-------|
| `new` | anyone (becomes owner) | — | — | — | `fee_bps≤10000`, bond ≥0, max >0 |
| `list` | anyone (becomes seller) | — | locks asset + bond | `list` | asset ∈ (0, max], bond ≥ min, timeout >0, arbiter whitelisted |
| `cancel` | the listing's **seller** | Open | asset + bond → seller | `cancel` | state set to Cancelled **before** deposits (CEI) |
| `take` | **anyone** (becomes buyer) | Open | none | `take` | buyer/buyer_account/hashlock are params; see griefing note |
| `confirm` | the **seller**, or anyone with the hashlock preimage | Taken | fee → treasury, asset−fee → buyer, bond → seller | `confirm` | state set to Settled **before** deposits (CEI) |
| `reclaim` | the listing's **seller** | Taken, `epoch≥deadline` | asset + bond → seller | `reclaim` | no fee |
| `open_dispute` | the listing's **seller or buyer** | Taken | none | `dispute` | freezes to Disputed |
| `resolve` | the listing's **arbiter** | Disputed | split asset (fee on buyer share) + bond → seller | `resolve` | if `arbiter_stake>0`, arbiter must have staked ≥ it |
| `add_arbiter` / `remove_arbiter` | owner badge | — | none | — | whitelist mgmt |
| `set_params` | owner badge | — | none | — | `fee_bps≤10000`, max >0 |
| `set_arbiter_stake` | owner badge | — | none | `set_arbiter_stake` | required stake to resolve; 0 disables |
| `stake_arbiter` | a **whitelisted** arbiter | — | caller → board (held) | `stake_arbiter` | |
| `unstake_arbiter` | the staking arbiter | **no open dispute naming them** | board → caller (all) | `unstake_arbiter` | **guard fixed in an earlier round**; re-pinned here |
| `slash_arbiter` | owner badge | — | arbiter's stake → treasury | `slash_arbiter` | penalty backing arbiter decisions |
| `get_*` | anyone (read) | — | none | — | read-only |

**Findings / confirmations**
- Every settlement exit binds the caller to the *recorded* principal (seller for cancel/reclaim,
  seller-or-preimage for confirm, seller-or-buyer for dispute, the listing's arbiter for resolve) — not
  to a call argument. New tests pin "unauthorized caller → reject AND listing state + all balances
  unchanged" for cancel, reclaim, open_dispute, resolve-when-not-disputed, and double-take.
- Replay is blocked by the state machine (`double_confirm_does_not_double_release` and the new
  `resolve_twice_rejected` / `cancel_after_taken_rejected`).
- Conservation (asset split + bond round-trip + stake stake/unstake/slash) is covered by the fuzz +
  boundary tests in `conservation.rs`.

### Documented limitations (design/trust, **not** contract bugs — no fix in this pass)

- **L1 — `take` has no taker bond ⇒ free listing griefing.** `take` is open to anyone and the taker
  posts nothing, so a griefer can take a listing with a bogus buyer and lock it until the seller's
  timeout `reclaim`. No funds are stolen (the seller gets asset + bond back on reclaim), but the slot
  is denied for `timeout_epochs`. Mitigation if this matters commercially: require a taker bond or bind
  the buyer to the signer. Left as-is because the board intentionally lets a buyer be recorded on whose
  behalf the take is made.
- **L2 — hashlock preimage is a crypto condition, not a payment receipt.** In both Escrow and OtcBoard,
  whoever holds the preimage can `release`/`confirm` to the recorded buyer account — *before* any
  off-chain payment clears. OTC settlement therefore relies on off-chain payment trust + the arbiter,
  and is **not** a trustless atomic swap. Already called out in `docs/security.md`; restated here so the
  audit is self-contained.
- **L3 — slashing an arbiter mid-dispute blocks that dispute's `resolve` until the stake bar is
  lowered.** If `arbiter_stake>0` and the owner `slash_arbiter`s the listing's arbiter while the
  listing is Disputed, the arbiter's staked balance drops to 0 and `resolve` then fails
  ("Arbiter has not staked enough to resolve"). There is **no arbiter reassignment**, so the same
  arbiter must resolve. **Funds are not permanently frozen**: the owner can `set_arbiter_stake(0)` (or
  the arbiter can re-stake) and `resolve` then proceeds. This recovery path is pinned by the new
  `slashed_arbiter_mid_dispute_can_resolve_after_stake_requirement_lowered` test. A production board
  that wants slash-and-replace would need an arbiter-reassignment method (a feature, out of scope).

---

## Test deltas added by this pass

- `templates/otc_board/tests/authz.rs` — unauthorized-caller + no-state-change tests for cancel,
  reclaim, open_dispute, resolve (not-disputed and non-arbiter with state assertions), double-take,
  and the L3 slash-then-recover liveness pin.
- `templates/escrow/tests/authz.rs` — release-by-stranger-without-hashlock, resolve-when-not-disputed,
  each asserting the balance/state is untouched.
- `templates/agent_budget/tests/escrow_integration.rs` — the cross-product chain: budget caps
  (per-tx / daily / whitelist / global-revoke / session-revoke) are enforced on the `pay_via_escrow`
  route, the daily counter is **shared** with `pay`, only the agent (escrow payer) can release while a
  stranger/merchant cannot, and the refund-to-owner path works — all asserting the budget vault is
  unchanged on every rejected attempt.

Full suite after this pass: see the run numbers in the hand-off note / commit message.
