//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! # AgentBudget template
//!
//! A chain-enforced spending wallet for an AI agent.
//!
//! The **owner** (a human) funds the budget and receives two badges from `new`:
//! - an **owner badge** — lets them change the limits, manage the merchant whitelist, revoke the
//!   agent, and withdraw the remaining balance;
//! - an **agent badge** — handed to the AI agent, lets it `pay` merchants, but only within the
//!   rules the chain enforces.
//!
//! The agent cannot exceed the per-transaction cap or the rolling daily cap, cannot pay a merchant
//! that is not whitelisted, and is frozen the instant the owner revokes it — none of this relies on
//! the agent's client behaving. Access is gated by the badges via component access rules, so the
//! agent (holding only the agent badge) can never call an owner method.
//!
//! **Confidential amounts (spike conclusion, 方案 a):** the Ootle engine cannot read the value of a
//! confidential resource inside a template, so hard limits can only be enforced on a *plaintext*
//! countable resource. This budget therefore locks whatever resource it is funded with and enforces
//! the caps on that plaintext amount. It is not bound to a single token.
//!
//! **Time = epochs.** "Daily" is a rolling window of `epochs_per_window` epochs (≈30 min each), since
//! the Ootle has no wall-clock time. The window resets lazily on the first `pay` after it elapses.

use tari_template_lib::prelude::*;

#[template]
mod agent_budget {
    use super::*;

    pub struct AgentBudget {
        /// The funds the agent may spend (a plaintext, countable resource — see module docs).
        vault: Vault,
        /// Badge resource that authorizes owner methods.
        owner_badge: ResourceAddress,
        /// Badge resource that authorizes the agent's `pay`.
        agent_badge: ResourceAddress,
        /// Maximum amount a single payment may move.
        per_tx_cap: Amount,
        /// Maximum amount that may be spent within one rolling window.
        daily_cap: Amount,
        /// Amount spent so far in the current window.
        spent_in_window: Amount,
        /// Epoch at which the current window started.
        window_start_epoch: u64,
        /// Length of the spending window, in epochs (e.g. 48 ≈ 24h).
        epochs_per_window: u64,
        /// Accounts the agent is allowed to pay.
        merchant_whitelist: Vec<ComponentAddress>,
        /// When true, the agent is frozen and `pay` always fails.
        revoked: bool,
        // ---- optional escrow integration (set via `configure_escrow`) ----
        /// Address of the `Escrow` template used by `pay_via_escrow`.
        escrow_template: Option<TemplateAddress>,
        /// Owner's account — receives the refund if an escrow times out.
        owner_account: Option<ComponentAddress>,
        /// Platform treasury account that collects the escrow fee.
        treasury_account: Option<ComponentAddress>,
        /// Optional arbiter identity for escrows opened by the agent.
        escrow_arbiter: Option<RistrettoPublicKeyBytes>,
        /// Fee (basis points) charged by escrows opened by the agent.
        escrow_fee_bps: u64,
    }

    impl AgentBudget {
        /// Creates a budget, locking `funds`, and returns `(component, owner_badge, agent_badge)`.
        ///
        /// Called by the owner. Give the agent badge to the AI agent; keep the owner badge.
        ///
        /// # Panics
        /// - if `epochs_per_window` is 0
        /// - if `per_tx_cap` or `daily_cap` is negative
        pub fn new(
            funds: Bucket,
            per_tx_cap: Amount,
            daily_cap: Amount,
            epochs_per_window: u64,
            merchant_whitelist: Vec<ComponentAddress>,
        ) -> (Component<AgentBudget>, Bucket, Bucket) {
            assert!(epochs_per_window > 0, "epochs_per_window must be greater than zero");
            assert!(per_tx_cap >= amount![0], "per_tx_cap cannot be negative");
            assert!(daily_cap >= amount![0], "daily_cap cannot be negative");

            let owner_badge_bucket = ResourceBuilder::non_fungible()
                .with_token_symbol("OWNER")
                .mintable(AccessRule::DenyAll, LOCKED)
                .burnable(AccessRule::AllowAll, LOCKED)
                .initial_supply_with_data(Some((NonFungibleId::random(), (&(), &()))));
            let owner_badge = owner_badge_bucket.resource_address();

            let agent_badge_bucket = ResourceBuilder::non_fungible()
                .with_token_symbol("AGENT")
                .mintable(AccessRule::DenyAll, LOCKED)
                .burnable(AccessRule::AllowAll, LOCKED)
                .initial_supply_with_data(Some((NonFungibleId::random(), (&(), &()))));
            let agent_badge = agent_badge_bucket.resource_address();

            // Owner methods require the owner badge; `pay` requires the agent badge; everything else
            // (the read-only getters) is open.
            let rules = ComponentAccessRules::new()
                .method("pay", rule!(resource(agent_badge)))
                .method("pay_via_escrow", rule!(resource(agent_badge)))
                .method("set_limits", rule!(resource(owner_badge)))
                .method("add_merchant", rule!(resource(owner_badge)))
                .method("remove_merchant", rule!(resource(owner_badge)))
                .method("configure_escrow", rule!(resource(owner_badge)))
                .method("revoke", rule!(resource(owner_badge)))
                .method("withdraw", rule!(resource(owner_badge)))
                .default(rule!(allow_all));

            let component = Component::new(Self {
                vault: Vault::from_bucket(funds),
                owner_badge,
                agent_badge,
                per_tx_cap,
                daily_cap,
                spent_in_window: amount![0],
                window_start_epoch: Consensus::current_epoch(),
                epochs_per_window,
                merchant_whitelist,
                revoked: false,
                escrow_template: None,
                owner_account: None,
                treasury_account: None,
                escrow_arbiter: None,
                escrow_fee_bps: 0,
            })
            .with_access_rules(rules)
            .create();

            (component, owner_badge_bucket, agent_badge_bucket)
        }

