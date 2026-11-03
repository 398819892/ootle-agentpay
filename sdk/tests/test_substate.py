"""#16: the MCP/SDK must read spend from the chain's component state, not a local estimate.

Covers the positional-state decoder (`_parse_budget_state`) and `OnChainBudget.read_onchain_state`.
The decoder is a 1:1 port of the web reconciler's substate.js parseBudgetState, so these mirror
web/server/substate.test.js: a valid state parses by explicit index, and any layout drift raises
(a loud failure the caller turns into an "unknown", never a silently-wrong number).
"""
import pytest

from agentpay.onchain import OnChainBudget, _parse_budget_state


def _tag(hexpair: str, tag: int = 131) -> dict:
    # A CBOR-tagged address object as walletd returns it: {'tag': .., 'value': {'hex': ..}}.
    return {"tag": tag, "value": {"hex": hexpair * 32}}


def _valid_state() -> list:
    # Struct order: vault, owner_badge, agent_badge, per_tx, daily, spent, window_start, epochs,
    # whitelist, revoked, revoked_sessions. (Mirrors web/server/substate.test.js validState.)
    return [
        _tag("ab", tag=132), _tag("11"), _tag("22"),   # vault (VaultId), owner_badge, agent_badge
        1000, 3000, 500, 10, 48,
        [_tag("cc")], False, [],
    ]


def test_parse_reads_fields_by_index():
    p = _parse_budget_state(_valid_state())
    assert p["per_tx_cap"] == 1000
    assert p["daily_cap"] == 3000
    assert p["spent_in_window"] == 500
    assert p["window_start_epoch"] == 10
    assert p["epochs_per_window"] == 48
    assert p["revoked"] is False
    assert p["vault_hex"] == "ab" * 32
    assert isinstance(p["whitelist_raw"], list) and len(p["whitelist_raw"]) == 1


def test_parse_layout_drift_raises():
    # A bool where per_tx_cap (a number) is expected — must raise, not read True as 1.
    s = _valid_state(); s[3] = True
    with pytest.raises(ValueError):
        _parse_budget_state(s)
    # A non-bool where revoked is expected.
    s = _valid_state(); s[9] = "no"
    with pytest.raises(ValueError):
        _parse_budget_state(s)
    # whitelist slot not an array.
    s = _valid_state(); s[8] = 7
    with pytest.raises(ValueError):
        _parse_budget_state(s)
    # field 0 not an address, too-short, and non-list all raise.
    with pytest.raises(ValueError):
        _parse_budget_state([1, 2, 3, 4, 5, 6, 7, 8, [], False])
    with pytest.raises(ValueError):
        _parse_budget_state([_tag("ab", tag=132), 1, 2])
    with pytest.raises(ValueError):
        _parse_budget_state(None)


class _SubstateClient:
    """Minimal walletd stub: returns a substates.get-shaped result wrapping a given state array."""
    def __init__(self, state):
        self._state = state

    def get_substate(self, _sid):
        return {"substate": {"Component": {"body": {"state": self._state}}}}


def test_read_onchain_state_decodes_from_substate():
    b = OnChainBudget(client=_SubstateClient(_valid_state()), budget_template="t",
                      owner_account="o", component="component_" + "c" * 64)
    st = b.read_onchain_state()
    assert st["spent_in_window"] == 500
    assert st["daily_cap"] == 3000
    assert st["per_tx_cap"] == 1000


def test_read_onchain_state_without_component_raises():
    from agentpay.errors import ChainError
    b = OnChainBudget(client=_SubstateClient(_valid_state()), budget_template="t", owner_account="o")
    with pytest.raises(ChainError):
        b.read_onchain_state()
