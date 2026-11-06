"""Shared AgentPay configuration source — fill it in **once**, every surface reads it.

AgentPay can be driven three ways (the MCP server, the hosted HTTP ``/api/v1``, and this SDK).
Historically each resolved its own environment variables with no common file, so a user had to
re-enter the same wallet daemon URL / budget template / account in several places. This module is
the single, portable source they all share: an optional ``agentpay.config.json`` whose keys mirror
the canonical ``AGENTPAY_*`` environment variables one-to-one.

Precedence, lowest -> highest (identical in the Python SDK, the JS server reader and the TS client):

    built-in / preset default
      -> defaults.json  (localnet template addresses only)
      -> agentpay.config.json
      -> AGENTPAY_* environment variable
      -> explicit argument / CLI flag passed by the caller

The config file is located by ``AGENTPAY_CONFIG`` (an explicit path), else ``./agentpay.config.json``
in the working directory, else the OS user-config directory. A missing or unparseable file is
fail-soft: it resolves to ``{}`` so every value simply falls through to the next source, exactly like
the older ``_defaults.py`` template reader this supersedes.

Pure stdlib — no third-party imports, safe to import from the SDK, the MCP package and scripts.
"""
from __future__ import annotations

import json
import os
import sys

# Canonical field name  ->  canonical AGENTPAY_* environment variable. The JSON config file uses the
# field name on the left; the environment variable on the right always wins over the file. Keep this
# in lock-step with web/server/config.js and clients/ts/src/config.ts.
FIELDS: dict[str, str] = {
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

# Deprecated env aliases still honored for back-compat (checked after the canonical name): the TS
# walletd historically read OOTLE_WALLETD_TOKEN for the same value the Python SDK read as
# AGENTPAY_WALLETD_TOKEN. The SDK now accepts either so a mixed setup keeps working.
_ENV_ALIASES: dict[str, tuple[str, ...]] = {
    "walletd_token": ("OOTLE_WALLETD_TOKEN",),
}

_HERE = os.path.dirname(os.path.abspath(__file__))
# sdk/src/agentpay/config.py -> repo root (three levels up). Only a dev checkout has this file; an
# installed package simply won't find it and falls through fail-soft.
_REPO_DEFAULTS = os.path.join(os.path.abspath(os.path.join(_HERE, "..", "..", "..")), "defaults.json")

CONFIG_BASENAME = "agentpay.config.json"

# Fields that point the daemon at a wallet / carry its bearer token. An *implicit* working-directory
# ``agentpay.config.json`` is attacker-controllable (you run a tool from a directory someone else
# populated): if it could set ``walletd_url``, the Bearer token from your environment would be sent to
# that URL. So these are honored ONLY from an explicit ``AGENTPAY_CONFIG`` path or the per-user config
# directory, never from a cwd file. Non-sensitive fields (template / account / network) still read from
# cwd for dev convenience. (6th-round review, batch 2 — cwd config-injection)
_SENSITIVE_FIELDS = frozenset({"walletd_url", "walletd_token"})


def _user_config_path() -> str:
    """OS-conventional location of the per-user ``agentpay.config.json`` (mirrors claude_install)."""
    if sys.platform.startswith("win"):
        base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
        return os.path.join(base, "agentpay", CONFIG_BASENAME)
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "agentpay", CONFIG_BASENAME)
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "agentpay", CONFIG_BASENAME)


def config_path() -> str | None:
    """The config file this process would read, or ``None`` if none is present.

    ``AGENTPAY_CONFIG`` names an explicit path and is honored even if the file is absent (so a
    misconfigured path surfaces honestly as "no values" rather than silently reading another file).
    Otherwise the working-directory file wins over the user-config-directory file.
    """
    explicit = os.environ.get("AGENTPAY_CONFIG")
    if explicit:
        return explicit
    local = os.path.join(os.getcwd(), CONFIG_BASENAME)
    if os.path.isfile(local):
        return local
    user = _user_config_path()
    if os.path.isfile(user):
        return user
    return None


