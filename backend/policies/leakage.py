"""The deterministic half of answer-leakage protection."""

import ast
import re
from dataclasses import dataclass

from domain.models import Hint

_DIFF = re.compile(r"^(--- .*\n\+\+\+ |@@ -\d+(,\d+)? \+\d+(,\d+)? @@)", re.MULTILINE)

_FENCED = re.compile(r"```[a-zA-Z0-9_+-]*\n(.*?)```", re.DOTALL)

_SOLUTION_LANGUAGE = re.compile(
    r"""
    here(\s+is|'s)\s+(the|your)\s+
        (fixed|corrected|working|updated|complete|full)\s+
        (code|version|function|class|method|implementation|line)
    | here(\s+is|'s)\s+the\s+(fix|solution|answer)\b
    | (copy|paste)\s+(and\s+paste\s+)?(this|these|it|the\s+following)
    | replace\s+(it|that|your\s+\w+|line\s+\d+)\s+with\s+(this|the\s+following)
    | (the\s+)?(corrected|fixed)\s+version\s+(is|of|looks)
    | just\s+(change|replace|use)\s+(it|this|that|line\s+\d+)\s+to
    """,
    re.IGNORECASE | re.VERBOSE,
)


@dataclass(frozen=True)
class HardBlock:
    """Why a candidate was refused."""

    rule: str


def hard_block(hint: Hint) -> HardBlock | None:
    """The first rule a candidate breaks, or None when it breaks none."""
    text = _text_of(hint)

    if _DIFF.search(text):
        return HardBlock("unified_diff")

    if _has_complete_definition(text):
        return HardBlock("complete_definition")

    if _SOLUTION_LANGUAGE.search(text):
        return HardBlock("solution_language")

    return None


def _text_of(hint: Hint) -> str:
    """Every field the developer would read, as one string."""
    return "\n".join(
        part
        for part in (hint.question, hint.concept, hint.evidence, hint.next_action)
        if part is not None
    )


def _has_complete_definition(text: str) -> bool:
    """True when the text contains a runnable function or class definition."""
    blocks = _FENCED.findall(text)

    blocks.append(text)

    return any(_defines_something(block) for block in blocks)


def _defines_something(source: str) -> bool:
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return False

    return any(
        isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
        and _has_real_body(node)
        for node in ast.walk(tree)
    )


def _has_real_body(
    node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef,
) -> bool:
    """A body that is more than a placeholder."""
    for statement in node.body:
        if isinstance(statement, ast.Pass):
            continue

        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant):
            continue

        return True

    return False
