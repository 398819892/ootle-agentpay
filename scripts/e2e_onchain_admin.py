#!/usr/bin/env python3
"""Real on-chain e2e for the owner admin calls `remove_merchant` and `set_limits` — NO MOCKS.

Companion to `e2e_onchain_pay.py`. Those two template methods were wired through the SDK, the TS
client, the dashboard and `/api/v1` with mock/dead-walletd tests only; this script proves, against a
real Tari Ootle wallet daemon (a local swarm), that the chain actually enforces the result:

  1. a confirmed `pay` to a whitelisted merchant works (baseline);
  2. after `remove_merchant`, the very same pay is REJECTED by the validator with the whitelist
     reason (not a badge/proof error) — and `add_merchant` makes it payable again (confirmed);
  3. after `set_limits(per_tx, daily)`, a pay one unit over the NEW per-tx cap is rejected with the
     cap reason, a pay at exactly the new cap is confirmed, and lowering the daily cap to just above
     what is already spent in the current window makes the next pay hit the DAILY cap (spend already
     counted is kept, as documented).

Needs a reachable walletd; exit 3 if it is not (callers may treat that as a skip).

    RUN_E2E=1 python3 scripts/e2e_onchain_admin.py

Env knobs (same as e2e_onchain_pay.py): WALLETD_URL, AGENT_TEMPLATE, OWNER, E2E_MERCHANT.
Exit codes: 0 = all chain-enforced outcomes verified · 1 = assertion/chain failure · 3 = unreachable.
"""
from __future__ import annotations

import os
import sys
import urllib.error

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk", "src"))
from agentpay.onchain import WalletdClient, OnChainBudget, ChainError  # noqa: E402
from e2e_onchain_pay import (  # noqa: E402
    WALLETD_URL, TEMPLATE, OWNER, MERCHANT_NAME, log, ensure_merchant, xtr_balance,
)

FUND, PER_TX, DAILY = 5000, 1000, 1500


def confirmed_pay(b: OnChainBudget, merchant: str, amount: int, memo: str) -> None:
    res = b.pay(merchant, amount, memo=memo)
    events = OnChainBudget.pay_events(res)
    assert events and int(events[0]["amount"]) == amount, f"no confirmed pay event for {amount}"
    log(f"pay {amount:>4} confirmed  (spent_in_window={events[0].get('spent_in_window')})")


def expect_reject(b: OnChainBudget, merchant: str, amount: int, needle: str, what: str) -> None:
    reason = b.would_reject(merchant, amount)
    assert reason, f"{what}: expected the chain to reject a pay of {amount}, but it would accept"
    assert "did not match" not in reason.lower(), f"{what}: badge proof mismatch regressed: {reason!r}"
    assert needle.lower() in reason.lower(), f"{what}: wrong reject reason {reason!r} (want {needle!r})"
    log(f"pay {amount:>4} rejected   ({what}): {reason}")


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
    m0 = xtr_balance(c, MERCHANT_NAME)

    b = OnChainBudget(client=c, budget_template=TEMPLATE, owner_account=owner)
    b.open(fund=FUND, per_tx_cap=PER_TX, daily_cap=DAILY, epochs_per_window=100, whitelist=[merchant])
    log(f"component : {b.component}")

    # 1. baseline
    confirmed_pay(b, merchant, 100, "admin-e2e-baseline")

    # 2. remove_merchant -> chain refuses; add back -> payable again
    b.remove_merchant(merchant)
    log("remove_merchant confirmed on chain")
    assert merchant not in b.whitelist
    expect_reject(b, merchant, 100, "not whitelisted", "after remove_merchant")
    b.add_merchant(merchant)
    log("add_merchant confirmed on chain")
    confirmed_pay(b, merchant, 100, "admin-e2e-readded")

    # 3. set_limits -> new per-tx cap binds on the next pay; daily cap keeps the spend already counted
    b.set_limits(300, DAILY)
    log("set_limits(300, 1500) confirmed on chain")
    expect_reject(b, merchant, 301, "per-transaction cap", "1 over the new per-tx cap")
    confirmed_pay(b, merchant, 300, "admin-e2e-at-new-cap")          # spent so far: 500
    b.set_limits(300, 550)
    log("set_limits(300, 550) confirmed on chain")
    expect_reject(b, merchant, 100, "daily cap", "daily cap lowered to 550 with 500 already spent")
    confirmed_pay(b, merchant, 50, "admin-e2e-daily-headroom")        # exactly fills the window

    m1 = xtr_balance(c, MERCHANT_NAME)
    log(f"merchant  : {m0} -> {m1} (Δ {m1 - m0}, expected 550)")
    assert m1 - m0 == 550, "merchant balance does not match the confirmed pays"

    print(f"\n  OK: remove_merchant / set_limits are enforced by the chain on {b.component}")
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
