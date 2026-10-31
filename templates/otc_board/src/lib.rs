//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! # OtcBoard template — a P2P OTC escrow board
//!
//! Sellers list an asset for sale; the asset is locked in a per-listing escrow. A buyer takes a
//! listing, pays the seller **off chain**, and the asset is released to the buyer — or refunded to
//! the seller on timeout, or split by an arbiter on dispute. The platform takes a fee per settled
//! deal into a treasury account.
//!
//! Per-listing escrow lifecycle:
//!
//! ```text
//!   Open ──take()──► Taken ──confirm(preimage?)──► Settled
//!     │ cancel()       │ reclaim() (after timeout)──► Refunded
//!     ▼                │ dispute()──► Disputed ──resolve(to_buyer)──► Settled
//!   Cancelled
//! ```
//!
//! This embeds the (Phase-1, separately tested) `Escrow` settlement logic per listing, with the
//! **OTC role model made explicit**: the seller and buyer are recorded by public key at list/take
//! time, so settlement authorises against those identities — unlike a standalone `Escrow`, whose
//! payer is whoever signed its `new`, which does not compose when a board opens it on a buyer's
//! behalf. Cross-template escrow instantiation is demonstrated elsewhere (`AgentBudget::pay_via_escrow`).
//!
//! **Settlement-security invariant:** without the seller's `confirm` (they received payment) or an
//! arbiter's `resolve`, *nobody* can move the seller's locked asset to a buyer. Two rules enforce it:
//! `take` binds the buyer to the transaction signer (you cannot take on someone else's behalf), and
//! the optional payment **hashlock is set by the *seller* at `list` time** — the seller holds the
//! preimage and only hands it to the buyer once paid off chain. This mirrors `Escrow`, where the
//! party who will *not* receive the funds sets the lock and the payout destination is fixed, so a
//! revealed preimage can only trigger the already-agreed payout, never redirect it. (A previous
//! revision let the *taker* supply the hashlock in `take`; combined with the preimage path in
//! `confirm`, any stranger could take a listing with a self-chosen lock and release the asset to
//! themselves without paying — a P0 asset-theft bug, now fixed. See `docs/audit-notes.md`.)
//!
//! **Dispute-timeout trust model (read before trusting a listing).** OTC settles off chain, so the
//! chain has *no proof the buyer paid*. If a dispute stalls (the arbiter never resolves), the asset
//! must go somewhere; `claim_dispute_timeout` returns it to the **seller**. This is deliberately the
//! safe default — the only alternative, defaulting to the buyer, would let a non-paying buyer take a
//! listing, open a dispute and wait out the clock to steal the asset outright. But it does mean a
//! *stalling seller* who picks a lazy or complicit arbiter could keep both the asset and the buyer's
//! off-chain payment. Three things guard against that, and a buyer should check all three before
//! paying: (1) the **buyer confirms the arbiter** at `take` (passes the arbiter key they are willing
//! to trust; a listing whose arbiter they do not accept cannot be taken by accident — read it with
//! `get_arbiter`); (2) a stalled arbiter is **slashed on timeout** — when the board requires an
//! arbiter stake, that stake is *locked to the deal at `take`* (not just when a dispute opens, so it
//! cannot be withdrawn in between — and each concurrent deal locks its own portion), and
//! `claim_dispute_timeout` **burns** this deal's locked portion (moves it to a no-withdrawal sink, so
//! the penalty neither enriches the owner nor rewards a possibly non-paying buyer); (3) arbiters are
//! owner-whitelisted. For the burn deterrent to bite, the owner must set `arbiter_stake` to at least a
//! single deal's value (`max_listing_amount` is a good floor), and may set a `min_timeout`. A board
//! with no arbiter stake offers no economic protection against seller–arbiter collusion on timeout —
//! only the whitelist and the buyer's own arbiter check. See `docs/audit-notes.md`.
//!
//! Anti-abuse (per the product plan): a **listing bond** (skin in the game to list), a
//! **max listing amount** (per-deal cap), and an **arbiter whitelist** (only approved arbiters).
//! Time is measured in epochs (`Consensus::current_epoch()`); "terms" are summarised on chain as a
//! hash, with the detail kept off chain.

use tari_template_lib::prelude::*;

/// Hard ceiling on the platform fee, in basis points (10% here). The owner cannot set a fee above
/// this in `new`/`set_params`, so even a malicious owner can never seize a meaningful share of a
/// settled deal. Combined with snapshotting the fee into each `Listing` at `list` time, an owner
/// cannot retroactively inflate the fee on a listing a buyer has already taken (that was a confirmed
/// fund-safety bug — see `docs/audit-notes.md`).
const MAX_FEE_BPS: u64 = 1000;

/// Upper bound on a listing's timeout window, in epochs (~57 years at ~30 min/epoch). Caps both an
/// accidental overflow of `now + timeout_epochs` (release builds wrap silently) and an absurdly large
/// value that would lock the asset near-forever. See `docs/audit-notes.md` (M1).
const MAX_TIMEOUT_EPOCHS: u64 = 1_000_000;

