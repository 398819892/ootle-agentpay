//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! Fund-conservation invariant + property/fuzz tests for the OtcBoard template (go-live gate ⑤).
//!
//! Each listing escrows two things: the ASSET (split on settlement) and the seller's BOND (always
//! returned in full — no fee is ever taken from it). The invariant, for every terminal transition:
//!
//!     asset == to_buyer + fee + to_seller + remaining       (bond round-trips wholly to the seller)
//!
//! so nothing is minted and nothing vanishes. Measured purely from on-chain account balances: because
//! the bond always comes back to the seller, the seller's NET outflow equals exactly what the buyer
//! and the treasury gained — the conservation identity, checked over a deterministic FUZZ of random
//! amounts, fees and settlement paths (cancel / confirm / reclaim / dispute→resolve). A separate test
//! covers arbiter-stake conservation (stake → unstake returns it; stake → slash moves it to treasury),
//! and illegal transitions are asserted to move no funds.

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

fn set_fee(ctx: &mut Ctx, owner: &Account, board: &Board, fee_bps: u64, max_amount: Amount) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, board.owner_badge)
            .put_last_instruction_output_on_workspace("p")
            .call_method(board.component, "set_params", args![amount![0], max_amount, fee_bps])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
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
fn simple(ctx: &mut Ctx, board: &Board, who: &Account, method: &str, id: u64) {
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(board.component, method, args![id]).build_and_seal(&who.key),
        vec![who.owner_token.clone()],
    );
}
fn confirm(ctx: &mut Ctx, board: &Board, seller: &Account, id: u64) {
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(board.component, "confirm", args![id, None::<Vec<u8>>]).build_and_seal(&seller.key),
        vec![seller.owner_token.clone()],
    );
}
fn resolve(ctx: &mut Ctx, board: &Board, arbiter: &Account, id: u64, to_buyer: Amount) {
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(board.component, "resolve", args![id, to_buyer]).build_and_seal(&arbiter.key),
        vec![arbiter.owner_token.clone()],
    );
}

fn fee_on(x: u64, bps: u64) -> u64 { x * bps / 10000 }

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 11
    }
    fn in_range(&mut self, lo: u64, hi_inclusive: u64) -> u64 { lo + self.next() % (hi_inclusive - lo + 1) }
}

const BIG: u64 = 1_000_000_000_000;

#[test]
fn fuzz_settlement_paths_conserve_funds() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test); // signs resolve
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![0], amount![BIG], 0);

    let seed = 0x0bad_c0de_0745_1111u64;
    let mut rng = Lcg(seed);
    let mut clock = 1u64;

    for i in 0..32u64 {
        let fee_bps = rng.in_range(0, 10000);
        set_fee(&mut ctx, &owner, &board, fee_bps, amount![BIG]);

        let asset = rng.in_range(1, 1_000_000);
        let bond = rng.in_range(1, 100_000);
        let path = rng.next() % 4; // 0 cancel, 1 confirm, 2 reclaim, 3 resolve
        let timeout = 5u64;

        let seller0 = bal(&mut ctx.test, &seller);
        let buyer0 = bal(&mut ctx.test, &buyer);
        let treas0 = bal(&mut ctx.test, &treasury);

        set_epoch(&mut ctx.test, clock);
        let id = list(&mut ctx, &board, &seller, &arbiter, amount![asset], amount![bond], timeout);

        let (exp_buyer, exp_fee) = match path {
            0 => {
                simple(&mut ctx, &board, &seller, "cancel", id);
                (0u64, 0u64)
            }
            1 => {
                take(&mut ctx, &board, &buyer, id);
                confirm(&mut ctx, &board, &seller, id);
                let fee = fee_on(asset, fee_bps);
                (asset - fee, fee)
            }
            2 => {
                take(&mut ctx, &board, &buyer, id);
                set_epoch(&mut ctx.test, clock + timeout + 1);
                simple(&mut ctx, &board, &seller, "reclaim", id);
                (0, 0)
            }
            _ => {
                take(&mut ctx, &board, &buyer, id);
                simple(&mut ctx, &board, &seller, "open_dispute", id);
                let to_buyer = rng.in_range(0, asset);
                resolve(&mut ctx, &board, &arbiter, id, amount![to_buyer]);
                let fee = fee_on(to_buyer, fee_bps);
                (to_buyer - fee, fee)
            }
        };

        let d_buyer = bal(&mut ctx.test, &buyer) - buyer0;
        let d_treas = bal(&mut ctx.test, &treasury) - treas0;
        let seller_out = seller0 - bal(&mut ctx.test, &seller); // net amount that left the seller

        let ctxt = format!("seed={:#x} iter={} path={} asset={} bond={} fee_bps={}", seed, i, path, asset, bond, fee_bps);
        assert_eq!(d_buyer, amount![exp_buyer], "buyer payout mismatch: {}", ctxt);
        assert_eq!(d_treas, amount![exp_fee], "treasury (fee) mismatch: {}", ctxt);
        // CONSERVATION: the bond round-trips, so the seller's NET outflow is exactly what the buyer
        // and treasury gained. Nothing created, nothing lost.
        assert_eq!(seller_out, d_buyer + d_treas, "conservation broken: {}", ctxt);
        clock += 100;
    }
}

