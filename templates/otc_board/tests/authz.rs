//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! Authorization / state-machine hardening tests for OtcBoard (audit pass).
//!
//! For every state-changing settlement function, an *unauthorized* caller (or an illegal state
//! transition) must be **rejected AND move no funds AND not advance the listing**. "Not advanced" is
//! proved positively: after the rejected call, the *legal* next step from the original state still
//! succeeds with the expected payout — a stronger guarantee than reading an opaque state enum, and it
//! pins "越权不能推进状态" directly. Also pins the L3 liveness note from `docs/audit-notes.md`
//! (slash-an-arbiter-mid-dispute is recoverable, funds are not frozen).

use sha2::{Digest, Sha256};

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
    let template = test.get_template_address("OtcBoard");
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
fn sha256(d: &[u8]) -> Hash32 {
    let mut o = [0u8; 32];
    o.copy_from_slice(&Sha256::digest(d));
    Hash32::from_array(o)
}

struct Board {
    component: ComponentAddress,
    owner_badge: ResourceAddress,
}

fn new_board(ctx: &mut Ctx, owner: &Account, treasury: &Account, arbiter: &Account,
             bond: Amount, max_amount: Amount, fee_bps: u64) -> Board {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_function(ctx.template, "new",
                args![treasury.component, bond, max_amount, fee_bps, vec![arbiter.public_key]])
            .put_last_instruction_output_on_workspace("ret")
            .call_method(owner.component, "deposit", args![Workspace("ret.1")])
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    let component = ctx.test.expect_return::<(ComponentAddress, Bucket)>(0).0;
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(component, "get_owner_badge", args![]).build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    let owner_badge = ctx.test.expect_return::<ResourceAddress>(0);
    Board { component, owner_badge }
}

fn list(ctx: &mut Ctx, board: &Board, seller: &Account, arbiter: &Account,
        amount: Amount, bond_amt: Amount, timeout: u64) -> u64 {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(seller.component, "withdraw", args![XTR, amount])
            .put_last_instruction_output_on_workspace("asset")
            .call_method(seller.component, "withdraw", args![XTR, bond_amt])
            .put_last_instruction_output_on_workspace("bond")
            .call_method(board.component, "list",
                args![Workspace("asset"), Workspace("bond"), seller.component,
                      sha256(b"terms"), arbiter.public_key, timeout])
            .build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );
    ctx.test.expect_return::<u64>(4)
}

fn take(ctx: &mut Ctx, board: &Board, buyer: &Account, id: u64) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "take", args![id, buyer.component, buyer.public_key, None::<Hash32>])
            .build_and_seal(&buyer.key),
        vec![buyer.owner_token.clone()],
    );
}

fn simple_ok(ctx: &mut Ctx, board: &Board, who: &Account, method: &str, id: u64) {
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(board.component, method, args![id]).build_and_seal(&who.key),
        vec![who.owner_token.clone()],
    );
}

fn simple_fail(ctx: &mut Ctx, board: &Board, who: &Account, method: &str, id: u64)
    -> tari_template_test_tooling::engine_types::commit_result::RejectReason {
    ctx.test.execute_expect_failure(
        ctx.test.transaction().call_method(board.component, method, args![id]).build_and_seal(&who.key),
        vec![who.owner_token.clone()],
    )
}

fn confirm_ok(ctx: &mut Ctx, board: &Board, who: &Account, id: u64) {
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(board.component, "confirm", args![id, None::<Vec<u8>>]).build_and_seal(&who.key),
        vec![who.owner_token.clone()],
    );
}

fn set_arbiter_stake(ctx: &mut Ctx, board: &Board, owner: &Account, stake: Amount) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, board.owner_badge)
            .put_last_instruction_output_on_workspace("p")
            .call_method(board.component, "set_arbiter_stake", args![stake])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
}

fn stake_arbiter(ctx: &mut Ctx, board: &Board, arbiter: &Account, stake: Amount) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(arbiter.component, "withdraw", args![XTR, stake])
            .put_last_instruction_output_on_workspace("stake")
            .call_method(board.component, "stake_arbiter", args![Workspace("stake")])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
}

fn slash(ctx: &mut Ctx, board: &Board, owner: &Account, arbiter: &Account) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, board.owner_badge)
            .put_last_instruction_output_on_workspace("p")
            .call_method(board.component, "slash_arbiter", args![arbiter.public_key])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
}

// ---------------------------------------------------------------------------------------------

/// A stranger cannot cancel another seller's open listing; nothing moves and the real seller can
/// still cancel afterwards (proving the listing stayed Open).
#[test]
fn non_seller_cannot_cancel_and_nothing_moves() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let stranger = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let before = bal(&mut ctx.test, &seller);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    let locked = bal(&mut ctx.test, &seller);
    assert_eq!(locked, before - amount![1100]);

    let reason = simple_fail(&mut ctx, &board, &stranger, "cancel", id);
    assert_reject_reason(reason, "Only the seller may cancel");
    assert_eq!(bal(&mut ctx.test, &seller), locked); // nothing returned to anyone

    // listing is still Open: the real seller can cancel and get the full asset + bond back
    simple_ok(&mut ctx, &board, &seller, "cancel", id);
    assert_eq!(bal(&mut ctx.test, &seller), before);
}

