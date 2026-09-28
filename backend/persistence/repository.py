"""Where sessions live."""

from typing import Protocol

from domain.models import Session


class SessionRepository(Protocol):
    """The storage surface the API depends on."""

    def add(self, session: Session) -> None: ...

    def get(self, session_id: str) -> Session | None: ...


class InMemorySessionRepository:
    """Sessions for the lifetime of the process."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    def add(self, session: Session) -> None:
        self._sessions[session.id] = session

    def get(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)
