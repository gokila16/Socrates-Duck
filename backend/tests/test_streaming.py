"""The hint endpoint's progress stream: what it reports, and what it never does."""

import json
from typing import Any

from fastapi.testclient import TestClient

from api.app import create_app
from persistence.metrics import NullMetricsStore
from persistence.repository import InMemorySessionRepository
from providers.base import CompletionRequest, ProviderUnavailable
from providers.fake import FailingProvider, RespondingProvider
from tests.canned import (
    CANNED_HINT,
    DIAGNOSIS,
    DIAGNOSIS_CANARY,
    JUDGE_CLEAN,
    JUDGE_LEAK,
    JUDGE_REASON_CANARY,
    call_kind,
    canned_model,
)

JsonDict = dict[str, Any]

STREAM = {"Accept": "text/event-stream"}

REFUSED_ACTION = "REFUSED_CANDIDATE_CANARY: change line 5 to check for empty."


def _client(provider: Any) -> TestClient:
    return TestClient(
        create_app(
            InMemorySessionRepository(), provider=provider, store=NullMetricsStore()
        )
    )


def _start(client: TestClient, payload: JsonDict) -> str:
    response = client.post("/v1/sessions", json=payload)
    assert response.status_code == 201

    return str(response.json()["id"])


def _events(body: str) -> list[tuple[str, JsonDict]]:
    """Parses a Server-Sent Events body into (event, data) pairs."""
    events = []

    for block in body.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((fields["event"], json.loads(fields["data"])))

    return events


def _leak_then_clean() -> RespondingProvider:
    """A first candidate the judge refuses, then a clean rewrite."""
    hints = iter(
        [
            json.dumps({**CANNED_HINT, "next_action": REFUSED_ACTION}),
            json.dumps(CANNED_HINT),
        ]
    )
    judges = iter([JUDGE_LEAK, JUDGE_CLEAN])

    def respond(request: CompletionRequest) -> str:
        kind = call_kind(request)

        if kind == "analysis":
            return DIAGNOSIS

        return next(hints) if kind == "hint" else next(judges)

    return RespondingProvider(respond)


def test_the_first_hint_streams_each_step_then_the_hint(
    session_payload: JsonDict,
) -> None:
    client = _client(RespondingProvider(canned_model))
    session_id = _start(client, session_payload)

    response = client.post(
        f"/v1/sessions/{session_id}/hints", json={"kind": "normal"}, headers=STREAM
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    events = _events(response.text)
    assert [data["step"] for name, data in events if name == "step"] == [
        "reading",
        "writing",
        "checking",
    ]
    assert events[-1][0] == "hint"
    assert events[-1][1]["nextAction"] == CANNED_HINT["next_action"]


def test_a_later_hint_skips_reading_when_nothing_new_was_reported(
    session_payload: JsonDict,
) -> None:
    client = _client(RespondingProvider(canned_model))
    session_id = _start(client, session_payload)
    client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "normal"})

    response = client.post(
        f"/v1/sessions/{session_id}/hints", json={"kind": "stronger"}, headers=STREAM
    )

    steps = [data["step"] for name, data in _events(response.text) if name == "step"]
    assert "reading" not in steps


def test_a_refused_candidate_is_never_streamed(session_payload: JsonDict) -> None:
    """An unjudged or refused candidate is never returned, streamed or not."""
    client = _client(_leak_then_clean())
    session_id = _start(client, session_payload)

    response = client.post(
        f"/v1/sessions/{session_id}/hints", json={"kind": "normal"}, headers=STREAM
    )

    steps = [data["step"] for name, data in _events(response.text) if name == "step"]
    assert steps == ["reading", "writing", "checking", "rewording", "checking"]
    assert "REFUSED_CANDIDATE_CANARY" not in response.text
    assert JUDGE_REASON_CANARY not in response.text
    assert DIAGNOSIS_CANARY not in response.text


def test_a_failure_arrives_as_an_error_event_and_changes_nothing(
    session_payload: JsonDict,
) -> None:
    client = _client(FailingProvider(ProviderUnavailable("upstream detail")))
    session_id = _start(client, session_payload)

    response = client.post(
        f"/v1/sessions/{session_id}/hints", json={"kind": "normal"}, headers=STREAM
    )

    name, data = _events(response.text)[-1]
    assert name == "error"
    assert "upstream detail" not in data["detail"]

    finished = client.post(
        f"/v1/sessions/{session_id}/complete", json={"status": "abandoned"}
    )
    assert finished.json()["hintCount"] == 0


def test_without_a_model_the_stream_is_refused_before_it_starts(
    session_payload: JsonDict,
) -> None:
    client = TestClient(create_app(InMemorySessionRepository(), store=NullMetricsStore()))
    session_id = _start(client, session_payload)

    response = client.post(
        f"/v1/sessions/{session_id}/hints", json={"kind": "normal"}, headers=STREAM
    )

    assert response.status_code == 503


def test_a_client_that_does_not_ask_for_a_stream_still_gets_json(
    session_payload: JsonDict,
) -> None:
    client = _client(RespondingProvider(canned_model))
    session_id = _start(client, session_payload)

    response = client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "normal"})

    assert response.status_code == 200
    assert response.json()["nextAction"] == CANNED_HINT["next_action"]
