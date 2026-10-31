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
    # shaped like a real finalized-tx event (appears twice in a real result → tests de-dup)
    ev = {"topic": "pay", "substate_id": OWNER,
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


# -- manifest shape + memo pass-through -----------------------------------------------

def test_pay_builds_manifest_with_proof_and_memo():
    b = _budget()
    b.pay(SHOP, 500, memo="ap1|inv1|tag")
    manifest, variables = b.client.runs[-1]
    assert f'create_proof_for_resource(address!("{AGENT_BADGE}"))' in manifest
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
    """Topic filter excludes a `pay_via_escrow` event (same merchant/memo shape); the running
    `spent_in_window` keeps two DISTINCT identical-looking pays while still collapsing the duplicate
    copy of each event across the two result subtrees."""
    pay1 = {"topic": "pay", "substate_id": OWNER,
            "payload": {"merchant": SHOP, "amount": "100", "memo": "m", "spent_in_window": "100"}}
    pay2 = {"topic": "pay", "substate_id": OWNER,  # identical except the running total advanced
            "payload": {"merchant": SHOP, "amount": "100", "memo": "m", "spent_in_window": "200"}}
    escrow = {"topic": "pay_via_escrow", "substate_id": OWNER,
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
    assert f'create_proof_for_resource(address!("{agent_badge}"))' in manifest


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
    """A non-XTR budget splices a validated `address!("resource_…")` into the withdraw, not the `XTR`
    keyword; the default stays `XTR` so the devnet flow is unchanged."""
    rescoin = "resource_" + "d" * 64
    b = _budget(resource=rescoin)
    b.top_up(500)
    manifest, _ = b.client.runs[-1]
    assert f'withdraw(address!("{rescoin}"), amount!(500))' in manifest
    assert "withdraw(XTR" not in manifest

    b2 = _budget()  # default resource
    b2.top_up(500)
    m2, _ = b2.client.runs[-1]
    assert "withdraw(XTR, amount!(500))" in m2


def test_resource_parametrization_rejects_bad_resource():
    b = _budget(resource="resource_not_hex")
    with pytest.raises(ChainError):
        b.top_up(500)                       # bad resource address is rejected at manifest-build time
    assert b.client.runs == []
