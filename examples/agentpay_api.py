"""
Thin Python client for the hosted AgentPay integration API (`/api/v1`) — standard library only.

This is NOT the on-chain SDK (`agentpay.onchain`, which talks to a wallet daemon and is for the
owner/operator). A third-party developer or an autonomous agent should call the owner's hosted HTTP
API with an API key and never touch walletd — the on-chain AgentBudget enforces the spending limits.
This module is a tiny urllib wrapper for exactly that. No pip install required.

    from agentpay_api import AgentPayApi
    api = AgentPayApi("http://localhost:8787", "sk_agent_...")
    print(api.budget())
    receipt, replayed = api.pay("shop", "250", memo="order #42", idempotency_key="order-42")
    receipt = api.wait_for_payment(receipt["id"])
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Optional


# ---- shared config (fill once, every surface reads it) -----------------------------------------
# A tiny, dependency-free reader for the repo's shared `agentpay.config.json`, so this HTTP example
# resolves the SAME base URL / API key as the SDK, the MCP server and the dashboard. Precedence:
# AGENTPAY_* env var > agentpay.config.json > the default passed here. (Mirrors agentpay.config.)
def _shared_config() -> dict:
    path = os.environ.get("AGENTPAY_CONFIG")
    if not path:
        local = os.path.join(os.getcwd(), "agentpay.config.json")
        if os.path.isfile(local):
            path = local
        else:
            if sys.platform.startswith("win"):
                base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
            elif sys.platform == "darwin":
                base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
            else:
                base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
            user = os.path.join(base, "agentpay", "agentpay.config.json")
            path = user if os.path.isfile(user) else None
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def resolve(env_name: str, file_key: str, default: str = "") -> str:
    """One shared-config scalar: AGENTPAY_* env var > agentpay.config.json[file_key] > default."""
    v = os.environ.get(env_name)
    if v:
        return v
    fv = _shared_config().get(file_key)
    return str(fv) if fv not in (None, "") else default


class AgentPayApiError(Exception):
    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.body = body or {}
        self.frozen = bool(self.body.get("frozen"))
        self.rate_limited = bool(self.body.get("rateLimited"))


class AgentPayApi:
    def __init__(self, base_url: str, api_key: str, timeout: float = 30.0):
        if not base_url:
            raise ValueError("base_url is required")
        if not api_key:
            raise ValueError("api_key is required")
        self.base = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _request(self, method: str, path: str, body: Optional[dict] = None, headers: Optional[dict] = None) -> dict:
        url = f"{self.base}/api/v1{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.api_key}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {"error": raw}
            raise AgentPayApiError(e.code, parsed.get("error", str(e)), parsed) from None

    # ---- payments (agent or admin key) ----------------------------------------------------------

    def pay(
        self,
        merchant: str,
        amount: str,
        memo: Optional[str] = None,
        invoice_id: Optional[str] = None,
        agent_tag: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> tuple[dict, bool]:
        """Make a capped payment. Returns (receipt, replayed). A chain REJECTION still returns a
        receipt (status == "rejected") rather than raising — a rejection is a verdict, not an error.
        Pass idempotency_key so a retry after a failure is safe (same key → same receipt)."""
        idem = idempotency_key or f"pay_{secrets.token_hex(8)}"
        body: dict = {"merchant": merchant, "amount": str(amount)}
        if memo is not None:
            body["memo"] = memo
        if invoice_id is not None:
            body["invoiceId"] = invoice_id
        if agent_tag is not None:
            body["agentTag"] = agent_tag
        try:
            r = self._request("POST", "/payments", body, {"Idempotency-Key": idem})
            return r.get("receipt", {}), bool(r.get("replayed"))
        except AgentPayApiError as e:
            if e.status == 402 and isinstance(e.body, dict) and e.body.get("receipt"):
                return e.body["receipt"], bool(e.body.get("replayed"))
            raise

    def get_payment(self, payment_id: str) -> dict:
        return self._request("GET", f"/payments/{payment_id}").get("receipt", {})

    def list_payments(self) -> list:
        return self._request("GET", "/payments").get("payments", [])

    def wait_for_payment(self, payment_id: str, tries: int = 20, delay: float = 1.5) -> dict:
        receipt = self.get_payment(payment_id)
        for _ in range(tries):
            if receipt.get("status") not in ("pending", "unknown"):
                break
            time.sleep(delay)
            receipt = self.get_payment(payment_id)
        return receipt

    def budget(self) -> Optional[dict]:
        return self._request("GET", "/budget").get("budget")

    def list_merchants(self) -> list:
        return self._request("GET", "/merchants").get("merchants", [])

    # ---- admin-key operations (raise 403 with an agent key) -------------------------------------

    def open_budget(self, fund: str, per_tx_cap: str, daily_cap: str, epochs_per_window: int = 10, whitelist: Optional[list] = None) -> dict:
        return self._request(
            "POST",
            "/budgets",
            {
                "fund": str(fund),
                "perTxCap": str(per_tx_cap),
                "dailyCap": str(daily_cap),
                "epochsPerWindow": epochs_per_window,
                "whitelist": whitelist or [],
            },
        ).get("budget")

    def add_merchant(self, merchant: str) -> list:
        return self._request("POST", "/merchants", {"merchant": merchant}).get("merchants", [])

    def remove_merchant(self, merchant: str) -> dict:
        """Remove a merchant from the ON-CHAIN whitelist (admin key): the owner badge signs the
        template's remove_merchant. `merchant` is a known friendly name or a component_… address.
        Returns {"removed": {...}, "merchants": [...]} (+ "pending"/"txId" if not yet confirmed)."""
        return self._request("DELETE", f"/merchants/{merchant}")

    def remove_merchant_alias(self, name: str) -> dict:  # deprecated name; the endpoint removes ON CHAIN
        return self.remove_merchant(name)

    def set_limits(self, per_tx_cap: str, daily_cap: str) -> dict:
        """Change both on-chain caps in one owner-badge call (admin key). Returns the updated budget."""
        return self._request(
            "POST", "/budget/limits", {"perTxCap": str(per_tx_cap), "dailyCap": str(daily_cap)}
        ).get("budget")

    def audit(self, limit: int = 100) -> list:
        return self._request("GET", f"/audit?limit={int(limit)}").get("entries", [])


if __name__ == "__main__":
    # A copy-paste runnable flow: read budget → pay → poll → idempotent retry.
    base = resolve("AGENTPAY_URL", "api_url", "http://localhost:8787")
    key = resolve("AGENTPAY_API_KEY", "api_key")
    if not key:
        raise SystemExit("Set AGENTPAY_API_KEY (or api_key in agentpay.config.json) — an agent key issued by the service owner.")
    api = AgentPayApi(base, key)

    bud = api.budget()
    if not bud:
        raise SystemExit("No budget is open on the service yet.")
    print(f"Budget: perTx={bud['perTxCap']} daily={bud['dailyCap']} remaining={bud['dailyRemaining']} treasury={bud['treasury']}")

    idem = f"demo_{secrets.token_hex(8)}"
    print(f"\nPaying 100 to 'shop' (Idempotency-Key: {idem}) …")
    receipt, _ = api.pay("shop", "100", memo="python example", idempotency_key=idem)
    print(f"  id={receipt.get('id')} status={receipt.get('status')} tx={receipt.get('txId') or '-'} reason={receipt.get('reason') or '-'}")

    receipt = api.wait_for_payment(receipt["id"])
    print(f"  settled: status={receipt.get('status')}")

    print("\nResending the same Idempotency-Key (client retry) …")
    r2, replayed = api.pay("shop", "100", memo="python example", idempotency_key=idem)
    print(f"  id={r2.get('id')} status={r2.get('status')} replayed={replayed}")
    print(f"  same payment id: {'YES — not double-spent' if r2.get('id') == receipt.get('id') else 'NO (unexpected)'}")
