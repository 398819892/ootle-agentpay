"""Write the ``agentpay`` entry into an MCP host's config file — so a future user runs one command
instead of hand-editing JSON and copying 64-hex addresses.

Both Claude Desktop and Cursor use the same ``{mcpServers: {name: {command, env}}}`` shape, so one
non-destructive merge serves both; only the file location differs (``host`` selects it). The merge
keeps any other MCP servers already configured, creates the file/``mcpServers`` map if absent, and
backs up an existing file to ``*.bak`` first. Pure stdlib; touches only the local config file.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

# MCP hosts this installer can write to (both use the mcpServers schema).
HOSTS = ("claude", "cursor")


def claude_config_path() -> Path:
    """The platform's Claude Desktop config file location."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "Claude" / "claude_desktop_config.json"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    # Linux / other (Claude Desktop is unofficial here, but honour XDG for completeness).
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "Claude" / "claude_desktop_config.json"


def cursor_config_path(*, project: bool = False) -> Path:
    """Cursor's MCP config location: the global ``~/.cursor/mcp.json`` (same on every OS), or the
    project-scoped ``<cwd>/.cursor/mcp.json`` when ``project`` is set."""
    root = Path.cwd() if project else Path.home()
    return root / ".cursor" / "mcp.json"


def host_config_path(host: str, *, project: bool = False) -> Path:
    """The config file for ``host`` ("claude" or "cursor")."""
    if host == "cursor":
        return cursor_config_path(project=project)
    if host == "claude":
        return claude_config_path()
    raise ValueError(f"unknown MCP host {host!r}; known: {', '.join(HOSTS)}")


def install(entry: dict, *, name: str = "agentpay", path: Path | None = None,
            host: str = "claude", project: bool = False) -> dict:
    """Merge ``{mcpServers: {name: entry}}`` into ``host``'s config at ``path`` (default: the host's
    platform location). Returns a structured result dict; never raises on a bad existing file.

    Non-destructive: existing servers are preserved, an existing file is backed up to ``*.bak``,
    and a missing file (or ``mcpServers`` map) is created."""
    p = path or host_config_path(host, project=project)
    existed = p.exists()
    existing: dict = {}
    if existed:
        try:
            existing = json.loads(p.read_text(encoding="utf-8") or "{}")
        except (OSError, ValueError) as exc:
            return {"ok": False, "path": str(p), "error": f"could not read/parse existing config: {exc}"}
        if not isinstance(existing, dict):
            return {"ok": False, "path": str(p), "error": "existing config is not a JSON object"}

    servers = existing.get("mcpServers")
    if servers is None:
        servers = existing["mcpServers"] = {}
    elif not isinstance(servers, dict):
        return {"ok": False, "path": str(p), "error": "existing 'mcpServers' is not a JSON object"}

    replaced = name in servers

    backup: str | None = None
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        if existed:
            backup = str(p.with_suffix(p.suffix + ".bak"))
            shutil.copyfile(p, backup)
        servers[name] = entry
        p.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except OSError as exc:
        return {"ok": False, "path": str(p), "error": f"could not write config: {exc}"}

    return {
        "ok": True,
        "host": host,
        "path": str(p),
        "server": name,
        "replaced": replaced,
        "created_file": not existed,
        "backup": backup,
    }
