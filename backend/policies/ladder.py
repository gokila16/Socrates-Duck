"""The fixed eight-rung hint ladder, and the rule for choosing a rung."""

from dataclasses import dataclass

from domain.models import (
    MAX_HINT_LEVEL,
    MIN_HINT_LEVEL,
    HintKind,
    Outcome,
    ReasoningProgress,
    Session,
)


@dataclass(frozen=True)
class Rung:
    level: int
    name: str
    purpose: str
    limit: str


LADDER: tuple[Rung, ...] = (
    Rung(
        level=1,
        name="Diagnostic question",
        purpose=(
            "Ask one question that makes the developer look at something they "
            "have not examined yet: a value, a branch, an input, or the gap "
            "between what they expect and what happens. Put it in `question`."
        ),
        limit=(
            "Do not name the cause, the faulty line, or the concept involved. "
            "The question must be answerable by reading or running their own code."
        ),
    ),
    Rung(
        level=2,
        name="Conceptual reminder",
        purpose=(
            "Remind the developer of the language rule, library behaviour, or "
            "general idea that governs this situation. Put it in `concept`."
        ),
        limit=(
            "State the concept in general terms. Do not apply it to their code "
            "or say which line breaks it."
        ),
    ),
    Rung(
        level=3,
        name="Relevant evidence",
        purpose=(
            "Point at one specific detail in the error, traceback, or observed "
            "behaviour they supplied, and say what that detail tells you. Put "
            "the detail in `evidence`. If they supplied no error, use the "
            "behaviour described in their problem."
        ),
        limit="Interpret the evidence. Do not leap from it to the cause.",
    ),
    Rung(
        level=4,
        name="Suspicious code region",
        purpose=(
            "Name the function, block, or line range where the problem lives, "
            "and why it deserves a closer look."
        ),
        limit="Say where to look, not what is wrong there.",
    ),
    Rung(
        level=5,
        name="Incorrect assumption to reconsider",
        purpose=(
            "Name the assumption — the developer's, or one built into the code "
            "— that does not hold, framed as something to test, not a verdict."
        ),
        limit="Do not say what should replace the assumption or how to change the code.",
    ),
    Rung(
        level=6,
        name="Smaller debugging subproblem",
        purpose=(
            "Give the developer a smaller, self-contained experiment that "
            "isolates the problem, such as calling one function with one "
            "specific input and observing the result."
        ),
        limit=(
            "The experiment exposes the behaviour. The developer still draws "
            "the conclusion and writes the fix."
        ),
    ),
    Rung(
        level=7,
        name="Analogy or simplified example",
        purpose=(
            "Show the same mechanism through an analogy, or a small example "
            "from a different context than their code."
        ),
        limit=(
            "The example must not be their code with the names changed, and "
            "must not contain their fix."
        ),
    ),
    Rung(
        level=8,
        name="Partial pseudocode",
        purpose=(
            "Sketch the shape of a correct approach as pseudocode, with the "
            "decisive step left as a clearly marked gap for the developer."
        ),
        limit=(
            "Pseudocode, not runnable code, and the decisive step stays blank. "
            "This is the top of the ladder: it never becomes a complete answer."
        ),
    ),
)


def rung(level: int) -> Rung:
    """The rung for a level."""
    if not MIN_HINT_LEVEL <= level <= MAX_HINT_LEVEL:
        raise ValueError(f"There is no rung {level} on the ladder.")

    return LADDER[level - MIN_HINT_LEVEL]


_CLIMB = {
    HintKind.NORMAL: 0,
    HintKind.STRONGER: 1,
}

STUCK_LEVEL = 6


NO_BUG_CEILING = 3


def select_level(
    session: Session,
    kind: HintKind,
    progress: ReasoningProgress | None,
    bug_found: bool = True,
) -> int:
    """Chooses the rung for the next hint."""
    current = 0 if ladder_restarted(session) else _last_level(session)
    ceiling = MAX_HINT_LEVEL if bug_found else NO_BUG_CEILING

    if kind is HintKind.STUCK:
        target = STUCK_LEVEL if current < STUCK_LEVEL else MAX_HINT_LEVEL

        return min(target, ceiling)

    climb = _CLIMB[kind]

    if kind is HintKind.NORMAL and current == 0:
        climb = 1
    elif kind is HintKind.NORMAL and _reported_still_stuck(session):
        climb = 0 if _holds_position(session, progress) else 1

    return min(max(current + climb, MIN_HINT_LEVEL), ceiling)


def _holds_position(session: Session, progress: ReasoningProgress | None) -> bool:
    """Whether to stay on this rung although the developer is still stuck."""
    return progress is ReasoningProgress.CLOSER and not _already_held(session)


def _already_held(session: Session) -> bool:
    """Whether the last hint stayed on its rung after a still_stuck report."""
    if len(session.hints) < 2:
        return False

    last, previous = session.hints[-1], session.hints[-2]

    if last.level != previous.level:
        return False

    between = session.attempts[previous.attempts_seen : last.attempts_seen]

    return any(attempt.outcome is Outcome.STILL_STUCK for attempt in between)


def ladder_restarted(session: Session) -> bool:
    """Whether the developer reported a different error since the last hint."""
    return bool(session.hints) and any(
        attempt.outcome is Outcome.DIFFERENT_ERROR
        for attempt in session.attempts_since_last_hint
    )


def _last_level(session: Session) -> int:
    return session.hints[-1].level if session.hints else 0


def _reported_still_stuck(session: Session) -> bool:
    return any(
        attempt.outcome is Outcome.STILL_STUCK
        for attempt in session.attempts_since_last_hint
    )
