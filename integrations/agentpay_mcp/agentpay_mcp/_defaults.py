"""Repo-root ``defaults.json`` reader — the single source of truth for fallback template
addresses, shared with the demo/verify scripts' ``scripts/_defaults.py``.

A republished template (e.g. after a local-swarm or testnet reset) is updated in **one**
place — ``defaults.json`` — instead of a literal baked into this package, which silently
goes stale and then fails on chain as "Template not found". A per-consumer environment
variable always wins over the file; if neither the env var nor the file has a value,
``fallback`` is returned (an empty local template then fails *honestly* at provision time,
pointing the operator at ``AGENTPAY_BUDGET_TEMPLATE`` — same shape as the esmeralda preset).

Pure stdlib, no SDK import.
"""
from __future__ import annotations

import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
# integrations/agentpay_mcp/agentpay_mcp/_defaults.py -> repo root (three levels up).
_DEFAULTS_PATH = os.path.join(os.path.abspath(os.path.join(_HERE, "..", "..", "..")), "defaults.json")


def _file_templates() -> dict:
    try:
        with open(_DEFAULTS_PATH, encoding="utf-8") as f:
            return json.load(f).get("templates", {})
    except (OSError, ValueError):
        return {}


def template(name: str, *env_vars: str, fallback: str = "") -> str:
    """Resolve a template address: first a set env var (in order), then ``defaults.json``,
    then ``fallback``. ``name`` is the key under ``templates`` in defaults.json (e.g.
    ``"agent_budget"``)."""
    for var in env_vars:
        v = os.environ.get(var)
        if v:
            return v
    return _file_templates().get(name, fallback)
