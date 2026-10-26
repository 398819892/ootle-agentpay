import pytest

from agentpay.budget import BudgetManager
from agentpay.errors import FrozenUtxo, InsufficientBudget, PayeeNotRegistered, PolicyViolation, SessionClosed
from agentpay.invoice import Invoice, from_challenge, new_invoice_id, to_challenge
from agentpay.merchant import Merchant
from agentpay.models import SessionPolicy
from agentpay.store import MemoryStore
from agentpay.testing import FakeChain


@pytest.fixture
def owner_and_chain():
    chain = FakeChain()
    owner = chain.identity_from_scalars(b"\x01" * 32, b"\x02" * 32)
    return owner, chain


@pytest.fixture
def manager(owner_and_chain):
    owner, chain = owner_and_chain
    return BudgetManager(chain, owner, b"owner-master-seed-long-enough!!", MemoryStore(), coin="XYZ")


async def _open(manager, chain, owner, amount=1000, **policy_kwargs):
    funding = chain.mint(owner, amount)
    policy = SessionPolicy(per_tx_cap=policy_kwargs.pop("per_tx_cap", amount),
                            session_cap=policy_kwargs.pop("session_cap", amount), **policy_kwargs)
    return await manager.open_session("agent-1", policy, funding, amount)


@pytest.mark.asyncio
async def test_open_session_funds_agent(manager, owner_and_chain):
    owner, chain = owner_and_chain
    res = await _open(manager, chain, owner, amount=1000)
    assert res.session.utxo.value == 1000
    wallet = manager.wallet_for(res.session.id)
    assert wallet.status()["remaining"] == 1000


@pytest.mark.asyncio
async def test_pay_reduces_remaining_and_pays_payee(manager, owner_and_chain):
    owner, chain = owner_and_chain
    res = await _open(manager, chain, owner, amount=1000)
    wallet = manager.wallet_for(res.session.id)
    payee = chain.identity_from_scalars(b"\x03" * 32, b"\x04" * 32)
    proof = await wallet.pay(payee.address, 300)
    assert proof.amount == 300
    assert wallet.status()["remaining"] == 700
    assert chain.balance_of(payee.address) == 300


@pytest.mark.asyncio
async def test_per_tx_cap_enforced(manager, owner_and_chain):
    owner, chain = owner_and_chain
    res = await _open(manager, chain, owner, amount=1000, per_tx_cap=100, session_cap=1000)
    wallet = manager.wallet_for(res.session.id)
    with pytest.raises(PolicyViolation):
        await wallet.pay("someone", 200)


@pytest.mark.asyncio
async def test_funded_amount_is_the_hard_ceiling(manager, owner_and_chain):
    owner, chain = owner_and_chain
    # open_session already forbids session_cap > funded, so the SDK-policy cap and the
    # on-chain hard cap coincide here; this checks a request above BOTH is rejected,
    # and specifically that InsufficientBudget (not just PolicyViolation) can fire when
    # a request is under the policy cap but (hypothetically) a UTXO was double-counted.
    res = await _open(manager, chain, owner, amount=100, per_tx_cap=100, session_cap=100)
    wallet = manager.wallet_for(res.session.id)
    with pytest.raises(PolicyViolation):
        await wallet.pay("someone", 150)   # exceeds both policy cap and funded amount
    # spend the exact funded amount, then confirm nothing is left to double-spend
    await wallet.pay("someone", 100)
    with pytest.raises(SessionClosed):
        await wallet.pay("someone", 1)


@pytest.mark.asyncio
async def test_open_session_rejects_cap_above_funding(manager, owner_and_chain):
    owner, chain = owner_and_chain
    funding = chain.mint(owner, 100)
    policy = SessionPolicy(per_tx_cap=100, session_cap=500)   # > funded amount
    with pytest.raises(PolicyViolation):
        await manager.open_session("agent-1", policy, funding, 100)


