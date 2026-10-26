"""Session persistence. The store never holds secrets: keys are re-derived from the master seed."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Protocol

from .models import Session


class SessionStore(Protocol):
    def get(self, session_id: str) -> Session | None: ...
    def put(self, session: Session) -> None: ...
    def all(self) -> list[Session]: ...


class MemoryStore:
    def __init__(self) -> None:
        self._d: dict[str, Session] = {}

    def get(self, session_id: str) -> Session | None:
        return self._d.get(session_id)

    def put(self, session: Session) -> None:
        self._d[session.id] = session

    def all(self) -> list[Session]:
        return list(self._d.values())


class JsonFileStore(MemoryStore):
    """Atomic-write JSON file. Single-process only: use a real DB for multi-process agents."""

    def __init__(self, path: str | Path):
        super().__init__()
        self.path = Path(path)
        if self.path.exists():
            for raw in json.loads(self.path.read_text()).get("sessions", []):
                s = Session.from_json(raw)
                self._d[s.id] = s

    def put(self, session: Session) -> None:
        super().put(session)
        data = json.dumps({"sessions": [s.to_json() for s in self._d.values()]}, indent=1)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent or ".", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            f.write(data)
        os.replace(tmp, self.path)