        /// Pays `amount` to a whitelisted `merchant` account. Called by the agent (agent badge).
        ///
        /// # Panics
        /// - if the agent has been revoked
        /// - if `amount` is not positive
        /// - if `amount` exceeds the per-transaction cap
        /// - if the merchant is not whitelisted
        /// - if the payment would exceed the rolling daily cap
        pub fn pay(&mut self, merchant: ComponentAddress, amount: Amount, memo: String) {
            assert!(!self.revoked, "Agent has been revoked");
            assert!(amount > amount![0], "Amount must be positive");
            assert!(amount <= self.per_tx_cap, "Amount exceeds the per-transaction cap");
            assert!(
                self.merchant_whitelist.contains(&merchant),
                "Merchant is not whitelisted"
            );

            self.roll_window();
            assert!(
                self.spent_in_window + amount <= self.daily_cap,
                "Amount exceeds the daily cap"
            );

            self.spent_in_window += amount;
            let payment = self.vault.withdraw(amount);
            ComponentManager::get(merchant).invoke("deposit", args![payment]);

            emit_event(
                "pay",
                metadata![
                    "merchant" => merchant.to_string(),
                    "amount" => amount.to_string(),
                    "memo" => memo,
                    "spent_in_window" => self.spent_in_window.to_string(),
                ],
            );
        }

        /// Configures the escrow integration used by `pay_via_escrow`. Called by the owner.
        ///
        /// - `escrow_template`: the address of the published `Escrow` template.
        /// - `owner_account`: where an escrow refunds to on timeout.
        /// - `treasury_account`: where the escrow fee is paid.
        /// - `arbiter`: optional dispute arbiter for escrows the agent opens.
        /// - `fee_bps`: escrow fee in basis points (0..=10000).
        pub fn configure_escrow(
            &mut self,
            escrow_template: TemplateAddress,
            owner_account: ComponentAddress,
            treasury_account: ComponentAddress,
            arbiter: Option<RistrettoPublicKeyBytes>,
            fee_bps: u64,
        ) {
            assert!(fee_bps <= 10000, "fee_bps cannot exceed 10000");
            self.escrow_template = Some(escrow_template);
            self.owner_account = Some(owner_account);
            self.treasury_account = Some(treasury_account);
            self.escrow_arbiter = arbiter;
            self.escrow_fee_bps = fee_bps;
            emit_event("configure_escrow", metadata!["fee_bps" => fee_bps.to_string()]);
        }

