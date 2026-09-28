"""Recording what happened, and reading it back for the MVP evaluation."""

import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

from sqlalchemy import Select, create_engine, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import InstrumentedAttribute, sessionmaker
from sqlalchemy.orm import Session as DbSession

from domain.models import (
    Attempt,
    Clarification,
    Hint,
    HintKind,
    HintSource,
    Outcome,
    Session,
    SessionStatus,
    Verdict,
)
from persistence.records import AttemptRow, Base, HintRow, QuestionRow, SessionRow

_log = logging.getLogger(__name__)

DEFAULT_DB_PATH = Path(__file__).resolve().parents[1] / ".data" / "metrics.sqlite3"


@dataclass(frozen=True)
class MetricsSummary:
    """The whole MVP metrics list, as counts."""

    sessions: int
    completed: int
    abandoned: int
    resolved: int
    hints: int
    stuck_requests: int
    different_error_reports: int
    leakage_blocks: int
    leakage_rewrites: int
    fallbacks: int
    highest_level_reached: int
    questions: int = 0
    question_blocks: int = 0
    question_fallbacks: int = 0


class MetricsStore(Protocol):
    """What the API needs from a store, so tests can hand it nothing."""

    def session_started(self, session: Session) -> None: ...

    def hint_recorded(self, session: Session, hint: Hint) -> None: ...

    def attempt_recorded(self, session: Session, attempt: Attempt) -> None: ...

    def question_recorded(
        self, session: Session, clarification: Clarification
    ) -> None: ...

    def session_finished(self, session: Session) -> None: ...

    def summary(self) -> MetricsSummary: ...


class NullMetricsStore:
    """Records nothing."""

    def session_started(self, session: Session) -> None:
        return None

    def hint_recorded(self, session: Session, hint: Hint) -> None:
        return None

    def attempt_recorded(self, session: Session, attempt: Attempt) -> None:
        return None

    def question_recorded(self, session: Session, clarification: Clarification) -> None:
        return None

    def session_finished(self, session: Session) -> None:
        return None

    def summary(self) -> MetricsSummary:
        return MetricsSummary(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)


