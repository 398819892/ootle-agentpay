"""End-to-end demo against a REAL local Ootle network (the swarm devnet).

Unlike demo_offline.py (in-memory, limits enforced client-side only), this drives the
**AgentBudget** template on chain, so the per-tx cap, daily cap, whitelist and kill switch are
enforced by the validator — the agent cannot exceed them no matter what the client does.

Prerequisites:
  * a running Tari Ootle swarm with its wallet daemon JSON-RPC on 127.0.0.1:12010 (auth=none),
  * the `agent_budget` template published to it (pass its address below or via $BUDGET_TEMPLATE).

    python examples/demo_devnet.py [BUDGET_TEMPLATE_ADDRESS]

No `ootle-py` needed: this path is pure stdlib JSON-RPC.
"""
from __future__ import annotations

import os
import sys

from agentpay.errors import ChainError, PolicyViolation
from agentpay.invoice import new_invoice_id
from agentpay.onchain import OnChainBudget, WalletdClient

BUDGET_TEMPLATE = (
    (sys.argv[1] if len(sys.argv) > 1 else None)
    or os.environ.get("BUDGET_TEMPLATE")
    or "template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97"
)


def ensure_account(c: WalletdClient, name: str) -> str:
    try:
        addr = c.account_address(name)
    except ChainError:
        addr = c.create_account(name)
        c.fund(name)
    return addr


def main() -> None:
    c = WalletdClient().connect()
    owner = c.account_address("default")                 # the funded swarm account = the owner
    shop = ensure_account(c, "shop")                     # a whitelisted merchant
    scammer = ensure_account(c, "scammer")               # NOT whitelisted
    print(f"owner={owner[:24]}…  shop={shop[:24]}…  scammer={scammer[:24]}…")

    print("\n== Owner opens an on-chain budget: 10000 funded, per-tx 1000, daily 1500, whitelist=[shop] ==")
    budget = OnChainBudget(c, BUDGET_TEMPLATE, owner).open(
        fund=10_000, per_tx_cap=1_000, daily_cap=1_500, epochs_per_window=10, whitelist=[shop],
    )
    print(f"  budget component = {budget.component}")
    shop_before = c.balance("shop")

    print("\n== Agent pays an invoice to the shop (on chain, memo carries the invoice id) ==")
    inv = new_invoice_id()
    res = budget.pay_invoice(merchant=shop, invoice_id=inv, amount=700, agent_tag="shopper")
    print(f"  paid 700 — pay events read from chain: {OnChainBudget.pay_events(res)}")

    print("\n== The chain REJECTS what the rules forbid (the VALIDATOR decides, not the client) ==")
    print(f"  over per-tx cap (1500 > 1000): rejected -> {budget.would_reject(shop, 1500)}")
    print(f"  non-whitelisted merchant:      rejected -> {budget.would_reject(scammer, 100)}")

    print("\n== A second real pay (700) brings spend to 1400; the next 700 would break the daily cap ==")
    budget.pay(shop, 700, memo="ap1|second|shopper")   # spent on chain: 700 + 700 = 1400
    print(f"  spent so far (daily cap 1500): {budget.spent}")
    print(f"  another 700 (1400 + 700 > 1500): rejected -> {budget.would_reject(shop, 700)}")

    print("\n== Owner revokes the agent (kill switch) — further pays fail on chain ==")
    budget.revoke()
    reason = budget.would_reject(shop, 100)
    print(f"  pay after revoke: {'rejected -> ' + reason if reason else 'UNEXPECTEDLY ACCEPTED'}")

    print("\n== Owner withdraws the remaining balance ==")
    remaining = 10_000 - budget.spent          # 10000 funded − 1400 spent = 8600
    budget.withdraw(remaining)
    print(f"  withdrew {remaining} back to owner")

    print(f"\n== Shop received: {c.balance('shop') - shop_before} (expected 1400 = two 700 pays) ==")
    print("== Local ledger rebuilt from on-chain pay events ==")
    for e in budget.ledger:
        print(f"  pay {e.amount} -> {e.merchant[:20]}…  memo={e.memo!r}")


if __name__ == "__main__":
    main()
