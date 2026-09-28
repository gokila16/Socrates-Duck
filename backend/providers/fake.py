"""Providers for tests."""

from collections.abc import Callable, Sequence
from typing import NoReturn

from providers.base import CompletionRequest, CompletionResult, ProviderError


class ScriptedProvider:
    """Hands back prepared answers in order, and records what it was asked."""

    def __init__(self, responses: Sequence[str]) -> None:
        self._responses = list(responses)
        self._requests: list[CompletionRequest] = []

    @property
    def requests(self) -> list[CompletionRequest]:
        """Every request received, so a test can assert on what was sent."""
        return list(self._requests)

    async def complete(self, request: CompletionRequest) -> CompletionResult:
        self._requests.append(request)

        if not self._responses:
            raise AssertionError(
                "ScriptedProvider ran out of responses: the code under test "
                "made more model calls than the test expected."
            )

        return CompletionResult(text=self._responses.pop(0))


class RespondingProvider:
    """Answers each request with a function of that request, and records them."""

    def __init__(self, respond: Callable[[CompletionRequest], str]) -> None:
        self._respond = respond
        self._requests: list[CompletionRequest] = []

    @property
    def requests(self) -> list[CompletionRequest]:
        return list(self._requests)

    async def complete(self, request: CompletionRequest) -> CompletionResult:
        self._requests.append(request)

        return CompletionResult(text=self._respond(request))


class FailingProvider:
    """Always raises, for the fail-closed paths."""

    def __init__(self, error: ProviderError) -> None:
        self._error = error
        self._calls = 0

    @property
    def calls(self) -> int:
        """How many times it was called — retry budgets are testable this way."""
        return self._calls

    async def complete(self, request: CompletionRequest) -> NoReturn:
        self._calls += 1

        raise self._error
