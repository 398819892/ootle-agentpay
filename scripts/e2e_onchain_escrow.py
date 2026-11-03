#!/usr/bin/env python3
"""Real on-chain e2e for the AgentBudget -> Escrow route (`configure_escrow` + `pay_via_escrow`) - NO MOCKS.

The cross-template path is covered by cargo tests (`templates/agent_budget/tests/escrow_integration.rs`)
but had never been exercised against a real wallet daemon. This script drives the real SDK client:

  1. open a budget (owner also holds the agent badge, as in the other e2e scripts);
  2. owner `configure_escrow` (escrow template, refunds to owner, fee to treasury = owner, no arbiter,
     fee 5 %, owner pubkey as the escrow payer, max timeout 1000 epochs);
  3. the chain still enforces the budget on this route: `pay_via_escrow` one unit over the per-tx cap
     is REJECTED with the cap reason;
  4. agent `pay_via_escrow` 400 is CONFIRMED: an `AgentBudget.pay_via_escrow` event names the new
     escrow component and the budget vault drops by 400 (read from the tx diff);
  5. the owner (= the escrow's payer) `release`s it: the escrow emits `released` with
     payee_amount 380 / fee 20, and - when the merchant is a separate account - its balance grows by 380.

Works against a local swarm (default) or esmeralda (set WALLETD_URL / AGENT_TEMPLATE / ESCROW_TEMPLATE /
OWNER / E2E_MERCHANT=<same account> since the public faucet cannot provision a second account).

    RUN_E2E=1 python3 scripts/e2e_onchain_escrow.py

Exit codes: 0 = verified / 1 = assertion or chain failure / 3 = walletd unreachable.
"""
from __future__ import annotations

import os
import sys
import urllib.error

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk", "src"))
from agentpay.onchain import (  # noqa: E402
    WalletdClient, OnChainBudget, ChainError, _iter_events, _components, _check_template,
    _check_component, _check_resource, _finalized_outcome, _clean_reason,
)
from e2e_onchain_pay import (  # noqa: E402
    WALLETD_URL, TEMPLATE, OWNER, MERCHANT_NAME, log, ensure_merchant, xtr_balance,
    budget_vault_id, vault_balance_from_result,
)
from _defaults import template as _template  # noqa: E402

ESCROW_TEMPLATE = _template("escrow", "ESCROW_TEMPLATE")
FUND, PER_TX, DAILY = 5000, 1000, 1500
AMOUNT, FEE_BPS, TIMEOUT = 400, 500, 50


def account_pubkey(c: WalletdClient, name: str) -> str:
    for a in c._rpc("accounts.list", {"offset": 0, "limit": 50})["result"]["accounts"]:
        if a["account"]["name"] == name:
            return a["account"]["owner_public_key"]
    raise ChainError(f"account {name!r} not found")


def events(result: dict, leaf: str) -> list[dict]:
    out, seen = [], set()
    for ev in _iter_events(result):
        topic = ev.get("topic")
        if (topic.rsplit(".", 1)[-1] if isinstance(topic, str) else topic) != leaf:
            continue
        key = repr(sorted((ev.get("payload") or {}).items()))
        if key not in seen:
            seen.add(key)
            out.append(ev.get("payload") or {})
    return out


def reject_reason(c: WalletdClient, manifest: str, variables: dict) -> str | None:
    r = c.dry_run(manifest, variables)
    if "error" in r:
        return _clean_reason(r["error"].get("message", "rejected"))
    outcome = _finalized_outcome(r.get("result"))
    return outcome[1] if outcome and outcome[0] == "reject" else None


def escrow_manifest(b: OnChainBudget, merchant: str, merchant_pk: str, amount: int, memo: str) -> str:
    return (
        'fn main() {\n'
        '    let mut agent = var!["agent"];\n'
        f'    let proof = agent.create_proof_by_non_fungible_ids(address!("{_check_resource(b.agent_badge)}"), [non_fungible_id!("{b.session}")]);\n'
        '    let mut budget = var!["budget"];\n'
        f'    budget.pay_via_escrow(proof, address!("{_check_component(merchant)}"), public_key!("{merchant_pk}"), '
        f'amount!({amount}), {TIMEOUT}u64, "{memo}");\n'
        '    drop_all_proofs!();\n'
        '}\n'
    )