def load_file() -> dict:
    """The parsed ``agentpay.config.json`` as a dict, fail-soft to ``{}`` (missing/unreadable/not an
    object). Read fresh each call so a late env/cwd change is respected; the file is tiny."""
    path = config_path()
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _from_implicit_cwd() -> bool:
    """True when the config file in effect is the IMPLICIT working-directory file (no explicit
    ``AGENTPAY_CONFIG``). Such a file is untrusted, so sensitive fields are not read from it."""
    if os.environ.get("AGENTPAY_CONFIG"):
        return False
    path = config_path()
    if not path:
        return False
    return os.path.abspath(path) == os.path.abspath(os.path.join(os.getcwd(), CONFIG_BASENAME))


def _file_value(key: str):
    """The config-file value for ``key``, except that a sensitive field is ignored when it would come
    from an implicit working-directory file (see ``_SENSITIVE_FIELDS``)."""
    if key in _SENSITIVE_FIELDS and _from_implicit_cwd():
        return None
    return load_file().get(key)


def _defaults_templates() -> dict:
    try:
        with open(_REPO_DEFAULTS, encoding="utf-8") as f:
            return json.load(f).get("templates", {})
    except (OSError, ValueError):
        return {}


def _env(key: str) -> str | None:
    """The canonical env var for ``key`` (then any deprecated alias), or ``None`` if none is set."""
    var = FIELDS.get(key)
    if var:
        v = os.environ.get(var)
        if v not in (None, ""):
            return v
    for alias in _ENV_ALIASES.get(key, ()):  # back-compat
        v = os.environ.get(alias)
        if v not in (None, ""):
            return v
    return None


def get(key: str, default: str = "", *, explicit: str | None = None, template_name: str | None = None) -> str:
    """Resolve one scalar field by precedence: ``explicit`` -> env -> config file -> (defaults.json
    template, if ``template_name`` given) -> ``default``.

    ``key`` is a name from :data:`FIELDS`. ``template_name`` layers ``defaults.json``'s
    ``templates[<name>]`` just above ``default`` — used for ``budget_template`` on localnet, which is
    re-derived into ``defaults.json`` on every swarm reset.
    """
    if explicit not in (None, ""):
        return str(explicit)
    env_val = _env(key)
    if env_val is not None:
        return env_val
    file_val = _file_value(key)
    if file_val not in (None, ""):
        return str(file_val)
    if template_name:
        tmpl = _defaults_templates().get(template_name)
        if tmpl:
            return str(tmpl)
    return default


_TRUE = ("1", "true", "yes", "on")
_FALSE = ("0", "false", "no", "off")


def get_bool(key: str, default: bool) -> bool:
    """Resolve a boolean field (env -> file -> ``default``). Accepts 1/true/yes/on and 0/false/no/off
    (case-insensitive); any other value falls through to the next source."""
    env_val = _env(key)
    if env_val is not None:
        low = env_val.strip().lower()
        if low in _TRUE:
            return True
        if low in _FALSE:
            return False
    file_val = load_file().get(key)
    if isinstance(file_val, bool):
        return file_val
    if isinstance(file_val, str):
        low = file_val.strip().lower()
        if low in _TRUE:
            return True
        if low in _FALSE:
            return False
    return default


def template(name: str, *env_vars: str, fallback: str = "") -> str:
    """Back-compat shim for the old ``_defaults.template`` contract, now layered through the shared
    config file: explicit env var(s) in order -> ``agentpay.config.json`` ``budget_template`` (for the
    ``agent_budget`` template) -> ``defaults.json`` ``templates[name]`` -> ``fallback``."""
    for var in env_vars:
        v = os.environ.get(var)
        if v:
            return v
    if name == "agent_budget":
        file_val = load_file().get("budget_template")
        if file_val:
            return str(file_val)
    tmpl = _defaults_templates().get(name)
    if tmpl:
        return str(tmpl)
    return fallback


def as_env(keys: list[str] | None = None) -> dict[str, str]:
    """The config file's values as a ``{AGENTPAY_*: value}`` dict — for emitting a ``.env`` snippet or
    an MCP ``env`` block. Only fields present in the file (and, if given, in ``keys``) are included;
    booleans render as ``true``/``false``."""
    data = load_file()
    out: dict[str, str] = {}
    for key, var in FIELDS.items():
        if keys is not None and key not in keys:
            continue
        if key in data and data[key] not in (None, ""):
            val = data[key]
            out[var] = ("true" if val else "false") if isinstance(val, bool) else str(val)
    return out
