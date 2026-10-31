//   Copyright 2026 The Tari Project
//   SPDX-License-Identifier: BSD-3-Clause

//! Cross-product integration tests: AgentBudget → Escrow (audit pass, roadmap step 3).
//!
//! The question these answer: **can the chain-enforced budget be bypassed by routing a payment through
//! `pay_via_escrow` instead of `pay`?** For every budget control — per-transaction cap, rolling daily
//! cap, merchant whitelist, global revoke, per-session revoke — the escrow route must enforce it
//! exactly like `pay`, and a rejected attempt must leave the budget vault untouched (no funds escape
//! into an escrow). We also pin that the daily counter is **shared** between `pay` and `pay_via_escrow`
//! (so you cannot split spending across the two routes to exceed the daily cap), that only the agent
//! (the escrow's payer) can release the escrowed funds, and that a timed-out escrow refunds to the
//! owner — not the merchant.

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
    escrow_tpl: TemplateAddress,
}

/// Loads both the AgentBudget (this crate) and the sibling Escrow crate.
fn setup() -> Ctx {
    let mut test = TemplateTest::new(".", ["../escrow", "."]);
    let template = test.get_template_address("AgentBudget");
    let escrow_tpl = test.get_template_address("Escrow");
    Ctx { test, template, escrow_tpl }
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

fn set_epoch(test: &mut TemplateTest, e: u64) {
    test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(e));
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
            .call_function(ctx.template, "new",
                args![Workspace("funds"), per_tx, daily, epochs_per_window, whitelist])
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

/// Owner wires up the escrow integration (refunds to owner, fee to treasury).
fn configure_escrow(ctx: &mut Ctx, owner: &Account, b: &Budget, treasury: &Account, fee_bps: u64) {
    let escrow_tpl = ctx.escrow_tpl;
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "configure_escrow",
                args![escrow_tpl, owner.component, treasury.component, None::<RistrettoPublicKeyBytes>, fee_bps,
                      pubkey(&owner.key), 100_000u64])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
}

/// Agent opens an escrow via the budget; returns the escrow component. Expects success.
fn pay_via_escrow_ok(ctx: &mut Ctx, agent: &Account, b: &Budget, merchant: ComponentAddress,
                     merchant_pk: RistrettoPublicKeyBytes, amount: Amount, timeout: u64) -> ComponentAddress {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(agent.component, b.agent_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "pay_via_escrow",
                args![Workspace("proof"), merchant, merchant_pk, amount, timeout, "memo".to_string()])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    );
    ctx.test.expect_return::<ComponentAddress>(2)
}

/// Agent tries to open an escrow via the budget; expects failure, returns the reason.
fn pay_via_escrow_fail(ctx: &mut Ctx, agent: &Account, b: &Budget, merchant: ComponentAddress,
                       merchant_pk: RistrettoPublicKeyBytes, amount: Amount, timeout: u64)
    -> tari_template_test_tooling::engine_types::commit_result::RejectReason {
    ctx.test.execute_expect_failure(
        ctx.test.transaction()
            .create_proof(agent.component, b.agent_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "pay_via_escrow",
                args![Workspace("proof"), merchant, merchant_pk, amount, timeout, "memo".to_string()])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    )
}

/// Direct `pay` (not via escrow), expects success.
fn pay_ok(ctx: &mut Ctx, agent: &Account, b: &Budget, merchant: ComponentAddress, amount: Amount) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(agent.component, b.agent_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "pay", args![Workspace("proof"), merchant, amount, "memo".to_string()])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    );
}

/// Reads the budget vault balance (get_info field 1).
fn budget_balance(ctx: &mut Ctx, who: &Account, b: &Budget) -> Amount {
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(b.component, "get_info", args![]).build_and_seal(&who.key),
        vec![who.owner_token.clone()],
    );
    ctx.test.expect_return::<(bool, Amount, Amount, Amount, Amount, u64)>(0).1
}

fn revoke_global(ctx: &mut Ctx, owner: &Account, b: &Budget) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "revoke", args![])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
}

fn issue_badge(ctx: &mut Ctx, owner: &Account, b: &Budget, to: &Account, session: &str) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
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

fn revoke_session(ctx: &mut Ctx, owner: &Account, b: &Budget, session: &str) {
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("proof")
            .call_method(b.component, "revoke_session", args![session.to_string()])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
}

// ============================================================================================
// The escrow route cannot bypass any budget control (and a rejection moves no funds).
// ============================================================================================

#[test]
fn escrow_route_respects_per_tx_cap() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
        amount![10000], amount![1000], amount![9000], 10);
    configure_escrow(&mut ctx, &owner, &b, &treasury, 0);

    let vault0 = budget_balance(&mut ctx, &owner, &b);
    let reason = pay_via_escrow_fail(&mut ctx, &agent, &b, merchant.component, pubkey(&merchant.key), amount![1500], 50);
    assert_reject_reason(reason, "Amount exceeds the per-transaction cap");
    assert_eq!(budget_balance(&mut ctx, &owner, &b), vault0); // no funds left the vault
}

