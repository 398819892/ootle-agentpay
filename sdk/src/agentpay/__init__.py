"""ootle-agentpay: private, budget-capped stablecoin payments for AI agents on Ootle."""
from __future__ import annotations

from .budget import AgentWallet, BudgetManager, OpenResult, PaymentProof, SweepResult
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

__all__ = [
    "AgentPayError", "AgentWallet", "BudgetManager", "ChainError", "ChainPort",
    "ComplianceGuard", "FrozenUtxo", "Identity", "InsufficientBudget", "Invoice",
    "InvoiceError", "JsonFileStore", "LedgerEntry", "Merchant", "MemoryStore",
    "OnChainBudget", "OpenResult", "OwnedUtxo", "PayeeNotRegistered", "PaymentProof",
    "PlannedTx", "PolicyViolation", "PrivacyReport", "Session", "SessionClosed",
    "SessionPolicy", "SessionStore", "StealthOut", "SweepResult", "VerificationFailed",
    "VerifiedPayment", "WalletdClient", "assess", "from_challenge", "new_invoice_id",
    "plan_batch", "to_challenge",
]
