"""End-to-end demo against the in-memory FakeChain. No indexer, no network needed.

    python examples/demo_offline.py

Shows: opening a session budget for an agent, the agent paying a per-invoice merchant,
merchant-side verification, the owner sweeping leftover funds (kill switch), and a
privacy report on what the flow actually leaks.
"""
from __future__ import annotations

import asyncio

from agentpay import (
    BudgetManager, Invoice, Merchant, MemoryStore, SessionPolicy,
    from_challenge, new_invoice_id, to_challenge,
)
from agentpay.privacy import assess
from agentpay.testing import FakeChain


async def main() -> None:
    chain = FakeChain()

    owner = chain.identity_from_scalars(b"\x11" * 32, b"\x22" * 32)
    merchant_id = chain.identity_from_scalars(b"\x33" * 32, b"\x44" * 32)
    merchant = Merchant(chain, merchant_id)

    manager = BudgetManager(chain, owner, b"replace-with-a-real-random-master-seed!!", MemoryStore(), coin="USDx-conf")

    print("== Owner funds a $50-cap session for a shopping agent ==")
    funding = chain.mint(owner, 50_000)     # 50_000 base units, e.g. cents
    policy = SessionPolicy(per_tx_cap=20_000, session_cap=50_000, daily_cap=50_000)
    opened = await manager.open_session("shopping-agent", policy, funding, 50_000)
    wallet = manager.wallet_for(opened.session.id)
    print(f"  session={opened.session.id} funded=50000 remaining={wallet.status()['remaining']}")

    print("\n== Merchant issues an invoice (this is what an HTTP 402 body carries) ==")
    inv = Invoice(new_invoice_id(), amount=12_500, coin="USDx-conf",
                  payee=merchant_id.address, expires_at=9e18, description="1x widget")
    challenge = to_challenge(inv)
    print(f"  challenge scheme={challenge['scheme']} amount={challenge['amount']}")

    print("\n== Agent pays the invoice from its private session budget ==")
    agent_side_invoice = from_challenge(challenge)
    proof = await wallet.pay_invoice(agent_side_invoice, agent_tag="shopping-agent")
    print(f"  paid tx={proof.tx_id[:16]}... remaining={proof.remaining}")

    print("\n== Merchant verifies the payment against its own invoice record ==")
    verified = await merchant.verify(proof.tx_id, inv)
    print(f"  verified amount={verified.amount} agent_tag={verified.agent_tag}")

    print("\n== A second, smaller purchase ==")
    inv2 = Invoice(new_invoice_id(), amount=3_000, coin="USDx-conf",
                   payee=merchant_id.address, expires_at=9e18, description="1x sticker")
    proof2 = await wallet.pay_invoice(inv2, agent_tag="shopping-agent")
    await merchant.verify(proof2.tx_id, inv2)
    print(f"  paid tx={proof2.tx_id[:16]}... remaining={proof2.remaining}")

    print("\n== Owner decides to end the session early (kill switch) ==")
    swept = await manager.sweep(opened.session.id)
    print(f"  recovered={swept.recovered} back to owner")

    print("\n== Privacy report for this kind of flow ==")
    report = assess(coin_variant="no_badge", outputs_in_tx=2, is_mint_or_redeem=False)
    print(report.render())
    print(f"\n  worst severity: {report.worst()}")


if __name__ == "__main__":
    asyncio.run(main())