#[test]
fn escrow_route_respects_daily_cap() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
        amount![10000], amount![5000], amount![2000], 10);
    configure_escrow(&mut ctx, &owner, &b, &treasury, 0);

    let vault0 = budget_balance(&mut ctx, &owner, &b);
    // within the per-tx cap (5000) but over the daily cap (2000)
    let reason = pay_via_escrow_fail(&mut ctx, &agent, &b, merchant.component, pubkey(&merchant.key), amount![2500], 50);
    assert_reject_reason(reason, "Amount exceeds the daily cap");
    assert_eq!(budget_balance(&mut ctx, &owner, &b), vault0);
}

#[test]
fn escrow_route_respects_whitelist() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let stranger = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
        amount![10000], amount![5000], amount![9000], 10);
    configure_escrow(&mut ctx, &owner, &b, &treasury, 0);

    let vault0 = budget_balance(&mut ctx, &owner, &b);
    // paying a non-whitelisted account through the escrow route is refused
    let reason = pay_via_escrow_fail(&mut ctx, &agent, &b, stranger.component, pubkey(&stranger.key), amount![500], 50);
    assert_reject_reason(reason, "Merchant is not whitelisted");
    assert_eq!(budget_balance(&mut ctx, &owner, &b), vault0);
}

#[test]
fn escrow_route_blocked_by_global_revoke() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
        amount![10000], amount![5000], amount![9000], 10);
    configure_escrow(&mut ctx, &owner, &b, &treasury, 0);
    revoke_global(&mut ctx, &owner, &b);

    let vault0 = budget_balance(&mut ctx, &owner, &b);
    let reason = pay_via_escrow_fail(&mut ctx, &agent, &b, merchant.component, pubkey(&merchant.key), amount![500], 50);
    assert_reject_reason(reason, "Agent has been revoked");
    assert_eq!(budget_balance(&mut ctx, &owner, &b), vault0);
}

#[test]
fn escrow_route_blocked_by_session_revoke() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent_a = empty(&mut ctx.test); // holds "default"
    let agent_b = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent_a, vec![merchant.component],
        amount![10000], amount![5000], amount![9000], 10);
    configure_escrow(&mut ctx, &owner, &b, &treasury, 0);
    issue_badge(&mut ctx, &owner, &b, &agent_b, "session-b");
    revoke_session(&mut ctx, &owner, &b, "session-b");

    let vault0 = budget_balance(&mut ctx, &owner, &b);
    // the revoked session cannot route through escrow...
    let reason = pay_via_escrow_fail(&mut ctx, &agent_b, &b, merchant.component, pubkey(&merchant.key), amount![500], 50);
    assert_reject_reason(reason, "Agent session has been revoked");
    assert_eq!(budget_balance(&mut ctx, &owner, &b), vault0);
    // ...but the still-valid default session can
    let _ = pay_via_escrow_ok(&mut ctx, &agent_a, &b, merchant.component, pubkey(&merchant.key), amount![500], 50);
    assert_eq!(budget_balance(&mut ctx, &owner, &b), vault0 - amount![500]);
}

/// The daily budget is a single pool shared by `pay` and `pay_via_escrow`: you cannot spend the cap
/// directly and then open an escrow on top of it.
#[test]
fn daily_cap_is_shared_between_pay_and_escrow() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
        amount![10000], amount![1000], amount![1000], 10);
    configure_escrow(&mut ctx, &owner, &b, &treasury, 0);

    // spend 700 of the 1000 daily cap directly
    pay_ok(&mut ctx, &agent, &b, merchant.component, amount![700]);
    let vault_after_pay = budget_balance(&mut ctx, &owner, &b);

    // an escrow for 400 would push the window to 1100 > 1000 -> rejected, nothing leaves the vault
    let reason = pay_via_escrow_fail(&mut ctx, &agent, &b, merchant.component, pubkey(&merchant.key), amount![400], 50);
    assert_reject_reason(reason, "Amount exceeds the daily cap");
    assert_eq!(budget_balance(&mut ctx, &owner, &b), vault_after_pay);

    // exactly the remaining 300 is allowed through the escrow route
    let _ = pay_via_escrow_ok(&mut ctx, &agent, &b, merchant.component, pubkey(&merchant.key), amount![300], 50);
    assert_eq!(budget_balance(&mut ctx, &owner, &b), vault_after_pay - amount![300]);
}

// ============================================================================================
// Full chain: budget → escrow custody → only the right principal can move the funds out.
// ============================================================================================

