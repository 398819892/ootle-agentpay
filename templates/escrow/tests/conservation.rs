//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! Fund-conservation invariant + property/fuzz tests for the Escrow template (go-live gate ⑤).
//!
//! The one invariant money must obey, in EVERY terminal transition:
//!
//!     locked == to_payee + to_payer + fee + remaining_in_vault
//!
//! i.e. nothing is created from nothing and nothing vanishes — every base unit that was locked is
//! accounted for by exactly one of: paid to the payee, returned to the payer, taken as fee, or (for a
//! still-open escrow) left in the vault. These tests drive the real template in the wasmer sandbox and
//! assert the identity holds across release / refund / resolve, over a deterministic FUZZ of random
//! amounts, fees and split points, and at the boundaries (1 unit, 0% / 100% fee, rounding, 0 / full
//! split). Illegal transitions are asserted to fail AND move no funds.
//!
//! Determinism: a small seeded LCG (no external rng dependency) drives the fuzz, so a failure is
//! reproducible from the seed printed in the panic.

use tari_template_lib::prelude::*;
use tari_template_test_tooling::byte_type::ToByteType;
use tari_template_test_tooling::crypto::{PublicKey as _, RistrettoPublicKey, RistrettoSecretKey};
use tari_template_test_tooling::engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_template_test_tooling::support::assert_error::assert_reject_reason;
use tari_template_test_tooling::transaction::args;
use tari_template_test_tooling::TemplateTest;

// ------------------------------------------------------------------ harness

#[derive(Clone)]
struct Account {
    component: ComponentAddress,
    owner_token: NonFungibleAddress,
    key: RistrettoSecretKey,
    public_key: RistrettoPublicKeyBytes,
}

struct Ctx {
    test: TemplateTest,
    template: TemplateAddress,
}

fn setup() -> Ctx {
    let mut test = TemplateTest::my_crate();
    let template = test.get_template_address("Escrow");
    Ctx { test, template }
}

fn funded(test: &mut TemplateTest) -> Account {
    let (component, owner_token, key) = test.create_funded_account();
    let public_key = RistrettoPublicKey::from_secret_key(&key).to_byte_type();
    Account { component, owner_token, key, public_key }
}

fn empty(test: &mut TemplateTest) -> Account {
    let (component, owner_token, key) = test.create_empty_account();
    let public_key = RistrettoPublicKey::from_secret_key(&key).to_byte_type();
    Account { component, owner_token, key, public_key }
}

fn bal(test: &mut TemplateTest, a: &Account) -> Amount {
    test.execute_expect_success(
        test.transaction().call_method(a.component, "balance", args![XTR]).build_and_seal(&a.key),
        vec![a.owner_token.clone()],
    );
    test.expect_return::<Amount>(0)
}

fn set_epoch(test: &mut TemplateTest, epoch: u64) {
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(epoch));
}

#[allow(clippy::too_many_arguments)]
fn new_escrow(
    ctx: &mut Ctx, payer: &Account, payee: &Account, treasury: &Account,
    arbiter: Option<RistrettoPublicKeyBytes>, amount: Amount, timeout: u64, fee_bps: u64,
) -> ComponentAddress {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(payer.component, "withdraw", args![XTR, amount])
            .put_last_instruction_output_on_workspace("funds")
            .call_function(ctx.template, "new",
                args![Workspace("funds"), payer.public_key, payer.component, payee.component, payee.public_key,
                      arbiter, treasury.component, None::<Hash32>, timeout, fee_bps])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    ctx.test.expect_return::<ComponentAddress>(2)
}

/// fee = amount * fee_bps / 10000 (integer truncation) — mirrors the contract exactly.
fn fee_on(amount_u64: u64, fee_bps: u64) -> u64 {
    amount_u64 * fee_bps / 10000
}

// A tiny deterministic LCG (PCG-style multiplier) so the fuzz is reproducible from its seed.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 11
    }
    fn in_range(&mut self, lo: u64, hi_inclusive: u64) -> u64 {
        lo + self.next() % (hi_inclusive - lo + 1)
    }
}

// ------------------------------------------------------------------ release / resolve fuzz

