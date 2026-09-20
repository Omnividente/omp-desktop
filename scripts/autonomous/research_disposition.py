#!/usr/bin/env python3
"""Historical owner acknowledgement, independent of the worker lifecycle."""
from __future__ import annotations

import copy
from datetime import datetime

SETTLED_REPAIRS = {"invalid", "rejected", "expired", "failed"}
BENIGN_FAILURES = {
    "research_invalid", "research_json", "research_shape", "research_schema",
    "tasks_malformed_block", "findings_invalid",
}


def research_incident(task: dict) -> dict:
    """Snapshot saved evidence without interpreting or changing it."""
    execution = task.get("execution")
    execution = execution if isinstance(execution, dict) else {}
    issue = execution.get("report_error")
    issue = issue if isinstance(issue, dict) else {}
    repair = execution.get("report_repair")
    repair = repair if isinstance(repair, dict) else {}
    basis = {field: execution.get(field) for field in ("state", "outcome", "session_state")}
    basis["event_at"] = (issue.get("reported_at") if execution.get("state") == "awaiting_report"
                         else execution.get("finished_at"))
    source = repair.get("source") or issue.get("source")
    if source is not None:
        basis["source"] = source
    for field in ("report_error", "report_repair", "report_repair_history", "last_error"):
        if field in execution:
            basis[field] = execution[field]
    return copy.deepcopy({"attempt": {field: execution.get(field) for field in
                                     ("session_id", "dispatch_key", "attempts")}, "basis": basis})


def _settled(task: dict) -> bool:
    execution = task.get("execution")
    if not isinstance(execution, dict):
        return False
    repair = execution.get("report_repair")
    return (task.get("task_type") == "project_discovery" and task.get("status") == "blocked"
            and "research_result" not in task and not execution.get("pull_request")
            and execution.get("session_state") in ("COMPLETED", "FAILED")
            and (execution.get("state"), execution.get("outcome")) in (
                ("awaiting_report", "report_invalid"), ("exhausted", "failed"))
            and isinstance(execution.get("session_id"), str) and bool(execution["session_id"].strip())
            and isinstance(execution.get("dispatch_key"), str) and bool(execution["dispatch_key"].strip())
            and type(execution.get("attempts")) is int and execution["attempts"] > 0
            and (repair is None or isinstance(repair, dict)
                 and isinstance(repair.get("status"), str) and repair["status"] in SETTLED_REPAIRS))


