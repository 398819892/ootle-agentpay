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

# --- manifest value validation (injection guard, issue #7) --------------------------------------
# A transaction manifest is assembled as text, so EVERY value spliced into it must be validated here,
# at the lowest layer (inside the manifest builders) — not only in `_precheck`. This way a direct SDK
# caller (`pay`, `pay_invoice`, `issue_agent_badge`, …) is protected too: an attacker-controlled memo
# or address can never break out of its literal and inject extra manifest instructions (which, when
# the owner and agent share an account, could move the owner's funds / bypass the authorizer).
#
# Values handed to walletd as `variables` (the accounts, the budget component) are NOT a vector: the
# daemon parses those as typed values, never splicing them into the manifest text. The values below
# ARE spliced in, so each is checked against a strict allowlist and rejected otherwise.
_COMPONENT_RE = re.compile(r"^component_[0-9a-f]{64}$")
_RESOURCE_RE = re.compile(r"^resource_[0-9a-f]{64}$")
_TEMPLATE_RE = re.compile(r"^template_[0-9a-f]{64}$")
_SESSION_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")
_MEMO_MAX_BYTES = 253  # Ootle Message-memo limit (see invoice.MAX_MEMO_BYTES)


def _check_address(addr: Any, kind: str, regex: "re.Pattern[str]") -> str:
    """Return `addr` if it is exactly ``<kind>_<64 lowercase hex>``, else raise. Used for every
    address spliced into an ``address!("…")`` / ``use …`` clause."""
    # fullmatch, not match: Python's `$` also matches just before a trailing newline, so
    # `regex.match("component_<64hex>\n")` would wrongly pass. fullmatch anchors the whole string.
    if not isinstance(addr, str) or not regex.fullmatch(addr):
        raise ChainError(f"invalid {kind} address (expected {kind}_ + 64 hex chars): {addr!r}")
    return addr


def _check_component(addr: Any) -> str:
    return _check_address(addr, "component", _COMPONENT_RE)


def _check_resource(addr: Any) -> str:
    return _check_address(addr, "resource", _RESOURCE_RE)


def _check_template(addr: Any) -> str:
    return _check_address(addr, "template", _TEMPLATE_RE)


def _check_memo(memo: Any) -> str:
    """Validate a free-text memo before it is spliced into a ``"…"`` manifest string literal.

    Rejects anything that could terminate the literal or start an escape sequence — a double-quote
    or a backslash (so we never depend on the manifest parser's escape handling) — plus any control
    character (newline / tab / NUL …, which could smuggle in further manifest lines) and over-length
    memos. Returns the memo unchanged when safe. Empty is allowed. Any accepted memo is guaranteed to
    stay inside its literal, so it cannot inject manifest instructions."""
    if not isinstance(memo, str):
        raise ChainError(f"memo must be a string, got {type(memo).__name__}")
    if '"' in memo or "\\" in memo:
        raise ChainError('memo must not contain a double-quote (") or backslash (\\)')
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in memo):
        raise ChainError("memo must not contain control characters")
    if len(memo.encode("utf-8")) > _MEMO_MAX_BYTES:
        raise ChainError(f"memo too long (max {_MEMO_MAX_BYTES} bytes)")
    return memo


def _check_session(session: Any) -> str:
    """Validate an agent session label before it is spliced into a ``"…"`` literal."""
    if not isinstance(session, str) or not _SESSION_RE.fullmatch(session):  # fullmatch: reject trailing newline
        raise ChainError("session label must match [A-Za-z0-9_.-]{1,64}")
    return session


