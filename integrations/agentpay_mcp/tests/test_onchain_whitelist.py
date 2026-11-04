"""list_merchants / get_budget_status must report the ON-CHAIN whitelist (what the validator
enforces at pay time), never the client-configured `whitelist` — which is display-only and usually
empty, so reporting it made agents wrongly conclude "no merchants, can't pay" even though the chain
had merchants whitelisted.

When the component state can't be read, the whitelist is reported as `unknown` (None), not as the
configured copy — a stale/config value must never masquerade as a live chain read.

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

CONFIGURED = "component_" + "f" * 64        # the client-configured whitelist entry (display-only)
M1 = "component_" + "1" * 64                # on-chain whitelisted merchants
M2 = "component_" + "2" * 64


class StubBudget:
    def __init__(self, chain=None, chain_exc=None, wr_val=None, wr_exc=None):
        self.component = "component_" + "c" * 64
        self.spent = 0
        self.client = None
        self._chain = chain
        self._chain_exc = chain_exc
        self._wr_val = wr_val
        self._wr_exc = wr_exc

    def read_onchain_state(self):
        if self._chain_exc is not None:
            raise self._chain_exc
        return self._chain

    def would_reject(self, *_a, **_k):
        if self._wr_exc is not None:
            raise self._wr_exc
        return self._wr_val


def _chain(whitelist, revoked=False):
    return {"spent_in_window": 100, "daily_cap": 1500, "per_tx_cap": 1000,
            "window_start_epoch": 2, "epochs_per_window": 10, "revoked": revoked,
            "whitelist": list(whitelist)}


def _wallet(bud: StubBudget) -> backend.AgentWallet:
    # configured whitelist deliberately DIFFERENT from the chain's, to prove it is not used
    return backend.AgentWallet(bud, per_tx_cap=1000, daily_cap=1500, whitelist=[CONFIGURED])


def test_list_merchants_reads_chain_not_config():
    bud = StubBudget(chain=_chain([M1, M2]))
    assert _wallet(bud).list_merchants() == [M1, M2]   # the chain list, not [CONFIGURED]


def test_list_merchants_empty_chain_is_empty_even_if_config_has_entries():
    bud = StubBudget(chain=_chain([]))
    assert _wallet(bud).list_merchants() == []


def test_list_merchants_chain_error_propagates():
    bud = StubBudget(chain_exc=ChainError("component unavailable"))
    with pytest.raises(ChainError):
        _wallet(bud).list_merchants()                  # server layer turns this into a structured error


def test_status_whitelist_from_chain():
    bud = StubBudget(chain=_chain([M1, M2]))
    out = _wallet(bud).status()
    assert out["whitelist"] == [M1, M2]
    assert out["whitelist_source"] == "chain"
    assert out["spent_source"] == "chain"


def test_status_whitelist_unknown_on_chain_error_not_config():
    bud = StubBudget(chain_exc=ChainError("component unavailable"))
    out = _wallet(bud).status()
    assert out["whitelist"] is None                    # unknown, NOT [CONFIGURED]
    assert out["whitelist_source"] == "unknown"
    assert out["spent_source"] == "unknown"


def test_status_revoked_probe_uses_chain_whitelist():
    # revoked flag is False on chain, but a dry-run probe against an on-chain merchant is refused
    # for revocation -> status must surface revoked True (the probe now has a merchant to try).
    bud = StubBudget(chain=_chain([M1]), wr_val="budget revoked (kill switch)")
    out = _wallet(bud).status()
    assert out["revoked"] is True
