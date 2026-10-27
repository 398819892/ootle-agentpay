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
import time
import urllib.error
import urllib.request
from typing import Any, Optional


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

    def remove_merchant_alias(self, name: str) -> dict:
        return self._request("DELETE", f"/merchants/{name}")

    def audit(self, limit: int = 100) -> list:
        return self._request("GET", f"/audit?limit={int(limit)}").get("entries", [])


if __name__ == "__main__":
    # A copy-paste runnable flow: read budget → pay → poll → idempotent retry.
    base = os.environ.get("AGENTPAY_URL", "http://localhost:8787")
    key = os.environ.get("AGENTPAY_API_KEY")
    if not key:
        raise SystemExit("Set AGENTPAY_API_KEY (an agent key issued by the service owner).")
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
