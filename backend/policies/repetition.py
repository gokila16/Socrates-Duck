"""Whether a candidate hint asks for work the developer has already been given."""

import re
from collections.abc import Sequence

from domain.models import Hint

_SAME_ACTION = 0.6

_WORD = re.compile(r"[a-z0-9_]+")


def repeats_earlier_action(candidate: Hint, previous: Sequence[Hint]) -> int | None:
    """The level of the most recent hint whose next action this one repeats."""
    words = _words(candidate.next_action)

    for hint in reversed(previous):
        if _overlap(words, _words(hint.next_action)) >= _SAME_ACTION:
            return hint.level

    return None


def _words(text: str) -> frozenset[str]:
    """The vocabulary of an action, lowercased."""
    return frozenset(_WORD.findall(text.lower()))


def _overlap(one: frozenset[str], other: frozenset[str]) -> float:
    """Jaccard overlap: shared words as a fraction of all words used."""
    if not one or not other:
        return 0.0

    return len(one & other) / len(one | other)
