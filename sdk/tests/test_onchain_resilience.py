"""Four-state resilience of the on-chain adapter: accept / reject / pending / transient.

The whole point of the "unknown ≠ failure" contract (H5 / D-1): a transaction that was SUBMITTED
but whose outcome we don't yet know must surface as ``pending`` (reconcilable), never as a hard
failure — because a caller reads "failure" as "safe to retry", and a retry of a tx that actually
landed double-pays the merchant. A DEFINITIVE chain Reject (the tx moved no funds) is the only
failure we flag as such, via ``chain_rejected``.

These stub the client's lowest level (``_rpc``) and exercise the REAL ``run`` / ``_submit_manifest``
/ ``get_result`` logic — no live chain, no network.
"""
from __future__ import annotations

import pytest

from agentpay.errors import ChainError
from agentpay.onchain import WalletdClient


class RpcFake(WalletdClient):
    """A client whose ``_rpc`` replays a scripted response (dict) or side effect (callable) per
    method, so the real run()/submit/get_result logic runs against canned walletd replies."""

    def __init__(self, script: dict):
        super().__init__("http://fake")
        self._token = "fake"
        self.script = script
        self.calls: list[tuple[str, dict]] = []

    def _rpc(self, method: str, params):  # type: ignore[override]
        self.calls.append((method, params))
        h = self.script[method]
        return h(params) if callable(h) else h


SUBMIT = "transactions.submit_manifest"
GETRES = "transactions.get_result"


def test_run_accept_returns_result():
    c = RpcFake({SUBMIT: {"result": {"transaction_id": "tx1"}},
                 GETRES: {"result": {"Accept": {"ok": 1}}}})
    assert c.run("m", {}) == {"Accept": {"ok": 1}}


def test_run_chain_reject_is_flagged_not_pending():
    c = RpcFake({SUBMIT: {"result": {"transaction_id": "tx1"}},
                 GETRES: {"result": {"Reject": "amount exceeds the per-transaction cap"}}})
    with pytest.raises(ChainError) as ei:
        c.run("m", {})
    assert getattr(ei.value, "chain_rejected", False) is True
    assert getattr(ei.value, "pending", False) is False


def test_run_timeout_is_pending_with_txid(monkeypatch):
    # get_result never finalizes → after the poll budget, a PENDING error carrying the tx id.
    monkeypatch.setattr("agentpay.onchain.time.sleep", lambda _s: None)
    c = RpcFake({SUBMIT: {"result": {"transaction_id": "tx9"}},
                 GETRES: {"result": {}}})  # no Accept/Reject variant → pending forever
    with pytest.raises(ChainError) as ei:
        c.run("m", {})
    assert getattr(ei.value, "pending", False) is True
    assert getattr(ei.value, "tx_id", None) == "tx9"


def test_real_submit_transient_error_is_pending_not_retried(monkeypatch):
    monkeypatch.setattr("agentpay.onchain.time.sleep", lambda _s: None)
    calls = {"n": 0}

    def submit(_params):
        calls["n"] += 1
        return {"error": {"message": "operation timed out"}}  # a transient marker

    c = RpcFake({SUBMIT: submit})
    with pytest.raises(ChainError) as ei:
        c.run("m", {})
    assert getattr(ei.value, "pending", False) is True
    assert calls["n"] == 1, "a REAL submit must do a single attempt — never auto-retry (H5)"


def test_real_submit_thrown_transport_is_pending():
    def submit(_params):
        raise ChainError("could not reach walletd")

    with pytest.raises(ChainError) as ei:
        RpcFake({SUBMIT: submit}).run("m", {})
    assert getattr(ei.value, "pending", False) is True


def test_get_result_blip_after_submit_is_pending_with_txid():
    def getres(_params):
        raise ChainError("connection reset mid-read")

    c = RpcFake({SUBMIT: {"result": {"transaction_id": "tx5"}}, GETRES: getres})
    with pytest.raises(ChainError) as ei:
        c.run("m", {})
    assert getattr(ei.value, "pending", False) is True
    assert getattr(ei.value, "tx_id", None) == "tx5"


def test_get_result_method_resolves_three_states():
    assert RpcFake({GETRES: {"result": {"Accept": {}}}}).get_result("t")[0] == "accept"
    assert RpcFake({GETRES: {"result": {"Reject": "no"}}}).get_result("t") == ("reject", "no")
    assert RpcFake({GETRES: {"result": {}}}).get_result("t") == ("pending", None)


def test_rpc_wraps_raw_transport_errors(monkeypatch):
    # A read timeout / unreadable body must never leak as a raw TimeoutError/JSONDecodeError.
    import agentpay.onchain as oc

    def boom(*_a, **_k):
        raise TimeoutError("read timed out")

    monkeypatch.setattr(oc.urllib.request, "urlopen", boom)
    c = WalletdClient("http://fake")
    c._token = "t"
    with pytest.raises(ChainError):
        c._rpc("settings.get", {})


# --- D-12: a consensus-level terminal failure (status but no FinalizeResult) is a reject ---------

def test_invalid_transaction_status_is_reject_not_pending():
    c = RpcFake({GETRES: {"result": {"result": None, "status": "InvalidTransaction", "transaction_id": "t"}}})
    assert c.get_result("t") == ("reject", "transaction InvalidTransaction")


def test_run_invalid_transaction_raises_chain_rejected(monkeypatch):
    monkeypatch.setattr("agentpay.onchain.time.sleep", lambda _s: None)
    seq = {SUBMIT: {"result": {"transaction_id": "txI"}},
           GETRES: {"result": {"result": None, "status": "InvalidTransaction", "transaction_id": "txI"}}}
    with pytest.raises(ChainError) as ei:
        RpcFake(seq).run("m", {})
    assert getattr(ei.value, "chain_rejected", False) is True
    assert getattr(ei.value, "pending", False) is False


# --- a definitive auth failure on a real submit is a HARD failure, not pending (review / TS D-13 twin)

def test_real_submit_auth_failure_is_hard_not_pending():
    # A 401/403 (bad / expired token) is rejected at walletd's auth layer BEFORE the manifest is
    # dispatched → the tx never landed, so it is a hard failure, never `pending` (which would tell a
    # caller "it may have landed, reconcile" for a request that was never submitted).
    def submit(_params):
        e = ChainError("walletd HTTP 401 for transactions.submit_manifest: Expired token")
        e.auth_failed = True
        raise e

    with pytest.raises(ChainError) as ei:
        RpcFake({SUBMIT: submit}).run("m", {})
    assert getattr(ei.value, "pending", False) is False
    assert getattr(ei.value, "auth_failed", False) is True


def test_real_submit_without_txid_is_pending_not_polled():
    # Submit reported success but returned no transaction id: unknown (may have landed) — never a
    # 120x poll of get_result(None).
    with pytest.raises(ChainError) as ei:
        RpcFake({SUBMIT: {"result": {}}}).run("m", {})
    assert getattr(ei.value, "pending", False) is True
