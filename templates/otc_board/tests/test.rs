//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! Integration tests for the OtcBoard template: the OTC flow (list → take → confirm / reclaim /
//! dispute→resolve), plus the anti-abuse checks (listing bond, max listing amount, arbiter
//! whitelist) and owner-only methods.

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
                args![treasury.component, bond, max_amount, fee_bps, vec![arbiter.public_key],
                      Vec::<ResourceAddress>::new()])
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

/// Seller lists `amount` of XTR with `bond_amt` bond and an optional seller-set payment `hashlock`;
/// returns the listing id.
fn list_locked(ctx: &mut Ctx, board: &Board, seller: &Account, arbiter: &Account,
        amount: Amount, bond_amt: Amount, timeout: u64, hashlock: Option<Hash32>) -> u64 {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(seller.component, "withdraw", args![XTR, amount])
            .put_last_instruction_output_on_workspace("asset")
            .call_method(seller.component, "withdraw", args![XTR, bond_amt])
            .put_last_instruction_output_on_workspace("bond")
            .call_method(board.component, "list",
                args![Workspace("asset"), Workspace("bond"), seller.component,
                      sha256(b"terms"), arbiter.public_key, timeout, hashlock])
            .build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );
    // instructions: 0 withdraw, 1 put, 2 withdraw, 3 put, 4 list -> u64
    ctx.test.expect_return::<u64>(4)
}

/// Seller lists with no payment hashlock (settlement via seller `confirm`).
fn list(ctx: &mut Ctx, board: &Board, seller: &Account, arbiter: &Account,
        amount: Amount, bond_amt: Amount, timeout: u64) -> u64 {
    list_locked(ctx, board, seller, arbiter, amount, bond_amt, timeout, None)
}

fn take(ctx: &mut Ctx, board: &Board, buyer: &Account, id: u64) {
    // A real buyer reads the listing's arbiter and confirms it in `take` (the method now requires it).
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(board.component, "get_arbiter", args![id]).build_and_seal(&buyer.key),
        vec![buyer.owner_token.clone()],
    );
    let arbiter = ctx.test.expect_return::<RistrettoPublicKeyBytes>(0);
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "take", args![id, buyer.component, buyer.public_key, arbiter])
            .build_and_seal(&buyer.key),
        vec![buyer.owner_token.clone()],
    );
}

fn simple(ctx: &mut Ctx, board: &Board, who: &Account, method: &str, id: u64) {
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(board.component, method, args![id]).build_and_seal(&who.key),
        vec![who.owner_token.clone()],
    );
}

// --------------------------------------------------------------------------------------------

#[test]
fn list_take_confirm_pays_buyer_minus_fee() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);

    take(&mut ctx, &board, &buyer, id);

    let buyer_before = bal(&mut ctx.test, &buyer);
    let treasury_before = bal(&mut ctx.test, &treasury);
    let seller_before = bal(&mut ctx.test, &seller);

    // seller confirms payment received -> asset released to buyer minus 5% fee, bond back to seller
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "confirm", args![id, None::<Vec<u8>>])
            .build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );

    assert_eq!(bal(&mut ctx.test, &buyer), buyer_before + amount![950]);
    assert_eq!(bal(&mut ctx.test, &treasury), treasury_before + amount![50]);
    assert_eq!(bal(&mut ctx.test, &seller), seller_before + amount![100]); // bond returned
}

#[test]
fn confirm_by_preimage_holder() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 0);
    let preimage = b"paid-in-full".to_vec();
    // the SELLER sets the payment hashlock at list time and reveals the preimage to the buyer once paid
    let id = list_locked(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10, Some(sha256(&preimage)));
    take(&mut ctx, &board, &buyer, id);

    let buyer_before = bal(&mut ctx.test, &buyer);
    // the buyer releases by presenting the payment preimage
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "confirm", args![id, Some(preimage.clone())])
            .build_and_seal(&buyer.key),
        vec![buyer.owner_token.clone()],
    );
    assert_eq!(bal(&mut ctx.test, &buyer), buyer_before + amount![1000]); // 0 fee
}

#[test]
fn confirm_wrong_preimage_by_stranger_fails() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);
    let stranger = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let id = list_locked(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10, Some(sha256(b"the secret")));
    take(&mut ctx, &board, &buyer, id);

    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "confirm", args![id, Some(b"wrong".to_vec())])
            .build_and_seal(&stranger.key),
        vec![stranger.owner_token.clone()],
    );
    assert_reject_reason(reason, "Unauthorized: confirm requires the seller or a valid payment preimage");
}

#[test]
fn seller_cancels_open_listing() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let before = bal(&mut ctx.test, &seller);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    assert_eq!(bal(&mut ctx.test, &seller), before - amount![1100]); // asset + bond locked
    simple(&mut ctx, &board, &seller, "cancel", id);
    assert_eq!(bal(&mut ctx.test, &seller), before); // fully returned
}

