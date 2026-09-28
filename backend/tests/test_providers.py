"""The provider adapter: configuration, error translation, and privacy defaults."""

import litellm
import pytest
from litellm.exceptions import (
    APIConnectionError,
    AuthenticationError,
    BadRequestError,
    ContentPolicyViolationError,
    ContextWindowExceededError,
    NotFoundError,
    RateLimitError,
    Timeout,
)

from providers.base import (
    CompletionRequest,
    ProviderError,
    ProviderMisconfigured,
    ProviderRefused,
    ProviderTimeout,
    ProviderUnavailable,
)
from providers.fake import FailingProvider, ScriptedProvider
from providers.litellm_provider import _effort_arguments, _read_result, _translate
from providers.settings import (
    DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_SECONDS,
    load_provider_settings,
    setup_instructions,
)


class _Message:
    def __init__(self, content: object) -> None:
        self.content = content


class _Choice:
    def __init__(self, content: object, finish_reason: str = "stop") -> None:
        self.message = _Message(content)
        self.finish_reason = finish_reason


class _Usage:
    def __init__(self, prompt: int, completion: int) -> None:
        self.prompt_tokens = prompt
        self.completion_tokens = completion


class _Response:
    def __init__(self, choice: _Choice, usage: _Usage | None = None) -> None:
        self.choices = [choice]
        self.usage = usage


def test_litellm_telemetry_is_disabled_by_importing_the_provider() -> None:
    """No telemetry leaves the machine."""
    assert litellm.telemetry is False


def test_litellm_message_logging_is_disabled() -> None:
    """Our messages are the developer's source code and their traceback."""
    assert litellm.turn_off_message_logging is True


def test_no_key_means_no_provider() -> None:
    assert load_provider_settings({}) is None
    assert load_provider_settings({"OPENAI_API_KEY": "   "}) is None


def test_the_suite_itself_can_never_reach_a_real_model() -> None:
    """The guard in conftest.py, asserted rather than assumed."""
    assert load_provider_settings() is None


def test_defaults_are_used_when_only_a_key_is_set() -> None:
    settings = load_provider_settings({"OPENAI_API_KEY": "sk-test"})

    assert settings is not None
    assert settings.model == DEFAULT_MODEL == "openai/gpt-5-mini"
    assert settings.api_key == "sk-test"
    assert settings.timeout_seconds == DEFAULT_TIMEOUT_SECONDS
    assert settings.max_output_tokens == DEFAULT_MAX_OUTPUT_TOKENS


def test_every_setting_can_be_overridden() -> None:
    settings = load_provider_settings(
        {
            "ANTHROPIC_API_KEY": "sk-test",
            "SOCRATES_DUCK_MODEL": "anthropic/example-model",
            "SOCRATES_DUCK_LLM_TIMEOUT_SECONDS": "5",
            "SOCRATES_DUCK_MAX_OUTPUT_TOKENS": "256",
        }
    )

    assert settings is not None
    assert settings.model == "anthropic/example-model"
    assert settings.timeout_seconds == 5.0
    assert settings.max_output_tokens == 256


def test_the_key_is_read_only_from_the_configured_providers_variable() -> None:
    """An Anthropic key must never be sent to OpenAI, or the other way round."""
    both = {"OPENAI_API_KEY": "sk-openai", "ANTHROPIC_API_KEY": "sk-ant-anthropic"}

    openai = load_provider_settings(both)
    anthropic = load_provider_settings(
        {**both, "SOCRATES_DUCK_MODEL": "anthropic/example-model"}
    )

    assert openai is not None and openai.api_key == "sk-openai"
    assert anthropic is not None and anthropic.api_key == "sk-ant-anthropic"


def test_another_providers_key_does_not_configure_the_default_model() -> None:
    assert load_provider_settings({"ANTHROPIC_API_KEY": "sk-ant-test"}) is None


@pytest.mark.parametrize("model", ["gpt-5-mini", "mistral/mistral-small", "/gpt-5"])
def test_a_model_without_a_known_provider_prefix_is_not_configured(model: str) -> None:
    env = {
        "SOCRATES_DUCK_MODEL": model,
        "OPENAI_API_KEY": "sk-openai",
        "ANTHROPIC_API_KEY": "sk-ant-anthropic",
    }

    assert load_provider_settings(env) is None
    assert "SOCRATES_DUCK_MODEL must start with" in setup_instructions(env)


@pytest.mark.parametrize(
    ("model", "variable"),
    [
        (None, "OPENAI_API_KEY"),
        ("openai/gpt-5-nano", "OPENAI_API_KEY"),
        ("anthropic/example-model", "ANTHROPIC_API_KEY"),
    ],
)
def test_setup_instructions_name_the_variable_the_model_needs(
    model: str | None, variable: str
) -> None:
    env = {} if model is None else {"SOCRATES_DUCK_MODEL": model}

    assert setup_instructions(env) == f"Set {variable} and restart the backend."


