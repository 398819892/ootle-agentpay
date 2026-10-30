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
//!     │  dispute()                                   resolve(to_payee)
//!     └───────────────────────────────► Disputed ──────────────────────► Resolved
//!                                           │  refund() (after dispute_deadline)
//!                                           └───────────────────────────► Refunded
//! ```
//!
//! Note the two edges into `Refunded`: a plain timeout from `Open`, and a stalled-dispute timeout
//! from `Disputed` (the safe default when the arbiter never resolves). Both pay the fixed
//! `payer_account` and are callable by anyone — see `refund`.
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
//! - **Dispute-timeout trust model.** The payer also sets the `arbiter` (the only party who can
//!   `resolve` a dispute). If a dispute stalls — the arbiter never resolves — the `dispute_deadline`
//!   backstop refunds the funds to the **payer** (see `refund`), never to the payee. That is the safe
//!   liveness default (funds are never frozen forever), but it means a payee who has delivered is
//!   protected on a dispute *only as far as they trust the payer-chosen arbiter to actually act*. A
//!   payee must therefore read `get_parties`, confirm the `arbiter` is one they trust, and treat a
//!   `None` arbiter (disputes disabled — e.g. `AgentBudget::pay_via_escrow` with no arbiter) as "no
//!   dispute protection at all" before delivering. In `AgentBudget::pay_via_escrow` the arbiter is
//!   configured by the budget owner (the payer side), so this caveat applies squarely to merchants.

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
        /// Payer identity — may dispute and may release. (Refund after timeout is callable by
        /// anyone: it always pays the fixed `payer_account`, so restricting the caller adds nothing
        /// and opening it is a deliberate key-loss recovery property — see `refund`.)
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
        /// The configured timeout window, in epochs. Reused to bound a dispute: the arbiter has one
        /// such window from the dispute to `resolve` before anyone may `refund` to the payer.
        timeout_epochs: u64,
        /// Epoch after which a stalled dispute may be force-refunded to the payer (0 = not disputed).
        /// Set in `dispute`; see `refund`. Guards against an unreachable arbiter freezing funds.
        dispute_deadline: u64,
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
                timeout_epochs,
                dispute_deadline: 0,
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

        /// Refunds the locked funds to the fixed `payer_account`. No fee is charged on a refund.
        ///
        /// **Callable by anyone** — the destination is the immutable `payer_account`, so there is no
        /// benefit to restricting the caller, and opening it is a deliberate recovery property: if the
        /// payer's key is lost, rotated, or compromised (e.g. a revoked/leaked agent key in
        /// `AgentBudget::pay_via_escrow`), the funds can still be returned to the owner's account once
        /// the timeout passes, instead of being stranded. A stolen key cannot redirect them either —
        /// refund always pays `payer_account`, never the caller.
        ///
        /// Two timeouts gate it:
        /// - from `Open`, once the refund `deadline_epoch` is reached (the payee never delivered);
        /// - from `Disputed`, once the `dispute_deadline` is reached — the safe default when the
        ///   arbiter never resolved, so a dispute can never freeze the funds forever (see `dispute`).
        ///
        /// # Panics
        /// - if the escrow is neither `Open` nor `Disputed`
        /// - if the relevant timeout has not yet been reached
        pub fn refund(&mut self) {
            let now = Consensus::current_epoch();
            match self.state {
                EscrowState::Open => {
                    assert!(now >= self.deadline_epoch, "Cannot refund before the timeout");
                }
                EscrowState::Disputed => {
                    assert!(
                        now >= self.dispute_deadline,
                        "Cannot force-close before the dispute deadline"
                    );
                }
                // Released / Refunded / Resolved are terminal. Keep the original message so callers
                // (and tests) see the same "not open" rejection for a settled escrow.
                _ => panic!("Escrow is not open"),
            }

            let refund_bucket = self.funds.withdraw_all();
            ComponentManager::get(self.payer_account).invoke("deposit", args![refund_bucket]);

            self.state = EscrowState::Refunded;
            emit_event("refunded", metadata![]);
        }

        /// Raises a dispute, freezing the escrow until the arbiter resolves it — or, if the arbiter
        /// never does, until anyone force-refunds it to the payer after `dispute_deadline` (see
        /// `refund`). Either the payer or the payee may dispute.
        ///
        /// Disputing is **only possible when an arbiter is configured**. With no arbiter, nobody could
        /// `resolve`, so a dispute would freeze the funds with no way out short of the refund timeout;
        /// rejecting it up front keeps the escrow on its normal release/refund paths. (An escrow with
        /// no arbiter — e.g. one opened by `AgentBudget::pay_via_escrow` with `escrow_arbiter = None` —
        /// is therefore never freezable: it can only be released by the payer/preimage or refunded to
        /// the payer after the timeout. This was a confirmed liveness/fund-safety gap — see
        /// `docs/audit-notes.md`.)
        ///
        /// # Panics
        /// - if the escrow is not `Open`
        /// - if no arbiter is configured
        /// - if the caller is neither the payer nor the payee
        pub fn dispute(&mut self) {
            self.assert_open();
            assert!(
                self.arbiter.is_some(),
                "Cannot dispute an escrow with no arbiter"
            );

            let caller = CallerContext::transaction_signer_public_key();
            assert!(
                caller == self.payer || caller == self.payee,
                "Unauthorized: only the payer or payee may dispute"
            );

            self.state = EscrowState::Disputed;
            self.dispute_deadline = Consensus::current_epoch() + self.timeout_epochs;
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
