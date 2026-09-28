"""Session lifecycle: create, hint, attempt, complete."""

from typing import Any

import pytest
from fastapi.testclient import TestClient

from api.app import create_app
from domain.models import MAX_HINT_LEVEL
from persistence.metrics import NullMetricsStore
from persistence.repository import InMemorySessionRepository
from providers.base import CompletionRequest, ProviderTimeout
from providers.fake import FailingProvider, RespondingProvider
from tests.canned import (
    DIAGNOSIS,
    DIAGNOSIS_CANARY,
    HINT,
    JUDGE_LEAK,
    JUDGE_REASON_CANARY,
    call_kind,
)

JsonDict = dict[str, Any]


def test_health_reports_no_provider_when_none_is_configured(
    client_without_model: TestClient,
) -> None:
    assert client_without_model.get("/health").json() == {
        "status": "ok",
        "provider": "absent",
        "model": "",
    }


def test_create_session_returns_state_without_echoing_contents(
    client: TestClient, session_payload: JsonDict
) -> None:
    response = client.post("/v1/sessions", json=session_payload)

    assert response.status_code == 201

    body = response.json()
    assert body["status"] == "active"
    assert body["hintCount"] == 0
    assert body["highestHintLevel"] == 0

    assert "def average" not in response.text
    assert "ZeroDivisionError" not in response.text


def test_session_can_start_without_error_evidence(
    client: TestClient, session_payload: JsonDict
) -> None:
    del session_payload["evidence"]

    assert client.post("/v1/sessions", json=session_payload).status_code == 201


def test_every_hint_carries_a_level_and_a_next_action(
    client: TestClient, session_id: str
) -> None:
    body = client.post(f"/v1/sessions/{session_id}/hints", json={}).json()

    assert body["level"] == 1
    assert body["nextAction"].strip() != ""


def test_get_hint_stays_on_its_rung_and_stronger_climbs(
    client: TestClient, session_id: str
) -> None:
    kinds = ["normal", "normal", "stronger", "stronger"]
    levels = [
        client.post(f"/v1/sessions/{session_id}/hints", json={"kind": kind}).json()[
            "level"
        ]
        for kind in kinds
    ]

    assert levels == [1, 1, 2, 3]


def test_hint_level_never_passes_the_top_of_the_ladder(
    client: TestClient, session_id: str
) -> None:
    for _ in range(MAX_HINT_LEVEL + 4):
        body = client.post(
            f"/v1/sessions/{session_id}/hints", json={"kind": "stuck"}
        ).json()

    assert body["level"] == MAX_HINT_LEVEL


def test_the_private_diagnosis_never_reaches_a_response(
    client: TestClient, session_id: str
) -> None:
    """The internal diagnosis is never returned to the developer."""
    bodies = [
        client.post(f"/v1/sessions/{session_id}/hints", json={}).text,
        client.post(
            f"/v1/sessions/{session_id}/attempts",
            json={"reasoning": "alan has no scores", "outcome": "still_stuck"},
        ).text,
        client.post(f"/v1/sessions/{session_id}/hints", json={}).text,
        client.post(
            f"/v1/sessions/{session_id}/complete", json={"status": "completed"}
        ).text,
    ]

    for body in bodies:
        assert DIAGNOSIS_CANARY not in body


def test_a_hint_that_keeps_leaking_arrives_as_the_safe_fallback(
    session_payload: JsonDict,
) -> None:
    """The developer still gets something they can act on, and no private text."""

    def always_leaking(request: CompletionRequest) -> str:
        return {
            "analysis": DIAGNOSIS,
            "judge": JUDGE_LEAK,
            "hint": HINT,
        }[call_kind(request)]

    client = TestClient(
        create_app(
            InMemorySessionRepository(),
            provider=RespondingProvider(always_leaking),
            store=NullMetricsStore(),
        )
    )
    session_id = client.post("/v1/sessions", json=session_payload).json()["id"]

    response = client.post(f"/v1/sessions/{session_id}/hints", json={})

    assert response.status_code == 200
    body = response.json()
    assert body["level"] == 1
    assert "least certain" in body["question"]
    assert body["nextAction"].strip() != ""

    assert DIAGNOSIS_CANARY not in response.text
    assert JUDGE_REASON_CANARY not in response.text

    state = client.post(
        f"/v1/sessions/{session_id}/attempts", json={"reasoning": "still looking"}
    ).json()
    assert state["hintCount"] == 1


def test_without_a_model_a_hint_is_503_and_changes_nothing(
    client_without_model: TestClient, session_payload: JsonDict
) -> None:
    session_id = client_without_model.post("/v1/sessions", json=session_payload).json()[
        "id"
    ]

    response = client_without_model.post(f"/v1/sessions/{session_id}/hints", json={})

    assert response.status_code == 503
    assert "OPENAI_API_KEY" in response.json()["detail"]

    state = client_without_model.post(
        f"/v1/sessions/{session_id}/attempts", json={"reasoning": "still looking"}
    ).json()
    assert state["hintCount"] == 0


