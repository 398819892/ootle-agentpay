"""Unit tests for the on-chain adapter (agentpay.onchain).

These do NOT need a live chain: a fake wallet daemon records the manifests the adapter builds and
returns canned results, so we test the adapter's logic — client pre-checks, memo pass-through,
manifest shape and the ledger-from-events decoder — in isolation. The real end-to-end path is
exercised by examples/demo_devnet.py against a swarm.
"""
from __future__ import annotations

import pytest

from agentpay.errors import ChainError, PolicyViolation
from agentpay.onchain import LedgerEntry, OnChainBudget, WalletdClient

TPL = "template_" + "7" * 64
OWNER = "component_" + "9" * 64
SHOP = "component_" + "1" * 64
OTHER = "component_" + "2" * 64
OWNER_BADGE = "resource_" + "a" * 64
AGENT_BADGE = "resource_" + "b" * 64


def _pay_event(merchant: str, amount: int, memo: str, spent: int) -> dict:
    # shaped like a real finalized-tx event: the engine namespaces the topic as "<Struct>.<event>",
    # so a real pay carries "AgentBudget.pay" (NOT a bare "pay"). Appears twice in a real result → de-dup.
    ev = {"topic": "AgentBudget.pay", "substate_id": OWNER,
          "payload": {"amount": str(amount), "memo": memo, "merchant": merchant,
                      "spent_in_window": str(spent)}}
    return {"result": {"events": [ev]},
            "result2": {"Accept": {"receipt": {"events": [ev]}}}}  # second copy, different path


def _component_substate(owner_badge: str, agent_badge: str) -> dict:
    """A minimal AgentBudget component substate shaped like walletd's `substates.get`, with the two
    badge ResourceAddresses in struct order (owner, agent) as CBOR tag-131 entries."""
    def res(addr: str) -> dict:
        return {"@cbor": "tag", "tag": 131, "value": {"@cbor": "bytes", "hex": addr.split("_", 1)[1]}}
    vault = {"@cbor": "tag", "tag": 132, "value": {"@cbor": "bytes", "hex": "ab" * 32}}
    return {"substate_from_remote": {"substate": {"Component": {"body": {"state": [
        vault, res(owner_badge), res(agent_badge), 1000, 3000, 0, 1, 48, [], False, [],
    ]}}}}}


class FakeWalletd(WalletdClient):
    """Records manifests; returns canned results instead of talking to a daemon."""

    def __init__(self):
        super().__init__("http://fake")
        self.runs: list[tuple[str, dict]] = []
        self.next_result: dict = {"result": {"Accept": {}}}
        self.substate: dict = {}

    def connect(self):  # no network
        self._token = "fake"
        return self

    def run(self, manifest, variables, max_fee=200_000):
        self.runs.append((manifest, variables))
        return self.next_result

    def get_substate(self, substate_id):  # canned component state for open()'s badge resolution
        return self.substate

    def dry_run(self, manifest, variables, max_fee=200_000):
        self.runs.append((manifest, variables))
        # walletd surfaces a dry-run rejection as an RPC error whose message is the engine's
        # free-text form; _clean_reason extracts the template's own wording from it.
        return {"error": {"message": "Application error: 5: Dry-run transaction rejected: "
                          "Execution failure (AssertionFailed): At instruction #2: "
                          "Panic! Amount exceeds the per-transaction cap"}}


def _budget(**over) -> OnChainBudget:
    b = OnChainBudget(FakeWalletd().connect(), TPL, OWNER)
    b.component = "component_" + "c" * 64
    b.owner_badge, b.agent_badge = OWNER_BADGE, AGENT_BADGE
    b.per_tx_cap, b.daily_cap, b.whitelist = 1_000, 3_000, [SHOP]
    for k, v in over.items():
        setattr(b, k, v)
    return b


# -- client pre-checks (early, friendly errors) ---------------------------------------

def test_precheck_rejects_over_per_tx_cap():
    b = _budget()
    with pytest.raises(PolicyViolation):
        b.pay(SHOP, 1_500, memo="x")


