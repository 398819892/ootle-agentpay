"""MCP backend: a PENDING (submitted-but-unknown) pay must surface as a third state (ok=None),
never ok=False — so the agent does not blindly re-pay (double-spend). A finalized chain Reject is
ok=False; an accept is ok=True. Plus get_payment_status mapping. (D-1)

Stubs the SDK budget so no chain/network is needed.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.abspath(os.path.join(HERE, ".."))          # integrations/agentpay_mcp
SDK_SRC = os.path.abspath(os.path.join(HERE, "..", "..", "..", "sdk", "src"))
for p in (PKG_ROOT, SDK_SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from agentpay.errors import ChainError  # noqa: E402
from agentpay_mcp import backend  # noqa: E402

MERCHANT = "component_" + "1" * 64


class StubBudget:
    def __init__(self, exc: Exception | None = None, events: list | None = None):
        self.component = "component_" + "c" * 64
        self.spent = 0
        self.client = None
        self._exc = exc
        self._events = events or []

    def would_reject(self, *_a, **_k):
        return None  # dry-run says OK; the real pay below decides

    def pay(self, *_a, **_k):
        if self._exc is not None:
            raise self._exc
        return {"result": {"events": self._events}}


class StubClient:
    def __init__(self, outcome):
        self._outcome = outcome

    def get_result(self, _tx_id):
        return self._outcome


def _wallet(exc=None, events=None) -> backend.AgentWallet:
    return backend.AgentWallet(StubBudget(exc, events), per_tx_cap=1000, daily_cap=2000,
                               whitelist=[MERCHANT])


def test_pending_pay_is_third_state_not_false():
    e = ChainError("did not finalize in time")
    e.pending = True
    e.tx_id = "txP"
    r = _wallet(exc=e).pay_merchant(MERCHANT, 10)
    assert r.ok is None
    assert r.status == "pending"
    assert r.tx_id == "txP"


def test_chain_reject_is_rejected():
    e = ChainError("amount exceeds the per-transaction cap")
    e.chain_rejected = True
    r = _wallet(exc=e).pay_merchant(MERCHANT, 10)
    assert r.ok is False
    assert r.status == "rejected"


def test_accept_is_ok():
    r = _wallet(events=[]).pay_merchant(MERCHANT, 10)
    assert r.ok is True
    assert r.status == "accepted"


def test_policy_violation_is_rejected_not_chain_error():
    # A client-side PolicyViolation from pay() (pre-submit, no funds moved) must surface as a definitive
    # rejection — ok=False, status="rejected" — not fall through to an "error_type: chain_error". (review)
    from agentpay.errors import PolicyViolation
    r = _wallet(exc=PolicyViolation(("amount exceeds the per-transaction cap",))).pay_merchant(MERCHANT, 10)
    assert r.ok is False
    assert r.status == "rejected"
    assert "per-transaction cap" in (r.reason or "")


class _RejectingStubBudget(StubBudget):
    """Dry-run says NO (would_reject returns a reason) — the validator refuses before any submit."""
    def would_reject(self, *_a, **_k):
        return "Amount exceeds the per-transaction cap"


def test_dry_run_reject_status_is_rejected():
    # A dry-run rejection must surface as ok=False AND status="rejected" — not the default
    # status="accepted" (N-4). The MCP tool reports `status`, so an "accepted" label on a
    # validator-rejected pay would tell the agent the payment went through.
    w = backend.AgentWallet(_RejectingStubBudget(), per_tx_cap=1000, daily_cap=2000, whitelist=[MERCHANT])
    r = w.pay_merchant(MERCHANT, 10)
    assert r.ok is False
    assert r.status == "rejected"
    assert "per-transaction cap" in (r.reason or "")


def test_non_integer_amount_status_is_rejected():
    # A non-integer amount is refused before any chain contact; it too must not read "accepted" (N-4).
    r = _wallet().pay_merchant(MERCHANT, "not-a-number")
    assert r.ok is False
    assert r.status == "rejected"


def test_payment_status_maps_three_states():
    w = _wallet()
    w.budget.client = StubClient(("accept", None))
    assert w.payment_status("t")["status"] == "accepted"
    w.budget.client = StubClient(("reject", "no"))
    assert w.payment_status("t")["status"] == "rejected"
    w.budget.client = StubClient(("pending", None))
    assert w.payment_status("t")["status"] == "pending"


# -- status() reads spend from chain, falls back to "unknown" — never a local estimate (#16) --------
class _StatusBudget:
    """A budget whose on-chain read is controllable. `spent` is a LOCAL estimate that status() must
    never leak into the reported figure."""
    def __init__(self, state=None, exc=None):
        self.component = "component_" + "c" * 64
        self.spent = 999            # stale local estimate — must NOT appear in status output
        self.client = None
        self._state = state
        self._exc = exc

    def would_reject(self, *_a, **_k):
        return None                 # kill-switch probe says not revoked

    def read_onchain_state(self):
        if self._exc is not None:
            raise self._exc
        return self._state


def test_status_reads_spent_from_chain_not_local_estimate():
    chain = {"per_tx_cap": 1000, "daily_cap": 3000, "spent_in_window": 500,
             "window_start_epoch": 10, "epochs_per_window": 48, "whitelist_raw": [], "revoked": False}
    w = backend.AgentWallet(_StatusBudget(state=chain), per_tx_cap=1, daily_cap=1, whitelist=[MERCHANT])
    s = w.status()
    assert s["spent_source"] == "chain"
    assert s["spent_in_window"] == 500          # from chain, not budget.spent (999)
    assert s["remaining_in_window"] == 2500
    assert s["daily_cap"] == 3000 and s["per_tx_cap"] == 1000   # chain caps, not the declared 1
    assert s["caps_source"] == "chain"
    assert s["revoked"] is False


def test_status_unknown_when_chain_unreadable():
    w = backend.AgentWallet(_StatusBudget(exc=ChainError("walletd down")),
                            per_tx_cap=1000, daily_cap=2000, whitelist=[MERCHANT])
    s = w.status()
    assert s["spent_source"] == "unknown"
    assert s["spent_in_window"] is None         # never the local estimate (999)
    assert s["remaining_in_window"] is None
    assert s["daily_cap"] == 2000 and s["caps_source"] == "declared"   # declared caps still shown


def test_status_revoked_from_chain_flag():
    chain = {"per_tx_cap": 1000, "daily_cap": 3000, "spent_in_window": 0,
             "window_start_epoch": 0, "epochs_per_window": 48, "whitelist_raw": [], "revoked": True}
    w = backend.AgentWallet(_StatusBudget(state=chain), per_tx_cap=1, daily_cap=1, whitelist=[MERCHANT])
    assert w.status()["revoked"] is True        # chain flag alone marks it revoked
