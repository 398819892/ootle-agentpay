"""The optional remote (Streamable HTTP) transport: config parsing, the fail-closed exposure guard,
and the bearer-token ASGI gate. STDIO stays the default; none of this touches the stdio path.
No network/uvicorn is started — the ASGI gate is exercised directly with crafted scopes.
"""
from __future__ import annotations

import asyncio
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.abspath(os.path.join(HERE, ".."))
SDK_SRC = os.path.abspath(os.path.join(HERE, "..", "..", "..", "sdk", "src"))
for p in (PKG_ROOT, SDK_SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from agentpay_mcp import config, server  # noqa: E402


# ---- config: defaults, env, CLI -----------------------------------------------------------------
def test_transport_defaults_to_stdio(monkeypatch):
    for k in ("AGENTPAY_MCP_TRANSPORT", "AGENTPAY_MCP_HTTP_HOST", "AGENTPAY_MCP_HTTP_PORT",
              "AGENTPAY_MCP_HTTP_PATH", "AGENTPAY_MCP_HTTP_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    cfg = config.load([])
    assert cfg.transport == "stdio"
    assert cfg.http_host == "127.0.0.1" and cfg.http_port == 8000 and cfg.http_path == "/mcp"
    assert cfg.http_tokens == []


def test_http_env_parsing(monkeypatch):
    monkeypatch.setenv("AGENTPAY_MCP_TRANSPORT", "http")  # alias normalizes
    monkeypatch.setenv("AGENTPAY_MCP_HTTP_HOST", "0.0.0.0")
    monkeypatch.setenv("AGENTPAY_MCP_HTTP_PORT", "9000")
    monkeypatch.setenv("AGENTPAY_MCP_HTTP_PATH", "agent")  # normalized to leading slash
    monkeypatch.setenv("AGENTPAY_MCP_HTTP_TOKEN", "tok-a, tok-b\ntok-c")
    cfg = config.load([])
    assert cfg.transport == "streamable-http"
    assert cfg.http_host == "0.0.0.0" and cfg.http_port == 9000 and cfg.http_path == "/agent"
    assert cfg.http_tokens == ["tok-a", "tok-b", "tok-c"]


def test_http_cli_overrides_env(monkeypatch):
    monkeypatch.delenv("AGENTPAY_MCP_TRANSPORT", raising=False)
    cfg = config.load(["--http", "--http-host", "127.0.0.1", "--http-port", "8123", "--http-path", "/x"])
    assert cfg.transport == "streamable-http"
    assert cfg.http_port == 8123 and cfg.http_path == "/x"


def test_token_never_in_public_dict(monkeypatch):
    monkeypatch.setenv("AGENTPAY_MCP_TRANSPORT", "streamable-http")
    monkeypatch.setenv("AGENTPAY_MCP_HTTP_TOKEN", "super-secret-value")
    cfg = config.load([])
    pub = cfg.public_dict()
    assert pub["transport"] == "streamable-http"
    assert pub["http_auth"] is True  # only the FACT of auth, not the token
    assert "super-secret-value" not in repr(pub)


def test_emit_remote_mentions_https_and_header(monkeypatch):
    monkeypatch.setenv("AGENTPAY_MCP_TRANSPORT", "streamable-http")
    cfg = config.load([])
    out = cfg.emit("remote")
    assert "https://YOUR_DOMAIN/mcp" in out
    assert "Authorization: Bearer" in out


# ---- fail-closed exposure guard -----------------------------------------------------------------
def test_loopback_detection():
    assert server._is_loopback_host("127.0.0.1")
    assert server._is_loopback_host("localhost")
    assert server._is_loopback_host("::1")
    assert not server._is_loopback_host("0.0.0.0")
    assert not server._is_loopback_host("10.0.0.5")


def test_exposure_refused_without_token():
    assert server._http_exposure_error("0.0.0.0", []) is not None      # exposed + no token -> refuse
    assert server._http_exposure_error("0.0.0.0", ["t"]) is None       # exposed + token    -> ok
    assert server._http_exposure_error("127.0.0.1", []) is None        # loopback            -> ok


# ---- bearer-token ASGI gate ---------------------------------------------------------------------
def _scope(auth=None):
    headers = []
    if auth is not None:
        headers.append((b"authorization", auth.encode("latin-1")))
    return {"type": "http", "headers": headers}


def _call(mw, scope):
    """Drive the ASGI middleware once; return (inner_called, status_or_None)."""
    state = {"inner": False, "status": None}

    async def inner_app(s, receive, send):
        state["inner"] = True

    async def send(msg):
        if msg["type"] == "http.response.start":
            state["status"] = msg["status"]

    mw.app = inner_app
    asyncio.run(mw(scope, None, send))
    return state["inner"], state["status"]


def test_no_tokens_is_passthrough():
    mw = server._BearerAuthASGI(None, [])
    inner, status = _call(mw, _scope())
    assert inner is True and status is None


def test_correct_bearer_passes():
    mw = server._BearerAuthASGI(None, ["right"])
    inner, status = _call(mw, _scope("Bearer right"))
    assert inner is True and status is None


def test_wrong_or_missing_bearer_401():
    mw = server._BearerAuthASGI(None, ["right"])
    inner, status = _call(mw, _scope("Bearer wrong"))
    assert inner is False and status == 401
    inner2, status2 = _call(server._BearerAuthASGI(None, ["right"]), _scope())  # no header
    assert inner2 is False and status2 == 401


def test_bearer_scheme_is_case_insensitive():
    mw = server._BearerAuthASGI(None, ["tok"])
    inner, status = _call(mw, _scope("bearer tok"))
    assert inner is True and status is None
