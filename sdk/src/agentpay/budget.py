"""Private session budgets.

Model (phase 1, works with ootle-py today, no on-chain conditions needed):

  owner master seed --derive--> session key K_s (throw-away account)
  owner funds K_s with ONE stealth UTXO of `amount`  => the on-chain hard cap
  agent holds K_s and can spend only that UTXO (payment + change = one live UTXO)
  owner can re-derive K_s any time and sweep what is left  => kill switch
  SDK policy (per-tx cap, allowlist, expiry, rate) is enforced client-side

Trust model, plainly:
  - A compromised agent can spend up to the funded amount, never more.
  - A compromised agent can ignore the SDK policy (it holds the key). Only the funded
    amount is hard-enforced until phase 2 (on-chain conditions).
  - The issuer of the coin can still freeze/recall (see compliance.py).

One live UTXO per session is deliberate: ootle-py's stealth builder accepts one stealth
input per owner address per transfer.
"""
from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass

from .chain import ChainPort
from .compliance import ComplianceGuard
from .errors import InsufficientBudget, PolicyViolation, SessionClosed, ChainError
from .invoice import Invoice, encode_memo
from .keys import derive_scalar_pair, session_path
from .models import Identity, OwnedUtxo, Session, SessionPolicy, StealthOut, TxRef, TxResult
from .payout import jitter_fee
from .policy import PolicyEngine
from .store import SessionStore


@dataclass(frozen=True)
class OpenResult:
    session: Session
    owner_change: OwnedUtxo | None
    tx: TxRef


@dataclass(frozen=True)
class SweepResult:
    recovered: int
    tx: TxRef | None


@dataclass(frozen=True)
class PaymentProof:
    tx_id: str
    invoice_id: str | None
    amount: int
    remaining: int


class BudgetManager:
    """Owner-side: opens sessions, sweeps them, hands out AgentWallets."""

    def __init__(
        self,
        chain: ChainPort,
        owner: Identity,
        master_seed: bytes,
        store: SessionStore,
        *,
        coin: str,
        base_fee: int = 1_000,
        clock: Callable[[], float] = time.time,
    ):
        self.chain, self.owner, self._seed, self.store = chain, owner, master_seed, store
        self.coin, self.base_fee, self.clock = coin, base_fee, clock
        self.guard = ComplianceGuard(chain)
        self._locks: dict[str, asyncio.Lock] = {}

    # -- identities -----------------------------------------------------------------
    def agent_identity(self, session: Session) -> Identity:
        o, v = derive_scalar_pair(self._seed, session.agent_path)
        return self.chain.identity_from_scalars(o, v)

    def _lock(self, sid: str) -> asyncio.Lock:
        return self._locks.setdefault(sid, asyncio.Lock())

    # -- lifecycle ------------------------------------------------------------------
    async def open_session(
        self, name: str, policy: SessionPolicy, funding: OwnedUtxo, amount: int
    ) -> OpenResult:
        if amount <= 0 or amount > funding.value:
            raise InsufficientBudget("amount must be in (0, funding.value]")
        if policy.session_cap > amount:
            raise PolicyViolation((f"session_cap {policy.session_cap} exceeds funded amount {amount}",))
        sid = "s" + secrets.token_hex(6)
        session = Session(sid, name, session_path(sid), policy, amount, created_at=self.clock())
        agent = self.agent_identity(session)
        res: TxResult = await self.chain.send_stealth(
            self.owner, [funding], [StealthOut(agent.address, amount)],
            fee=jitter_fee(self.base_fee),
        )
        got = await self.chain.read_outputs(res.tx, agent)
        live = next((g for g in got if g.value == amount), None)
        if live is None:
            raise ChainError("funding output not readable by the session key")
        session.utxo = OwnedUtxo(live.commitment, live.value)
        self.store.put(session)
        return OpenResult(session, res.change, res.tx)

    async def sweep(self, session_id: str) -> SweepResult:
        """Kill switch: move whatever is left back to the owner."""
        s = self._get(session_id)
        async with self._lock(s.id):
            if s.status != "active" or s.utxo is None:
                return SweepResult(0, None)
            agent = self.agent_identity(s)
            await self.guard.check_spend(s.utxo, self.owner.address)
            value = s.utxo.value
            res = await self.chain.send_stealth(
                agent, [s.utxo], [StealthOut(self.owner.address, value)],
                fee=jitter_fee(self.base_fee),
            )
            s.status, s.utxo = "swept", None
            self.store.put(s)
            return SweepResult(value, res.tx)

    async def expire_due(self) -> list[SweepResult]:
        """Call periodically (cron / background task): sweeps sessions past their expiry."""
        now, out = self.clock(), []
        for s in self.store.all():
            if s.status == "active" and s.policy.expires_at is not None and now >= s.policy.expires_at:
                r = await self.sweep(s.id)
                s.status = "expired"
                self.store.put(s)
                out.append(r)
        return out

    def wallet_for(self, session_id: str) -> "AgentWallet":
        return AgentWallet(self, self._get(session_id))

    def _get(self, session_id: str) -> Session:
        s = self.store.get(session_id)
        if s is None:
            raise SessionClosed(f"unknown session {session_id}")
        return s


class AgentWallet:
    """Agent-side handle: the only object an AI agent needs."""

    def __init__(self, mgr: BudgetManager, session: Session):
        self._m, self._s = mgr, session
        self._agent = mgr.agent_identity(session)
        self._engine = PolicyEngine(session.policy, session.ledger, mgr.clock)

    def status(self) -> dict:
        s = self._s
        return {
            "session": s.id, "state": s.status,
            "remaining": 0 if s.utxo is None else s.utxo.value,
            "spent": self._engine.spent, "session_cap": s.policy.session_cap,
            "expires_at": s.policy.expires_at,
        }

    async def pay(self, payee: str, amount: int, *, memo: dict | None = None) -> PaymentProof:
        s, m = self._s, self._m
        async with m._lock(s.id):
            if s.status != "active" or s.utxo is None:
                raise SessionClosed(f"session {s.id} is {s.status}")
            d = self._engine.evaluate(payee, amount)
            if not d.allowed:
                raise PolicyViolation(d.reasons)
            if amount > s.utxo.value:
                raise InsufficientBudget(f"need {amount}, have {s.utxo.value}")
            await m.guard.check_spend(s.utxo, payee)
            res = await m.chain.send_stealth(
                self._agent, [s.utxo], [StealthOut(payee, amount, memo)],
                fee=jitter_fee(m.base_fee),
            )
            self._engine.record(amount)
            s.utxo = res.change            # None when fully spent
            m.store.put(s)
            return PaymentProof(res.tx.tx_id, None, amount, 0 if s.utxo is None else s.utxo.value)

    async def pay_invoice(self, invoice: Invoice, *, agent_tag: str = "") -> PaymentProof:
        if invoice.expired(self._m.clock()):
            raise PolicyViolation(("invoice expired",))
        if invoice.coin != self._m.coin:
            raise PolicyViolation((f"invoice coin {invoice.coin} is not this session's coin",))
        proof = await self.pay(invoice.payee, invoice.amount, memo=encode_memo(invoice.invoice_id, agent_tag))
        return PaymentProof(proof.tx_id, invoice.invoice_id, proof.amount, proof.remaining)
