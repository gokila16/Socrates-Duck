"""The canned model the test suite answers with, and the canaries inside it."""

import json

from providers.base import CompletionRequest

DIAGNOSIS_CANARY = "PRIVATE_DIAGNOSIS_CANARY_51c2"

JUDGE_REASON_CANARY = "PRIVATE_JUDGE_REASON_CANARY_7b4e"

CANNED_DIAGNOSIS = {
    "root_cause": f"average() divides by len([]) for alan. {DIAGNOSIS_CANARY}",
    "key_inference": "An empty score list reaches the division.",
    "suspicious_region": "samples/stats.py line 5",
    "faulty_assumption": "Every student has at least one score.",
    "reasoning_assessment": "Right function, wrong reason: it is the input.",
    "reasoning_progress": "unchanged",
}

CANNED_DIAGNOSIS_CLOSER = {**CANNED_DIAGNOSIS, "reasoning_progress": "closer"}

CANNED_QUESTION = "Which student's scores reach average() when it fails?"
CANNED_NEXT_ACTION = "Print each student's scores just before average() is called."

CANNED_HINT = {
    "question": CANNED_QUESTION,
    "concept": None,
    "evidence": None,
    "next_action": CANNED_NEXT_ACTION,
}

CANNED_ANSWER_TEXT = "enumerate(values) gives you each item together with its position."
CANNED_ANSWER_ACTION = (
    "Try list(enumerate(['a', 'b'])) in a Python shell and look at the pairs."
)

CANNED_ANSWER = {"answer": CANNED_ANSWER_TEXT, "next_action": CANNED_ANSWER_ACTION}

CANNED_JUDGE_CLEAN = {"verdict": "clean", "reason": "Asks, does not answer."}

CANNED_JUDGE_LEAK = {
    "verdict": "leak",
    "reason": f"It states the key inference outright. {JUDGE_REASON_CANARY}",
}

DIAGNOSIS = json.dumps(CANNED_DIAGNOSIS)
DIAGNOSIS_CLOSER = json.dumps(CANNED_DIAGNOSIS_CLOSER)
HINT = json.dumps(CANNED_HINT)
ANSWER = json.dumps(CANNED_ANSWER)
JUDGE_CLEAN = json.dumps(CANNED_JUDGE_CLEAN)
JUDGE_LEAK = json.dumps(CANNED_JUDGE_LEAK)


def call_kind(request: CompletionRequest) -> str:
    """Which of the workflow's calls this is, by the system prompt it carries."""
    if request.system.startswith("You are the analysis step"):
        return "analysis"

    if request.system.startswith("You are the answer-leakage judge"):
        return "judge"

    if request.system.startswith("You are answering a question"):
        return "answer"

    return "hint"


def is_analysis(request: CompletionRequest) -> bool:
    return call_kind(request) == "analysis"


def canned_model(request: CompletionRequest) -> str:
    """Answers every call with a fixed, clean reply."""
    return {
        "analysis": DIAGNOSIS,
        "judge": JUDGE_CLEAN,
        "hint": HINT,
        "answer": ANSWER,
    }[call_kind(request)]


def last_request_of(kind: str, requests: list[CompletionRequest]) -> CompletionRequest:
    """The most recent call of one kind, for tests about prompt contents."""
    matching = [request for request in requests if call_kind(request) == kind]
    assert matching, f"no {kind} request was made"

    return matching[-1]