/// `amount * fee_bps / 10000`, computed as a split so no intermediate overflows a 64-bit `Amount` on
/// a large (e.g. 18-decimal) resource: `amount * fee_bps` can exceed `i64::MAX` even though the fee
/// itself (≤ amount) never does. With `q = amount / 10000` and `r = amount - q*10000` (r < 10000),
/// `fee = q*fee_bps + r*fee_bps/10000`; each term stays bounded and the result equals the naive
/// expression. See `docs/audit-notes.md`.
fn fee_on(amount: Amount, fee_bps: u64) -> Amount {
    let q = amount / 10000;
    let r = amount - q * 10000;
    q * fee_bps + r * fee_bps / 10000
}

#[derive(Debug, Clone, PartialEq, Eq, minicbor::Encode, minicbor::Decode, minicbor::CborLen)]
pub enum ListingState {
    #[n(0)]
    Open,
    #[n(1)]
    Taken,
    #[n(2)]
    Settled,
    #[n(3)]
    Refunded,
    #[n(4)]
    Cancelled,
    #[n(5)]
    Disputed,
}

#[derive(minicbor::Encode, minicbor::Decode, minicbor::CborLen)]
pub struct Listing {
    #[n(0)]
    seller: RistrettoPublicKeyBytes,
    #[n(1)]
    seller_account: ComponentAddress,
    #[n(2)]
    amount: Amount,
    #[n(3)]
    terms_hash: Hash32,
    #[n(4)]
    arbiter: RistrettoPublicKeyBytes,
    #[n(5)]
    timeout_epochs: u64,
    #[n(6)]
    asset: Vault,
    #[n(7)]
    bond: Vault,
    #[n(8)]
    buyer_account: Option<ComponentAddress>,
    #[n(9)]
    buyer: Option<RistrettoPublicKeyBytes>,
    #[n(10)]
    hashlock: Option<Hash32>,
    #[n(11)]
    deadline_epoch: u64,
    #[n(12)]
    state: ListingState,
    /// Platform fee (basis points) **snapshotted at `list` time**. Settlement (`confirm`/`resolve`)
    /// charges this, not the board's current `fee_bps`, so a later `set_params` cannot change the
    /// fee on a deal that is already in flight.
    #[n(13)]
    fee_bps: u64,
    /// Epoch after which a stalled dispute may be force-closed by anyone (0 = not disputed). Set in
    /// `open_dispute`; see `claim_dispute_timeout`. Guards against an unreachable arbiter freezing
    /// the asset forever.
    #[n(14)]
    dispute_deadline: u64,
    /// The amount of the arbiter's stake locked for **this** listing — snapshotted from the board's
    /// `arbiter_stake` at `take` time (0 when no stake was required then). It stays locked while the
    /// listing is `Taken` or `Disputed` (so the arbiter cannot `unstake` it out from under a live
    /// deal), and on a stalled-dispute timeout exactly this much is slashed/burned. Each concurrent
    /// deal locks its own portion, so one stake can never "cover" several deals at once. See
    /// `docs/audit-notes.md`.
    #[n(15)]
    arbiter_stake_locked: Amount,
}

#[template]
mod otc_board {
    use std::collections::HashMap;

    use super::*;

    pub struct OtcBoard {
        owner_badge: ResourceAddress,
        treasury_account: ComponentAddress,
        listing_bond: Amount,
        max_listing_amount: Amount,
        fee_bps: u64,
        arbiter_whitelist: Vec<RistrettoPublicKeyBytes>,
        /// Resources that may be listed for sale. **Empty = any resource allowed** (permissive; not
        /// recommended for production). When non-empty, `list` rejects any asset whose resource is not
        /// in this set, so a seller cannot spam the board with self-minted worthless tokens — the
        /// bond, which must be the same resource as the asset, would then be worthless too, defeating
        /// the skin-in-the-game / slashing purpose. Managed by the owner via
        /// `add_tradable_asset` / `remove_tradable_asset`. See `docs/audit-notes.md`.
        asset_whitelist: Vec<ResourceAddress>,
        /// Stake an arbiter must have **free** (unlocked) to be named on a new `take`, and the amount
        /// locked per deal they are named on (0 = staking disabled — whitelist-only). Set by the owner.
        arbiter_stake: Amount,
        /// Per-arbiter stake held by the board. Slashable by the owner, and burned per-deal on a
        /// stalled-dispute timeout, giving the arbiter skin in the game beyond being whitelisted.
        arbiter_stakes: HashMap<RistrettoPublicKeyBytes, Vault>,
        /// Minimum `timeout_epochs` a listing may set (0 = no minimum). Stops a seller choosing an
        /// unreasonably short window. Set by the owner via `set_min_timeout`.
        min_timeout_epochs: u64,
        /// Burn sink for stake slashed on a stalled-dispute timeout. The funds are moved here and have
        /// **no withdrawal path** — effectively burned — so the timeout penalty neither enriches the
        /// owner (the conflict the audit flagged) nor rewards a possibly non-paying buyer.
        slashed_pool: Option<Vault>,
        listings: HashMap<u64, Listing>,
        next_id: u64,
    }

