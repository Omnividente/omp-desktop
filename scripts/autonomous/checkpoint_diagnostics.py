#!/usr/bin/env python3
"""Bounded causal checkpoint metadata; never serialize exception text or commands."""
from __future__ import annotations

import re
import subprocess

CHECKPOINT_STAGES = frozenset({
    "unknown", "finish", "reconcile", "quarantine_disabled", "record_error",
    "feedback_intent", "feedback_result", "research_detach", "report_repair_intent",
    "report_repair_disabled", "report_repair_result", "rejection_closed",
    "rejection_stop_intent", "rejection_result", "collect", "review_sweep",
    "report_repair_expired", "existing_session_binding", "attempt_ref_release",
    "research_planner", "dispatch_reservation", "quarantine_before_create",
    "quarantine_create_guard", "created_session_binding", "quarantine_during_create",
    "owner_quarantine", "owner_recovery_queue", "owner_recovery_claim",
})
EXCEPTION_CATEGORIES = frozenset({
    "state_write", "state_conflict", "state_uncertain", "journal_conflict",
    "journal_uncertain", "validation", "os_error", "timeout", "subprocess",
    "runtime", "unknown",
})
GIT_OPERATIONS = frozenset({
    "unknown", "ls-remote", "cat-file", "fetch", "show", "hash-object", "mktree",
    "commit-tree", "push",
})
MAX_DIAGNOSTIC_BYTES = 4096
MAX_CAUSAL_DEPTH = 8
SHA = re.compile(r"[0-9a-f]{40}\Z")
_FIELDS = frozenset({
    "version", "checkpoint_stage", "exception_category", "causal_chain",
    "git_operation", "git_returncode", "git_timeout", "expected_state_sha",
    "observed_state_sha", "acknowledgement_uncertain",
})


class StateWriteError(Exception):
    """Stop all external effects when the queue could not be durably saved."""

    def __init__(self, message, *, stage="unknown"):
        super().__init__(message)
        self.checkpoint_stage = stage if type(stage) is str and stage in CHECKPOINT_STAGES else "unknown"


def _sha(value):
    return value is None or (type(value) is str and (value == "" or SHA.fullmatch(value) is not None))


def normalized_returncode(value):
    return value if type(value) is int and -255 <= value <= 255 else None


def validate_diagnostics(value) -> bool:
    """Validate the exact optional ZIP member independently of the old report."""
    if type(value) is not dict or set(value) != _FIELDS:
        return False
    if type(value["version"]) is not int or value["version"] != 1:
        return False
    for field, choices in (("checkpoint_stage", CHECKPOINT_STAGES),
                           ("exception_category", EXCEPTION_CATEGORIES),
                           ("git_operation", GIT_OPERATIONS)):
        if type(value[field]) is not str or value[field] not in choices:
            return False
    chain = value["causal_chain"]
    if (type(chain) is not list or not 1 <= len(chain) <= MAX_CAUSAL_DEPTH
            or any(type(item) is not str or item not in EXCEPTION_CATEGORIES for item in chain)
            or chain[0] != value["exception_category"]):
        return False
    code = value["git_returncode"]
    if code is not None and normalized_returncode(code) is None:
        return False
    for field in ("git_timeout", "acknowledgement_uncertain"):
        if value[field] is not None and type(value[field]) is not bool:
            return False
    return _sha(value["expected_state_sha"]) and _sha(value["observed_state_sha"])


def _category(exc):
    # Import lazily: the state store also attaches these safe metadata fields.
    from state_store import StateConflict, StateUncertain
    from dispatch_journal import JournalConflict, JournalUncertain
    for kind, category in (
        (StateWriteError, "state_write"), (StateUncertain, "state_uncertain"),
        (StateConflict, "state_conflict"), (JournalUncertain, "journal_uncertain"),
        (JournalConflict, "journal_conflict"), (subprocess.TimeoutExpired, "timeout"),
        (subprocess.SubprocessError, "subprocess"), (ValueError, "validation"),
        (OSError, "os_error"), (RuntimeError, "runtime"),
    ):
        if isinstance(exc, kind):
            return category
    return "unknown"


def diagnostic_for_failure(stage: str, exc: BaseException) -> dict:
    """Only allowlisted typed facts may cross the diagnostic artifact boundary."""
    result = {
        "version": 1,
        "checkpoint_stage": stage if type(stage) is str and stage in CHECKPOINT_STAGES else "unknown",
        "exception_category": _category(exc), "causal_chain": [],
        "git_operation": "unknown", "git_returncode": None, "git_timeout": None,
        "expected_state_sha": None, "observed_state_sha": None,
        "acknowledgement_uncertain": None,
    }
    current, seen = exc, set()
    while current is not None and id(current) not in seen and len(seen) < MAX_CAUSAL_DEPTH:
        seen.add(id(current))
        result["causal_chain"].append(_category(current))
        metadata = getattr(current, "checkpoint_metadata", None)
        if type(metadata) is dict:
            operation = metadata.get("git_operation")
            if result["git_operation"] == "unknown" and type(operation) is str and operation in GIT_OPERATIONS:
                result["git_operation"] = operation
            for field in ("git_returncode", "git_timeout", "expected_state_sha",
                          "observed_state_sha", "acknowledgement_uncertain"):
                value = metadata.get(field)
                valid = (_sha(value) if field.endswith("_sha") else
                         (value is None or type(value) is bool) if field != "git_returncode" else
                         (value is None or normalized_returncode(value) is not None))
                if result[field] is None and valid:
                    result[field] = value
        current = current.__cause__ if current.__cause__ is not None else (
            None if current.__suppress_context__ else current.__context__)
    return result
