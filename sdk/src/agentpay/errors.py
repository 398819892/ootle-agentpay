"""Exception hierarchy. Every failure the SDK raises derives from AgentPayError."""
from __future__ import annotations


class AgentPayError(Exception):
    """Base class."""


class PolicyViolation(AgentPayError):
    """A payment was refused by the session policy. ``reasons`` lists every rule broken."""

    def __init__(self, reasons: tuple[str, ...]):
        self.reasons = reasons
        super().__init__("; ".join(reasons))


class SessionClosed(AgentPayError):
    """The session was swept, expired or never existed."""


class InsufficientBudget(AgentPayError):
    """The session's live UTXO cannot cover the requested amount."""


class FrozenUtxo(AgentPayError):
    """The issuer froze the UTXO the session needs to spend."""


class PayeeNotRegistered(AgentPayError):
    """The stablecoin variant requires holder registration and the payee has none."""


class InvoiceError(AgentPayError):
    """Malformed, expired or otherwise unusable invoice / memo."""


class VerificationFailed(AgentPayError):
    """Merchant could not verify a claimed payment."""


class ChainError(AgentPayError):
    """The chain adapter failed (rejected transaction, indexer error...)."""