def test_precheck_rejects_non_whitelisted():
    b = _budget()
    with pytest.raises(PolicyViolation):
        b.pay(OTHER, 100, memo="x")


def test_precheck_rejects_over_daily_cap():
    b = _budget(spent=2_800)
    with pytest.raises(PolicyViolation):
        b.pay(SHOP, 500, memo="x")   # 2800 + 500 > 3000


def test_precheck_rejects_when_revoked():
    b = _budget(revoked=True)
    with pytest.raises(PolicyViolation):
        b.pay(SHOP, 100, memo="x")


def test_precheck_refreshes_stale_caps_from_chain_instead_of_false_rejecting(monkeypatch):
    # Attached with a STALE display daily cap (1500) while the chain's real cap is 15000 (raised on
    # chain after attach). A spend that exceeds the stale cap but fits the real one must NOT be
    # pre-rejected: the pre-check reconciles with the authoritative chain state before rejecting.
    b = _budget(per_tx_cap=1_000, daily_cap=1_500, spent=1_530)
    monkeypatch.setattr(b, "read_onchain_state", lambda: {
        "per_tx_cap": 1_000, "daily_cap": 15_000, "spent_in_window": 1_530,
        "whitelist": [SHOP], "revoked": False})
    b.client.next_result = _pay_event(SHOP, 1, "x", 1_531)
    b.pay(SHOP, 1, memo="x")                 # within the real cap -> accepted, not pre-rejected
    assert b.daily_cap == 15_000             # reconciled from chain
    assert b.spent == 1_531                  # ledger still follows the pay event


def test_precheck_still_rejects_when_chain_confirms_over_cap(monkeypatch):
    # Reconciling with chain must not WEAKEN the check: if the chain's own numbers still say over
    # cap, the client pre-check rejects (early, friendly) exactly as before.
    b = _budget(per_tx_cap=1_000, daily_cap=1_500, spent=1_530)
    monkeypatch.setattr(b, "read_onchain_state", lambda: {
        "per_tx_cap": 1_000, "daily_cap": 1_500, "spent_in_window": 1_530,
        "whitelist": [SHOP], "revoked": False})
    with pytest.raises(PolicyViolation):
        b.pay(SHOP, 1, memo="x")


def test_precheck_keeps_display_copy_when_chain_unreadable(monkeypatch):
    # A read hiccup must never block a pay-by-crash NOR silently pass: it falls back to the display
    # copy (the pre-0.49 offline/mock behaviour), and the chain still enforces on the real submit.
    b = _budget(per_tx_cap=1_000, daily_cap=1_500, spent=1_530)
    def boom():
        raise ChainError("walletd unreachable")
    monkeypatch.setattr(b, "read_onchain_state", boom)
    with pytest.raises(PolicyViolation):
        b.pay(SHOP, 1, memo="x")             # stale 1500 kept -> 1531 > 1500 -> rejected as before


# -- manifest shape + memo pass-through -----------------------------------------------

def test_pay_builds_manifest_with_proof_and_memo():
    b = _budget()
    b.pay(SHOP, 500, memo="ap1|inv1|tag")
    manifest, variables = b.client.runs[-1]
    assert f'create_proof_by_non_fungible_ids(address!("{AGENT_BADGE}"), [non_fungible_id!("default")])' in manifest
    # `pay` takes the session-badge proof as its first arg (so it can identify / refuse a revoked session)
    assert f'budget.pay(proof, address!("{SHOP}"), amount!(500), "ap1|inv1|tag")' in manifest
    assert "drop_all_proofs!();" in manifest
    assert variables == {"agent": OWNER, "budget": b.component}


def test_pay_invoice_passes_invoice_id_as_memo():
    b = _budget()
    b.pay_invoice(merchant=SHOP, invoice_id="deadbeef", amount=200, agent_tag="shopper")
    manifest, _ = b.client.runs[-1]
    assert '"ap1|deadbeef|shopper"' in manifest     # unchanged phase-1 memo codec


