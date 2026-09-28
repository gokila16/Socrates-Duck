"""The one provider implementation, on top of LiteLLM."""

from typing import Any, cast

import litellm
from litellm.exceptions import (
    APIConnectionError,
    APIError,
    AuthenticationError,
    BadRequestError,
    ContentPolicyViolationError,
    ContextWindowExceededError,
    InternalServerError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    ServiceUnavailableError,
    Timeout,
)

from providers.base import (
    CompletionRequest,
    CompletionResult,
    Effort,
    ProviderError,
    ProviderMisconfigured,
    ProviderRefused,
    ProviderTimeout,
    ProviderUnavailable,
)
from providers.settings import ProviderSettings

# Keep the developer's code out of telemetry and logs.
litellm.telemetry = False
litellm.turn_off_message_logging = True
litellm.suppress_debug_info = True


class LiteLlmProvider:
    """Satisfies `providers.base.LlmProvider`."""

    def __init__(self, settings: ProviderSettings) -> None:
        self._settings = settings

    async def complete(self, request: CompletionRequest) -> CompletionResult:
        try:
            response = await litellm.acompletion(
                model=self._settings.model,
                api_key=self._settings.api_key,
                messages=[
                    {"role": "system", "content": request.system},
                    {"role": "user", "content": request.user},
                ],
                max_tokens=request.max_output_tokens,
                timeout=self._settings.timeout_seconds,
                # Retries belong to the caller, which budgets them per call.
                num_retries=0,
                **_effort_arguments(self._settings.model, request.effort),
            )
        except Exception as error:
            # Drop the original: its message can echo the request, i.e. the code.
            raise _translate(error) from None

        return _read_result(response)


def _effort_arguments(model: str, effort: Effort | None) -> dict[str, str]:
    """`reasoning_effort`, but only for a model that thinks before answering."""
    if effort is None:
        return {}

    try:
        supported = litellm.supports_reasoning(model=model)
    except Exception:
        supported = False

    return {"reasoning_effort": effort} if supported else {}


def _translate(error: Exception) -> ProviderError:
    """Maps a client exception onto our small, stable set."""
    if isinstance(error, Timeout):
        return ProviderTimeout("The model did not respond in time.")

    if isinstance(error, ContentPolicyViolationError):
        return ProviderRefused("The provider declined to answer this request.")

    if isinstance(error, ContextWindowExceededError):
        return ProviderMisconfigured("The request was too large for this model.")

    if isinstance(error, AuthenticationError | PermissionDeniedError):
        return ProviderMisconfigured("The provider rejected the API key.")

    if isinstance(error, NotFoundError):
        return ProviderMisconfigured("The configured model was not found.")

    if isinstance(error, BadRequestError):
        return ProviderMisconfigured("The provider rejected the request.")

    if isinstance(
        error,
        RateLimitError
        | ServiceUnavailableError
        | InternalServerError
        | APIConnectionError,
    ):
        return ProviderUnavailable("The provider is unavailable right now.")

    if isinstance(error, APIError):
        return ProviderUnavailable("The provider returned an unexpected error.")

    return ProviderError("The model call failed.")


def _read_result(response: object) -> CompletionResult:
    """Pulls the text out, refusing anything a caller could misread."""
    payload = cast(Any, response)

    choice = payload.choices[0]

    if choice.finish_reason == "length":
        raise ProviderError("The model's response was cut off before it finished.")

    text = choice.message.content

    if not isinstance(text, str) or text.strip() == "":
        raise ProviderError("The model returned an empty response.")

    usage = getattr(payload, "usage", None)

    return CompletionResult(
        text=text,
        input_tokens=getattr(usage, "prompt_tokens", None),
        output_tokens=getattr(usage, "completion_tokens", None),
    )
