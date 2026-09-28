"""The hint workflow: one controlled graph, not autonomous agents."""

from collections.abc import Callable
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Annotated, Literal, NotRequired, TypedDict, TypeVar

import langsmith
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime
from pydantic import (
    BaseModel,
    ConfigDict,
    StringConstraints,
    ValidationError,
    field_validator,
)

from domain.models import (
    Clarification,
    Diagnosis,
    Hint,
    HintKind,
    HintSource,
    LeakageRecord,
    ReasoningProgress,
    Session,
    Verdict,
)
from policies.fallback import safe_fallback_answer, safe_fallback_hint
from policies.ladder import rung, select_level
from policies.leakage import hard_block
from policies.repetition import repeats_earlier_action
from providers.base import (
    CompletionRequest,
    LlmProvider,
    ProviderError,
    ProviderMisconfigured,
    ProviderTimeout,
)
from workflows.prompts import (
    Correction,
    analysis_request,
    answer_request,
    hint_request,
    judge_request,
)

MAX_REWRITES = 2

MAX_REPEAT_RETRIES = 1

# LangSmith tracing would upload each run's state, including the developer's code.
langsmith.configure(enabled=False)


class HintUnavailable(Exception):
    """No hint could be produced."""


class HintStep(StrEnum):
    """What the workflow is doing right now, for the panel to show."""

    READING = "reading"
    WRITING = "writing"
    CHECKING = "checking"
    REWORDING = "rewording"


@dataclass(frozen=True)
class HintContext:
    """What a run needs from outside the session: which model, and its budget."""

    provider: LlmProvider
    max_output_tokens: int
    on_step: Callable[[HintStep], None] | None = None


def _report(runtime: Runtime[HintContext], step: HintStep) -> None:
    if runtime.context.on_step is not None:
        runtime.context.on_step(step)


class HintState(TypedDict):
    """The graph's state."""

    session: Session
    kind: HintKind
    question: NotRequired[str]
    about: NotRequired[int]
    diagnosis: NotRequired[Diagnosis]
    level: NotRequired[int]
    candidate: NotRequired[Hint]
    deterministic: NotRequired[Verdict]
    judge: NotRequired[Verdict]
    rule: NotRequired[str | None]
    reason: NotRequired[str | None]
    rewrites: NotRequired[int]
    hint: NotRequired[Hint]


class _Update(TypedDict, total=False):
    """What a node may change."""

    diagnosis: Diagnosis
    level: int
    candidate: Hint
    deterministic: Verdict
    judge: Verdict
    rule: str | None
    reason: str | None
    rewrites: int
    hint: Hint


async def next_hint(session: Session, kind: HintKind, context: HintContext) -> Hint:
    """Runs the workflow, records its result on the session, and returns the hint."""
    final = await _GRAPH.ainvoke({"session": session, "kind": kind}, context=context)

    hint: Hint = final["hint"]
    session.diagnosis = final["diagnosis"]
    session.record_hint(hint)

    return hint


async def answer_question(
    session: Session, about: int, question: str, context: HintContext
) -> Clarification:
    """Answers a question about hint number `about`, and records the answer."""
    asked = session.hints[about - 1]
    final = await _GRAPH.ainvoke(
        {"session": session, "kind": asked.kind, "question": question, "about": about},
        context=context,
    )

    result: Hint = final["hint"]
    session.diagnosis = final["diagnosis"]
    clarification = Clarification(
        about_hint=about,
        question=question,
        answer=result.concept or "",
        next_action=result.next_action,
        level=result.level,
        leakage=result.leakage,
    )
    session.record_clarification(clarification)

    return clarification


async def _analyze(state: HintState, runtime: Runtime[HintContext]) -> _Update:
    session = state["session"]
    cached = session.diagnosis

    if cached is not None and cached.attempts_seen == len(session.attempts):
        return {"diagnosis": cached}

    _report(runtime, HintStep.READING)
    parsed = await _complete_as(
        _DiagnosisOut,
        runtime.context.provider,
        analysis_request(session, runtime.context.max_output_tokens),
    )

    return {
        "diagnosis": Diagnosis(
            root_cause=parsed.root_cause,
            key_inference=parsed.key_inference,
            suspicious_region=parsed.suspicious_region,
            faulty_assumption=parsed.faulty_assumption,
            reasoning_assessment=parsed.reasoning_assessment,
            reasoning_progress=_progress(parsed.reasoning_progress),
            attempts_seen=len(session.attempts),
            bug_found=parsed.bug_found,
        )
    }