def test_pay_ledger_follows_chain_events_and_dedupes():
    b = _budget()
    b.client.next_result = _pay_event(SHOP, 500, "ap1|inv1|tag", 500)
    b.pay(SHOP, 500, memo="ap1|inv1|tag")
    assert b.spent == 500
    assert b.ledger == [LedgerEntry(SHOP, 500, "ap1|inv1|tag", "pay")]   # one entry, not two


# -- event decoder --------------------------------------------------------------------

def test_pay_events_extracts_and_dedupes():
    evs = OnChainBudget.pay_events(_pay_event(SHOP, 700, "ap1|x|y", 700))
    assert evs == [{"amount": "700", "memo": "ap1|x|y", "merchant": SHOP, "spent_in_window": "700"}]


def test_pay_events_empty_on_unrelated_result():
    assert OnChainBudget.pay_events({"result": {"Accept": {"events": [
        {"topic": "pay_fee", "payload": {"amount": 100}}]}}}) == []


def test_pay_events_filters_by_topic_and_keeps_distinct_pays():
    """The namespaced topic filter matches "AgentBudget.pay" (the engine prefixes template events with
    the struct name) and excludes the namespaced "AgentBudget.pay_via_escrow" (same merchant/memo
    shape); the running `spent_in_window` keeps two DISTINCT identical-looking pays while still
    collapsing the duplicate copy of each event across the two result subtrees."""
    pay1 = {"topic": "AgentBudget.pay", "substate_id": OWNER,
            "payload": {"merchant": SHOP, "amount": "100", "memo": "m", "spent_in_window": "100"}}
    pay2 = {"topic": "AgentBudget.pay", "substate_id": OWNER,  # identical except the running total advanced
            "payload": {"merchant": SHOP, "amount": "100", "memo": "m", "spent_in_window": "200"}}
    escrow = {"topic": "AgentBudget.pay_via_escrow", "substate_id": OWNER,
              "payload": {"merchant": SHOP, "amount": "100", "memo": "m", "escrow": "component_x"}}
    evs = [pay1, pay2, escrow]
    result = {"result": {"events": evs}, "result2": {"Accept": {"receipt": {"events": evs}}}}  # each duplicated
    got = OnChainBudget.pay_events(result)
    assert len(got) == 2                                    # two distinct pays, not collapsed to one
    assert {e["spent_in_window"] for e in got} == {"100", "200"}
    assert all("escrow" not in e for e in got)             # the pay_via_escrow event is excluded


# -- open() resolves badges from component state, not address sort order --------------

def test_open_resolves_badges_from_state_not_sort():
    """Regression guard for the on-chain "Proof of resource did not match" bug: open() must read
    which badge is owner vs agent from the component's struct state, never from sorted address order.
    Here the AGENT badge sorts BEFORE the owner badge, so a sort-based guess would swap them and
    `pay` would prove the wrong resource (rejected on chain)."""
    owner_badge = "resource_" + "f" * 64   # sorts AFTER the agent badge
    agent_badge = "resource_" + "a" * 64   # sorts FIRST
    new_comp = "component_" + "c" * 64
    assert sorted([owner_badge, agent_badge]) == [agent_badge, owner_badge]  # sort would mislead

    b = OnChainBudget(FakeWalletd().connect(), TPL, OWNER)
    # The open() run result only needs to surface a new component + two badge resources for the
    # existence guard; the owner/agent *mapping* comes from the component state below.
    b.client.next_result = {"result": {"Accept": {
        "component": new_comp, "owner_badge": owner_badge, "agent_badge": agent_badge}}}
    b.client.substate = _component_substate(owner_badge, agent_badge)

    b.open(fund=5000, per_tx_cap=1000, daily_cap=3000, epochs_per_window=48, whitelist=[SHOP])

    assert b.component == new_comp
    assert b.owner_badge == owner_badge        # struct order, not sort order
    assert b.agent_badge == agent_badge
    # and the pay proof must target the real agent badge (what the template asserts)
    manifest = b._pay_manifest(SHOP, 100, "m")
    assert f'create_proof_by_non_fungible_ids(address!("{agent_badge}"), [non_fungible_id!("default")])' in manifest


# -- would_reject surfaces the validator's reason -------------------------------------

