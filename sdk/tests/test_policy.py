from agentpay.models import SessionPolicy
from agentpay.policy import PolicyEngine


def test_per_tx_cap():
    p = SessionPolicy(per_tx_cap=100, session_cap=1000)
    e = PolicyEngine(p, [])
    assert e.evaluate("payee", 100).allowed
    d = e.evaluate("payee", 101)
    assert not d.allowed and "per-tx cap" in d.reasons[0]


def test_session_cap_accumulates():
    p = SessionPolicy(per_tx_cap=100, session_cap=150)
    ledger: list = []
    e = PolicyEngine(p, ledger)
    d1 = e.evaluate("payee", 100)
    assert d1.allowed
    e.record(100)
    d2 = e.evaluate("payee", 60)
    assert not d2.allowed  # 100 + 60 > 150


def test_allowlist():
    p = SessionPolicy(per_tx_cap=100, session_cap=100, allowlist=frozenset({"a"}))
    e = PolicyEngine(p, [])
    assert e.evaluate("a", 10).allowed
    assert not e.evaluate("b", 10).allowed


def test_expiry(monkeypatch):
    now = [1000.0]
    p = SessionPolicy(per_tx_cap=100, session_cap=100, expires_at=1000.0)
    e = PolicyEngine(p, [], clock=lambda: now[0])
    assert not e.evaluate("a", 10).allowed
    now[0] = 999.0
    assert e.evaluate("a", 10).allowed


def test_daily_cap_window():
    t = [0.0]
    p = SessionPolicy(per_tx_cap=1000, session_cap=1000, daily_cap=50)
    ledger: list = []
    e = PolicyEngine(p, ledger, clock=lambda: t[0])
    e.record(40)
    assert not e.evaluate("a", 20).allowed   # 40+20 > 50 within 24h
    t[0] = 86_401.0                          # a day later, old entry falls out of window
    assert e.evaluate("a", 20).allowed


def test_rate_limit():
    t = [0.0]
    p = SessionPolicy(per_tx_cap=10, session_cap=1000, max_tx_per_hour=2)
    ledger: list = []
    e = PolicyEngine(p, ledger, clock=lambda: t[0])
    e.record(1)
    e.record(1)
    assert not e.evaluate("a", 1).allowed
    t[0] = 3601.0
    assert e.evaluate("a", 1).allowed


def test_non_positive_amount_rejected():
    p = SessionPolicy(per_tx_cap=10, session_cap=10)
    e = PolicyEngine(p, [])
    assert not e.evaluate("a", 0).allowed
    assert not e.evaluate("a", -5).allowed