def _select_level(state: HintState) -> _Update:
    if "about" in state:
        return {"level": state["session"].hints[state["about"] - 1].level}

    return {
        "level": select_level(
            state["session"],
            state["kind"],
            state["diagnosis"].reasoning_progress,
            state["diagnosis"].bug_found,
        )
    }


async def _generate(state: HintState, runtime: Runtime[HintContext]) -> _Update:
    """The first candidate, rewritten once if it repeats an earlier action."""
    _report(runtime, HintStep.WRITING)

    if "question" in state:
        return {"candidate": await _write_answer(state, runtime), "rewrites": 0}

    candidate = await _write_hint(state, runtime)
    retries = 0

    for _ in range(MAX_REPEAT_RETRIES):
        repeated = repeats_earlier_action(candidate, state["session"].hints)

        if repeated is None:
            break

        candidate = await _write_hint(
            state,
            runtime,
            Correction(candidate=candidate, repeats_level=repeated),
        )
        retries += 1

    return {"candidate": replace(candidate, repeat_retries=retries), "rewrites": 0}


async def _check_leakage(state: HintState, runtime: Runtime[HintContext]) -> _Update:
    """Runs the hard rules, then the judge."""
    _report(runtime, HintStep.CHECKING)
    candidate = state["candidate"]
    blocked = hard_block(candidate)

    if blocked is not None:
        return {
            "deterministic": Verdict.LEAK,
            "judge": Verdict.NOT_RUN,
            "rule": blocked.rule,
            "reason": None,
        }

    verdict, reason = await _judge(
        runtime.context.provider,
        judge_request(
            state["session"],
            state["diagnosis"],
            rung(state["level"]),
            candidate,
            runtime.context.max_output_tokens,
            question=state.get("question"),
        ),
    )

    return {
        "deterministic": Verdict.CLEAN,
        "judge": verdict,
        "rule": None,
        "reason": reason,
    }


def _route(state: HintState) -> Literal["accept", "rewrite", "fallback"]:
    """The only path to `accept` is both layers returning clean."""
    if state["deterministic"] is Verdict.CLEAN and state["judge"] is Verdict.CLEAN:
        return "accept"

    # Without a judge a rewrite could not be checked either, so fail closed.
    if state["judge"] is Verdict.NOT_RUN and state["deterministic"] is Verdict.CLEAN:
        return "fallback"

    return "rewrite" if state["rewrites"] < MAX_REWRITES else "fallback"


async def _rewrite(state: HintState, runtime: Runtime[HintContext]) -> _Update:
    """Another attempt at the same rung, told what the last one gave away."""
    _report(runtime, HintStep.REWORDING)
    correction = Correction(candidate=state["candidate"], reason=state["reason"])
    candidate = (
        await _write_answer(state, runtime, correction)
        if "question" in state
        else await _write_hint(state, runtime, correction)
    )

    return {
        "candidate": replace(candidate, repeat_retries=state["candidate"].repeat_retries),
        "rewrites": state["rewrites"] + 1,
    }


async def _write_hint(
    state: HintState,
    runtime: Runtime[HintContext],
    correction: Correction | None = None,
) -> Hint:
    """One hint call, optionally told what the previous attempt got wrong."""
    level = state["level"]

    parsed = await _complete_as(
        _HintOut,
        runtime.context.provider,
        hint_request(
            state["session"],
            state["diagnosis"],
            rung(level),
            state["kind"],
            runtime.context.max_output_tokens,
            correction=correction,
        ),
    )

    return _to_hint(parsed, state, level)


async def _write_answer(
    state: HintState,
    runtime: Runtime[HintContext],
    correction: Correction | None = None,
) -> Hint:
    """One answer call, returned in the Hint shape so the checks can read it."""
    level = state["level"]

    parsed = await _complete_as(
        _AnswerOut,
        runtime.context.provider,
        answer_request(
            state["session"],
            state["diagnosis"],
            rung(level),
            state["about"],
            state["question"],
            runtime.context.max_output_tokens,
            correction=correction,
        ),
    )

    return Hint(
        level=level,
        kind=state["kind"],
        next_action=parsed.next_action,
        attempts_seen=len(state["session"].attempts),
        concept=parsed.answer,
    )


def _accept(state: HintState) -> _Update:
    source = HintSource.GENERATED if state["rewrites"] == 0 else HintSource.REWRITTEN

    return {"hint": replace(state["candidate"], leakage=_record(state, source))}


def _fallback(state: HintState) -> _Update:
    """The predefined safe question, when nothing safe could be produced."""
    session = state["session"]
    fallback = safe_fallback_answer if "question" in state else safe_fallback_hint

    return {
        "hint": replace(
            fallback(
                level=state["level"],
                kind=state["kind"],
                attempts_seen=len(session.attempts),
            ),
            leakage=_record(state, HintSource.FALLBACK),
        )
    }


