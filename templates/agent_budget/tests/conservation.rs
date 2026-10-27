//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! Fund-conservation invariant + property/fuzz tests for the AgentBudget template (go-live gate ⑤).
//!
//! The budget has no fee. Every base unit is always accounted for by exactly one of: still in the
//! vault, paid out to a merchant, or withdrawn back out by the owner. So the invariant, at all times:
//!
//!     funded_total (initial + top-ups)  ==  vault_balance + Σ(paid to merchants) + Σ(withdrawn)
//!
//! These tests drive the real template in the wasmer sandbox over a deterministic FUZZ of random
//! pay / top-up / withdraw sequences, asserting the identity after every step from on-chain reads
//! (the component's own `get_info` balance, the merchant account, and a withdrawal sink account).
//! Per-tx and daily caps are set huge and the window is effectively infinite, so the fuzz exercises
//! fund movement, not the cap logic (which `test.rs` covers). A rejected (over-cap) pay is asserted
//! to move nothing.

use tari_template_lib::prelude::*;
use tari_template_test_tooling::crypto::RistrettoSecretKey;
use tari_template_test_tooling::support::assert_error::assert_reject_reason;
use tari_template_test_tooling::transaction::args;
use tari_template_test_tooling::TemplateTest;

#[derive(Clone)]
struct Account {
    component: ComponentAddress,
    owner_token: NonFungibleAddress,
    key: RistrettoSecretKey,
}

struct Ctx {
    test: TemplateTest,
    template: TemplateAddress,
}

fn setup() -> Ctx {
    let mut test = TemplateTest::my_crate();
    let template = test.get_template_address("AgentBudget");
    Ctx { test, template }
}

fn funded(test: &mut TemplateTest) -> Account {
    let (component, owner_token, key) = test.create_funded_account();
    Account { component, owner_token, key }
}
fn empty(test: &mut TemplateTest) -> Account {
    let (component, owner_token, key) = test.create_empty_account();
    Account { component, owner_token, key }
}

fn tari_balance(test: &mut TemplateTest, a: &Account) -> Amount {
    test.execute_expect_success(
        test.transaction().call_method(a.component, "balance", args![XTR]).build_and_seal(&a.key),
        vec![a.owner_token.clone()],
    );
    test.expect_return::<Amount>(0)
}

struct Budget {
    component: ComponentAddress,
    owner_badge: ResourceAddress,
    agent_badge: ResourceAddress,
}

#[allow(clippy::too_many_arguments)]
fn create_budget(ctx: &mut Ctx, owner: &Account, agent: &Account, whitelist: Vec<ComponentAddress>,
                 fund: Amount, per_tx: Amount, daily: Amount, epochs_per_window: u64) -> Budget {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(owner.component, "withdraw", args![XTR, fund])
            .put_last_instruction_output_on_workspace("funds")
            .call_function(ctx.template, "new", args![Workspace("funds"), per_tx, daily, epochs_per_window, whitelist])
            .put_last_instruction_output_on_workspace("ret")
            .call_method(owner.component, "deposit", args![Workspace("ret.1")])
            .call_method(agent.component, "deposit", args![Workspace("ret.2")])
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    let component = ctx.test.expect_return::<(ComponentAddress, Bucket, Bucket)>(2).0;
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(component, "get_badges", args![]).build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    let (owner_badge, agent_badge) = ctx.test.expect_return::<(ResourceAddress, ResourceAddress)>(0);
    Budget { component, owner_badge, agent_badge }
}

fn budget_balance(ctx: &mut Ctx, owner: &Account, b: &Budget) -> Amount {
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(b.component, "get_info", args![]).build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    ctx.test.expect_return::<(bool, Amount, Amount, Amount, Amount, u64)>(0).1
}

fn pay(ctx: &mut Ctx, agent: &Account, b: &Budget, merchant: ComponentAddress, amount: Amount) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(agent.component, b.agent_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "pay", args![Workspace("proof"), merchant, amount, "m".to_string()])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    );
}

fn pay_expect_failure(ctx: &mut Ctx, agent: &Account, b: &Budget, merchant: ComponentAddress, amount: Amount)
    -> tari_template_test_tooling::engine_types::commit_result::RejectReason {
    ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .create_proof(agent.component, b.agent_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "pay", args![Workspace("proof"), merchant, amount, "m".to_string()])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    )
}

