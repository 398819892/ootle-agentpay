//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! Integration tests for the `Escrow` template, run in the wasmer sandbox via
//! `tari_template_test_tooling`. Covers the happy paths and every failure path in the project's
//! Phase-1 checklist: normal release, wrong preimage, refund before/after timeout, non-arbiter
//! resolve, double release, and fee calculation (including a 0% rate and the 100% cap).

use sha2::{Digest, Sha256};

use tari_template_lib::prelude::*;
use tari_template_test_tooling::byte_type::ToByteType;
use tari_template_test_tooling::crypto::{PublicKey as _, RistrettoPublicKey, RistrettoSecretKey};
use tari_template_test_tooling::engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_template_test_tooling::support::assert_error::assert_reject_reason;
use tari_template_test_tooling::transaction::args;
use tari_template_test_tooling::TemplateTest;

// --------------------------------------------------------------------------------------------
// Test harness helpers
// --------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Account {
    component: ComponentAddress,
    owner_token: NonFungibleAddress,
    key: RistrettoSecretKey,
    public_key: RistrettoPublicKeyBytes,
}

struct Ctx {
    test: TemplateTest,
    escrow_template: TemplateAddress,
}

fn setup() -> Ctx {
    let mut test = TemplateTest::my_crate();
    let escrow_template = test.get_template_address("Escrow");
    Ctx {
        test,
        escrow_template,
    }
}

fn new_account(test: &mut TemplateTest) -> Account {
    let (component, owner_token, key) = test.create_funded_account();
    let public_key = RistrettoPublicKey::from_secret_key(&key).to_byte_type();
    Account {
        component,
        owner_token,
        key,
        public_key,
    }
}

fn tari_balance(test: &mut TemplateTest, account: &Account) -> Amount {
    test.execute_expect_success(
        test.transaction()
            .call_method(account.component, "balance", args![XTR])
            .build_and_seal(&account.key),
        vec![account.owner_token.clone()],
    );
    test.expect_return::<Amount>(0)
}

fn set_epoch(test: &mut TemplateTest, epoch: u64) {
    test.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(epoch),
    );
}

fn sha256(data: &[u8]) -> Hash32 {
    let digest = Sha256::digest(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    Hash32::from_array(out)
}

struct EscrowParams {
    fund: Amount,
    hashlock: Option<Hash32>,
    timeout: u64,
    fee_bps: u64,
    with_arbiter: bool,
}

impl Default for EscrowParams {
    fn default() -> Self {
        Self {
            fund: amount![1000],
            hashlock: None,
            timeout: 10,
            fee_bps: 500, // 5%
            with_arbiter: true,
        }
    }
}

/// Creates an escrow funded by `payer`, returning its component address.
fn create_escrow(
    ctx: &mut Ctx,
    payer: &Account,
    payee: &Account,
    arbiter: &Account,
    treasury: &Account,
    p: &EscrowParams,
) -> ComponentAddress {
    let arbiter_pk = if p.with_arbiter {
        Some(arbiter.public_key)
    } else {
        None
    };
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(payer.component, "withdraw", args![XTR, p.fund])
            .put_last_instruction_output_on_workspace("funds")
            .call_function(
                ctx.escrow_template,
                "new",
                args![
                    Workspace("funds"),
                    payer.public_key,
                    payer.component,
                    payee.component,
                    payee.public_key,
                    arbiter_pk,
                    treasury.component,
                    p.hashlock,
                    p.timeout,
                    p.fee_bps
                ],
            )
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    // instructions: 0 = withdraw, 1 = put_last_instruction_output_on_workspace, 2 = new
    ctx.test.expect_return::<ComponentAddress>(2)
}

// --------------------------------------------------------------------------------------------
// Happy paths
// --------------------------------------------------------------------------------------------

#[test]
fn release_pays_payee_minus_fee() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &EscrowParams::default());

    let payee_before = tari_balance(&mut ctx.test, &payee);
    let treasury_before = tari_balance(&mut ctx.test, &treasury);

    // payer releases
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(escrow, "release", args![None::<Vec<u8>>])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );

    // 1000 funds, 5% fee => payee +950, treasury +50
    assert_eq!(tari_balance(&mut ctx.test, &payee), payee_before + amount![950]);
    assert_eq!(tari_balance(&mut ctx.test, &treasury), treasury_before + amount![50]);
}