def _check_amount(x: Any) -> str:
    """Normalise a base-unit amount to a decimal-integer string for an ``amount!(…)`` literal,
    rejecting negatives, non-integers and anything that is not a plain decimal integer (so no
    expression can ride in through the amount field)."""
    if isinstance(x, bool):                       # bool is an int subclass — reject explicitly
        raise ChainError(f"invalid amount: {x!r}")
    if isinstance(x, int):
        if x < 0:
            raise ChainError(f"amount cannot be negative: {x}")
        return str(x)
    if isinstance(x, str):
        s = x.strip()
        if not re.fullmatch(r"\d+", s):
            raise ChainError(f"invalid amount (expected a non-negative integer): {x!r}")
        return s
    raise ChainError(f"invalid amount type: {type(x).__name__}")

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

    def get_substate(self, substate_id: str) -> dict:
        """Fetch a substate (component / resource / vault) by its address. Read-only."""
        r = self._rpc("substates.get", {"substate_id": substate_id})
        if "error" in r:
            raise ChainError(r["error"].get("message", "substates.get failed"))
        return r["result"]

    # -- transactions ---------------------------------------------------------------
    def _submit_manifest(self, manifest: str, variables: dict[str, str], max_fee: int,
                         dry_run: bool) -> dict:
        """Submit a manifest. A transient error (connection / 30s indexer timeout seen on esmeralda)
        is ambiguous for a REAL submit: the manifest may already have reached the node and created a
        transaction while only the response was lost, so resubmitting it would be a *new* transaction
        — a double-spend (H5). We therefore retry transient errors ONLY for dry runs (no state
        change); a real submit does a single attempt and surfaces a transient failure as ``pending``
        (unknown), to be reconciled by tx id rather than blindly resubmitted. A template/policy
        rejection is returned immediately either way. A local swarm never produces transient errors."""
        params = {"manifest": manifest, "variables": variables, "max_fee": max_fee, "dry_run": dry_run}
        if dry_run:
            last = None
            for _ in range(_SUBMIT_RETRIES):
                last = self._rpc("transactions.submit_manifest", params)
                err = last.get("error")
                if not err or not _is_transient(err.get("message", "")):
                    return last
                time.sleep(_SUBMIT_RETRY_DELAY)
            return last
        resp = self._rpc("transactions.submit_manifest", params)
        err = resp.get("error")
        if err and _is_transient(err.get("message", "")):
            e = ChainError(
                "submit may or may not have landed (transient error, not resubmitted): "
                + err.get("message", "")
            )
            e.pending = True  # unknown: reconcile, never auto-resubmit (H5)
            raise e
        return resp

    def dry_run(self, manifest: str, variables: dict[str, str], max_fee: int = 200_000) -> dict:
        return self._submit_manifest(manifest, variables, max_fee, dry_run=True)

    def run(self, manifest: str, variables: dict[str, str], max_fee: int = 200_000) -> dict:
        """Submit a manifest for real and wait for it to finalize. Returns the finalized result
        (whose transaction result is ``Accept``). Raises ChainError on rejection."""
        r = self._submit_manifest(manifest, variables, max_fee, dry_run=False)
        if "error" in r:
            raise ChainError(r["error"]["message"])
        tx_id = r["result"].get("transaction_id") or r["result"].get("hash")
        for _ in range(120):   # esmeralda finalization can be slow under congestion
            res = self._rpc("transactions.get_result", {"transaction_id": tx_id}).get("result")
            # Decide accept/reject from the structured TransactionResult, not by searching the JSON
            # blob for "Accept"/"Reject": the `AcceptFeeRejectRest` variant (fee taken, rest rejected)
            # contains the substring "Accept" yet is a FAILURE, and reject reasons are now objects
            # (`ExecutionFailure { code, message }`) a substring scan can't read.
            outcome = _finalized_outcome(res)
            if outcome is not None:
                kind, reason = outcome
                if kind == "accept":
                    return res
                raise ChainError(reason)
            time.sleep(1.5)
        raise ChainError(f"transaction {tx_id} did not finalize in time")


# --- structured transaction-result handling -------------------------------------------------
# The Ootle returns a typed result tree; we navigate it by key instead of regex-matching the JSON
# string, so a reject reason (now an object, e.g. ``ExecutionFailure { code, message }``) and the
# accept/reject distinction are read from the actual fields. See the engine's `commit_result.rs`:
#   TransactionResult = { "Accept": diff } | { "Reject": reason } | { "AcceptFeeRejectRest": [diff, reason] }
# and RejectReason = { "ExecutionFailure": { code, message } } | { "<Variant>": "<message>" } | "<Variant>".

_TX_RESULT_VARIANTS = ("Accept", "Reject", "AcceptFeeRejectRest")


