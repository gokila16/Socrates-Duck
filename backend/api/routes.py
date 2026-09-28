"""The session, hint, question, attempt, and completion endpoints."""

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import replace
from typing import TypeVar, cast

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from api.schemas import (
    AttemptRequest,
    CodeContextIn,
    CompleteRequest,
    CreateSessionRequest,
    HintRequest,
    HintResponse,
    QuestionRequest,
    QuestionResponse,
    SessionResponse,
)
from domain.models import Attempt, CodeContext, Hint, Session, SessionStatus
from persistence.metrics import MetricsStore
from persistence.repository import SessionRepository
from providers.base import LlmProvider
from providers.settings import setup_instructions
from workflows.hinting import (
    HintContext,
    HintStep,
    HintUnavailable,
    answer_question,
    next_hint,
)

ResultT = TypeVar("ResultT")

router = APIRouter(prefix="/v1", tags=["sessions"])


def get_repository(request: Request) -> SessionRepository:
    """Hands routes the repository the app was built with."""
    return cast(SessionRepository, request.app.state.repository)


def get_store(request: Request) -> MetricsStore:
    """The durable metrics store the app was built with."""
    return cast(MetricsStore, request.app.state.store)


def get_hint_context(request: Request) -> HintContext | None:
    """The model and its budget, or None when the developer has not set a key."""
    provider = cast(LlmProvider | None, request.app.state.provider)

    if provider is None:
        return None

    return HintContext(
        provider=provider,
        max_output_tokens=cast(int, request.app.state.max_output_tokens),
    )


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
def create_session(
    payload: CreateSessionRequest,
    repository: SessionRepository = Depends(get_repository),
    store: MetricsStore = Depends(get_store),
) -> SessionResponse:
    session = Session(
        problem=payload.problem,
        reasoning=payload.reasoning,
        evidence=payload.evidence,
        code_contexts=tuple(_to_domain(context) for context in payload.code_contexts),
    )
    repository.add(session)
    store.session_started(session)

    return _session_response(session)


@router.post("/sessions/{session_id}/attempts")
def record_attempt(
    session_id: str,
    payload: AttemptRequest,
    repository: SessionRepository = Depends(get_repository),
    store: MetricsStore = Depends(get_store),
) -> SessionResponse:
    session = _load_active(repository, session_id)
    attempt = Attempt(
        reasoning=payload.reasoning,
        evidence=payload.evidence,
        outcome=payload.outcome,
        code_refreshed=payload.code_contexts is not None,
    )

    if payload.code_contexts is not None:
        session.code_contexts = tuple(
            _to_domain(context) for context in payload.code_contexts
        )

    session.record_attempt(attempt)
    store.attempt_recorded(session, attempt)

    return _session_response(session)


@router.post("/sessions/{session_id}/hints", response_model=HintResponse)
async def request_hint(
    session_id: str,
    payload: HintRequest,
    request: Request,
    repository: SessionRepository = Depends(get_repository),
    context: HintContext | None = Depends(get_hint_context),
    store: MetricsStore = Depends(get_store),
) -> HintResponse | StreamingResponse:
    """Returns the next hint, streaming its steps when the client asks for them."""
    session = _load_active(repository, session_id)

    if context is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"No model is configured. {setup_instructions()}",
        )

    def deliver(hint: Hint) -> tuple[str, dict[str, object]]:
        store.hint_recorded(session, hint)
        return "hint", _hint_response(hint).model_dump(by_alias=True, mode="json")

    if _wants_stream(request):
        return _stream(
            lambda ctx: next_hint(session, payload.kind, ctx), context, deliver
        )

    try:
        hint = await next_hint(session, payload.kind, context)
    except HintUnavailable as error:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(error)) from None

    store.hint_recorded(session, hint)

    return _hint_response(hint)


