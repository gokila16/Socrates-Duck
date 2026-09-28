"""Request and response shapes for the local API."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

from domain.models import HintKind, Outcome, SessionStatus

MAX_PROBLEM_CHARS = 4_000
MAX_REASONING_CHARS = 4_000
MAX_EVIDENCE_CHARS = 20_000
MAX_CODE_CHARS = 40_000
MAX_CODE_CONTEXTS = 8

ProblemText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_PROBLEM_CHARS),
]
ReasoningText = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=MAX_REASONING_CHARS
    ),
]
EvidenceText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_EVIDENCE_CHARS),
]


class StrictModel(BaseModel):
    """The wire contract with the extension."""

    model_config = ConfigDict(
        extra="forbid",
        alias_generator=to_camel,
        populate_by_name=True,
    )


class CodeContextIn(StrictModel):
    label: str = Field(min_length=1, max_length=400)
    language_id: str = Field(min_length=1, max_length=50)
    source: Literal["selection", "file", "traceback"]
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    line_count: int = Field(ge=1)
    code: str = Field(min_length=1, max_length=MAX_CODE_CHARS)
    truncated: bool

    @model_validator(mode="after")
    def check_line_range(self) -> "CodeContextIn":
        if self.end_line < self.start_line:
            raise ValueError("endLine must not be before startLine")

        if self.line_count != self.end_line - self.start_line + 1:
            raise ValueError("lineCount must match the startLine/endLine range")

        return self


class CreateSessionRequest(StrictModel):
    problem: ProblemText
    reasoning: ReasoningText | None = None
    code_contexts: list[CodeContextIn] = Field(min_length=1, max_length=MAX_CODE_CONTEXTS)
    evidence: EvidenceText | None = None


class AttemptRequest(StrictModel):
    reasoning: ReasoningText
    evidence: EvidenceText | None = None
    outcome: Outcome | None = None
    code_contexts: list[CodeContextIn] | None = Field(
        default=None, min_length=1, max_length=MAX_CODE_CONTEXTS
    )


class HintRequest(StrictModel):
    kind: HintKind = HintKind.NORMAL


MAX_QUESTION_CHARS = 1_000


class QuestionRequest(StrictModel):
    hint_number: int = Field(ge=1)
    question: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True, min_length=1, max_length=MAX_QUESTION_CHARS
        ),
    ]


class QuestionResponse(StrictModel):
    """The answer, and nothing else — as with a hint, an allowlist."""

    hint_number: int
    answer: str
    next_action: str


class CompleteRequest(StrictModel):
    status: Literal["completed", "abandoned"]
    outcome: Outcome | None = None


class HintResponse(StrictModel):
    """What the developer is allowed to see."""

    level: int
    next_action: str
    question: str | None = None
    concept: str | None = None
    evidence: str | None = None


class SessionResponse(StrictModel):
    """Session state, with none of its contents echoed back."""

    id: str
    status: SessionStatus
    hint_count: int
    highest_hint_level: int
