#!/usr/bin/env python3
"""Real on-chain end-to-end test for AgentPay — NO MOCKS.

This is the gap-closer for the class of bug where the unit tests are green but a real payment
is rejected on chain. It drives the *actual* Python SDK (`agentpay.onchain`) against a running
Tari Ootle wallet daemon: it opens a fresh AgentBudget, makes a **confirmed** payment through the
agent-badge proof path, and asserts the funds really moved (budget vault down, merchant up).

If the agent-badge proof is wrong (the historical "Proof of resource did not match" regression),
`pay` is rejected on chain and this script exits non-zero — which is the whole point.

It needs a reachable walletd (a local swarm). It is therefore an INTEGRATION test, gated out of
the swarm-free CI: `scripts/ci-local.sh` only runs it when `RUN_E2E=1` and walletd answers, and
skips it (never fails it) otherwise. Run it directly with:

    RUN_E2E=1 python3 scripts/e2e_onchain_pay.py

Env knobs (all optional):
    WALLETD_URL    wallet daemon JSON-RPC url   (default http://127.0.0.1:12010/json_rpc)
    AGENT_TEMPLATE AgentBudget template address (default: the current local-swarm multi-session build)
    OWNER          owner account name           (default "default")
    E2E_MERCHANT   merchant account name        (default "e2e_merchant"; created+funded if missing)

Exit codes: 0 = payment confirmed & balances verified · 1 = assertion/chain failure ·
            3 = walletd unreachable (caller decides whether that is a skip).
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk", "src"))
from agentpay.onchain import (  # noqa: E402
    WalletdClient,
    OnChainBudget,
    ChainError,
    _find_component_state,
)

WALLETD_URL = os.environ.get("WALLETD_URL", "http://127.0.0.1:12010/json_rpc")
TEMPLATE = os.environ.get(
    "AGENT_TEMPLATE",
    "template_31cfc3fbd31b66dc2479ef46a13cdd8301de8150a9db9900d2715a69f1fb4107",
)
OWNER = os.environ.get("OWNER", "default")
MERCHANT_NAME = os.environ.get("E2E_MERCHANT", "e2e_merchant")

FUND = 5000
PER_TX = 1000
DAILY = 1500
PAY_AMOUNT = 500


def log(msg: str) -> None:
    print("  " + msg, flush=True)


def budget_vault_id(c: WalletdClient, component: str) -> str:
    """The budget's own vault substate id, read from the component's state (field 0 is the Vault)."""
    state = _find_component_state(c.get_substate(component))
    return "vault_" + state[0]["value"]["hex"]


def _iter_up_substates(node):
    """Yield every `up_substates` list found anywhere in a tx result tree."""
    if isinstance(node, dict):
        if isinstance(node.get("up_substates"), list):
            yield node["up_substates"]
        for v in node.values():
            yield from _iter_up_substates(v)
    elif isinstance(node, list):
        for v in node:
            yield from _iter_up_substates(v)


def vault_balance_from_result(result: dict, vault_id: str) -> int:
    """Read a specific vault's post-transaction balance straight from the tx's committed diff —
    lag-free (no indexer round-trip). `up_substates` is a list of `[substate_id, record]` pairs."""
    for ups in _iter_up_substates(result):
        for entry in ups:
            if not (isinstance(entry, list) and len(entry) == 2):
                continue
            sid, rec = entry
            if vault_id not in json.dumps(sid):
                continue
            container = (((rec or {}).get("substate") or {}).get("Vault") or {}).get("resource_container") or {}
            for kind in ("Stealth", "Fungible", "Confidential"):
                body = container.get(kind)
                if isinstance(body, dict) and body.get("revealed_amount") is not None:
                    return int(body["revealed_amount"])
                if isinstance(body, dict) and body.get("amount") is not None:
                    return int(body["amount"])
    raise ChainError(f"budget vault {vault_id} not found in transaction result diff")


def xtr_balance(c: WalletdClient, name: str) -> int:
    """Account's native-token (XTR/tTARI) balance, base units."""
    r = c._rpc("accounts.get_balances", {"account": {"Name": name}, "refresh": True})
    for b in r.get("result", {}).get("balances", []):
        ra = b.get("resource_address", "")
        if ra.startswith("resource_0101") or b.get("token_symbol") in ("XTR", "tXTR", "tTARI"):
            return int(b["balance"])
    return 0


