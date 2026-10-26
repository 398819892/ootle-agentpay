"""On-chain budget adapter — the phase-2 (on-chain conditions) path.

The phase-1 `BudgetManager` (budget.py) gets a hard ceiling from throw-away key derivation
and enforces the per-tx cap / allowlist *client-side only*. This module instead backs the
budget with the **AgentBudget** Ootle template, so the per-transaction cap, the rolling daily
cap, the merchant whitelist and the kill switch are all enforced **on chain** by the
validator — the agent's client cannot override them.

It talks to a running Tari Ootle wallet daemon over JSON-RPC (the same one `tari publish`
uses). It is deliberately stdlib-only (no `ootle-py`): a template component is driven by
submitting a transaction *manifest*, which the daemon parses, signs and commits.

Pairs with the `agent_budget` and `escrow` templates in this repo's sibling `templates/`
directory. See examples/demo_devnet.py for an end-to-end run against a local swarm.
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from .errors import ChainError, PolicyViolation
from .invoice import encode_memo

# Native Tari test token used as the (plaintext, countable) budget resource on a devnet.
XTR = "XTR"

# Transient public-testnet (esmeralda) indexer errors worth retrying a manifest submit through.
# A local swarm never produces these, so retry logic below stays dormant there.
_TRANSIENT_MARKERS = (
    "did not respond within", "Network interface", "timed out", "operation timed out",
    "http2", "stream error", "connection error", "Indexer client error",
    "Failed to send request", "SendRequest", "Failed to submit transaction",
)
_SUBMIT_RETRIES = 30
_SUBMIT_RETRY_DELAY = 12  # seconds


def _is_transient(message: str) -> bool:
    return any(m in message for m in _TRANSIENT_MARKERS)


class WalletdClient:
    """Minimal JSON-RPC client for a Tari Ootle wallet daemon (auth = ``none`` devnet mode)."""

    def __init__(self, url: str = "http://127.0.0.1:12010/json_rpc") -> None:
        self.url = url
        self._token: str | None = None

    def _rpc(self, method: str, params: Any) -> dict:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(self.url, data=body, headers={"Content-Type": "application/json"})
        if self._token:
            req.add_header("Authorization", "Bearer " + self._token)
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())

    def connect(self) -> "WalletdClient":
        """Mint an admin token. On an ``auth=none`` devnet daemon this needs no credentials."""
        r = self._rpc("auth.request", {"permissions": ["Admin"], "duration": None, "credentials": "None"})
        self._token = r["result"]["token"]
        return self

    # -- accounts -------------------------------------------------------------------
    def account_address(self, name: str) -> str:
        for a in self._rpc("accounts.list", {"offset": 0, "limit": 50})["result"]["accounts"]:
            if a["account"]["name"] == name:
                return a["address"] if False else a["account"]["component_address"]
        raise ChainError(f"account {name!r} not found")

    def create_account(self, name: str) -> str:
        r = self._rpc("accounts.create", {"account_name": name, "custom_access_rules": None,
                                           "max_fee": None, "is_default": False, "key_id": None})
        if "error" in r:
            raise ChainError(r["error"]["message"])
        return r["result"]["account"]["component_address"]

    def fund(self, name: str, amount: int = 1_000_000, max_fee: int = 50_000) -> None:
        """Claim free test coins (localnet faucet) so the account exists on chain with a balance."""
        self._rpc("accounts.create_free_test_coins",
                  {"account": {"Name": name}, "amount": amount, "max_fee": max_fee, "key_id": None})

    def balance(self, name: str) -> int:
        r = self._rpc("accounts.get_balances", {"account": {"Name": name}, "refresh": True})
        for b in r["result"].get("balances", []):
            if b["token_symbol"] == "tTARI":
                return int(b["balance"])
        return 0

    # -- transactions ---------------------------------------------------------------
    def _submit_manifest(self, manifest: str, variables: dict[str, str], max_fee: int,
                         dry_run: bool) -> dict:
        """Submit a manifest, retrying ONLY on transient public-indexer errors (connection /
        30s timeouts seen on esmeralda). A local swarm never hits these, so its behaviour is
        unchanged; a template/policy rejection is returned immediately (never retried)."""
        params = {"manifest": manifest, "variables": variables, "max_fee": max_fee, "dry_run": dry_run}
        last = None
        for _ in range(_SUBMIT_RETRIES):
            last = self._rpc("transactions.submit_manifest", params)
            err = last.get("error")
            if not err or not _is_transient(err.get("message", "")):
                return last
            time.sleep(_SUBMIT_RETRY_DELAY)
        return last  # exhausted: hand back the last (transient) error for the caller to surface

    def dry_run(self, manifest: str, variables: dict[str, str], max_fee: int = 200_000) -> dict:
        return self._submit_manifest(manifest, variables, max_fee, dry_run=True)

    def run(self, manifest: str, variables: dict[str, str], max_fee: int = 200_000) -> dict:
        """Submit a manifest for real and wait for it to finalize. Returns the finalized result
        (a dict containing ``Accept``). Raises ChainError on rejection."""
        r = self._submit_manifest(manifest, variables, max_fee, dry_run=False)
        if "error" in r:
            raise ChainError(r["error"]["message"])
        tx_id = r["result"].get("transaction_id") or r["result"].get("hash")
        for _ in range(120):   # esmeralda finalization can be slow under congestion
            res = self._rpc("transactions.get_result", {"transaction_id": tx_id}).get("result")
            if res:
                blob = json.dumps(res)
                if '"Reject"' in blob:
                    raise ChainError(_reject_reason(res) or "transaction rejected")
                if '"Accept"' in blob:
                    return res
            time.sleep(1.5)
        raise ChainError(f"transaction {tx_id} did not finalize in time")


def _reject_reason(result: dict) -> str | None:
    m = re.search(r'"(?:ExecutionFailure|OneOrMoreInputsNotFound|[A-Za-z]*Error)":"([^"]+)"', json.dumps(result))
    if m:
        return m.group(1)
    m = re.search(r"Template error: ([^\"]+)", json.dumps(result))
    return m.group(1) if m else None


def _components(blob: str, exclude: set[str]) -> list[str]:
    return [c for c in set(re.findall(r"component_[0-9a-f]{64}", blob)) if c not in exclude]


def _badge_resources(blob: str) -> list[str]:
    # non-fungible badge resources minted by the template (exclude the native XTR resource 0101..
    # and the zero template address resource 0000..)
    return sorted(x for x in set(re.findall(r"resource_[0-9a-f]{64}", blob))
                  if not x.startswith("resource_0101") and not x.startswith("resource_0000"))


@dataclass
class LedgerEntry:
    merchant: str
    amount: int
    memo: str
    tx_kind: str  # "pay" | "pay_via_escrow"


@dataclass
class OnChainBudget:
    """A budget instance backed by an on-chain AgentBudget component.

    `open()` instantiates it; the owner account receives both badges. For devnet simplicity the
    owner account also acts as the agent (holds the agent badge); in production the agent badge
    is handed to a separate agent key and `agent_account` points at it — the on-chain rules are
    identical either way (the template's cargo tests cover the separate-account case).
    """

    client: WalletdClient
    budget_template: str
    owner_account: str
    agent_account: str | None = None          # defaults to owner_account
    component: str | None = None
    owner_badge: str | None = None
    agent_badge: str | None = None
    per_tx_cap: int = 0
    daily_cap: int = 0
    whitelist: list[str] = field(default_factory=list)
    revoked: bool = False
    spent: int = 0
    ledger: list[LedgerEntry] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.agent_account is None:
            self.agent_account = self.owner_account

    # -- owner -----------------------------------------------------------------------
    def open(self, *, fund: int, per_tx_cap: int, daily_cap: int,
             epochs_per_window: int, whitelist: list[str]) -> "OnChainBudget":
        wl = ", ".join(f'address!("{m}")' for m in whitelist)
        manifest = (
            f'use {self.budget_template} as AgentBudget;\n'
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            f'    let funds = owner.withdraw(XTR, amount!({fund}));\n'
            f'    let (comp, owner_badge, agent_badge) = AgentBudget::new('
            f'funds, amount!({per_tx_cap}), amount!({daily_cap}), {epochs_per_window}u64, [{wl}]);\n'
            '    owner.deposit(owner_badge);\n'
            '    owner.deposit(agent_badge);\n'
            '}\n'
        )
        res = self.client.run(manifest, {"owner": self.owner_account})
        blob = json.dumps(res)
        comps = _components(blob, {self.owner_account, self.agent_account, *whitelist})
        badges = _badge_resources(blob)
        if not comps or len(badges) < 2:
            raise ChainError("could not locate the new budget component / badges in the result")
        self.component = comps[0]
        # owner badge minted first, agent badge second; sorted() is stable but not creation order,
        # so for devnet (one account holds both) either proof authorizes. Record both.
        self.owner_badge, self.agent_badge = badges[0], badges[1]
        self.per_tx_cap, self.daily_cap, self.whitelist = per_tx_cap, daily_cap, list(whitelist)
        return self

    def revoke(self) -> None:
        self._owner_call("revoke()")
        self.revoked = True

    def withdraw(self, amount: int) -> None:
        manifest = (
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            f'    let proof = owner.create_proof_for_resource(address!("{self.owner_badge}"));\n'
            '    let mut budget = var!["budget"];\n'
            f'    let coins = budget.withdraw(amount!({amount}));\n'
            '    owner.deposit(coins);\n'
            '    drop_all_proofs!();\n'
            '}\n'
        )
        self.client.run(manifest, {"owner": self.owner_account, "budget": self.component})

    def add_merchant(self, merchant: str) -> None:
        self._owner_call(f'add_merchant(address!("{merchant}"))')
        if merchant not in self.whitelist:
            self.whitelist.append(merchant)

    def _owner_call(self, call: str) -> None:
        manifest = (
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            f'    let proof = owner.create_proof_for_resource(address!("{self.owner_badge}"));\n'
            '    let mut budget = var!["budget"];\n'
            f'    budget.{call};\n'
            '    drop_all_proofs!();\n'
            '}\n'
        )
        self.client.run(manifest, {"owner": self.owner_account, "budget": self.component})

    # -- agent -----------------------------------------------------------------------
    def _pay_manifest(self, merchant: str, amount: int, memo: str) -> str:
        return (
            'fn main() {\n'
            '    let mut agent = var!["agent"];\n'
            f'    let proof = agent.create_proof_for_resource(address!("{self.agent_badge}"));\n'
            '    let mut budget = var!["budget"];\n'
            f'    budget.pay(address!("{merchant}"), amount!({amount}), "{memo}");\n'
            '    drop_all_proofs!();\n'
            '}\n'
        )

    def pay(self, merchant: str, amount: int, *, memo: str = "") -> dict:
        """The agent pays a whitelisted merchant. The client-side checks below are only an early,
        friendly error — the chain enforces the real limits regardless of what this client does.
        The local ledger is updated from the on-chain ``pay`` event, not from the request."""
        self._precheck(merchant, amount)
        res = self.client.run(self._pay_manifest(merchant, amount, memo),
                              {"agent": self.agent_account, "budget": self.component})
        for ev in self.pay_events(res):      # ledger follows the chain's events
            self.spent += int(ev.get("amount", amount))
            self.ledger.append(LedgerEntry(ev.get("merchant", merchant),
                                           int(ev.get("amount", amount)), ev.get("memo", memo), "pay"))
        return res

    def would_reject(self, merchant: str, amount: int, *, memo: str = "forced") -> str | None:
        """Ask the validator (via a dry run) whether this pay would be rejected, returning the
        on-chain reason — used to show that the *chain*, not the client, enforces the rules."""
        r = self.client.dry_run(self._pay_manifest(merchant, amount, memo),
                                {"agent": self.agent_account, "budget": self.component})
        if "error" in r:
            return _clean_reason(r["error"].get("message", "rejected"))
        if '"Reject"' in json.dumps(r.get("result", {})):
            return _reject_reason(r["result"]) or "rejected"
        return None

    def pay_invoice(self, *, merchant: str, invoice_id: str, amount: int, agent_tag: str = "") -> dict:
        """Pay an invoice: the invoice id + agent tag ride along as the on-chain memo, unchanged
        from the phase-1 codec (`agentpay.invoice.encode_memo`)."""
        memo = encode_memo(invoice_id, agent_tag)["Message"]
        return self.pay(merchant, amount, memo=memo)

    def _precheck(self, merchant: str, amount: int) -> None:
        if self.revoked:
            raise PolicyViolation(("budget revoked (client pre-check; chain also rejects)",))
        if amount <= 0 or amount > self.per_tx_cap:
            raise PolicyViolation((f"amount {amount} over per-tx cap {self.per_tx_cap} (client pre-check)",))
        if self.whitelist and merchant not in self.whitelist:
            raise PolicyViolation(("merchant not whitelisted (client pre-check)",))
        if self.spent + amount > self.daily_cap:
            raise PolicyViolation((f"would exceed daily cap {self.daily_cap} (client pre-check)",))

    # -- events / ledger -------------------------------------------------------------
    @staticmethod
    def pay_events(result: dict) -> list[dict]:
        """Extract the AgentBudget ``pay`` events (payload: merchant/amount/memo/spent_in_window)
        from a tx result — this is how a watcher keeps a local ledger in sync with the chain. The
        same event is recorded in two places in the result, so we de-duplicate."""
        out: list[dict] = []
        seen: set = set()
        for ev in _iter_events(result):
            p = ev.get("payload")
            if isinstance(p, dict) and "merchant" in p and "memo" in p:
                key = (p.get("merchant"), p.get("amount"), p.get("memo"))
                if key not in seen:
                    seen.add(key)
                    out.append(p)
        return out


def _iter_events(result: Any):
    """Yield every event-shaped dict (has a ``payload``) anywhere in a result tree."""
    if isinstance(result, dict):
        if "payload" in result and ("topic" in result or "substate_id" in result):
            yield result
        for v in result.values():
            yield from _iter_events(v)
    elif isinstance(result, list):
        for v in result:
            yield from _iter_events(v)


def _clean_reason(message: str) -> str:
    m = re.search(r"Template error: (.+?)(?:\"|$)", message)
    if m:
        return m.group(1)
    m = re.search(r"rejected: (.+?)(?:\"|$)", message)
    return m.group(1) if m else message