    impl OtcBoard {
        /// Creates the board. Returns `(component, owner_badge)`. The owner badge gates the
        /// parameter / arbiter-management methods; `treasury_account` collects the per-deal fee.
        pub fn new(
            treasury_account: ComponentAddress,
            listing_bond: Amount,
            max_listing_amount: Amount,
            fee_bps: u64,
            arbiter_whitelist: Vec<RistrettoPublicKeyBytes>,
            asset_whitelist: Vec<ResourceAddress>,
        ) -> (Component<OtcBoard>, Bucket) {
            assert!(fee_bps <= MAX_FEE_BPS, "fee_bps cannot exceed the platform maximum");
            assert!(listing_bond >= amount![0], "listing_bond cannot be negative");
            assert!(max_listing_amount > amount![0], "max_listing_amount must be positive");

            let owner_badge_bucket = ResourceBuilder::non_fungible()
                .with_token_symbol("OTC-OWN")
                .mintable(AccessRule::DenyAll, LOCKED)
                // DenyAll: the owner badge gates all board management and has no recovery path, so it
                // must not be burnable — burning it would permanently lock board administration.
                .burnable(AccessRule::DenyAll, LOCKED)
                .initial_supply_with_data(Some((NonFungibleId::random(), (&(), &()))));
            let owner_badge = owner_badge_bucket.resource_address();

            let rules = ComponentAccessRules::new()
                .method("add_arbiter", rule!(resource(owner_badge)))
                .method("remove_arbiter", rule!(resource(owner_badge)))
                .method("set_params", rule!(resource(owner_badge)))
                .method("set_arbiter_stake", rule!(resource(owner_badge)))
                .method("slash_arbiter", rule!(resource(owner_badge)))
                .method("add_tradable_asset", rule!(resource(owner_badge)))
                .method("remove_tradable_asset", rule!(resource(owner_badge)))
                .method("set_min_timeout", rule!(resource(owner_badge)))
                .default(rule!(allow_all));

            let component = Component::new(Self {
                owner_badge,
                treasury_account,
                listing_bond,
                max_listing_amount,
                fee_bps,
                arbiter_whitelist,
                asset_whitelist,
                arbiter_stake: amount![0],
                arbiter_stakes: HashMap::new(),
                min_timeout_epochs: 0,
                slashed_pool: None,
                listings: HashMap::new(),
                next_id: 0,
            })
            .with_access_rules(rules)
            .create();

            (component, owner_badge_bucket)
        }

        /// Seller lists `asset` for sale, posting a `bond`. Returns the listing id. The seller is the
        /// transaction signer. `arbiter` must be whitelisted; `asset` must be within the cap; `bond`
        /// must meet the minimum.
        ///
        /// `hashlock` is an **optional, seller-set** SHA-256 payment lock. When present, the seller
        /// keeps the matching preimage and reveals it to the buyer only after being paid off chain;
        /// the buyer (or anyone holding the preimage) can then `confirm` to release. Pass `None` to
        /// require an explicit seller `confirm` instead. It must be set here by the seller and can
        /// never be supplied by the taker — that was the P0 (see module docs). A seller who sets a
        /// hashlock must keep its preimage secret until paid; a guessable/leaked preimage only ever
        /// releases *this* listing's asset to the recorded buyer, not to anyone else.
        ///
        /// `seller_account` is chosen by the seller (the signer) and is where the asset/bond return
        /// on `cancel`/`reclaim` and where the bond returns on settlement. Misdirecting it only
        /// affects the seller's own funds — there is no cross-party path out of it.
        pub fn list(
            &mut self,
            asset: Bucket,
            bond: Bucket,
            seller_account: ComponentAddress,
            terms_hash: Hash32,
            arbiter: RistrettoPublicKeyBytes,
            timeout_epochs: u64,
            hashlock: Option<Hash32>,
        ) -> u64 {
            let amount = asset.amount();
            assert!(amount > amount![0], "Asset must be non-empty");
            // When an asset whitelist is configured, only its resources may be listed. This stops a
            // seller from listing a self-minted worthless token (whose same-resource bond would be
            // worthless too) — see the `asset_whitelist` field and `docs/audit-notes.md`. An empty
            // whitelist allows any resource (permissive default).
            assert!(
                self.asset_whitelist.is_empty()
                    || self.asset_whitelist.contains(&asset.resource_address()),
                "Asset resource is not on the board's tradable-asset whitelist"
            );
            // `max_listing_amount` is a per-deal sanity cap denominated in the *asset's own* resource
            // (there is no price oracle on chain to compare resources by value). It is only meaningful
            // because the bond is required to be the same resource as the asset just below, so a
            // listing is internally single-denomination — asset, bond and cap are all one unit.
            assert!(amount <= self.max_listing_amount, "Asset exceeds the max listing amount");
            // The bond must be the SAME resource as the listed asset. Without this, a seller could
            // post a self-minted worthless token as the bond, defeating the skin-in-the-game /
            // slashing-on-abuse purpose of the bond entirely (a confirmed fund-safety bug — the
            // amount check below is meaningless across resources). See `docs/audit-notes.md`.
            assert!(
                bond.resource_address() == asset.resource_address(),
                "Bond must be posted in the same resource as the listed asset"
            );
            assert!(bond.amount() >= self.listing_bond, "Bond below the minimum listing bond");
            assert!(timeout_epochs > 0, "timeout must be greater than zero");
            assert!(timeout_epochs <= MAX_TIMEOUT_EPOCHS, "timeout exceeds the maximum");
            assert!(
                timeout_epochs >= self.min_timeout_epochs,
                "timeout is below the board minimum"
            );
            assert!(
                self.arbiter_whitelist.contains(&arbiter),
                "Arbiter is not whitelisted"
            );

            let id = self.next_id;
            self.next_id += 1;
            let seller = CallerContext::transaction_signer_public_key();
            // Snapshot the fee now so a later `set_params` cannot re-rate a deal in flight.
            let fee_bps = self.fee_bps;
            self.listings.insert(id, Listing {
                seller,
                seller_account,
                amount,
                terms_hash,
                arbiter,
                timeout_epochs,
                asset: Vault::from_bucket(asset),
                bond: Vault::from_bucket(bond),
                buyer_account: None,
                buyer: None,
                hashlock,
                deadline_epoch: 0,
                state: ListingState::Open,
                fee_bps,
                dispute_deadline: 0,
                arbiter_stake_locked: amount![0],
            });
            emit_event("list", metadata!["id" => id.to_string(), "amount" => amount.to_string()]);
            id
        }

