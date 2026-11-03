#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared fallback template addresses for the demo/verify scripts.

Reads the repo-root ``defaults.json`` (the single source of truth) so a republished template is
updated in one place. A per-consumer environment variable always wins over the file; if neither the
env var nor the file has a value, ``fallback`` is returned. Pure stdlib, no SDK import.
"""
from __future__ import annotations

import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULTS_PATH = os.path.join(os.path.dirname(_HERE), "defaults.json")


def _file_templates() -> dict:
    try:
        with open(_DEFAULTS_PATH, encoding="utf-8") as f:
            return json.load(f).get("templates", {})
    except (OSError, ValueError):
        return {}


def template(name: str, *env_vars: str, fallback: str = "") -> str:
    """Resolve a template address: first a set env var (in order), then ``defaults.json``, then
    ``fallback``. ``name`` is the key under ``templates`` in defaults.json (e.g. ``"agent_budget"``)."""
    for var in env_vars:
        v = os.environ.get(var)
        if v:
            return v
    return _file_templates().get(name, fallback)
