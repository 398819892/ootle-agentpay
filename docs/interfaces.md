# Contract interface reference / 合约接口参考

Amounts are integers in the resource's base units. Time is in **epochs** (`Consensus::current_epoch()`,
≈30 min each) — there is no wall-clock time on the Ootle. "Caller" is the transaction signer's public
key unless a badge is noted. Full behaviour (panics, fees) is in each template's rustdoc.

> 金额为资源最小单位整数。时间用 **epoch**（≈30 分钟/个）。「调用者」除非注明 badge，否则指交易签名者公钥。

---

## Escrow — `templates/escrow`

State: `Open → Released | Refunded | Disputed → Resolved`. Works with any resource.

| Method | Caller | Effect |
|---|---|---|
| `new(funds, payer_account, payee_account, payee, arbiter?, treasury_account, hashlock?, timeout_epochs, fee_bps) -> Component` | payer | Lock `funds`; record payer = signer. |
| `release(preimage?)` | payer **or** valid preimage holder | Pay payee `amount − fee`; `fee` → treasury. → Released |
| `refund()` | payer, at/after deadline | Return all funds to payer_account. → Refunded |
| `dispute()` | payer or payee | Freeze. → Disputed |
| `resolve(to_payee_amount)` | arbiter | Split: payee gets `to_payee_amount − fee`, payer the rest. → Resolved |
| `get_state() / get_info()` | anyone | Read state / `(state, balance, deadline, fee_bps)`. |

Fee = `amount * fee_bps / 10000` (0..=10000), charged on the payee's payout.

---

## AgentBudget — `templates/agent_budget`

Owner funds it; `new` returns two badges. Access is gated by badges (owner methods need the owner
badge; `pay`/`pay_via_escrow` need the agent badge). Enforces a **plaintext** resource budget.

| Method | Caller (badge) | Effect |
|---|---|---|
| `new(funds, per_tx_cap, daily_cap, epochs_per_window, whitelist) -> (Component, owner_badge, agent_badge)` | owner | Create the budget. |
| `pay(merchant, amount, memo)` | agent | Checks: not revoked, `0 < amount ≤ per_tx_cap`, merchant whitelisted, `spent_in_window + amount ≤ daily_cap`; then pays, emits `pay`. |
| `pay_via_escrow(merchant, merchant_pubkey, amount, timeout_epochs, memo) -> escrow` | agent | Same checks, but opens an `Escrow` (pay on delivery) instead of paying directly. Needs `configure_escrow` first. |
| `configure_escrow(escrow_template, owner_account, treasury_account, arbiter?, fee_bps)` | owner | Wire up the escrow integration. |
| `set_limits(per_tx_cap, daily_cap)` / `add_merchant(m)` / `remove_merchant(m)` | owner | Change the rules. |
| `revoke()` | owner | Freeze the agent; every `pay` then fails. |
| `withdraw(amount) -> Bucket` | owner | Take funds back. |
| `get_badges() / get_info()` | anyone | `(owner_badge, agent_badge)` / `(revoked, balance, per_tx_cap, daily_cap, spent_in_window, window_start_epoch)`. |

"Daily" = a rolling window of `epochs_per_window` epochs; `spent_in_window` resets lazily on the
first `pay` after the window elapses.

---

## OtcBoard — `templates/otc_board`

Per-listing escrow with explicit OTC roles. Listing: `Open → Taken → Settled | Refunded | Cancelled | Disputed`.

| Method | Caller | Effect |
|---|---|---|
| `new(treasury_account, listing_bond, max_listing_amount, fee_bps, arbiter_whitelist) -> (Component, owner_badge)` | owner | Create the board. |
| `list(asset, bond, seller_account, terms_hash, arbiter, timeout_epochs) -> id` | seller | Checks: `0 < asset ≤ max_listing_amount`, `bond ≥ listing_bond`, arbiter whitelisted. Locks asset+bond. → Open |
| `cancel(id)` | seller | Open only; return asset+bond. → Cancelled |
| `take(id, buyer_account, buyer, hashlock?)` | buyer (identity by arg) | → Taken; sets deadline. |
| `confirm(id, preimage?)` | seller **or** valid preimage holder | Asset → buyer `− fee`; fee → treasury; bond → seller. → Settled |
| `reclaim(id)` | seller, after timeout | Asset+bond → seller. → Refunded |
| `open_dispute(id)` | seller or buyer | → Disputed |
| `resolve(id, to_buyer_amount)` | listing's arbiter | Split asset; bond → seller. → Settled |
| `add_arbiter(pk)` / `remove_arbiter(pk)` / `set_params(bond, max, fee_bps)` | owner (owner_badge) | Manage the board. |
| `get_listing(id) / get_params() / get_owner_badge()` | anyone | Read. |

Terms are summarised on chain as `terms_hash` (a 32-byte hash); the detail is kept off chain.

Anti-abuse: **listing bond** (skin in the game), **max listing amount** (per-deal cap), **arbiter
whitelist** (only approved arbiters).
