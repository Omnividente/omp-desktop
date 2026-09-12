#!/usr/bin/env python3
"""Own the task lifecycle: todo -> in_progress -> done / blocked.

Without this the loop re-dispatches work it has already finished, which is
exactly how an autonomous agent ends up repeating discovery forever instead of
shipping fixes. The AI worker is not allowed to edit the queue, so every
transition is recorded here by the automation, together with the session and
pull request that caused it. The queue becomes an auditable log rather than a
wish list.

Transitions:
  start          todo        -> in_progress   (a worker session was dispatched)
  close-from-pr  in_progress -> done          (its pull request merged)
                 in_progress -> todo/blocked  (closed without merging)
  complete       in_progress -> done/todo/blocked (explicit outcome, e.g. the
                 worker session finished with no change at all)
  reconcile      in_progress -> todo/blocked  (no result within the stale window)

A task that burns through ``lifecycle.max_attempts`` becomes ``blocked`` instead
of cycling forever - the anti-churn rule that makes the loop give up honestly.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

TASK_ID_RE = re.compile(r"AUTONOMOUS_TASK_ID:\s*([A-Za-z0-9._-]+)")
DISPATCH_KEY_RE = re.compile(r"\[dispatch:([A-Za-z0-9]+)\]")

DEFAULT_MAX_ATTEMPTS = 2
DEFAULT_STALE_HOURS = 6

OUTCOME_MERGED = "merged"
OUTCOME_NO_CHANGE = "no_change"
OUTCOME_CLOSED = "closed_unmerged"
OUTCOME_FAILED = "failed"
OUTCOME_STALE = "stale"
VALID_OUTCOMES = (
    OUTCOME_MERGED, OUTCOME_NO_CHANGE, OUTCOME_CLOSED, OUTCOME_FAILED, OUTCOME_STALE,
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: Any):
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _tasks(manifest: Mapping[str, Any]) -> list:
    return [t for t in manifest.get("tasks", []) if isinstance(t, dict)]


def find_task(manifest: Mapping[str, Any], task_id: str):
    for task in _tasks(manifest):
        if str(task.get("id")) == str(task_id):
            return task
    return None


def limits(manifest: Mapping[str, Any]) -> tuple:
    lifecycle = ((manifest.get("autonomous_loop_policy") or {}).get("lifecycle") or {})
    try:
        max_attempts = int(lifecycle.get("max_attempts", DEFAULT_MAX_ATTEMPTS))
    except (TypeError, ValueError):
        max_attempts = DEFAULT_MAX_ATTEMPTS
    try:
        stale_hours = int(lifecycle.get("stale_in_progress_hours", DEFAULT_STALE_HOURS))
    except (TypeError, ValueError):
        stale_hours = DEFAULT_STALE_HOURS
    return max(1, max_attempts), max(1, stale_hours)


def _execution(task: dict) -> dict:
    block = task.get("execution")
    if not isinstance(block, dict):
        block = {}
        task["execution"] = block
    return block


def attempts_of(task: Mapping[str, Any]) -> int:
    block = task.get("execution") or {}
    try:
        return int(block.get("attempts") or 0)
    except (TypeError, ValueError):
        return 0


def start(manifest: dict, task_id: str, *, session_id: str = "",
          dispatch_key: str = "", now: datetime | None = None) -> dict:
    task = find_task(manifest, task_id)
    if task is None:
        return {"changed": False, "reason": "task_not_found", "task_id": str(task_id)}
    block = _execution(task)
    attempt = attempts_of(task) + 1
    block.update({
        "state": "dispatched",
        "session_id": str(session_id or ""),
        "dispatch_key": str(dispatch_key or ""),
        "attempts": attempt,
        "started_at": iso(now or utcnow()),
        "finished_at": "",
        "pull_request": 0,
        "outcome": "",
        "note": "",
    })
    task["status"] = "in_progress"
    return {
        "changed": True, "reason": "dispatched", "task_id": str(task_id),
        "status": "in_progress", "attempts": attempt,
    }


def _finish(manifest: dict, task: dict, outcome: str, *, pull_request: int = 0,
            note: str = "", now: datetime | None = None) -> str:
    max_attempts, _ = limits(manifest)
    block = _execution(task)
    block["finished_at"] = iso(now or utcnow())
    block["outcome"] = str(outcome)
    block["note"] = str(note or "")
    if pull_request:
        block["pull_request"] = int(pull_request)
    if outcome == OUTCOME_MERGED:
        task["status"] = "done"
        block["state"] = "completed"
    elif attempts_of(task) >= max_attempts:
        task["status"] = "blocked"
        block["state"] = "exhausted"
    else:
        task["status"] = "todo"
        block["state"] = "retry"
    return str(task["status"])


def complete(manifest: dict, task_id: str, *, outcome: str, pull_request: int = 0,
             note: str = "", now: datetime | None = None) -> dict:
    if outcome not in VALID_OUTCOMES:
        raise ValueError("outcome must be one of " + str(list(VALID_OUTCOMES)))
    task = find_task(manifest, task_id)
    if task is None:
        return {"changed": False, "reason": "task_not_found", "task_id": str(task_id)}
    status = _finish(manifest, task, outcome, pull_request=pull_request, note=note, now=now)
    return {
        "changed": True, "reason": outcome, "task_id": str(task_id),
        "status": status, "attempts": attempts_of(task),
    }


def match_task(manifest: Mapping[str, Any], title: str = "", body: str = "") -> tuple:
    """Resolve which queued task a pull request belongs to.

    The dispatch prompt carries both markers, so a well-formed worker pull
    request is matched exactly. The single-in-flight fallback exists because the
    loop never runs two sessions at once.
    """
    marker = TASK_ID_RE.search(str(body or "")) or TASK_ID_RE.search(str(title or ""))
    if marker:
        task = find_task(manifest, marker.group(1))
        if task is not None:
            return task, "task_id_marker"
    key_match = (
        DISPATCH_KEY_RE.search(str(title or ""))
        or DISPATCH_KEY_RE.search(str(body or ""))
    )
    if key_match:
        key = key_match.group(1)
        for task in _tasks(manifest):
            if str((task.get("execution") or {}).get("dispatch_key") or "") == key:
                return task, "dispatch_key"
    in_flight = [t for t in _tasks(manifest) if str(t.get("status")) == "in_progress"]
    if len(in_flight) == 1:
        return in_flight[0], "single_in_progress"
    return None, "unmatched"


def close_from_pr(manifest: dict, *, pull_request: int, title: str = "", body: str = "",
                  merged: bool = False, now: datetime | None = None) -> dict:
    task, how = match_task(manifest, title=title, body=body)
    if task is None:
        return {"changed": False, "reason": "no_matching_task", "matched_by": how}
    outcome = OUTCOME_MERGED if merged else OUTCOME_CLOSED
    note = "pull request #" + str(pull_request) + (" merged" if merged else " closed without merging")
    status = _finish(manifest, task, outcome, pull_request=pull_request, note=note, now=now)
    return {
        "changed": True, "reason": outcome, "matched_by": how,
        "task_id": str(task.get("id")), "status": status, "attempts": attempts_of(task),
    }


def reconcile(manifest: dict, *, now: datetime | None = None) -> dict:
    """Release tasks stuck in_progress so the queue cannot deadlock."""
    max_attempts, stale_hours = limits(manifest)
    moment = now or utcnow()
    cutoff = moment - timedelta(hours=stale_hours)
    changes = []
    for task in _tasks(manifest):
        if str(task.get("status")) != "in_progress":
            continue
        started = parse_iso((task.get("execution") or {}).get("started_at"))
        if started is not None and started > cutoff:
            continue
        status = _finish(
            manifest, task, OUTCOME_STALE,
            note="no result within " + str(stale_hours) + "h", now=moment,
        )
        changes.append({
            "task_id": str(task.get("id")), "status": status,
            "attempts": attempts_of(task),
        })
    return {
        "changed": bool(changes), "changes": changes,
        "stale_hours": stale_hours, "max_attempts": max_attempts,
    }


def counts(manifest: Mapping[str, Any]) -> dict:
    tally = {"todo": 0, "in_progress": 0, "done": 0, "blocked": 0}
    for task in _tasks(manifest):
        status = str(task.get("status"))
        if status in tally:
            tally[status] += 1
    return tally


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--action", required=True,
                        choices=["start", "complete", "close-from-pr", "reconcile"])
    parser.add_argument("--task-id", default="")
    parser.add_argument("--session-id", default="")
    parser.add_argument("--dispatch-key", default="")
    parser.add_argument("--outcome", default=OUTCOME_NO_CHANGE, choices=list(VALID_OUTCOMES))
    parser.add_argument("--pull-request", type=int, default=0)
    parser.add_argument("--title", default="")
    parser.add_argument("--body", default="")
    parser.add_argument("--body-file", type=Path)
    parser.add_argument("--merged", default="false")
    parser.add_argument("--note", default="")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--github-output", default="")
    args = parser.parse_args(argv)

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    body = args.body
    if args.body_file and args.body_file.exists():
        body = args.body_file.read_text(encoding="utf-8")

    if args.action == "start":
        result = start(manifest, args.task_id, session_id=args.session_id,
                       dispatch_key=args.dispatch_key)
    elif args.action == "complete":
        result = complete(manifest, args.task_id, outcome=args.outcome,
                          pull_request=args.pull_request, note=args.note)
    elif args.action == "close-from-pr":
        result = close_from_pr(
            manifest, pull_request=args.pull_request, title=args.title, body=body,
            merged=str(args.merged).strip().lower() in ("1", "true", "yes"),
        )
    else:
        result = reconcile(manifest)

    result["queue"] = counts(manifest)
    if result.get("changed"):
        (args.out or args.manifest).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            handle.write(
                "lifecycle_changed=" + ("true" if result.get("changed") else "false") + "\n"
            )
            handle.write("lifecycle_reason=" + str(result.get("reason", "")) + "\n")
            handle.write("lifecycle_task_id=" + str(result.get("task_id", "")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
