"""Shared config source + SDK ``from_config`` factories (no chain touched).

``agentpay.config`` is the one resolver every surface shares; the factories build a WalletdClient /
OnChainBudget from it so a user configures once (agentpay.config.json / AGENTPAY_*) and the SDK,
the MCP server and the HTTP server all agree. Base constructors stay pure — only the factories read
the file.
"""
from __future__ import annotations

import json
import os

import pytest

from agentpay import config as cfg
from agentpay.onchain import OnChainBudget, WalletdClient, _env_float, _env_int


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in list(os.environ):
        if k.startswith("AGENTPAY_") or k == "OOTLE_WALLETD_TOKEN":
            monkeypatch.delenv(k, raising=False)
    yield


def _cfg(tmp_path, data: dict) -> str:
    p = tmp_path / "agentpay.config.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return str(p)


def test_get_precedence(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTPAY_CONFIG", _cfg(tmp_path, {"owner_account": "from_file"}))
    assert cfg.get("owner_account", default="d") == "from_file"
    monkeypatch.setenv("AGENTPAY_OWNER_ACCOUNT", "from_env")
    assert cfg.get("owner_account", default="d") == "from_env"
    assert cfg.get("owner_account", explicit="x") == "x"


def test_walletd_from_config(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTPAY_CONFIG", _cfg(tmp_path, {
        "walletd_url": "http://file-walletd:9/json_rpc", "walletd_token": "tok-from-file",
    }))
    w = WalletdClient.from_config()
    assert w.url == "http://file-walletd:9/json_rpc"
    assert w._token == "tok-from-file"
    # explicit beats the file
    assert WalletdClient.from_config(url="http://explicit/json_rpc").url == "http://explicit/json_rpc"


def test_walletd_from_config_token_alias(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTPAY_CONFIG", str(tmp_path / "none.json"))
    monkeypatch.setenv("OOTLE_WALLETD_TOKEN", "legacy")
    assert WalletdClient.from_config()._token == "legacy"


def test_budget_from_config(tmp_path, monkeypatch):
    comp = "component_" + "e" * 64
    badge = "resource_" + "a" * 64
    monkeypatch.setenv("AGENTPAY_CONFIG", _cfg(tmp_path, {
        "budget_template": "template_fromfile", "owner_account": "owner1",
        "agent_account": "agent1", "component": comp, "agent_badge": badge, "proof_windows": False,
    }))
    b = OnChainBudget.from_config(WalletdClient("http://x/json_rpc"))
    assert b.budget_template == "template_fromfile"
    assert b.owner_account == "owner1"
    assert b.agent_account == "agent1"
    assert b.component == comp
    assert b.agent_badge == badge
    assert b.proof_windows is False


def test_budget_from_config_defaults_and_explicit(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTPAY_CONFIG", str(tmp_path / "none.json"))  # empty config
    b = OnChainBudget.from_config(WalletdClient("http://x/json_rpc"),
                                  budget_template="template_explicit", owner_account="o")
    assert b.budget_template == "template_explicit"
    assert b.owner_account == "o"
    assert b.agent_account == "o"          # defaults to owner
    assert b.component is None


# --- P2: a SET-but-non-numeric config var is refused, naming the variable (never silently defaulted)

def test_env_int_unset_or_empty_uses_default(monkeypatch):
    monkeypatch.delenv("AGENTPAY_SUBMIT_RETRIES", raising=False)
    assert _env_int("AGENTPAY_SUBMIT_RETRIES", 7) == 7
    monkeypatch.setenv("AGENTPAY_SUBMIT_RETRIES", "   ")
    assert _env_int("AGENTPAY_SUBMIT_RETRIES", 7) == 7
    monkeypatch.setenv("AGENTPAY_SUBMIT_RETRIES", "12")
    assert _env_int("AGENTPAY_SUBMIT_RETRIES", 7) == 12


def test_env_int_nan_config_refuses_start(monkeypatch):
    monkeypatch.setenv("AGENTPAY_SUBMIT_RETRIES", "4o")  # a typo, not an int
    with pytest.raises(ValueError) as ei:
        _env_int("AGENTPAY_SUBMIT_RETRIES", 7)
    # the error must name the offending variable so the operator can fix it at boot
    assert "AGENTPAY_SUBMIT_RETRIES" in str(ei.value)


def test_env_float_nan_config_refuses_start(monkeypatch):
    monkeypatch.setenv("AGENTPAY_SUBMIT_RETRY_DELAY", "fast")
    with pytest.raises(ValueError) as ei:
        _env_float("AGENTPAY_SUBMIT_RETRY_DELAY", 1.0)
    assert "AGENTPAY_SUBMIT_RETRY_DELAY" in str(ei.value)


# --- batch 2 (6th-round review): cwd config-injection — a walletd URL/token is NEVER read from an
# implicit working-directory agentpay.config.json (an attacker who controls the cwd could otherwise
# redirect the daemon and exfiltrate the env's Bearer token). Non-sensitive fields still read from cwd.

def test_sensitive_field_ignored_from_implicit_cwd(tmp_path, monkeypatch):
    (tmp_path / cfg.CONFIG_BASENAME).write_text(json.dumps({
        "walletd_url": "http://attacker:9/json_rpc",
        "walletd_token": "stolen",
        "owner_account": "ownerX",        # non-sensitive — still honored from cwd
    }), encoding="utf-8")
    monkeypatch.chdir(tmp_path)           # AGENTPAY_CONFIG stays unset (cleared by the fixture)
    assert cfg.get("walletd_url", default="http://safe/json_rpc") == "http://safe/json_rpc"
    assert cfg.get("walletd_token", default="") == ""
    assert cfg.get("owner_account", default="d") == "ownerX"


def test_sensitive_field_honored_from_explicit_config(tmp_path, monkeypatch):
    p = tmp_path / cfg.CONFIG_BASENAME
    p.write_text(json.dumps({"walletd_url": "http://trusted:9/json_rpc"}), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("AGENTPAY_CONFIG", str(p))   # the operator explicitly pointed at this file
    assert cfg.get("walletd_url", default="d") == "http://trusted:9/json_rpc"


def test_sensitive_field_honored_from_user_config_dir(tmp_path, monkeypatch):
    user_file = tmp_path / "userdir" / cfg.CONFIG_BASENAME
    user_file.parent.mkdir(parents=True)
    user_file.write_text(json.dumps({"walletd_url": "http://user-dir:9/json_rpc"}), encoding="utf-8")
    monkeypatch.setattr(cfg, "_user_config_path", lambda: str(user_file))
    work = tmp_path / "work"              # a cwd that has NO config file of its own
    work.mkdir()
    monkeypatch.chdir(work)
    assert cfg.get("walletd_url", default="d") == "http://user-dir:9/json_rpc"


def test_walletd_from_config_ignores_cwd_file(tmp_path, monkeypatch):
    (tmp_path / cfg.CONFIG_BASENAME).write_text(json.dumps({
        "walletd_url": "http://attacker:9/json_rpc", "walletd_token": "stolen",
    }), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    w = WalletdClient.from_config()
    assert "attacker" not in w.url        # falls through to the safe localnet default
    assert w._token is None