def test_would_reject_returns_clean_onchain_reason():
    b = _budget()
    assert b.would_reject(SHOP, 9_999) == "Amount exceeds the per-transaction cap"


# -- manifest injection guard (issue #7) ----------------------------------------------
# Every value spliced into a manifest string is validated at the lowest layer, so a crafted memo /
# address can never break out of its literal and inject extra manifest instructions. These assert
# the guard rejects such input and NEVER builds a tainted manifest, while leaving normal input alone.

# A memo that tries to close the string literal and append its own instructions (the core attack:
# with a shared owner/agent account these extra lines could move the owner's funds).
_INJECTION_MEMOS = [
    'x"); owner.withdraw(amount!(999999)); agent.deposit(address!("resource_" + "a"*64, memo="',
    'a"); drop_all_proofs!(); budget.pay(proof, address!("component_' + "e" * 64 + '"), amount!(1), "',
    'has a " quote',                 # a lone double-quote would terminate the literal
    "back\\slash",                   # a backslash could start an escape sequence
    "line\nbreak",                   # a newline could smuggle in another manifest statement
    "tab\there",                     # any control char is refused
    "x" * 254,                       # over the 253-byte memo limit
]


@pytest.mark.parametrize("memo", _INJECTION_MEMOS)
def test_pay_rejects_injection_memo(memo):
    b = _budget()
    with pytest.raises(ChainError):
        b.pay(SHOP, 100, memo=memo)                 # rejected before any chain submit
    assert b.client.runs == []                      # and no (tainted) manifest was ever built

    with pytest.raises(ChainError):                 # the low-level builder refuses it directly too
        b._pay_manifest(SHOP, 100, memo)


def test_pay_manifest_rejects_non_hex_merchant():
    b = _budget()
    for bad in ["component_not_hex", "component_" + "a" * 63, "resource_" + "a" * 64,
                'component_' + "a" * 64 + '"); drop_all_proofs!(); //',
                "robert'); DROP", "component_" + "A" * 64,   # uppercase hex is rejected too
                "component_" + "a" * 64 + "\n"]:   # trailing newline must be rejected (fullmatch, not match)
        with pytest.raises(ChainError):
            b._pay_manifest(bad, 100, "ok")


def test_pay_manifest_rejects_bad_amount():
    b = _budget()
    for bad in ["1); drop_all_proofs!(); amount!(1", -5, "1_000", 3.5, "nan"]:
        with pytest.raises(ChainError):
            b._pay_manifest(SHOP, bad, "ok")


def test_open_rejects_injection_in_template_and_whitelist():
    b = OnChainBudget(FakeWalletd().connect(), 'template_x") AS Evil; use template_' + "0" * 64, OWNER)
    with pytest.raises(ChainError):
        b.open(fund=1000, per_tx_cap=100, daily_cap=300, epochs_per_window=48, whitelist=[SHOP])
    assert b.client.runs == []

    b2 = OnChainBudget(FakeWalletd().connect(), TPL, OWNER)
    with pytest.raises(ChainError):                 # a tainted whitelist entry is refused
        b2.open(fund=1000, per_tx_cap=100, daily_cap=300, epochs_per_window=48,
                whitelist=['component_' + "a" * 64 + '"), address!("component_evil'])
    assert b2.client.runs == []


def test_session_label_injection_is_rejected():
    b = _budget()
    for bad in ['default"); revoke(); budget.issue_agent_badge("x', "has space", "a" * 65, "quote\""]:
        with pytest.raises(ChainError):
            b.issue_agent_badge(bad)
        with pytest.raises(ChainError):
            b.revoke_session(bad)
    assert b.client.runs == []                      # nothing reached the daemon


