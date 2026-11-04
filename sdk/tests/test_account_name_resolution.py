"""Attach-mode account-name resolution: a budget configured with a human account NAME (the default
``agent_account`` is just ``"default"``) must bind the account's *component address* into the pay
manifest's ``agent`` variable, not the bare name. walletd's manifest parser rejects a name there
(``Invalid manifest value 'default'``) on the dry-run preflight, so without this an attach-mode pay
fails before it reaches the validator. An address is passed through untouched; resolutions are cached.

Stubs the client so no chain / network is touched.
"""
from __future__ import annotations

import pytest

from agentpay.errors import ChainError
from agentpay.onchain import OnChainBudget, WalletdClient

MERCHANT = "component_" + "c" * 64
ADDR = "component_" + "d" * 64


class _RecordingClient(WalletdClient):
    """Records the variables handed to ``dry_run`` and scripts ``account_address`` (counting calls)."""

    def __init__(self):
        super().__init__("http://fake")
        self._token = "fake"
        self.lookups = 0
        self.last_vars = None

    def account_address(self, name):  # type: ignore[override]
        self.lookups += 1
        if name == "default":
            return ADDR
        raise ChainError(f"account {name!r} not found")

    def dry_run(self, manifest, variables, max_fee=200_000):  # type: ignore[override]
        self.last_vars = variables
        return {"result": {}}  # no error, not a Reject → accepted


def _budget(client, agent_account) -> OnChainBudget:
    return OnChainBudget(
        client=client, budget_template="template_x",
        owner_account="default", agent_account=agent_account,
        component="component_" + "a" * 64, agent_badge="resource_" + "b" * 64,
    )


def test_name_is_resolved_to_address_in_agent_var():
    c = _RecordingClient()
    b = _budget(c, "default")
    assert b.would_reject(MERCHANT, 1) is None
    assert c.last_vars["agent"] == ADDR      # the ADDRESS, never the bare name "default"
    assert c.lookups == 1


def test_address_is_passed_through_without_a_lookup():
    c = _RecordingClient()
    b = _budget(c, ADDR)                      # already a component address
    assert b.would_reject(MERCHANT, 1) is None
    assert c.last_vars["agent"] == ADDR
    assert c.lookups == 0                     # no accounts.list call needed


def test_resolution_is_cached_across_calls():
    c = _RecordingClient()
    b = _budget(c, "default")
    b.would_reject(MERCHANT, 1)
    b.would_reject(MERCHANT, 2)
    b.would_reject(MERCHANT, 3)
    assert c.lookups == 1                     # resolved once, then served from the cache


def test_unknown_account_name_surfaces_as_config_error_not_transient():
    c = _RecordingClient()
    b = _budget(c, "nope")                    # not a known account, not an address
    with pytest.raises(ChainError) as ei:
        b.would_reject(MERCHANT, 1)
    assert "not found" in str(ei.value)
    assert getattr(ei.value, "transient", False) is False   # must NOT be masked as transient
