//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! Integration tests for the `AgentBudget` template. Covers the Phase-2 checklist: over the
//! per-transaction cap, over the daily cap, the daily-window reset, a non-whitelisted merchant,
//! paying after revoke, and the agent attempting an owner-only method — all of which must fail —
//! plus the happy paths.

use tari_template_lib::prelude::*;
use tari_template_test_tooling::support::assert_error::assert_reject_reason;
use tari_template_test_tooling::transaction::args;
use tari_template_test_tooling::engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_template_test_tooling::byte_type::ToByteType;
use tari_template_test_tooling::crypto::{PublicKey as _, RistrettoPublicKey, RistrettoSecretKey};
use tari_template_test_tooling::TemplateTest;

fn pubkey(key: &RistrettoSecretKey) -> RistrettoPublicKeyBytes {
    RistrettoPublicKey::from_secret_key(key).to_byte_type()
}

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

struct Budget {
    component: ComponentAddress,
    owner_badge: ResourceAddress,
    agent_badge: ResourceAddress,
}

/// Creates a budget funded by `owner`, depositing the owner badge back to `owner` and the agent
/// badge into `agent`'s account.
fn create_budget(
    ctx: &mut Ctx,
    owner: &Account,
    agent: &Account,
    whitelist: Vec<ComponentAddress>,
    fund: Amount,
    per_tx: Amount,
    daily: Amount,
    epochs_per_window: u64,
) -> Budget {
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(owner.component, "withdraw", args![XTR, fund])
            .put_last_instruction_output_on_workspace("funds")
            .call_function(
                ctx.template,
                "new",
                args![Workspace("funds"), per_tx, daily, epochs_per_window, whitelist],
            )
            .put_last_instruction_output_on_workspace("ret")
            .call_method(owner.component, "deposit", args![Workspace("ret.1")])
            .call_method(agent.component, "deposit", args![Workspace("ret.2")])
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    // instructions: 0 withdraw, 1 put, 2 new -> (Component, Bucket, Bucket)
    let component = ctx.test.expect_return::<(ComponentAddress, Bucket, Bucket)>(2).0;

    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(component, "get_badges", args![])
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    let (owner_badge, agent_badge) = ctx.test.expect_return::<(ResourceAddress, ResourceAddress)>(0);

    Budget { component, owner_badge, agent_badge }
}

/// Builds a `pay` transaction authorized with the agent badge, expecting success. The agent presents
/// a proof of the agent badge resource, which `pay` now takes as its first argument.
fn pay_ok(ctx: &mut Ctx, agent: &Account, b: &Budget, merchant: ComponentAddress, amount: Amount) {
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .create_proof(agent.component, b.agent_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "pay", args![Workspace("proof"), merchant, amount, "memo".to_string()])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    );
}

/// Builds a `pay` transaction authorized with the agent badge, expecting failure; returns the reason.
fn pay_fail(
    ctx: &mut Ctx,
    agent: &Account,
    b: &Budget,
    merchant: ComponentAddress,
    amount: Amount,
) -> tari_template_test_tooling::engine_types::commit_result::RejectReason {
    ctx.test.execute_expect_failure(
        ctx.test
            .transaction()
            .create_proof(agent.component, b.agent_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "pay", args![Workspace("proof"), merchant, amount, "memo".to_string()])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    )
}

/// Owner mints a new agent session badge labelled `session` and deposits it into `to`'s account.
fn issue_badge(ctx: &mut Ctx, owner: &Account, b: &Budget, to: &Account, session: &str) {
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "issue_agent_badge", args![session.to_string()])
            .put_last_instruction_output_on_workspace("badge")
            .call_method(to.component, "deposit", args![Workspace("badge")])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
}

/// Owner individually revokes the session badge labelled `session`.
fn revoke_session(ctx: &mut Ctx, owner: &Account, b: &Budget, session: &str) {
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "revoke_session", args![session.to_string()])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
}

/// Owner (or keeper) tops the budget's vault up by `amount` XTR. `top_up` is open, so no badge proof.
fn top_up(ctx: &mut Ctx, funder: &Account, b: &Budget, amount: Amount) {
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(funder.component, "withdraw", args![XTR, amount])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(b.component, "top_up", args![Workspace("funds")])
            .build_and_seal(&funder.key),
        vec![funder.owner_token.clone()],
    );
}

/// Owner reconfigures the rolling window length (and resets the current window).
fn set_window(ctx: &mut Ctx, owner: &Account, b: &Budget, epochs_per_window: u64) {
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "set_window", args![epochs_per_window])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
}

/// Reads the budget's current vault balance from `get_info` (field 1 of the returned tuple).
fn budget_balance(ctx: &mut Ctx, owner: &Account, b: &Budget) -> Amount {
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(b.component, "get_info", args![])
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    ctx.test
        .expect_return::<(bool, Amount, Amount, Amount, Amount, u64)>(0)
        .1
}

// --------------------------------------------------------------------------------------------

#[test]
fn agent_pays_whitelisted_merchant() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![1000], amount![3000], 10,
    );

    pay_ok(&mut ctx, &agent, &b, merchant.component, amount![500]);
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![500]);
}