def test_remove_merchant_validates_address_and_mirrors_whitelist():
    for bad in ["component_not_hex", "component_" + "a" * 63, "resource_" + "a" * 64,
                'component_' + "a" * 64 + '"); drop_all_proofs!(); //', ""]:
        b = _budget()
        with pytest.raises(ChainError):
            b.remove_merchant(bad)
        assert b.client.runs == []                  # nothing reached the daemon
        assert b.whitelist == [SHOP]                # untouched on failure

    b = _budget()
    b.remove_merchant(SHOP)
    manifest, variables = b.client.runs[-1]
    assert f'owner.create_proof_for_resource(address!("{OWNER_BADGE}"))' in manifest
    assert f'budget.remove_merchant(address!("{SHOP}"));' in manifest
    assert "drop_all_proofs!();" in manifest
    assert variables == {"owner": OWNER, "budget": b.component}   # component never in the text
    assert b.whitelist == []                        # local mirror follows the accepted call


def test_set_limits_normalises_caps_and_rejects_bad_amounts():
    for p, d in [(-1, 100), (100, -1), (1.5, 100), ("1); drop_all_proofs!(); amount!(1", 100),
                 (100, "1_000"), ("nan", 100), (True, 100)]:
        b = _budget()
        with pytest.raises(ChainError):
            b.set_limits(p, d)
        assert b.client.runs == []
        assert (b.per_tx_cap, b.daily_cap) == (1_000, 3_000)   # untouched on failure

    b = _budget()
    huge = 123456789012345678901234567890             # > 2^63: must stay an exact integer literal
    b.set_limits(250, huge)
    manifest, _ = b.client.runs[-1]
    assert f"budget.set_limits(amount!(250), amount!({huge}));" in manifest
    assert f'owner.create_proof_for_resource(address!("{OWNER_BADGE}"))' in manifest
    assert (b.per_tx_cap, b.daily_cap) == (250, huge)

    b.set_limits("7", 8)                             # a decimal string normalises the same way
    assert "set_limits(amount!(7), amount!(8))" in b.client.runs[-1][0]
    assert (b.per_tx_cap, b.daily_cap) == (7, 8)


def test_normal_memo_and_addresses_still_pass():
    """The guard must not reject legitimate input: a plain memo, the invoice-codec memo, and valid
    addresses all build a well-formed manifest and reach the (fake) daemon."""
    b = _budget()
    b.pay(SHOP, 500, memo="order #42 — café latte")      # punctuation / unicode is fine
    manifest, _ = b.client.runs[-1]
    assert 'budget.pay(proof, address!("' + SHOP + '"), amount!(500), "order #42 — café latte")' in manifest

    b.pay_invoice(merchant=SHOP, invoice_id="deadbeef", amount=200, agent_tag="shopper")
    manifest, _ = b.client.runs[-1]
    assert '"ap1|deadbeef|shopper"' in manifest

    b.add_merchant(OTHER)                                # valid component address passes
    b.issue_agent_badge("session-1.default")             # valid label passes


# -- non-custodial walletd auth (M5 / deployment path) --------------------------------
# The client must support a least-privilege, credentialed connection, not only `auth=none` + Admin,
# so an agent can hold its OWN key in its OWN walletd and the on-chain caps become the real boundary.

class RecordingWalletd(WalletdClient):
    """Records every _rpc call and fakes auth.request, so we can assert what connect() requests."""

    def __init__(self, **kw):
        super().__init__("http://fake", **kw)
        self.rpc_calls: list[tuple[str, dict]] = []

    def _rpc(self, method, params):  # no network
        self.rpc_calls.append((method, params))
        return {"result": {"token": "minted"}} if method == "auth.request" else {"result": {}}


def test_connect_uses_supplied_token_without_minting():
    """Non-custodial: a pre-minted least-privilege token is used as-is — connect() never asks for Admin."""
    c = RecordingWalletd(token="preminted-least-privilege").connect()
    assert c._token == "preminted-least-privilege"
    assert all(m != "auth.request" for m, _ in c.rpc_calls)  # nothing minted, no Admin requested


def test_connect_mints_with_configured_least_privilege_permissions():
    c = RecordingWalletd(permissions=["TransactionSend", "TransactionGet"], credentials="None").connect()
    assert c._token == "minted"
    auth = [p for m, p in c.rpc_calls if m == "auth.request"]
    assert auth and auth[0]["permissions"] == ["TransactionSend", "TransactionGet"]
    assert auth[0]["permissions"] != ["Admin"]


