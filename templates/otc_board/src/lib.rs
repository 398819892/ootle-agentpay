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
//! Anti-abuse (per the product plan): a **listing bond** (skin in the game to list), a
//! **max listing amount** (per-deal cap), and an **arbiter whitelist** (only approved arbiters).
//! Time is measured in epochs (`Consensus::current_epoch()`); "terms" are summarised on chain as a
//! hash, with the detail kept off chain.

use tari_template_lib::prelude::*;

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
        /// Minimum stake an arbiter must post before they are allowed to `resolve`
        /// (0 = staking disabled — the whitelist-only behaviour). Set by the owner.
        arbiter_stake: Amount,
        /// Per-arbiter stake held by the board. Slashable by the owner if an arbiter misbehaves,
        /// giving the arbiter skin in the game beyond being whitelisted.
        arbiter_stakes: HashMap<RistrettoPublicKeyBytes, Vault>,
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
        ) -> (Component<OtcBoard>, Bucket) {
            assert!(fee_bps <= 10000, "fee_bps cannot exceed 10000");
            assert!(listing_bond >= amount![0], "listing_bond cannot be negative");
            assert!(max_listing_amount > amount![0], "max_listing_amount must be positive");

            let owner_badge_bucket = ResourceBuilder::non_fungible()
                .with_token_symbol("OTC-OWN")
                .mintable(AccessRule::DenyAll, LOCKED)
                .burnable(AccessRule::AllowAll, LOCKED)
                .initial_supply_with_data(Some((NonFungibleId::random(), (&(), &()))));
            let owner_badge = owner_badge_bucket.resource_address();

            let rules = ComponentAccessRules::new()
                .method("add_arbiter", rule!(resource(owner_badge)))
                .method("remove_arbiter", rule!(resource(owner_badge)))
                .method("set_params", rule!(resource(owner_badge)))
                .method("set_arbiter_stake", rule!(resource(owner_badge)))
                .method("slash_arbiter", rule!(resource(owner_badge)))
                .default(rule!(allow_all));

            let component = Component::new(Self {
                owner_badge,
                treasury_account,
                listing_bond,
                max_listing_amount,
                fee_bps,
                arbiter_whitelist,
                arbiter_stake: amount![0],
                arbiter_stakes: HashMap::new(),
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
        pub fn list(
            &mut self,
            asset: Bucket,
            bond: Bucket,
            seller_account: ComponentAddress,
            terms_hash: Hash32,
            arbiter: RistrettoPublicKeyBytes,
            timeout_epochs: u64,
        ) -> u64 {
            let amount = asset.amount();
            assert!(amount > amount![0], "Asset must be non-empty");
            assert!(amount <= self.max_listing_amount, "Asset exceeds the max listing amount");
            assert!(bond.amount() >= self.listing_bond, "Bond below the minimum listing bond");
            assert!(timeout_epochs > 0, "timeout must be greater than zero");
            assert!(
                self.arbiter_whitelist.contains(&arbiter),
                "Arbiter is not whitelisted"
            );

            let id = self.next_id;
            self.next_id += 1;
            let seller = CallerContext::transaction_signer_public_key();
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
                hashlock: None,
                deadline_epoch: 0,
                state: ListingState::Open,
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
        /// via `confirm`. `hashlock` (optional) lets the buyer release with a payment preimage.
        pub fn take(
            &mut self,
            id: u64,
            buyer_account: ComponentAddress,
            buyer: RistrettoPublicKeyBytes,
            hashlock: Option<Hash32>,
        ) {
            let now = Consensus::current_epoch();
            let listing = self.get_mut(id);
            assert!(listing.state == ListingState::Open, "Listing is not open");
            listing.buyer_account = Some(buyer_account);
            listing.buyer = Some(buyer);
            listing.hashlock = hashlock;
            listing.deadline_epoch = now + listing.timeout_epochs;
            listing.state = ListingState::Taken;
            emit_event("take", metadata!["id" => id.to_string()]);
        }

        /// Releases the asset to the buyer, charging the platform fee. Authorised by the seller
        /// (confirming they were paid) or by anyone presenting the payment preimage of the hashlock.
        pub fn confirm(&mut self, id: u64, preimage: Option<Vec<u8>>) {
            let treasury = self.treasury_account;
            let fee_bps = self.fee_bps;
            let listing = self.get_mut(id);
            assert!(listing.state == ListingState::Taken, "Listing is not taken");

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
            let fee = total * fee_bps / 10000;
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

        /// Either party raises a dispute, freezing the listing until the arbiter resolves it.
        pub fn open_dispute(&mut self, id: u64) {
            let listing = self.get_mut(id);
            assert!(listing.state == ListingState::Taken, "Listing is not taken");
            let caller = CallerContext::transaction_signer_public_key();
            assert!(
                caller == listing.seller || Some(caller) == listing.buyer,
                "Only the seller or buyer may dispute"
            );
            listing.state = ListingState::Disputed;
            emit_event("dispute", metadata!["id" => id.to_string()]);
        }

        /// The listing's arbiter splits the asset: `to_buyer_amount` (minus fee) to the buyer, the
        /// remainder to the seller. The bond returns to the seller.
        pub fn resolve(&mut self, id: u64, to_buyer_amount: Amount) {
            let treasury = self.treasury_account;
            let fee_bps = self.fee_bps;
            let stake_req = self.arbiter_stake;
            // When staking is required, the listing's arbiter must have posted enough stake. Read
            // both (disjoint, immutable) fields before taking the mutable listing borrow below.
            if stake_req > amount![0] {
                let l = self.listings.get(&id).expect("unknown listing");
                let staked = self.arbiter_stakes.get(&l.arbiter).map(|v| v.balance()).unwrap_or(amount![0]);
                assert!(staked >= stake_req, "Arbiter has not staked enough to resolve");
            }
            let listing = self.get_mut(id);
            assert!(listing.state == ListingState::Disputed, "Listing is not under dispute");
            assert!(
                CallerContext::transaction_signer_public_key() == listing.arbiter,
                "Only the listing's arbiter may resolve"
            );
            let total = listing.asset.balance();
            assert!(to_buyer_amount >= amount![0], "amount cannot be negative");
            assert!(to_buyer_amount <= total, "amount exceeds the escrowed asset");

            let fee = to_buyer_amount * fee_bps / 10000;
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

        pub fn set_params(&mut self, listing_bond: Amount, max_listing_amount: Amount, fee_bps: u64) {
            assert!(fee_bps <= 10000, "fee_bps cannot exceed 10000");
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
            let amt = stake.amount();
            match self.arbiter_stakes.get_mut(&who) {
                Some(v) => v.deposit(stake),
                None => {
                    self.arbiter_stakes.insert(who, Vault::from_bucket(stake));
                }
            }
            emit_event("stake_arbiter", metadata!["amount" => amt.to_string()]);
        }

        /// An arbiter withdraws their entire posted stake (e.g. to retire). Returns the bucket.
        pub fn unstake_arbiter(&mut self) -> Bucket {
            let who = CallerContext::transaction_signer_public_key();
            let v = self.arbiter_stakes.get_mut(&who).expect("no stake posted");
            let out = v.withdraw_all();
            emit_event("unstake_arbiter", metadata!["amount" => out.amount().to_string()]);
            out
        }

        /// Owner slashes a misbehaving arbiter: their entire stake is moved to the treasury. This is
        /// the penalty that backs the arbiter's decisions — being whitelisted is no longer "free".
        pub fn slash_arbiter(&mut self, arbiter: RistrettoPublicKeyBytes) {
            let treasury = self.treasury_account;
            let v = self.arbiter_stakes.get_mut(&arbiter).expect("arbiter has no stake");
            let slashed = v.withdraw_all();
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
    }
}