def ensure_merchant(c: WalletdClient, name: str) -> str:
    """Return the merchant account's component address, creating+funding it on the faucet if absent."""
    try:
        return c.account_address(name)
    except ChainError:
        log(f"merchant account {name!r} not found — creating + funding on the devnet faucet")
        comp = c.create_account(name)  # creates the on-chain account component
        c.fund(name)                   # claim free test coins so it exists with a balance
        return comp


def main() -> int:
    log(f"walletd   : {WALLETD_URL}")
    log(f"template  : {TEMPLATE}")
    c = WalletdClient(WALLETD_URL)
    try:
        c.connect()
    except (urllib.error.URLError, OSError) as e:
        log(f"walletd unreachable ({e}) — cannot run the on-chain e2e")
        return 3

    owner = c.account_address(OWNER)
    merchant = ensure_merchant(c, MERCHANT_NAME)
    log(f"owner     : {owner}")
    log(f"merchant  : {merchant} ({MERCHANT_NAME})")

    merchant_before = xtr_balance(c, MERCHANT_NAME)

    # ---- open a fresh budget through the real SDK --------------------------------------------
    b = OnChainBudget(client=c, budget_template=TEMPLATE, owner_account=owner)
    b.open(fund=FUND, per_tx_cap=PER_TX, daily_cap=DAILY, epochs_per_window=100, whitelist=[merchant])
    log(f"component : {b.component}")
    log(f"owner_badge: {b.owner_badge}")
    log(f"agent_badge: {b.agent_badge}")
    assert b.owner_badge and b.agent_badge, "badges not resolved"
    assert b.owner_badge != b.agent_badge, "owner and agent badges must be distinct resources"

    vault_id = budget_vault_id(c, b.component)

    # ---- the real confirmed payment (this is what the mocks never exercised) -----------------
    log(f"paying {PAY_AMOUNT} to merchant (confirmed) …")
    res = b.pay(merchant, PAY_AMOUNT, memo="e2e-onchain")
    events = OnChainBudget.pay_events(res)
    assert events, "expected a `pay` event in the confirmed transaction result"
    ev = events[0]
    assert int(ev["amount"]) == PAY_AMOUNT, f"pay event amount {ev['amount']} != {PAY_AMOUNT}"
    log(f"pay event : {ev}")

    # ---- verify the money actually moved on chain --------------------------------------------
    # The budget vault's new balance is read straight from the committed tx diff (lag-free): it must
    # have dropped by exactly the paid amount. The merchant balance is read via the wallet (refreshes).
    vault_after = vault_balance_from_result(res, vault_id)
    merchant_after = xtr_balance(c, MERCHANT_NAME)
    log(f"budget vault after: {vault_after} (funded {FUND}, Δ {FUND - vault_after})")
    log(f"merchant  : {merchant_before} -> {merchant_after} (Δ {merchant_after - merchant_before})")
    assert vault_after == FUND - PAY_AMOUNT, f"budget vault should be {FUND - PAY_AMOUNT}, got {vault_after}"
    assert merchant_after - merchant_before == PAY_AMOUNT, "merchant did not receive the paid amount"

    # ---- and prove the chain (not the client) still enforces the cap with the right proof ----
    # A reject here must be the CAP, not a badge/proof mismatch — that distinguishes "limit works"
    # from "the badge path is broken again".
    reason = b.would_reject(merchant, PER_TX + 1)
    assert reason, "over-cap payment should be rejected on chain"
    assert "did not match" not in reason.lower(), f"badge proof mismatch regressed: {reason!r}"
    log(f"over-cap reject (chain-enforced): {reason}")

    print("\n  OK: confirmed on-chain payment verified (vault -%d, merchant +%d) on %s"
          % (PAY_AMOUNT, PAY_AMOUNT, b.component))
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
