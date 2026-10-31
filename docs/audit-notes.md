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

**Headline result (updated):** a follow-up **independent review found one release-blocking P0 that an
earlier pass had mis-filed as a griefing limitation** — OtcBoard `take` did not bind the buyer to the
signer and let the *taker* supply the release `hashlock`, so any stranger could empty any Open listing
for free. It is now **fixed** (see **§P0** under OtcBoard) with regression tests. This exactly
contradicted failure-mode #1 ("caller identity bound to the recorded principal, not passed in as an
argument"), which is why it is called out prominently. The lesson: check #1 against *who ends up
receiving funds*, not only who the state-transition assertions name. Other genuinely exploitable issues
were found and fixed in earlier rounds (arbiter unstake during dispute, txId attribution, multi-instance
double-spend in the web layer, confirmed-payment badge mismatch, idempotency-key binding — see the
side-session notes). Two reviewer points on identity *decoupling* (Escrow `payee` vs `payee_account`,
and `pay_via_escrow`'s `merchant_pubkey`) were examined and are **not** fund-theft vectors — funds can
only reach the pre-agreed accounts — but a readability gap is closed by Escrow's new `get_parties`
(see §2). The rest of this pass still stands: (a) the function-by-function tables below, (b) documented
*trust / liveness* limitations, and (c) the **"unauthorized must fail AND move nothing"** + the
**budget-cannot-be-bypassed-via-escrow** regression suites.

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
- **`pay_via_escrow` `merchant_pubkey` is unbound from the whitelist — reviewed, **not** a fund risk.**
  The whitelist constrains the `merchant` **account** (checked: `merchant_whitelist.contains(&merchant)`),
  and that account is the escrow's `payee_account`. The `merchant_pubkey` argument becomes the escrow's
  `payee` key, which only grants the right to `dispute`. The opened escrow records the agent as payer
  and passes `hashlock = None`, so the escrowed funds can only reach the **whitelisted merchant
  account** (release/resolve) or the **owner account** (refund/resolve) — never a third party, whatever
  pubkey the agent supplies. So budget spend-control (pay only whitelisted destinations) holds. The
  only downside of a wrong `merchant_pubkey` is that the real merchant could not raise a dispute; the
  merchant should verify it via Escrow's new `get_parties` before delivering (see §2). Binding the pair
  on chain would require the owner to whitelist `(account, pubkey)` tuples — a product enhancement, not
  a safety fix, so deferred.

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
- **`payee` pubkey vs `payee_account` (reviewer point).** The payer sets both independently at `new`:
  `payee` is the key allowed to `dispute`, `payee_account` is where `release`/`resolve` pays. **No fund
  risk** — the escrowed funds belong to the payer and can only ever flow to `payee_account`,
  `payer_account` or the treasury, so a mismatch cannot divert funds to a third party. The only effect
  of a mismatch is that the *intended* payee might not hold the recorded `payee` key and so could not
  `dispute`. These were previously **unreadable**, so a payee had no way to check before relying on the
  escrow. Fixed by adding `get_parties() → (payer, payee, arbiter, payee_account, payer_account)` and
  documenting the "payee verifies before delivering" constraint in the module docs and
  `get_parties_exposes_recorded_identities` (`templates/escrow/tests/test.rs`).

---

## 3. OtcBoard (`templates/otc_board/src/lib.rs`)

Per-listing escrow with an **explicit OTC role model**: `seller` (+ `seller_account`, optional
payment `hashlock`) recorded at `list`, `buyer` (+ `buyer_account`) recorded at `take` **and bound to
the transaction signer**, `arbiter` chosen from the owner's whitelist. Owner methods are gated by the
**owner badge** via component access rules.

| fn | legal caller | pre-state | funds move | event | notes |
|----|--------------|-----------|------------|-------|-------|
| `new` | anyone (becomes owner) | — | — | — | `fee_bps≤10000`, bond ≥0, max >0 |
| `list` | anyone (becomes seller) | — | locks asset + bond | `list` | asset ∈ (0, max], bond ≥ min, timeout >0, arbiter whitelisted |
| `cancel` | the listing's **seller** | Open | asset + bond → seller | `cancel` | state set to Cancelled **before** deposits (CEI) |
| `take` | **anyone** (becomes buyer) | Open | none | `take` | declared `buyer` **must equal the signer**; hashlock is seller-set at `list`, **not** a take param (P0 fix, see §P0) |
| `confirm` | the **seller**, or anyone with the **seller-set** hashlock preimage | Taken | fee → treasury, asset−fee → buyer, bond → seller | `confirm` | state set to Settled **before** deposits (CEI); preimage path is seller-gated (§P0) |
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

### §P0 — Asset theft via unbound `take` + taker-set hashlock (**FIXED this pass**)

An earlier revision let `take(id, buyer_account, buyer, hashlock)` record **all four** from call
arguments without checking the signer, and `confirm` released on `is_seller || has_preimage`. Combined,
this was a **release-blocking P0: any stranger could empty any Open listing for free.** The exploit:

1. Attacker calls `take` on a victim seller's Open listing, passing *their own* `buyer_account` and a
   self-chosen `hashlock = sha256(attacker_secret)` — nothing bound them to the declared `buyer`.
2. Attacker calls `confirm(Some(attacker_secret))`. `has_preimage` is true against their own lock, so
   the seller's locked asset (minus fee) is released **to the attacker's account**, having paid nothing.

The seller's `confirm`-as-payment-receipt and the arbiter were both bypassed — the exact safety goal
("no payout without the seller's confirm or an arbiter's resolve") was broken.

**Root cause:** the *recipient* of the payout (the taker) was allowed to both set the release condition
and name the payout destination. (This was previously **mis-filed as a griefing limitation** — see the
old L1 "bind the buyer to the signer, left as-is". That under-rated it: it was theft, not griefing.)

**Fix (approach A — mirrors Escrow's safe model):**
- `take` now asserts `transaction_signer_public_key() == buyer` ("buyer must be the transaction
  signer"), so a taker can only ever bind *themselves* as buyer.
- The payment `hashlock` is **removed from `take`** and is set only by the **seller** at `list` (the
  seller holds the preimage and reveals it to the buyer once paid off chain). `confirm` keeps
  `is_seller || has_preimage`, but since only the seller can set the lock and holds its secret, a
  non-paying taker can satisfy neither branch. This matches Escrow, where the party who will *not*
  receive the funds sets the lock and the payout destination is fixed, so a revealed preimage can only
  trigger the already-agreed payout, never redirect it.

**Regression tests** (`templates/otc_board/tests/authz.rs`):
`take_cannot_impersonate_a_different_buyer` (signer≠declared buyer ⇒ reject; listing stays Open and the
real buyer is paid), `non_paying_taker_cannot_release_the_asset` (taker's own/empty preimage both
rejected; attacker balance unchanged; seller fully recovers asset+bond via `reclaim`), and
`seller_set_lock_releases_only_with_the_sellers_preimage` (a guessed preimage is rejected, only the
seller's real secret releases to the recorded buyer). Happy paths remain green in `test.rs`
(`list_take_confirm_pays_buyer_minus_fee`, `confirm_by_preimage_holder` — now seller-set).

### Documented limitations (design/trust, **not** contract bugs — no fix in this pass)

- **L1 — `take` has no taker bond ⇒ listing griefing (reduced, not removed).** `take` is still open to
  anyone and the taker posts no bond, so a griefer can take a listing and sit on it until the seller's
  timeout `reclaim`. No funds are stolen (seller gets asset + bond back) and — since the §P0 fix — the
  taker can no longer bind a *third party* as buyer or self-release, so the only residual harm is that
  the slot is denied for `timeout_epochs`. Mitigation if this matters commercially: require a taker
  bond. Left as-is: a taker bond is a product-policy knob, not a safety gap.
- **L2 — a seller-set hashlock is a crypto condition, not an on-chain payment receipt.** When a seller
  sets a `hashlock`, whoever holds the preimage can `confirm` to the *recorded buyer* account — the
  seller reveals it off chain once paid, so this is a seller-gated payment proof, but the chain cannot
  verify the off-chain payment itself. OTC settlement therefore still relies on off-chain payment trust
  + the arbiter, and is **not** a trustless atomic swap. A seller who does not want this delegates
  nothing: passing `hashlock = None` makes `confirm` seller-only. Called out in `docs/security.md`;
  restated here so the audit is self-contained.
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

- **§P0 regression (`templates/otc_board/tests/authz.rs`)** — `take_cannot_impersonate_a_different_buyer`,
  `non_paying_taker_cannot_release_the_asset`, `seller_set_lock_releases_only_with_the_sellers_preimage`.
  These prove the asset-theft chain is dead (forged buyer rejected; non-paying taker cannot release;
  preimage release is seller-gated) while the legitimate take→confirm / take→preimage paths still pay
  the buyer. The `list`/`take` helpers across all three OtcBoard test files were updated for the new
  ABI (hashlock set at `list`, dropped from `take`).
- `templates/escrow/tests/test.rs` — `get_parties_exposes_recorded_identities` pins the new getter used
  for payee verification.
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

---

## Fund-safety pass (independent review — four confirmed issues, now fixed)

A second independent review found four fund-safety issues (pre-mainnet "must fix"). All four were
reproduced in code, fixed, and pinned with an attack-scenario regression test. No cross-template call
signature changed (`Escrow::new` and `AgentBudget::pay_via_escrow` are untouched; OtcBoard gained a
new `claim_dispute_timeout` method but no existing signature changed).

### #1 — Retroactive fee hike (otc_board)
**Was:** `confirm`/`resolve` charged the board's *current* `self.fee_bps`, and `set_params` could
raise it to 10000 at any time. An owner could take the full asset into the treasury after a buyer
took a listing. **Fix:** the fee is snapshotted into `Listing.fee_bps` at `list` time and settlement
uses that snapshot; a module-wide `MAX_FEE_BPS = 1000` (10%) caps the fee in `new`/`set_params` so no
confiscatory rate is possible even on future listings. **Tests:**
`owner_cannot_raise_fee_after_listing_is_taken`, `fee_above_platform_maximum_is_rejected`.

### #2 — Collateral in a worthless resource (otc_board)
**Was:** `list` and `stake_arbiter` only checked `amount`, never `resource_address`, so a seller/
arbiter could post a self-minted air-coin as bond/stake, voiding the skin-in-the-game and making
`slash` empty. **Fix:** the bond must be the **same resource as the listed asset**
(`list`), and the arbiter stake must be **XTR** (the board's single collateral currency). The
`max_listing_amount` cap is documented as denominated in the asset's own resource; bond==asset keeps
each listing single-denomination so the cap is meaningful. **Tests:**
`bond_in_wrong_resource_is_rejected`, `arbiter_stake_in_wrong_resource_is_rejected`.

### #3 — Dispute can freeze funds forever (escrow + otc_board)
**Was:** escrow `arbiter` is `Option`; `dispute` didn't check it, but only an arbiter can `resolve`,
so a dispute on a no-arbiter escrow (e.g. a `pay_via_escrow` escrow with `escrow_arbiter = None`)
froze the funds. Even with an arbiter, an unreachable one froze them with no timeout. OtcBoard had
the same unreachable-arbiter freeze. **Fix (escrow):** `dispute` asserts an arbiter is configured;
it records `dispute_deadline = now + timeout_epochs`; once that passes, `refund` (now any-caller, see
#4) force-closes a stalled dispute by returning everything to the payer. **Fix (otc_board):**
`open_dispute` records `dispute_deadline`; new `claim_dispute_timeout` lets **anyone** force-close
after it, returning asset + bond to the seller (the same safe default as `reclaim` — no on-chain
proof of payment ⇒ asset goes back to the seller). **Tests:**
`dispute_without_arbiter_is_rejected_and_escrow_stays_recoverable`,
`stalled_dispute_refunds_payer_after_deadline` (escrow);
`stalled_dispute_can_be_force_closed_after_deadline` (otc_board).

### #4 — Lost agent key strands escrowed funds (escrow)
**Was:** `refund` was payer-only; if the payer's key (an agent key in `pay_via_escrow`) was lost,
rotated or revoked, the timed-out funds could never be returned. **Fix:** after the timeout `refund`
is callable by **anyone**; the destination is the immutable `payer_account`, so a third party can
recover the funds to the owner and a stolen key still cannot redirect them. **Tests:**
`refund_after_timeout_is_callable_by_anyone_and_pays_the_payer` (replaces the old payer-only test,
which pinned the vulnerable behaviour).

## Second external review (2026-10-30, follow-up) — fixes to the fixes

The reviewer re-read the #1–#4 / #7 fixes and found that fixing the #3 freeze introduced a new
*incentive* problem, plus two residual gaps. All addressed here.

### A — Stalled-dispute timeout was seller-profitable (otc_board)
**Was:** `claim_dispute_timeout` returns the asset to the **seller**, and the arbiter is chosen by
the seller at `list`. A stalling seller could take the buyer's off-chain payment, pick a lazy or
complicit (whitelisted) arbiter, let the dispute time out, and keep *both* the asset and the payment.
(The pre-#3 "freeze forever" was incentive-neutral; the #3 fix made the default profitable.)
**Why not just flip the default to the buyer:** the chain has no proof the buyer paid, so a
buyer-default would let a non-paying buyer take → dispute → wait → steal the asset outright — a
strictly worse, theft-grade bug. The seller-default stays; the collusion incentive is removed
instead. **Fix:** (1) the **buyer confirms the arbiter** at `take` (`expected_arbiter` must equal the
listing's arbiter — the buyer consents, on chain, to the party the timeout favours; read it with
`get_arbiter`); (2) `claim_dispute_timeout` **slashes the stalled arbiter's stake** to the treasury,
so an arbiter who goes dark loses money and a seller gains nothing by recruiting one — the owner
sizes `arbiter_stake` above a deal's value to make collusion unprofitable; (3) the trust model is
documented in the module docs and `docs/interfaces.md`. **Tests:** `take_with_wrong_arbiter_is_rejected`,
`stalled_dispute_slashes_the_absent_arbiter`.

### B — Same timeout asymmetry in escrow (disclosure)
**Was:** escrow's stalled-dispute backstop refunds the **payer**; in `pay_via_escrow` the arbiter is
owner-configured (payer side), so a merchant who delivered can be refunded-against by a stalling
payer + absent arbiter. There is no clean automatic alternative (payer-default is the safe liveness
choice). **Fix:** documented — the escrow module docs now state the dispute-timeout trust model and
direct a payee to verify the arbiter via `get_parties` (and treat a `None` arbiter as "no dispute
protection") before delivering. No code change to the settlement default.

### C — Same-resource bond still allows air-coin listings (otc_board)
**Was:** #2 made the bond the same resource as the asset, but a seller can still list a self-minted
worthless token *as the asset* and post the same worthless token as the bond — the bond check passes
and the skin-in-the-game is empty. **Fix:** an owner-managed **tradable-asset whitelist**
(`asset_whitelist`, with `add_tradable_asset` / `remove_tradable_asset`): when non-empty, `list`
rejects any asset whose resource is not on it, so a board can restrict trading to real resources
(XTR, approved stablecoins). Empty = permissive (documented as not for production). **Test:**
`listing_a_non_whitelisted_asset_is_rejected`.

### D — Address/label regex allowed a trailing newline (sdk onchain.py)
**Was:** `_check_address` / `_check_session` used `re.match` with a `^…$` pattern; Python's `$` also
matches just before a trailing `\n`, so `"component_<64hex>\n"` passed. Not exploitable (the string
literal stays closed), but a gap in the hardening layer. **Fix:** switched to `re.fullmatch`.
**Test:** the trailing-newline case added to `test_pay_manifest_rejects_non_hex_merchant`.

### Fee-multiplication overflow (escrow + otc_board) — fixed
**Was:** `amount * fee_bps / 10000` multiplies first; on a large (e.g. 18-decimal) resource
`amount * fee_bps` can exceed `i64::MAX` and overflow, even though the fee itself (≤ amount) never
does. **Fix:** a shared overflow-safe `fee_on(amount, fee_bps)` computes it as `q*fee_bps +
r*fee_bps/10000` with `q = amount/10000`, `r = amount - q*10000` (r < 10000) — each term stays
bounded and the result is identical to the naive expression. Used by escrow `release`/`resolve` and
otc_board `confirm`/`resolve`. **Test:** `fee_floors_on_indivisible_amount` (1234 @ 5% → 61) plus the
existing fee-bearing settlement tests, which now exercise the split.

## Third external review (2026-10-30, follow-up) — the A fix was bypassable

The reviewer found that last round's A (slash the stalled arbiter) could be dodged through the
**arbiter-stake timing**, and raised three related points. All fixed in otc_board.

### #1 — Stake could be pulled before a dispute, defeating the slash (serious)
**Was:** `unstake_arbiter` only blocked while the arbiter was named on a `Disputed` listing, and
neither `list` nor `take` checked the arbiter actually held stake. So a complicit arbiter could stake,
get taken, then **unstake while the listing was merely `Taken`** (before the buyer disputed); on
timeout the slash found an empty vault. With `arbiter_stake = 0` (default) there was nothing to slash
at all. **Fix:** stake is now **locked to the deal at `take`**: `take` requires the arbiter to have
≥ `arbiter_stake` *free* stake and snapshots that amount into `Listing.arbiter_stake_locked`;
`unstake_arbiter` returns only the **free** (unlocked) part, where "locked" counts every `Taken` *or*
`Disputed` listing the arbiter is named on. The stake therefore cannot leave between take and dispute.
**Tests:** `arbiter_cannot_unstake_while_named_on_a_taken_listing`,
`take_requires_arbiter_free_stake_when_required`.

### #2 — One stake "covered" all concurrent deals
**Was:** `claim_dispute_timeout` did `withdraw_all`, so a seller + arbiter could run N deals in
parallel and the arbiter lost only one stake's worth. **Fix:** each deal locks its own
`arbiter_stake_locked`; `take` requires *free* stake (total − already-locked) ≥ the requirement, so N
concurrent deals need N× the stake, and the timeout burns only that deal's locked portion. **Test:**
`one_stake_cannot_cover_two_concurrent_deals`.

### #3 — Slashed stake enriched the owner (conflict of interest)
**Was:** the timeout slash sent the stake to the treasury (the owner's), giving the owner an incentive
to tolerate arbiter inaction — the very conflict this doc flagged. Paying the buyer instead would
reward a possibly non-paying buyer. **Fix:** the timeout slash now **burns** the stake — moves it to
`slashed_pool`, a vault with no withdrawal path — so it enriches no one while the arbiter still loses
the collateral. (Owner-discretion `slash_arbiter` still banks to treasury; see limitations.) **Test:**
`stalled_dispute_burns_the_absent_arbiters_stake` (asserts treasury and buyer both unchanged).

### #4 — No minimum listing timeout (minor)
**Was:** `timeout_epochs` was seller-set with no floor, so a seller could pick 1 epoch (~30 min),
starving the buyer/arbiter of time. **Fix:** owner-set `min_timeout_epochs` via `set_min_timeout`
(default 0 = none); `list` rejects a shorter window. **Test:** `listing_below_min_timeout_is_rejected`.

## Fourth external review (2026-10-31)

Two web-robustness bugs the reviewer reproduced by running the server, plus OTC owner-power and
retry-safety issues. Fixed the ones with clean fixes; the rest are OTC feature/architecture items
tracked under limitations (and reinforce the standing "freeze OTC, focus AgentPay" recommendation).

- **H1 — a malformed URL crashed the process (fixed).** `serveStatic` called `decodeURIComponent`
  with no guard; `GET /%E0%A4%A` threw `URIError` → unhandled rejection → process exit. Now the
  decode is wrapped (400 on failure), plus a top-level `unhandledRejection`/`uncaughtException` net.
- **H2 — unbounded request body (fixed).** `readBody` rejected over 1 MB but kept appending; a 300 MB
  stream drove RSS to ~410 MB. Now it `req.destroy()`s on overflow and collects Buffers +
  `Buffer.concat` (also fixes multibyte-UTF-8 split across chunks).
- **H3 — owner could force a dispute outcome (fixed).** `resolve` checked the board's *current*
  `arbiter_stake` and the arbiter's live balance, so an owner could block `resolve` (raise the stake
  bar / `slash_arbiter` / `remove_arbiter`) and let the timeout default the asset to a colluding
  seller; `slash_arbiter`'s `withdraw_all` also drained stake locked to in-flight deals. **Fix:**
  `resolve` now checks `listing.arbiter_stake_locked` (the take-time snapshot, owner-immutable), and
  `slash_arbiter` can take only the **free** (unlocked) stake. **Tests:**
  `malicious_owner_cannot_block_an_in_flight_resolve`, `stake_locked_to_a_dispute_cannot_be_unstaked_or_slashed`.
- **H5 — submit retry could double-pay (fixed).** The TS/Python clients retried a *real* submit up to
  30× on transient errors (incl. "did not respond within" / "Failed to submit transaction") — but
  those are ambiguous: the tx may already have landed, so resubmitting is a new, duplicate payment.
  **Fix:** transient-error retry now applies to **dry runs only**; a real submit makes one attempt and
  surfaces a transient failure as `pending` (unknown) for reconciliation, never resubmitting.
- **M1 — timeout overflow / near-infinite lock (fixed).** `now + timeout_epochs` could wrap in a
  release build (deadline in the past → instant refund) and had no upper bound (lock funds ~forever,
  incl. via a leaked agent key in `pay_via_escrow`). **Fix:** `checked_add` everywhere and a
  `MAX_TIMEOUT_EPOCHS` cap in `Escrow::new` and OtcBoard `list`.
- **Owner badge was burnable by anyone (fixed).** AgentBudget and OtcBoard minted the owner badge
  `burnable(AllowAll)` with no recovery — burning it would strand funds/admin. Now `DenyAll`. (Agent
  session badges stay burnable — they are meant to be retired.)
- **Consistency fixes.** v1 `GET /payments/:id` now returns only `pay` records (was any op, incl.
  withdraw); the v1 remove-merchant notice no longer wrongly claims the template lacks
  `remove_merchant`; the invoice scheme/comments no longer say "stealth" (the memo is public
  plaintext); `pyproject.toml` drops the broken `agentpay.cli:main` entry and adds `pytest-asyncio`;
  README test counts corrected to 96 (26/25/45).

### Deferred this round (see limitations below, and the freeze-OTC recommendation)
- **H4** — `take` costs nothing, so an attacker can squat every Open listing (and tie up arbiter
  stake) for the price of fees. A real fix needs a buyer take-deposit or seller approval — an OTC flow
  change. **M2** — Docker loses the idempotency log (txlog/audit/claims not under `/data`), which
  undermines H5's protection; `.dockerignore` gaps; `node:18` EOL. **M3** — all requests (incl. reads)
  share one serial lock; a stuck tx blocks the dashboard. **M4** — a buyer-callable `mark_paid` to
  stop a seller waiting out `reclaim`. **M5** — all clients request Admin on `auth=none` walletd; no
  non-custodial least-privilege path (the #8 custodial point). **M6** — `take` now also scans all
  listings via `locked_stake_for`, so per-tx cost grows with history (needs a per-arbiter counter or
  one-component-per-listing). Plus lows: escrow `dispute` has no deadline check (payee can stall a
  window), checks-effects-interactions ordering, `ADMIN_PASSWORD` defaulting to the login password,
  and the server/SDK session-label regexes disagreeing on spaces.

## Fifth review (2026-10-31, round 2)

Contract-layer hardening against a leaked agent key, plus the cheap-and-correct items. Design/product
and most server-layer items are deferred (listed at the end).

- **#1 — leaked agent key + `pay_via_escrow` (HIGH, fixed).** The escrow's `payer` was the transaction
  signer (the agent), so a leaked agent key could `release` the owner's funds to a colluding merchant,
  and `timeout_epochs` (agent-chosen, up to the ~57-year `MAX_TIMEOUT_EPOCHS`) could lock funds
  long-term. **Fix:** `Escrow::new` now takes an explicit `payer` (the funder names it; naming another
  party only forgoes the funder's own control, since payouts are to fixed accounts). `configure_escrow`
  gains `owner_pubkey` (recorded as the escrow payer) and `max_escrow_timeout`; `pay_via_escrow`
  records the **owner** as payer and asserts `timeout_epochs ≤ max_escrow_timeout`. A leaked agent key
  can no longer release/lock the owner's money. **Tests:** `escrowed_funds_release_only_by_owner_not_agent`,
  `leaked_agent_key_cannot_release_open_escrow`, `pay_via_escrow_rejects_timeout_above_owner_max`.
- **#2 — empty-proof bypass of `revoke_session` (HIGH, fixed).** `authorize_session` checked only the
  proof's resource, not that it carried a badge, so an empty proof (zero tokens) skipped the revocation
  loop. **Fix:** `assert!(sessions.len() == 1, …)`. **Test:** `pay_with_more_than_one_session_badge_is_rejected`
  (the `>1` case; the `==0` case is the same guard).
- **#3 — `roll_window` overflow (fixed).** `window_start_epoch + epochs_per_window` was raw `u64` add
  that wraps in release builds (a `set_window(u64::MAX)` misuse would reset every payment, voiding the
  cap). **Fix:** `saturating_add`, and `overflow-checks = true` in all three templates' release profile.
- **#6 — checks-effects-interactions (fixed).** `release`/`refund`/`resolve` set the terminal state
  **before** any external `invoke("deposit")` now, so a reentrant call hits `assert_open()` (defense in
  depth; no exploitable path was found, but the ordering is free).
- **#7 — unbounded memo (fixed).** `pay`/`pay_via_escrow` now assert `memo.len() ≤ MAX_MEMO_BYTES`
  (253), matching the SDK, so a direct caller can't bloat events/fees.
- **SDK / repo:** `top_up` validates its amount via `_check_amount` (was `int(amount)`, allowed a
  negative); `pyproject.toml` moves `ootle-py` to an optional `[ootle]` extra (the onchain adapter is
  stdlib-only) and drops the "Private … stablecoin" description; the server session-label regex is
  unified with the SDK's (no spaces, #13); runtime state files are `.gitignore`d; Docker base image
  → `node:22-slim`; README OTC-frozen status made consistent (zh prose + quickstarts) and docs/CI
  "no GitHub remote" notes corrected.

### Deferred this round (recommendation: do server-layer next; design/product separately)
Server-layer (not yet done): **#8** persist tx id before awaiting confirmation (crash → stuck pending);
**#9** add an API-key revoke entry point (or drop the "runtime-revocable" claim); **#10** refuse to
start when `ADMIN_PASSWORD == DASHBOARD_PASSWORD` in production; **#11** serialize only submits, not
reads; **#12** make `freeze` low-friction (login only), keep `unfreeze` behind step-up; **#14** require
`Idempotency-Key` on v1 pay + map API key → session; **#15** default MCP to attach (non-custodial) and
read `spent_in_window` from chain; **#16** replace positional substate parsing with a typed `get_info`
dry-run. Design/product: **#4** escrow gives the merchant little (payer picks arbiter / timeout favours
payer) — position `pay_via_escrow` as payer-protection; **#5** the platform fee can't be enforced by an
open-source template — revenue is from the service; SDK `payEvents` topic/dedup and `open()`
component-discovery robustness; resource-address parametrization (drop hard-coded `XTR`); copyright
headers (need the owner's name — not guessed) and TS-vs-rest licence consistency.

## Server-layer pass (2026-10-31) — the deferred #8–#16

Followed up on the fifth review's deferred server items.

- **#8 — tx id lost on a crash mid-confirmation (fixed).** `runChainOp` recorded the tx id only after
  `submitFn` (submit + up-to-minutes wait) returned, so a crash during the wait left a `pending`
  record with no txId — unreconcilable. Now a watcher persists the txId to the journal the moment the
  client's `lastTxId` advances (right after submit), closing the window. Safe because chain ops are
  serialized.
- **#9 — API-key revoke had no entry point (fixed).** Added admin `GET /api/v1/keys` and
  `POST /api/v1/keys/:id/revoke` (the revoke logic existed in apikeys.js), so a leaked key can be
  killed at runtime without an env edit + restart.
- **#10 — step-up reused the login password (fixed).** The server now **refuses to start** when it is
  network-exposed, auth is on, and `AGENTPAY_ADMIN_PASSWORD == DASHBOARD_PASSWORD` (step-up would be
  the same secret, not a second factor). Loopback dev keeps the non-fatal note.
- **#12 — emergency stop was high-friction (fixed).** `freeze` now skips step-up (`noStepUp`) and the
  rate limiter (`bypassRateLimit`) — a logged-in operator can always brake, even under a flood — while
  staying `highRisk` so it is still durably audited. `unfreeze` keeps the full step-up gate.
- **#14 — v1 pay could double-pay on retry (fixed, core).** `POST /api/v1/payments` now **requires** an
  `Idempotency-Key` header (without it a retried request would get a fresh random key and re-submit).
  The thin TS/Python clients already send it. *(Deferred: API-key → session mapping so per-key on-chain
  session revoke works; it currently uses the one "default" session.)*
- **#15 — MCP was custodial by default (fixed, core).** `AGENTPAY_AUTO_PROVISION` now defaults to
  **false**: the MCP/agent attaches to an owner-opened budget (holds only the agent badge) instead of
  opening one with the owner key. Provision is opt-in for demos. The `status()` docstring is corrected
  to stop claiming `spent_in_window` is chain-confirmed (it is a local estimate; `revoked` is probed).

### #11 + #16 (done, with a concurrency / parse test each)
- **#11 — serial lock blocked reads (fixed).** The dashboard router wrapped *every* handler in the
  serial lock, so a GET queued behind an in-flight write (up to minutes on a slow confirm). Now only
  state-changing (POST) handlers serialize; GET reads run concurrently (they never submit or touch
  the shared `lastTxId`). The v1 `/budget` and `/merchants` GETs also drop their `serialize`. **Test:**
  `web/server/concurrency.test.js` — a mock walletd parks a write ~2s in the lock and a concurrent
  `GET /api/state` still returns in < 1s.
- **#16 — positional substate parse (hardened; loud-fail, testable).** The reader took "the first 5
  numbers / first boolean / first array", so a struct reorder returned WRONG values silently. It now
  lives in `web/server/substate.js` and reads by **explicit index + type assertion**, throwing a
  descriptive error on layout drift (the caller falls back to cache). **Test:**
  `web/server/substate.test.js`. *Remaining:* a fully type-safe read (template `get_info` via dry-run,
  decoding a typed return) still wants validation against the live walletd result shape — tracked;
  it would also give MCP `status()` a live `spent_in_window` (#15).

### Design / SDK pass
- **SDK `payEvents` topic + dedup (fixed).** It identified events by "payload has merchant+memo",
  which also matched `pay_via_escrow`, and deduped by `(merchant, amount, memo)`, which collapsed two
  distinct identical pays. Now it filters by `topic == "pay"` and keys the dedup on the running
  `spent_in_window` (strictly increasing per pay) — distinct pays are kept, duplicate copies collapse.
  Python + TS; test `test_pay_events_filters_by_topic_and_keeps_distinct_pays`.
- **Resource parametrization (fixed).** `open()`/`top_up()` hard-coded `XTR`. `open(resource=…)` now
  sets the budget's resource and `top_up` reuses it; the manifest splices `XTR` (native) or a
  validated `address!("resource_…")`. Default stays `XTR`. Test
  `test_resource_parametrization_uses_address_not_xtr`.
- **#4 / #5 documented** in `ootle-plan.md`: `pay_via_escrow` protects the *payer*, not the merchant
  (position it accordingly); and the per-deal fee cannot be enforced by an open-source template, so
  revenue comes from the operated service, not the template.

### Still deferred (need live-chain validation or the owner's input)
- **#14 API-key → session mapping** (per-key on-chain session revoke; currently one "default" session).
- **SDK `open()` component discovery** — still finds the new component by "first unknown address";
  the robust fix decodes the `new` return value, same live-walletd-shape validation as #16's typed read.
- **Copyright headers** (templates say "The Tari Project" — need the owner's name) and the TS-vs-rest
  licence split (MIT vs BSD-3) — both are the owner's call, not guessed.

## Decision: OtcBoard frozen (2026-10-31)

After the fourth review, **OtcBoard is frozen** — moved out of the supported product line, kept in
the repo (compiling, 45 tests green) only as a reference/research artifact. The supported primitives
are **AgentBudget + Escrow**.

**Why.** Across four review rounds the new risks were overwhelmingly OtcBoard's, because its model —
a *custodial arbiter* settling an *off-chain (fiat) payment* with no on-chain proof of payment — is
inherently trust-heavy, and each fix surfaced the next incentive gap (taker-set hashlock P0 → fee
rug → air-coin collateral → dispute-timeout favouring the seller → arbiter-stake timing bypass →
owner power over disputes → free-`take` squatting …). It also has the heaviest regulatory exposure (a
P2P fiat-settlement matcher). Continuing to harden it is low-value churn relative to the agent-payment
core.

**What frozen means.** The module carries a FROZEN banner; the README presents only AgentBudget +
Escrow as supported. Its known-open issues — **H4** (free-`take` squatting), **M4** (seller waits out
`reclaim`; a `mark_paid` would help), **M6** (unbounded listings / per-`take` scan), and the OTC lows
below — are **not being fixed** while frozen. CI still builds and tests it (cheap regression guard);
the on-chain deployments are left as-is. Unfreezing would mean re-opening those issues deliberately.

## Known limitations & mitigations (disclosed, by design — not code bugs)

These are architectural trade-offs, not fixable by a localised patch. They are disclosed here and in
the relevant module docs; the mitigations are the honest answer rather than bolting on risky
half-fixes.

- **#5 — AgentBudget is a fixed window, not sliding.** The daily cap can bind ~2× across a window
  boundary (full cap in the last epoch, full cap again in the first epoch of the next). A true sliding
  window would need an on-chain timestamped spend history. **Mitigation (now in the module docs):**
  set `daily_cap` to half the real ceiling and/or a tight `per_tx_cap`; treat `daily_cap` as a rate
  guard — the hard rails that never over-spend are `per_tx_cap` (per payment) and `revoke` (freeze).
- **#8 / M5 — custodial reference deployment (now has a non-custodial path).** The web *dashboard*
  signs with one walletd account holding the owner + agent badges, so its on-chain caps bind only
  agents coming *through the API*, not the operator — inherent to a custodial server. The limits
  deliver their full value only when the agent holds its **own** key in its own environment. That
  **non-custodial path is now supported**: the SDK/TS `WalletdClient` takes a least-privilege `token`
  (or a narrow `permissions`/`credentials` request) instead of forcing an `auth=none` Admin token, the
  SDK already supports a separate `agent_account`, and the MCP integration reads all of it from env.
  See `docs/deployment-noncustodial.md`. The hosted dashboard stays custodial by design.
- **#4 back-half — revoke doesn't retroactively close open escrows.** `revoke` freezes the budget's
  `pay`/`pay_via_escrow`, but an escrow a leaked agent key *already opened* still releases to the
  payee (or refunds to the fixed `payer_account` after timeout) — the escrow has no link back to the
  budget's revocation flag. Mitigation: keep `timeout_epochs` short for agent-opened escrows so a
  leaked key's window is bounded; the refund destination is always the owner's account.
- **OTC listing bond is never slashed.** The bond round-trips to the seller on every terminal path;
  it deters spam (skin-in-the-game) but is not a penalty fund. Slashing it on an adverse resolve was
  considered and rejected: "adverse" has no crisp on-chain definition and auto-slashing would deter
  legitimate sellers from accepting disputes. The arbiter *stake* (slashable, incl. on timeout) is
  the penalty mechanism.
- **OTC `slash_arbiter` (owner-discretion) still banks to treasury → residual conflict.** The
  automatic, objective path (`claim_dispute_timeout`) now **burns** the stake, so the owner no longer
  profits from arbiter inaction (that conflict is resolved). The remaining `slash_arbiter` is an
  owner-discretion backstop that still sends the stake to the treasury; an owner could grief an honest
  arbiter with it. Its abuse is bounded by the owner being the reputationally-exposed operator and by
  the arbiter whitelist being the owner's own; a future hardening could burn this path too.
- **OTC listings grow unbounded in one component.** All listings live in one `HashMap` in one
  component, and `unstake_arbiter` scans them. Fees/latency grow with history. The clean fix is one
  component per listing (a larger refactor), tracked for later.

### cargo test (WSL, all green)
escrow **26** (authz 4, conservation 4, edge 4, test 14) · otc_board **45** (authz 22, conservation 4,
test 19) · agent_budget **28** (conservation 3, escrow_integration 10, test 15). Total **99**.
_(This round: agent_budget +3 for the #1/#2 regression tests; escrow `new` gained an explicit `payer`.
The reviewer's `review_probe.rs` is a throwaway diagnostic, not committed.)_
