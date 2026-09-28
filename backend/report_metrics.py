"""Prints the local MVP metrics."""

import sys

from persistence.metrics import SqliteMetricsStore, configured_path


def main() -> int:
    path = configured_path()

    if not path.exists():
        print(f"No metrics yet. The backend writes {path} as it runs.")
        return 1

    summary = SqliteMetricsStore(path).summary()

    print(f"file     : {path}\n")

    rows = [
        ("Sessions started", summary.sessions),
        ("  completed", summary.completed),
        ("  abandoned", summary.abandoned),
        ("  self-reported resolved", summary.resolved),
        ("Hints delivered", summary.hints),
        ("  highest level reached", summary.highest_level_reached),
        ("  I Feel Stuck requests", summary.stuck_requests),
        ("different_error reports", summary.different_error_reports),
        ("Leakage blocks", summary.leakage_blocks),
        ("  rewrites", summary.leakage_rewrites),
        ("  safe fallbacks returned", summary.fallbacks),
        ("Questions about hints", summary.questions),
        ("  answers blocked at least once", summary.question_blocks),
        ("  fallback answers returned", summary.question_fallbacks),
    ]

    for label, value in rows:
        print(f"{label:<28} {value:>5}")

    print(f"{'Hint helpfulness feedback':<28} {'—':>5}  (not collected yet)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
