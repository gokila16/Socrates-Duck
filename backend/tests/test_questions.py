"""Asking about a hint: answered, checked for leakage, and off the ladder."""

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from api.app import create_app
from api.schemas import MAX_QUESTION_CHARS
from persistence.metrics import NullMetricsStore, SqliteMetricsStore
from persistence.repository import InMemorySessionRepository
from policies.fallback import FALLBACK_ANSWER
from providers.base import CompletionRequest
from providers.fake import RespondingProvider
from tests.canned import (
    CANNED_ANSWER,
    CANNED_ANSWER_TEXT,
    DIAGNOSIS,
    DIAGNOSIS_CANARY,
    HINT,
    JUDGE_CLEAN,
    JUDGE_LEAK,
    JUDGE_REASON_CANARY,
    call_kind,
    canned_model,
    last_request_of,
)

JsonDict = dict[str, Any]

QUESTION = "What does enumerate(values) do?"


def _client(provider: Any, store: Any = None) -> TestClient:
    return TestClient(
        create_app(
            InMemorySessionRepository(),
            provider=provider,
            store=store if store is not None else NullMetricsStore(),
        )
    )


def _session_with_hint(client: TestClient, payload: JsonDict) -> str:
    session_id = str(client.post("/v1/sessions", json=payload).json()["id"])
    client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "normal"})

    return session_id


def _ask(client: TestClient, session_id: str, number: int = 1, **kwargs: Any) -> Any:
    return client.post(
        f"/v1/sessions/{session_id}/questions",
        json={"hintNumber": number, "question": QUESTION},
        **kwargs,
    )


def test_a_question_gets_an_answer_and_something_to_do(session_payload: JsonDict) -> None:
    client = _client(RespondingProvider(canned_model))
    session_id = _session_with_hint(client, session_payload)

    response = _ask(client, session_id)

    assert response.status_code == 200
    assert response.json() == {
        "hintNumber": 1,
        "answer": CANNED_ANSWER_TEXT,
        "nextAction": CANNED_ANSWER["next_action"],
    }


def test_asking_does_not_move_the_ladder_or_count_as_a_hint(
    session_payload: JsonDict,
) -> None:
    client = _client(RespondingProvider(canned_model))
    session_id = _session_with_hint(client, session_payload)

    _ask(client, session_id)
    _ask(client, session_id)
    hint = client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "normal"})
    finished = client.post(
        f"/v1/sessions/{session_id}/complete", json={"status": "abandoned"}
    )

    assert hint.json()["level"] == 1
    assert finished.json()["hintCount"] == 2


def test_the_answer_is_written_at_the_rung_of_the_hint_asked_about(
    session_payload: JsonDict,
) -> None:
    model = RespondingProvider(canned_model)
    client = _client(model)
    session_id = _session_with_hint(client, session_payload)
    client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "stuck"})

    _ask(client, session_id, number=1)

    answer = last_request_of("answer", model.requests)
    assert "rung 1 of 8" in answer.system
    judge = last_request_of("judge", model.requests)
    assert "rung 1 of 8" in judge.system
    assert QUESTION in judge.user
    assert "answer to the developer's question" in judge.system


def test_a_leaking_answer_is_rewritten_and_never_returned(
    session_payload: JsonDict,
) -> None:
    leaked = "LEAKED_ANSWER_CANARY: skip the empty list with an if."
    answers = iter(
        [json.dumps({**CANNED_ANSWER, "answer": leaked}), json.dumps(CANNED_ANSWER)]
    )
    judges = iter([JUDGE_CLEAN, JUDGE_LEAK, JUDGE_CLEAN])

    def respond(request: CompletionRequest) -> str:
        kind = call_kind(request)

        return {
            "analysis": lambda: DIAGNOSIS,
            "hint": lambda: HINT,
            "answer": lambda: next(answers),
            "judge": lambda: next(judges),
        }[kind]()

    client = _client(RespondingProvider(respond))
    session_id = _session_with_hint(client, session_payload)

    response = _ask(client, session_id)

    assert "LEAKED_ANSWER_CANARY" not in response.text
    assert response.json()["answer"] == CANNED_ANSWER_TEXT
    assert JUDGE_REASON_CANARY not in response.text


