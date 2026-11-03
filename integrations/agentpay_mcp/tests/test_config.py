"""config.load() network resolution — fail-closed on an unknown network (D-8).

No chain / network is touched: config.load only reads environment + argv. The point of these tests
is the SAFETY property — an unknown or typo'd AGENTPAY_NETWORK (notably "mainnet") must NEVER
silently inherit the local swarm's walletd URL / template; it is rejected unless the operator points
the server at the network explicitly.
"""
from __future__ import annotations

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.abspath(os.path.join(HERE, ".."))                # integrations/agentpay_mcp
SDK_SRC = os.path.abspath(os.path.join(HERE, "..", "..", "..", "sdk", "src"))
for p in (PKG_ROOT, SDK_SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from agentpay_mcp import config  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Every test starts from a clean AGENTPAY_* environment."""
    for k in list(os.environ):
        if k.startswith("AGENTPAY_"):
            monkeypatch.delenv(k, raising=False)
    yield


def test_default_network_is_local():
    cfg = config.load([])
    assert cfg.network == "local"
    assert cfg.walletd_url == config.PRESETS["local"]["walletd_url"]
    assert cfg.budget_template == config.PRESETS["local"]["budget_template"]


def test_known_preset_esmeralda(monkeypatch):
    monkeypatch.setenv("AGENTPAY_NETWORK", "esmeralda")
    cfg = config.load([])
    assert cfg.network == "esmeralda"
    assert cfg.walletd_url == config.PRESETS["esmeralda"]["walletd_url"]


def test_unknown_network_fails_closed(monkeypatch):
    """An unknown network with no explicit endpoint is rejected — not silently run as local."""
    monkeypatch.setenv("AGENTPAY_NETWORK", "mainnet")
    with pytest.raises(SystemExit) as ei:
        config.load([])
    msg = str(ei.value)
    assert "mainnet" in msg
    assert "AGENTPAY_WALLETD_URL" in msg


def test_typo_network_fails_closed_not_local(monkeypatch):
    """A typo must fail loudly, never fall back to the local swarm's config."""
    monkeypatch.setenv("AGENTPAY_NETWORK", "locl")
    with pytest.raises(SystemExit):
        config.load([])


def test_unknown_network_allowed_with_explicit_endpoint(monkeypatch):
    """A network with no built-in preset is allowed ONLY when pointed at explicitly — and it then
    inherits NOTHING from the local preset (no assumed template / owner / URL)."""
    monkeypatch.setenv("AGENTPAY_NETWORK", "mainnet")
    monkeypatch.setenv("AGENTPAY_WALLETD_URL", "http://127.0.0.1:9000/json_rpc")
    cfg = config.load([])
    assert cfg.network == "mainnet"  # real name kept, never coerced to "local"
    assert cfg.walletd_url == "http://127.0.0.1:9000/json_rpc"
    # No leakage from the local preset:
    assert cfg.budget_template != config.PRESETS["local"]["budget_template"]
    assert cfg.owner_account != config.PRESETS["local"]["owner_account"]


def test_explicit_endpoint_on_known_preset_still_overrides(monkeypatch):
    """The explicit-endpoint escape hatch does not disturb the normal per-field override on a known
    preset: env still wins over the preset default."""
    monkeypatch.setenv("AGENTPAY_NETWORK", "esmeralda")
    monkeypatch.setenv("AGENTPAY_WALLETD_URL", "http://127.0.0.1:7777/json_rpc")
    cfg = config.load([])
    assert cfg.network == "esmeralda"
    assert cfg.walletd_url == "http://127.0.0.1:7777/json_rpc"
    # template/owner still come from the esmeralda preset (not overridden)
    assert cfg.budget_template == config.PRESETS["esmeralda"]["budget_template"]
