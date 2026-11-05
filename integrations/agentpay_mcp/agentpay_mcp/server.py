"""A real Model Context Protocol (MCP) server exposing an AI agent's on-chain wallet.

Run it as a stdio MCP server — this is what an MCP client (Claude Desktop, Cursor, or this
repo's ``demo_agent.py``) launches:

    agentpay-mcp                 # installed console script
    python -m agentpay_mcp.server

Configuration comes from environment variables (what the client passes under ``"env"``) with
optional CLI flags; see ``agentpay_mcp.config`` for the full list. It defaults to the **local
swarm** in **attach mode** (non-custodial): it expects a budget the owner already opened, so set
``AGENTPAY_COMPONENT`` (+ ``AGENTPAY_AGENT_BADGE`` + ``AGENTPAY_AGENT_ACCOUNT``) — the agent then
holds only the agent badge, never the owner key. With no component and no ``AGENTPAY_AUTO_PROVISION=1``
it reports ``not_configured`` rather than opening a budget. For local demos, set
``AGENTPAY_AUTO_PROVISION=1`` to let it open a fresh budget with the owner key (provision mode).
Point it at the public testnet with ``AGENTPAY_NETWORK=esmeralda``.

The three tools below are the agent's *entire* spending surface. Every payment is adjudicated
by the Tari Ootle validator; a blocked payment returns the validator's own reason so the agent
can react. Infrastructure problems (walletd down, bad config) come back as structured,
agent-friendly error objects rather than raw exceptions / a crashed server.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from . import backend, config
from .receipt_image import render_receipt_png

# ---- receipt language -------------------------------------------------------------------------
# The receipt image's language is a dashboard Setting, but the dashboard is a SEPARATE process
# (often on a different host/OS). So the MCP reads it live from the dashboard's open /api/state
# endpoint over localhost, cached briefly, and falls back to AGENTPAY_RECEIPT_LANG then "both" when
# the dashboard can't be reached. This keeps one Settings page in control of this process too.
_RECEIPT_LANG_CACHE = {"val": None, "at": 0.0}
_RECEIPT_LANG_TTL = 10.0  # seconds — short, so a Settings change is picked up on the next pay


def _receipt_lang() -> str:
    """Resolve the receipt language ("zh" | "en" | "both"). Never raises."""
    now = time.time()
    cached = _RECEIPT_LANG_CACHE["val"]
    if cached and now - _RECEIPT_LANG_CACHE["at"] < _RECEIPT_LANG_TTL:
        return cached
    lang = None
    base = os.environ.get("AGENTPAY_DASHBOARD_URL", "http://127.0.0.1:8787").rstrip("/")
    try:
        with urllib.request.urlopen(f"{base}/api/state", timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        v = data.get("receiptLang")
        if v in ("zh", "en", "both"):
            lang = v
    except Exception:  # noqa: BLE001 - dashboard unreachable; use the env/default fallback
        lang = None
    if lang is None:
        env = os.environ.get("AGENTPAY_RECEIPT_LANG", "").strip().lower()
        lang = env if env in ("zh", "en", "both") else "both"
    _RECEIPT_LANG_CACHE["val"] = lang
    _RECEIPT_LANG_CACHE["at"] = now
    return lang


# ---- saving the receipt image to a downloadable file ------------------------------------------
# The MCP returns the receipt inline, but an inline image has no "download" affordance in most MCP
# hosts. So we also WRITE each receipt to a PNG file the user can open / save, and hand the path back
# in the JSON result. The folder is AGENTPAY_RECEIPT_DIR, defaulting to ~/agentpay-receipts.
def _receipt_dir() -> Path:
    d = os.environ.get("AGENTPAY_RECEIPT_DIR", "").strip()
    return Path(d) if d else Path.home() / "agentpay-receipts"


def _save_receipt_png(png: bytes, *, merchant=None, paid_at=None) -> str | None:
    """Write the receipt PNG to a file and return its absolute path, or None on any failure (saving
    is a convenience — a write error must never break an accepted payment)."""
    try:
        when = None
        if paid_at:
            try:
                when = datetime.fromisoformat(str(paid_at))
            except ValueError:
                when = None
        when = when or datetime.now()
        tag = ""
        m = str(merchant or "")
        if m:
            tag = "-" + re.sub(r"[^0-9A-Za-z]", "", m)[-8:]
        name = f"receipt-{when.strftime('%Y%m%d-%H%M%S')}{tag}.png"
        d = _receipt_dir()
        d.mkdir(parents=True, exist_ok=True)
        path = d / name
        # avoid clobbering a same-second receipt
        i = 1
        while path.exists():
            path = d / f"receipt-{when.strftime('%Y%m%d-%H%M%S')}{tag}-{i}.png"
            i += 1
        path.write_bytes(png)
        return str(path)
    except Exception:  # noqa: BLE001 - saving is best-effort; never fail a good pay on a file error
        return None


def _upload_receipt_to_dashboard(png: bytes, meta: dict) -> str | None:
    """POST the receipt PNG (base64) + its figures to the dashboard, which stores it and serves it
    back at a download URL (surfaced on the dashboard's 回执 / Receipts page). Returns the absolute
    URL, or None if the dashboard is unreachable or declines — best-effort, so it never blocks a pay.
    Uses the same AGENTPAY_DASHBOARD_URL the receipt-language read uses."""
    import base64
    base = os.environ.get("AGENTPAY_DASHBOARD_URL", "http://127.0.0.1:8787").rstrip("/")
    body = json.dumps({
        "png_base64": base64.b64encode(png).decode("ascii"),
        "payer": meta.get("payer"), "merchant": meta.get("merchant"),
        "amount": meta.get("amount"), "unit": meta.get("unit", "µT"),
        "remaining_balance": meta.get("remaining_balance"),
        "remaining_in_window": meta.get("remaining_in_window"),
        "paid_at": meta.get("paid_at"),
    }).encode("utf-8")
    req = urllib.request.Request(f"{base}/api/receipts", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        rel = data.get("url")
        return f"{base}{rel}" if isinstance(rel, str) and rel.startswith("/") else None
    except Exception:  # noqa: BLE001 - dashboard down / declined: skip the URL, keep the pay + file
        return None

try:
    from mcp.server.fastmcp import FastMCP, Image
except ImportError:  # pragma: no cover - friendly message when deps are missing
    sys.stderr.write(
        "The 'mcp' package is not installed. Install this server, e.g.:\n"
        "  pip install -e integrations/agentpay_mcp\n"
        "or into a local venv:\n"
        "  python -m venv integrations/agentpay_mcp/.venv\n"
        "  integrations/agentpay_mcp/.venv/Scripts/pip install -r integrations/agentpay_mcp/requirements.txt\n"
    )
    raise

try:  # the SDK's typed chain error, for precise handling
    from agentpay.errors import ChainError
except Exception:  # pragma: no cover
    ChainError = Exception  # type: ignore


mcp = FastMCP("agentpay")
CONFIG: config.ServerConfig = config.load([])  # env-only by default; CLI main() may replace it
_wallet: "backend.AgentWallet | None" = None


# --- structured, agent-friendly errors --------------------------------------------------
def _error(error_type: str, message: str, hint: str = "") -> dict:
    """Shape returned to the agent when something is wrong with the setup or the chain link
    (as opposed to a *policy* rejection, which is a normal ``ok=false`` + ``reason``)."""
    out = {"ok": False, "error_type": error_type, "error": message}
    if hint:
        out["hint"] = hint
    return out


def _walletd_hint() -> str:
    if CONFIG.network == "esmeralda":
        return ("Is the esmeralda wallet daemon reachable at " + CONFIG.walletd_url +
                "? See docs/esmeralda.md.")
    return ("Is the local swarm running with walletd at " + CONFIG.walletd_url +
            " (auth=none)? See docs/devnet.md.")


def _build_wallet() -> "backend.AgentWallet | dict":
    """Connect to walletd and either attach to or provision a budget. Returns an AgentWallet on
    success, or a structured error dict (never raises) so a tool can relay it to the agent."""
    # 1) connect / authenticate
    try:
        client = backend.connect(CONFIG.walletd_url)
    except Exception as exc:
        return _error("not_connected", f"could not reach the wallet daemon: {exc}", _walletd_hint())

    # 2) attach mode
    if CONFIG.component:
        missing = CONFIG.missing_attach_vars()
        if missing:
            return _error("not_configured",
                          "attach mode needs " + ", ".join(missing),
                          "Set those env vars, or unset AGENTPAY_COMPONENT to let the server open a budget.")
        try:
            return backend.attach_wallet(
                client, component=CONFIG.component, agent_badge=CONFIG.agent_badge,
                agent_account=CONFIG.agent_account, per_tx_cap=CONFIG.per_tx_cap,
                daily_cap=CONFIG.daily_cap, whitelist=CONFIG.whitelist,
                template=CONFIG.budget_template,
            )
        except Exception as exc:
            return _error("attach_failed", f"could not attach to budget {CONFIG.component}: {exc}",
                          "Check AGENTPAY_COMPONENT / AGENTPAY_AGENT_BADGE / AGENTPAY_AGENT_ACCOUNT.")

    # 3) provision mode
    if not CONFIG.auto_provision:
        return _error("not_configured",
                      "no budget configured and auto-provision is disabled",
                      "Set AGENTPAY_COMPONENT (+badge +agent account), or drop --no-provision.")
    try:
        owner = client.account_address(CONFIG.owner_account)  # resolve first for a clear error
    except ChainError as exc:
        return _error("not_configured",
                      f"owner account {CONFIG.owner_account!r} not found on chain: {exc}",
                      "Set AGENTPAY_OWNER_ACCOUNT to a funded account (local default 'default', "
                      "esmeralda 'dev').")
    try:
        return backend.provision_wallet(
            client, owner, fund=CONFIG.fund, per_tx_cap=CONFIG.per_tx_cap,
            daily_cap=CONFIG.daily_cap, whitelist=CONFIG.whitelist,
            epochs_per_window=CONFIG.epochs_per_window, template=CONFIG.budget_template,
        )
    except Exception as exc:
        return _error("provision_failed", f"could not open a budget: {exc}",
                      "Is the owner account funded and the AgentBudget template published on this "
                      "network? " + _walletd_hint())


def _wallet_or_error() -> "tuple[backend.AgentWallet | None, dict | None]":
    """Lazily build the wallet, caching only on success so a later retry can recover once the
    chain link / config is fixed."""
    global _wallet
    if _wallet is not None:
        return _wallet, None
    built = _build_wallet()
    if isinstance(built, dict):
        return None, built
    _wallet = built
    return _wallet, None


# --- tools (the agent's entire surface) -------------------------------------------------
@mcp.tool()
def pay_merchant(merchant: str, amount: int, memo: str = "") -> dict:
    """Pay a merchant from the agent's on-chain budget.

    The payment is adjudicated by the Tari Ootle validator against the budget's on-chain rules
    (per-transaction cap, daily cap, merchant whitelist, revocation). Outcomes:

      * accepted -> ``{"ok": true, "status": "accepted", "spent_in_window": <int>,
        "receipt": {"merchant", "amount", "unit", "remaining_balance", "remaining_in_window",
        "paid_at"}, ...}`` — the receipt covers who was paid, how much, what's left, and when.
      * rejected -> ``{"ok": false, "status": "rejected", "reason": "<validator's reason>", ...}``
        (a normal, expected outcome — the agent cannot override it)
      * PENDING  -> ``{"ok": null, "status": "pending", "tx_id": <str|null>, "action_required": ...}``
        The payment was SUBMITTED but its on-chain outcome is not yet known (a network blip or a slow
        finalization); the transaction MAY have gone through. **Do NOT call pay_merchant again for
        this payment — that can pay the merchant twice.** Call ``get_payment_status(tx_id)`` to learn
        the real outcome (or, if tx_id is null, wait and check ``get_budget_status`` / ask a human
        before any retry).
      * setup/chain problem -> ``{"ok": false, "error_type": ..., "error": ..., "hint": ...}``

    Args:
        merchant: the merchant's account component address (see ``list_merchants``).
        amount:   amount to pay, in BASE UNITS (µT; 1 XTR = 1,000,000 µT). Integer — so one whole XTR
                  is ``1000000``, not ``1``. The per-tx and daily caps use the same base units.
        memo:     optional note / invoice reference carried on chain with the payment.
    """
    w, err = _wallet_or_error()
    if err:
        return err
    try:
        r = w.pay_merchant(merchant, amount, memo)
    except Exception as exc:  # defensive: never surface a raw traceback to the agent
        return _error("chain_error", f"payment failed unexpectedly: {exc}", _walletd_hint())
    out = {"ok": r.ok, "status": r.status, "merchant": r.merchant, "amount": r.amount, "memo": r.memo}
    if r.status == "pending":
        # Submitted, outcome UNKNOWN. Never retry this payment — resolve it with get_payment_status.
        out["tx_id"] = r.tx_id
        out["reason"] = r.reason
        out["action_required"] = (
            "The payment was submitted but its on-chain outcome is UNKNOWN. Do NOT call pay_merchant "
            "again for this payment — it may already have paid the merchant. "
            + (f"Call get_payment_status('{r.tx_id}') to resolve it."
               if r.tx_id else
               "No tx id is available; wait, then check get_budget_status, and ask a human before any retry.")
        )
    elif r.ok:
        out["spent_in_window"] = r.spent_in_window
        # A receipt for the accepted payment: who was paid, how much, what's left, and when.
        # Amounts are base units (µT). `remaining_balance` is the budget's funds left after this pay
        # (the vault balance); `remaining_in_window` is how much is still spendable this window. Both
        # may be null if the post-pay chain read momentarily failed — the payment still went through.
        out["receipt"] = {
            "payer": r.payer,                        # 付款方 — the paying budget's on-chain component
            "merchant": r.merchant,                  # 商户姓名 — the merchant as paid
            "amount": r.amount,                      # 付款金额 — this payment
            "unit": "µT",
            "remaining_balance": r.balance,          # 剩余金额 — budget funds left (vault balance)
            "remaining_in_window": r.remaining_in_window,
            "paid_at": r.paid_at,                    # 付款时间 — local time of acceptance
        }
    else:
        out["reason"] = r.reason
        out["rejected_by"] = "Tari Ootle validator (on-chain budget rule)"
    # For an accepted pay, also return a rendered PNG receipt alongside the JSON (best-effort: if the
    # image can't be drawn — e.g. Pillow missing — we just return the JSON, so the tool never fails).
    if r.ok:
        png = render_receipt_png(
            merchant=r.merchant, amount=r.amount, memo=r.memo,
            remaining_balance=r.balance, remaining_in_window=r.remaining_in_window,
            paid_at=r.paid_at, lang=_receipt_lang(), payer=r.payer,
        )
        if png:
            # 1) a downloadable file on disk, 2) the dashboard's own copy with a download URL — both
            #    best-effort, so a save/upload hiccup never turns a good payment into an error.
            path = _save_receipt_png(png, merchant=r.merchant, paid_at=r.paid_at)
            if path:
                out["receipt"]["image_path"] = path
            url = _upload_receipt_to_dashboard(png, out["receipt"])
            if url:
                out["receipt"]["download_url"] = url
            return [Image(data=png, format="png"), out]
    return out


@mcp.tool()
def get_payment_status(tx_id: str) -> dict:
    """Resolve the on-chain outcome of a previously submitted payment by its transaction id.

    Use this when ``pay_merchant`` returned a PENDING result (``ok: null``) to learn whether the
    payment was accepted or rejected — instead of retrying the payment, which could pay the merchant
    twice. Returns ``{"ok": true, "status": "accepted"|"rejected"|"pending", "reason": ...}``; the
    status may still be ``pending`` if the chain has not finalized it yet (wait and call again)."""
    w, err = _wallet_or_error()
    if err:
        return err
    try:
        st = w.payment_status(tx_id)
    except Exception as exc:
        return _error("chain_error", f"could not read transaction status: {exc}", _walletd_hint())
    return {"ok": True, **st}


@mcp.tool()
def get_budget_status() -> dict:
    """Report the agent's remaining budget and the rules it must stay within.

    The caps and whitelist are the owner's declared policy; the binding copy is enforced on
    chain. ``revoked`` is confirmed against the live chain (a dry-run probe). ``spent_in_window``
    is this process's last-seen estimate — it resets on restart and does NOT reflect spends by other
    sessions of the same budget, so treat it as a local estimate, not an authoritative chain read.
    On a setup or chain problem, returns a structured error object instead."""
    w, err = _wallet_or_error()
    if err:
        return err
    try:
        status = w.status()
    except Exception as exc:
        return _error("chain_error", f"could not read budget status: {exc}", _walletd_hint())
    status["ok"] = True
    return status


@mcp.tool()
def list_merchants() -> dict:
    """List the merchant addresses the agent is allowed to pay — the component's ON-CHAIN whitelist,
    read live (what the validator enforces at pay time), not a client-configured list.

    Returns ``{"ok": true, "merchants": [...]}`` or a structured error object."""
    w, err = _wallet_or_error()
    if err:
        return err
    try:
        merchants = w.list_merchants()
    except Exception as exc:  # noqa: BLE001 — surface a chain read failure as a structured error
        return _error("chain_error", f"could not read the on-chain whitelist: {exc}", _walletd_hint())
    return {"ok": True, "merchants": merchants}


@mcp.tool()
def get_server_info() -> dict:
    """Describe how this AgentPay server is configured and whether the wallet is live.

    Non-secret: network, walletd URL, template, mode (provision/attach) and declared caps. Use
    it to confirm the server is pointed where you expect and that the budget is reachable."""
    info = CONFIG.public_dict()
    w, err = _wallet_or_error()
    info["connected"] = w is not None
    if err:
        info["status"] = err
    elif w is not None:
        info["component"] = w.component
    return info


# --- entry point ------------------------------------------------------------------------
def main() -> None:
    """Console-script / module entry point. Parses CLI flags, handles ``--print-config`` and
    ``--selftest``, otherwise runs the stdio MCP server."""
    global CONFIG
    CONFIG = config.load()  # read CLI args this time

    if getattr(CONFIG, "_print_config", False):
        print(json.dumps(CONFIG.public_dict(), indent=2))
        return
    emit_host = getattr(CONFIG, "_emit_host", None)
    if emit_host:
        # Ready-to-paste wiring for this config — no hand-written JSON. Host selects the shape:
        # claude/cursor/generic (MCP) or http-json/http-env (an HTTP-API consumer like OpenClaw).
        if emit_host not in config.ServerConfig.EMIT_HOSTS:
            sys.stderr.write(f"Unknown --host {emit_host!r}; choose from {', '.join(config.ServerConfig.EMIT_HOSTS)}.\n")
            sys.exit(2)
        print(CONFIG.emit(emit_host))
        return
    install_host = getattr(CONFIG, "_install_host", None)
    if install_host:
        if install_host not in config.ServerConfig.INSTALL_HOSTS:
            sys.stderr.write(
                f"--install writes a file only for {', '.join(config.ServerConfig.INSTALL_HOSTS)} "
                f"(got --host {install_host!r}). For other targets use --emit-config.\n"
            )
            sys.exit(2)
        from . import claude_install
        res = claude_install.install(
            CONFIG.mcp_entry(), host=install_host, project=getattr(CONFIG, "_install_project", False),
        )
        print(json.dumps(res, indent=2, ensure_ascii=False))
        if not res.get("ok"):
            sys.exit(1)
        label = "Cursor" if install_host == "cursor" else "Claude Desktop"
        sys.stderr.write(f"\nAdded the 'agentpay' server to {res['path']}. Restart {label} to load it.\n")
        return
    if getattr(CONFIG, "_selftest", False):
        built = _build_wallet()
        if isinstance(built, dict):
            print(json.dumps({"selftest": "fail", **built}, indent=2))
            sys.exit(1)
        global _wallet
        _wallet = built
        info = get_server_info()
        print(json.dumps({"selftest": "ok", **info}, indent=2, default=str))
        return

    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()
