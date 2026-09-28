"""The wire contract with the VS Code extension."""

from typing import Any

from fastapi.testclient import TestClient

JsonDict = dict[str, Any]

EXTENSION_CODE_CONTEXT_FIELDS = {
    "label",
    "languageId",
    "source",
    "startLine",
    "endLine",
    "lineCount",
    "code",
    "truncated",
}


def test_the_extensions_payload_shape_is_accepted(
    client: TestClient, session_payload: JsonDict
) -> None:
    assert set(session_payload["codeContexts"][0]) == EXTENSION_CODE_CONTEXT_FIELDS

    assert client.post("/v1/sessions", json=session_payload).status_code == 201


def test_snake_case_is_also_accepted_for_python_callers(
    client: TestClient, session_payload: JsonDict
) -> None:
    context = session_payload["codeContexts"][0]
    session_payload["code_contexts"] = [
        {
            "label": context["label"],
            "language_id": context["languageId"],
            "source": context["source"],
            "start_line": context["startLine"],
            "end_line": context["endLine"],
            "line_count": context["lineCount"],
            "code": context["code"],
            "truncated": context["truncated"],
        }
    ]
    del session_payload["codeContexts"]

    assert client.post("/v1/sessions", json=session_payload).status_code == 201


def test_responses_use_the_same_camelCase_convention(
    client: TestClient, session_id: str
) -> None:
    hint = client.post(f"/v1/sessions/{session_id}/hints", json={}).json()
    session = client.post(
        f"/v1/sessions/{session_id}/attempts",
        json={"reasoning": "still looking"},
    ).json()

    assert set(hint) == {"level", "nextAction", "question", "concept", "evidence"}
    assert set(session) == {"id", "status", "hintCount", "highestHintLevel"}


def test_a_line_count_that_contradicts_the_range_is_rejected(
    client: TestClient, session_payload: JsonDict
) -> None:
    session_payload["codeContexts"][0]["lineCount"] = 99

    assert client.post("/v1/sessions", json=session_payload).status_code == 422