@pytest.mark.parametrize("bad", ["not-a-number", "0", "-3", ""])
def test_a_malformed_timeout_falls_back_instead_of_crashing(bad: str) -> None:
    settings = load_provider_settings(
        {"OPENAI_API_KEY": "sk-test", "SOCRATES_DUCK_LLM_TIMEOUT_SECONDS": bad}
    )

    assert settings is not None
    assert settings.timeout_seconds == DEFAULT_TIMEOUT_SECONDS


@pytest.mark.parametrize(
    ("raised", "expected"),
    [
        (Timeout("slow", "m", "anthropic"), ProviderTimeout),
        (
            ContentPolicyViolationError("declined", "m", "anthropic"),
            ProviderRefused,
        ),
        (
            ContextWindowExceededError("too big", "m", "anthropic"),
            ProviderMisconfigured,
        ),
        (AuthenticationError("bad key", "anthropic", "m"), ProviderMisconfigured),
        (NotFoundError("no model", "m", "anthropic"), ProviderMisconfigured),
        (BadRequestError("nope", "m", "anthropic"), ProviderMisconfigured),
        (RateLimitError("slow down", "anthropic", "m"), ProviderUnavailable),
        (APIConnectionError("network", "m", "anthropic"), ProviderUnavailable),
        (ValueError("a bug in our own adapter"), ProviderError),
    ],
)
def test_client_errors_become_our_small_stable_set(
    raised: Exception, expected: type[ProviderError]
) -> None:
    """Callers fail closed against these classes, so the mapping is the contract."""
    assert type(_translate(raised)) is expected


def test_translated_errors_do_not_carry_the_original_message() -> None:
    """An upstream 400 echoes the request body, which here is the developer's code."""
    leaky = BadRequestError(
        "Invalid request: {'messages': [{'content': 'def secret_pricing():'}]}",
        "m",
        "anthropic",
    )

    assert "secret_pricing" not in str(_translate(leaky))


def test_effort_is_sent_to_a_model_that_reasons() -> None:
    assert _effort_arguments("openai/gpt-5-mini", "low") == {"reasoning_effort": "low"}


@pytest.mark.parametrize("model", ["openai/gpt-4.1-mini", "openai/not-a-real-model"])
def test_effort_is_not_sent_to_a_model_that_would_reject_it(model: str) -> None:
    assert _effort_arguments(model, "low") == {}


def test_no_effort_leaves_the_models_default() -> None:
    assert _effort_arguments("openai/gpt-5-mini", None) == {}


def test_a_normal_response_is_read_with_its_token_counts() -> None:
    result = _read_result(_Response(_Choice("Which branch runs first?"), _Usage(120, 18)))

    assert result.text == "Which branch runs first?"
    assert result.input_tokens == 120
    assert result.output_tokens == 18


def test_a_response_cut_off_at_the_token_cap_is_rejected() -> None:
    with pytest.raises(ProviderError, match="cut off"):
        _read_result(_Response(_Choice("What happens when", finish_reason="length")))


@pytest.mark.parametrize("empty", ["", "   \n ", None])
def test_an_empty_response_is_rejected(empty: object) -> None:
    with pytest.raises(ProviderError, match="empty"):
        _read_result(_Response(_Choice(empty)))


def test_a_response_with_no_usage_still_reads() -> None:
    result = _read_result(_Response(_Choice("ok"), usage=None))

    assert result.text == "ok"
    assert result.input_tokens is None


@pytest.mark.anyio
async def test_scripted_provider_records_what_it_was_asked() -> None:
    provider = ScriptedProvider(["first", "second"])
    request = CompletionRequest(system="s", user="u", max_output_tokens=10)

    assert (await provider.complete(request)).text == "first"
    assert (await provider.complete(request)).text == "second"
    assert len(provider.requests) == 2


@pytest.mark.anyio
async def test_failing_provider_counts_calls_for_retry_budgets() -> None:
    provider = FailingProvider(ProviderTimeout("nope"))

    with pytest.raises(ProviderTimeout):
        await provider.complete(
            CompletionRequest(system="s", user="u", max_output_tokens=10)
        )

    assert provider.calls == 1


def test_health_reports_a_configured_provider_without_leaking_the_key() -> None:
    """The developer needs to know their key was picked up."""
    from fastapi.testclient import TestClient

    from api.app import create_app
    from persistence.metrics import NullMetricsStore
    from providers.fake import ScriptedProvider

    client = TestClient(
        create_app(provider=ScriptedProvider([]), store=NullMetricsStore())
    )
    body = client.get("/health").json()

    assert body["status"] == "ok"
    assert body["provider"] == "configured"
    assert "sk-" not in client.get("/health").text
