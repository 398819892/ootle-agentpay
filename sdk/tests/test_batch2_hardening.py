"""Batch-2 hardening regressions (6th-round review). No live chain — a fake walletd stands in.

Covers:
- ``_check_u64``: ``epochs_per_window`` (and any ``…u64`` field) is validated before it is spliced
  into a manifest, so a negative / NaN / out-of-range value fails early with a clear error instead of
  producing ``-5u64`` / ``NaNu64`` that only the manifest parser would reject.
- N-5 bare-string ``error`` shapes on reads: ``create_account`` / ``get_substate`` read the message
  through ``_err_message`` so a daemon that returns ``{"error": "<string>"}`` raises a clean
  ``ChainError`` rather than TypeError/AttributeError.
- Per-instance concurrency: ``@_synchronized`` serializes owner mutations / pay on ONE budget so two
  threads cannot interleave and corrupt the local mirror (the chain is still the cap authority).
"""
from __future__ import annotations

import threading
import time

import pytest

from agentpay.errors import ChainError
from agentpay.onchain import OnChainBudget, WalletdClient, _check_u64

TPL = "template_" + "7" * 64
OWNER = "component_" + "9" * 64
SHOP = "component_" + "1" * 64
OWNER_BADGE = "resource_" + "a" * 64
AGENT_BADGE = "resource_" + "b" * 64


class _FakeWalletd(WalletdClient):
    """Accepts every manifest; records nothing. Subclasses override one method per test."""

    def __init__(self):
        super().__init__("http://fake")
        self._token = "fake"

    def run(self, manifest, variables, max_fee=200_000):
        return {"result": {"Accept": {}}}


def _opened_budget(client: WalletdClient | None = None) -> OnChainBudget:
    b = OnChainBudget(client or _FakeWalletd(), TPL, OWNER)
    b.component = "component_" + "c" * 64
    b.owner_badge, b.agent_badge = OWNER_BADGE, AGENT_BADGE
    b.per_tx_cap, b.daily_cap, b.whitelist = 1_000, 3_000, [SHOP]
    return b


# -- _check_u64 ------------------------------------------------------------------------

@pytest.mark.parametrize("good,expected", [
    (0, "0"), (1, "1"), (48, "48"), ("100", "100"), (2**64 - 1, str(2**64 - 1)), (" 7 ", "7"),
])
def test_check_u64_accepts_nonneg_integers(good, expected):
    assert _check_u64(good, "epochs_per_window") == expected


@pytest.mark.parametrize("bad", [-1, True, False, 2**64, "4o", "-5", "", 1.5, float("nan"), None])
def test_check_u64_rejects_bad(bad):
    with pytest.raises(ChainError):
        _check_u64(bad, "epochs_per_window")


def test_open_rejects_bad_epochs_before_submitting():
    calls = []
    client = _FakeWalletd()
    client.run = lambda *a, **k: calls.append(a) or {"result": {"Accept": {}}}  # type: ignore[assignment]
    b = OnChainBudget(client, TPL, OWNER)
    with pytest.raises(ChainError):
        b.open(fund=1_000, per_tx_cap=100, daily_cap=500, epochs_per_window=-1, whitelist=[SHOP])
    assert calls == []   # rejected while building the manifest — nothing was submitted


def test_set_window_rejects_bad_epochs():
    b = _opened_budget()
    with pytest.raises(ChainError):
        b.set_window(2**64)   # out of u64 range


# -- N-5: bare-string error on reads does not crash ------------------------------------

def test_get_substate_bare_string_error_raises_chainerror():
    class W(_FakeWalletd):
        def _rpc(self, method, params):
            return {"error": "substate component_… does not exist"}   # bare string, no {code,message}
    with pytest.raises(ChainError) as ei:
        W().get_substate("component_" + "c" * 64)
    assert "does not exist" in str(ei.value)   # the message surfaced, not a TypeError/AttributeError


def test_create_account_bare_string_error_raises_chainerror():
    class W(_FakeWalletd):
        def _rpc(self, method, params):
            return {"error": "account name already in use"}
    with pytest.raises(ChainError) as ei:
        W().create_account("dup")
    assert "already in use" in str(ei.value)


# -- concurrency: owner mutations on one instance are serialized -----------------------

def test_owner_mutations_serialized_on_one_instance():
    """Two threads mutating the SAME budget must not have their on-chain calls overlap — the
    per-instance lock serializes them, so the local whitelist mirror ends consistent."""
    state = {"active": 0, "max": 0}
    guard = threading.Lock()

    class W(_FakeWalletd):
        def run(self, manifest, variables, max_fee=200_000):
            with guard:
                state["active"] += 1
                state["max"] = max(state["max"], state["active"])
            time.sleep(0.03)   # widen the window a lone-lock test would catch
            with guard:
                state["active"] -= 1
            return {"result": {"Accept": {}}}

    b = OnChainBudget(W(), TPL, OWNER)
    b.component = "component_" + "c" * 64
    b.owner_badge = OWNER_BADGE
    m1, m2 = "component_" + "1" * 64, "component_" + "2" * 64
    threads = [threading.Thread(target=b.add_merchant, args=(m1,)),
               threading.Thread(target=b.add_merchant, args=(m2,))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert state["max"] == 1              # never two concurrent on-chain calls on one budget
    assert set(b.whitelist) == {m1, m2}   # both local-mirror appends survived the race