/// After `pay_via_escrow`, the funds sit in the escrow with the **OWNER** (not the agent) recorded as
/// payer (audit #1). So the agent's own key — even if leaked — CANNOT release it; nor can a stranger
/// or the merchant. Only the owner can. This is what makes a leaked agent key non-catastrophic.
#[test]
fn escrowed_funds_release_only_by_owner_not_agent() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);
    let stranger = funded(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
        amount![10000], amount![5000], amount![9000], 10);
    configure_escrow(&mut ctx, &owner, &b, &treasury, 500); // 5% fee

    let escrow = pay_via_escrow_ok(&mut ctx, &agent, &b, merchant.component, pubkey(&merchant.key), amount![1000], 50);
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![0]); // locked, not paid

    // a stranger cannot release
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction().call_method(escrow, "release", args![None::<Vec<u8>>]).build_and_seal(&stranger.key),
        vec![stranger.owner_token.clone()],
    );
    assert_reject_reason(reason, "Unauthorized: release requires the payer or a valid preimage");

    // the merchant (payee) cannot release to themselves either
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction().call_method(escrow, "release", args![None::<Vec<u8>>]).build_and_seal(&merchant.key),
        vec![merchant.owner_token.clone()],
    );
    assert_reject_reason(reason, "Unauthorized: release requires the payer or a valid preimage");

    // THE AGENT whose key opened the escrow cannot release it — the payer is the owner, not the agent
    // (so a leaked agent key cannot move an already-opened escrow). This is the #1 fix.
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction().call_method(escrow, "release", args![None::<Vec<u8>>]).build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    );
    assert_reject_reason(reason, "Unauthorized: release requires the payer or a valid preimage");
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![0]); // still nothing moved

    // the OWNER (the recorded escrow payer) releases once the merchant delivers
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(escrow, "release", args![None::<Vec<u8>>]).build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![950]); // 1000 - 5%
    assert_eq!(tari_balance(&mut ctx.test, &treasury), amount![50]);
}

/// #1 regression, named for the attack: a leaked agent key, after the owner has `revoke`d the budget,
/// still cannot release an already-open escrow (it is not the payer) — and cannot open new ones.
#[test]
fn leaked_agent_key_cannot_release_open_escrow() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
        amount![10000], amount![5000], amount![9000], 10);
    configure_escrow(&mut ctx, &owner, &b, &treasury, 0);
    let escrow = pay_via_escrow_ok(&mut ctx, &agent, &b, merchant.component, pubkey(&merchant.key), amount![1000], 50);

    // owner revokes the (leaked) agent after noticing
    ctx.test.execute_expect_success(
        ctx.test.transaction()
            .create_proof(owner.component, b.owner_badge)
            .put_last_instruction_output_on_workspace("p")
            .call_method(b.component, "revoke", args![])
            .drop_all_proofs_in_workspace()
            .build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );

    // the leaked agent key cannot release the open escrow (not the payer)
    let reason = ctx.test.execute_expect_failure(
        ctx.test.transaction().call_method(escrow, "release", args![None::<Vec<u8>>]).build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    );
    assert_reject_reason(reason, "Unauthorized: release requires the payer or a valid preimage");

    // the owner recovers the funds (release to the merchant here, or could refund after timeout)
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(escrow, "release", args![None::<Vec<u8>>]).build_and_seal(&owner.key),
        vec![owner.owner_token.clone()],
    );
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![1000]); // 0 fee
}

/// #1 regression: the owner's `max_escrow_timeout` bounds how long an agent-opened escrow can lock
/// funds — a `timeout_epochs` above it is rejected (so a leaked key cannot pick a ~57-year lock).
#[test]
fn pay_via_escrow_rejects_timeout_above_owner_max() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
        amount![10000], amount![5000], amount![9000], 10);
    configure_escrow(&mut ctx, &owner, &b, &treasury, 0); // helper sets max_escrow_timeout = 100_000

    // 100_001 > the owner's max -> rejected
    let reason = pay_via_escrow_fail(&mut ctx, &agent, &b, merchant.component, pubkey(&merchant.key), amount![500], 100_001);
    assert_reject_reason(reason, "timeout exceeds the owner's max_escrow_timeout");
}

/// A timed-out escrow refunds to the OWNER account (configured as the refund target), not to the
/// merchant — the agent cannot divert a stuck payment.
#[test]
fn escrow_refund_returns_to_owner_on_timeout() {
    let mut ctx = setup();
    let owner = funded(&mut ctx.test);
    let agent = empty(&mut ctx.test);
    let merchant = empty(&mut ctx.test);
    let treasury = empty(&mut ctx.test);

    let b = create_budget(&mut ctx, &owner, &agent, vec![merchant.component],
        amount![10000], amount![5000], amount![9000], 10);
    configure_escrow(&mut ctx, &owner, &b, &treasury, 0);

    set_epoch(&mut ctx.test, 1);
    let escrow = pay_via_escrow_ok(&mut ctx, &agent, &b, merchant.component, pubkey(&merchant.key), amount![1000], 5);

    let owner_before = tari_balance(&mut ctx.test, &owner);
    set_epoch(&mut ctx.test, 100); // past the escrow deadline (1 + 5)

    // the agent (escrow payer) triggers the refund; it goes to the owner account, not the merchant
    ctx.test.execute_expect_success(
        ctx.test.transaction().call_method(escrow, "refund", args![]).build_and_seal(&agent.key),
        vec![agent.owner_token.clone()],
    );
    assert_eq!(tari_balance(&mut ctx.test, &owner), owner_before + amount![1000]);
    assert_eq!(tari_balance(&mut ctx.test, &merchant), amount![0]);
}