/// A stranger cannot reclaim after timeout; funds stay locked and the real seller can still reclaim.
#[test]
fn non_seller_cannot_reclaim_and_nothing_moves() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);
    let stranger = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let before = bal(&mut ctx.test, &seller);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);
    set_epoch(&mut ctx.test, 11);

    let locked = bal(&mut ctx.test, &seller);
    let reason = simple_fail(&mut ctx, &board, &stranger, "reclaim", id);
    assert_reject_reason(reason, "Only the seller may reclaim");
    assert_eq!(bal(&mut ctx.test, &seller), locked); // nothing moved

    simple_ok(&mut ctx, &board, &seller, "reclaim", id);
    assert_eq!(bal(&mut ctx.test, &seller), before); // asset + bond back
}

/// A third party (neither seller nor buyer) cannot open a dispute; the listing stays Taken, so the
/// seller can still confirm and the buyer is paid.
#[test]
fn stranger_cannot_dispute_then_seller_can_still_confirm() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);
    let stranger = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 0);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);

    let reason = simple_fail(&mut ctx, &board, &stranger, "open_dispute", id);
    assert_reject_reason(reason, "Only the seller or buyer may dispute");

    // still Taken (not Disputed): seller confirms and the buyer gets the asset
    let buyer_before = bal(&mut ctx.test, &buyer);
    confirm_ok(&mut ctx, &board, &seller, id);
    assert_eq!(bal(&mut ctx.test, &buyer), buyer_before + amount![1000]);
}

/// `resolve` on a listing that is merely Taken (never disputed) is rejected; the listing stays Taken.
#[test]
fn resolve_on_non_disputed_listing_is_rejected() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 0);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);

    let buyer_before = bal(&mut ctx.test, &buyer);
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "resolve", args![id, amount![500]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    assert_reject_reason(reason, "Listing is not under dispute");
    assert_eq!(bal(&mut ctx.test, &buyer), buyer_before); // nothing moved

    // still Taken: seller confirm pays the buyer in full (0 fee)
    confirm_ok(&mut ctx, &board, &seller, id);
    assert_eq!(bal(&mut ctx.test, &buyer), buyer_before + amount![1000]);
}

/// A dispute can be resolved exactly once; a second resolve is rejected and pays nothing extra.
#[test]
fn resolve_twice_rejected() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 0);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);
    simple_ok(&mut ctx, &board, &buyer, "open_dispute", id);

    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "resolve", args![id, amount![600]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    let buyer_after_first = bal(&mut ctx.test, &buyer);

    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "resolve", args![id, amount![1000]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    assert_reject_reason(reason, "Listing is not under dispute");
    assert_eq!(bal(&mut ctx.test, &buyer), buyer_after_first); // no second payout
}

/// Taking an already-taken listing is rejected; the first buyer remains the recorded buyer and is the
/// one paid on confirm.
#[test]
fn double_take_rejected_first_buyer_is_paid() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer1 = empty(&mut ctx.test);
    let buyer2 = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 0);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer1, id);

    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "take", args![id, buyer2.component, buyer2.public_key, None::<Hash32>])
            .build_and_seal(&buyer2.key),
        vec![buyer2.owner_token.clone()],
    );
    assert_reject_reason(reason, "Listing is not open");

    let b1 = bal(&mut ctx.test, &buyer1);
    let b2 = bal(&mut ctx.test, &buyer2);
    confirm_ok(&mut ctx, &board, &seller, id);
    assert_eq!(bal(&mut ctx.test, &buyer1), b1 + amount![1000]); // first buyer gets the asset
    assert_eq!(bal(&mut ctx.test, &buyer2), b2); // the would-be taker gets nothing
}

/// Once taken, the seller can no longer cancel; the listing is only settleable via confirm/reclaim/
/// dispute, so cancel must be rejected and the funds stay put.
#[test]
fn cancel_after_taken_is_rejected() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 0);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);

    let reason = simple_fail(&mut ctx, &board, &seller, "cancel", id);
    assert_reject_reason(reason, "Listing is not open");

    // still Taken: confirm still works
    let buyer_before = bal(&mut ctx.test, &buyer);
    confirm_ok(&mut ctx, &board, &seller, id);
    assert_eq!(bal(&mut ctx.test, &buyer), buyer_before + amount![1000]);
}

/// L3 (docs/audit-notes.md): slashing the listing's arbiter mid-dispute blocks `resolve` while a
/// stake is required, but the funds are NOT frozen — lowering the stake requirement (owner action)
/// lets the dispute be resolved and the asset distributed. Proves the "no permanent freeze" claim.
#[test]
fn slashed_arbiter_mid_dispute_can_resolve_after_stake_requirement_lowered() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 0);
    set_arbiter_stake(&mut ctx, &board, &owner, amount![500]);
    stake_arbiter(&mut ctx, &board, &arbiter, amount![500]);

    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);
    simple_ok(&mut ctx, &board, &buyer, "open_dispute", id);

    // owner slashes the arbiter mid-dispute -> their stake drops to 0
    slash(&mut ctx, &board, &owner, &arbiter);

    // with a stake still required, resolve is now blocked (the L3 symptom)
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "resolve", args![id, amount![600]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    assert_reject_reason(reason, "Arbiter has not staked enough to resolve");

    // RECOVERY: owner lowers the stake bar to 0 and the dispute resolves -> funds are not frozen
    set_arbiter_stake(&mut ctx, &board, &owner, amount![0]);
    let buyer_before = bal(&mut ctx.test, &buyer);
    let seller_before = bal(&mut ctx.test, &seller);
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "resolve", args![id, amount![600]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    // fee_bps 0 -> buyer +600, seller +400 asset + 100 bond
    assert_eq!(bal(&mut ctx.test, &buyer), buyer_before + amount![600]);
    assert_eq!(bal(&mut ctx.test, &seller), seller_before + amount![400] + amount![100]);
}
