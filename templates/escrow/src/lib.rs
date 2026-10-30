//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! # Escrow template
//!
//! A generic, single-use escrow for the Tari Ootle.
//!
//! State machine:
//!
//! ```text
//!              release(preimage?)
//!   Open ───────────────────────────► Released
//!     │  refund()  (after timeout)
//!     ├───────────────────────────────► Refunded
//!     │  dispute()
//!     └───────────────────────────────► Disputed ──► resolve(to_payee) ──► Resolved
//! ```
//!
//! Design notes (grounded in the real `tari_template_lib` 0.35 API):
//! - **Any resource.** The escrow locks whatever resource is in the `funds` bucket and pays out in
//!   that same resource. It is not bound to a single token (per the project's "任意资源地址" rule).
//! - **Identity-based auth.** Callers are authenticated by their transaction signer public key
//!   (`CallerContext::transaction_signer_public_key()`), compared against the payer / payee /
//!   arbiter public keys recorded at creation. Access rules are `allow_all`; authorization is
//!   enforced inside each method.
//! - **Time = epochs.** Timeouts use `Consensus::current_epoch()` (≈30 min granularity). There is
//!   no wall-clock time on the Ootle.
//! - **Fee in basis points.** `fee_bps` (0..=10000) of the amount delivered to the payee is routed
//!   to the platform treasury account. A 0 bps fee charges nothing.
//! - **Payee verification.** The payer sets both the `payee` public key (who may `dispute`) and the
//!   `payee_account` (where `release`/`resolve` pays) at `new`; they are independent. The escrowed
//!   funds belong to the payer and can only flow to `payee_account`, `payer_account` or the
//!   treasury, so these never let funds reach a third party. But a payee who relies on being able
//!   to dispute should first read `get_parties` and confirm their own key/account are the recorded
//!   ones before delivering.

use tari_template_lib::prelude::*;

/// The escrow lifecycle state.
#[derive(Debug, Clone, PartialEq, Eq, minicbor::Encode, minicbor::Decode, minicbor::CborLen)]
pub enum EscrowState {
    /// Funds are locked; awaiting release, refund or dispute.
    #[n(0)]
    Open,
    /// Funds were released to the payee (terminal).
    #[n(1)]
    Released,
    /// Funds were refunded to the payer after timeout (terminal).
    #[n(2)]
    Refunded,
    /// A party raised a dispute; funds are frozen until the arbiter resolves.
    #[n(3)]
    Disputed,
    /// The arbiter split the funds (terminal).
    #[n(4)]
    Resolved,
}

#[template]
mod escrow {
    use super::*;

    pub struct Escrow {
        /// The locked funds (any resource type).
        funds: Vault,
        /// Payer identity — may refund (after timeout) and may dispute/release.
        payer: RistrettoPublicKeyBytes,
        /// Payee identity — may dispute.
        payee: RistrettoPublicKeyBytes,
        /// Arbiter identity — may resolve a dispute. `None` means no arbiter was configured.
        arbiter: Option<RistrettoPublicKeyBytes>,
        /// Account that receives funds on release / the payee share on resolve.
        payee_account: ComponentAddress,
        /// Account that receives funds on refund / the payer share on resolve.
        payer_account: ComponentAddress,
        /// Platform treasury account that collects the fee.
        treasury_account: ComponentAddress,
        /// Optional SHA-256 hashlock. If set, anyone presenting the matching preimage may release.
        hashlock: Option<Hash32>,
        /// Refund is only allowed at or after this epoch.
        deadline_epoch: u64,
        /// Fee charged on the payee's payout, in basis points (0..=10000).
        fee_bps: u64,
        /// Current lifecycle state.
        state: EscrowState,
    }