        /// Seller cancels an open (not-yet-taken) listing; the asset and bond are returned.
        pub fn cancel(&mut self, id: u64) {
            let treasury = self.treasury_account;
            let listing = self.get_mut(id);
            assert!(listing.state == ListingState::Open, "Listing is not open");
            assert!(
                CallerContext::transaction_signer_public_key() == listing.seller,
                "Only the seller may cancel"
            );
            let _ = treasury; // not used here; kept for symmetry
            let asset = listing.asset.withdraw_all();
            let bond = listing.bond.withdraw_all();
            let seller_account = listing.seller_account;
            listing.state = ListingState::Cancelled;
            ComponentManager::get(seller_account).invoke("deposit", args![asset]);
            ComponentManager::get(seller_account).invoke("deposit", args![bond]);
            emit_event("cancel", metadata!["id" => id.to_string()]);
        }

        /// Buyer takes an open listing. The buyer pays the seller off chain, then settlement happens
        /// via `confirm`.
        ///
        /// The declared `buyer` **must be the transaction signer** — you cannot take on another
        /// party's behalf or impersonate a buyer. The listing's payment hashlock (if any) was fixed
        /// by the seller at `list` time and is deliberately *not* a parameter here: a taker must not
        /// be able to install their own lock and then release the asset to themselves (that was the
        /// P0; see module docs).
        ///
        /// The buyer must also pass `expected_arbiter` — the arbiter they are willing to trust to
        /// `resolve` a dispute — and it must equal the arbiter the seller chose at `list` time, or the
        /// take is rejected. The arbiter is the party who decides a disputed deal and, on a stalled
        /// dispute, the timeout defaults to refunding the *seller* (see `claim_dispute_timeout`), so a
        /// buyer must not commit to a listing without consenting to its arbiter. Read it beforehand
        /// with `get_arbiter`.
        ///
        /// **Stake coverage is checked and locked here.** When the board requires an arbiter stake
        /// (`arbiter_stake > 0`), the listing's arbiter must have at least that much *free* (unlocked)
        /// stake at take time, and exactly that much is then **locked to this listing** for as long as
        /// it stays `Taken`/`Disputed`. This closes the hole where an arbiter staked, got taken, then
        /// unstaked before a dispute was opened (the slash later found nothing): the stake can no
        /// longer be withdrawn while the deal is live, and each concurrent deal needs its own free
        /// stake — one stake can never cover several deals. See `docs/audit-notes.md`.
        pub fn take(
            &mut self,
            id: u64,
            buyer_account: ComponentAddress,
            buyer: RistrettoPublicKeyBytes,
            expected_arbiter: RistrettoPublicKeyBytes,
        ) {
            let now = Consensus::current_epoch();
            assert!(
                CallerContext::transaction_signer_public_key() == buyer,
                "buyer must be the transaction signer"
            );
            // Validate immutably (the arbiter must match; read the required stake) before any mutation.
            let (arbiter, required) = {
                let listing = self.listings.get(&id).expect("unknown listing");
                assert!(listing.state == ListingState::Open, "Listing is not open");
                // The buyer must explicitly consent to the arbiter the seller chose — a deliberate,
                // on-chain act by the party the timeout default works against.
                assert!(
                    listing.arbiter == expected_arbiter,
                    "Arbiter mismatch: the listing's arbiter is not the one the buyer confirmed"
                );
                (listing.arbiter, self.arbiter_stake)
            };
            // When a stake is required, the arbiter must have enough FREE stake (total minus what is
            // already locked by their other live deals) to cover this one; that amount is locked below.
            if required > amount![0] {
                let free = self.staked_balance(&arbiter) - self.locked_stake_for(&arbiter);
                assert!(
                    free >= required,
                    "Arbiter has insufficient free stake to cover this deal"
                );
            }
            let listing = self.get_mut(id);
            listing.buyer_account = Some(buyer_account);
            listing.buyer = Some(buyer);
            listing.deadline_epoch = now.checked_add(listing.timeout_epochs).expect("deadline overflow");
            listing.state = ListingState::Taken;
            listing.arbiter_stake_locked = required; // snapshot (0 when no stake required)
            emit_event("take", metadata!["id" => id.to_string()]);
        }