def main() -> int:
    log(f"walletd        : {WALLETD_URL}")
    log(f"budget template: {TEMPLATE}")
    log(f"escrow template: {ESCROW_TEMPLATE}")
    c = WalletdClient(WALLETD_URL)
    try:
        c.connect()
    except (urllib.error.URLError, OSError) as e:
        log(f"walletd unreachable ({e}) - cannot run the on-chain e2e")
        return 3

    owner = c.account_address(OWNER)
    merchant = ensure_merchant(c, MERCHANT_NAME)
    owner_pk, merchant_pk = account_pubkey(c, OWNER), account_pubkey(c, MERCHANT_NAME)
    separate = merchant != owner
    log(f"owner          : {owner}")
    log(f"merchant       : {merchant} ({MERCHANT_NAME}{'' if separate else ' = owner'})")

    b = OnChainBudget(client=c, budget_template=TEMPLATE, owner_account=owner)
    b.open(fund=FUND, per_tx_cap=PER_TX, daily_cap=DAILY, epochs_per_window=100, whitelist=[merchant])
    log(f"budget         : {b.component}")
    vault_id = budget_vault_id(c, b.component)

    # 2. owner wires the escrow integration (owner-badge gated, same path as the other admin calls)
    tpl = _check_template(ESCROW_TEMPLATE)
    b._owner_call(
        f'configure_escrow(address!("{tpl}"), address!("{owner}"), address!("{owner}"), None, '
        f'{FEE_BPS}u64, public_key!("{owner_pk}"), 1000u64)'
    )
    log(f"configure_escrow confirmed (fee {FEE_BPS} bps, treasury = owner, max timeout 1000 epochs)")

    # 3. the budget's caps bind on the escrow route too
    reason = reject_reason(c, escrow_manifest(b, merchant, merchant_pk, PER_TX + 1, "over-cap"),
                           {"agent": owner, "budget": b.component})
    assert reason and "per-transaction cap" in reason.lower(), f"over-cap escrow not rejected: {reason!r}"
    assert "did not match" not in reason.lower(), f"badge proof mismatch: {reason!r}"
    log(f"pay_via_escrow {PER_TX + 1} rejected on chain: {reason}")

    # 4. the real escrow-opening payment
    m0 = xtr_balance(c, MERCHANT_NAME)
    res = c.run(escrow_manifest(b, merchant, merchant_pk, AMOUNT, "e2e-escrow"),
                {"agent": owner, "budget": b.component})
    evs = events(res, "pay_via_escrow")
    assert evs and int(evs[0]["amount"]) == AMOUNT, f"no pay_via_escrow event: {evs}"
    escrow = evs[0]["escrow"]
    assert escrow.startswith("component_"), f"event does not name the escrow: {evs[0]}"
    assert escrow in _components(repr(res), {owner, merchant, b.component}), "escrow component not in tx diff"
    vault_after = vault_balance_from_result(res, vault_id)
    assert vault_after == FUND - AMOUNT, f"budget vault should be {FUND - AMOUNT}, got {vault_after}"
    log(f"pay_via_escrow {AMOUNT} confirmed -> escrow {escrow}; budget vault {FUND} -> {vault_after}")
    assert xtr_balance(c, MERCHANT_NAME) == m0 or not separate, "merchant must not be paid before release"

    # 5. owner releases (the escrow's payer is the OWNER pubkey, not the agent signer)
    rel = c.run('fn main() {\n    let mut escrow = var!["escrow"];\n    escrow.release(None);\n}\n',
                {"escrow": escrow})
    rev = events(rel, "released")
    fee = AMOUNT * FEE_BPS // 10000
    assert rev and int(rev[0]["payee_amount"]) == AMOUNT - fee and int(rev[0]["fee"]) == fee, \
        f"released event mismatch: {rev}"
    log(f"release confirmed: payee_amount {rev[0]['payee_amount']}, fee {rev[0]['fee']}")
    if separate:
        m1 = xtr_balance(c, MERCHANT_NAME)
        assert m1 - m0 == AMOUNT - fee, f"merchant delta {m1 - m0} != {AMOUNT - fee}"
        log(f"merchant       : {m0} -> {m1} (delta {m1 - m0})")
    else:
        log("merchant = owner on this network: balance delta not meaningful (fees), events verified instead")

    print(f"\n  OK: pay_via_escrow verified on chain (budget {b.component}, escrow {escrow})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as e:
        print(f"\n  FAIL: {e}", file=sys.stderr)
        sys.exit(1)
    except ChainError as e:
        print(f"\n  FAIL (chain): {e}", file=sys.stderr)
        sys.exit(1)