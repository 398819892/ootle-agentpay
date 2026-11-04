"""#3 — the MCP backend's up-front dry-run preflight must treat a transient failure as "no verdict",
not as a rejection.

``pay_merchant`` asks the validator (a dry run) before submitting. If that dry run could not reach a
verdict (indexer / transport hiccup — ``would_reject`` raises a ``transient``-flagged ChainError),
the backend must SKIP the preflight and let the real submit be the authority — never report the
agent a phantom ``rejected_by validator`` for an infra blip. A non-transient failure (e.g. auth) is
surfaced. ``status()``'s revoke probe must likewise swallow a transient failure without crashing and
without asserting "not revoked".

Stubs the SDK budget so no chain / network is needed.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.abspath(os.path.join(HERE, ".."))
SDK_SRC = os.path.abspath(os.path.join(HERE, "..", "..", "..", "sdk", "src"))
for p in (PKG_ROOT, SDK_SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

import pytest  # noqa: E402

from agentpay.errors import ChainError  # noqa: E402
from agentpay_mcp import backend  # noqa: E402

MERCHANT = "component_" + "1" * 64


def _transient() -> ChainError:
    e = ChainError("could not verify with the validator (transient): did not respond within 30s")
    e.transient = True
    return e


class StubBudget:
    """would_reject behaviour is scripted; pay records that it was reached and returns a chain event."""

    def __init__(self, would_reject_exc=None, would_reject_val=None, pay_exc=None):
        self.component = "component_" + "c" * 64
        self.spent = 0
        self.client = None
        self._wr_exc = would_reject_exc
        self._wr_val = would_reject_val
        self._pay_exc = pay_exc
        self.pay_called = False

    def would_reject(self, *_a, **_k):
        if self._wr_exc is not None:
            raise self._wr_exc
        return self._wr_val

    def pay(self, *_a, **_k):
        self.pay_called = True
        if self._pay_exc is not None:
            raise self._pay_exc
        return {"result": {"events": [{"amount": 10, "spent_in_window": 10}]}}

    def read_onchain_state(self):
        return {"spent_in_window": 10, "daily_cap": 2000, "per_tx_cap": 1000,
                "window_start_epoch": 0, "epochs_per_window": 10, "revoked": False,
                "whitelist": [MERCHANT]}


def _wallet(bud: StubBudget) -> backend.AgentWallet:
    return backend.AgentWallet(bud, per_tx_cap=1000, daily_cap=2000, whitelist=[MERCHANT])


def test_transient_preflight_falls_through_to_real_submit():
    bud = StubBudget(would_reject_exc=_transient())
    r = _wallet(bud).pay_merchant(MERCHANT, 10)
    assert bud.pay_called is True          # preflight was skipped, real submit ran
    assert r.ok is True and r.status == "accepted"


def test_transient_preflight_then_pending_submit_is_pending_not_rejected():
    pend = ChainError("submit may or may not have landed")
    pend.pending = True
    pend.tx_id = "txT"
    bud = StubBudget(would_reject_exc=_transient(), pay_exc=pend)
    r = _wallet(bud).pay_merchant(MERCHANT, 10)
    assert r.ok is None and r.status == "pending"   # never a phantom "rejected"
    assert r.tx_id == "txT"


def test_genuine_reject_still_rejected_without_submitting():
    bud = StubBudget(would_reject_val="amount exceeds the per-transaction cap")
    r = _wallet(bud).pay_merchant(MERCHANT, 10)
    assert bud.pay_called is False         # a real verdict short-circuits the submit
    assert r.ok is False and r.status == "rejected"
    assert "per-transaction cap" in (r.reason or "")


def test_non_transient_preflight_failure_is_surfaced():
    auth = ChainError("walletd HTTP 401")
    auth.auth_failed = True                # not flagged transient
    bud = StubBudget(would_reject_exc=auth)
    with pytest.raises(ChainError):
        _wallet(bud).pay_merchant(MERCHANT, 10)
    assert bud.pay_called is False


def test_status_probe_swallows_transient_without_crashing():
    bud = StubBudget(would_reject_exc=_transient())
    out = _wallet(bud).status()
    assert out["revoked"] is False          # inconclusive probe is not read as revoked, and no crash
    assert out["spent_source"] == "chain"
