"""Property-based stress test of the on-chain AgentBudget against a live swarm.

Opens a budget, then fires a stream of RANDOM payments (random merchants — some not whitelisted —
and random amounts, some over the caps). For each one it asks the validator (`would_reject`) and
compares the answer to an independent reference model of the rules. Every accepted payment is then
really executed so the on-chain `spent` advances in lockstep with the model.

The invariant under test: **the chain accepts a payment iff the rules allow it** — no client can
make it accept more, and it never wrongly rejects an allowed one. Any mismatch is a bug and is
reported. This is the "randomised listings / payments" stress the launch plan asks for, bounded to
a burst you can watch (raise ROUNDS / point at a long-running swarm for a soak test).

    PYTHONPATH=src python examples/stress_devnet.py [ROUNDS] [AGENT_BUDGET_TEMPLATE_ADDRESS]
"""
from __future__ import annotations

import os
import random
import sys

from agentpay.errors import ChainError
from agentpay.onchain import OnChainBudget, WalletdClient

ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 20
TEMPLATE = (sys.argv[2] if len(sys.argv) > 2 else None) or os.environ.get("BUDGET_TEMPLATE") \
    or "template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97"

PER_TX = 1_000
DAILY = 6_000


def ensure(c: WalletdClient, name: str) -> str:
    try:
        return c.account_address(name)
    except ChainError:
        addr = c.create_account(name)
        c.fund(name)
        return addr


def main() -> None:
    rng = random.Random(1234)   # deterministic run
    c = WalletdClient().connect()
    owner = c.account_address("default")
    shops = [ensure(c, f"stress_shop{i}") for i in range(2)]      # whitelisted merchants
    rogue = ensure(c, "stress_rogue")                            # NOT whitelisted
    merchants = shops + [rogue]

    print(f"opening budget: per_tx={PER_TX} daily={DAILY} whitelist={len(shops)} shops; rounds={ROUNDS}")
    b = OnChainBudget(c, TEMPLATE, owner).open(
        fund=1_000_000, per_tx_cap=PER_TX, daily_cap=DAILY, epochs_per_window=10_000, whitelist=shops,
    )

    model_spent = 0
    mismatches = 0
    accepted = rejected = 0
    for n in range(1, ROUNDS + 1):
        merchant = rng.choice(merchants)
        amount = rng.randint(1, PER_TX + 500)        # sometimes over the per-tx cap
        allowed = (merchant in shops) and (0 < amount <= PER_TX) and (model_spent + amount <= DAILY)

        reason = b.would_reject(merchant, amount)    # ask the validator
        chain_allows = reason is None
        ok = (chain_allows == allowed)
        if not ok:
            mismatches += 1
            print(f"  [{n:02}] MISMATCH merchant={'shop' if merchant in shops else 'rogue'} "
                  f"amount={amount} model={'allow' if allowed else 'deny'} chain={'allow' if chain_allows else 'deny'} ({reason})")
        if allowed:
            b.pay(merchant, amount, memo=f"ap1|stress{n:04x}|s")   # really execute; advances on-chain spent
            model_spent += amount
            accepted += 1
        else:
            rejected += 1
        tag = "OK " if ok else "BUG"
        print(f"  [{n:02}] {tag} {'shop' if merchant in shops else 'ROGUE'} amount={amount:4} "
              f"-> {'accepted' if allowed else 'rejected: ' + (reason or '')}  spent={model_spent}")

    print(f"\n{ROUNDS} rounds: {accepted} accepted, {rejected} rejected, "
          f"model-vs-chain mismatches = {mismatches}")
    print("PASS — chain enforcement matched the rules on every round" if mismatches == 0
          else f"FAIL — {mismatches} mismatch(es)")
    assert b.spent == model_spent, f"ledger drift: chain-tracked {b.spent} vs model {model_spent}"
    sys.exit(1 if mismatches else 0)


if __name__ == "__main__":
    main()
