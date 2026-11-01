"""ootle-agentpay: budget-capped, chain-enforced payments for AI agents on Tari Ootle (L2).

The supported, on-chain path is ``agentpay.onchain`` (``OnChainBudget`` / ``WalletdClient``): a
stdlib-only adapter that drives the ``AgentBudget`` template through a wallet daemon, so the
per-transaction cap, rolling daily cap, merchant whitelist and kill switch are enforced by the
validator. Amounts are PUBLIC on chain (see docs/security.md).

EXPERIMENTAL (not part of the supported surface, kept importable for the offline demo/tests only):
``agentpay.budget`` (``BudgetManager`` / ``AgentWallet`` — the phase-1 client-side-policy model whose
limits a compromised agent can bypass) and ``agentpay.ootle_chain.OotlePyChain`` (never run against a
live indexer, still has ``NotImplementedError`` stubs). Neither is exported in ``__all__``; import them
explicitly from their modules if you knowingly want them.
"""
from __future__ import annotations

# Phase-1 (experimental) names: importable for backwards compatibility / the offline demo, but
# deliberately NOT in __all__ — see the module docstring and sdk/README.md "Status".
from .budget import AgentWallet, BudgetManager, OpenResult, PaymentProof, SweepResult  # noqa: F401
from .chain import ChainPort
from .compliance import ComplianceGuard
from .errors import (
    AgentPayError, ChainError, FrozenUtxo, InsufficientBudget, InvoiceError,
    PayeeNotRegistered, PolicyViolation, SessionClosed, VerificationFailed,
)
from .invoice import Invoice, from_challenge, new_invoice_id, to_challenge
from .merchant import Merchant, VerifiedPayment
from .models import Identity, OwnedUtxo, Session, SessionPolicy, StealthOut
from .onchain import LedgerEntry, OnChainBudget, WalletdClient
from .payout import PlannedTx, plan_batch
from .privacy import PrivacyReport, assess
from .store import JsonFileStore, MemoryStore, SessionStore

__version__ = "0.1.0"

#: Names that are experimental / unsupported and therefore excluded from ``__all__``.
EXPERIMENTAL = ("AgentWallet", "BudgetManager", "OpenResult", "PaymentProof", "SweepResult", "OotlePyChain")

__all__ = [
    # supported on-chain path
    "OnChainBudget", "WalletdClient", "LedgerEntry",
    # invoice / memo codec (used by the on-chain path)
    "Invoice", "InvoiceError", "from_challenge", "new_invoice_id", "to_challenge",
    # errors
    "AgentPayError", "ChainError", "FrozenUtxo", "InsufficientBudget", "PayeeNotRegistered",
    "PolicyViolation", "SessionClosed", "VerificationFailed",
    # chain-agnostic helpers (merchant verification, compliance, privacy linter, payout planner, stores)
    "ChainPort", "ComplianceGuard", "Identity", "JsonFileStore", "Merchant", "MemoryStore",
    "OwnedUtxo", "PlannedTx", "PrivacyReport", "Session", "SessionPolicy", "SessionStore",
    "StealthOut", "VerifiedPayment", "assess", "plan_batch",
    "EXPERIMENTAL",
]
