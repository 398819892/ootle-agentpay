//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! Authorization / state-machine gap tests for Escrow (audit pass): a stranger cannot `release` when
//! no hashlock is configured, and `resolve` is rejected unless the escrow is actually Disputed. Each
//! asserts the rejected call moves no funds and leaves the escrow in its original (Open) state, proved
//! by the legal next step still succeeding.

use tari_template_lib::prelude::*;
use tari_template_test_tooling::byte_type::ToByteType;
use tari_template_test_tooling::crypto::{PublicKey as _, RistrettoPublicKey, RistrettoSecretKey};
use tari_template_test_tooling::engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
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

fn set_epoch(test: &mut TemplateTest, e: u64) {
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(e));
}

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
    ctx.test.expect_return::<ComponentAddress>(2)
}

// --------------------------------------------------------------------------------------------

/// With no hashlock set, only the payer may release; a stranger presenting no/any preimage is rejected
/// and no funds move. The payer can then still release (escrow stayed Open).
#[test]
fn release_by_stranger_without_hashlock_is_rejected() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let stranger = funded(&mut ctx.test);

    let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, None, amount![1000], 0);

    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(escrow, "release", args![None::<Vec<u8>>])
            .build_and_seal(&stranger.key),
        vec![stranger.owner_token.clone()],
    );
    assert_reject_reason(reason, "Unauthorized: release requires the payer or a valid preimage");
    assert_eq!(bal(&mut ctx.test, &payee), amount![0]); // nothing released

    // escrow is still Open: the payer can release
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(escrow, "release", args![None::<Vec<u8>>])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    assert_eq!(bal(&mut ctx.test, &payee), amount![1000]);
}

/// `resolve` is only valid in the Disputed state; calling it on an Open escrow (even by the real
/// arbiter) is rejected and moves nothing. After a proper dispute the arbiter can resolve.
#[test]
fn resolve_on_non_disputed_escrow_is_rejected() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test);

    let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, Some(arbiter.public_key), amount![1000], 0);

    let payee_before = bal(&mut ctx.test, &payee);
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(escrow, "resolve", args![amount![500]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    assert_reject_reason(reason, "Escrow is not under dispute");
    assert_eq!(bal(&mut ctx.test, &payee), payee_before); // nothing moved

    // dispute, then the arbiter can resolve
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(escrow, "dispute", args![]).build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(escrow, "resolve", args![amount![1000]]).build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    assert_eq!(bal(&mut ctx.test, &payee), payee_before + amount![1000]);
}

// =============================================================================================
// #3 Dispute-freeze regressions (independent audit pass). See `docs/audit-notes.md` §Fund-safety.
// =============================================================================================

/// An escrow with NO arbiter cannot be disputed — otherwise a dispute would move it to a state only
/// an (absent) arbiter could leave, freezing the funds. Rejecting the dispute keeps the escrow on its
/// release / refund paths. This is the exact shape of a `pay_via_escrow` escrow opened with
/// `escrow_arbiter = None`, so that route can never be frozen.
#[test]
fn dispute_without_arbiter_is_rejected_and_escrow_stays_recoverable() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, None, amount![1000], 0);

    // dispute is rejected: there is no arbiter who could ever resolve it
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction().call_method(escrow, "dispute", args![]).build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    assert_reject_reason(reason, "Cannot dispute an escrow with no arbiter");

    // the escrow is untouched (still Open): after the timeout the funds refund to the payer, never frozen
    set_epoch(&mut ctx.test, 11); // new_escrow uses timeout 10 => deadline epoch 10
    let payer_before = bal(&mut ctx.test, &payer);
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(escrow, "refund", args![]).build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    assert_eq!(bal(&mut ctx.test, &payer), payer_before + amount![1000]);
}

/// A dispute is raised but the arbiter never resolves. Once the dispute deadline passes, ANYONE may
/// refund the funds to the payer — the disputed escrow is never frozen forever. Before the deadline
/// the force-refund is rejected and nothing moves.
#[test]
fn stalled_dispute_refunds_payer_after_deadline() {
    let mut ctx = setup();
    let payer = funded(&mut ctx.test);
    let payee = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test); // configured, but goes dark
    let anyone = funded(&mut ctx.test);

    // created at epoch 0 with timeout 10 (new_escrow default)
    let escrow = new_escrow(&mut ctx, &payer, &payee, &treasury, Some(arbiter.public_key), amount![1000], 0);

    // dispute at epoch 0 => dispute_deadline = 0 + 10 = 10
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(escrow, "dispute", args![]).build_and_seal(&payee.key),
        vec![payee.owner_token.clone()],
    );

    // before the dispute deadline, a force-refund is rejected and nothing moves
    set_epoch(&mut ctx.test, 9);
    let payer_mid = bal(&mut ctx.test, &payer);
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction().call_method(escrow, "refund", args![]).build_and_seal(&anyone.key),
        vec![anyone.owner_token.clone()],
    );
    assert_reject_reason(reason, "Cannot force-close before the dispute deadline");
    assert_eq!(bal(&mut ctx.test, &payer), payer_mid); // still locked

    // after the deadline, anyone force-refunds the payer; funds are not frozen
    set_epoch(&mut ctx.test, 10);
    let payer_before = bal(&mut ctx.test, &payer);
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(escrow, "refund", args![]).build_and_seal(&anyone.key),
        vec![anyone.owner_token.clone()],
    );
    assert_eq!(bal(&mut ctx.test, &payer), payer_before + amount![1000]);
    assert_eq!(bal(&mut ctx.test, &payee), amount![0]); // payee got nothing
}
