"""The shared configuration source — ``agentpay.config`` (agentpay.config.json / AGENTPAY_* env).

No chain is touched. These exercise the one resolver every surface shares: precedence
(explicit > env > file > defaults.json template > default), file location (AGENTPAY_CONFIG),
fail-soft parsing, the deprecated OOTLE_WALLETD_TOKEN alias, and the as_env emitter.
"""
from __future__ import annotations

import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SDK_SRC = os.path.abspath(os.path.join(HERE, "..", "..", "..", "sdk", "src"))
if SDK_SRC not in sys.path:
    sys.path.insert(0, SDK_SRC)

from agentpay import config as cfg  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in list(os.environ):
        if k.startswith("AGENTPAY_") or k == "OOTLE_WALLETD_TOKEN":
            monkeypatch.delenv(k, raising=False)
    yield


def _write(tmp_path, data: dict):
    p = tmp_path / "agentpay.config.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def test_precedence_explicit_over_env_over_file_over_default(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTPAY_CONFIG", str(_write(tmp_path, {"walletd_url": "http://file:1"})))
    # file only
    assert cfg.get("walletd_url", default="http://dflt") == "http://file:1"
    # env beats file
    monkeypatch.setenv("AGENTPAY_WALLETD_URL", "http://env:2")
    assert cfg.get("walletd_url", default="http://dflt") == "http://env:2"
    # explicit beats env
    assert cfg.get("walletd_url", default="http://dflt", explicit="http://explicit:3") == "http://explicit:3"


def test_default_when_nothing_set(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # a clean cwd: no agentpay.config.json present
    assert cfg.load_file() == {}
    assert cfg.get("owner_account", default="default") == "default"


def test_template_layering(tmp_path, monkeypatch):
    # defaults.json template is used only when neither env nor file provides budget_template
    monkeypatch.setenv("AGENTPAY_CONFIG", str(_write(tmp_path, {})))
    repo_tmpl = cfg._defaults_templates().get("agent_budget")
    resolved = cfg.get("budget_template", template_name="agent_budget", default="FALLBACK")
    assert resolved == (repo_tmpl or "FALLBACK")
    # a file value overrides the defaults.json template
    monkeypatch.setenv("AGENTPAY_CONFIG", str(_write(tmp_path, {"budget_template": "template_fromfile"})))
    assert cfg.get("budget_template", template_name="agent_budget") == "template_fromfile"


def test_get_bool(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTPAY_CONFIG", str(_write(tmp_path, {"proof_windows": False})))
    assert cfg.get_bool("proof_windows", True) is False          # file bool wins over default
    monkeypatch.setenv("AGENTPAY_PROOF_WINDOWS", "1")
    assert cfg.get_bool("proof_windows", True) is True           # env wins over file
    monkeypatch.setenv("AGENTPAY_PROOF_WINDOWS", "off")
    assert cfg.get_bool("proof_windows", True) is False


def test_walletd_token_alias(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTPAY_CONFIG", str(tmp_path / "none.json"))  # no file
    monkeypatch.setenv("OOTLE_WALLETD_TOKEN", "legacy-token")
    assert cfg.get("walletd_token") == "legacy-token"            # deprecated alias honored
    monkeypatch.setenv("AGENTPAY_WALLETD_TOKEN", "canonical")
    assert cfg.get("walletd_token") == "canonical"               # canonical wins over alias


def test_fail_soft_on_malformed_file(tmp_path, monkeypatch):
    p = tmp_path / "agentpay.config.json"
    p.write_text("{ not json", encoding="utf-8")
    monkeypatch.setenv("AGENTPAY_CONFIG", str(p))
    assert cfg.load_file() == {}
    assert cfg.get("walletd_url", default="http://dflt") == "http://dflt"


def test_as_env_renders_prefixed_block(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTPAY_CONFIG", str(_write(tmp_path, {
        "api_url": "https://pay.example.com", "api_key": "sk_agent_1", "proof_windows": True, "network": "",
    })))
    env = cfg.as_env()
    assert env["AGENTPAY_URL"] == "https://pay.example.com"
    assert env["AGENTPAY_API_KEY"] == "sk_agent_1"
    assert env["AGENTPAY_PROOF_WINDOWS"] == "true"               # bool rendered
    assert "AGENTPAY_NETWORK" not in env                         # empty value skipped
    # a subset filter
    only = cfg.as_env(["api_url"])
    assert only == {"AGENTPAY_URL": "https://pay.example.com"}


def test_config_path_honours_explicit_env(tmp_path, monkeypatch):
    target = str(tmp_path / "custom.json")
    monkeypatch.setenv("AGENTPAY_CONFIG", target)
    assert cfg.config_path() == target                          # honored even though absent
