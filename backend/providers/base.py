"""The boundary between Socrates' Duck and whichever model answers."""

from dataclasses import dataclass
from typing import Literal, Protocol

Effort = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class CompletionRequest:
    """One turn: a system instruction and the developer-derived content."""

    system: str
    user: str
    max_output_tokens: int
    effort: Effort | None = None


@dataclass(frozen=True)
class CompletionResult:
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None


class ProviderError(Exception):
    """Base for every failure this package reports."""


class ProviderTimeout(ProviderError):
    """The model did not answer inside the configured timeout."""


class ProviderUnavailable(ProviderError):
    """Reachable but not answering: rate limited, overloaded, or a network fault."""


class ProviderRefused(ProviderError):
    """The provider declined to answer at all."""


class ProviderMisconfigured(ProviderError):
    """A bad key, an unknown model, or a malformed request."""


class LlmProvider(Protocol):
    """The whole surface the rest of the backend may use."""

    async def complete(self, request: CompletionRequest) -> CompletionResult: ...
