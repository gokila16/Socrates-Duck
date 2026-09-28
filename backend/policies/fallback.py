"""The predefined safe fallback hint."""

from domain.models import Hint, HintKind

FALLBACK_ANSWER = (
    "That is hard to explain without giving away the part the hint leaves to "
    "you. Try asking about one word or step of the hint instead, or press "
    "Another hint for a different angle."
)
FALLBACK_ANSWER_ACTION = "Reread the hint and pick the one word or step that is unclear."


def safe_fallback_hint(level: int, kind: HintKind, attempts_seen: int) -> Hint:
    return Hint(
        level=level,
        kind=kind,
        attempts_seen=attempts_seen,
        question=(
            "Which part of this code are you least certain about, and what do "
            "you expect it to produce?"
        ),
        next_action=(
            "Print or inspect that value where it is used, then compare it "
            "with what you expected."
        ),
    )


def safe_fallback_answer(level: int, kind: HintKind, attempts_seen: int) -> Hint:
    """The fallback for a question about a hint, in the workflow's Hint shape."""
    return Hint(
        level=level,
        kind=kind,
        attempts_seen=attempts_seen,
        concept=FALLBACK_ANSWER,
        next_action=FALLBACK_ANSWER_ACTION,
    )