#[test]
fn reclaim_after_timeout_returns_to_seller() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let before = bal(&mut ctx.test, &seller);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);

    // too early
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction().call_method(board.component, "reclaim", args![id]).build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );
    assert_reject_reason(reason, "Cannot reclaim before the timeout");

    set_epoch(&mut ctx.test, 11);
    simple(&mut ctx, &board, &seller, "reclaim", id);
    assert_eq!(bal(&mut ctx.test, &seller), before); // asset + bond back
}

#[test]
fn dispute_then_arbiter_resolves_split() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);
    simple(&mut ctx, &board, &buyer, "open_dispute", id);

    let buyer_before = bal(&mut ctx.test, &buyer);
    let seller_before = bal(&mut ctx.test, &seller);
    let treasury_before = bal(&mut ctx.test, &treasury);

    // arbiter awards 600 to buyer (5% fee on that = 30), 400 to seller
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "resolve", args![id, amount![600]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    assert_eq!(bal(&mut ctx.test, &buyer), buyer_before + amount![570]);
    assert_eq!(bal(&mut ctx.test, &seller), seller_before + amount![400] + amount![100]); // + bond
    assert_eq!(bal(&mut ctx.test, &treasury), treasury_before + amount![30]);
}

#[test]
fn non_arbiter_resolve_fails() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);
    simple(&mut ctx, &board, &seller, "open_dispute", id);

    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "resolve", args![id, amount![500]])
            .build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );
    assert_reject_reason(reason, "Only the listing's arbiter may resolve");
}

#[test]
fn listing_over_cap_is_rejected() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![500], 500);
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(seller.component, "withdraw", args![XTR, amount![1000]])
            .put_last_instruction_output_on_workspace("asset")
            .call_method(seller.component, "withdraw", args![XTR, amount![100]])
            .put_last_instruction_output_on_workspace("bond")
            .call_method(board.component, "list",
                args![Workspace("asset"), Workspace("bond"), seller.component,
                      sha256(b"t"), arbiter.public_key, 10u64, None::<Hash32>])
            .build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );
    assert_reject_reason(reason, "Asset exceeds the max listing amount");
}

#[test]
fn listing_bond_too_low_is_rejected() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(seller.component, "withdraw", args![XTR, amount![1000]])
            .put_last_instruction_output_on_workspace("asset")
            .call_method(seller.component, "withdraw", args![XTR, amount![10]]) // bond 10 < 100
            .put_last_instruction_output_on_workspace("bond")
            .call_method(board.component, "list",
                args![Workspace("asset"), Workspace("bond"), seller.component,
                      sha256(b"t"), arbiter.public_key, 10u64, None::<Hash32>])
            .build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );
    assert_reject_reason(reason, "Bond below the minimum listing bond");
}

#[test]
fn non_whitelisted_arbiter_is_rejected() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let rogue = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(seller.component, "withdraw", args![XTR, amount![1000]])
            .put_last_instruction_output_on_workspace("asset")
            .call_method(seller.component, "withdraw", args![XTR, amount![100]])
            .put_last_instruction_output_on_workspace("bond")
            .call_method(board.component, "list",
                args![Workspace("asset"), Workspace("bond"), seller.component,
                      sha256(b"t"), rogue.public_key, 10u64, None::<Hash32>]) // rogue arbiter not whitelisted
            .build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );
    assert_reject_reason(reason, "Arbiter is not whitelisted");
}

#[test]
fn non_owner_cannot_set_params() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let stranger = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "set_params", args![amount![0], amount![1], 0u64])
            .build_and_seal(&stranger.key),
        vec![stranger.owner_token.clone()],
    );
    assert_reject_reason(reason, "Access Denied");
}

#[test]
fn owner_adds_arbiter_then_listing_with_them_works() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let arbiter2 = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    // owner adds arbiter2 (owner badge proof)
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, board.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(board.component, "add_arbiter", args![arbiter2.public_key])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    // now a listing with arbiter2 is accepted
    let _id = list(&mut ctx, &board, &seller, &arbiter2, amount![500], amount![100], 10);
}

// -- arbiter staking & slashing (stronger trust model than whitelist-only) -------------------

/// Owner sets a required arbiter stake; `set_arbiter_stake` is owner-badge gated.
fn set_arbiter_stake(ctx: &mut Ctx, board: &Board, owner: &Account, stake: Amount) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, board.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(board.component, "set_arbiter_stake", args![stake])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
}

/// A whitelisted arbiter posts `stake` of XTR.
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