def test_a_model_failure_is_503_and_leaves_the_ladder_where_it_was(
    session_payload: JsonDict,
) -> None:
    """A timeout must not cost the developer a rung or count as a hint given."""
    failing = FailingProvider(ProviderTimeout("slow"))
    client = TestClient(
        create_app(
            InMemorySessionRepository(), provider=failing, store=NullMetricsStore()
        )
    )
    session_id = client.post("/v1/sessions", json=session_payload).json()["id"]

    response = client.post(f"/v1/sessions/{session_id}/hints", json={})

    assert response.status_code == 503
    assert response.json() == {"detail": "The model did not respond in time. Try again."}
    assert failing.calls == 1

    state = client.post(
        f"/v1/sessions/{session_id}/attempts", json={"reasoning": "trying again"}
    ).json()
    assert state["hintCount"] == 0
    assert state["highestHintLevel"] == 0


def test_stuck_request_is_accepted(client: TestClient, session_id: str) -> None:
    response = client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "stuck"})

    assert response.status_code == 200


def test_attempt_is_recorded_and_reflected_in_session_state(
    client: TestClient, session_id: str
) -> None:
    response = client.post(
        f"/v1/sessions/{session_id}/attempts",
        json={
            "reasoning": "I checked the list and it is empty for alan.",
            "outcome": "still_stuck",
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "active"


def test_completing_a_session_stops_further_work(
    client: TestClient, session_id: str
) -> None:
    completed = client.post(
        f"/v1/sessions/{session_id}/complete",
        json={"status": "completed", "outcome": "resolved"},
    )

    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"

    assert client.post(f"/v1/sessions/{session_id}/hints", json={}).status_code == 409
    assert (
        client.post(
            f"/v1/sessions/{session_id}/attempts", json={"reasoning": "one more"}
        ).status_code
        == 409
    )


def test_abandoning_a_session_is_a_distinct_outcome(
    client: TestClient, session_id: str
) -> None:
    response = client.post(
        f"/v1/sessions/{session_id}/complete", json={"status": "abandoned"}
    )

    assert response.json()["status"] == "abandoned"


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("hints", {"kind": "normal"}),
        ("attempts", {"reasoning": "I tried printing the list."}),
        ("complete", {"status": "completed"}),
    ],
)
def test_unknown_session_is_not_found(
    client: TestClient, path: str, body: JsonDict
) -> None:
    """Every body here is valid, so the 404 branch is the one being tested."""
    response = client.post(f"/v1/sessions/does-not-exist/{path}", json=body)

    assert response.status_code == 404


def _edited(payload: JsonDict) -> JsonDict:
    """The same attachment, as it reads after the developer edited it."""
    context = dict(payload["codeContexts"][0])
    context["code"] = "def average(values):\n    # EDITED_CODE_MARKER\n    return 0"
    context["endLine"] = context["startLine"] + 2
    context["lineCount"] = 3

    return context


def test_a_report_with_code_makes_the_next_hint_see_the_edits(
    client: TestClient, model: RespondingProvider, session_payload: JsonDict
) -> None:
    session_id = client.post("/v1/sessions", json=session_payload).json()["id"]
    client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "normal"})

    reported = client.post(
        f"/v1/sessions/{session_id}/attempts",
        json={
            "reasoning": "I changed average().",
            "outcome": "still_stuck",
            "codeContexts": [_edited(session_payload)],
        },
    )
    assert reported.status_code == 200

    client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "normal"})

    analysis = [r for r in model.requests if call_kind(r) == "analysis"][-1]
    assert "EDITED_CODE_MARKER" in analysis.user
    assert "sum(values) / len(values)" not in analysis.user
    assert "their current version" in analysis.user


def test_a_report_without_code_keeps_the_code_from_the_start(
    client: TestClient, model: RespondingProvider, session_payload: JsonDict
) -> None:
    session_id = client.post("/v1/sessions", json=session_payload).json()["id"]
    client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "normal"})
    client.post(
        f"/v1/sessions/{session_id}/attempts",
        json={"reasoning": "Still looking.", "outcome": "still_stuck"},
    )
    client.post(f"/v1/sessions/{session_id}/hints", json={"kind": "normal"})

    analysis = [r for r in model.requests if call_kind(r) == "analysis"][-1]
    assert "their current version" not in analysis.user


def test_a_report_with_an_empty_code_list_is_rejected(
    client: TestClient, session_payload: JsonDict
) -> None:
    session_id = client.post("/v1/sessions", json=session_payload).json()["id"]

    response = client.post(
        f"/v1/sessions/{session_id}/attempts",
        json={"reasoning": "x", "outcome": "still_stuck", "codeContexts": []},
    )

    assert response.status_code == 422