#[test]
fn over_per_tx_cap_fails() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![1000], amount![5000], 10,
    );

    let reason = pay_fail(&mut ctx, &agent, &b, merchant.component, amount![1500]);
    assert_reject_reason(reason, "Amount exceeds the per-transaction cap");
}

#[test]
fn over_daily_cap_fails() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![2000], amount![3000], 10,
    );

    pay_ok(&mut ctx, &agent, &b, merchant.component, amount![2000]); // spent 2000
    let reason = pay_fail(&mut ctx, &agent, &b, merchant.component, amount![2000]); // 4000 > 3000
    assert_reject_reason(reason, "Amount exceeds the daily cap");
}

#[test]
fn daily_window_resets() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![2000], amount![3000], 10,
    );

    pay_ok(&mut ctx, &agent, &b, merchant.component, amount![2000]); // spent 2000 in window
    // advance past the window (window was created at epoch 0, length 10)
    set_epoch(&mut ctx.test, 11);
    // the window resets, so another 2000 is allowed
    pay_ok(&mut ctx, &agent, &b, merchant.component, amount![2000]);
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![4000]);
}

#[test]
fn non_whitelisted_merchant_fails() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let stranger = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![1000], amount![3000], 10,
    );

    let reason = pay_fail(&mut ctx, &agent, &b, stranger.component, amount![100]);
    assert_reject_reason(reason, "Merchant is not whitelisted");
}

#[test]
fn pay_after_revoke_fails() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![1000], amount![3000], 10,
    );

    // owner revokes (owner badge)
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "revoke", args![])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );

    let reason = pay_fail(&mut ctx, &agent, &b, merchant.component, amount![100]);
    assert_reject_reason(reason, "Agent has been revoked");
}

#[test]
fn agent_cannot_call_owner_method() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![1000], amount![3000], 10,
    );

    // agent presents the AGENT badge and tries an owner-only method
    let reason = ctx.test.execute_expect_failure(
        ctx.test
            .transaction()
            .create_proof(agent.component, b.agent_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "set_limits", args![amount![999999], amount![999999]])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    );
    assert_reject_reason(reason, "Access Denied");
}

#[test]
fn owner_can_raise_limits_then_agent_pays_more() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![1000], amount![3000], 10,
    );

    // initially 1500 is over the per-tx cap
    let reason = pay_fail(&mut ctx, &agent, &b, merchant.component, amount![1500]);
    assert_reject_reason(reason, "Amount exceeds the per-transaction cap");

    // owner raises the caps
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "set_limits", args![amount![2000], amount![5000]])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );

    // now 1500 is fine
    pay_ok(&mut ctx, &agent, &b, merchant.component, amount![1500]);
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![1500]);
}

#[test]
fn owner_can_withdraw_remaining() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![1000], amount![3000], 10,
    );

    let owner_before = tari_balance(&mut ctx.test, &owner);
    // owner withdraws 4000 back to their account
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "withdraw", args![amount![4000]])
            .put_last_instruction_output_on_workspace("coins")
            .call_method(owner.component, "deposit", args![Workspace("coins")])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    assert_eq!(tari_balance(&mut ctx.test, &owner), owner_before + amount![4000]);
}

// --------------------------------------------------------------------------------------------
// multi-session badges — issue extra agent/session badges and revoke one in isolation
// --------------------------------------------------------------------------------------------

#[test]
fn revoking_one_session_leaves_others_working() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent_a = empty(&mut ctx.test); // holds the "default" session badge from `new`
    let agent_b = empty(&mut ctx.test); // will hold a second, independently-issued session badge
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent_a,
        vec![merchant.component],
        amount![10000], amount![1000], amount![9000], 10,
    );

    // owner issues a second session badge (same agent-badge resource) to a different agent account
    issue_badge(&mut ctx, &owner, &b, &agent_b, "session-b");

    // both sessions can pay within the same on-chain caps/whitelist
    pay_ok(&mut ctx, &agent_a, &b, merchant.component, amount![100]);
    pay_ok(&mut ctx, &agent_b, &b, merchant.component, amount![100]);

    // owner revokes ONLY the default session
    revoke_session(&mut ctx, &owner, &b, "default");

    // A (default) is now frozen...
    let reason = pay_fail(&mut ctx, &agent_a, &b, merchant.component, amount![100]);
    assert_reject_reason(reason, "Agent session has been revoked");
    // ...but B keeps working
    pay_ok(&mut ctx, &agent_b, &b, merchant.component, amount![100]);
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![300]);
}

/// #2 regression: `pay` requires a proof carrying EXACTLY ONE session badge. If an account holds two
/// of the agent-badge resource's tokens, `create_proof` carries both, and the payment is rejected —
/// the guard that also blocks the empty-proof bypass of `revoke_session` (an empty proof has zero
/// tokens). See `docs/audit-notes.md` #2.
#[test]
fn pay_with_more_than_one_session_badge_is_rejected() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
        amount![10000], amount![5000], amount![9000], 10);
    // the agent already holds the "default" badge; give it a second one in the same account
    issue_badge(&mut ctx, &owner, &b, &agent, "extra");

    // a proof over the agent-badge resource now carries two tokens -> rejected
    let reason = pay_fail(&mut ctx, &agent, &b, merchant.component, amount![100]);
    assert_reject_reason(reason, "Present exactly one agent session badge");
}