        /// Releases the asset to the recorded buyer, charging the platform fee. Authorised by the
        /// seller (confirming they were paid) or by anyone presenting the preimage of the listing's
        /// **seller-set** hashlock. Because only the seller can set that lock (at `list`) and holds
        /// its preimage until paid, a non-paying taker cannot forge this path; the payout always
        /// goes to the recorded buyer regardless of who presents the preimage.
        pub fn confirm(&mut self, id: u64, preimage: Option<Vec<u8>>) {
            let treasury = self.treasury_account;
            let listing = self.get_mut(id);
            assert!(listing.state == ListingState::Taken, "Listing is not taken");
            // Use the fee snapshotted when the listing was created, NOT the board's current rate, so
            // the owner cannot inflate the fee after the buyer committed.
            let fee_bps = listing.fee_bps;

            let caller = CallerContext::transaction_signer_public_key();
            let is_seller = caller == listing.seller;
            let has_preimage = match (&listing.hashlock, &preimage) {
                (Some(lock), Some(pre)) => intrinsics::hash_sha256(pre) == *lock,
                _ => false,
            };
            assert!(
                is_seller || has_preimage,
                "Unauthorized: confirm requires the seller or a valid payment preimage"
            );

            let buyer_account = listing.buyer_account.expect("no buyer");
            let seller_account = listing.seller_account;
            let total = listing.asset.balance();
            let fee = fee_on(total, fee_bps);
            let to_buyer = total - fee;

            if !fee.is_zero() {
                let fee_bucket = listing.asset.withdraw(fee);
                ComponentManager::get(treasury).invoke("deposit", args![fee_bucket]);
            }
            let asset = listing.asset.withdraw(to_buyer);
            let bond = listing.bond.withdraw_all();
            listing.state = ListingState::Settled;
            ComponentManager::get(buyer_account).invoke("deposit", args![asset]);
            ComponentManager::get(seller_account).invoke("deposit", args![bond]);
            emit_event("confirm", metadata!["id" => id.to_string(), "to_buyer" => to_buyer.to_string(), "fee" => fee.to_string()]);
        }

        /// Seller reclaims the asset after the timeout (buyer never paid). Asset and bond return to
        /// the seller; no fee is charged.
        pub fn reclaim(&mut self, id: u64) {
            let now = Consensus::current_epoch();
            let listing = self.get_mut(id);
            assert!(listing.state == ListingState::Taken, "Listing is not taken");
            assert!(
                CallerContext::transaction_signer_public_key() == listing.seller,
                "Only the seller may reclaim"
            );
            assert!(now >= listing.deadline_epoch, "Cannot reclaim before the timeout");
            let asset = listing.asset.withdraw_all();
            let bond = listing.bond.withdraw_all();
            let seller_account = listing.seller_account;
            listing.state = ListingState::Refunded;
            ComponentManager::get(seller_account).invoke("deposit", args![asset]);
            ComponentManager::get(seller_account).invoke("deposit", args![bond]);
            emit_event("reclaim", metadata!["id" => id.to_string()]);
        }

        /// Either party raises a dispute, freezing the listing until the arbiter resolves it — or,
        /// if the arbiter never does, until anyone force-closes it after `dispute_deadline` via
        /// `claim_dispute_timeout`. The deadline is one `timeout_epochs` window from now, so an
        /// unreachable arbiter can delay settlement by at most that window, never freeze it forever.
        pub fn open_dispute(&mut self, id: u64) {
            let now = Consensus::current_epoch();
            let listing = self.get_mut(id);
            assert!(listing.state == ListingState::Taken, "Listing is not taken");
            let caller = CallerContext::transaction_signer_public_key();
            assert!(
                caller == listing.seller || Some(caller) == listing.buyer,
                "Only the seller or buyer may dispute"
            );
            listing.state = ListingState::Disputed;
            listing.dispute_deadline = now.checked_add(listing.timeout_epochs).expect("dispute deadline overflow");
            emit_event("dispute", metadata!["id" => id.to_string()]);
        }

