"""Unit tests for the on-chain adapter (agentpay.onchain).

These do NOT need a live chain: a fake wallet daemon records the manifests the adapter builds and
returns canned results, so we test the adapter's logic — client pre-checks, memo pass-through,
manifest shape and the ledger-from-events decoder — in isolation. The real end-to-end path is
exercised by examples/demo_devnet.py against a swarm.
"""
from __future__ import annotations

import pytest

from agentpay.errors import PolicyViolation
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