#[test]
fn global_revoke_freezes_every_session() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent_a = empty(&mut ctx.test);
    let agent_b = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent_a,
        vec![merchant.component],
        amount![10000], amount![1000], amount![9000], 10,
    );
    issue_badge(&mut ctx, &owner, &b, &agent_b, "session-b");

    // the global kill switch (revoke, no argument) freezes all sessions at once
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "revoke", args![])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );

    assert_reject_reason(
        pay_fail(&mut ctx, &agent_a, &b, merchant.component, amount![100]),
        "Agent has been revoked",
    );
    assert_reject_reason(
        pay_fail(&mut ctx, &agent_b, &b, merchant.component, amount![100]),
        "Agent has been revoked",
    );
}

// --------------------------------------------------------------------------------------------
// top-up & window — recurring allowance and owner/keeper funding
// --------------------------------------------------------------------------------------------

#[test]
fn owner_can_top_up_the_vault() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![1000], amount![1000], amount![9000], 10,
    );
    assert_eq!(budget_balance(&mut ctx, &owner, &b), amount![1000]);

    pay_ok(&mut ctx, &agent, &b, merchant.component, amount![800]); // vault now 200
    assert_eq!(budget_balance(&mut ctx, &owner, &b), amount![200]);

    // owner tops the vault up by 5000
    top_up(&mut ctx, &owner, &b, amount![5000]);
    assert_eq!(budget_balance(&mut ctx, &owner, &b), amount![5200]);

    // the extra funds are spendable (daily cap is generous here)
    pay_ok(&mut ctx, &agent, &b, merchant.component, amount![500]);
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![1300]);
}

#[test]
fn set_window_resets_the_allowance() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![1000], amount![1000], 10,
    );

    pay_ok(&mut ctx, &agent, &b, merchant.component, amount![1000]); // hits the daily cap
    assert_reject_reason(
        pay_fail(&mut ctx, &agent, &b, merchant.component, amount![1]),
        "Amount exceeds the daily cap",
    );

    // owner restarts the window — the per-window allowance is available again immediately
    set_window(&mut ctx, &owner, &b, 20);
    pay_ok(&mut ctx, &agent, &b, merchant.component, amount![1000]);
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![2000]);
}

// --------------------------------------------------------------------------------------------
// pay_via_escrow — cross-template integration with the Escrow template
// --------------------------------------------------------------------------------------------

/// Loads both the AgentBudget (this crate) and the sibling Escrow crate, so `pay_via_escrow` can
/// instantiate an Escrow on-chain. Run from the agent_budget crate dir; `../escrow` is the sibling.
fn setup_with_escrow() -> (Ctx, TemplateAddress) {
    let mut test = TemplateTest::new(".", ["../escrow", "."]);
    let template = test.get_template_address("AgentBudget");
    let escrow_tpl = test.get_template_address("Escrow");
    (Ctx { test, template }, escrow_tpl)
}

#[test]
fn agent_pays_via_escrow_then_release() {
    let (mut ctx, escrow_tpl) = setup_with_escrow();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let b = create_budget(
        &mut ctx, &owner, &agent,
        vec![merchant.component],
        amount![10000], amount![2000], amount![5000], 10,
    );

    // owner wires up the escrow integration: 5% fee, no arbiter, refunds to owner, fee to treasury
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(
                b.component,
                "configure_escrow",
                args![escrow_tpl, owner.component, treasury.component, None::<RistrettoPublicKeyBytes>, 500u64,
                      pubkey(&owner.key), 100_000u64],
            )
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );

    // agent opens an escrow for 1000 instead of paying the merchant directly
    let merchant_pk = pubkey(&merchant.key);
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .create_proof(agent.component, b.agent_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(
                b.component,
                "pay_via_escrow",
                args![Workspace("proof"), merchant.component, merchant_pk, amount![1000], 50u64, "deliver first".to_string()],
            )
            .drop_all_proofs_in_workspace()
            .build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    );
    // instructions: 0 create_proof, 1 put, 2 pay_via_escrow -> escrow ComponentAddress
    let escrow = ctx.test.expect_return::<ComponentAddress>(2);

    // the funds are locked in the escrow — the merchant has NOT been paid yet
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![0]);

    // the OWNER is the escrow's payer (pay_via_escrow records the owner, not the agent), so the owner
    // releases once the merchant delivers — a leaked agent key could not (see audit #1).
    ctx.test.execute_expect_success(
        ctx.test
            .transaction()
            .call_method(escrow, "release", args![None::<Vec<u8>>])
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    // 1000 funds, 5% fee => merchant +950, treasury +50
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![950]);
    assert_eq!(tari_balance(&mut ctx.test, &treasury), amount![50]);
}
