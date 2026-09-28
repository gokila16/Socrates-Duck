"""The local metrics store: what it counts, and what it refuses to keep."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError

from api.app import create_app
from domain.models import (
    Attempt,
    CodeContext,
    Hint,
    HintKind,
    HintSource,
    LeakageRecord,
    Outcome,
    Session,
    SessionStatus,
    Verdict,
)
from persistence.metrics import (
    DEFAULT_DB_PATH,
    NullMetricsStore,
    SqliteMetricsStore,
    configured_path,
)
from persistence.repository import InMemorySessionRepository
from providers.fake import RespondingProvider
from tests.canned import (
    CANNED_NEXT_ACTION,
    DIAGNOSIS_CANARY,
    JUDGE_REASON_CANARY,
    canned_model,
)
from tests.conftest import JsonDict

CODE_CANARY = "SECRET_SOURCE_CANARY_2b71"


@pytest.fixture
def store(tmp_path: Path) -> SqliteMetricsStore:
    return SqliteMetricsStore(tmp_path / "metrics.sqlite3")


def _session(**overrides: object) -> Session:
    defaults: dict[str, object] = {
        "problem": "It crashes.",
        "reasoning": "I think average() is broken.",
        "evidence": "ZeroDivisionError: division by zero",
        "code_contexts": (
            CodeContext(
                label="stats.py",
                language_id="python",
                source="file",
                start_line=1,
                end_line=2,
                code="def average(values):\n    return sum(values) / len(values)",
                truncated=False,
            ),
        ),
    }

    return Session(**{**defaults, **overrides})  # type: ignore[arg-type]


def _hint(level: int, kind: HintKind = HintKind.NORMAL, **leakage: object) -> Hint:
    record: dict[str, object] = {
        "deterministic": Verdict.CLEAN,
        "judge": Verdict.CLEAN,
        "rewrites": 0,
        "source": HintSource.GENERATED,
        **leakage,
    }

    return Hint(
        level=level,
        kind=kind,
        next_action="Print the list.",
        attempts_seen=0,
        leakage=LeakageRecord(**record),  # type: ignore[arg-type]
    )


def test_a_whole_session_is_counted(store: SqliteMetricsStore) -> None:
    session = _session()
    store.session_started(session)

    for hint in (_hint(1), _hint(3, HintKind.STUCK)):
        session.record_hint(hint)
        store.hint_recorded(session, hint)

    attempt = Attempt(reasoning="tried it", outcome=Outcome.STILL_STUCK)
    session.record_attempt(attempt)
    store.attempt_recorded(session, attempt)

    session.finish(SessionStatus.COMPLETED, Outcome.RESOLVED)
    store.session_finished(session)

    summary = store.summary()
    assert summary.sessions == 1
    assert summary.completed == 1
    assert summary.resolved == 1
    assert summary.hints == 2
    assert summary.stuck_requests == 1
    assert summary.highest_level_reached == 3


def test_abandonment_is_counted_apart_from_completion(
    store: SqliteMetricsStore,
) -> None:
    statuses = [
        SessionStatus.COMPLETED,
        SessionStatus.COMPLETED,
        SessionStatus.ABANDONED,
    ]

    for status in statuses:
        session = _session()
        store.session_started(session)
        session.finish(status)
        store.session_finished(session)

    summary = store.summary()
    assert summary.sessions == 3
    assert summary.completed == 2
    assert summary.abandoned == 1
    assert summary.resolved == 0


def test_each_hint_kind_is_counted_as_itself(store: SqliteMetricsStore) -> None:
    session = _session()
    store.session_started(session)

    for kind in (HintKind.NORMAL, HintKind.NORMAL, HintKind.STRONGER, HintKind.STUCK):
        hint = _hint(2, kind)
        session.record_hint(hint)
        store.hint_recorded(session, hint)

    summary = store.summary()
    assert summary.hints == 4
    assert summary.stuck_requests == 1


def test_different_error_reports_are_counted(store: SqliteMetricsStore) -> None:
    session = _session()
    store.session_started(session)

    reported = [
        Outcome.DIFFERENT_ERROR,
        Outcome.STILL_STUCK,
        Outcome.DIFFERENT_ERROR,
        Outcome.STILL_STUCK,
        Outcome.STILL_STUCK,
    ]

    for outcome in reported:
        attempt = Attempt(reasoning="again", outcome=outcome)
        session.record_attempt(attempt)
        store.attempt_recorded(session, attempt)

    assert store.summary().different_error_reports == 2


def test_leakage_blocks_rewrites_and_fallbacks_are_counted(
    store: SqliteMetricsStore,
) -> None:
    """The evidence for whether the leakage layers are too strict or too loose."""
    session = _session()
    store.session_started(session)

    hints = [
        _hint(1),
        _hint(2, rewrites=1, source=HintSource.REWRITTEN),
        _hint(3, deterministic=Verdict.LEAK, judge=Verdict.NOT_RUN, rule="unified_diff"),
        _hint(4, rewrites=2, source=HintSource.FALLBACK, judge=Verdict.LEAK),
    ]

    for hint in hints:
        session.record_hint(hint)
        store.hint_recorded(session, hint)

    summary = store.summary()
    assert summary.leakage_blocks == 3
    assert summary.leakage_rewrites == 3
    assert summary.fallbacks == 1


def test_an_empty_store_answers_with_zeroes(store: SqliteMetricsStore) -> None:
    summary = store.summary()

    assert summary.sessions == 0
    assert summary.highest_level_reached == 0
    assert summary.leakage_rewrites == 0


def test_no_code_or_model_text_reaches_the_database(tmp_path: Path) -> None:
    """The privacy line, as a test over the bytes on disk."""
    path = tmp_path / "metrics.sqlite3"
    store = SqliteMetricsStore(path)

    session = _session(
        problem=f"It crashes: {CODE_CANARY}",
        reasoning=f"I think {CODE_CANARY} is wrong",
        evidence=f"Traceback: {CODE_CANARY}",
        code_contexts=(
            CodeContext(
                label=f"{CODE_CANARY}.py",
                language_id="python",
                source="file",
                start_line=1,
                end_line=1,
                code=f"def {CODE_CANARY}(): pass",
                truncated=False,
            ),
        ),
    )
    store.session_started(session)

    hint = Hint(
        level=4,
        kind=HintKind.NORMAL,
        next_action=f"Look at {CODE_CANARY}",
        attempts_seen=0,
        question=f"What does {CODE_CANARY} return?",
        leakage=LeakageRecord(
            deterministic=Verdict.CLEAN,
            judge=Verdict.LEAK,
            rewrites=1,
            source=HintSource.REWRITTEN,
            reason=f"It states {JUDGE_REASON_CANARY}",
        ),
    )
    session.record_hint(hint)
    store.hint_recorded(session, hint)

    attempt = Attempt(reasoning=f"I tried {CODE_CANARY}", evidence=f"{CODE_CANARY}: []")
    session.record_attempt(attempt)
    store.attempt_recorded(session, attempt)

    session.finish(SessionStatus.COMPLETED, Outcome.RESOLVED)
    store.session_finished(session)

    written = b"".join(each.read_bytes() for each in tmp_path.iterdir())

    for canary in (CODE_CANARY, JUDGE_REASON_CANARY, DIAGNOSIS_CANARY):
        assert canary.encode() not in written

    assert store.summary().hints == 1
    assert store.summary().leakage_rewrites == 1


def test_the_stored_facts_are_only_shapes_and_verdicts(
    store: SqliteMetricsStore,
) -> None:
    session = _session(evidence=None)
    store.session_started(session)

    with store._new_db_session() as db:
        from persistence.records import SessionRow

        row = db.get(SessionRow, session.id)

    assert row is not None
    assert row.code_context_count == 1
    assert row.had_evidence is False


def test_a_broken_store_never_costs_the_developer_a_hint(
    store: SqliteMetricsStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A metric is worth losing; the request that produced it is not."""

    def explode() -> None:
        raise SQLAlchemyError("disk is gone")

    monkeypatch.setattr(store, "_new_db_session", explode)

    session = _session()
    store.session_started(session)
    store.hint_recorded(session, _hint(1))
    store.attempt_recorded(session, Attempt(reasoning="tried"))
    store.session_finished(session)