#[test]
fn release_by_preimage_holder() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    let preimage = b"super secret".to_vec();
    let params = EscrowParams {
        hashlock: Some(sha256(&preimage)),
        fee_bps: 0,
        ..Default::default()
    };
    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &params);

    let payee_before = tari_balance(&mut ctx.test, &payee);

    // the payee (not the payer) releases by presenting the correct preimage
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(escrow, "release", args![Some(preimage.clone())])
            .build_and_seal(&payee.key),
        vec![payee.owner_token.clone()],
    );

    // fee is 0, so payee receives the full 1000
    assert_eq!(tari_balance(&mut ctx.test, &payee), payee_before + amount![1000]);
}

#[test]
fn refund_after_timeout_succeeds() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &EscrowParams::default());

    let payer_before = tari_balance(&mut ctx.test, &payer);

    // advance past the deadline (timeout 10 => deadline is epoch 10)
    set_epoch(&mut ctx.test, 11);

    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(escrow, "refund", args![])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );

    // refund returns the full amount, no fee
    assert_eq!(tari_balance(&mut ctx.test, &payer), payer_before + amount![1000]);
}

#[test]
fn dispute_then_resolve_splits_with_fee() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &EscrowParams::default());

    // payee raises a dispute
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(escrow, "dispute", args![])
            .build_and_seal(&payee.key),
        vec![payee.owner_token.clone()],
    );

    let payee_before = tari_balance(&mut ctx.test, &payee);
    let payer_before = tari_balance(&mut ctx.test, &payer);
    let treasury_before = tari_balance(&mut ctx.test, &treasury);

    // arbiter awards 600 to the payee (5% fee on that = 30)
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(escrow, "resolve", args![amount![600]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );

    assert_eq!(tari_balance(&mut ctx.test, &payee), payee_before + amount![570]);
    assert_eq!(tari_balance(&mut ctx.test, &payer), payer_before + amount![400]);
    assert_eq!(tari_balance(&mut ctx.test, &treasury), treasury_before + amount![30]);
}

#[test]
fn zero_fee_pays_full_amount() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    let params = EscrowParams { fee_bps: 0, ..Default::default() };
    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &params);

    let payee_before = tari_balance(&mut ctx.test, &payee);
    let treasury_before = tari_balance(&mut ctx.test, &treasury);

    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(escrow, "release", args![None::<Vec<u8>>])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );

    assert_eq!(tari_balance(&mut ctx.test, &payee), payee_before + amount![1000]);
    assert_eq!(tari_balance(&mut ctx.test, &treasury), treasury_before);
}

// --------------------------------------------------------------------------------------------
// Failure paths
// --------------------------------------------------------------------------------------------

#[test]
fn release_with_wrong_preimage_fails() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);
    let stranger = new_account(&mut ctx.test);

    let params = EscrowParams {
        hashlock: Some(sha256(b"the real secret")),
        ..Default::default()
    };
    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &params);

    // a stranger tries to release with the wrong preimage
    let reason = ctx.test.execute_expect_failure(
        ctx.test
            .transaction()
            .call_method(escrow, "release", args![Some(b"wrong guess".to_vec())])
            .build_and_seal(&stranger.key),
        vec![stranger.owner_token.clone()],
    );
    assert_reject_reason(reason, "Unauthorized: release requires the payer or a valid preimage");
}

#[test]
fn refund_before_timeout_fails() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &EscrowParams::default());

    // current epoch is 0, deadline is 10 => too early
    let reason = ctx.test.execute_expect_failure(
        ctx.test
            .transaction()
            .call_method(escrow, "refund", args![])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    assert_reject_reason(reason, "Cannot refund before the timeout");
}

/// After the timeout, refund is callable by ANYONE (not just the payer) and the funds always go to
/// the fixed `payer_account`. This is the key-loss recovery property: a third party can trigger the
/// return even if the payer's key is gone, and a stranger cannot redirect the funds to themselves.
/// (Was previously payer-only — a confirmed custody bug; see `docs/audit-notes.md`.)
#[test]
fn refund_after_timeout_is_callable_by_anyone_and_pays_the_payer() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);
    let stranger = new_account(&mut ctx.test);

    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &EscrowParams::default());
    set_epoch(&mut ctx.test, 11);

    let payer_before = tari_balance(&mut ctx.test, &payer);
    let stranger_before = tari_balance(&mut ctx.test, &stranger);

    // a stranger (not the payer) triggers the refund after the timeout
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(escrow, "refund", args![])
            .build_and_seal(&stranger.key),
        vec![stranger.owner_token.clone()],
    );

    // the full 1000 lands in the payer's account; the caller gets nothing extra (minus their own fees)
    assert_eq!(tari_balance(&mut ctx.test, &payer), payer_before + amount![1000]);
    assert!(tari_balance(&mut ctx.test, &stranger) <= stranger_before); // no diversion to the caller
}