fn top_up(ctx: &mut Ctx, funder: &Account, b: &Budget, amount: Amount) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .call_method(funder.component, "withdraw", args![XTR, amount])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(b.component, "top_up", args![Workspace("funds")])
            .build_and_seal(&funder.key),
        vec![funder.owner_token.clone()],
    );
}

/// Owner withdraws `amount` from the budget and deposits it into `sink`.
fn owner_withdraw(ctx: &mut Ctx, owner: &Account, b: &Budget, sink: &Account, amount: Amount) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "withdraw", args![amount])
            .put_last_instruction_output_on_workspace("out")
            .call_method(sink.component, "deposit", args![Workspace("out")])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
}

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

const BIG: u64 = 1_000_000_000_000; // caps far above any amount the fuzz moves

#[test]
fn fuzz_pay_topup_withdraw_conserve_funds() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let keeper = funded(&mut ctx.test); // funds the top-ups
    let sink = empty(&mut ctx.test); // receives owner withdrawals

    let fund0 = 1_000u64;
    // window length 1 is fine: spent resets but caps are enormous, so pays never hit the cap anyway.
    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
                          amount![fund0], amount![BIG], amount![BIG], 1_000_000_000);

    let mut vault = fund0; // model of the on-chain vault balance
    let mut funded_total = fund0;
    let mut paid_total = 0u64;
    let mut withdrawn_total = 0u64;

    let seed = 0x1357_9bdf_2468_ace0u64;
    let mut rng = Lcg(seed);

    for i in 0..40u64 {
        // choose an op; if the vault is empty, force a top-up so there is always something to do
        let mut op = rng.next() % 3; // 0 pay, 1 top_up, 2 withdraw
        if vault == 0 && op != 1 {
            op = 1;
        }
        match op {
            0 => {
                let amt = rng.in_range(1, vault);
                pay(&mut ctx, &agent, &b, merchant.component, amount![amt]);
                vault -= amt;
                paid_total += amt;
            }
            1 => {
                let amt = rng.in_range(1, 100_000);
                top_up(&mut ctx, &keeper, &b, amount![amt]);
                vault += amt;
                funded_total += amt;
            }
            _ => {
                let amt = rng.in_range(1, vault);
                owner_withdraw(&mut ctx, &owner, &b, &sink, amount![amt]);
                vault -= amt;
                withdrawn_total += amt;
            }
        }

        let ctxt = format!("seed={:#x} iter={} op={}", seed, i, op);
        let on_chain_vault = budget_balance(&mut ctx, &owner, &b);
        let merchant_bal = tari_balance(&mut ctx.test, &merchant);
        let sink_bal = tari_balance(&mut ctx.test, &sink);

        assert_eq!(on_chain_vault, amount![vault], "vault model drift: {}", ctxt);
        assert_eq!(merchant_bal, amount![paid_total], "merchant total mismatch: {}", ctxt);
        assert_eq!(sink_bal, amount![withdrawn_total], "withdrawn total mismatch: {}", ctxt);
        // CONSERVATION: everything funded is in exactly one place — vault, merchant, or sink.
        assert_eq!(on_chain_vault + merchant_bal + sink_bal, amount![funded_total],
                   "conservation broken: {}", ctxt);
    }
}

#[test]
fn boundary_withdraw_whole_vault_then_empty() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let sink = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
                          amount![1000], amount![BIG], amount![BIG], 1_000_000_000);
    // pay 400, then withdraw the remaining 600 — vault must end exactly empty, all accounted for.
    pay(&mut ctx, &agent, &b, merchant.component, amount![400]);
    owner_withdraw(&mut ctx, &owner, &b, &sink, amount![600]);
    assert_eq!(budget_balance(&mut ctx, &owner, &b), amount![0]);
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![400]);
    assert_eq!(tari_balance(&mut ctx.test, &sink), amount![600]);
}

#[test]
fn rejected_pay_moves_no_funds() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    // per-tx cap 100; a 500 pay must be rejected and move nothing.
    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
                          amount![1000], amount![100], amount![BIG], 1_000_000_000);
    let reason = pay_expect_failure(&mut ctx, &agent, &b, merchant.component, amount![500]);
    assert_reject_reason(reason, "Amount exceeds the per-transaction cap");
    assert_eq!(budget_balance(&mut ctx, &owner, &b), amount![1000]); // vault untouched
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![0]); // merchant got nothing
}