def test_an_answer_that_keeps_leaking_ends_in_the_fixed_fallback(
    session_payload: JsonDict,
) -> None:
    def respond(request: CompletionRequest) -> str:
        kind = call_kind(request)

        if kind == "judge" and "answer to the developer's question" in request.system:
            return JUDGE_LEAK

        return canned_model(request)

    client = _client(RespondingProvider(respond))
    session_id = _session_with_hint(client, session_payload)

    response = _ask(client, session_id)

    assert response.status_code == 200
    assert response.json()["answer"] == FALLBACK_ANSWER


def test_a_question_about_a_hint_that_does_not_exist_is_refused(
    session_payload: JsonDict,
) -> None:
    client = _client(RespondingProvider(canned_model))
    session_id = _session_with_hint(client, session_payload)

    assert _ask(client, session_id, number=2).status_code == 422
    assert _ask(client, session_id, number=0).status_code == 422


def test_an_overlong_question_is_refused(session_payload: JsonDict) -> None:
    client = _client(RespondingProvider(canned_model))
    session_id = _session_with_hint(client, session_payload)

    response = client.post(
        f"/v1/sessions/{session_id}/questions",
        json={"hintNumber": 1, "question": "x" * (MAX_QUESTION_CHARS + 1)},
    )

    assert response.status_code == 422


def test_the_question_is_fenced_as_data(session_payload: JsonDict) -> None:
    model = RespondingProvider(canned_model)
    client = _client(model)
    session_id = _session_with_hint(client, session_payload)

    _ask(client, session_id)

    request = last_request_of("answer", model.requests)
    token = request.system.split("<<<", 1)[1].split(" ", 1)[0]
    assert f"<<<{token} their question>>>\n{QUESTION}\n<<<{token} end>>>" in request.user
    assert f"<<<{token} hint asked about>>>" in request.user


def test_later_hints_see_what_the_developer_asked(session_payload: JsonDict) -> None:
    model = RespondingProvider(canned_model)
    client = _client(model)
    session_id = _session_with_hint(client, session_payload)

    _ask(client, session_id)
    client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "stronger"})

    hint = last_request_of("hint", model.requests)
    assert QUESTION in hint.user
    assert CANNED_ANSWER_TEXT in hint.user


def test_the_answer_never_carries_the_diagnosis(session_payload: JsonDict) -> None:
    client = _client(RespondingProvider(canned_model))
    session_id = _session_with_hint(client, session_payload)

    assert DIAGNOSIS_CANARY not in _ask(client, session_id).text


def test_a_question_can_stream_its_steps(session_payload: JsonDict) -> None:
    client = _client(RespondingProvider(canned_model))
    session_id = _session_with_hint(client, session_payload)

    response = _ask(client, session_id, headers={"Accept": "text/event-stream"})

    blocks = response.text.strip().split("\n\n")
    names = [block.splitlines()[0].removeprefix("event: ") for block in blocks]
    assert names == ["step", "step", "answer"]
    final = json.loads(blocks[-1].splitlines()[1].removeprefix("data: "))
    assert final["answer"] == CANNED_ANSWER_TEXT


def test_questions_are_counted_apart_from_hints_with_no_text(
    tmp_path: Path, session_payload: JsonDict
) -> None:
    store = SqliteMetricsStore(tmp_path / "metrics.sqlite3")
    client = _client(RespondingProvider(canned_model), store)
    session_id = _session_with_hint(client, session_payload)

    _ask(client, session_id)

    summary = store.summary()
    assert summary.hints == 1
    assert summary.questions == 1
    stored = (tmp_path / "metrics.sqlite3").read_bytes()
    assert b"enumerate" not in stored


def test_a_request_for_the_fix_is_declined_in_the_first_draft(
    session_payload: JsonDict,
) -> None:
    model = RespondingProvider(canned_model)
    client = _client(model)
    session_id = _session_with_hint(client, session_payload)

    _ask(client, session_id)

    answer = last_request_of("answer", model.requests).system
    assert "working that out is their step" in answer
    assert "leave the finding to them" in answer
