"""Shared-config access for the MCP server — delegates to the SDK's :mod:`agentpay.config` so the
MCP server, the hosted HTTP API and the SDK all read the **same** ``agentpay.config.json`` and the
same ``AGENTPAY_*`` environment variables with identical precedence (see that module's docstring).

The MCP package already depends on the SDK (``backend.py`` imports ``agentpay.onchain``), so the
delegation normally succeeds. A pure-stdlib fallback is kept for the degenerate case where only this
package is importable, so ``defaults.json`` template resolution never hard-fails at import time.
"""
from __future__ import annotations

import json
import os

try:  # the normal path: one shared resolver for every surface
    from agentpay import config as _shared  # type: ignore
except Exception:  # pragma: no cover - SDK not importable; minimal stdlib fallback below
    _shared = None


_HERE = os.path.dirname(os.path.abspath(__file__))
# integrations/agentpay_mcp/agentpay_mcp/_defaults.py -> repo root (three levels up).
_DEFAULTS_PATH = os.path.join(os.path.abspath(os.path.join(_HERE, "..", "..", "..")), "defaults.json")

# Fallback-only: canonical field -> AGENTPAY_* env var (kept in sync with agentpay.config.FIELDS).
_FALLBACK_ENV: dict[str, str] = {
    "network": "AGENTPAY_NETWORK",
    "walletd_url": "AGENTPAY_WALLETD_URL",
    "walletd_token": "AGENTPAY_WALLETD_TOKEN",
    "budget_template": "AGENTPAY_BUDGET_TEMPLATE",
    "owner_account": "AGENTPAY_OWNER_ACCOUNT",
    "component": "AGENTPAY_COMPONENT",
    "agent_account": "AGENTPAY_AGENT_ACCOUNT",
    "agent_badge": "AGENTPAY_AGENT_BADGE",
    "proof_windows": "AGENTPAY_PROOF_WINDOWS",
    "api_url": "AGENTPAY_URL",
    "api_key": "AGENTPAY_API_KEY",
}


def _file_templates() -> dict:
    try:
        with open(_DEFAULTS_PATH, encoding="utf-8") as f:
            return json.load(f).get("templates", {})
    except (OSError, ValueError):
        return {}


def template(name: str, *env_vars: str, fallback: str = "") -> str:
    """Resolve a template address: a set env var (in order), then the shared config / ``defaults.json``,
    then ``fallback``. ``name`` is a key under ``templates`` in defaults.json (e.g. ``"agent_budget"``)."""
    if _shared is not None:
        return _shared.template(name, *env_vars, fallback=fallback)
    for var in env_vars:  # fallback: SDK not importable
        v = os.environ.get(var)
        if v:
            return v
    return _file_templates().get(name, fallback)


def get(key: str, default: str = "", *, explicit: str | None = None, template_name: str | None = None) -> str:
    """Resolve a shared-config scalar (see :func:`agentpay.config.get`)."""
    if _shared is not None:
        return _shared.get(key, default, explicit=explicit, template_name=template_name)
    if explicit not in (None, ""):  # fallback: explicit -> env -> defaults.json template -> default
        return str(explicit)
    var = _FALLBACK_ENV.get(key)
    if var:
        v = os.environ.get(var)
        if v:
            return v
    if template_name:
        tmpl = _file_templates().get(template_name)
        if tmpl:
            return str(tmpl)
    return default


def get_bool(key: str, default: bool) -> bool:
    if _shared is not None:
        return _shared.get_bool(key, default)
    var = _FALLBACK_ENV.get(key)  # fallback: env only
    if var:
        v = (os.environ.get(var) or "").strip().lower()
        if v in ("1", "true", "yes", "on"):
            return True
        if v in ("0", "false", "no", "off"):
            return False
    return default


def load_file() -> dict:
    if _shared is not None:
        return _shared.load_file()
    return {}  # pragma: no cover