    impl Escrow {
        /// Creates a new escrow, locking `funds`.
        ///
        /// Called by the **payer** (the transaction signer becomes the recorded payer identity).
        ///
        /// # Panics
        /// - if `funds` is empty
        /// - if `timeout_epochs` is 0
        /// - if `fee_bps` exceeds 10000 (100%)
        pub fn new(
            funds: Bucket,
            payer_account: ComponentAddress,
            payee_account: ComponentAddress,
            payee: RistrettoPublicKeyBytes,
            arbiter: Option<RistrettoPublicKeyBytes>,
            treasury_account: ComponentAddress,
            hashlock: Option<Hash32>,
            timeout_epochs: u64,
            fee_bps: u64,
        ) -> Component<Escrow> {
            assert!(!funds.amount().is_zero(), "Escrow must be funded");
            assert!(timeout_epochs > 0, "Timeout must be greater than zero");
            assert!(fee_bps <= 10000, "Fee basis points cannot exceed 10000");

            let payer = CallerContext::transaction_signer_public_key();
            let deadline_epoch = Consensus::current_epoch() + timeout_epochs;

            Component::new(Self {
                funds: Vault::from_bucket(funds),
                payer,
                payee,
                arbiter,
                payee_account,
                payer_account,
                treasury_account,
                hashlock,
                deadline_epoch,
                fee_bps,
                state: EscrowState::Open,
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        /// Releases the funds to the payee, charging the platform fee.
        ///
        /// Authorized if the caller is the payer, **or** a hashlock is set and `preimage` hashes
        /// (SHA-256) to it. `preimage` is ignored when no hashlock is configured.
        ///
        /// # Panics
        /// - if the escrow is not `Open`
        /// - if the caller is neither the payer nor a valid preimage holder
        pub fn release(&mut self, preimage: Option<Vec<u8>>) {
            self.assert_open();

            let caller = CallerContext::transaction_signer_public_key();
            let is_payer = caller == self.payer;
            let has_preimage = match (&self.hashlock, &preimage) {
                (Some(lock), Some(pre)) => intrinsics::hash_sha256(pre) == *lock,
                _ => false,
            };
            assert!(
                is_payer || has_preimage,
                "Unauthorized: release requires the payer or a valid preimage"
            );

            let total = self.funds.balance();
            let fee = self.fee_on(total);
            let payee_amount = total - fee;

            // Pay the fee to the treasury first (only if non-zero).
            self.pay_fee(fee);

            // Pay the remainder to the payee.
            let payee_bucket = self.funds.withdraw(payee_amount);
            ComponentManager::get(self.payee_account).invoke("deposit", args![payee_bucket]);

            self.state = EscrowState::Released;
            emit_event(
                "released",
                metadata![
                    "payee_amount" => payee_amount.to_string(),
                    "fee" => fee.to_string(),
                ],
            );
        }

        /// Refunds the locked funds to the payer. Only callable by the payer, and only once the
        /// timeout epoch has been reached. No fee is charged on a refund.
        ///
        /// # Panics
        /// - if the escrow is not `Open`
        /// - if the caller is not the payer
        /// - if the current epoch is before the deadline
        pub fn refund(&mut self) {
            self.assert_open();

            let caller = CallerContext::transaction_signer_public_key();
            assert!(caller == self.payer, "Unauthorized: only the payer may refund");
            assert!(
                Consensus::current_epoch() >= self.deadline_epoch,
                "Cannot refund before the timeout"
            );

            let refund_bucket = self.funds.withdraw_all();
            ComponentManager::get(self.payer_account).invoke("deposit", args![refund_bucket]);

            self.state = EscrowState::Refunded;
            emit_event("refunded", metadata![]);
        }

        /// Raises a dispute, freezing the escrow until the arbiter resolves it. Either the payer or
        /// the payee may dispute.
        ///
        /// # Panics
        /// - if the escrow is not `Open`
        /// - if the caller is neither the payer nor the payee
        pub fn dispute(&mut self) {
            self.assert_open();

            let caller = CallerContext::transaction_signer_public_key();
            assert!(
                caller == self.payer || caller == self.payee,
                "Unauthorized: only the payer or payee may dispute"
            );

            self.state = EscrowState::Disputed;
            emit_event("disputed", metadata![]);
        }

        /// Resolves a dispute by splitting the funds: `to_payee_amount` (minus the fee on it) goes to
        /// the payee, the remainder goes back to the payer. Only callable by the configured arbiter.
        ///
        /// # Panics
        /// - if the escrow is not `Disputed`
        /// - if there is no arbiter, or the caller is not the arbiter
        /// - if `to_payee_amount` is negative or exceeds the locked balance
        pub fn resolve(&mut self, to_payee_amount: Amount) {
            assert!(
                self.state == EscrowState::Disputed,
                "Escrow is not under dispute"
            );

            let caller = CallerContext::transaction_signer_public_key();
            assert!(
                self.arbiter == Some(caller),
                "Unauthorized: only the arbiter may resolve"
            );

            let total = self.funds.balance();
            assert!(to_payee_amount >= amount![0], "Payee amount cannot be negative");
            assert!(to_payee_amount <= total, "Payee amount exceeds the escrow balance");

            let fee = self.fee_on(to_payee_amount);
            let payee_net = to_payee_amount - fee;
            let payer_amount = total - to_payee_amount;

            self.pay_fee(fee);

            if !payee_net.is_zero() {
                let payee_bucket = self.funds.withdraw(payee_net);
                ComponentManager::get(self.payee_account).invoke("deposit", args![payee_bucket]);
            }
            if !payer_amount.is_zero() {
                let payer_bucket = self.funds.withdraw(payer_amount);
                ComponentManager::get(self.payer_account).invoke("deposit", args![payer_bucket]);
            }

            self.state = EscrowState::Resolved;
            emit_event(
                "resolved",
                metadata![
                    "to_payee" => payee_net.to_string(),
                    "to_payer" => payer_amount.to_string(),
                    "fee" => fee.to_string(),
                ],
            );
        }

        /// Returns the current lifecycle state. Readable by anyone.
        pub fn get_state(&self) -> EscrowState {
            self.state.clone()
        }

        /// Returns `(state, locked_balance, deadline_epoch, fee_bps)`. Readable by anyone.
        pub fn get_info(&self) -> (EscrowState, Amount, u64, u64) {
            (
                self.state.clone(),
                self.funds.balance(),
                self.deadline_epoch,
                self.fee_bps,
            )
        }

        /// Returns the recorded parties `(payer, payee, arbiter, payee_account, payer_account)`.
        /// Readable by anyone.
        ///
        /// The payee should read this **before relying on the escrow** (e.g. before delivering) and
        /// check that their own public key is the recorded `payee` — the identity allowed to
        /// `dispute` — and that their account is the `payee_account` that `release`/`resolve` pays.
        /// The payer sets both at `new`; they are independent, and the funds (which belong to the
        /// payer) only ever flow to `payee_account`, `payer_account` or the treasury, so a mismatch
        /// cannot divert funds to a third party — it would only leave the payee unable to dispute as
        /// expected. Verifying here closes that gap.
        pub fn get_parties(
            &self,
        ) -> (
            RistrettoPublicKeyBytes,
            RistrettoPublicKeyBytes,
            Option<RistrettoPublicKeyBytes>,
            ComponentAddress,
            ComponentAddress,
        ) {
            (self.payer, self.payee, self.arbiter, self.payee_account, self.payer_account)
        }

        // ----------------------------- helpers ----------------------------- //

        fn assert_open(&self) {
            assert!(self.state == EscrowState::Open, "Escrow is not open");
        }

        /// fee = amount * fee_bps / 10000 (integer math, truncated).
        fn fee_on(&self, amount: Amount) -> Amount {
            amount * self.fee_bps / 10000
        }

        /// Deposits `fee` into the treasury account, unless it is zero.
        fn pay_fee(&mut self, fee: Amount) {
            if !fee.is_zero() {
                let fee_bucket = self.funds.withdraw(fee);
                ComponentManager::get(self.treasury_account).invoke("deposit", args![fee_bucket]);
            }
        }
    }
}
