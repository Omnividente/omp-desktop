#!/usr/bin/env python3
"""Select the next eligible autonomous task from agent_tasks.json.

Pure, deterministic, and deliberately biased towards finishing real work:

* nothing is selected while another task is still in flight, so the loop can
  never run two worker sessions against one integration branch;
* a concrete evidence-backed task always outranks open-ended discovery,
  regardless of the configured priority numbers - discovery is the fallback for
  an empty queue, not the default activity;
* a task that already burned through its attempt budget is skipped instead of
  being retried forever.

Never mutates the manifest; task_lifecycle.py owns all transitions.
"""
from __future__ import annotations

import argparse
import json
import os
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
    in_flight = [t for t in tasks if str(t.get("status")) == "in_progress"]
    todo_count = len(todo)

    def is_eligible(task: Mapping[str, Any]) -> tuple:
        if str(task.get("id")) in excluded:
            return False, "excluded"
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

    # One task in flight at a time. Re-dispatching while a session is still
    # running is how duplicate pull requests and repeated discovery happen.
    if in_flight:
        return _summary(
            False, in_flight[0], "work_in_progress",
            "task " + repr(str(in_flight[0].get("id"))) + " is still in progress",
            todo_count, 0,
        )

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
        return _summary(True, match, "explicit_task_selected",
                        "explicit task selected", todo_count, 1)

    eligible = [t for t in todo if is_eligible(t)[0]]
    eligible_count = len(eligible)
    concrete = [t for t in eligible if str(t.get("task_type")) != DISCOVERY_TYPE]
    discovery = [t for t in eligible if str(t.get("task_type")) == DISCOVERY_TYPE]

    if todo_count == 0:
        return _summary(False, None, "no_todo_tasks",
                        "no todo tasks remain", todo_count, 0)
    if not eligible:
        return _summary(False, None, "no_eligible_autonomous_task",
                        "todo tasks remain but none is eligible", todo_count, 0)

    if concrete:
        chosen = sorted(concrete, key=sort_key)[0]
        return _summary(True, chosen, "ready", "eligible task selected",
                        todo_count, eligible_count,
                        deferred_discovery=bool(discovery))
    if not allow_discovery:
        return _summary(False, None, "discovery_disabled",
                        "only discovery tasks remain and discovery is disabled",
                        todo_count, eligible_count)
    chosen = sorted(discovery, key=sort_key)[0]
    return _summary(True, chosen, "ready_discovery",
                    "no concrete task is available; falling back to discovery",
                    todo_count, eligible_count)


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
