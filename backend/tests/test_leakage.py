"""The deterministic hard-block rules."""

import pytest

from domain.models import Hint, HintKind
from policies.leakage import hard_block


def _hint(
    next_action: str = "Print the list just before the call.",
    question: str | None = None,
    concept: str | None = None,
    evidence: str | None = None,
) -> Hint:
    return Hint(
        level=8,
        kind=HintKind.NORMAL,
        next_action=next_action,
        attempts_seen=0,
        question=question,
        concept=concept,
        evidence=evidence,
    )


def test_a_unified_diff_is_blocked() -> None:
    blocked = hard_block(
        _hint(
            next_action=(
                "Apply this:\n"
                "--- a/stats.py\n"
                "+++ b/stats.py\n"
                "-    return sum(values) / len(values)\n"
                "+    return sum(values) / len(values) if values else 0\n"
            )
        )
    )

    assert blocked is not None
    assert blocked.rule == "unified_diff"


def test_a_hunk_header_alone_is_blocked() -> None:
    blocked = hard_block(_hint(next_action="@@ -1,4 +1,6 @@\n some context"))

    assert blocked is not None
    assert blocked.rule == "unified_diff"


def test_a_complete_replacement_function_is_blocked() -> None:
    blocked = hard_block(
        _hint(
            next_action=(
                "```python\n"
                "def average(values):\n"
                "    if not values:\n"
                "        return 0\n"
                "    return sum(values) / len(values)\n"
                "```"
            )
        )
    )

    assert blocked is not None
    assert blocked.rule == "complete_definition"


def test_a_replacement_function_sent_without_a_fence_is_blocked() -> None:
    blocked = hard_block(
        _hint(
            next_action="def average(values):\n    return sum(values) / max(len(values), 1)"
        )
    )

    assert blocked is not None
    assert blocked.rule == "complete_definition"


def test_a_complete_class_is_blocked() -> None:
    blocked = hard_block(
        _hint(next_action="class Stats:\n    def mean(self, values):\n        return 1")
    )

    assert blocked is not None
    assert blocked.rule == "complete_definition"


@pytest.mark.parametrize(
    "text",
    [
        "Here is the fixed code for your function.",
        "Here's the corrected version of average().",
        "Here is the fix: guard the empty case.",
        "Copy and paste this into stats.py.",
        "Just paste the following in place of line 5.",
        "Replace it with this and rerun.",
        "Replace line 5 with the following.",
        "The corrected version is shorter than yours.",
    ],
)
def test_copy_and_paste_solution_language_is_blocked(text: str) -> None:
    blocked = hard_block(_hint(next_action=text))

    assert blocked is not None, text
    assert blocked.rule == "solution_language"


def test_any_field_is_checked_not_just_the_next_action() -> None:
    blocked = hard_block(_hint(concept="Here is the fixed code you need."))

    assert blocked is not None


def test_partial_pseudocode_is_allowed() -> None:
    """Rung 8 is partial pseudocode: the rules must not make that rung useless."""
    assert (
        hard_block(
            _hint(
                next_action=(
                    "Sketch:\n"
                    "```\n"
                    "def average(values):\n"
                    "    if <the case you have not handled>:\n"
                    "        <what should happen here?>\n"
                    "    otherwise: divide as you do now\n"
                    "```"
                )
            )
        )
        is None
    )


def test_a_signature_with_no_body_is_allowed() -> None:
    assert (
        hard_block(_hint(next_action="Look at `def average(values): ...` again.")) is None
    )


@pytest.mark.parametrize(
    "body",
    [
        "def average(values):\n    ...",
        "def average(values):\n    pass",
        'def average(values):\n    """Return the mean of values."""',
    ],
)
def test_a_parseable_definition_with_an_empty_body_is_allowed(body: str) -> None:
    """The rule is about a body that does something, not the word `def`."""
    assert hard_block(_hint(next_action=f"```python\n{body}\n```")) is None


@pytest.mark.parametrize(
    "text",
    [
        "The fix is not in average() itself — look at what reaches it.",
        "The problem is not where the traceback points.",
        "Replace your assumption with a test: what does len([]) return?",
        "Compare the fixed output with what you expected.",
        "Which line would you change first, and why?",
        "Print `scores` for each student before the call.",
    ],
)
def test_ordinary_hints_are_not_blocked(text: str) -> None:
    """Near misses for the phrase rules."""
    assert hard_block(_hint(next_action=text)) is None, text


def test_a_plain_question_is_not_blocked() -> None:
    assert (
        hard_block(
            _hint(
                question="What does len([]) return?",
                concept="Dividing by zero raises ZeroDivisionError.",
                evidence="The traceback names line 5 of stats.py.",
            )
        )
        is None
    )
