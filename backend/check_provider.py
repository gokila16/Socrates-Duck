"""Manual check that the configured provider actually answers."""

import asyncio
import sys

from providers.base import CompletionRequest, ProviderError
from providers.litellm_provider import LiteLlmProvider
from providers.settings import load_provider_settings, setup_instructions


async def main() -> int:
    settings = load_provider_settings()

    if settings is None:
        print(f"No model is configured. {setup_instructions()}")
        return 1

    print(f"model   : {settings.model}")
    print(f"timeout : {settings.timeout_seconds}s")
    print(f"max out : {settings.max_output_tokens} tokens")
    print()

    provider = LiteLlmProvider(settings)

    try:
        result = await provider.complete(
            CompletionRequest(
                system="Answer in exactly one short sentence.",
                user="Confirm you are reachable.",
                max_output_tokens=settings.max_output_tokens,
            )
        )
    except ProviderError as error:
        print(f"FAILED  : {type(error).__name__}: {error}")
        return 1

    print(f"reply   : {result.text.strip()}")
    print(f"tokens  : {result.input_tokens} in, {result.output_tokens} out")

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