def test_connect_defaults_to_admin_on_devnet():
    """Unchanged devnet behavior: with no token/permissions given, mint Admin (auth=none swarm)."""
    c = RecordingWalletd().connect()
    auth = [p for m, p in c.rpc_calls if m == "auth.request"]
    assert auth and auth[0]["permissions"] == ["Admin"] and auth[0]["credentials"] == "None"


# -- resource parametrization (drop the hard-coded XTR) --------------------------------

def test_resource_parametrization_uses_address_not_xtr():
    """A non-XTR budget splices a validated `address!("resource_…")` into the withdraw, not the
    native-token keyword; the default stays the native token (API name ``"XTR"``), spliced as the
    manifest keyword ``TARI`` — the only spelling a 0.48+ parser resolves (#3076) and one 0.47 also
    accepts — so the devnet flow is unchanged on either chain."""
    rescoin = "resource_" + "d" * 64
    b = _budget(resource=rescoin)
    b.top_up(500)
    manifest, _ = b.client.runs[-1]
    assert f'withdraw(address!("{rescoin}"), amount!(500))' in manifest
    assert "withdraw(TARI" not in manifest and "withdraw(XTR" not in manifest

    for native in ("XTR", "TARI"):  # both API spellings of the native token
        b2 = _budget(resource=native)
        b2.top_up(500)
        m2, _ = b2.client.runs[-1]
        assert "withdraw(TARI, amount!(500))" in m2
        assert "XTR" not in m2                      # the removed alias never reaches a manifest


def test_resource_parametrization_rejects_bad_resource():
    b = _budget(resource="resource_not_hex")
    with pytest.raises(ChainError):
        b.top_up(500)                       # bad resource address is rejected at manifest-build time
    assert b.client.runs == []


# -- proof authorization windows (tari-ootle 0.49, #3206) -------------------------------------
# A workspace proof authorizes nothing until `authorize!(proof)` opens a window over it, so every
# OWNER-badge manifest opens one around the owner-gated call and closes it (`drop_authorize!`) before
# dropping the proof. The agent's `pay` proof is only SHOWN to the template (an argument it reads), so
# it never needs a window. A 0.47 parser does not know the macros: `proof_windows=False`
# (`AGENTPAY_PROOF_WINDOWS=0`) keeps the old dialect.

def _once(m: str, needle: str) -> int:
    i = m.find(needle)
    assert i >= 0, f"missing {needle!r} in:\n{m}"
    assert m.find(needle, i + 1) < 0, f"{needle!r} occurs more than once"
    return i


def test_owner_calls_open_a_proof_window_by_default():
    b = _budget()
    assert b.proof_windows is True
    b.set_limits(250, 900)
    b.withdraw(100)
    b.issue_agent_badge("s2")
    b.revoke_session("s2")
    b.add_merchant(OTHER)
    assert len(b.client.runs) == 5
    for m, _ in b.client.runs:
        create = _once(m, f'owner.create_proof_for_resource(address!("{OWNER_BADGE}"));')
        opened = _once(m, "\n    authorize!(proof);")
        closed = _once(m, "drop_authorize!(proof);")
        dropped = _once(m, "drop_all_proofs!();")
        call = m.find("budget.")
        # create -> authorize! -> the budget call -> drop_authorize! -> drop_all_proofs!
        assert create < opened < call < closed < dropped, m


def test_pay_proof_is_only_shown_no_window_on_either_dialect():
    for pw in (True, False):
        b = _budget(proof_windows=pw)
        b.pay(SHOP, 10, memo="m")
        m, _ = b.client.runs[-1]
        assert "create_proof_by_non_fungible_ids(" in m and "budget.pay(proof, " in m
        assert "authorize!(" not in m, m
        assert "drop_all_proofs!();" in m


def test_proof_windows_off_keeps_the_pre_0_49_dialect():
    b = _budget(proof_windows=False)
    b.set_limits(250, 900)
    m, _ = b.client.runs[-1]
    assert f'owner.create_proof_for_resource(address!("{OWNER_BADGE}"));' in m
    assert "budget.set_limits(amount!(250), amount!(900));" in m
    assert "drop_all_proofs!();" in m
    assert "authorize!(" not in m, m