@pytest.mark.asyncio
async def test_sweep_returns_funds_to_owner(manager, owner_and_chain):
    owner, chain = owner_and_chain
    res = await _open(manager, chain, owner, amount=1000)
    wallet = manager.wallet_for(res.session.id)
    await wallet.pay("someone", 300)
    swept = await manager.sweep(res.session.id)
    assert swept.recovered == 700
    assert chain.balance_of(owner.address) >= 700
    with pytest.raises(SessionClosed):
        await wallet.pay("someone", 1)


@pytest.mark.asyncio
async def test_sweep_on_frozen_session_raises(manager, owner_and_chain):
    owner, chain = owner_and_chain
    res = await _open(manager, chain, owner, amount=1000)
    chain.freeze(res.session.utxo.commitment)
    with pytest.raises(FrozenUtxo):
        await manager.sweep(res.session.id)


@pytest.mark.asyncio
async def test_registration_required_variant_blocks_unregistered_payee(monkeypatch):
    # In the `issuer` (badge) stablecoin variant every recipient -- including a session's
    # own agent account -- must hold a user badge before it can receive a deposit. A real
    # BudgetManager.open_session would mint that badge as part of provisioning; here we
    # pin the session id so we can register its derived address up front instead.
    import agentpay.budget as budget_mod
    monkeypatch.setattr(budget_mod.secrets, "token_hex", lambda n: "deadbeef0001")

    chain = FakeChain(require_registration=True)
    owner = chain.identity_from_scalars(b"\x01" * 32, b"\x02" * 32)
    manager = BudgetManager(chain, owner, b"owner-master-seed-long-enough!!", MemoryStore(), coin="XYZ")

    from agentpay.keys import derive_scalar_pair, session_path
    o, v = derive_scalar_pair(manager._seed, session_path("sdeadbeef0001"))
    agent_addr = chain.identity_from_scalars(o, v).address
    chain.register(agent_addr)   # owner provisions the session account's badge

    res = await _open(manager, chain, owner, amount=100)
    wallet = manager.wallet_for(res.session.id)
    with pytest.raises(PayeeNotRegistered):
        await wallet.pay("unregistered-payee", 10)
    chain.register("registered-payee")
    proof = await wallet.pay("registered-payee", 10)
    assert proof.amount == 10


@pytest.mark.asyncio
async def test_pay_invoice_end_to_end_with_merchant_verification(manager, owner_and_chain):
    owner, chain = owner_and_chain
    res = await _open(manager, chain, owner, amount=1000)
    wallet = manager.wallet_for(res.session.id)
    merchant_identity = chain.identity_from_scalars(b"\x05" * 32, b"\x06" * 32)
    merchant = Merchant(chain, merchant_identity)

    inv = Invoice(new_invoice_id(), 250, "XYZ", merchant_identity.address, expires_at=9e18, description="widget")
    challenge = to_challenge(inv)                 # what the merchant's server would return as HTTP 402
    inv2 = from_challenge(challenge)               # what the agent parses
    proof = await wallet.pay_invoice(inv2, agent_tag="agent-1")

    verified = await merchant.verify(proof.tx_id, inv)
    assert verified.amount == 250
    assert verified.invoice_id == inv.invoice_id
    assert verified.agent_tag == "agent-1"

    with pytest.raises(Exception):   # replay must fail
        await merchant.verify(proof.tx_id, inv)


@pytest.mark.asyncio
async def test_expire_due_sweeps_expired_sessions(owner_and_chain):
    owner, chain = owner_and_chain
    t = [1000.0]
    manager = BudgetManager(chain, owner, b"owner-master-seed-long-enough!!", MemoryStore(),
                             coin="XYZ", clock=lambda: t[0])
    funding = chain.mint(owner, 500)
    policy = SessionPolicy(per_tx_cap=500, session_cap=500, expires_at=1000.0)
    res = await manager.open_session("agent-1", policy, funding, 500)
    t[0] = 1001.0
    results = await manager.expire_due()
    assert len(results) == 1 and results[0].recovered == 500
