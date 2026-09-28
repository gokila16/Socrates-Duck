"""The deterministic repeated-action check."""

import pytest

from domain.models import Hint, HintKind
from policies.repetition import repeats_earlier_action

LEVEL_1_CALL_VALIDATORS = (
    "After validators = make_validators(LIMITS), add prints that call and show "
    "the result of validators['width'](10), validators['height'](20), and "
    "validators['depth'](5); run the script and note the three outputs."
)
LEVEL_6_CALL_VALIDATORS = (
    "After validators = make_validators(LIMITS), add and run prints that call "
    "validators['width'](10), validators['height'](20), and "
    "validators['depth'](5) (for example print(\"width(10):\", "
    "validators['width'](10)) etc.) and note the three outputs."
)

LEVEL_1_PRINT_CLOSURE = (
    "After validators = make_validators(LIMITS), add code to print each "
    "validator's __closure__ and the cell_contents (e.g. iterate "
    "validators.items() and for each function print the list of c.cell_contents "
    "for c in (fn.__closure__ or [])); run the script and note the values "
    "shown for each field's closure."
)
LEVEL_3_PRINT_CLOSURE = (
    "After validators = make_validators(LIMITS), print each validator's "
    "__closure__ cell_contents (e.g. iterate validators.items() and for each "
    "function print([c.cell_contents for c in (fn.__closure__ or [])])); run "
    "the script and paste the printed closure values."
)

LEVEL_2_READ_DOCS = (
    "Read the CPython docs section on function definitions / default argument "
    "values, then in a small REPL experiment create several functions (or "
    "lambdas) inside a loop where each function uses a default parameter "
    "expression that references the loop variable; create and later call those "
    "functions and note whether the defaults hold the value from the iteration "
    "in which the function was created."
)


def _hint(level: int, next_action: str) -> Hint:
    return Hint(
        level=level,
        kind=HintKind.NORMAL,
        next_action=next_action,
        attempts_seen=0,
    )


def test_an_identical_action_is_caught() -> None:
    earlier = _hint(1, LEVEL_1_CALL_VALIDATORS)

    assert repeats_earlier_action(_hint(4, LEVEL_1_CALL_VALIDATORS), [earlier]) == 1


@pytest.mark.parametrize(
    ("earlier", "later"),
    [
        (LEVEL_1_CALL_VALIDATORS, LEVEL_6_CALL_VALIDATORS),
        (LEVEL_1_PRINT_CLOSURE, LEVEL_3_PRINT_CLOSURE),
    ],
)
def test_the_repeats_the_real_run_produced_are_caught(earlier: str, later: str) -> None:
    """Reworded, not rewritten: the developer would run the same thing twice."""
    assert repeats_earlier_action(_hint(6, later), [_hint(1, earlier)]) == 1


def test_different_work_on_the_same_bug_is_left_alone() -> None:
    """The anti-stonewalling half: rejecting this would cost a good hint."""
    previous = [_hint(1, LEVEL_1_CALL_VALIDATORS), _hint(2, LEVEL_2_READ_DOCS)]

    assert repeats_earlier_action(_hint(3, LEVEL_3_PRINT_CLOSURE), previous) is None


def test_inspecting_a_closure_is_not_the_same_work_as_calling_a_validator() -> None:
    previous = [_hint(1, LEVEL_1_CALL_VALIDATORS)]

    assert repeats_earlier_action(_hint(2, LEVEL_1_PRINT_CLOSURE), previous) is None


def test_the_first_hint_of_a_session_can_repeat_nothing() -> None:
    assert repeats_earlier_action(_hint(1, LEVEL_1_CALL_VALIDATORS), []) is None


def test_the_most_recent_repeat_is_the_one_reported() -> None:
    """The retry is told which hint to differ from, so it must be the latest."""
    previous = [
        _hint(1, LEVEL_1_CALL_VALIDATORS),
        _hint(2, LEVEL_2_READ_DOCS),
        _hint(3, LEVEL_1_CALL_VALIDATORS),
    ]

    assert repeats_earlier_action(_hint(4, LEVEL_6_CALL_VALIDATORS), previous) == 3


def test_wording_alone_does_not_make_an_action_different() -> None:
    """Word order is not the signal; the vocabulary of the work is."""
    earlier = _hint(1, "Print the value of limit inside the loop, then run it.")
    later = _hint(2, "Run it, then print inside the loop the value of limit.")

    assert repeats_earlier_action(later, [earlier]) == 1
