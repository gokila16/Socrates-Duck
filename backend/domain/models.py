"""Domain models for a Socrates' Duck session."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum

MIN_HINT_LEVEL = 1
MAX_HINT_LEVEL = 8


class Outcome(StrEnum):
    """What the developer reports after rerunning their own code."""

    RESOLVED = "resolved"
    STILL_STUCK = "still_stuck"
    DIFFERENT_ERROR = "different_error"


class HintKind(StrEnum):
    """Which button the developer pressed."""

    NORMAL = "normal"
    STRONGER = "stronger"
    STUCK = "stuck"


class SessionStatus(StrEnum):
    ACTIVE = "active"
    COMPLETED = "completed"
    ABANDONED = "abandoned"


class Verdict(StrEnum):
    """What one leakage check concluded about a candidate hint."""

    CLEAN = "clean"
    LEAK = "leak"
    NOT_RUN = "not_run"


class ReasoningProgress(StrEnum):
    """Where the developer's latest reasoning has moved, judged by the analysis."""

    CLOSER = "closer"
    UNCHANGED = "unchanged"
    OFF_TRACK = "off_track"


class HintSource(StrEnum):
    """Where the hint the developer finally received came from."""

    GENERATED = "generated"
    REWRITTEN = "rewritten"
    FALLBACK = "fallback"


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class CodeContext:
    """A piece of code the developer chose to share, mirroring the extension."""

    label: str
    language_id: str
    source: str
    start_line: int
    end_line: int
    code: str
    truncated: bool


@dataclass(frozen=True, repr=False)
class Diagnosis:
    """What Socrates' Duck privately believes is wrong."""

    root_cause: str
    key_inference: str
    suspicious_region: str
    faulty_assumption: str
    reasoning_assessment: str
    reasoning_progress: ReasoningProgress
    attempts_seen: int
    bug_found: bool = True

    def __repr__(self) -> str:
        return "Diagnosis(<private>)"


@dataclass(frozen=True, repr=False)
class LeakageRecord:
    """What the leakage checks did for one delivered hint."""

    deterministic: Verdict
    judge: Verdict
    rewrites: int
    source: HintSource
    rule: str | None = None
    reason: str | None = None

    @property
    def blocked(self) -> bool:
        """Whether any candidate was refused before this hint was delivered."""
        return (
            self.rewrites > 0
            or self.deterministic is Verdict.LEAK
            or self.judge is Verdict.LEAK
            or self.source is HintSource.FALLBACK
        )

    def __repr__(self) -> str:
        return (
            f"LeakageRecord(deterministic={self.deterministic.value}, "
            f"judge={self.judge.value}, rewrites={self.rewrites}, "
            f"source={self.source.value}, reason=<private>)"
        )


@dataclass(frozen=True)
class Hint:
    """One rung of the ladder, as delivered."""

    level: int
    kind: HintKind
    next_action: str
    attempts_seen: int
    question: str | None = None
    concept: str | None = None
    evidence: str | None = None
    leakage: LeakageRecord | None = None
    repeat_retries: int = 0
    created_at: datetime = field(default_factory=_now)


@dataclass(frozen=True)
class Clarification:
    """A question the developer asked about one hint, and the answer."""

    about_hint: int
    question: str
    answer: str
    next_action: str
    level: int
    leakage: LeakageRecord | None = None
    created_at: datetime = field(default_factory=_now)


@dataclass(frozen=True)
class Attempt:
    """What the developer tried, and what happened when they reran it."""

    reasoning: str
    evidence: str | None = None
    outcome: Outcome | None = None
    code_refreshed: bool = False
    created_at: datetime = field(default_factory=_now)


@dataclass
class Session:
    problem: str
    reasoning: str | None
    code_contexts: tuple[CodeContext, ...]
    evidence: str | None = None
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    status: SessionStatus = SessionStatus.ACTIVE
    final_outcome: Outcome | None = None
    hints: list[Hint] = field(default_factory=list)
    attempts: list[Attempt] = field(default_factory=list)
    clarifications: list[Clarification] = field(default_factory=list)
    diagnosis: Diagnosis | None = None
    created_at: datetime = field(default_factory=_now)

    @property
    def is_active(self) -> bool:
        return self.status is SessionStatus.ACTIVE

    @property
    def attempts_since_last_hint(self) -> list[Attempt]:
        """What the developer reported after the most recent hint."""
        if not self.hints:
            return list(self.attempts)

        return self.attempts[self.hints[-1].attempts_seen :]

    @property
    def highest_hint_level(self) -> int:
        """0 before any hint, so the first hint lands on level 1."""
        return max((hint.level for hint in self.hints), default=0)

    @property
    def stuck_requests(self) -> int:
        return sum(1 for hint in self.hints if hint.kind is HintKind.STUCK)

    @property
    def different_error_reports(self) -> int:
        return sum(
            1 for attempt in self.attempts if attempt.outcome is Outcome.DIFFERENT_ERROR
        )

    @property
    def leakage_blocks(self) -> int:
        """Hints where a candidate was refused by either leakage layer."""
        return sum(
            1 for hint in self.hints if hint.leakage is not None and hint.leakage.blocked
        )

    @property
    def leakage_rewrites(self) -> int:
        return sum(
            hint.leakage.rewrites for hint in self.hints if hint.leakage is not None
        )

    @property
    def fallback_hints(self) -> int:
        """Hints that ended as the safe fallback because nothing safe was produced."""
        return sum(
            1
            for hint in self.hints
            if hint.leakage is not None and hint.leakage.source is HintSource.FALLBACK
        )

    def record_hint(self, hint: Hint) -> None:
        self.hints.append(hint)

    def record_attempt(self, attempt: Attempt) -> None:
        self.attempts.append(attempt)

    def record_clarification(self, clarification: Clarification) -> None:
        self.clarifications.append(clarification)

    def finish(self, status: SessionStatus, outcome: Outcome | None = None) -> None:
        self.status = status
        self.final_outcome = outcome