def _transaction_result(rpc_result: Any) -> dict | None:
    """Locate the typed TransactionResult inside a walletd result, across both nesting shapes.

    ``transactions.get_result`` nests it at ``result.result``; a dry run (``submit_manifest``) nests
    it at ``result.result.finalize.result``. We descend the known wrapper keys rather than guessing.
    """
    node = rpc_result
    for _ in range(6):
        if not isinstance(node, dict):
            return None
        if any(v in node for v in _TX_RESULT_VARIANTS):
            return node
        node = node.get("result") if node.get("result") is not None else node.get("finalize")
    return None


def _render_reject(reason: Any) -> str:
    """Render a structured RejectReason (or a bare string) into a human message."""
    if reason is None:
        return "transaction rejected"
    if isinstance(reason, str):
        return reason
    if isinstance(reason, dict) and reason:
        variant, payload = next(iter(reason.items()))
        if isinstance(payload, dict):               # e.g. ExecutionFailure { code, message }
            return _clean_panic(payload.get("message")) if payload.get("message") else variant
        if isinstance(payload, str):                # e.g. SubstateNotFound("...")
            return payload
        return variant
    return "transaction rejected"


def _finalized_outcome(rpc_result: Any) -> tuple[str, str | None] | None:
    """``("accept", None)`` / ``("reject", reason)`` once finalized, else ``None`` (still pending)."""
    tr = _transaction_result(rpc_result)
    if tr is None:
        return None
    if "Accept" in tr:
        return ("accept", None)
    if "Reject" in tr:
        return ("reject", _render_reject(tr["Reject"]))
    if "AcceptFeeRejectRest" in tr:
        pair = tr["AcceptFeeRejectRest"]
        reason = pair[1] if isinstance(pair, list) and len(pair) > 1 else None
        return ("reject", _render_reject(reason))
    return None


def _clean_panic(message: str) -> str:
    """Strip the engine's instruction/panic framing from a template assertion message so the UI shows
    the budget's own wording (e.g. ``Agent has been revoked``) rather than ``At instruction #2: Panic! …``."""
    m = re.search(r"Panic(?:ked)?[:!]?\s*(.+)", message)
    if m:
        return m.group(1).strip().rstrip(".")
    return message.strip()


def _components(blob: str, exclude: set[str]) -> list[str]:
    return [c for c in set(re.findall(r"component_[0-9a-f]{64}", blob)) if c not in exclude]


def _badge_resources(blob: str) -> list[str]:
    # non-fungible badge resources minted by the template (exclude the native XTR resource 0101..
    # and the zero template address resource 0000..). Used only to sanity-check that `new` minted
    # two badges; the owner/agent *mapping* is read authoritatively from component state, never from
    # address sort order (see `_read_badges`).
    return sorted(x for x in set(re.findall(r"resource_[0-9a-f]{64}", blob))
                  if not x.startswith("resource_0101") and not x.startswith("resource_0000"))


# The AgentBudget component's state is a positional array matching its struct fields, in order:
#   (vault, owner_badge, agent_badge, per_tx_cap, daily_cap, spent_in_window, window_start_epoch,
#    epochs_per_window, merchant_whitelist, revoked, revoked_sessions, escrow_* …).
# Addresses are CBOR-tagged objects: tag 131 = ResourceAddress, 132 = VaultId, 128 = ComponentAddress.
# So the two tag-131 entries are, in order, the owner badge then the agent badge.
_CBOR_TAG_RESOURCE = 131


def _find_component_state(node: Any) -> list | None:
    """Find the AgentBudget component's positional state array anywhere in a substates.get result."""
    if isinstance(node, dict):
        comp = node.get("Component")
        if isinstance(comp, dict):
            body = comp.get("body")
            if isinstance(body, dict) and isinstance(body.get("state"), list):
                return body["state"]
        for v in node.values():
            r = _find_component_state(v)
            if r is not None:
                return r
    elif isinstance(node, list):
        for v in node:
            r = _find_component_state(v)
            if r is not None:
                return r
    return None