#[test]
fn non_arbiter_resolve_fails() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &EscrowParams::default());

    // dispute first so the escrow is in Disputed state
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(escrow, "dispute", args![])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );

    // the payer (not the arbiter) tries to resolve
    let reason = ctx.test.execute_expect_failure(
        ctx.test
            .transaction()
            .call_method(escrow, "resolve", args![amount![500]])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    assert_reject_reason(reason, "Unauthorized: only the arbiter may resolve");
}

#[test]
fn double_release_fails() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &EscrowParams::default());

    // first release succeeds
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(escrow, "release", args![None::<Vec<u8>>])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );

    // second release fails because the escrow is no longer Open
    let reason = ctx.test.execute_expect_failure(
        ctx.test
            .transaction()
            .call_method(escrow, "release", args![None::<Vec<u8>>])
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    assert_reject_reason(reason, "Escrow is not open");
}

#[test]
fn dispute_by_stranger_fails() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);
    let stranger = new_account(&mut ctx.test);

    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &EscrowParams::default());

    let reason = ctx.test.execute_expect_failure(
        ctx.test
            .transaction()
            .call_method(escrow, "dispute", args![])
            .build_and_seal(&stranger.key),
        vec![stranger.owner_token.clone()],
    );
    assert_reject_reason(reason, "Unauthorized: only the payer or payee may dispute");
}

#[test]
fn fee_above_cap_is_rejected() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    // fee_bps 10001 > 10000 cap
    let reason = ctx.test.execute_expect_failure(
        ctx.test
            .transaction()
            .call_method(payer.component, "withdraw", args![XTR, amount![1000]])
            .put_last_instruction_output_on_workspace("funds")
            .call_function(
                ctx.escrow_template,
                "new",
                args![
                    Workspace("funds"),
                    payer.public_key,
                    payer.component,
                    payee.component,
                    payee.public_key,
                    Some(arbiter.public_key),
                    treasury.component,
                    None::<Hash32>,
                    10u64,
                    10001u64
                ],
            )
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    assert_reject_reason(reason, "Fee basis points cannot exceed 10000");
}

#[test]
fn zero_funds_is_rejected() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    let reason = ctx.test.execute_expect_failure(
        ctx.test
            .transaction()
            .call_method(payer.component, "withdraw", args![XTR, amount![0]])
            .put_last_instruction_output_on_workspace("funds")
            .call_function(
                ctx.escrow_template,
                "new",
                args![
                    Workspace("funds"),
                    payer.public_key,
                    payer.component,
                    payee.component,
                    payee.public_key,
                    Some(arbiter.public_key),
                    treasury.component,
                    None::<Hash32>,
                    10u64,
                    500u64
                ],
            )
            .build_and_seal(&payer.key),
        vec![payer.owner_token.clone()],
    );
    assert_reject_reason(reason, "Escrow must be funded");
}

/// `get_parties` lets a payee verify, before relying on the escrow, that their own key/account are
/// the recorded `payee` (the dispute identity) and `payee_account` (the release/resolve target).
#[test]
fn get_parties_exposes_recorded_identities() {
    let mut ctx = setup();
    let payer = new_account(&mut ctx.test);
    let payee = new_account(&mut ctx.test);
    let arbiter = new_account(&mut ctx.test);
    let treasury = new_account(&mut ctx.test);

    let escrow = create_escrow(&mut ctx, &payer, &payee, &arbiter, &treasury, &EscrowParams::default());

    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(escrow, "get_parties", args![]).build_and_seal(&payee.key),
        vec![payee.owner_token.clone()],
    );
    let (r_payer, r_payee, r_arbiter, r_payee_acct, r_payer_acct) = ctx
        .test
        .expect_return::<(
            RistrettoPublicKeyBytes,
            RistrettoPublicKeyBytes,
            Option<RistrettoPublicKeyBytes>,
            ComponentAddress,
            ComponentAddress,
        )>(0);
    assert_eq!(r_payer, payer.public_key);
    assert_eq!(r_payee, payee.public_key);
    assert_eq!(r_arbiter, Some(arbiter.public_key));
    assert_eq!(r_payee_acct, payee.component);
    assert_eq!(r_payer_acct, payer.component);
}