        /// Force-closes a dispute that the arbiter never resolved. Callable by **anyone** once the
        /// `dispute_deadline` has passed, so an unresponsive or unreachable arbiter can never freeze a
        /// listing's asset indefinitely (a confirmed liveness/fund-safety bug — see
        /// `docs/audit-notes.md`).
        ///
        /// The safe default mirrors `reclaim`: with no on-chain proof that the buyer paid (that proof
        /// is the seller's `confirm` or the arbiter's `resolve`, neither of which happened), the asset
        /// and bond return to the seller. A buyer who genuinely paid must get the arbiter to `resolve`
        /// within the dispute window; this backstop only runs once that window has fully elapsed.
        ///
        /// **This deal's locked stake is burned.** Because the default favours the seller, an
        /// unresolved dispute is the arbiter failing the one job they were named (and staked) for.
        /// Exactly the stake **locked to this listing** at `take` (`arbiter_stake_locked`) is withdrawn
        /// from the arbiter and moved to the burn sink (`slashed_pool`, no withdrawal path). Burning —
        /// not paying the treasury or the buyer — means the penalty neither enriches the owner (the
        /// conflict the audit flagged) nor rewards a possibly non-paying buyer, while a stalled or
        /// colluding arbiter still loses the collateral that backed this deal. Only this deal's portion
        /// is burned, so the arbiter's stake for their *other* live deals is untouched. A board with no
        /// arbiter stake has nothing to burn — see the module-level trust-model note.
        pub fn claim_dispute_timeout(&mut self, id: u64) {
            let now = Consensus::current_epoch();
            // Validate and read the arbiter + this deal's locked amount before touching the vaults.
            let (arbiter, locked) = {
                let listing = self.listings.get(&id).expect("unknown listing");
                assert!(listing.state == ListingState::Disputed, "Listing is not under dispute");
                assert!(
                    now >= listing.dispute_deadline,
                    "Cannot force-close before the dispute deadline"
                );
                (listing.arbiter, listing.arbiter_stake_locked)
            };
            // Burn this deal's locked stake from the stalled arbiter (bounded by what they still hold).
            if locked > amount![0] {
                if let Some(v) = self.arbiter_stakes.get_mut(&arbiter) {
                    let take = if v.balance() < locked { v.balance() } else { locked };
                    if !take.is_zero() {
                        let burned = v.withdraw(take);
                        let amt = burned.amount();
                        match &mut self.slashed_pool {
                            Some(p) => p.deposit(burned),
                            None => self.slashed_pool = Some(Vault::from_bucket(burned)),
                        }
                        emit_event("slash_arbiter", metadata!["amount" => amt.to_string(), "reason" => "dispute_timeout_burned".to_string()]);
                    }
                }
            }
            let listing = self.get_mut(id);
            let asset = listing.asset.withdraw_all();
            let bond = listing.bond.withdraw_all();
            let seller_account = listing.seller_account;
            listing.state = ListingState::Refunded;
            ComponentManager::get(seller_account).invoke("deposit", args![asset]);
            ComponentManager::get(seller_account).invoke("deposit", args![bond]);
            emit_event("claim_dispute_timeout", metadata!["id" => id.to_string()]);
        }

        /// The listing's arbiter splits the asset: `to_buyer_amount` (minus fee) to the buyer, the
        /// remainder to the seller. The bond returns to the seller.
        pub fn resolve(&mut self, id: u64, to_buyer_amount: Amount) {
            let treasury = self.treasury_account;
            // The stake requirement for THIS deal is the amount locked at `take`
            // (`arbiter_stake_locked`), NOT the board's current `arbiter_stake`. Using the snapshot
            // means a malicious owner cannot block resolution of an in-flight dispute — and so cannot
            // force the timeout default to the seller — by raising `set_arbiter_stake`, calling
            // `slash_arbiter`, or `remove_arbiter` after the deal was taken. (Slash can only take FREE
            // stake, so the locked portion is always still present here.) See docs/audit-notes.md (H3).
            let (arbiter, req) = {
                let l = self.listings.get(&id).expect("unknown listing");
                (l.arbiter, l.arbiter_stake_locked)
            };
            if req > amount![0] {
                assert!(
                    self.staked_balance(&arbiter) >= req,
                    "Arbiter's deal-locked stake is missing"
                );
            }
            let listing = self.get_mut(id);
            assert!(listing.state == ListingState::Disputed, "Listing is not under dispute");
            assert!(
                CallerContext::transaction_signer_public_key() == listing.arbiter,
                "Only the listing's arbiter may resolve"
            );
            // Fee snapshotted at `list` time, not the board's current rate (see `confirm`).
            let fee_bps = listing.fee_bps;
            let total = listing.asset.balance();
            assert!(to_buyer_amount >= amount![0], "amount cannot be negative");
            assert!(to_buyer_amount <= total, "amount exceeds the escrowed asset");

            let fee = fee_on(to_buyer_amount, fee_bps);
            let buyer_net = to_buyer_amount - fee;
            let seller_amount = total - to_buyer_amount;
            let buyer_account = listing.buyer_account.expect("no buyer");
            let seller_account = listing.seller_account;

            if !fee.is_zero() {
                let fee_bucket = listing.asset.withdraw(fee);
                ComponentManager::get(treasury).invoke("deposit", args![fee_bucket]);
            }
            if !buyer_net.is_zero() {
                let b = listing.asset.withdraw(buyer_net);
                ComponentManager::get(buyer_account).invoke("deposit", args![b]);
            }
            if !seller_amount.is_zero() {
                let s = listing.asset.withdraw(seller_amount);
                ComponentManager::get(seller_account).invoke("deposit", args![s]);
            }
            let bond = listing.bond.withdraw_all();
            listing.state = ListingState::Settled;
            ComponentManager::get(seller_account).invoke("deposit", args![bond]);
            emit_event("resolve", metadata!["id" => id.to_string(), "to_buyer" => buyer_net.to_string()]);
        }