        /// Instead of paying `merchant` directly, opens an `Escrow` that locks `amount` until it is
        /// released (e.g. after the merchant delivers). Returns the new escrow component address.
        /// Called by the agent. Subject to the same checks and daily budget as `pay`.
        ///
        /// The escrow records the transaction signer (the agent) as its payer, the owner's account
        /// as the refund target, and the merchant as the payee. `merchant_pubkey` lets the merchant
        /// raise a dispute.
        ///
        /// # Panics
        /// - any of the `pay` checks (revoked / positive / per-tx cap / whitelist / daily cap)
        /// - if the escrow integration has not been configured
        pub fn pay_via_escrow(
            &mut self,
            merchant: ComponentAddress,
            merchant_pubkey: RistrettoPublicKeyBytes,
            amount: Amount,
            timeout_epochs: u64,
            memo: String,
        ) -> ComponentAddress {
            assert!(!self.revoked, "Agent has been revoked");
            assert!(amount > amount![0], "Amount must be positive");
            assert!(amount <= self.per_tx_cap, "Amount exceeds the per-transaction cap");
            assert!(
                self.merchant_whitelist.contains(&merchant),
                "Merchant is not whitelisted"
            );
            self.roll_window();
            assert!(
                self.spent_in_window + amount <= self.daily_cap,
                "Amount exceeds the daily cap"
            );

            let escrow_template = self.escrow_template.expect("Escrow integration is not configured");
            let owner_account = self.owner_account.expect("Escrow integration is not configured");
            let treasury_account = self
                .treasury_account
                .expect("Escrow integration is not configured");

            self.spent_in_window += amount;
            let payment = self.vault.withdraw(amount);
            let escrow: ComponentAddress = TemplateManager::get(escrow_template).call(
                "new",
                args![
                    payment,
                    owner_account,
                    merchant,
                    merchant_pubkey,
                    self.escrow_arbiter,
                    treasury_account,
                    None::<Hash32>,
                    timeout_epochs,
                    self.escrow_fee_bps
                ],
            );

            emit_event(
                "pay_via_escrow",
                metadata![
                    "merchant" => merchant.to_string(),
                    "amount" => amount.to_string(),
                    "escrow" => escrow.to_string(),
                    "memo" => memo,
                ],
            );
            escrow
        }

        /// Updates the per-transaction and daily caps. Called by the owner.
        pub fn set_limits(&mut self, per_tx_cap: Amount, daily_cap: Amount) {
            assert!(per_tx_cap >= amount![0], "per_tx_cap cannot be negative");
            assert!(daily_cap >= amount![0], "daily_cap cannot be negative");
            self.per_tx_cap = per_tx_cap;
            self.daily_cap = daily_cap;
            emit_event(
                "set_limits",
                metadata!["per_tx_cap" => per_tx_cap.to_string(), "daily_cap" => daily_cap.to_string()],
            );
        }

        /// Adds a merchant account to the whitelist. Called by the owner.
        pub fn add_merchant(&mut self, merchant: ComponentAddress) {
            if !self.merchant_whitelist.contains(&merchant) {
                self.merchant_whitelist.push(merchant);
            }
            emit_event("add_merchant", metadata!["merchant" => merchant.to_string()]);
        }

        /// Removes a merchant account from the whitelist. Called by the owner.
        pub fn remove_merchant(&mut self, merchant: ComponentAddress) {
            self.merchant_whitelist.retain(|m| m != &merchant);
            emit_event("remove_merchant", metadata!["merchant" => merchant.to_string()]);
        }

        /// Immediately freezes the agent. Called by the owner. After this, every `pay` fails.
        pub fn revoke(&mut self) {
            self.revoked = true;
            emit_event("revoke", metadata![]);
        }

        /// Withdraws `amount` from the budget back to the owner (returns a bucket). Called by the owner.
        pub fn withdraw(&mut self, amount: Amount) -> Bucket {
            emit_event("withdraw", metadata!["amount" => amount.to_string()]);
            self.vault.withdraw(amount)
        }

        /// Returns `(owner_badge, agent_badge)` resource addresses. Readable by anyone — lets the
        /// owner and agent clients discover which badge authorizes which calls.
        pub fn get_badges(&self) -> (ResourceAddress, ResourceAddress) {
            (self.owner_badge, self.agent_badge)
        }

        /// Returns `(revoked, balance, per_tx_cap, daily_cap, spent_in_window, window_start_epoch)`.
        /// Readable by anyone.
        pub fn get_info(&self) -> (bool, Amount, Amount, Amount, Amount, u64) {
            (
                self.revoked,
                self.vault.balance(),
                self.per_tx_cap,
                self.daily_cap,
                self.spent_in_window,
                self.window_start_epoch,
            )
        }

        // ----------------------------- helpers ----------------------------- //

        /// Resets the spent counter if the current window has elapsed.
        fn roll_window(&mut self) {
            let now = Consensus::current_epoch();
            if now >= self.window_start_epoch + self.epochs_per_window {
                self.window_start_epoch = now;
                self.spent_in_window = amount![0];
            }
        }
    }
}
