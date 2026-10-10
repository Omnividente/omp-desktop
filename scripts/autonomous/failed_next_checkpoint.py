#!/usr/bin/env python3
"""Eligibility proof for one immutable failed automatic NEXT producer, not a retry."""
from __future__ import annotations

from next_no_effect_artifact import FAILED_AUTOMATIC_NEXT_PRODUCER as SUPPORTED_PRODUCER
FAILURE_KIND = "automatic_next_failed_before_external_mutation"


def automatic_inputs(inputs):
    from dispatch_journal import NEXT, normalize_inputs
    return inputs == normalize_inputs(NEXT, {"automatic": True})


def mutation_candidates(manifest, inputs):
    """Mirror the supported producer's pre-planner paths and initial selection.

    lab_controller.py:656-734 polls *all* matching stored identities, including
    detached workers and reserved/unbound dispatch with allow_create=False.
    Both nudge branches, harvest/repair and rejection are downstream of collect;
    excluding its entire entry set excludes those paths without guessing a remote
    session state. An unrelated parked invalid report is not a polling candidate.
    Pending repair expiry precedes disposition filtering, so it is excluded first.
    Release-ref runs after collect and before planner. An already selected task
    can reach ensure_attempt without a newly created planner task; exclude it.
    Newly planned tasks instead require an acknowledged durable checkpoint before
    ensure_attempt, and reservation before CreateSession. Together with exact
    parent/body/journal conservation this excludes reaching either external path,
    including a committed checkpoint whose push acknowledgement was lost.
    """
    from research_disposition import disposition_state
    from select_task import pending_report_repair, select
    from task_lifecycle import awaiting_report, awaiting_review

    candidates = []
    for task in manifest["tasks"]:
        execution = task.get("execution") or {}
        pending = pending_report_repair(task)
        if awaiting_review(task):
            candidates.append((task["id"], "review"))
            continue
        if pending:
            candidates.append((task["id"], "pending_report_repair"))
        disposition = disposition_state(task)
        disposition_allows_poll = (not disposition or (
            disposition == "recover_authorized" and pending
            and task["research_disposition"]["events"][-1].get("mode") == "repair"))
        if disposition_allows_poll and (task.get("status") == "in_progress"
                                       or execution.get("state") == "quarantined" or pending):
            candidates.append((task["id"], "poll_or_reserved_dispatch"))
        branch = execution.get("starting_branch")
        if (not awaiting_report(task) and branch
                and execution.get("session_state") in ("COMPLETED", "FAILED")
                and execution.get("released_attempt_ref") != branch):
            candidates.append((task["id"], "release_attempt_ref"))
    # autonomous-project.json:110-111 at SUPPORTED_PRODUCER enables research.
    # Current owner configuration must not disable a historical candidate.
    selection = select(manifest, task_id=inputs["task_id"] or None,
                       focus=inputs["focus"].split(",") if inputs["focus"] else [],
                       risk_ceiling=inputs["risk_ceiling"],
                       allow_discovery=True)
    if selection["selected"]:
        candidates.append((selection["task_id"], "selected_existing_task"))
    return candidates
