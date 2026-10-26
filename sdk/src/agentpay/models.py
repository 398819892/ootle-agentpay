"""Plain data types shared by every module. No I/O, no chain dependency."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Identity:
    """An account on chain. ``handle`` is adapter-specific (an OotleSecretKey for the real adapter)."""

    address: str
    handle: Any = field(default=None, repr=False, compare=False)


@dataclass(frozen=True)
class OwnedUtxo:
    commitment: bytes
    value: int


@dataclass(frozen=True)
class StealthOut:
    destination: str                     # bech32m address
    amount: int                          # base units, > 0
    memo: dict[str, Any] | None = None   # Ootle Memo JSON, e.g. {"Message": "..."}


@dataclass(frozen=True)
class TxRef:
    tx_id: str


@dataclass(frozen=True)
class TxResult:
    tx: TxRef
    change: OwnedUtxo | None             # sender's change UTXO, if any


@dataclass(frozen=True)
class ReceivedOutput:
    commitment: bytes
    value: int
    memo: dict[str, Any] | None


@dataclass(frozen=True)
class SessionPolicy:
    """Limits enforced by the SDK (advisory on chain in phase 1; see docs/01)."""

    per_tx_cap: int
    session_cap: int
    daily_cap: int | None = None
    allowlist: frozenset[str] | None = None     # payee addresses; None = anyone
    expires_at: float | None = None             # unix seconds; None = no expiry
    max_tx_per_hour: int | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "per_tx_cap": self.per_tx_cap,
            "session_cap": self.session_cap,
            "daily_cap": self.daily_cap,
            "allowlist": None if self.allowlist is None else sorted(self.allowlist),
            "expires_at": self.expires_at,
            "max_tx_per_hour": self.max_tx_per_hour,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "SessionPolicy":
        al = d.get("allowlist")
        return cls(
            per_tx_cap=int(d["per_tx_cap"]),
            session_cap=int(d["session_cap"]),
            daily_cap=d.get("daily_cap"),
            allowlist=None if al is None else frozenset(al),
            expires_at=d.get("expires_at"),
            max_tx_per_hour=d.get("max_tx_per_hour"),
        )


@dataclass
class Session:
    id: str
    name: str
    agent_path: str
    policy: SessionPolicy
    funded: int
    status: str = "active"                      # active | swept | expired
    created_at: float = 0.0
    utxo: OwnedUtxo | None = None               # the single live UTXO
    ledger: list[tuple[float, int]] = field(default_factory=list)   # (ts, amount)

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "agent_path": self.agent_path,
            "policy": self.policy.to_json(), "funded": self.funded, "status": self.status,
            "created_at": self.created_at,
            "utxo": None if self.utxo is None else {"c": self.utxo.commitment.hex(), "v": self.utxo.value},
            "ledger": [[t, a] for t, a in self.ledger],
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "Session":
        u = d.get("utxo")
        return cls(
            id=d["id"], name=d["name"], agent_path=d["agent_path"],
            policy=SessionPolicy.from_json(d["policy"]), funded=int(d["funded"]),
            status=d.get("status", "active"), created_at=float(d.get("created_at", 0.0)),
            utxo=None if u is None else OwnedUtxo(bytes.fromhex(u["c"]), int(u["v"])),
            ledger=[(float(t), int(a)) for t, a in d.get("ledger", [])],
        )