        // -- owner -----------------------------------------------------------------------
        pub fn add_arbiter(&mut self, arbiter: RistrettoPublicKeyBytes) {
            if !self.arbiter_whitelist.contains(&arbiter) {
                self.arbiter_whitelist.push(arbiter);
            }
        }

        pub fn remove_arbiter(&mut self, arbiter: RistrettoPublicKeyBytes) {
            self.arbiter_whitelist.retain(|a| a != &arbiter);
        }

        /// Owner adds a resource to the tradable-asset whitelist (idempotent). Once the whitelist is
        /// non-empty, only its resources may be `list`ed. See the `asset_whitelist` field.
        pub fn add_tradable_asset(&mut self, asset: ResourceAddress) {
            if !self.asset_whitelist.contains(&asset) {
                self.asset_whitelist.push(asset);
            }
            emit_event("add_tradable_asset", metadata!["asset" => asset.to_string()]);
        }

        /// Owner removes a resource from the tradable-asset whitelist. Existing listings are
        /// unaffected; only new `list` calls are gated.
        pub fn remove_tradable_asset(&mut self, asset: ResourceAddress) {
            self.asset_whitelist.retain(|a| a != &asset);
            emit_event("remove_tradable_asset", metadata!["asset" => asset.to_string()]);
        }

        /// Owner sets the minimum `timeout_epochs` any new listing may specify (0 = no minimum). Stops
        /// a seller choosing an unreasonably short window that leaves the buyer and arbiter too little
        /// time to pay / adjudicate. Existing listings are unaffected.
        pub fn set_min_timeout(&mut self, min_timeout_epochs: u64) {
            self.min_timeout_epochs = min_timeout_epochs;
            emit_event("set_min_timeout", metadata!["min_timeout_epochs" => min_timeout_epochs.to_string()]);
        }

        /// Updates board parameters. The fee is capped at `MAX_FEE_BPS`, and because each listing
        /// snapshots the fee at `list` time, a change here only affects *future* listings — it can
        /// never re-rate a deal already in flight.
        pub fn set_params(&mut self, listing_bond: Amount, max_listing_amount: Amount, fee_bps: u64) {
            assert!(fee_bps <= MAX_FEE_BPS, "fee_bps cannot exceed the platform maximum");
            assert!(max_listing_amount > amount![0], "max_listing_amount must be positive");
            self.listing_bond = listing_bond;
            self.max_listing_amount = max_listing_amount;
            self.fee_bps = fee_bps;
        }

        /// Owner sets the minimum stake an arbiter must post to be allowed to `resolve`. 0 disables
        /// staking (whitelist-only). Existing posted stakes are unaffected.
        pub fn set_arbiter_stake(&mut self, stake: Amount) {
            assert!(stake >= amount![0], "stake cannot be negative");
            self.arbiter_stake = stake;
            emit_event("set_arbiter_stake", metadata!["stake" => stake.to_string()]);
        }

        /// A whitelisted arbiter posts (or tops up) their stake; the board holds it. With a non-zero
        /// `arbiter_stake` set, having at least that much staked is required to `resolve`.
        pub fn stake_arbiter(&mut self, stake: Bucket) {
            let who = CallerContext::transaction_signer_public_key();
            assert!(
                self.arbiter_whitelist.contains(&who),
                "Only a whitelisted arbiter may stake"
            );
            // The stake must be the native token (XTR), the board's single collateral currency. An
            // arbiter cannot post a self-minted worthless token as their stake, which would make the
            // slash-on-misbehaviour penalty (stake -> treasury) empty (a confirmed fund-safety bug —
            // see `docs/audit-notes.md`).
            assert!(
                stake.resource_address() == XTR,
                "Arbiter stake must be posted in XTR"
            );
            let amt = stake.amount();
            match self.arbiter_stakes.get_mut(&who) {
                Some(v) => v.deposit(stake),
                None => {
                    self.arbiter_stakes.insert(who, Vault::from_bucket(stake));
                }
            }
            emit_event("stake_arbiter", metadata!["amount" => amt.to_string()]);
        }