def test_proof_windows_env_switch(monkeypatch):
    from agentpay.onchain import _proof_windows_default
    monkeypatch.setenv("AGENTPAY_PROOF_WINDOWS", "0")
    assert _proof_windows_default() is False
    assert OnChainBudget(FakeWalletd().connect(), TPL, OWNER).proof_windows is False
    monkeypatch.setenv("AGENTPAY_PROOF_WINDOWS", "1")
    assert _proof_windows_default() is True
    monkeypatch.delenv("AGENTPAY_PROOF_WINDOWS")
    assert _proof_windows_default() is True
    # an explicit field wins over the environment
    monkeypatch.setenv("AGENTPAY_PROOF_WINDOWS", "0")
    assert OnChainBudget(FakeWalletd().connect(), TPL, OWNER, proof_windows=True).proof_windows is True


# -- P1-3: a dialect mismatch on an owner call is attributable, not a bare parser rejection ---------

def _owner_budget_that_rejects(err: ChainError) -> OnChainBudget:
    b = OnChainBudget(FakeWalletd().connect(), TPL, OWNER)
    b.component = "component_" + "c" * 64
    b.owner_badge = "resource_" + "a" * 64

    def boom(manifest, variables, max_fee=200_000):
        raise err

    b.client.run = boom
    return b


def test_owner_call_failure_carries_dialect_hint_when_guessed(monkeypatch):
    # dialect is the DEFAULTED guess (no env) → an owner-call rejection should point at the knob.
    monkeypatch.delenv("AGENTPAY_PROOF_WINDOWS", raising=False)
    b = _owner_budget_that_rejects(ChainError("manifest parse error: unknown instruction `authorize!`"))
    with pytest.raises(ChainError) as ei:
        b.revoke()  # an owner-badge call (uses the proof-window macros)
    msg = str(ei.value)
    assert "AGENTPAY_PROOF_WINDOWS" in msg and "DEFAULTED" in msg


def test_owner_call_hint_suppressed_when_dialect_explicit(monkeypatch):
    # the operator chose the dialect explicitly → no need to second-guess it in the error.
    monkeypatch.setenv("AGENTPAY_PROOF_WINDOWS", "1")
    b = _owner_budget_that_rejects(ChainError("manifest parse error"))
    with pytest.raises(ChainError) as ei:
        b.revoke()
    assert "AGENTPAY_PROOF_WINDOWS" not in str(ei.value)


def test_owner_call_hint_suppressed_on_auth_failure(monkeypatch):
    # a 401/403 is the auth layer, not the manifest dialect → don't misattribute it.
    monkeypatch.delenv("AGENTPAY_PROOF_WINDOWS", raising=False)
    err = ChainError("walletd HTTP 401 for submit")
    err.auth_failed = True
    b = _owner_budget_that_rejects(err)
    with pytest.raises(ChainError) as ei:
        b.revoke()
    assert "AGENTPAY_PROOF_WINDOWS" not in str(ei.value)


# -- session selection: the pay proof carries exactly ONE badge, chosen by id ---------------

def test_pay_session_override_and_client_field():
    b = _budget()
    b.pay(SHOP, 100, memo="m", session="key-bot1")
    manifest, _ = b.client.runs[-1]
    assert f'create_proof_by_non_fungible_ids(address!("{AGENT_BADGE}"), [non_fungible_id!("key-bot1")])' in manifest
    assert "create_proof_for_resource" not in manifest
    b.session = "agent-2"
    b.pay(SHOP, 100, memo="m")
    assert 'non_fungible_id!("agent-2")' in b.client.runs[-1][0]
    b.pay_invoice(merchant=SHOP, invoice_id="deadbeef", amount=50, session="key-x")
    assert 'non_fungible_id!("key-x")' in b.client.runs[-1][0]


