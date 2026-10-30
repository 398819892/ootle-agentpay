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

### cargo test (WSL, all green)
escrow **26** (authz 4, conservation 4, edge 4, test 14) · otc_board **38** (authz 16, conservation 4,
test 18) · agent_budget **25** (conservation 3, escrow_integration 8, test 14). Total **89**.
