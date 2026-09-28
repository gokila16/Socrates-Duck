"""The API boundary: what it rejects, and what it refuses to repeat back."""

import copy
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from api.schemas import (
    MAX_CODE_CHARS,
    MAX_CODE_CONTEXTS,
    MAX_EVIDENCE_CHARS,
    MAX_PROBLEM_CHARS,
)

JsonDict = dict[str, Any]

CANARY = "SECRET_CANARY_TOKEN_9f3a"


def _backwards_range(payload: JsonDict) -> None:
    payload["codeContexts"][0]["code"] = f"def leak():\n    return {CANARY!r}"
    payload["codeContexts"][0]["startLine"] = 40
    payload["codeContexts"][0]["endLine"] = 10


def _oversized_code(payload: JsonDict) -> None:
    payload["codeContexts"][0]["code"] = "x" * (MAX_CODE_CHARS + 1) + CANARY


def _incomplete_context(payload: JsonDict) -> None:
    payload["codeContexts"][0]["code"] = f"def leak():\n    return {CANARY!r}"
    del payload["codeContexts"][0]["truncated"]


def _oversized_evidence(payload: JsonDict) -> None:
    payload["evidence"] = f'File "{CANARY}.py", line 3\n' + "x" * MAX_EVIDENCE_CHARS


def test_problem_description_is_required(
    client: TestClient, session_payload: JsonDict
) -> None:
    session_payload["problem"] = ""

    assert client.post("/v1/sessions", json=session_payload).status_code == 422


def test_reasoning_may_be_left_out(client: TestClient, session_payload: JsonDict) -> None:
    del session_payload["reasoning"]

    assert client.post("/v1/sessions", json=session_payload).status_code == 201


def test_whitespace_only_reasoning_is_not_reasoning(
    client: TestClient, session_payload: JsonDict
) -> None:
    session_payload["reasoning"] = "   \n\t  "

    assert client.post("/v1/sessions", json=session_payload).status_code == 422


def test_a_session_needs_at_least_one_piece_of_code(
    client: TestClient, session_payload: JsonDict
) -> None:
    session_payload["codeContexts"] = []

    assert client.post("/v1/sessions", json=session_payload).status_code == 422


def test_too_many_code_contexts_are_rejected(
    client: TestClient, session_payload: JsonDict
) -> None:
    context = session_payload["codeContexts"][0]
    session_payload["codeContexts"] = [
        copy.deepcopy(context) for _ in range(MAX_CODE_CONTEXTS + 1)
    ]

    assert client.post("/v1/sessions", json=session_payload).status_code == 422


def test_oversized_problem_is_rejected(
    client: TestClient, session_payload: JsonDict
) -> None:
    session_payload["problem"] = "x" * (MAX_PROBLEM_CHARS + 1)

    assert client.post("/v1/sessions", json=session_payload).status_code == 422


def test_backwards_line_range_is_rejected(
    client: TestClient, session_payload: JsonDict
) -> None:
    session_payload["codeContexts"][0]["startLine"] = 40
    session_payload["codeContexts"][0]["endLine"] = 10

    assert client.post("/v1/sessions", json=session_payload).status_code == 422


def test_line_numbers_are_one_based(
    client: TestClient, session_payload: JsonDict
) -> None:
    session_payload["codeContexts"][0]["startLine"] = 0

    assert client.post("/v1/sessions", json=session_payload).status_code == 422


def test_unknown_fields_are_rejected_rather_than_ignored(
    client: TestClient, session_payload: JsonDict
) -> None:
    session_payload["repository_path"] = "/Users/dev/project"

    assert client.post("/v1/sessions", json=session_payload).status_code == 422


def test_unknown_hint_kind_is_rejected(client: TestClient, session_id: str) -> None:
    response = client.post(
        f"/v1/sessions/{session_id}/hints", json={"kind": "just_tell_me"}
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("description", "mutate"),
    [
        ("line range rejected by the model validator", _backwards_range),
        ("code longer than the field allows", _oversized_code),
        ("a context missing a required field", _incomplete_context),
        ("evidence longer than the field allows", _oversized_evidence),
    ],
)
def test_validation_errors_do_not_echo_what_was_submitted(
    client: TestClient,
    session_payload: JsonDict,
    description: str,
    mutate: Callable[[JsonDict], None],
) -> None:
    """The privacy rule, as a test."""
    mutate(session_payload)

    response = client.post("/v1/sessions", json=session_payload)

    assert response.status_code == 422, description
    assert CANARY not in response.text, description


def test_validation_errors_still_say_what_went_wrong(
    client: TestClient, session_payload: JsonDict
) -> None:
    session_payload["problem"] = ""

    body = client.post("/v1/sessions", json=session_payload).json()

    assert body["detail"][0]["loc"] == ["body", "problem"]
    assert body["detail"][0]["msg"] != ""


def test_conflict_and_not_found_bodies_stay_generic(
    client: TestClient, session_id: str
) -> None:
    client.post(f"/v1/sessions/{session_id}/complete", json={"status": "completed"})

    conflict = client.post(f"/v1/sessions/{session_id}/hints", json={})
    missing = client.post("/v1/sessions/unknown/hints", json={})

    assert conflict.json() == {"detail": "This session has finished."}
    assert missing.json() == {"detail": "Session not found."}
