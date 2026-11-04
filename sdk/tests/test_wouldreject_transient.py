"""#3 — a dry-run preflight that could not reach a verdict (transient indexer / transport failure)
must NOT be reported as a validator rejection.

``would_reject`` is meant to surface the *chain's* own verdict on a pay. When the dry run never got
one — the indexer timed out, the connection dropped, walletd answered 5xx / garbage — there is no
verdict to report. Returning such a failure as a reject reason makes an infra hiccup look like "the
budget refused you", and (via the MCP / server preflight) burns the idempotency key on a payment the
validator never actually declined. So on a transient failure ``would_reject`` raises a
``transient``-flagged ``ChainError``; only a genuine (non-transient) RPC error or a finalized Reject
returns a reason. A definitive auth failure is surfaced as-is, NOT flagged transient.

Stubs the client's ``dry_run`` so no chain / network is touched.
"""
from __future__ import annotations

import pytest

from agentpay.errors import ChainError
from agentpay.onchain import OnChainBudget, WalletdClient

MERCHANT = "component_" + "c" * 64


class _DryRunClient(WalletdClient):
    """A client whose ``dry_run`` replays a scripted dict, or raises a scripted exception."""

    def __init__(self, reply):
        super().__init__("http://fake")
        self._token = "fake"
        self._reply = reply

    def dry_run(self, manifest, variables, max_fee=200_000):  # type: ignore[override]
        if isinstance(self._reply, BaseException):
            raise self._reply
        return self._reply


def _budget(reply) -> OnChainBudget:
    return OnChainBudget(
        client=_DryRunClient(reply), budget_template="template_x",
        owner_account="acc", agent_account="acc",
        component="component_" + "a" * 64, agent_badge="resource_" + "b" * 64,
    )


def test_transient_error_dict_raises_transient_not_reason():
    # dry_run exhausted its retries and returned the transient marker as a plain RPC error.
    b = _budget({"error": {"message": "Indexer client error: did not respond within 30s"}})
    with pytest.raises(ChainError) as ei:
        b.would_reject(MERCHANT, 10)
    assert getattr(ei.value, "transient", False) is True


def test_genuine_reject_error_returns_reason():
    b = _budget({"error": {"message": "amount exceeds the per-transaction cap"}})
    reason = b.would_reject(MERCHANT, 10)
    assert reason is not None
    assert "per-transaction cap" in reason


def test_raised_transport_error_is_flagged_transient():
    # _rpc raised (connection refused / read timeout / malformed envelope) straight out of dry_run.
    b = _budget(ChainError("could not reach walletd at http://fake"))
    with pytest.raises(ChainError) as ei:
        b.would_reject(MERCHANT, 10)
    assert getattr(ei.value, "transient", False) is True


def test_raised_auth_failure_is_not_transient():
    e = ChainError("walletd HTTP 401 for transactions.submit_manifest")
    e.auth_failed = True
    b = _budget(e)
    with pytest.raises(ChainError) as ei:
        b.would_reject(MERCHANT, 10)
    assert getattr(ei.value, "transient", False) is False
    assert getattr(ei.value, "auth_failed", False) is True


def test_accept_returns_none():
    # No error, and the finalized result is not a Reject → the pay would be accepted.
    b = _budget({"result": {}})
    assert b.would_reject(MERCHANT, 10) is None
