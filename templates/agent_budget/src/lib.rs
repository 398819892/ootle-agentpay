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
//!
//! **⚠ Fixed window, not a sliding one — the cap binds ~2× across a boundary.** `daily_cap` limits
//! spend *within* each fixed `epochs_per_window` window, not over any trailing window. An agent can
//! spend the full cap in the last epoch of one window and the full cap again in the first epoch of the
//! next — up to ~2× the cap within a short real-time span straddling the boundary. This is deliberate:
//! a true sliding window would need the chain to store a timestamped spend history and bound fees by
//! it, which the fixed-window counter avoids. If an absolute ceiling over any ~24h span matters, set
//! `daily_cap` to **half** the real limit (so 2× the cap is the real limit), and/or set a tight
//! `per_tx_cap`. The hard safety rails that never over-spend are `per_tx_cap` (every single payment)
//! and `revoke` (instant freeze); treat `daily_cap` as a rate guard, not a hard cumulative ceiling.
//! See `docs/audit-notes.md` (#5).
//!
//! **Many agents / sessions.** All agent badges are non-fungible tokens of one agent-badge *resource*
//! (so `pay` only ever honours that resource). `new` mints a first badge (the `"default"` session, so
//! the one-badge flow is unchanged); the owner can `issue_agent_badge` more — one per agent or session
//! — and `revoke_session` any single one without touching the others. `pay` identifies the paying
//! session from the badge proof and refuses a revoked one; `revoke` (no argument) remains the global
//! kill switch that freezes every session at once.
//!
//! **Top-ups & periodic allowance.** `top_up` lets the owner — or an external keeper — add funds to the
//! vault at any time. The per-window `daily_cap` *is* the recurring allowance: the rolling window zeroes
//! `spent_in_window` on the first `pay` of each new window, so the agent regains its allowance every
//! window with no action required. **There is no wall-clock timer and no on-chain scheduler on the
//! Ootle** — a window only advances when epochs pass, and it only *resets* lazily on the next payment.
//! Anything that must happen "on a schedule" (a recurring deposit, a subscription charge) is driven by
//! the owner or a keeper calling `top_up` on its own cadence; the chain does not do it for you.

use tari_template_lib::prelude::*;

#[template]
mod agent_budget {
    use super::*;

    pub struct AgentBudget {
        /// The funds the agent may spend (a plaintext, countable resource — see module docs).
        vault: Vault,
        /// Badge resource that authorizes owner methods.
        owner_badge: ResourceAddress,
        /// Badge resource whose non-fungible tokens authorize the agent's `pay`. Every agent/session
        /// badge is a token of this one resource (see module docs).
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
        /// When true, every agent session is frozen and `pay` always fails (the global kill switch).
        revoked: bool,
        /// Individually revoked session badges, by their non-fungible id. A `pay` presenting any of
        /// these is refused, while other sessions keep working. See `revoke_session`.
        revoked_sessions: Vec<NonFungibleId>,
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
        /// Called by the owner. Give the agent badge to the AI agent; keep the owner badge. The agent
        /// badge returned here is the first session (id `"default"`); use `issue_agent_badge` to mint
        /// more for additional agents/sessions.
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
                // DenyAll (not AllowAll): the owner badge gates withdraw / revoke / limit changes and
                // there is no recovery path, so burning it would strand the funds. It must not be
                // destroyable. (The agent badge below stays burnable — sessions are meant to be retired.)
                .burnable(AccessRule::DenyAll, LOCKED)
                .initial_supply_with_data(Some((NonFungibleId::random(), (&(), &()))));
            let owner_badge = owner_badge_bucket.resource_address();

            let agent_badge_bucket = ResourceBuilder::non_fungible()
                .with_token_symbol("AGENT")
                // Only a transaction carrying the owner badge can mint more session badges
                // (`issue_agent_badge`). The genesis token below is part of resource creation and is
                // not subject to this rule. Nobody else — not even a holder of an agent badge — can mint.
                .mintable(rule!(resource(owner_badge)), LOCKED)
                .burnable(AccessRule::AllowAll, LOCKED)
                .initial_supply_with_data(Some((NonFungibleId::from_string("default"), (&(), &()))));
            let agent_badge = agent_badge_bucket.resource_address();

            // Owner methods require the owner badge. `pay` / `pay_via_escrow` are `allow_all` at the
            // component level because they enforce the agent badge *inside* the method (they read the
            // presented badge proof to learn which session is paying — a per-session access rule can't,
            // since the rules are fixed at creation). `top_up` and the read-only getters are open.
            let rules = ComponentAccessRules::new()
                .method("pay", rule!(allow_all))
                .method("pay_via_escrow", rule!(allow_all))
                .method("set_limits", rule!(resource(owner_badge)))
                .method("add_merchant", rule!(resource(owner_badge)))
                .method("remove_merchant", rule!(resource(owner_badge)))
                .method("configure_escrow", rule!(resource(owner_badge)))
                .method("issue_agent_badge", rule!(resource(owner_badge)))
                .method("revoke_session", rule!(resource(owner_badge)))
                .method("set_window", rule!(resource(owner_badge)))
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
                revoked_sessions: Vec::new(),
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

