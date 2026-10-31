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
| `new(funds, payer, payer_account, payee_account, payee, arbiter?, treasury_account, hashlock?, timeout_epochs, fee_bps) -> Component` | funder | Lock `funds`; record `payer` **explicitly** (who may release/dispute), not the signer — lets a cross-template caller set the owner as payer. `timeout_epochs ≤ MAX_TIMEOUT_EPOCHS`. |
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
| `pay_via_escrow(agent_proof, merchant, merchant_pubkey, amount, timeout_epochs, memo) -> escrow` | agent (badge proof) | Same checks, but opens an `Escrow` (pay on delivery) — with the **owner** as payer (a leaked agent key can't release it) and `timeout_epochs ≤ max_escrow_timeout`. Needs `configure_escrow` first. |
| `issue_agent_badge(session) -> Bucket` | owner | Mint another agent session badge (one per agent/session); give the returned badge to that agent. |
| `revoke_session(session)` | owner | Freeze **one** session; its `pay` then fails while others keep working. |
| `top_up(funds)` | anyone (owner/keeper) | Add funds to the vault. Lets an external keeper replenish on its own cadence — there is no on-chain timer. |
| `set_window(epochs_per_window)` | owner | Reconfigure the rolling allowance window (and restart it now). |
| `configure_escrow(escrow_template, owner_account, treasury_account, arbiter?, fee_bps, owner_pubkey, max_escrow_timeout)` | owner | Wire up the escrow integration. `owner_pubkey` becomes the escrow's payer (so a leaked agent key can't release); `max_escrow_timeout` caps an agent-opened escrow's timeout. |
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
| `new(treasury_account, listing_bond, max_listing_amount, fee_bps, arbiter_whitelist, asset_whitelist) -> (Component, owner_badge)` | owner | Create the board. `asset_whitelist` empty = any resource tradable. |
| `list(asset, bond, seller_account, terms_hash, arbiter, timeout_epochs, hashlock?) -> id` | seller | Checks: `0 < asset ≤ max_listing_amount`, `bond ≥ listing_bond` **and same resource as asset**, arbiter whitelisted, asset on whitelist (if non-empty), `timeout_epochs ≥ min_timeout`. `hashlock` is seller-set. Locks asset+bond. → Open |
| `cancel(id)` | seller | Open only; return asset+bond. → Cancelled |
| `take(id, buyer_account, buyer, expected_arbiter)` | buyer (identity by arg) | Buyer must confirm the listing's arbiter (`expected_arbiter` = `get_arbiter(id)`). When a stake is required, the arbiter must have ≥ `arbiter_stake` **free** stake, which is then **locked to this deal**. → Taken; sets deadline. |
| `confirm(id, preimage?)` | seller **or** valid preimage holder | Asset → buyer `− fee`; fee → treasury; bond → seller. → Settled |
| `reclaim(id)` | seller, after timeout | Asset+bond → seller. → Refunded |
| `open_dispute(id)` | seller or buyer | → Disputed |
| `resolve(id, to_buyer_amount)` | listing's arbiter | Split asset; bond → seller. → Settled |
| `claim_dispute_timeout(id)` | anyone, after `dispute_deadline` | Force-close a stalled dispute: asset+bond → seller (safe default); this deal's locked arbiter stake is **burned** (to a no-withdrawal sink, not treasury/buyer). → Refunded |
| `add_arbiter(pk)` / `remove_arbiter(pk)` / `set_params(bond, max, fee_bps)` / `set_min_timeout(epochs)` | owner (owner_badge) | Manage the board. |
| `add_tradable_asset(resource)` / `remove_tradable_asset(resource)` | owner (owner_badge) | Manage the tradable-asset whitelist. |
| `set_arbiter_stake(stake)` / `slash_arbiter(pk)` | owner (owner_badge) | Set the per-deal stake requirement; owner-slash a bad arbiter's whole stake to treasury (discretionary). |
| `stake_arbiter(stake)` / `unstake_arbiter() -> bucket` | whitelisted arbiter | Post stake / withdraw the **free** (unlocked) part. `unstake_arbiter` is **rejected for stake locked by any live (`Taken`/`Disputed`) listing** (can't dodge a slash by unstaking before a dispute). |
| `get_listing(id) / get_params() / get_arbiter(id) / get_arbiter_stake(pk) / get_asset_whitelist() / get_owner_badge()` | anyone | Read. |

Terms are summarised on chain as `terms_hash` (a 32-byte hash); the detail is kept off chain.

Anti-abuse: **listing bond** (skin in the game, same resource as the asset), **max listing amount**
(per-deal cap), **arbiter whitelist** (only approved arbiters), an optional **tradable-asset
whitelist** (only approved resources listable), a **buyer-confirmed arbiter** at `take`, an optional
**min listing timeout**, and an optional **arbiter stake** — locked per deal at `take` and burned on
a stalled-dispute timeout (plus owner-discretion slash to treasury).

**Dispute-timeout trust model.** OTC settles off chain, so the chain has no proof of payment. A
stalled dispute force-closes to the **seller** (defaulting to the buyer would let a non-paying buyer
steal the asset). The buyer's protections are: confirming the arbiter at `take`, the owner's arbiter
whitelist, and the arbiter's deal-locked stake being **burned** if they go dark. The stake is locked
to the deal at `take` (not just at dispute, so it can't be withdrawn in between) and each concurrent
deal locks its own portion. A board with no arbiter stake has no economic protection against
seller↔arbiter collusion on timeout — set `arbiter_stake` to at least `max_listing_amount` and
consider a `min_timeout`. See `docs/audit-notes.md`.

**Trust model (read before building on this).** OtcBoard settles an **off-chain** payment, so it is
**not a trustless atomic swap**. `confirm(id, preimage?)`: the hashlock preimage is only a
cryptographic condition — it proves the releaser knows a secret, **not** that any off-chain/fiat
payment arrived, and a preimage holder can release **before** paying. Without a hashlock, `confirm`
is the seller voluntarily acknowledging payment. Safety therefore rests on off-chain-payment trust
plus the arbiter (and their slashable stake), never on atomicity. Amounts are public on chain —
privacy is scoped and known, not anonymity. See `docs/security.md`.