class SqliteMetricsStore:
    """The real store: one local SQLite file, written through SQLAlchemy."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path if path is not None else configured_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)

        self._engine = create_engine(
            f"sqlite:///{self.path}",
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(self._engine)
        self._new_db_session = sessionmaker(self._engine)

    def session_started(self, session: Session) -> None:
        row = SessionRow(
            id=session.id,
            created_at=session.created_at,
            status=session.status.value,
            code_context_count=len(session.code_contexts),
            had_evidence=session.evidence is not None,
        )

        self._write(lambda db: db.add(row))

    def hint_recorded(self, session: Session, hint: Hint) -> None:
        leakage = hint.leakage
        row = HintRow(
            session_id=session.id,
            created_at=hint.created_at,
            level=hint.level,
            kind=hint.kind.value,
            source=(
                leakage.source.value
                if leakage is not None
                else HintSource.GENERATED.value
            ),
            deterministic_verdict=(
                leakage.deterministic.value
                if leakage is not None
                else Verdict.NOT_RUN.value
            ),
            judge_verdict=(
                leakage.judge.value if leakage is not None else Verdict.NOT_RUN.value
            ),
            rewrites=leakage.rewrites if leakage is not None else 0,
            rule=leakage.rule if leakage is not None else None,
        )

        self._write(lambda db: db.add(row))

    def attempt_recorded(self, session: Session, attempt: Attempt) -> None:
        row = AttemptRow(
            session_id=session.id,
            created_at=attempt.created_at,
            outcome=attempt.outcome.value if attempt.outcome else None,
            had_evidence=attempt.evidence is not None,
        )

        self._write(lambda db: db.add(row))

    def question_recorded(self, session: Session, clarification: Clarification) -> None:
        leakage = clarification.leakage
        row = QuestionRow(
            session_id=session.id,
            created_at=clarification.created_at,
            level=clarification.level,
            source=(
                leakage.source.value
                if leakage is not None
                else HintSource.GENERATED.value
            ),
            deterministic_verdict=(
                leakage.deterministic.value
                if leakage is not None
                else Verdict.NOT_RUN.value
            ),
            judge_verdict=(
                leakage.judge.value if leakage is not None else Verdict.NOT_RUN.value
            ),
            rewrites=leakage.rewrites if leakage is not None else 0,
            rule=leakage.rule if leakage is not None else None,
        )

        self._write(lambda db: db.add(row))

    def session_finished(self, session: Session) -> None:
        def finish(db: DbSession) -> None:
            row = db.get(SessionRow, session.id)

            if row is None:
                return

            row.status = session.status.value
            row.final_outcome = (
                session.final_outcome.value if session.final_outcome else None
            )
            row.finished_at = _now_from(session)

        self._write(finish)

    def summary(self) -> MetricsSummary:
        """Every metric, from one grouped query per table."""
        with self._new_db_session() as db:
            statuses = _counts_by(db, SessionRow.status)
            outcomes = _counts_by(db, SessionRow.final_outcome)
            kinds = _counts_by(db, HintRow.kind)
            sources = _counts_by(db, HintRow.source)
            reports = _counts_by(db, AttemptRow.outcome)

            return MetricsSummary(
                sessions=sum(statuses.values()),
                completed=statuses.get(SessionStatus.COMPLETED.value, 0),
                abandoned=statuses.get(SessionStatus.ABANDONED.value, 0),
                resolved=outcomes.get(Outcome.RESOLVED.value, 0),
                hints=sum(kinds.values()),
                stuck_requests=kinds.get(HintKind.STUCK.value, 0),
                different_error_reports=reports.get(Outcome.DIFFERENT_ERROR.value, 0),
                leakage_blocks=_count(
                    db,
                    select(func.count())
                    .select_from(HintRow)
                    .where(
                        (HintRow.rewrites > 0)
                        | (HintRow.deterministic_verdict == Verdict.LEAK.value)
                        | (HintRow.judge_verdict == Verdict.LEAK.value)
                        | (HintRow.source == HintSource.FALLBACK.value)
                    ),
                ),
                leakage_rewrites=_count(
                    db, select(func.coalesce(func.sum(HintRow.rewrites), 0))
                ),
                fallbacks=sources.get(HintSource.FALLBACK.value, 0),
                highest_level_reached=_count(
                    db, select(func.coalesce(func.max(HintRow.level), 0))
                ),
                questions=_count(db, select(func.count()).select_from(QuestionRow)),
                question_blocks=_count(
                    db,
                    select(func.count())
                    .select_from(QuestionRow)
                    .where(
                        (QuestionRow.rewrites > 0)
                        | (QuestionRow.deterministic_verdict == Verdict.LEAK.value)
                        | (QuestionRow.judge_verdict == Verdict.LEAK.value)
                        | (QuestionRow.source == HintSource.FALLBACK.value)
                    ),
                ),
                question_fallbacks=_count(
                    db,
                    select(func.count())
                    .select_from(QuestionRow)
                    .where(QuestionRow.source == HintSource.FALLBACK.value),
                ),
            )

    def _write(self, work: Callable[[DbSession], None]) -> None:
        """Commits, and never lets a failed write cost the developer a hint."""
        try:
            with self._new_db_session() as db:
                work(db)
                db.commit()
        except SQLAlchemyError:
            _log.warning("Could not record a Socrates' Duck metric.")


def configured_path() -> Path:
    configured = os.environ.get("SOCRATES_DUCK_DB_PATH", "").strip()

    return Path(configured).expanduser() if configured else DEFAULT_DB_PATH


def _counts_by(
    db: DbSession, column: InstrumentedAttribute[str | None]
) -> dict[str, int]:
    """How many rows carry each value of one column."""
    rows = db.execute(select(column, func.count()).group_by(column)).all()

    return {value: count for value, count in rows if value is not None}


def _count(db: DbSession, statement: Select[tuple[int]]) -> int:
    return db.execute(statement).scalar_one()


def _now_from(session: Session) -> datetime:
    """The moment the session ended."""
    timestamps = [hint.created_at for hint in session.hints]
    timestamps.extend(attempt.created_at for attempt in session.attempts)

    return max(timestamps, default=session.created_at)