        /// Pays `amount` to a whitelisted `merchant` account. Called by the agent, which must present
        /// a proof of one of this budget's agent-badge session tokens as `agent_proof`.
        ///
        /// # Panics
        /// - if the agent has been globally revoked
        /// - if `agent_proof` is not a proof of this budget's agent badge
        /// - if the presented session badge has been individually revoked
        /// - if `amount` is not positive
        /// - if `amount` exceeds the per-transaction cap
        /// - if the merchant is not whitelisted
        /// - if the payment would exceed the rolling daily cap
        pub fn pay(&mut self, agent_proof: Proof, merchant: ComponentAddress, amount: Amount, memo: String) {
            let session = self.authorize_session(&agent_proof);
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
                    "session" => session,
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
            agent_proof: Proof,
            merchant: ComponentAddress,
            merchant_pubkey: RistrettoPublicKeyBytes,
            amount: Amount,
            timeout_epochs: u64,
            memo: String,
        ) -> ComponentAddress {
            self.authorize_session(&agent_proof);
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

        /// Mints and returns a new agent session badge labelled `session`. Called by the owner.
        ///
        /// Hand the returned badge to another agent (or another session of the same agent): it is a
        /// token of the same agent-badge resource `pay` honours, so the new holder can pay within the
        /// very same on-chain caps/whitelist — and the owner can later `revoke_session(session)` to cut
        /// off just that one. If `session` had been revoked before, issuing it again clears that flag.
        ///
        /// # Panics
        /// - if a badge with this `session` label already exists (labels must be unique)
        pub fn issue_agent_badge(&mut self, session: String) -> Bucket {
            let id = NonFungibleId::from_string(&session);
            self.revoked_sessions.retain(|x| x != &id);
            let badge = ResourceManager::get(self.agent_badge).mint_non_fungible(id, &(), &());
            emit_event("issue_agent_badge", metadata!["session" => session]);
            badge
        }

        /// Individually revokes the agent session badge labelled `session`. Called by the owner.
        /// Every further `pay` from that badge is rejected on chain; other sessions are unaffected.
        pub fn revoke_session(&mut self, session: String) {
            let id = NonFungibleId::from_string(&session);
            if !self.revoked_sessions.contains(&id) {
                self.revoked_sessions.push(id);
            }
            emit_event("revoke_session", metadata!["session" => session]);
        }

        /// Adds `funds` to the budget's vault. Open to anyone (the owner, or an external keeper topping
        /// the budget up on its own cadence — the Ootle has no scheduler to do it automatically; see
        /// module docs). `funds` must be the same resource the budget was created with.
        pub fn top_up(&mut self, funds: Bucket) {
            let amount = funds.amount();
            self.vault.deposit(funds);
            emit_event(
                "top_up",
                metadata!["amount" => amount.to_string(), "balance" => self.vault.balance().to_string()],
            );
        }

        /// Reconfigures the rolling spending window. Called by the owner.
        ///
        /// `epochs_per_window` is the recurring allowance period: the agent may spend up to `daily_cap`
        /// per window, and the counter resets on the first `pay` of each new window. This restarts the
        /// window now (resets the spent counter), so the new period takes effect immediately.
        ///
        /// # Panics
        /// - if `epochs_per_window` is 0
        pub fn set_window(&mut self, epochs_per_window: u64) {
            assert!(epochs_per_window > 0, "epochs_per_window must be greater than zero");
            self.epochs_per_window = epochs_per_window;
            self.window_start_epoch = Consensus::current_epoch();
            self.spent_in_window = amount![0];
            emit_event(
                "set_window",
                metadata!["epochs_per_window" => epochs_per_window.to_string()],
            );
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

        /// Validates an agent badge proof for a `pay` call and returns the paying session's label.
        ///
        /// Panics if the agent is globally revoked, if the proof is not of this budget's agent-badge
        /// resource, or if any session the proof carries has been individually revoked. This is the
        /// single place the agent-badge gate lives, so both `pay` and `pay_via_escrow` enforce it
        /// identically.
        fn authorize_session(&self, agent_proof: &Proof) -> String {
            assert!(!self.revoked, "Agent has been revoked");
            agent_proof.assert_resource(self.agent_badge);
            let sessions = agent_proof.get_non_fungibles();
            for id in &sessions {
                assert!(!self.revoked_sessions.contains(id), "Agent session has been revoked");
            }
            // Report the clean session label (e.g. "default"), not its namespaced form ("str_default").
            sessions
                .iter()
                .next()
                .map(|id| id.as_str().map(String::from).unwrap_or_else(|| id.to_string()))
                .unwrap_or_default()
        }

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