def validate_research_disposition(task: dict, prefix: str) -> list[str]:
    """Validate the audit history, not whether an old acknowledgement still applies."""
    # validate_tasks calls us; importing helpers lazily avoids an import cycle.
    from validate_tasks import (_nonblank, _utc_timestamp, _validate_report_source,
                                _validate_research, _validate_execution)

    if "research_disposition" not in task:
        return []
    prefix += ".research_disposition"
    block = task["research_disposition"]
    if not isinstance(block, dict) or not isinstance(block.get("events"), list) or not block["events"]:
        return [prefix + " requires a nonempty events list"]
    errors = []
    if task.get("task_type") != "project_discovery":
        errors.append(prefix + " requires project_discovery")
    events = block["events"]
    initial = events[0]
    if not isinstance(initial, dict):
        return errors + [prefix + ".events[0] must be an object"]
    attempt, basis = initial.get("attempt"), initial.get("basis")
    if not isinstance(attempt, dict) or not isinstance(basis, dict):
        return errors + [prefix + ".events[0] requires attempt and basis objects"]
    historical = {"task_type": "project_discovery", "status": "blocked", "execution": {
        **attempt, **{field: basis[field] for field in
                     ("state", "outcome", "session_state", "report_error", "report_repair",
                      "report_repair_history", "last_error")
                     if field in basis}, "finished_at": basis.get("event_at"),
    }}
    if not _settled(historical):
        errors.append(prefix + ".events[0] requires a settled bound unaccepted research incident")
    errors.extend(_validate_research(historical, prefix + ".events[0].basis"))
    errors.extend(_validate_execution(historical["execution"], prefix + ".events[0].basis"))
    if set(attempt) != {"session_id", "dispatch_key", "attempts"}:
        errors.append(prefix + ".events[0].attempt must retain the exact attempt identity")
    if not _utc_timestamp(basis.get("event_at")):
        errors.append(prefix + ".events[0].basis.event_at must be UTC")
    if research_incident(historical) != {"attempt": attempt, "basis": basis}:
        errors.append(prefix + ".events[0].basis must retain its exact incident diagnostics and source")

    def source_errors(source: object, location: str) -> None:
        errors.extend(_validate_report_source(source, location))
        if isinstance(source, dict) and any(source.get(field) != attempt.get(field)
                                            for field in ("session_id", "dispatch_key")):
            errors.append(location + " must belong to the acknowledged attempt")

    if "source" in basis:
        source_errors(basis["source"], prefix + ".events[0].basis.source")
    previous_action = None
    previous_at = basis.get("event_at")
    authorization = None
    transitions = {
        None: {"close_unaccepted"}, "close_unaccepted": {"recover_authorized"},
        "recovery_failed": {"recover_authorized"},
        "recover_authorized": {"report_accepted", "recovery_failed"}, "report_accepted": set(),
    }
    for index, event in enumerate(events):
        location = prefix + ".events[" + str(index) + "]"
        if not isinstance(event, dict):
            errors.append(location + " must be an object")
            continue
        action, at = event.get("action"), event.get("at")
        if not isinstance(action, str) or action not in transitions.get(previous_action, set()):
            errors.append(location + " has an invalid event transition")
        if not _utc_timestamp(at):
            errors.append(location + ".at must be UTC")
        elif _utc_timestamp(previous_at) and datetime.fromisoformat(at.replace("Z", "+00:00")) < datetime.fromisoformat(previous_at.replace("Z", "+00:00")):
            errors.append(location + ".at must not precede the incident or previous event")
        if action in ("close_unaccepted", "recover_authorized") and not _nonblank(event.get("actor")):
            errors.append(location + ".actor requires an owner identity")
        if action == "close_unaccepted" and not _nonblank(event.get("note")):
            errors.append(location + ".note must be nonblank")
        if action == "recover_authorized":
            source_errors(event.get("source"), location + ".source")
            mode = event.get("mode", "reparse")
            if mode not in ("reparse", "repair"):
                errors.append(location + ".mode must be reparse or repair")
            if mode == "repair":
                if not _utc_timestamp(event.get("repair_after")):
                    errors.append(location + ".repair_after must be UTC for explicitly authorized repair")
            elif "repair_after" in event:
                errors.append(location + ".repair_after requires repair mode")
            authorization = event
        if action == "report_accepted":
            source_errors(event.get("source"), location + ".source")
            report = task.get("research_result")
            if not isinstance(report, dict) or event.get("source") != report.get("source"):
                errors.append(location + ".source must equal the accepted report source")
            if authorization and authorization.get("mode", "reparse") == "reparse" and event.get("source") != authorization.get("source"):
                errors.append(location + ".source must equal the authorized reparse source")
        if action == "recovery_failed" and not _nonblank(event.get("reason")):
            errors.append(location + ".reason must be nonblank")
        previous_action = action if isinstance(action, str) else "invalid"
        previous_at = at
    return errors


def acknowledged_disposition(task: dict) -> dict | None:
    """Return only an acknowledgement that still describes this exact settled incident."""
    if "research_disposition" not in task or not _settled(task):
        return None
    if validate_research_disposition(task, "task"):
        return None
    events = task["research_disposition"]["events"]
    latest = events[-1]
    if latest["action"] != "close_unaccepted" and not (
        latest["action"] == "recovery_failed" and latest.get("reason") in BENIGN_FAILURES
    ):
        return None
    initial = events[0]
    if research_incident(task) != {field: initial[field] for field in ("attempt", "basis")}:
        return None
    return copy.deepcopy(initial)


def disposition_state(task: dict) -> str | None:
    """Return the latest saved event action, if there is one."""
    block = task.get("research_disposition")
    events = block.get("events") if isinstance(block, dict) else None
    if not isinstance(events, list) or not events or not isinstance(events[-1], dict):
        return None
    return events[-1].get("action")


def append_recovery_event(task: dict, action: str, *, now: str,
                          actor: str | None = None, source: dict | None = None,
                          mode: str = "reparse", repair_after: str | None = None,
                          reason: str | None = None) -> dict:
    """Append validated recovery history after the caller has authorized its owner."""
    if action not in ("recover_authorized", "report_accepted", "recovery_failed"):
        raise ValueError("not a recovery event")
    block = task.get("research_disposition")
    if not isinstance(block, dict) or not isinstance(block.get("events"), list) or not block["events"]:
        raise ValueError("recovery events require an initial research disposition")
    event = {"action": action, "at": now}
    if action == "recover_authorized":
        event.update(actor=actor, source=copy.deepcopy(source), mode=mode)
        if repair_after is not None:
            event["repair_after"] = repair_after
    elif action == "report_accepted":
        event["source"] = copy.deepcopy(source)
    else:
        event["reason"] = reason
    candidate = {**task, "research_disposition": copy.deepcopy(block)}
    candidate["research_disposition"]["events"].append(event)
    errors = validate_research_disposition(candidate, "task")
    if errors:
        raise ValueError("invalid research recovery: " + "; ".join(errors))
    task["research_disposition"] = candidate["research_disposition"]
    return copy.deepcopy(event)