def _tagged_resources(state: list) -> list[str]:
    """ResourceAddresses (CBOR tag 131) in the state array, in struct order: [owner_badge, agent_badge]."""
    out: list[str] = []
    for x in state:
        if isinstance(x, dict) and x.get("tag") == _CBOR_TAG_RESOURCE:
            hexv = (x.get("value") or {}).get("hex")
            if isinstance(hexv, str):
                out.append("resource_" + hexv)
    return out


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
    # Agent session badges issued for this budget (the first, "default", comes from `open`). These
    # are tracked client-side for convenience; the chain is the source of truth for what each can do.
    sessions: list[str] = field(default_factory=lambda: ["default"])
    revoked_sessions: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.agent_account is None:
            self.agent_account = self.owner_account

    # -- owner -----------------------------------------------------------------------
    def open(self, *, fund: int, per_tx_cap: int, daily_cap: int,
             epochs_per_window: int, whitelist: list[str]) -> "OnChainBudget":
        wl = ", ".join(f'address!("{_check_component(m)}")' for m in whitelist)
        manifest = (
            f'use {_check_template(self.budget_template)} as AgentBudget;\n'
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            f'    let funds = owner.withdraw(XTR, amount!({_check_amount(fund)}));\n'
            f'    let (comp, owner_badge, agent_badge) = AgentBudget::new('
            f'funds, amount!({_check_amount(per_tx_cap)}), amount!({_check_amount(daily_cap)}), {int(epochs_per_window)}u64, [{wl}]);\n'
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
        # Resolve which badge is which from the component's on-chain state, NOT from address sort
        # order. The owner and agent badges are two distinct non-fungible resources; `pay` asserts
        # the *agent* badge resource specifically, so proving the wrong one is rejected on chain
        # ("Proof of resource did not match"). The struct lays them out as (owner_badge, agent_badge).
        self.owner_badge, self.agent_badge = self._read_badges()
        self.per_tx_cap, self.daily_cap, self.whitelist = per_tx_cap, daily_cap, list(whitelist)
        return self

    def _read_badges(self) -> tuple[str, str]:
        """Read `(owner_badge, agent_badge)` authoritatively from the component's on-chain state."""
        state = _find_component_state(self.client.get_substate(self.component))
        if not state:
            raise ChainError("could not read the budget component state to resolve badges")
        resources = _tagged_resources(state)
        if len(resources) < 2:
            raise ChainError("budget component state did not expose the owner and agent badges")
        return resources[0], resources[1]  # struct order: owner_badge, agent_badge

    def revoke(self) -> None:
        self._owner_call("revoke()")
        self.revoked = True

    def withdraw(self, amount: int) -> None:
        manifest = (
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            f'    let proof = owner.create_proof_for_resource(address!("{_check_resource(self.owner_badge)}"));\n'
            '    let mut budget = var!["budget"];\n'
            f'    let coins = budget.withdraw(amount!({_check_amount(amount)}));\n'
            '    owner.deposit(coins);\n'
            '    drop_all_proofs!();\n'
            '}\n'
        )
        self.client.run(manifest, {"owner": self.owner_account, "budget": self.component})

    def add_merchant(self, merchant: str) -> None:
        self._owner_call(f'add_merchant(address!("{_check_component(merchant)}"))')
        if merchant not in self.whitelist:
            self.whitelist.append(merchant)

    def issue_agent_badge(self, session: str, *, to_account: str | None = None) -> str:
        """Owner mints a new agent session badge labelled `session` and deposits it into `to_account`
        (defaults to this budget's agent account). The new badge can `pay` within the same on-chain
        caps/whitelist until the owner revokes *that* session. Returns the session label."""
        target = to_account or self.agent_account
        _check_session(session)
        manifest = (
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            f'    let proof = owner.create_proof_for_resource(address!("{_check_resource(self.owner_badge)}"));\n'
            '    let mut budget = var!["budget"];\n'
            f'    let badge = budget.issue_agent_badge("{session}");\n'
            '    let mut agent = var!["agent"];\n'
            '    agent.deposit(badge);\n'
            '    drop_all_proofs!();\n'
            '}\n'
        )
        self.client.run(manifest, {"owner": self.owner_account, "budget": self.component,
                                   "agent": target})
        if session not in self.sessions:
            self.sessions.append(session)
        if session in self.revoked_sessions:          # re-issuing clears a prior revoke (mirrors chain)
            self.revoked_sessions.remove(session)
        return session

    def revoke_session(self, session: str) -> None:
        """Owner revokes a single agent session badge. Other sessions keep working; use `revoke()`
        for the global kill switch."""
        self._owner_call(f'revoke_session("{_check_session(session)}")')
        if session not in self.revoked_sessions:
            self.revoked_sessions.append(session)

    def set_window(self, epochs_per_window: int) -> None:
        """Owner reconfigures the rolling allowance window (and restarts it now). The daily cap is the
        recurring per-window allowance — see the module/template docs on there being no on-chain timer."""
        self._owner_call(f"set_window({int(epochs_per_window)}u64)")
        self.spent = 0

    def top_up(self, amount: int, *, from_account: str | None = None) -> None:
        """Add `amount` to the budget's vault, funded from `from_account` (defaults to the owner).
        `top_up` is open on the template, so a keeper account can replenish the budget on its own
        cadence — the chain has no scheduler to do it automatically."""
        funder = from_account or self.owner_account
        manifest = (
            'fn main() {\n'
            '    let mut funder = var!["funder"];\n'
            f'    let funds = funder.withdraw(XTR, amount!({int(amount)}));\n'
            '    let mut budget = var!["budget"];\n'
            '    budget.top_up(funds);\n'
            '}\n'
        )
        self.client.run(manifest, {"funder": funder, "budget": self.component})

    def _owner_call(self, call: str) -> None:
        manifest = (
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            f'    let proof = owner.create_proof_for_resource(address!("{_check_resource(self.owner_badge)}"));\n'
            '    let mut budget = var!["budget"];\n'
            f'    budget.{call};\n'
            '    drop_all_proofs!();\n'
            '}\n'
        )
        self.client.run(manifest, {"owner": self.owner_account, "budget": self.component})

    # -- agent -----------------------------------------------------------------------
    def _pay_manifest(self, merchant: str, amount: int, memo: str) -> str:
        # The agent presents a proof of its session badge; `pay` reads it to identify (and, if
        # revoked, refuse) the session before moving funds.
        return (
            'fn main() {\n'
            '    let mut agent = var!["agent"];\n'
            f'    let proof = agent.create_proof_for_resource(address!("{_check_resource(self.agent_badge)}"));\n'
            '    let mut budget = var!["budget"];\n'
            f'    budget.pay(proof, address!("{_check_component(merchant)}"), amount!({_check_amount(amount)}), "{_check_memo(memo)}");\n'
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
        # walletd surfaces a dry-run rejection either as an RPC error (a plain message string — no
        # structured field is available there, so it is parsed in the one place _clean_reason lives)
        # or as a finalized result whose TransactionResult is Reject (read structurally).
        if "error" in r:
            return _clean_reason(r["error"].get("message", "rejected"))
        outcome = _finalized_outcome(r.get("result"))
        if outcome is not None and outcome[0] == "reject":
            return outcome[1]
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
    """Extract the meaningful reason from a walletd RPC *error message* for a dry run.

    This is the ONE place we parse a reject out of a free-text string, and only because a dry-run
    rejection arrives as an RPC error whose `message` is human text with no structured field to read,
    e.g. ``Application error: 5: Dry-run transaction rejected: Execution failure (AssertionFailed):
    At instruction #2: Panic! Agent has been revoked``. Committed-transaction rejections (`run`) and
    dry-run results that carry a typed TransactionResult go through `_finalized_outcome` instead.
    """
    m = re.search(r"rejected:\s*(.+?)(?:\"|$)", message)
    tail = m.group(1).strip() if m else message.strip()
    # If the tail is the engine's "Execution failure (Code): <...>: Panic! <msg>" form, surface the
    # template's own wording; otherwise return the tail as-is.
    panic = re.search(r"Panic(?:ked)?[:!]?\s*(.+)", tail)
    return panic.group(1).strip().rstrip(".") if panic else tail
