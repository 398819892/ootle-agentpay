"""The opt-in human-confirmation gate on pay_merchant: when a pay passphrase is configured, a
payment is refused BEFORE any chain submit unless the agent passes the matching passphrase. When no
passphrase is configured, payments behave exactly as before. The secret is stored/compared as a
hash and never echoed. Stubs the wallet so no chain/network is needed.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.abspath(os.path.join(HERE, ".."))
SDK_SRC = os.path.abspath(os.path.join(HERE, "..", "..", "..", "sdk", "src"))
for p in (PKG_ROOT, SDK_SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from agentpay_mcp import backend, server  # noqa: E402

MERCHANT = "component_" + "1" * 64


def _pay(*args, **kwargs):
    """pay_merchant is an async tool now (it may elicit a confirmation out of band); these tests
    pass ctx=None (no elicitation) and drive the dashboard/env paths directly, so just run it."""
    return asyncio.run(server.pay_merchant(*args, **kwargs))


class _OkWallet:
    def pay_merchant(self, merchant, amount, memo=""):
        return backend.PayResult(True, merchant, amount, memo, status="accepted",
                                 spent_in_window=amount, payer="component_" + "c" * 64)


def _clear_env(mp):
    mp.delenv("AGENTPAY_PAY_PASSPHRASE", raising=False)
    mp.delenv("AGENTPAY_PAY_PASSPHRASE_SHA256", raising=False)
    # Force the dashboard "unreachable" so these tests deterministically exercise the env-var
    # FALLBACK path — otherwise a dashboard happening to run on 127.0.0.1:8787 would drive the gate.
    mp.setattr(server, "_dashboard_state", lambda: None)


def _allow_pay(mp):
    mp.setattr(server, "_wallet_or_error", lambda: (_OkWallet(), None))
    mp.setattr(server, "render_receipt_png", lambda **k: None)  # no file/upload side effects


def test_no_passphrase_configured_pays_without_confirmation(monkeypatch):
    _clear_env(monkeypatch)
    _allow_pay(monkeypatch)
    r = _pay(MERCHANT, 10)
    assert r["ok"] is True and r["status"] == "accepted"


def test_required_passphrase_blocks_missing_confirmation_before_chain(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("AGENTPAY_PAY_PASSPHRASE", "open-sesame")

    def must_not_reach():
        raise AssertionError("the wallet must not be reached when confirmation is missing")
    monkeypatch.setattr(server, "_wallet_or_error", must_not_reach)

    r = _pay(MERCHANT, 10)  # no confirmation supplied
    assert r["ok"] is False and r["status"] == "rejected"
    assert r.get("confirmation_required") is True


def test_required_passphrase_blocks_wrong_confirmation(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("AGENTPAY_PAY_PASSPHRASE", "open-sesame")
    monkeypatch.setattr(server, "_wallet_or_error",
                        lambda: (_ for _ in ()).throw(AssertionError("must not reach wallet")))
    r = _pay(MERCHANT, 10, confirmation="wrong")
    assert r.get("confirmation_required") is True


def test_correct_passphrase_allows_pay(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("AGENTPAY_PAY_PASSPHRASE", "open-sesame")
    _allow_pay(monkeypatch)
    r = _pay(MERCHANT, 10, confirmation="open-sesame")
    assert r["ok"] is True and r["status"] == "accepted"


def test_sha256_hex_env_form_matches(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("AGENTPAY_PAY_PASSPHRASE_SHA256", hashlib.sha256(b"s3cret").hexdigest())
    _allow_pay(monkeypatch)
    assert _pay(MERCHANT, 10, confirmation="nope").get("confirmation_required") is True
    assert _pay(MERCHANT, 10, confirmation="s3cret")["status"] == "accepted"


def test_passphrase_not_echoed_in_refusal(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("AGENTPAY_PAY_PASSPHRASE", "topsecretvalue")
    monkeypatch.setattr(server, "_wallet_or_error",
                        lambda: (_ for _ in ()).throw(AssertionError("must not reach wallet")))
    r = _pay(MERCHANT, 10, confirmation="zzq-provided-123")
    blob = repr(r)
    assert "topsecretvalue" not in blob and "zzq-provided-123" not in blob


# ---- dashboard-driven policy (the dashboard Settings page is the source of truth) ----------------
# When the dashboard is reachable it OWNS the policy: `payConfirmRequired` says whether a passphrase
# is needed, and the candidate is verified via POST /api/verify-pay (the hash never leaves the
# dashboard). The env vars are only a fallback for when the dashboard can't be reached.

def test_dashboard_not_required_pays_without_confirmation(monkeypatch):
    # Even with an env passphrase set, a reachable dashboard that says "not required" wins.
    monkeypatch.setenv("AGENTPAY_PAY_PASSPHRASE", "env-pass")
    monkeypatch.setattr(server, "_dashboard_state", lambda: {"payConfirmRequired": False})
    _allow_pay(monkeypatch)
    r = _pay(MERCHANT, 10)  # no confirmation, none required
    assert r["ok"] is True and r["status"] == "accepted"


def test_dashboard_required_blocks_when_verify_fails(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(server, "_dashboard_state", lambda: {"payConfirmRequired": True})
    monkeypatch.setattr(server, "_verify_pay_with_dashboard", lambda c: False)
    monkeypatch.setattr(server, "_wallet_or_error",
                        lambda: (_ for _ in ()).throw(AssertionError("must not reach wallet")))
    r = _pay(MERCHANT, 10, confirmation="whatever")
    assert r["ok"] is False and r.get("confirmation_required") is True


def test_dashboard_required_allows_when_verify_ok(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(server, "_dashboard_state", lambda: {"payConfirmRequired": True})
    monkeypatch.setattr(server, "_verify_pay_with_dashboard", lambda c: c == "right-one")
    _allow_pay(monkeypatch)
    assert _pay(MERCHANT, 10, confirmation="wrong").get("confirmation_required") is True
    assert _pay(MERCHANT, 10, confirmation="right-one")["status"] == "accepted"


# ---- merchant name <-> address resolution (names come from the dashboard book) ------------------
ADDR = "component_" + "a" * 64


class _CaptureWallet:
    """Records the address it was actually asked to pay, so we can assert a NAME resolved correctly."""
    def __init__(self):
        self.paid_to = None

    def pay_merchant(self, merchant, amount, memo=""):
        self.paid_to = merchant
        return backend.PayResult(True, merchant, amount, memo, status="accepted",
                                 spent_in_window=amount, payer="component_" + "c" * 64)


def test_pay_by_name_resolves_to_address(monkeypatch):
    cw = _CaptureWallet()
    monkeypatch.setattr(server, "_dashboard_state",
                        lambda: {"merchants": [{"name": "shop", "address": ADDR}],
                                 "payConfirmRequired": False})
    monkeypatch.setattr(server, "_wallet_or_error", lambda: (cw, None))
    monkeypatch.setattr(server, "render_receipt_png", lambda **k: None)
    r = _pay("shop", 10)  # pay by NAME, not address
    assert r["status"] == "accepted"
    assert cw.paid_to == ADDR  # the name was resolved to the book's address


def test_unknown_merchant_name_is_refused_with_known_list(monkeypatch):
    monkeypatch.setattr(server, "_dashboard_state",
                        lambda: {"merchants": [{"name": "shop", "address": ADDR}],
                                 "payConfirmRequired": False})
    monkeypatch.setattr(server, "_wallet_or_error",
                        lambda: (_ for _ in ()).throw(AssertionError("must not reach wallet")))
    r = _pay("ghost", 10)  # a name that isn't in the book
    assert r["ok"] is False and r.get("error_type") == "merchant_unknown"
    assert any(m.get("name") == "shop" for m in r.get("known_merchants", []))


# ---- out-of-band confirmation via MCP elicitation (the passphrase never becomes a tool arg) ------
class _FakeCtx:
    """A stand-in for the MCP Context: its async elicit() returns a scripted accept/decline result,
    like a host that popped (or didn't) its own passphrase prompt."""
    def __init__(self, action, passphrase=""):
        self._action, self._passphrase = action, passphrase

    async def elicit(self, message, schema):
        data = type("D", (), {"passphrase": self._passphrase})() if self._action == "accept" else None
        return type("R", (), {"action": self._action, "data": data})()


def test_elicited_passphrase_allows_pay(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(server, "_dashboard_state", lambda: {"payConfirmRequired": True})
    monkeypatch.setattr(server, "_verify_pay_with_dashboard", lambda c: c == "elicited-secret")
    _allow_pay(monkeypatch)
    # No `confirmation` arg at all — the host collects it out of band.
    r = asyncio.run(server.pay_merchant(MERCHANT, 10, ctx=_FakeCtx("accept", "elicited-secret")))
    assert r["status"] == "accepted"
    assert "elicited-secret" not in repr(r)  # never echoed back into the chat


def test_elicited_wrong_passphrase_refused(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(server, "_dashboard_state", lambda: {"payConfirmRequired": True})
    monkeypatch.setattr(server, "_verify_pay_with_dashboard", lambda c: c == "elicited-secret")
    monkeypatch.setattr(server, "_wallet_or_error",
                        lambda: (_ for _ in ()).throw(AssertionError("must not reach wallet")))
    r = asyncio.run(server.pay_merchant(MERCHANT, 10, ctx=_FakeCtx("accept", "WRONG")))
    assert r.get("confirmation_required") is True


def test_declined_elicitation_refused(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(server, "_dashboard_state", lambda: {"payConfirmRequired": True})
    # Only a real value verifies, so the empty initial check fails and the gate reaches elicitation.
    monkeypatch.setattr(server, "_verify_pay_with_dashboard", lambda c: c == "secret")
    monkeypatch.setattr(server, "_wallet_or_error",
                        lambda: (_ for _ in ()).throw(AssertionError("must not reach wallet")))
    r = asyncio.run(server.pay_merchant(MERCHANT, 10, ctx=_FakeCtx("decline")))
    assert r.get("confirmation_required") is True