        /// An arbiter withdraws their **free** (unlocked) stake — the part not locked to any live
        /// (`Taken`/`Disputed`) listing they are named on. Returns the bucket.
        ///
        /// This is what stops an arbiter dodging a slash: a listing locks its stake at `take`, not just
        /// at dispute, so the arbiter cannot unstake between take and dispute (the old guard only
        /// looked at `Disputed` listings — the gap this closes). They must let every live deal settle
        /// (or be slashed) before the stake backing it can leave.
        pub fn unstake_arbiter(&mut self) -> Bucket {
            let who = CallerContext::transaction_signer_public_key();
            let locked = self.locked_stake_for(&who);
            let v = self.arbiter_stakes.get_mut(&who).expect("no stake posted");
            let free = v.balance() - locked;
            assert!(
                free > amount![0],
                "No free stake to withdraw: it is locked by your live listings (taken or disputed)"
            );
            let out = v.withdraw(free);
            emit_event("unstake_arbiter", metadata!["amount" => out.amount().to_string()]);
            out
        }

        /// Owner slashes a misbehaving arbiter's **free** (unlocked) stake to the treasury. This is a
        /// discretionary penalty for arbiters not currently backing a live deal.
        ///
        /// It can only take the FREE portion: stake locked to a `Taken`/`Disputed` listing is reserved
        /// to back that deal and the owner cannot drain it. Without this an owner could empty an
        /// arbiter's collateral mid-dispute — leaving nothing for the timeout burn and starving
        /// `resolve` — to force the timeout default to a colluding seller (a confirmed owner-power bug,
        /// see docs/audit-notes.md H3). The automatic, objective penalty for a stalled dispute remains
        /// `claim_dispute_timeout`, which burns the deal's locked portion.
        pub fn slash_arbiter(&mut self, arbiter: RistrettoPublicKeyBytes) {
            let treasury = self.treasury_account;
            let locked = self.locked_stake_for(&arbiter);
            let v = self.arbiter_stakes.get_mut(&arbiter).expect("arbiter has no stake");
            let free = v.balance() - locked;
            assert!(
                free > amount![0],
                "No free (unlocked) stake to slash; it is locked to the arbiter's live deals"
            );
            let slashed = v.withdraw(free);
            let amt = slashed.amount();
            ComponentManager::get(treasury).invoke("deposit", args![slashed]);
            emit_event("slash_arbiter", metadata!["amount" => amt.to_string()]);
        }

        // -- views -----------------------------------------------------------------------
        pub fn get_listing(&self, id: u64) -> (ListingState, Amount, ComponentAddress, u64) {
            let l = self.listings.get(&id).expect("unknown listing");
            (l.state.clone(), l.asset.balance(), l.seller_account, l.deadline_epoch)
        }

        pub fn get_params(&self) -> (Amount, Amount, u64, u64) {
            (self.listing_bond, self.max_listing_amount, self.fee_bps, self.next_id)
        }

        /// The arbiter recorded on a listing. A buyer should read this before `take` (which requires
        /// them to confirm it) and before paying off chain. Readable by anyone.
        pub fn get_arbiter(&self, id: u64) -> RistrettoPublicKeyBytes {
            self.listings.get(&id).expect("unknown listing").arbiter
        }

        /// The tradable-asset whitelist (empty = any resource allowed). Readable by anyone.
        pub fn get_asset_whitelist(&self) -> Vec<ResourceAddress> {
            self.asset_whitelist.clone()
        }

        /// Returns `(required_stake, staked_by_this_arbiter)`. Readable by anyone.
        pub fn get_arbiter_stake(&self, arbiter: RistrettoPublicKeyBytes) -> (Amount, Amount) {
            let staked = self.arbiter_stakes.get(&arbiter).map(|v| v.balance()).unwrap_or(amount![0]);
            (self.arbiter_stake, staked)
        }

        /// The owner badge resource address (gates the owner-only methods). Readable by anyone.
        pub fn get_owner_badge(&self) -> ResourceAddress {
            self.owner_badge
        }

        // -- helpers ---------------------------------------------------------------------
        fn get_mut(&mut self, id: u64) -> &mut Listing {
            self.listings.get_mut(&id).expect("unknown listing")
        }

        /// Total stake `who` currently holds in the board (0 if they never staked).
        fn staked_balance(&self, who: &RistrettoPublicKeyBytes) -> Amount {
            self.arbiter_stakes.get(who).map(|v| v.balance()).unwrap_or(amount![0])
        }

        /// Stake locked to `who`'s **live** deals — the sum of `arbiter_stake_locked` over every
        /// listing they arbitrate that is still `Taken` or `Disputed`. This is the portion that cannot
        /// be unstaked and that backs each deal's timeout burn; the free portion is the rest.
        fn locked_stake_for(&self, who: &RistrettoPublicKeyBytes) -> Amount {
            let mut total = amount![0];
            for l in self.listings.values() {
                if &l.arbiter == who
                    && (l.state == ListingState::Taken || l.state == ListingState::Disputed)
                {
                    total += l.arbiter_stake_locked;
                }
            }
            total
        }
    }
}
