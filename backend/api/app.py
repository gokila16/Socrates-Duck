"""The FastAPI application."""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from api.routes import router
from persistence.metrics import MetricsStore, SqliteMetricsStore
from persistence.repository import InMemorySessionRepository, SessionRepository
from providers.base import LlmProvider
from providers.litellm_provider import LiteLlmProvider
from providers.settings import (
    DEFAULT_MAX_OUTPUT_TOKENS,
    ProviderSettings,
    load_provider_settings,
)


def create_app(
    repository: SessionRepository | None = None,
    provider: LlmProvider | None = None,
    store: MetricsStore | None = None,
) -> FastAPI:
    """Builds an app, optionally with the parts a test wants to supply itself."""
    app = FastAPI(
        title="Socrates' Duck",
        version="0.0.1",
        summary="Local Socratic hint service for the Socrates' Duck extension.",
    )

    app.state.repository = (
        repository if repository is not None else InMemorySessionRepository()
    )
    app.state.store = store if store is not None else SqliteMetricsStore()
    settings = load_provider_settings()
    app.state.provider = provider if provider is not None else _build_provider(settings)
    app.state.max_output_tokens = (
        settings.max_output_tokens if settings is not None else DEFAULT_MAX_OUTPUT_TOKENS
    )
    app.include_router(router)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)

    @app.get("/health", tags=["meta"])
    def health() -> dict[str, str]:
        """Lets the extension check the backend is up before starting a session."""
        configured = app.state.provider is not None

        return {
            "status": "ok",
            "provider": "configured" if configured else "absent",
            "model": _configured_model() if configured else "",
        }

    return app


def _build_provider(settings: ProviderSettings | None) -> LlmProvider | None:
    """Constructs the provider from the environment, or None when unconfigured."""
    return None if settings is None else LiteLlmProvider(settings)


def _configured_model() -> str:
    settings = load_provider_settings()

    return "" if settings is None else settings.model


async def _validation_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Reports what failed without echoing what was sent."""
    if not isinstance(exc, RequestValidationError):
        raise exc

    return JSONResponse(
        status_code=422,
        content={
            "detail": [
                {
                    "loc": list(error["loc"]),
                    "msg": error["msg"],
                    "type": error["type"],
                }
                for error in exc.errors()
            ]
        },
    )
