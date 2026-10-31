//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! Adversarial / boundary tests for the Escrow template (reviewer feedback #6 fund safety, #8 edge
//! cases): double release (no double-spend), resolving more than is locked, a 100% fee, and
//! fee truncation on a tiny amount.

use tari_template_lib::prelude::*;
use tari_template_test_tooling::byte_type::ToByteType;
use tari_template_test_tooling::crypto::{PublicKey as _, RistrettoPublicKey, RistrettoSecretKey};
use tari_template_test_tooling::support::assert_error::assert_reject_reason;
use tari_template_test_tooling::transaction::args;
use tari_template_test_tooling::TemplateTest;

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

/// Payer opens an escrow for `amount` with the given arbiter / fee; returns its address.
#[allow(clippy::too_many_arguments)]
fn new_escrow(ctx: &mut Ctx, payer: &Account, payee: &Account, treasury: &Account,
              arbiter: Option<RistrettoPublicKeyBytes>, amount: Amount, fee_bps: u64) -> ComponentAddress {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(payer.component, "withdraw", args![XTR, amount])
            .put_last_instruction_output_on_workspace("funds")
            .call_function(ctx.template, "new",
                args![Workspace("funds"), payer.public_key, payer.component, payee.component, payee.public_key,
                      arbiter, treasury.component, None::<Hash32>, 10u64, fee_bps])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    // instructions: 0 withdraw, 1 put, 2 new -> Component
    ctx.test.expect_return::<ComponentAddress>(2)
}

fn release(ctx: &mut Ctx, escrow: ComponentAddress, payer: &Account) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(escrow, "release", args![None::<Vec<u8>>])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
}

// --------------------------------------------------------------------------------------------

#[test]
fn edge_release_twice_does_not_double_spend() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, None, amount![1000], 0);
    release(&mut ctx, escrow, &payer);
    assert_eq!(bal(&mut ctx.test, &payee), amount![1000]);

    // a second release must fail — the funds are already gone
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(escrow, "release", args![None::<Vec<u8>>])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    assert_reject_reason(reason, "Escrow is not open");
    assert_eq!(bal(&mut ctx.test, &payee), amount![1000]); // unchanged
}

#[test]
fn edge_resolve_more_than_locked_is_rejected() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);

    let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, Some(arbiter.public_key), amount![1000], 0);
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(escrow, "dispute", args![]).build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(escrow, "resolve", args![amount![2000]]) // more than the 1000 locked
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    assert_reject_reason(reason, "Payee amount exceeds the escrow balance");
}

#[test]
fn edge_full_fee_sends_everything_to_treasury() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, None, amount![1000], 10000); // 100%
    release(&mut ctx, escrow, &payer);
    assert_eq!(bal(&mut ctx.test, &payee), amount![0]);
    assert_eq!(bal(&mut ctx.test, &treasury), amount![1000]);
}

#[test]
fn edge_tiny_amount_fee_truncates_to_zero() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    // 5% of 1 truncates to 0 — the payee gets the whole unit, treasury gets nothing.
    let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, None, amount![1], 500);
    release(&mut ctx, escrow, &payer);
    assert_eq!(bal(&mut ctx.test, &payee), amount![1]);
    assert_eq!(bal(&mut ctx.test, &treasury), amount![0]);
}
