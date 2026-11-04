"""--emit-claude-config / --install-claude and the slimmer attach surface.

No chain is touched: these exercise the config -> Claude-Desktop-entry mapping and the
non-destructive file merge. The point is operator ergonomics — a future user runs one command
instead of hand-writing JSON and copying 64-hex addresses, and attach needs only the component
(the agent badge is derived on chain; the agent account defaults to the owner).
"""
from __future__ import annotations

import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.abspath(os.path.join(HERE, ".."))                # integrations/agentpay_mcp
SDK_SRC = os.path.abspath(os.path.join(HERE, "..", "..", "..", "sdk", "src"))
for p in (PKG_ROOT, SDK_SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from agentpay_mcp import claude_install, config  # noqa: E402

COMP = "component_" + "e" * 64
SHOP = "component_" + "1" * 64
BADGE = "resource_" + "a" * 64


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in list(os.environ):
        if k.startswith("AGENTPAY_"):
            monkeypatch.delenv(k, raising=False)
    yield


# --- the generated Claude Desktop entry -------------------------------------------------
def test_entry_command_is_the_console_script():
    assert config.load([]).claude_entry()["command"] == "agentpay-mcp"


def test_provision_block_is_minimal(monkeypatch):
    monkeypatch.setenv("AGENTPAY_AUTO_PROVISION", "true")
    monkeypatch.setenv("AGENTPAY_WHITELIST", SHOP)
    env = config.load([]).claude_env()
    assert env["AGENTPAY_AUTO_PROVISION"] == "true"
    assert env["AGENTPAY_WHITELIST"] == SHOP
    # local defaults are NOT echoed back — the block stays short
    assert "AGENTPAY_NETWORK" not in env
    assert "AGENTPAY_WALLETD_URL" not in env
    assert "AGENTPAY_BUDGET_TEMPLATE" not in env


def test_attach_block_needs_only_the_component(monkeypatch):
    monkeypatch.setenv("AGENTPAY_COMPONENT", COMP)
    env = config.load([]).claude_env()
    assert env["AGENTPAY_COMPONENT"] == COMP
    # badge is derived on chain, account defaults to owner → neither is emitted
    assert "AGENTPAY_AGENT_BADGE" not in env
    assert "AGENTPAY_AGENT_ACCOUNT" not in env
    assert "AGENTPAY_AUTO_PROVISION" not in env


def test_attach_block_keeps_explicit_badge_and_distinct_account(monkeypatch):
    monkeypatch.setenv("AGENTPAY_COMPONENT", COMP)
    monkeypatch.setenv("AGENTPAY_AGENT_BADGE", BADGE)
    monkeypatch.setenv("AGENTPAY_AGENT_ACCOUNT", "component_" + "b" * 64)
    env = config.load([]).claude_env()
    assert env["AGENTPAY_AGENT_BADGE"] == BADGE
    assert env["AGENTPAY_AGENT_ACCOUNT"] == "component_" + "b" * 64


def test_esmeralda_emits_network_and_template(monkeypatch):
    monkeypatch.setenv("AGENTPAY_NETWORK", "esmeralda")
    monkeypatch.setenv("AGENTPAY_BUDGET_TEMPLATE", "template_" + "7" * 64)
    env = config.load([]).claude_env()
    assert env["AGENTPAY_NETWORK"] == "esmeralda"
    assert env["AGENTPAY_BUDGET_TEMPLATE"] == "template_" + "7" * 64
    # same walletd as the preset → omitted
    assert "AGENTPAY_WALLETD_URL" not in env


def test_attach_no_longer_requires_the_badge(monkeypatch):
    monkeypatch.setenv("AGENTPAY_COMPONENT", COMP)
    assert "AGENTPAY_AGENT_BADGE" not in config.load([]).missing_attach_vars()


# --- non-destructive install into the config file ---------------------------------------
def test_install_creates_file_and_merges(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTPAY_AUTO_PROVISION", "true")
    monkeypatch.setenv("AGENTPAY_WHITELIST", SHOP)
    cfg = config.load([])
    target = tmp_path / "claude_desktop_config.json"

    res = claude_install.install(cfg.claude_entry(), path=target)
    assert res["ok"] and res["created_file"] and res["backup"] is None
    doc = json.loads(target.read_text(encoding="utf-8"))
    assert doc["mcpServers"]["agentpay"]["command"] == "agentpay-mcp"
    assert doc["mcpServers"]["agentpay"]["env"]["AGENTPAY_WHITELIST"] == SHOP


def test_install_preserves_existing_servers_and_backs_up(tmp_path):
    target = tmp_path / "claude_desktop_config.json"
    target.write_text(json.dumps({
        "preferences": {"x": 1},
        "mcpServers": {"other": {"command": "other-mcp"}},
    }), encoding="utf-8")

    res = claude_install.install({"command": "agentpay-mcp"}, path=target)
    assert res["ok"] and not res["created_file"] and res["backup"]
    doc = json.loads(target.read_text(encoding="utf-8"))
    assert doc["mcpServers"]["other"] == {"command": "other-mcp"}   # untouched
    assert doc["mcpServers"]["agentpay"] == {"command": "agentpay-mcp"}
    assert doc["preferences"] == {"x": 1}                            # top-level kept
    assert os.path.exists(res["backup"])


def test_install_reports_replacement(tmp_path):
    target = tmp_path / "claude_desktop_config.json"
    target.write_text(json.dumps({"mcpServers": {"agentpay": {"command": "old"}}}), encoding="utf-8")
    res = claude_install.install({"command": "agentpay-mcp"}, path=target)
    assert res["ok"] and res["replaced"] is True


def test_install_rejects_malformed_existing(tmp_path):
    target = tmp_path / "claude_desktop_config.json"
    target.write_text("{ not valid json", encoding="utf-8")
    res = claude_install.install({"command": "agentpay-mcp"}, path=target)
    assert res["ok"] is False and "parse" in res["error"]