#[test]
fn boundary_resolve_zero_and_full_conserve() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![0], amount![BIG], 500);

    // to_buyer = 0 → everything back to the seller (asset + bond), buyer and treasury get nothing.
    {
        set_epoch(&mut ctx.test, 1);
        let seller0 = bal(&mut ctx.test, &seller);
        let buyer0 = bal(&mut ctx.test, &buyer);
        let treas0 = bal(&mut ctx.test, &treasury);
        let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 5);
        take(&mut ctx, &board, &buyer, id);
        simple(&mut ctx, &board, &seller, "open_dispute", id);
        resolve(&mut ctx, &board, &arbiter, id, amount![0]);
        assert_eq!(bal(&mut ctx.test, &buyer) - buyer0, amount![0]);
        assert_eq!(bal(&mut ctx.test, &treasury) - treas0, amount![0]);
        assert_eq!(seller0 - bal(&mut ctx.test, &seller), amount![0]); // asset+bond fully returned
    }
    // to_buyer = full → buyer gets asset - fee, treasury gets fee, seller only the bond back.
    {
        set_epoch(&mut ctx.test, 100);
        let seller0 = bal(&mut ctx.test, &seller);
        let buyer0 = bal(&mut ctx.test, &buyer);
        let treas0 = bal(&mut ctx.test, &treasury);
        let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 5);
        take(&mut ctx, &board, &buyer, id);
        simple(&mut ctx, &board, &seller, "open_dispute", id);
        resolve(&mut ctx, &board, &arbiter, id, amount![1000]);
        assert_eq!(bal(&mut ctx.test, &buyer) - buyer0, amount![950]);
        assert_eq!(bal(&mut ctx.test, &treasury) - treas0, amount![50]);
        assert_eq!(seller0 - bal(&mut ctx.test, &seller), amount![1000]); // asset left; only bond returned → net -1000
    }
}

#[test]
fn arbiter_stake_is_conserved() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test);
    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![0], amount![BIG], 0);

    // unstake returns the full posted stake to the arbiter.
    {
        let a0 = bal(&mut ctx.test, &arbiter);
        ctx.test.execute_expect_success(
            ctx.test.transaction()
                .call_method(arbiter.component, "withdraw", args![XTR, amount![5000]])
                .put_last_instruction_output_on_workspace("stake")
                .call_method(board.component, "stake_arbiter", args![Workspace("stake")])
                .build_and_seal(&arbiter.key),
            vec![arbiter.owner_token.clone()],
        );
        assert_eq!(a0 - bal(&mut ctx.test, &arbiter), amount![5000]); // locked in the board
        ctx.test.execute_expect_success(
            ctx.test.transaction()
                .call_method(board.component, "unstake_arbiter", args![])
                .put_last_instruction_output_on_workspace("back")
                .call_method(arbiter.component, "deposit", args![Workspace("back")])
                .build_and_seal(&arbiter.key),
            vec![arbiter.owner_token.clone()],
        );
        assert_eq!(bal(&mut ctx.test, &arbiter), a0); // fully returned — conserved
    }

    // slash moves the whole posted stake to the treasury (nothing created or lost).
    {
        let t0 = bal(&mut ctx.test, &treasury);
        ctx.test.execute_expect_success(
            ctx.test.transaction()
                .call_method(arbiter.component, "withdraw", args![XTR, amount![3000]])
                .put_last_instruction_output_on_workspace("stake")
                .call_method(board.component, "stake_arbiter", args![Workspace("stake")])
                .build_and_seal(&arbiter.key),
            vec![arbiter.owner_token.clone()],
        );
        ctx.test.execute_expect_success(
            ctx.test.transaction()
                .create_proof(owner.component, board.owner_badge)
                .put_last_instruction_output_on_workspace("p")
                .call_method(board.component, "slash_arbiter", args![arbiter.public_key])
                .drop_all_proofs_in_workspace()
                .build_and_seal(&owner.key),
            vec![owner.owner_token.clone()],
        );
        assert_eq!(bal(&mut ctx.test, &treasury) - t0, amount![3000]); // slashed stake → treasury
    }
}

#[test]
fn illegal_transitions_move_no_funds() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let arbiter = funded(&mut ctx.test);
    let seller = funded(&mut ctx.test);
    let buyer = empty(&mut ctx.test);

    let board = new_board(&mut ctx, &owner, &treasury, &arbiter, amount![0], amount![BIG], 0);

    // confirm before take is rejected and moves nothing.
    {
        set_epoch(&mut ctx.test, 1);
        let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 5);
        let buyer0 = bal(&mut ctx.test, &buyer);
        let reason = ctx.test.execute_expect_failure(
            ctx.test.transaction().call_method(board.component, "confirm", args![id, None::<Vec<u8>>]).build_and_seal(&seller.key),
            vec![seller.owner_token.clone()],
        );
        assert_reject_reason(reason, "Listing is not taken");
        assert_eq!(bal(&mut ctx.test, &buyer), buyer0);
        // cancel it cleanly to return the funds
        simple(&mut ctx, &board, &seller, "cancel", id);
    }

    // resolve awarding more than the escrowed asset is rejected and moves nothing.
    {
        set_epoch(&mut ctx.test, 100);
        let id = list(&mut ctx, &board, &seller, &arbiter, amount![1000], amount![100], 5);
        take(&mut ctx, &board, &buyer, id);
        simple(&mut ctx, &board, &seller, "open_dispute", id);
        let buyer0 = bal(&mut ctx.test, &buyer);
        let reason = ctx.test.execute_expect_failure(
            ctx.test.transaction().call_method(board.component, "resolve", args![id, amount![2000]]).build_and_seal(&arbiter.key),
            vec![arbiter.owner_token.clone()],
        );
        assert_reject_reason(reason, "amount exceeds the escrowed asset");
        assert_eq!(bal(&mut ctx.test, &buyer), buyer0);
    }
}