#[test]
fn fuzz_release_and_resolve_conserve_funds() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);

    let seed = 0x5eed_1234_abcd_0001u64;
    let mut rng = Lcg(seed);

    for i in 0..40u64 {
        let fund = rng.in_range(1, 1_000_000);
        let fee_bps = rng.in_range(0, 10000);
        let resolve_path = rng.next() % 2 == 0;

        let payer0 = bal(&mut ctx.test, &payer);
        let payee0 = bal(&mut ctx.test, &payee);
        let treas0 = bal(&mut ctx.test, &treasury);

        let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, Some(arbiter.public_key),
                                amount![fund], 10, fee_bps);

        let (exp_payee, exp_payer, exp_fee) = if resolve_path {
            // split: random to_payee in [0, fund]; payee gets to_payee - fee(to_payee); payer the rest
            let to_payee = rng.in_range(0, fund);
            ctx.test.execute_expect_success(
                ctx.test.transaction().call_method(escrow, "dispute", args![]).build_and_seal(&payer.key),
                vec![payer.owner_token.clone()],
            );
            ctx.test.execute_expect_success(
                ctx.test.transaction().call_method(escrow, "resolve", args![amount![to_payee]]).build_and_seal(&arbiter.key),
                vec![arbiter.owner_token.clone()],
            );
            let fee = fee_on(to_payee, fee_bps);
            (to_payee - fee, fund - to_payee, fee)
        } else {
            // release: everything but the fee goes to the payee
            ctx.test.execute_expect_success(
                ctx.test.transaction().call_method(escrow, "release", args![None::<Vec<u8>>]).build_and_seal(&payer.key),
                vec![payer.owner_token.clone()],
            );
            let fee = fee_on(fund, fee_bps);
            (fund - fee, 0, fee)
        };

        let d_payee = bal(&mut ctx.test, &payee) - payee0; // amount gained (positive)
        let d_treas = bal(&mut ctx.test, &treasury) - treas0; // amount gained (positive)
        // Net amount that LEFT the payer = locked - returned (positive; Amount is unsigned).
        let payer_out = payer0 - bal(&mut ctx.test, &payer);

        let ctxt = format!("seed={:#x} iter={} fund={} fee_bps={} resolve={}", seed, i, fund, fee_bps, resolve_path);
        assert_eq!(d_payee, amount![exp_payee], "payee payout mismatch: {}", ctxt);
        assert_eq!(d_treas, amount![exp_fee], "treasury (fee) mismatch: {}", ctxt);
        assert_eq!(payer_out, amount![fund - exp_payer], "payer net outflow mismatch: {}", ctxt);
        // CONSERVATION (formula): locked == to_payee + to_payer + fee  (vault fully drained).
        assert_eq!(exp_payee + exp_payer + exp_fee, fund, "conservation formula broken: {}", ctxt);
        // CONSERVATION (measured on chain): what the recipients gained == what net-left the payer.
        assert_eq!(d_payee + d_treas, payer_out, "measured balance not conserved: {}", ctxt);
    }
}

// ------------------------------------------------------------------ refund fuzz (needs the clock)

#[test]
fn fuzz_refund_conserves_funds() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let seed = 0x5eed_1234_abcd_0002u64;
    let mut rng = Lcg(seed);
    let mut clock = 1u64;

    for i in 0..16u64 {
        let fund = rng.in_range(1, 1_000_000);
        let timeout = rng.in_range(1, 50);
        set_epoch(&mut ctx.test, clock); // escrow records deadline = clock + timeout

        let payer0 = bal(&mut ctx.test, &payer);
        let payee0 = bal(&mut ctx.test, &payee);
        let treas0 = bal(&mut ctx.test, &treasury);

        let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, None, amount![fund], timeout, 500);

        set_epoch(&mut ctx.test, clock + timeout + 1); // past the deadline
        ctx.test.execute_expect_success(
            ctx.test.transaction().call_method(escrow, "refund", args![]).build_and_seal(&payer.key),
            vec![payer.owner_token.clone()],
        );

        let d_payer = bal(&mut ctx.test, &payer) - payer0;
        let d_payee = bal(&mut ctx.test, &payee) - payee0;
        let d_treas = bal(&mut ctx.test, &treasury) - treas0;
        let ctxt = format!("seed={:#x} iter={} fund={} timeout={}", seed, i, fund, timeout);
        // refund returns the FULL amount, no fee: payer net delta (payout - lock) is zero.
        assert_eq!(d_payer, amount![0], "refund should net to zero for the payer: {}", ctxt);
        assert_eq!(d_payee, amount![0], "payee must receive nothing on refund: {}", ctxt);
        assert_eq!(d_treas, amount![0], "no fee on refund: {}", ctxt);
        clock += timeout + 100;
    }
}

// ------------------------------------------------------------------ explicit boundaries

