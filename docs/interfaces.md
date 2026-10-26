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

Owner funds it; `new` returns an owner badge and a first agent badge. Owner methods need the owner
badge. `pay`/`pay_via_escrow` are open at the component level but self-enforce the agent badge: the
caller must present a **proof of an agent-badge session token** as the first argument, which the
method checks (resource + per-session revoke) before moving funds. Enforces a **plaintext** resource
budget.

| Method | Caller (badge) | Effect |
|---|---|---|
| `new(funds, per_tx_cap, daily_cap, epochs_per_window, whitelist) -> (Component, owner_badge, agent_badge)` | owner | Create the budget; the agent badge is the first session (id `"default"`). |
| `pay(agent_proof, merchant, amount, memo)` | agent (badge proof) | Checks: not globally revoked, proof is this budget's agent badge, the session is not individually revoked, `0 < amount ≤ per_tx_cap`, merchant whitelisted, `spent_in_window + amount ≤ daily_cap`; then pays, emits `pay`. |
| `pay_via_escrow(agent_proof, merchant, merchant_pubkey, amount, timeout_epochs, memo) -> escrow` | agent (badge proof) | Same checks, but opens an `Escrow` (pay on delivery) instead of paying directly. Needs `configure_escrow` first. |
| `issue_agent_badge(session) -> Bucket` | owner | Mint another agent session badge (one per agent/session); give the returned badge to that agent. |
| `revoke_session(session)` | owner | Freeze **one** session; its `pay` then fails while others keep working. |
| `top_up(funds)` | anyone (owner/keeper) | Add funds to the vault. Lets an external keeper replenish on its own cadence — there is no on-chain timer. |
| `set_window(epochs_per_window)` | owner | Reconfigure the rolling allowance window (and restart it now). |
| `configure_escrow(escrow_template, owner_account, treasury_account, arbiter?, fee_bps)` | owner | Wire up the escrow integration. |
| `set_limits(per_tx_cap, daily_cap)` / `add_merchant(m)` / `remove_merchant(m)` | owner | Change the rules. |
| `revoke()` | owner | Global kill switch: freeze **every** session; every `pay` then fails. |
| `withdraw(amount) -> Bucket` | owner | Take funds back. |
| `get_badges() / get_info()` | anyone | `(owner_badge, agent_badge)` / `(revoked, balance, per_tx_cap, daily_cap, spent_in_window, window_start_epoch)`. |

**Many agents / sessions.** Every agent badge is a non-fungible token of one agent-badge resource,
so `pay` only ever honours that resource. `new` mints the first (`"default"`); `issue_agent_badge`
mints more and `revoke_session` cuts off any single one. `revoke()` (no argument) stays the global
kill switch.

**"Daily" = a recurring per-window allowance.** It is a rolling window of `epochs_per_window` epochs;
`spent_in_window` resets lazily on the first `pay` after the window elapses, so the agent regains its
allowance each window automatically. **There is no wall-clock timer and no scheduler on the Ootle** —
a window only advances as epochs pass and only *resets* on the next payment. Anything that must happen
"on a schedule" (a recurring deposit) is driven by the owner or a keeper calling `top_up`; the chain
does not do it for you.

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
| `set_arbiter_stake(stake)` / `slash_arbiter(pk)` | owner (owner_badge) | Require a resolve stake; slash a bad arbiter's stake to treasury. |
| `stake_arbiter(stake)` / `unstake_arbiter() -> bucket` | whitelisted arbiter | Post / withdraw stake. `unstake_arbiter` is **rejected while the caller is the arbiter on a `Disputed` listing** (can't dodge a slash). |
| `get_listing(id) / get_params() / get_arbiter_stake(pk) / get_owner_badge()` | anyone | Read. |

Terms are summarised on chain as `terms_hash` (a 32-byte hash); the detail is kept off chain.

Anti-abuse: **listing bond** (skin in the game), **max listing amount** (per-deal cap), **arbiter
whitelist** (only approved arbiters), and an optional **arbiter stake** the owner can slash.

**Trust model (read before building on this).** OtcBoard settles an **off-chain** payment, so it is
**not a trustless atomic swap**. `confirm(id, preimage?)`: the hashlock preimage is only a
cryptographic condition — it proves the releaser knows a secret, **not** that any off-chain/fiat
payment arrived, and a preimage holder can release **before** paying. Without a hashlock, `confirm`
is the seller voluntarily acknowledging payment. Safety therefore rests on off-chain-payment trust
plus the arbiter (and their slashable stake), never on atomicity. Amounts are public on chain —
privacy is scoped and known, not anonymity. See `docs/security.md`.