#[test]
fn arbiter_must_stake_before_resolving_when_required() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test); // funded so it can post a stake
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    set_arbiter_stake(&mut ctx, &board, &owner, amount![500]);

    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);
    simple(&mut ctx, &board, &buyer, "open_dispute", id);

    // arbiter has not staked -> resolve is rejected
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "resolve", args![id, amount![600]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    assert_reject_reason(reason, "Arbiter has not staked enough to resolve");

    // arbiter posts the stake -> resolve now succeeds
    stake_arbiter(&mut ctx, &board, &arbiter, amount![500]);
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "resolve", args![id, amount![600]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
}

#[test]
fn owner_slashes_arbiter_stake_to_treasury() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test);
    let _seller = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    stake_arbiter(&mut ctx, &board, &arbiter, amount![500]);
    assert_eq!(bal(&mut ctx.test, &treasury), amount![0]);

    // owner slashes the arbiter's stake -> it goes to the treasury
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, board.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(board.component, "slash_arbiter", args![arbiter.public_key])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    assert_eq!(bal(&mut ctx.test, &treasury), amount![500]);

    // the arbiter's staked balance is now zero
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "get_arbiter_stake", args![arbiter.public_key])
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    let (_required, staked) = ctx.test.expect_return::<(Amount, Amount)>(0);
    assert_eq!(staked, amount![0]);
}

// -- fund-safety edge cases (reviewer feedback #6) -------------------------------------------

fn confirm(ctx: &mut Ctx, board: &Board, who: &Account, id: u64) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "confirm", args![id, None::<Vec<u8>>])
            .build_and_seal(&who.key),
        vec![who.owner_token.clone()],
    );
}

#[test]
fn double_confirm_does_not_double_release() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 0);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);
    confirm(&mut ctx, &board, &seller, id);
    let buyer_after_first = bal(&mut ctx.test, &buyer);

    // a second confirm must fail — the listing already settled
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "confirm", args![id, None::<Vec<u8>>])
            .build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );
    assert_reject_reason(reason, "Listing is not taken");
    assert_eq!(bal(&mut ctx.test, &buyer), buyer_after_first); // no extra payout
}

/// A whitelisted arbiter withdraws their entire posted stake.
fn unstake_arbiter(ctx: &mut Ctx, board: &Board, arbiter: &Account) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "unstake_arbiter", args![])
            .put_last_instruction_output_on_workspace("stake")
            .call_method(arbiter.component, "deposit", args![Workspace("stake")])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
}

/// An arbiter must NOT be able to pull their stake while a dispute names them (that would dodge
/// slashing); and `slash_arbiter` must still work while the dispute is live.
#[test]
fn arbiter_cannot_unstake_during_dispute_and_slash_still_works() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    set_arbiter_stake(&mut ctx, &board, &owner, amount![500]);
    stake_arbiter(&mut ctx, &board, &arbiter, amount![500]);

    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);
    simple(&mut ctx, &board, &buyer, "open_dispute", id);

    // the arbiter tries to escape by pulling their stake mid-dispute -> rejected
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "unstake_arbiter", args![])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
    assert_reject_reason(reason, "Cannot unstake while you are the arbiter on a listing under dispute");

    // the stake is still there, so slashing remains effective during the dispute
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, board.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(board.component, "slash_arbiter", args![arbiter.public_key])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    assert_eq!(bal(&mut ctx.test, &treasury), amount![500]); // slashed stake moved to treasury

    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "get_arbiter_stake", args![arbiter.public_key])
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    let (_required, staked) = ctx.test.expect_return::<(Amount, Amount)>(0);
    assert_eq!(staked, amount![0]);
}

/// Once the arbiter has no open dispute (the deal is resolved/settled), they CAN retire their stake.
#[test]
fn arbiter_can_unstake_once_dispute_is_resolved() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 500);
    set_arbiter_stake(&mut ctx, &board, &owner, amount![500]);
    stake_arbiter(&mut ctx, &board, &arbiter, amount![500]);

    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    take(&mut ctx, &board, &buyer, id);
    simple(&mut ctx, &board, &buyer, "open_dispute", id);

    // arbiter resolves the dispute (settling the listing) ...
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "resolve", args![id, amount![600]])
            .build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );

    // ... and with no open dispute remaining, the stake can be withdrawn
    let before = bal(&mut ctx.test, &arbiter);
    unstake_arbiter(&mut ctx, &board, &arbiter);
    assert_eq!(bal(&mut ctx.test, &arbiter), before + amount![500]);

    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(board.component, "get_arbiter_stake", args![arbiter.public_key])
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    let (_required, staked) = ctx.test.expect_return::<(Amount, Amount)>(0);
    assert_eq!(staked, amount![0]);
}

#[test]
fn confirm_before_take_is_rejected() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = empty(&mut ctx.test);
    let seller = funded(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![100], amount![10000], 0);
    let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 10);
    // listing is Open (never taken) -> confirm must fail
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .call_method(board.component, "confirm", args![id, None::<Vec<u8>>])
            .build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );
    assert_reject_reason(reason, "Listing is not taken");
}
