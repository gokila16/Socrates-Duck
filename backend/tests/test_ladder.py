"""The hint ladder's policy: which rung the next hint lands on."""

import itertools

import pytest

from domain.models import (
    MAX_HINT_LEVEL,
    MIN_HINT_LEVEL,
    Attempt,
    CodeContext,
    Hint,
    HintKind,
    Outcome,
    ReasoningProgress,
    Session,
)
from policies.ladder import (
    LADDER,
    NO_BUG_CEILING,
    STUCK_LEVEL,
    ladder_restarted,
    rung,
    select_level,
)

NORMAL, STRONGER, STUCK = HintKind.NORMAL, HintKind.STRONGER, HintKind.STUCK


def _session() -> Session:
    return Session(
        problem="It crashes.",
        reasoning="I think average() is broken.",
        code_contexts=(
            CodeContext(
                label="stats.py",
                language_id="python",
                source="file",
                start_line=1,
                end_line=2,
                code="def average(values):\n    return sum(values) / len(values)",
                truncated=False,
            ),
        ),
    )


def _give(session: Session, level: int, kind: HintKind = NORMAL) -> None:
    """Records a hint the way the workflow does, stamped with the attempt count."""
    session.record_hint(
        Hint(
            level=level,
            kind=kind,
            next_action="Look.",
            attempts_seen=len(session.attempts),
        )
    )


def _report(session: Session, outcome: Outcome | None) -> None:
    session.record_attempt(Attempt(reasoning="I tried again.", outcome=outcome))


def test_the_ladder_has_eight_rungs_in_order() -> None:
    assert [(r.level, r.name) for r in LADDER] == [
        (1, "Diagnostic question"),
        (2, "Conceptual reminder"),
        (3, "Relevant evidence"),
        (4, "Suspicious code region"),
        (5, "Incorrect assumption to reconsider"),
        (6, "Smaller debugging subproblem"),
        (7, "Analogy or simplified example"),
        (8, "Partial pseudocode"),
    ]


def test_every_rung_says_what_it_does_and_where_it_stops() -> None:
    for step in LADDER:
        assert step.purpose.strip() != "", step.name
        assert step.limit.strip() != "", step.name


@pytest.mark.parametrize("level", [0, -1, MAX_HINT_LEVEL + 1])
def test_a_level_off_the_ladder_is_refused(level: int) -> None:
    with pytest.raises(ValueError):
        rung(level)


@pytest.mark.parametrize(
    ("kind", "expected"),
    [(NORMAL, 1), (STRONGER, 1), (STUCK, STUCK_LEVEL)],
)
def test_first_hint(kind: HintKind, expected: int) -> None:
    assert select_level(_session(), kind, None) == expected


def test_get_hint_stays_on_the_current_rung() -> None:
    session = _session()
    _give(session, 3)

    assert select_level(session, NORMAL, None) == 3


def test_get_hint_climbs_one_after_the_developer_reports_still_stuck() -> None:
    session = _session()
    _give(session, 3)
    _report(session, Outcome.STILL_STUCK)

    assert select_level(session, NORMAL, None) == 4


def test_a_still_stuck_report_from_before_the_last_hint_does_not_count() -> None:
    session = _session()
    _give(session, 2)
    _report(session, Outcome.STILL_STUCK)
    _give(session, 3)

    assert select_level(session, NORMAL, None) == 3


@pytest.mark.parametrize("outcome", [None, Outcome.RESOLVED])
def test_other_reports_do_not_make_get_hint_climb(outcome: Outcome | None) -> None:
    session = _session()
    _give(session, 3)
    _report(session, outcome)

    assert select_level(session, NORMAL, None) == 3


@pytest.mark.parametrize(("kind", "expected"), [(STRONGER, 4), (STUCK, STUCK_LEVEL)])
def test_explicit_requests_climb(kind: HintKind, expected: int) -> None:
    session = _session()
    _give(session, 3)

    assert select_level(session, kind, None) == expected


@pytest.mark.parametrize(("start", "expected"), [(1, 6), (5, 6), (6, 8), (7, 8)])
def test_i_feel_stuck_gives_as_close_a_hint_as_the_ladder_allows(
    start: int, expected: int
) -> None:
    session = _session()
    _give(session, start)

    assert select_level(session, STUCK, None) == expected


@pytest.mark.parametrize(
    ("kind", "expected"),
    [(NORMAL, 1), (STRONGER, 1), (STUCK, STUCK_LEVEL)],
)
def test_a_different_error_restarts_the_ladder(kind: HintKind, expected: int) -> None:
    session = _session()
    _give(session, 6)
    _report(session, Outcome.DIFFERENT_ERROR)

    assert ladder_restarted(session)
    assert select_level(session, kind, None) == expected


def test_a_different_error_outweighs_still_stuck_in_the_same_interval() -> None:
    session = _session()
    _give(session, 6)
    _report(session, Outcome.STILL_STUCK)
    _report(session, Outcome.DIFFERENT_ERROR)

    assert select_level(session, NORMAL, None) == 1


def test_the_ladder_climbs_normally_again_after_a_restart() -> None:
    session = _session()
    _give(session, 6)
    _report(session, Outcome.DIFFERENT_ERROR)
    _give(session, 1)

    assert not ladder_restarted(session)
    assert select_level(session, STRONGER, None) == 2


def test_a_different_error_before_any_hint_is_not_a_restart() -> None:
    session = _session()
    _report(session, Outcome.DIFFERENT_ERROR)

    assert not ladder_restarted(session)
    assert select_level(session, NORMAL, None) == 1