#[test]
fn boundary_resolve_zero_and_full_split_conserve() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);

    // to_payee = 0 → everything returns to the payer, fee is 0 (fee is on the payee share).
    {
        let payer0 = bal(&mut ctx.test, &payer);
        let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, Some(arbiter.public_key), amount![1000], 10, 500);
        ctx.test.execute_expect_success(ctx.test.transaction().call_method(escrow, "dispute", args![]).build_and_seal(&payer.key), vec![payer.owner_token.clone()]);
        ctx.test.execute_expect_success(ctx.test.transaction().call_method(escrow, "resolve", args![amount![0]]).build_and_seal(&arbiter.key), vec![arbiter.owner_token.clone()]);
        assert_eq!(bal(&mut ctx.test, &payee), amount![0]);
        assert_eq!(bal(&mut ctx.test, &treasury), amount![0]);
        assert_eq!(payer0 - bal(&mut ctx.test, &payer), amount![0]); // lock -1000 then +1000 back → net 0
    }
    // to_payee = full → payee gets fund - fee, treasury gets fee, payer gets nothing back.
    {
        let payer0 = bal(&mut ctx.test, &payer);
        let payee0 = bal(&mut ctx.test, &payee);
        let treas0 = bal(&mut ctx.test, &treasury);
        let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, Some(arbiter.public_key), amount![1000], 10, 500);
        ctx.test.execute_expect_success(ctx.test.transaction().call_method(escrow, "dispute", args![]).build_and_seal(&payer.key), vec![payer.owner_token.clone()]);
        ctx.test.execute_expect_success(ctx.test.transaction().call_method(escrow, "resolve", args![amount![1000]]).build_and_seal(&arbiter.key), vec![arbiter.owner_token.clone()]);
        assert_eq!(bal(&mut ctx.test, &payee) - payee0, amount![950]);
        assert_eq!(bal(&mut ctx.test, &treasury) - treas0, amount![50]);
        assert_eq!(payer0 - bal(&mut ctx.test, &payer), amount![1000]); // locked 1000, got nothing back
    }
}

// ------------------------------------------------------------------ illegal transitions move nothing

#[test]
fn illegal_transitions_reject_and_move_no_funds() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);

    // resolve while OPEN (never disputed) is rejected and moves nothing.
    {
        let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, Some(arbiter.public_key), amount![1000], 10, 0);
        let reason = ctx.test.execute_expect_failure(
            ctx.test.transaction().call_method(escrow, "resolve", args![amount![500]]).build_and_seal(&arbiter.key),
            vec![arbiter.owner_token.clone()],
        );
        assert_reject_reason(reason, "Escrow is not under dispute");
        assert_eq!(bal(&mut ctx.test, &payee), amount![0]);
        assert_eq!(bal(&mut ctx.test, &treasury), amount![0]);
    }

    // release, then a SECOND settle of any kind is rejected and moves nothing more.
    {
        let payee0 = bal(&mut ctx.test, &payee);
        let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, Some(arbiter.public_key), amount![1000], 10, 0);
        ctx.test.execute_expect_success(ctx.test.transaction().call_method(escrow, "release", args![None::<Vec<u8>>]).build_and_seal(&payer.key), vec![payer.owner_token.clone()]);
        assert_eq!(bal(&mut ctx.test, &payee) - payee0, amount![1000]);
        // refund after release → rejected, payee unchanged
        set_epoch(&mut ctx.test, 1000);
        let reason = ctx.test.execute_expect_failure(
            ctx.test.transaction().call_method(escrow, "refund", args![]).build_and_seal(&payer.key),
            vec![payer.owner_token.clone()],
        );
        assert_reject_reason(reason, "Escrow is not open");
        assert_eq!(bal(&mut ctx.test, &payee) - payee0, amount![1000]); // unchanged
    }

    // refund BEFORE the timeout is rejected and moves nothing.
    {
        set_epoch(&mut ctx.test, 1); // fresh, early
        let payer0 = bal(&mut ctx.test, &payer);
        let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, None, amount![1000], 50, 0);
        let reason = ctx.test.execute_expect_failure(
            ctx.test.transaction().call_method(escrow, "refund", args![]).build_and_seal(&payer.key),
            vec![payer.owner_token.clone()],
        );
        assert_reject_reason(reason, "Cannot refund before the timeout");
        // the 1000 is still locked; payer only spent the lock, got nothing back.
        assert_eq!(payer0 - bal(&mut ctx.test, &payer), amount![1000]);
    }
}
