"""The rows Socrates' Duck keeps on disk."""

from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class SessionRow(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime]
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
    status: Mapped[str] = mapped_column(String(16))
    final_outcome: Mapped[str | None] = mapped_column(String(16), default=None)
    code_context_count: Mapped[int] = mapped_column(default=0)
    had_evidence: Mapped[bool] = mapped_column(default=False)

    hints: Mapped[list["HintRow"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    attempts: Mapped[list["AttemptRow"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class HintRow(Base):
    """One delivered hint, as numbers and verdicts."""

    __tablename__ = "hints"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"))
    created_at: Mapped[datetime]
    level: Mapped[int]
    kind: Mapped[str] = mapped_column(String(16))
    source: Mapped[str] = mapped_column(String(16))
    deterministic_verdict: Mapped[str] = mapped_column(String(16))
    judge_verdict: Mapped[str] = mapped_column(String(16))
    rewrites: Mapped[int] = mapped_column(default=0)
    rule: Mapped[str | None] = mapped_column(String(32), default=None)

    session: Mapped[SessionRow] = relationship(back_populates="hints")


class QuestionRow(Base):
    """One question the developer asked about a hint, as numbers and verdicts."""

    __tablename__ = "questions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"))
    created_at: Mapped[datetime]
    level: Mapped[int]
    source: Mapped[str] = mapped_column(String(16))
    deterministic_verdict: Mapped[str] = mapped_column(String(16))
    judge_verdict: Mapped[str] = mapped_column(String(16))
    rewrites: Mapped[int] = mapped_column(default=0)
    rule: Mapped[str | None] = mapped_column(String(32), default=None)


class AttemptRow(Base):
    """What the developer reported after rerunning their own code."""

    __tablename__ = "attempts"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"))
    created_at: Mapped[datetime]
    outcome: Mapped[str | None] = mapped_column(String(16), default=None)
    had_evidence: Mapped[bool] = mapped_column(default=False)

    session: Mapped[SessionRow] = relationship(back_populates="attempts")
