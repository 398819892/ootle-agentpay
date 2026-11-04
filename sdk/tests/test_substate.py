"""#16 + #1: the MCP/SDK must read spend from the chain, not a local estimate.

Two readers are covered:
  * `_parse_budget_state` — the POSITIONAL component-state decoder (a 1:1 port of the web
    reconciler's substate.js parseBudgetState; reads by explicit index + type, loud-fails on drift).
  * `_parse_info_payload` / `read_info` — the NAME-keyed `get_info` info-event decoder (#1). Because
    it reads by field name, it catches a same-type field swap that the positional reader cannot see.
`read_onchain_state` prefers the name-keyed read and falls back to the positional one.
Also covers `_created_component` (#2): locating the new component from the `std.component.created`
event rather than guessing "the first unknown component address".
"""
import pytest

from agentpay.onchain import (
    OnChainBudget,
    _parse_budget_state,
    _parse_info_payload,
    _created_component,
)


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


def _info_payload() -> dict:
    # The name-keyed payload of the `AgentBudget.info` event (every value is a string).
    return {"revoked": "false", "balance": "5000", "per_tx_cap": "1000", "daily_cap": "1500",
            "spent_in_window": "250", "window_start_epoch": "2", "epochs_per_window": "100"}


# --- positional decoder (#16) ---------------------------------------------------------------

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


def test_positional_read_cannot_catch_a_same_type_swap():
    # This documents the GAP that #1 closes: per_tx_cap[3] and daily_cap[4] are both ints, so swapping
    # their declaration order in the component struct makes the positional reader return them swapped
    # with NO error. (The name-keyed info read below is immune.)
    s = _valid_state(); s[3], s[4] = s[4], s[3]
    p = _parse_budget_state(s)
    assert p["per_tx_cap"] == 3000 and p["daily_cap"] == 1000  # silently wrong, no raise


# --- name-keyed info decoder (#1) -----------------------------------------------------------

def test_info_payload_decodes_by_name():
    info = _parse_info_payload(_info_payload())
    assert info == {"revoked": False, "balance": 5000, "per_tx_cap": 1000, "daily_cap": 1500,
                    "spent_in_window": 250, "window_start_epoch": 2, "epochs_per_window": 100}


def test_info_payload_is_order_independent():
    # Reading by NAME means dict order is irrelevant — a struct-order swap of two same-type fields
    # cannot corrupt the result (the whole point of #1 vs the positional reader).
    reordered = dict(reversed(list(_info_payload().items())))
    info = _parse_info_payload(reordered)
    assert info["per_tx_cap"] == 1000 and info["daily_cap"] == 1500


def test_info_payload_type_checks_raise():
    base = _info_payload()
    d = dict(base); del d["per_tx_cap"]
    with pytest.raises(ValueError):
        _parse_info_payload(d)
    d = dict(base); d["daily_cap"] = "abc"
    with pytest.raises(ValueError):
        _parse_info_payload(d)
    d = dict(base); d["revoked"] = "maybe"
    with pytest.raises(ValueError):
        _parse_info_payload(d)


# --- component discovery (#2) ---------------------------------------------------------------

def test_created_component_from_event():
    tmpl = "template_" + "ab" * 32
    result = {"result": {"events": [
        {"topic": "std.resource.create", "substate_id": "resource_" + "11" * 32,
         "template_address": "ab" * 32, "payload": {}},
        {"topic": "std.component.created", "substate_id": "component_" + "cd" * 32,
         "template_address": "ab" * 32, "payload": {}},
        {"topic": "std.component.created", "substate_id": "component_" + "ef" * 32,
         "template_address": "99" * 32, "payload": {}},  # a different template — must be ignored
    ]}}
    assert _created_component(result, tmpl) == "component_" + "cd" * 32
    assert _created_component({"result": {"events": []}}, tmpl) is None


# --- read_onchain_state: prefers info, falls back to positional ------------------------------

class _StubClient:
    """walletd stub: `get_substate` returns a positional state; `dry_run` returns a get_info result
    carrying an `info` event (or none, to exercise the positional fallback)."""
    def __init__(self, state=None, info_payload=None):
        self._state = state
        self._info_payload = info_payload

    def get_substate(self, _sid):
        return {"substate": {"Component": {"body": {"state": self._state}}}}

    def dry_run(self, _manifest, _variables):
        events = []
        if self._info_payload is not None:
            events = [{"topic": "AgentBudget.info", "payload": self._info_payload}]
        return {"result": {"finalize": {"events": events}}}


def test_read_onchain_state_prefers_info_event():
    b = OnChainBudget(client=_StubClient(state=_valid_state(), info_payload=_info_payload()),
                      budget_template="t", owner_account="o", component="component_" + "c" * 64)
    st = b.read_onchain_state()
    assert st["spent_in_window"] == 250     # from the info event (positional would be 500)
    assert st["per_tx_cap"] == 1000
    assert st["epochs_per_window"] == 100
    assert st["balance"] == 5000            # only the info path exposes balance
    assert st["daily_cap_worst_case"] == 2 * st["daily_cap"] == 3000  # fixed-window ~2x ceiling


def test_read_onchain_state_falls_back_to_positional():
    # No info event in the dry-run result -> read_info raises -> positional read is used.
    b = OnChainBudget(client=_StubClient(state=_valid_state(), info_payload=None),
                      budget_template="t", owner_account="o", component="component_" + "c" * 64)
    st = b.read_onchain_state()
    assert st["spent_in_window"] == 500     # the positional value
    assert "balance" not in st              # the positional path has no balance field
    assert st["daily_cap_worst_case"] == 2 * st["daily_cap"] == 6000  # fixed-window ~2x ceiling


def test_read_onchain_state_without_component_raises():
    from agentpay.errors import ChainError
    b = OnChainBudget(client=_StubClient(state=_valid_state()), budget_template="t", owner_account="o")
    with pytest.raises(ChainError):
        b.read_onchain_state()