def _to_hint(parsed: "_HintOut", state: HintState, level: int) -> Hint:
    return Hint(
        level=level,
        kind=state["kind"],
        next_action=parsed.next_action,
        attempts_seen=len(state["session"].attempts),
        question=parsed.question,
        concept=parsed.concept,
        evidence=parsed.evidence,
    )


def _record(state: HintState, source: HintSource) -> LeakageRecord:
    return LeakageRecord(
        deterministic=state["deterministic"],
        judge=state["judge"],
        rewrites=state["rewrites"],
        source=source,
        rule=state["rule"],
        reason=state["reason"],
    )


def _build_graph() -> CompiledStateGraph[HintState, HintContext, HintState, HintState]:
    builder = StateGraph(HintState, context_schema=HintContext)

    builder.add_node("analyze", _analyze)
    builder.add_node("select_level", _select_level)
    builder.add_node("generate", _generate)
    builder.add_node("check_leakage", _check_leakage)
    builder.add_node("rewrite", _rewrite)
    builder.add_node("accept", _accept)
    builder.add_node("fallback", _fallback)

    builder.add_edge(START, "analyze")
    builder.add_edge("analyze", "select_level")
    builder.add_edge("select_level", "generate")
    builder.add_edge("generate", "check_leakage")
    builder.add_conditional_edges("check_leakage", _route)
    builder.add_edge("rewrite", "check_leakage")
    builder.add_edge("accept", END)
    builder.add_edge("fallback", END)

    return builder.compile()


_Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class _ModelReply(BaseModel):
    """The model's JSON, validated like any other untrusted input."""

    model_config = ConfigDict(extra="ignore")


class _DiagnosisOut(_ModelReply):
    root_cause: _Text
    key_inference: _Text
    suspicious_region: _Text
    faulty_assumption: _Text
    reasoning_assessment: _Text
    reasoning_progress: str = ReasoningProgress.UNCHANGED.value
    bug_found: bool = True


def _progress(value: str) -> ReasoningProgress:
    try:
        return ReasoningProgress(value.strip().lower())
    except ValueError:
        return ReasoningProgress.UNCHANGED


class _HintOut(_ModelReply):
    next_action: _Text
    question: str | None = None
    concept: str | None = None
    evidence: str | None = None

    @field_validator("question", "concept", "evidence")
    @classmethod
    def _blank_is_absent(cls, value: str | None) -> str | None:
        """Stores "" as None, so "omit when empty" has one case, not two."""
        if value is None or value.strip() == "":
            return None

        return value.strip()


class _AnswerOut(_ModelReply):
    answer: _Text
    next_action: _Text


class _JudgeOut(_ModelReply):
    verdict: Literal["clean", "leak"]
    reason: str | None = None


ReplyT = TypeVar("ReplyT", bound=_ModelReply)


async def _complete_as(
    reply_type: type[ReplyT], provider: LlmProvider, request: CompletionRequest
) -> ReplyT:
    """One model call, parsed into `reply_type`."""
    for _ in range(2):
        try:
            result = await provider.complete(request)
        except ProviderError as error:
            raise HintUnavailable(_explain(error)) from None

        parsed = _parse(reply_type, result.text)

        if parsed is not None:
            return parsed

    raise HintUnavailable("The model's reply could not be read. Try again.")


def _explain(error: ProviderError) -> str:
    """Fixed text per failure class — what the developer can do about it."""
    if isinstance(error, ProviderTimeout):
        return "The model did not respond in time. Try again."

    if isinstance(error, ProviderMisconfigured):
        return (
            "The model is not configured correctly. Check the backend's API key "
            "and model settings."
        )

    return "The model is unavailable right now. Try again."


async def _judge(
    provider: LlmProvider, request: CompletionRequest
) -> tuple[Verdict, str | None]:
    """The judge's verdict, or NOT_RUN when it could not give one."""
    for _ in range(2):
        try:
            result = await provider.complete(request)
        except ProviderError:
            continue

        parsed = _parse(_JudgeOut, result.text)

        if parsed is not None:
            verdict = Verdict.LEAK if parsed.verdict == "leak" else Verdict.CLEAN

            return verdict, parsed.reason

    return Verdict.NOT_RUN, None


def _parse(reply_type: type[ReplyT], text: str) -> ReplyT | None:
    """Reads one JSON object out of the reply, tolerating a wrapper around it."""
    start, end = text.find("{"), text.rfind("}")

    if start == -1 or end < start:
        return None

    try:
        return reply_type.model_validate_json(text[start : end + 1])
    except ValidationError:
        return None


_GRAPH = _build_graph()
