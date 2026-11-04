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
from agentpay.onchain import OnChainBudget, WalletdClient


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