@router.post("/sessions/{session_id}/questions", response_model=QuestionResponse)
async def ask_question(
    session_id: str,
    payload: QuestionRequest,
    request: Request,
    repository: SessionRepository = Depends(get_repository),
    context: HintContext | None = Depends(get_hint_context),
    store: MetricsStore = Depends(get_store),
) -> QuestionResponse | StreamingResponse:
    """Answers a question about one of the session's hints."""
    session = _load_active(repository, session_id)

    if payload.hint_number > len(session.hints):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "There is no hint with that number in this session.",
        )

    if context is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"No model is configured. {setup_instructions()}",
        )

    def ask(ctx: HintContext) -> Awaitable[QuestionResponse]:
        return _answer(session, payload, ctx, store)

    if _wants_stream(request):
        return _stream(
            ask,
            context,
            lambda answer: ("answer", answer.model_dump(by_alias=True, mode="json")),
        )

    try:
        return await ask(context)
    except HintUnavailable as error:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(error)) from None


async def _answer(
    session: Session, payload: QuestionRequest, context: HintContext, store: MetricsStore
) -> QuestionResponse:
    clarification = await answer_question(
        session, payload.hint_number, payload.question, context
    )
    store.question_recorded(session, clarification)

    return QuestionResponse(
        hint_number=clarification.about_hint,
        answer=clarification.answer,
        next_action=clarification.next_action,
    )


def _wants_stream(request: Request) -> bool:
    return "text/event-stream" in request.headers.get("accept", "")


def _stream(
    run: Callable[[HintContext], Awaitable[ResultT]],
    context: HintContext,
    deliver: Callable[[ResultT], tuple[str, dict[str, object]]],
) -> StreamingResponse:
    return StreamingResponse(
        _events(run, context, deliver),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )


async def _events(
    run: Callable[[HintContext], Awaitable[ResultT]],
    context: HintContext,
    deliver: Callable[[ResultT], tuple[str, dict[str, object]]],
) -> AsyncIterator[str]:
    """Streams `step` events as work starts, then one `hint`, `answer`, or `error`."""
    steps: asyncio.Queue[HintStep] = asyncio.Queue()
    task = asyncio.ensure_future(run(replace(context, on_step=steps.put_nowait)))

    try:
        while not task.done():
            waiting = asyncio.ensure_future(steps.get())
            await asyncio.wait({task, waiting}, return_when=asyncio.FIRST_COMPLETED)

            if waiting.done():
                yield _event("step", {"step": waiting.result().value})
            else:
                waiting.cancel()

        while not steps.empty():
            yield _event("step", {"step": steps.get_nowait().value})

        try:
            result = task.result()
        except HintUnavailable as error:
            yield _event("error", {"detail": str(error)})
            return
        except Exception:
            yield _event("error", {"detail": "Something went wrong writing the hint."})
            return

        name, data = deliver(result)
        yield _event(name, data)
    finally:
        if not task.done():
            task.cancel()


def _event(name: str, data: dict[str, object]) -> str:
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


def _hint_response(hint: Hint) -> HintResponse:
    return HintResponse(
        level=hint.level,
        next_action=hint.next_action,
        question=hint.question,
        concept=hint.concept,
        evidence=hint.evidence,
    )


@router.post("/sessions/{session_id}/complete")
def complete_session(
    session_id: str,
    payload: CompleteRequest,
    repository: SessionRepository = Depends(get_repository),
    store: MetricsStore = Depends(get_store),
) -> SessionResponse:
    session = _load_active(repository, session_id)
    session.finish(SessionStatus(payload.status), payload.outcome)
    store.session_finished(session)

    return _session_response(session)


def _to_domain(context: CodeContextIn) -> CodeContext:
    """Maps one wire object onto the domain model, field by field."""
    return CodeContext(
        label=context.label,
        language_id=context.language_id,
        source=context.source,
        start_line=context.start_line,
        end_line=context.end_line,
        code=context.code,
        truncated=context.truncated,
    )


def _load_active(repository: SessionRepository, session_id: str) -> Session:
    """Finds a session that can still be worked on."""
    session = repository.get(session_id)

    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found.")

    if not session.is_active:
        raise HTTPException(status.HTTP_409_CONFLICT, "This session has finished.")

    return session


def _session_response(session: Session) -> SessionResponse:
    return SessionResponse(
        id=session.id,
        status=session.status,
        hint_count=len(session.hints),
        highest_hint_level=session.highest_hint_level,
    )