def test_finishing_a_session_the_store_never_saw_is_harmless(
    store: SqliteMetricsStore,
) -> None:
    session = _session()
    session.finish(SessionStatus.ABANDONED)

    store.session_finished(session)

    assert store.summary().sessions == 0


def test_the_finish_time_comes_from_the_session_not_the_clock(
    store: SqliteMetricsStore,
) -> None:
    session = _session()
    store.session_started(session)
    hint = _hint(1)
    session.record_hint(hint)
    store.hint_recorded(session, hint)
    session.finish(SessionStatus.COMPLETED)
    store.session_finished(session)

    with store._new_db_session() as db:
        from persistence.records import SessionRow

        row = db.get(SessionRow, session.id)

    assert row is not None
    assert row.finished_at is not None
    assert row.finished_at.replace(tzinfo=UTC) == hint.created_at
    assert row.finished_at.replace(tzinfo=UTC) <= datetime.now(UTC)


def test_the_database_path_can_be_moved(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOCRATES_DUCK_DB_PATH", "/tmp/somewhere/else.sqlite3")

    assert configured_path() == Path("/tmp/somewhere/else.sqlite3")


def test_the_default_path_is_inside_the_backend_folder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOCRATES_DUCK_DB_PATH", raising=False)

    assert configured_path() == DEFAULT_DB_PATH
    assert DEFAULT_DB_PATH.suffix == ".sqlite3"


def test_a_session_driven_through_the_endpoints_is_recorded(
    tmp_path: Path, session_payload: JsonDict
) -> None:
    """End to end: the store sees what the developer actually did."""
    store = SqliteMetricsStore(tmp_path / "metrics.sqlite3")
    client = TestClient(
        create_app(
            InMemorySessionRepository(),
            provider=RespondingProvider(canned_model),
            store=store,
        )
    )

    session_id = client.post("/v1/sessions", json=session_payload).json()["id"]
    client.post(f"/v1/sessions/{session_id}/hints", json={})
    client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "stuck"})
    client.post(
        f"/v1/sessions/{session_id}/attempts",
        json={"reasoning": "alan has no scores", "outcome": "different_error"},
    )
    client.post(
        f"/v1/sessions/{session_id}/complete",
        json={"status": "completed", "outcome": "resolved"},
    )

    summary = store.summary()
    assert summary.sessions == 1
    assert summary.completed == 1
    assert summary.resolved == 1
    assert summary.hints == 2
    assert summary.stuck_requests == 1
    assert summary.different_error_reports == 1

    written = b"".join(each.read_bytes() for each in tmp_path.iterdir())
    for canary in (b"def average", b"ZeroDivisionError", CANNED_NEXT_ACTION.encode()):
        assert canary not in written


def test_a_failed_hint_is_not_counted_as_one(
    tmp_path: Path, session_payload: JsonDict
) -> None:
    store = SqliteMetricsStore(tmp_path / "metrics.sqlite3")
    client = TestClient(create_app(InMemorySessionRepository(), store=store))

    session_id = client.post("/v1/sessions", json=session_payload).json()["id"]

    assert client.post(f"/v1/sessions/{session_id}/hints", json={}).status_code == 503
    assert store.summary().hints == 0


def test_the_null_store_is_a_working_store() -> None:
    session = _session()
    store = NullMetricsStore()

    store.session_started(session)
    store.hint_recorded(session, _hint(1))
    store.attempt_recorded(session, Attempt(reasoning="x"))
    store.session_finished(session)

    assert store.summary().sessions == 0
