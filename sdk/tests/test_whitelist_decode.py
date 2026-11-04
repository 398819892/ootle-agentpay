"""read_onchain_state must expose the merchant whitelist DECODED to `component_…` addresses (what
the validator enforces), alongside the raw CBOR form. The MCP's list_merchants / get_budget_status
rely on this so agents see the real on-chain whitelist instead of a client-configured display copy.
"""
from __future__ import annotations

from agentpay.onchain import _parse_budget_state

TAG_COMPONENT = 128


def _addr(hex64: str) -> dict:
    return {"@cbor": "tag", "tag": TAG_COMPONENT, "value": {"@cbor": "bytes", "hex": hex64}}


def _state(whitelist_hexes: list[str], revoked: bool = False) -> list:
    # positional AgentBudget state: [vault, owner_badge, agent_badge, per_tx, daily, spent,
    #                                window_start, epochs, merchant_whitelist, revoked, revoked_sessions]
    return [
        _addr("ab" * 32), _addr("11" * 32), _addr("22" * 32),
        1000, 1500, 1497, 2, 10,
        [_addr(h) for h in whitelist_hexes],
        revoked, [],
    ]


def test_whitelist_decoded_to_component_addresses():
    out = _parse_budget_state(_state(["12" * 32, "dd" * 32]))
    assert out["whitelist"] == ["component_" + "12" * 32, "component_" + "dd" * 32]
    # the raw CBOR form is preserved for callers that want it
    assert isinstance(out["whitelist_raw"], list) and len(out["whitelist_raw"]) == 2


def test_empty_whitelist_decodes_to_empty_list():
    out = _parse_budget_state(_state([]))
    assert out["whitelist"] == []
