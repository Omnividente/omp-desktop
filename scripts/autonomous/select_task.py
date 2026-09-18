#!/usr/bin/env python3
"""Select read-only research by default; implementation requires explicit approval.

Research and implementation have independent foreground lanes. Detached pinned
research remains unresolved but frees the research lane, never its own scope.
Never mutates the manifest; task_lifecycle.py owns all transitions.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Mapping, Sequence

RISK_ORDER = {"low": 1, "medium": 2, "high": 3}
DEFAULT_MAX_ATTEMPTS = 2
DISCOVERY_TYPE = "project_discovery"


def _risk_rank(value: Any) -> int:
    return RISK_ORDER.get(str(value or "").strip().lower(), RISK_ORDER["high"])


def _as_list(value: Any) -> list:
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, (list, tuple)):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _attempts(task: Mapping[str, Any]) -> int:
    try:
        return int((task.get("execution") or {}).get("attempts") or 0)
    except (TypeError, ValueError):
        return 0


def _utc_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or "T" not in value:
        return False
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return moment.tzinfo is not None and moment.utcoffset() == timedelta(0)
    except ValueError:
        return False


def pending_report_repair(task: Mapping[str, Any]) -> bool:
    execution = task.get("execution")
    if not isinstance(execution, Mapping):
        return False
    receipt = execution.get("report_repair")
    if not isinstance(receipt, Mapping):
        return False
    return (task.get("task_type") == DISCOVERY_TYPE and task.get("status") == "blocked"
            and execution.get("state") == "awaiting_report"
            and execution.get("outcome") == "report_invalid" and receipt.get("status") == "pending")


def is_unresolved(task: Mapping[str, Any]) -> bool:
    execution = task.get("execution")
    return (task.get("status") == "in_progress" or pending_report_repair(task)
            or (isinstance(execution, Mapping) and execution.get("state") == "quarantined"))


def valid_research_detachment(task: Mapping[str, Any]) -> bool:
    """A sticky detachment is valid only for its saved, immutable research attempt."""
    execution = task.get("execution")
    if not isinstance(execution, Mapping):
        return False
    detached = execution.get("research_detached")
    key = execution.get("dispatch_key")
    return (
        task.get("task_type") == DISCOVERY_TYPE
        and isinstance(detached, dict)
        and _utc_timestamp(detached.get("at"))
        and detached.get("reason") in ("AWAITING_USER_FEEDBACK", "AWAITING_PLAN_APPROVAL", "PAUSED")
        and type(execution.get("attempts")) is int and execution["attempts"] >= 1
        and isinstance(execution.get("session_id"), str)
        and re.fullmatch(r"(?:sessions/)?[A-Za-z0-9_-]+", execution["session_id"]) is not None
        and isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9_-]+", key) is not None
        and execution.get("starting_branch") == "autonomous/attempt-" + key
        and re.fullmatch(r"[0-9a-fA-F]{40}", str(execution.get("base_sha") or "")) is not None
    )


def blocks_lane(task: Mapping[str, Any], *, discovery: bool) -> bool:
    if not is_unresolved(task) or (task.get("task_type") == DISCOVERY_TYPE) != discovery:
        return False
    return not (discovery and (valid_research_detachment(task) or pending_report_repair(task)))


def _approved(task: Mapping[str, Any]) -> bool:
    decision = task.get("proposal_decision")
    return (isinstance(decision, dict) and decision.get("action") == "approve"
            and all(isinstance(decision.get(field), str) and decision[field].strip()
                    for field in ("actor", "note"))
            and _utc_timestamp(decision.get("at")))


def select(
    manifest: Mapping[str, Any],
    *,
    focus: Sequence[str] | None = None,
    risk_ceiling: str = "high",
    task_id: str | None = None,
    excluded_task_ids: Sequence[str] | None = None,
    allow_discovery: bool = True,
) -> dict:
    tasks = [t for t in manifest.get("tasks", []) if isinstance(t, dict)]
    policy = manifest.get("autonomous_loop_policy") or {}
    lifecycle = policy.get("lifecycle") or {}
    try:
        max_attempts = int(lifecycle.get("max_attempts", DEFAULT_MAX_ATTEMPTS))
    except (TypeError, ValueError):
        max_attempts = DEFAULT_MAX_ATTEMPTS
    max_attempts = max(1, max_attempts)

    focus_filter = {f.lower() for f in (focus or [])}
    excluded = {str(x) for x in (excluded_task_ids or []) if str(x)}
    ceiling = _risk_rank(risk_ceiling)

    todo = [t for t in tasks if str(t.get("status")) == "todo"]
    unresolved = [t for t in tasks if is_unresolved(t)]
    todo_count = len(todo)

    def is_eligible(task: Mapping[str, Any]) -> tuple:
        if str(task.get("id")) in excluded:
            return False, "excluded"
        if is_unresolved(task):
            return False, "work_in_progress"
        if task.get("task_type") != DISCOVERY_TYPE and not _approved(task):
            return False, "proposal_approval_required"
        if task.get("task_type") == DISCOVERY_TYPE:
            if not allow_discovery:
                return False, "discovery_disabled"
            scope = task.get("research") or {}
            if scope and any(
                other.get("task_type") == DISCOVERY_TYPE
                and (other.get("research") or {}).get("area_id") == scope.get("area_id")
                and (other.get("research") or {}).get("perspective_id") == scope.get("perspective_id")
                for other in unresolved
            ):
                return False, "research_scope_occupied"
        if (task.get("execution") or {}).get("outcome") == "closed_unmerged":
            return False, "proposal_declined"
        if _attempts(task) >= max_attempts:
            return False, "attempt_limit_reached"
        if _risk_rank(task.get("risk", "medium")) > ceiling:
            return False, "risk_above_ceiling"
        task_focus = {f.lower() for f in _as_list(task.get("focus"))}
        if focus_filter and task_focus and not (focus_filter & task_focus):
            return False, "focus_mismatch"
        return True, "eligible"

    def sort_key(task: Mapping[str, Any]):
        try:
            priority = int(task.get("priority", 0))
        except (TypeError, ValueError):
            priority = 0
        return (-priority, str(task.get("created_at") or ""), str(task.get("id") or ""))

    def lane_blocker(discovery: bool) -> dict | None:
        return next((task for task in unresolved if blocks_lane(task, discovery=discovery)), None)

    def occupied(blocker: dict) -> dict:
        return _summary(False, blocker, "work_in_progress",
                        "task " + repr(str(blocker.get("id"))) + " still occupies this lane",
                        todo_count, 0)

    if task_id:
        match = next((t for t in tasks if str(t.get("id")) == task_id), None)
        if match is None:
            return _summary(False, None, "explicit_task_missing",
                            "task " + repr(task_id) + " not found", todo_count, 0)
        if str(match.get("status")) != "todo":
            return _summary(False, match, "explicit_task_not_todo",
                            "task " + repr(task_id) + " is " + str(match.get("status")),
                            todo_count, 0)
        ok, why = is_eligible(match)
        if not ok:
            return _summary(False, match, "explicit_task_ineligible",
                            "task " + repr(task_id) + " ineligible: " + why,
                            todo_count, 0)
        blocker = lane_blocker(match.get("task_type") == DISCOVERY_TYPE)
        if blocker:
            return occupied(blocker)
        return _summary(True, match, "explicit_task_selected",
                        "explicit task selected", todo_count, 1)

    blocker = lane_blocker(True)
    if blocker:
        return occupied(blocker)
    if not allow_discovery:
        return _summary(False, None, "discovery_disabled", "research is disabled", todo_count, 0)
    eligible = [t for t in todo if t.get("task_type") == DISCOVERY_TYPE and is_eligible(t)[0]]
    if not eligible:
        return _summary(False, None, "no_todo_tasks" if not todo else "no_eligible_autonomous_task",
                        "no eligible research task", todo_count, 0)
    chosen = min(eligible, key=sort_key)
    return _summary(True, chosen, "ready_discovery", "eligible read-only research selected",
                    todo_count, len(eligible))


def _summary(selected, task, reason_code, reason, todo_count, eligible_count,
             deferred_discovery: bool = False) -> dict:
    task = task or {}
    try:
        score = int(task.get("priority", 0))
    except (TypeError, ValueError):
        score = 0
    return {
        "selected": bool(selected),
        "task_id": str(task.get("id") or ""),
        "title": str(task.get("title") or ""),
        "task_type": str(task.get("task_type") or ""),
        "score": score,
        "attempts": _attempts(task),
        "reason": reason,
        "reason_code": reason_code,
        "todo_count": todo_count,
        "eligible_count": eligible_count,
        "deferred_discovery": bool(deferred_discovery),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--focus", default="")
    parser.add_argument("--risk-ceiling", default="high")
    parser.add_argument("--task-id", default="")
    parser.add_argument("--exclude-task-id", action="append", default=[])
    parser.add_argument("--no-discovery", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT", ""))
    args = parser.parse_args(argv)

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    result = select(
        manifest,
        focus=_as_list(args.focus),
        risk_ceiling=args.risk_ceiling,
        task_id=args.task_id or None,
        excluded_task_ids=args.exclude_task_id,
        allow_discovery=not args.no_discovery,
    )
    print(json.dumps(result, ensure_ascii=False, indent=None if args.json else 2))
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            handle.write("selected=" + ("true" if result["selected"] else "false") + "\n")
            handle.write("task_id=" + result["task_id"] + "\n")
            handle.write("task_type=" + result["task_type"] + "\n")
            handle.write("reason_code=" + result["reason_code"] + "\n")
            handle.write("todo_count=" + str(result["todo_count"]) + "\n")
            handle.write(
                "deferred_discovery="
                + ("true" if result["deferred_discovery"] else "false") + "\n"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