@pytest.mark.parametrize(
    ("start", "kind", "report"),
    [
        (7, STUCK, None),
        (8, STRONGER, None),
        (8, STUCK, None),
        (8, NORMAL, Outcome.STILL_STUCK),
    ],
)
def test_no_request_goes_past_level_8(
    start: int, kind: HintKind, report: Outcome | None
) -> None:
    session = _session()
    _give(session, start)

    if report is not None:
        _report(session, report)

    assert select_level(session, kind, None) == MAX_HINT_LEVEL


_ACTIONS: list[HintKind | Outcome] = [NORMAL, STRONGER, STUCK, *Outcome]


@pytest.mark.parametrize(
    "progress", [None, ReasoningProgress.CLOSER, ReasoningProgress.UNCHANGED]
)
def test_invariants_hold_for_every_sequence_of_five_actions(
    progress: ReasoningProgress | None,
) -> None:
    """Every sequence of five presses and reports: 6**5 = 7,776 histories."""
    for history in itertools.product(_ACTIONS, repeat=5):
        session = _session()
        restarted = False

        for action in history:
            if isinstance(action, Outcome):
                _report(session, action)
                restarted = restarted or action is Outcome.DIFFERENT_ERROR
                continue

            level = select_level(session, action, progress)
            previous = session.hints[-1].level if session.hints else 0

            assert MIN_HINT_LEVEL <= level <= MAX_HINT_LEVEL, history

            if action is STUCK:
                assert level in (STUCK_LEVEL, MAX_HINT_LEVEL), history
            else:
                assert level - previous <= 1, history

            assert level >= previous or restarted, history

            _give(session, level, action)
            restarted = False


CLOSER = ReasoningProgress.CLOSER
UNCHANGED = ReasoningProgress.UNCHANGED
OFF_TRACK = ReasoningProgress.OFF_TRACK


def test_reasoning_that_is_closing_in_holds_the_rung() -> None:
    """The developer is working it out; climbing would do it for them."""
    session = _session()
    _give(session, 3)
    _report(session, Outcome.STILL_STUCK)

    assert select_level(session, NORMAL, CLOSER) == 3


@pytest.mark.parametrize("progress", [UNCHANGED, OFF_TRACK, None])
def test_reasoning_that_is_not_moving_climbs_as_before(
    progress: ReasoningProgress | None,
) -> None:
    session = _session()
    _give(session, 3)
    _report(session, Outcome.STILL_STUCK)

    assert select_level(session, NORMAL, progress) == 4


def test_the_rung_is_held_only_once_before_climbing_anyway() -> None:
    """The anti-stonewalling valve."""
    session = _session()
    _give(session, 3)
    _report(session, Outcome.STILL_STUCK)

    held = select_level(session, NORMAL, CLOSER)
    _give(session, held)
    _report(session, Outcome.STILL_STUCK)

    assert held == 3
    assert select_level(session, NORMAL, CLOSER) == 4


def test_asking_for_another_angle_does_not_use_up_the_hold() -> None:
    """Two hints on a rung are not a hold unless a stuck report sat between them."""
    session = _session()
    _give(session, 3)
    _give(session, 3)
    _report(session, Outcome.STILL_STUCK)

    assert select_level(session, NORMAL, CLOSER) == 3


def test_holding_becomes_available_again_on_the_next_rung() -> None:
    session = _session()
    _give(session, 3)
    _report(session, Outcome.STILL_STUCK)
    _give(session, 3)
    _report(session, Outcome.STILL_STUCK)
    _give(session, 4)
    _report(session, Outcome.STILL_STUCK)

    assert select_level(session, NORMAL, CLOSER) == 4


@pytest.mark.parametrize(("kind", "expected"), [(STRONGER, 4), (STUCK, STUCK_LEVEL)])
def test_an_explicit_request_is_never_overridden_by_progress(
    kind: HintKind, expected: int
) -> None:
    session = _session()
    _give(session, 3)
    _report(session, Outcome.STILL_STUCK)

    assert select_level(session, kind, CLOSER) == expected


def test_progress_does_not_change_a_first_hint() -> None:
    assert select_level(_session(), NORMAL, CLOSER) == 1


def test_progress_does_not_resurrect_a_restarted_ladder() -> None:
    session = _session()
    _give(session, 6)
    _report(session, Outcome.DIFFERENT_ERROR)

    assert select_level(session, NORMAL, CLOSER) == 1


def test_progress_alone_does_not_hold_a_rung_that_was_not_climbing() -> None:
    session = _session()
    _give(session, 3)

    assert select_level(session, NORMAL, CLOSER) == 3


def test_a_developer_who_stays_stuck_always_reaches_the_top() -> None:
    """The anti-stonewalling property, as a loop rather than an example."""
    session = _session()

    for _ in range(MAX_HINT_LEVEL * 3):
        _report(session, Outcome.STILL_STUCK)
        _give(session, select_level(session, NORMAL, ReasoningProgress.CLOSER))

    assert session.hints[-1].level == MAX_HINT_LEVEL


@pytest.mark.parametrize("kind", [NORMAL, STRONGER, STUCK])
def test_with_no_bug_found_hints_never_point_at_code(kind: HintKind) -> None:
    session = _session()
    _give(session, 3)

    assert select_level(session, kind, None, bug_found=False) == NO_BUG_CEILING


def test_a_high_rung_comes_back_down_when_no_bug_is_found_any_more() -> None:
    session = _session()
    _give(session, 6)
    _report(session, Outcome.STILL_STUCK)

    assert select_level(session, NORMAL, None, bug_found=False) == NO_BUG_CEILING


def test_with_no_bug_found_the_lower_rungs_work_as_usual() -> None:
    session = _session()

    assert select_level(session, NORMAL, None, bug_found=False) == 1
    _give(session, 1)
    assert select_level(session, STRONGER, None, bug_found=False) == 2
