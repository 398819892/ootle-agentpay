"""On-chain budget adapter — the phase-2 (on-chain conditions) path.

The phase-1 `BudgetManager` (budget.py) gets a hard ceiling from throw-away key derivation
and enforces the per-tx cap / allowlist *client-side only*. This module instead backs the
budget with the **AgentBudget** Ootle template, so the per-transaction cap, the per-window
spending cap (a fixed epoch window, not a trailing 24h), the merchant whitelist and the kill
switch are all enforced **on chain** by the
validator — the agent's client cannot override them.

It talks to a running Tari Ootle wallet daemon over JSON-RPC (the same one `tari publish`
uses). It is deliberately stdlib-only (no `ootle-py`): a template component is driven by
submitting a transaction *manifest*, which the daemon parses, signs and commits.

Pairs with the `agent_budget` and `escrow` templates in this repo's sibling `templates/`
directory. See examples/demo_devnet.py for an end-to-end run against a local swarm.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from .errors import ChainError, PolicyViolation
from .invoice import encode_memo

# Native Tari test token used as the (plaintext, countable) budget resource on a devnet.
XTR = "XTR"
# Manifest keyword for the native token. `XTR` was a deprecated alias that tari-ootle 0.48 removed
# (#3076): a 0.48+ manifest parser resolves only `TARI`, while 0.47 accepts both — so every manifest
# splices `TARI`. The `XTR` constant stays as the API-level name for "the native token".
_NATIVE_KEYWORD = "TARI"
_NATIVE_ALIASES = ("XTR", "TARI")


def _proof_windows_default() -> bool:
    """Whether owner-badge manifests open an explicit proof authorization window.

    tari-ootle 0.49 (#3206) changed the model: a proof left on the transaction workspace authorizes
    NOTHING until ``authorize!(proof)`` opens a window over it (closed by ``drop_authorize!``), and a
    window is lent exactly one hop (the budget component). A 0.47 manifest parser does not know the
    two macros and rejects the manifest outright, so the dialect is a switch: default ON (the repo
    targets 0.49); set ``AGENTPAY_PROOF_WINDOWS=0`` to keep the pre-0.49 dialect for a 0.47 walletd.
    The agent's ``pay`` proof is only *shown* to the template (passed as an argument, read with
    ``assert_resource``/``get_non_fungibles``), which needs no window on either version.
    """
    v = os.environ.get("AGENTPAY_PROOF_WINDOWS", "").strip().lower()
    return v not in ("0", "false", "no", "off")

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
# Defaults for the dry-run transient-retry loop (esmeralda indexer hiccups). 30 × 12s ≈ 6 min is a
# deliberately patient ceiling for a congested public testnet; a local swarm never retries at all
# (it produces no transient markers). Override per-client via the `WalletdClient` constructor, or
# process-wide via `AGENTPAY_SUBMIT_RETRIES` / `AGENTPAY_SUBMIT_RETRY_DELAY`.
_SUBMIT_RETRIES = 30
_SUBMIT_RETRY_DELAY = 12  # seconds


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name, "").strip()
    if not v:
        return default
    try:
        return int(v)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    v = os.environ.get(name, "").strip()
    if not v:
        return default
    try:
        return float(v)
    except ValueError:
        return default


def _is_transient(message: str) -> bool:
    return any(m in message for m in _TRANSIENT_MARKERS)


def _err_message(err: Any) -> str:
    """The human message from a JSON-RPC ``error`` field, whatever its shape. A conformant daemon
    sends ``{"code", "message"}``, but real responses also carry a bare string or an object without a
    ``message`` — reading ``err["message"]`` blindly then raises AttributeError/KeyError on a tx that
    was already SUBMITTED, which the caller would misreport as a hard failure. (N-5)"""
    if isinstance(err, dict):
        return str(err.get("message") or "")
    return str(err) if err else ""


class WalletdClient:
    """Minimal JSON-RPC client for a Tari Ootle wallet daemon (auth = ``none`` devnet mode)."""

    def __init__(
        self,
        url: str = "http://127.0.0.1:12010/json_rpc",
        *,
        token: str | None = None,
        permissions: list[str] | None = None,
        credentials: str = "None",
        submit_retries: int | None = None,
        submit_retry_delay: float | None = None,
    ) -> None:
        """Connect to a wallet daemon.

        Devnet default: ``auth=none`` daemon, mint an ``Admin`` token with no credentials — fine for a
        local swarm where one account plays every role.

        **Non-custodial deployment** (the agent holds its own key in its own environment): pass a
        least-privilege ``token`` minted out-of-band for the agent's OWN walletd (so this client never
        asks for ``Admin``), or pass a narrower ``permissions`` list + ``credentials`` for this client
        to mint one itself. Request only what submitting/reading a transaction needs — never ``Admin``,
        which could sign for any account and defeats the point of the on-chain caps. See
        ``docs/deployment-noncustodial.md``. Defaults can also come from the environment:
        ``AGENTPAY_WALLETD_TOKEN``, ``AGENTPAY_WALLETD_PERMISSIONS`` (comma-separated),
        ``AGENTPAY_WALLETD_CREDENTIALS``.

        The dry-run transient-retry budget is tunable too: ``submit_retries`` /
        ``submit_retry_delay`` (seconds) override the module defaults, or set
        ``AGENTPAY_SUBMIT_RETRIES`` / ``AGENTPAY_SUBMIT_RETRY_DELAY`` process-wide. These bound only
        the **dry-run** loop; a real submit never auto-retries (H5), whatever these are set to.
        """
        self.url = url
        self._token: str | None = token or os.environ.get("AGENTPAY_WALLETD_TOKEN") or None
        if permissions is None:
            env_perms = os.environ.get("AGENTPAY_WALLETD_PERMISSIONS")
            permissions = [p.strip() for p in env_perms.split(",") if p.strip()] if env_perms else ["Admin"]
        self._permissions = permissions
        self._credentials = os.environ.get("AGENTPAY_WALLETD_CREDENTIALS", credentials)
        self._submit_retries = (
            submit_retries if submit_retries is not None
            else _env_int("AGENTPAY_SUBMIT_RETRIES", _SUBMIT_RETRIES)
        )
        self._submit_retry_delay = (
            submit_retry_delay if submit_retry_delay is not None
            else _env_float("AGENTPAY_SUBMIT_RETRY_DELAY", _SUBMIT_RETRY_DELAY)
        )

    def _rpc(self, method: str, params: Any) -> dict:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(self.url, data=body, headers={"Content-Type": "application/json"})
        if self._token:
            req.add_header("Authorization", "Bearer " + self._token)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                envelope = json.loads(r.read())
        except urllib.error.HTTPError as e:
            # A JSON-RPC daemon normally answers 200 even for RPC-level errors; a non-2xx means an
            # HTTP-layer failure (bad token → 401, overload → 5xx …). If the error body still carries a
            # JSON-RPC envelope, hand it back untouched so the normal `error`/transient-retry handling
            # applies; otherwise surface a structured ChainError instead of a bare HTTPError.
            raw = b""
            try:
                raw = e.read()
            except Exception:
                pass
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and ("error" in parsed or "result" in parsed):
                    return parsed
            except Exception:
                pass
            snippet = raw.decode("utf-8", "replace")[:200].strip()
            err = ChainError(
                f"walletd HTTP {e.code} for {method}" + (f": {snippet}" if snippet else "")
            )
            # 401/403 = the auth layer rejected the request BEFORE dispatch (bad / expired token): the
            # method never ran, so a REAL submit that hits this definitely did NOT land. Flag it so the
            # submit path surfaces it as a hard failure, not `pending` (which would wrongly tell a caller
            # "it may have landed, go reconcile"). Mirrors the TS D-13 guard.
            if e.code in (401, 403):
                err.auth_failed = True
            raise err from e
        except urllib.error.URLError as e:
            # Connection refused / DNS / socket timeout: the daemon was unreachable. The real-submit
            # path promotes a thrown transport error to `pending` (never a blind resubmit).
            raise ChainError(f"could not reach walletd at {self.url} for {method}: {e.reason}") from e
        except (TimeoutError, OSError) as e:
            # A read timeout, a reset mid-read (RemoteDisconnected), or another socket error NOT wrapped
            # as URLError. Surface as a ChainError so no caller ever sees a raw socket error; the
            # real-submit path promotes it to `pending` (submitted-but-unknown), never a resubmit. (D-1)
            raise ChainError(f"walletd call {method} failed (transport): {e}") from e
        except json.JSONDecodeError as e:
            # walletd answered with a truncated / non-JSON body — a transport-level fault too. (D-1)
            raise ChainError(f"walletd call {method} returned an unreadable response: {e}") from e
        # A 200 body must be a JSON-RPC envelope: a bare null / list / dict lacking BOTH `result` and
        # `error` is a malformed response (a transport-level fault). Surface it as ChainError here so
        # the real-submit path promotes it to pending, instead of letting a caller crash parsing
        # `result`/`error` on a tx that may already have landed. (N-5)
        if not isinstance(envelope, dict) or ("result" not in envelope and "error" not in envelope):
            raise ChainError(f"walletd call {method} returned a malformed response (no result/error envelope)")
        return envelope

    def connect(self) -> "WalletdClient":
        """Obtain a token. If one was supplied (a least-privilege token minted out-of-band for this
        agent's own walletd — the non-custodial path), use it as-is and request nothing. Otherwise
        mint one with the configured ``permissions``/``credentials`` (devnet default: ``Admin`` on an
        ``auth=none`` daemon)."""
        if self._token:
            return self
        r = self._rpc(
            "auth.request",
            {"permissions": self._permissions, "duration": None, "credentials": self._credentials},
        )
        self._token = r["result"]["token"]
        return self

    # -- accounts -------------------------------------------------------------------
    def account_address(self, name: str) -> str:
        for a in self._rpc("accounts.list", {"offset": 0, "limit": 50})["result"]["accounts"]:
            if a["account"]["name"] == name:
                return a["account"]["component_address"]
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

    def balance(self, name: str, token_symbol: str = "tTARI") -> int:
        """Balance of `name` in `token_symbol` (default ``tTARI``, the native XTR test token). Pass the
        symbol of a non-XTR budget's resource to read it instead of always returning 0 (audit #11)."""
        r = self._rpc("accounts.get_balances", {"account": {"Name": name}, "refresh": True})
        for b in r["result"].get("balances", []):
            if b["token_symbol"] == token_symbol:
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
            for _ in range(max(1, self._submit_retries)):
                last = self._rpc("transactions.submit_manifest", params)
                err = last.get("error")
                if not err or not _is_transient(_err_message(err)):
                    return last
                time.sleep(self._submit_retry_delay)
            return last
        try:
            resp = self._rpc("transactions.submit_manifest", params)
        except Exception as e:
            # A THROWN error on a REAL submit (transport drop, read timeout, HTTP 5xx) is ambiguous:
            # the manifest may already have reached the node and created a tx while only the response
            # was lost. Surface as pending (unknown) — reconcile by tx id, never blind-resubmit. (D-1)
            pe = e if isinstance(e, ChainError) else ChainError(str(e))
            # Exception: a DEFINITIVE auth failure (HTTP 401/403 — bad / expired token) is rejected at
            # the auth layer before dispatch, so the tx never landed. It is a hard failure, NOT pending:
            # marking it pending would wrongly tell the caller "it may have landed, reconcile" for a
            # request that was never submitted. (review follow-up; mirrors the TS D-13 guard)
            if not getattr(e, "auth_failed", False):
                pe.pending = True  # unknown: reconcile, never auto-resubmit (H5)
            raise pe from e
        err = resp.get("error")
        if err is not None and _is_transient(_err_message(err)):
            e = ChainError(
                "submit may or may not have landed (transient error, not resubmitted): " + _err_message(err)
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
        # `r` is a validated JSON-RPC envelope (see _rpc). A well-formed `error` is a DEFINITIVE
        # submit-time rejection — the node refused it, so no tx was created; read the message whatever
        # its shape (dict / bare string / object without `message`) rather than crashing on it. (N-5)
        if r.get("error") is not None:
            raise ChainError(_err_message(r["error"]) or "submit rejected")
        # Otherwise read a tx id from `result`. If `result` is null / not a dict / carries no id, the
        # submit returned 200 but we cannot identify the tx: it MAY have landed, so it is UNKNOWN
        # (pending) — never a hard failure (which would invite a blind resubmit, H5) and never a 120x
        # poll of `None`. Any unforeseen parse fault here is treated the same way. (N-5 / D-1)
        try:
            result = r.get("result")
            tx_id = (result.get("transaction_id") or result.get("hash")) if isinstance(result, dict) else None
        except Exception as e:  # pragma: no cover - defensive against an unforeseen result shape
            pe = ChainError("submit response could not be parsed; outcome unknown: " + str(e))
            pe.pending = True
            raise pe from e
        if not tx_id:
            e = ChainError("submit returned no usable transaction id; outcome unknown")
            e.pending = True
            raise e
        for _ in range(120):   # esmeralda finalization can be slow under congestion
            try:
                res = self._rpc("transactions.get_result", {"transaction_id": tx_id}).get("result")
            except Exception as e:
                # Transport blip AFTER a successful submit: the tx is on chain, we just can't read its
                # verdict right now. UNKNOWN, not failed — carry tx_id so the caller reconciles. (D-1)
                pe = e if isinstance(e, ChainError) else ChainError(str(e))
                pe.pending = True
                pe.tx_id = tx_id
                raise pe from e
            # Decide accept/reject from the structured TransactionResult, not by searching the JSON
            # blob for "Accept"/"Reject": the `AcceptFeeRejectRest` variant (fee taken, rest rejected)
            # contains the substring "Accept" yet is a FAILURE, and reject reasons are now objects
            # (`ExecutionFailure { code, message }`) a substring scan can't read.
            outcome = _finalized_outcome(res)
            if outcome is not None:
                kind, reason = outcome
                if kind == "accept":
                    return res
                # Finalized chain Reject — a DEFINITIVE verdict (the tx moved no funds). Flag it so a
                # caller (and the MCP layer) tell it apart from a pending/unknown outcome. (D-1)
                e = ChainError(reason)
                e.chain_rejected = True
                raise e
            # A consensus-level terminal failure (InvalidTransaction / Rejected) has a top-level status
            # but no FinalizeResult — also a definitive reject (the tx never executed). (D-12)
            st = res.get("status") if isinstance(res, dict) else None
            if st in _TERMINAL_FAILURE_STATUSES:
                e = ChainError(f"transaction {tx_id} rejected at consensus ({st})")
                e.chain_rejected = True
                raise e
            time.sleep(1.5)
        # Did not finalize in the window: SUBMITTED but unknown. Carry pending + tx_id so the caller
        # records it unknown and reconciles by tx id — never a hard failure. (D-1)
        e = ChainError(f"transaction {tx_id} did not finalize in time")
        e.pending = True
        e.tx_id = tx_id
        raise e

    def get_result(self, tx_id: str) -> tuple[str, str | None]:
        """Resolve a transaction id to ``("accept"|"reject"|"pending", reason)`` with a single
        read-only ``get_result`` call. Never submits or signs — this is what a status probe /
        reconciler uses to settle a previously-submitted tx id against the chain's verdict. (D-1)"""
        res = self._rpc("transactions.get_result", {"transaction_id": tx_id}).get("result")
        outcome = _finalized_outcome(res)
        if outcome is not None:
            return outcome
        # A consensus-level terminal failure (InvalidTransaction / Rejected) has a top-level status
        # but no FinalizeResult, so _finalized_outcome misses it — a definitive reject, not pending. (D-12)
        st = res.get("status") if isinstance(res, dict) else None
        if st in _TERMINAL_FAILURE_STATUSES:
            return ("reject", f"transaction {st}")
        return ("pending", None)


# --- structured transaction-result handling -------------------------------------------------
# The Ootle returns a typed result tree; we navigate it by key instead of regex-matching the JSON
# string, so a reject reason (now an object, e.g. ``ExecutionFailure { code, message }``) and the
# accept/reject distinction are read from the actual fields. See the engine's `commit_result.rs`:
#   TransactionResult = { "Accept": diff } | { "Reject": reason } | { "AcceptFeeRejectRest": [diff, reason] }
# and RejectReason = { "ExecutionFailure": { code, message } } | { "<Variant>": "<message>" } | "<Variant>".

_TX_RESULT_VARIANTS = ("Accept", "Reject", "AcceptFeeRejectRest")

# Wallet-daemon TransactionStatus values that are TERMINAL failures carrying NO FinalizeResult (the
# typed result tree is null), so `_finalized_outcome` can't see them — only the top-level `status`
# reveals them. Without this, such a tx is polled as "pending" forever and never reconciles. (D-12)
_TERMINAL_FAILURE_STATUSES = ("InvalidTransaction", "Rejected")


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


def _cbor_hex(x: Any) -> str | None:
    """The 32-byte hex payload of a CBOR-tagged address object, or None. Tag-agnostic (any
    ``{'value': {'hex': ...}}``), matching the web reconciler's reader (web/server/substate.js)."""
    if isinstance(x, dict):
        v = x.get("value")
        if isinstance(v, dict) and isinstance(v.get("hex"), str):
            return v["hex"]
    return None


def _parse_budget_state(state: Any) -> dict:
    """Decode the AgentBudget component's POSITIONAL state array by explicit index + type, raising a
    descriptive ``ValueError`` on any layout drift so a caller falls back to "unknown" rather than
    reporting a wrong number. 1:1 with the web reconciler's substate.js ``parseBudgetState`` (#16).

    Struct order (templates/agent_budget/src/lib.rs):
      [0] vault  [1] owner_badge  [2] agent_badge  [3] per_tx_cap  [4] daily_cap
      [5] spent_in_window  [6] window_start_epoch  [7] epochs_per_window
      [8] merchant_whitelist  [9] revoked  [10] revoked_sessions  [11..] escrow fields

    (The web reader rejects Amounts above 2^53 as a lossy JS-number read; Python's ``json`` decodes
    integers losslessly, so no such guard is needed here — only the type checks.)
    """
    if not isinstance(state, list) or len(state) < 10:
        raise ValueError(
            "unexpected budget component layout: expected a list of >=10 fields, got "
            + (f"length {len(state)}" if isinstance(state, list) else type(state).__name__)
        )
    if _cbor_hex(state[0]) is None:
        raise ValueError("unexpected budget component layout: field 0 (vault) is not an address")

    def _num(i: int, name: str) -> int:
        v = state[i]
        # bool is an int subclass in Python — exclude it so a mis-typed slot is still caught.
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValueError(
                f"unexpected budget component layout: field {i} ({name}) is "
                f"{type(v).__name__}, expected an integer"
            )
        return v

    per_tx_cap = _num(3, "per_tx_cap")
    daily_cap = _num(4, "daily_cap")
    spent_in_window = _num(5, "spent_in_window")
    window_start_epoch = _num(6, "window_start_epoch")
    epochs_per_window = _num(7, "epochs_per_window")
    if not isinstance(state[8], list):
        raise ValueError("unexpected budget component layout: field 8 (merchant_whitelist) is not an array")
    if not isinstance(state[9], bool):
        raise ValueError("unexpected budget component layout: field 9 (revoked) is not a boolean")
    return {
        "vault_hex": _cbor_hex(state[0]),
        "per_tx_cap": per_tx_cap,
        "daily_cap": daily_cap,
        "spent_in_window": spent_in_window,
        "window_start_epoch": window_start_epoch,
        "epochs_per_window": epochs_per_window,
        "whitelist_raw": state[8],
        "revoked": state[9],
    }


def _created_component(result: Any, template: str) -> str | None:
    """The component this tx CREATED from ``template``, read from the engine's ``std.component.created``
    event (its ``template_address`` identifies the creating template) — authoritative, rather than
    guessing "the first unknown ``component_…`` address" in the result blob. ``template`` is a
    ``template_<hex>`` address; the event carries the bare hex, so compare on that. (#2)"""
    tmpl_hex = template.split("_", 1)[-1]
    for ev in _iter_events(result):
        topic = ev.get("topic")
        leaf = topic.rsplit(".", 1)[-1] if isinstance(topic, str) else None
        sid = ev.get("substate_id")
        if (leaf == "created" and isinstance(sid, str) and sid.startswith("component_")
                and ev.get("template_address") == tmpl_hex):
            return sid
    return None


def _info_event_payload(result: Any) -> dict | None:
    """The payload of the ``info`` event emitted by ``AgentBudget::get_info`` (namespaced topic
    ``AgentBudget.info``) — a NAME-keyed map of the budget's fields, or ``None`` if absent."""
    for ev in _iter_events(result):
        topic = ev.get("topic")
        if isinstance(topic, str) and topic.rsplit(".", 1)[-1] == "info":
            p = ev.get("payload")
            return p if isinstance(p, dict) else None
    return None


def _parse_info_payload(p: dict) -> dict:
    """Decode the name-keyed ``info`` payload (every value is a string) into typed fields. Because the
    read is keyed by NAME, a same-type field swap in the component struct is caught here — the thing
    the positional reader cannot see (#1). Raises ``ValueError`` on a missing/mistyped field so a
    caller can fall back to the positional read."""
    def _int(name: str) -> int:
        v = p.get(name)
        if not isinstance(v, str):
            raise ValueError(f"info event field {name!r} missing or not a string: {v!r}")
        try:
            return int(v)
        except ValueError as e:
            raise ValueError(f"info event field {name!r} is not an integer: {v!r}") from e
    revoked = p.get("revoked")
    if revoked not in ("true", "false"):
        raise ValueError(f"info event field 'revoked' is not a boolean: {revoked!r}")
    return {
        "revoked": revoked == "true",
        "balance": _int("balance"),
        "per_tx_cap": _int("per_tx_cap"),
        "daily_cap": _int("daily_cap"),
        "spent_in_window": _int("spent_in_window"),
        "window_start_epoch": _int("window_start_epoch"),
        "epochs_per_window": _int("epochs_per_window"),
    }


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
    # The resource the budget is denominated in. `"XTR"` (the native test token) is the default so the
    # devnet flow is unchanged; a non-XTR budget passes a `resource_…` address to `open` (the template
    # itself is resource-agnostic — it locks whatever it is funded with). `top_up` reuses this.
    resource: str = "XTR"
    # The agent session badge this client proves when it pays: the label of ONE non-fungible of the
    # agent-badge resource ("default" is minted by `open`; `issue_agent_badge` mints more). The pay
    # proof is built with `create_proof_by_non_fungible_ids` so it carries exactly that token — the
    # template rejects a proof with several session tokens ("Present exactly one agent session
    # badge"), which is what `create_proof_for_resource` yields once an account holds 2+ badges.
    session: str = "default"
    # Manifest dialect for owner-badge calls: open an `authorize!` window around the call (0.49+) or
    # not (0.47). See `_proof_windows_default`.
    proof_windows: bool = field(default_factory=_proof_windows_default)
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

    def _resource_arg(self) -> str:
        """Manifest expression for the budget's resource: the ``XTR`` keyword for the native token,
        else a strictly-validated ``address!("resource_…")``. Keeps the resource out of a raw string
        splice (same injection guard as every other spliced value)."""
        return _NATIVE_KEYWORD if self.resource in _NATIVE_ALIASES else f'address!("{_check_resource(self.resource)}")'

    # -- owner -----------------------------------------------------------------------
    def open(self, *, fund: int, per_tx_cap: int, daily_cap: int,
             epochs_per_window: int, whitelist: list[str], resource: str = "XTR") -> "OnChainBudget":
        self.resource = resource
        wl = ", ".join(f'address!("{_check_component(m)}")' for m in whitelist)
        manifest = (
            f'use {_check_template(self.budget_template)} as AgentBudget;\n'
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            f'    let funds = owner.withdraw({self._resource_arg()}, amount!({_check_amount(fund)}));\n'
            f'    let (comp, owner_badge, agent_badge) = AgentBudget::new('
            f'funds, amount!({_check_amount(per_tx_cap)}), amount!({_check_amount(daily_cap)}), {int(epochs_per_window)}u64, [{wl}]);\n'
            '    owner.deposit(owner_badge);\n'
            '    owner.deposit(agent_badge);\n'
            '}\n'
        )
        res = self.client.run(manifest, {"owner": self.owner_account})
        # Locate the new component from the engine's `std.component.created` event (its template
        # address identifies it), not by scanning for "the first unknown component address" in the
        # result blob. Fall back to that scan only if the event is ever absent, so discovery never
        # regresses to failing. (#2)
        comp = _created_component(res, self.budget_template)
        if comp is None:
            blob = json.dumps(res)
            cands = _components(blob, {self.owner_account, self.agent_account, *whitelist})
            comp = cands[0] if cands else None
        if comp is None:
            raise ChainError("could not locate the new budget component in the result")
        self.component = comp
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

    def read_info(self) -> dict:
        """Read this budget's live state by DRY-RUNNING ``get_info`` and decoding its name-keyed
        ``info`` event payload: ``revoked``, ``balance``, ``per_tx_cap``, ``daily_cap``,
        ``spent_in_window``, ``window_start_epoch``, ``epochs_per_window``. Because the fields are
        keyed by NAME (not position), a same-type field swap in the component struct is caught here —
        the gap the positional component-state read cannot see (#1). The dry run charges no real fee.
        Raises ``ChainError`` (no component / walletd unreachable / no info event) or ``ValueError``
        (the payload is missing or mistyped a field)."""
        if not self.component:
            raise ChainError("budget has no on-chain component yet")
        manifest = 'fn main() {\n    let budget = var!["budget"];\n    budget.get_info();\n}\n'
        r = self.client.dry_run(manifest, {"budget": self.component})
        payload = _info_event_payload(r)
        if payload is None:
            raise ChainError("get_info dry-run did not expose an info event")
        return _parse_info_payload(payload)

    def read_onchain_state(self) -> dict:
        """Authoritatively read this budget's LIVE state: ``per_tx_cap``, ``daily_cap``,
        ``spent_in_window`` (the chain's own running total — it reflects spends by EVERY session of
        this budget, not just this process), ``window_start_epoch``, ``epochs_per_window`` and
        ``revoked``. Read-only.

        Prefers the name-keyed ``get_info`` ``info`` event (``read_info`` — catches a same-type field
        swap, #1); falls back to the positional component-state read (``_parse_budget_state``,
        1:1 with the web reconciler, #16) if the event is unavailable (older template or a changed
        event shape). Raises ``ChainError`` (no component yet / walletd unreachable) or ``ValueError``
        (both reads found an unexpected shape)."""
        if not self.component:
            raise ChainError("budget has no on-chain component yet")
        try:
            return self.read_info()
        except (ChainError, ValueError):
            state = _find_component_state(self.client.get_substate(self.component))
            if state is None:
                raise ChainError("could not read the budget component state from chain")
            return _parse_budget_state(state)

    def revoke(self) -> None:
        self._owner_call("revoke()")
        self.revoked = True

    def withdraw(self, amount: int) -> None:
        manifest = (
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            + self._owner_proof_open() +
            '    let mut budget = var!["budget"];\n'
            f'    let coins = budget.withdraw(amount!({_check_amount(amount)}));\n'
            '    owner.deposit(coins);\n'
            + self._owner_proof_close() +
            '}\n'
        )
        self.client.run(manifest, {"owner": self.owner_account, "budget": self.component})

    def add_merchant(self, merchant: str) -> None:
        self._owner_call(f'add_merchant(address!("{_check_component(merchant)}"))')
        if merchant not in self.whitelist:
            self.whitelist.append(merchant)

    def remove_merchant(self, merchant: str) -> None:
        """Owner removes `merchant` from the on-chain whitelist (template ``remove_merchant``,
        owner-badge gated). The address stops being payable once the tx finalizes; the local
        mirror follows the accepted call. Removing a non-whitelisted address is a chain no-op."""
        self._owner_call(f'remove_merchant(address!("{_check_component(merchant)}"))')
        self.whitelist = [m for m in self.whitelist if m != merchant]

    def set_limits(self, per_tx_cap: int, daily_cap: int) -> None:
        """Owner changes both caps in one on-chain call (template ``set_limits``, owner-badge gated).
        The new per-tx cap binds on the very next ``pay``; the daily cap applies to the current
        rolling window (spend already counted is kept). Both go through ``_check_amount``."""
        p, d = _check_amount(per_tx_cap), _check_amount(daily_cap)
        self._owner_call(f"set_limits(amount!({p}), amount!({d}))")
        self.per_tx_cap = int(p)
        self.daily_cap = int(d)

    def issue_agent_badge(self, session: str, *, to_account: str | None = None) -> str:
        """Owner mints a new agent session badge labelled `session` and deposits it into `to_account`
        (defaults to this budget's agent account). The new badge can `pay` within the same on-chain
        caps/whitelist until the owner revokes *that* session. Returns the session label."""
        target = to_account or self.agent_account
        _check_session(session)
        manifest = (
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            + self._owner_proof_open() +
            '    let mut budget = var!["budget"];\n'
            f'    let badge = budget.issue_agent_badge("{session}");\n'
            '    let mut agent = var!["agent"];\n'
            '    agent.deposit(badge);\n'
            + self._owner_proof_close() +
            '}\n'
        )
        self.client.run(manifest, {"owner": self.owner_account, "budget": self.component,
                                   "agent": target})
        if session not in self.sessions:
            self.sessions.append(session)
        if session in self.revoked_sessions:          # mirrors the template on a successful mint; note a
            self.revoked_sessions.remove(session)     # revoked badge's label can only be re-minted after
                                                      # that badge was burned (its NFT still exists)
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
            f'    let funds = funder.withdraw({self._resource_arg()}, amount!({_check_amount(amount)}));\n'
            '    let mut budget = var!["budget"];\n'
            '    budget.top_up(funds);\n'
            '}\n'
        )
        self.client.run(manifest, {"funder": funder, "budget": self.component})

    def _owner_proof_open(self) -> str:
        """Manifest lines that prove the owner badge — and, in the 0.49 dialect, open the
        authorization window the budget's owner-gated methods are reached through."""
        line = f'    let proof = owner.create_proof_for_resource(address!("{_check_resource(self.owner_badge)}"));\n'
        return line + ('    authorize!(proof);\n' if self.proof_windows else '')

    def _owner_proof_close(self) -> str:
        """Closes the window opened by `_owner_proof_open` (0.49 dialect) and drops the proof."""
        return ('    drop_authorize!(proof);\n' if self.proof_windows else '') + '    drop_all_proofs!();\n'

    def _owner_call(self, call: str) -> None:
        manifest = (
            'fn main() {\n'
            '    let mut owner = var!["owner"];\n'
            + self._owner_proof_open() +
            '    let mut budget = var!["budget"];\n'
            f'    budget.{call};\n'
            + self._owner_proof_close() +
            '}\n'
        )
        self.client.run(manifest, {"owner": self.owner_account, "budget": self.component})

    # -- agent -----------------------------------------------------------------------
    def _pay_manifest(self, merchant: str, amount: int, memo: str, session: str | None = None) -> str:
        # The agent presents a proof of ONE session badge, selected by its non-fungible id; `pay`
        # reads it to identify (and, if revoked, refuse) the session before moving funds. The label
        # goes through `_check_session` before it is spliced into the `non_fungible_id!("…")` literal.
        sess = _check_session(self.session if session is None else session)
        return (
            'fn main() {\n'
            '    let mut agent = var!["agent"];\n'
            f'    let proof = agent.create_proof_by_non_fungible_ids(address!("{_check_resource(self.agent_badge)}"), [non_fungible_id!("{sess}")]);\n'
            '    let mut budget = var!["budget"];\n'
            f'    budget.pay(proof, address!("{_check_component(merchant)}"), amount!({_check_amount(amount)}), "{_check_memo(memo)}");\n'
            '    drop_all_proofs!();\n'
            '}\n'
        )

    def pay(self, merchant: str, amount: int, *, memo: str = "", session: str | None = None) -> dict:
        """The agent pays a whitelisted merchant. The client-side checks below are only an early,
        friendly error — the chain enforces the real limits regardless of what this client does.
        The local ledger is updated from the on-chain ``pay`` event, not from the request.
        ``session`` selects which issued session badge pays (defaults to ``self.session``)."""
        self._precheck(merchant, amount)
        res = self.client.run(self._pay_manifest(merchant, amount, memo, session),
                              {"agent": self.agent_account, "budget": self.component})
        for ev in self.pay_events(res):      # ledger follows the chain's events
            # Track spend from the chain's OWN running total (`spent_in_window`), not by accumulating
            # locally. The on-chain window resets lazily, so a local accumulator keeps growing past a
            # window roll and makes `_precheck` wrongly reject payments the chain would accept — which,
            # via MCP, even surfaces as a misleading infra error (audit #1). Fall back to accumulation
            # only if an event somehow lacks the field.
            siw = ev.get("spent_in_window")
            self.spent = int(siw) if siw is not None else self.spent + int(ev.get("amount", amount))
            self.ledger.append(LedgerEntry(ev.get("merchant", merchant),
                                           int(ev.get("amount", amount)), ev.get("memo", memo), "pay"))
        return res

    def would_reject(self, merchant: str, amount: int, *, memo: str = "forced",
                     session: str | None = None) -> str | None:
        """Ask the validator (via a dry run) whether this pay would be rejected, returning the
        on-chain reason — used to show that the *chain*, not the client, enforces the rules."""
        r = self.client.dry_run(self._pay_manifest(merchant, amount, memo, session),
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

    def pay_invoice(self, *, merchant: str, invoice_id: str, amount: int, agent_tag: str = "",
                    session: str | None = None) -> dict:
        """Pay an invoice: the invoice id + agent tag ride along as the on-chain memo, unchanged
        from the phase-1 codec (`agentpay.invoice.encode_memo`)."""
        memo = encode_memo(invoice_id, agent_tag)["Message"]
        return self.pay(merchant, amount, memo=memo, session=session)

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
        same event is recorded in two places in the result, so we de-duplicate.

        Filter by the event **topic**, not merely "the payload has merchant+memo" — a
        ``pay_via_escrow`` event carries those fields too and would otherwise be miscounted as a direct
        pay. The engine NAMESPACES a template event topic as ``<Struct>.<event>``, so the on-chain topic
        is ``AgentBudget.pay`` (escrow is ``AgentBudget.pay_via_escrow``); match the final segment
        ``pay`` so both the namespaced form and a bare ``pay`` are accepted while
        ``pay_via_escrow``/``pay_fee`` are excluded. (A bare ``pay`` check silently dropped EVERY real
        pay event, emptying the ledger.) The de-dup key includes ``spent_in_window`` (the running total,
        which strictly increases by ``amount`` on each pay): two COPIES of one event share it (so they
        collapse), while two DISTINCT pays in a single tx differ in it (so both are kept, not merged).
        See `docs/audit-notes.md`."""
        out: list[dict] = []
        seen: set = set()
        for ev in _iter_events(result):
            topic = ev.get("topic")
            leaf = topic.rsplit(".", 1)[-1] if isinstance(topic, str) else topic
            if leaf != "pay":
                continue
            p = ev.get("payload")
            if isinstance(p, dict) and "merchant" in p and "memo" in p:
                key = (p.get("merchant"), p.get("amount"), p.get("memo"), p.get("spent_in_window"))
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