def test_pay_rejects_injected_session_label_before_any_rpc():
    b = _budget()
    n = len(b.client.runs)
    for bad in ['x") ; owner.withdraw(XTR, amount!(1)); //', "with space", "", "a" * 65, "é"]:
        with pytest.raises(ChainError):
            b.pay(SHOP, 100, memo="m", session=bad)
    assert len(b.client.runs) == n


# -- N-5: post-submit response parse is under the pending umbrella --------------------
# A REAL submit that returns 200 but a response we can't read a tx id from means the tx MAY have
# landed — so run() must raise a PENDING ChainError (reconcile by id, never blind-resubmit), not a
# bare AttributeError/KeyError that the MCP/Python layer misreports as a hard "chain_error" failure.
# We drive the real run() / _submit_manifest / _rpc logic by stubbing ONLY the _rpc transport.

class _RpcStub(WalletdClient):
    """Returns a canned response for submit_manifest (and, optionally, for get_result), so the real
    run()/_submit_manifest parsing runs against it."""
    def __init__(self, submit_response, get_result_response=None):
        super().__init__("http://fake")
        self._token = "fake"
        self._submit_response = submit_response
        self._get_result_response = get_result_response

    def _rpc(self, method, params):
        if method == "transactions.submit_manifest":
            return self._submit_response
        if method == "transactions.get_result":
            return self._get_result_response
        raise AssertionError(f"unexpected rpc {method}")


def _run_submit(submit_response):
    return _RpcStub(submit_response).run("MANIFEST", {})


def test_run_submit_result_null_is_pending():
    # {"result": null} — the old code did null.get(...) → AttributeError.
    with pytest.raises(ChainError) as ei:
        _run_submit({"result": None})
    assert getattr(ei.value, "pending", False) is True


def test_run_submit_result_without_tx_id_is_pending():
    # {"result": {}} — a success-shaped response that carries no transaction id.
    with pytest.raises(ChainError) as ei:
        _run_submit({"result": {}})
    assert getattr(ei.value, "pending", False) is True


def test_run_submit_error_string_is_rejected_not_crash():
    # {"error": "boom"} — the old code did "boom"["message"] → TypeError. A well-formed error is a
    # DEFINITIVE submit-time rejection (no tx created), so it is rejected, NOT pending.
    with pytest.raises(ChainError) as ei:
        _run_submit({"error": "boom"})
    assert getattr(ei.value, "pending", False) is False
    assert "boom" in str(ei.value)


def test_run_submit_error_object_without_message_is_rejected():
    # {"error": {"code": 1}} — the old code did err["message"] → KeyError. Rejected, not a crash.
    with pytest.raises(ChainError) as ei:
        _run_submit({"error": {"code": 1}})
    assert getattr(ei.value, "pending", False) is False


def test_run_happy_path_accept_returns_result():
    # Guard the refactor: a normal submit (tx id) + an Accept verdict still returns the result.
    stub = _RpcStub(
        {"result": {"transaction_id": "tx1"}},
        {"result": {"result": {"Accept": {}}}},
    )
    res = stub.run("MANIFEST", {})
    assert res == {"result": {"Accept": {}}}


def test_rpc_rejects_malformed_200_envelope(monkeypatch):
    # A 200 body that is not a JSON-RPC envelope (bare null, or a dict with neither result nor error)
    # is a transport-level fault — _rpc raises ChainError rather than handing a caller a shape it will
    # crash on. A well-formed envelope passes through untouched.
    import urllib.request as _ur

    class _FakeResp:
        def __init__(self, body): self._b = body
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return self._b

    c = WalletdClient("http://fake")
    c._token = "fake"
    for bad in (b"null", b"{}", b"[]", b'{"jsonrpc":"2.0"}'):
        monkeypatch.setattr(_ur, "urlopen", lambda req, timeout=120, _b=bad: _FakeResp(_b))
        with pytest.raises(ChainError):
            c._rpc("transactions.get_result", {"transaction_id": "t"})
    monkeypatch.setattr(_ur, "urlopen", lambda req, timeout=120: _FakeResp(b'{"result": null}'))
    assert c._rpc("x", {}) == {"result": None}
