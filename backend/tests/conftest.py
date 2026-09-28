from typing import Any

import pytest
from fastapi.testclient import TestClient

from api.app import create_app
from persistence.metrics import NullMetricsStore
from persistence.repository import InMemorySessionRepository
from providers.fake import RespondingProvider
from providers.settings import KEY_VARIABLES
from tests.canned import canned_model

JsonDict = dict[str, Any]


@pytest.fixture(autouse=True)
def _no_real_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """No test may reach a real provider, whatever the developer has exported."""
    for variable in KEY_VARIABLES.values():
        monkeypatch.delenv(variable, raising=False)

    monkeypatch.delenv("SOCRATES_DUCK_MODEL", raising=False)


@pytest.fixture
def model() -> RespondingProvider:
    return RespondingProvider(canned_model)


@pytest.fixture
def client(model: RespondingProvider) -> TestClient:
    """A client over a fresh app with a canned model."""
    return TestClient(
        create_app(InMemorySessionRepository(), provider=model, store=NullMetricsStore())
    )


@pytest.fixture
def client_without_model() -> TestClient:
    """The state a developer is in before they export a key."""
    return TestClient(create_app(InMemorySessionRepository(), store=NullMetricsStore()))


@pytest.fixture
def session_payload() -> JsonDict:
    """A realistic request, modelled on samples/grade_report.py."""
    return {
        "problem": "My grade report crashes for one student but works for the others.",
        "reasoning": "I think average() is broken, but it works for ada and grace.",
        "evidence": (
            "Traceback (most recent call last):\n"
            '  File "grade_report.py", line 22, in report\n'
            '  File "stats.py", line 5, in average\n'
            "ZeroDivisionError: division by zero"
        ),
        "codeContexts": [
            {
                "label": "samples/stats.py",
                "languageId": "python",
                "source": "traceback",
                "startLine": 1,
                "endLine": 5,
                "lineCount": 5,
                "code": "def average(values):\n    return sum(values) / len(values)",
                "truncated": False,
            }
        ],
    }


@pytest.fixture
def session_id(client: TestClient, session_payload: JsonDict) -> str:
    response = client.post("/v1/sessions", json=session_payload)
    assert response.status_code == 201

    session_id: str = response.json()["id"]

    return session_id
