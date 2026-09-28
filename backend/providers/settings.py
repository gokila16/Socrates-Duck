"""Where the model configuration comes from."""

import os
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_MODEL = "openai/gpt-5-mini"

KEY_VARIABLES = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}

DEFAULT_TIMEOUT_SECONDS = 30.0

DEFAULT_MAX_OUTPUT_TOKENS = 4_096


@dataclass(frozen=True)
class ProviderSettings:
    model: str
    api_key: str
    timeout_seconds: float
    max_output_tokens: int


def load_provider_settings(
    env: Mapping[str, str] | None = None,
) -> ProviderSettings | None:
    """Reads the configuration, or returns None when there is no usable key."""
    source = os.environ if env is None else env

    model = _configured_model(source)
    key_variable = KEY_VARIABLES.get(_provider_of(model))

    if key_variable is None:
        return None

    api_key = source.get(key_variable, "").strip()

    if api_key == "":
        return None

    return ProviderSettings(
        model=model,
        api_key=api_key,
        timeout_seconds=_positive_float(
            source, "SOCRATES_DUCK_LLM_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS
        ),
        max_output_tokens=int(
            _positive_float(
                source, "SOCRATES_DUCK_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS
            )
        ),
    )


def setup_instructions(env: Mapping[str, str] | None = None) -> str:
    """What the developer must set, given the model they have configured."""
    source = os.environ if env is None else env

    key_variable = KEY_VARIABLES.get(_provider_of(_configured_model(source)))

    if key_variable is None:
        supported = ", ".join(f"{provider}/" for provider in KEY_VARIABLES)
        return f"SOCRATES_DUCK_MODEL must start with one of: {supported}."

    return f"Set {key_variable} and restart the backend."


def _configured_model(source: Mapping[str, str]) -> str:
    return source.get("SOCRATES_DUCK_MODEL", "").strip() or DEFAULT_MODEL


def _provider_of(model: str) -> str:
    """ "openai/gpt-5-mini" -> "openai"."""
    provider, separator, _ = model.partition("/")

    return provider if separator else ""


def _positive_float(source: Mapping[str, str], name: str, fallback: float) -> float:
    """Falls back rather than crashing on a malformed value."""
    raw = source.get(name, "").strip()

    if raw == "":
        return fallback

    try:
        value = float(raw)
    except ValueError:
        return fallback

    return value if value > 0 else fallback
