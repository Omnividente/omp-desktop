#!/usr/bin/env python3
"""Own every transition of a task's life, so the queue stays truthful.

The queue is the loop's memory. If a transition is lost, the loop either keeps
working on something already finished or keeps waiting for a worker that died.
Four lessons are baked into this module:

* **Completion may not depend on an event.** GitHub starts no workflow run for
  an event caused by the loop's own token, so a pull request the loop merged
  itself delivers no ``pull_request: closed``. ``sweep()`` therefore reconciles
  the queue against the pull requests as the API reports them, and
  ``close_from_pr()`` is idempotent, so both paths can run.
* **Only an identified pull request may close a task.** An earlier version fell
  back to "the single task in progress" when no marker was found, and a
  hand-written pull request closed live autonomous work. There is no fallback
  now: no marker, no match.
* **"Nothing to change" is an answer.** ``no_change`` is terminal. Re-queuing it
  made the loop ask the same question for ever.
* **A dead session still costs an attempt.** If a failure is recorded for a task
  that was not marked as started, the attempt counter still advances, otherwise
  the dispatch key never changes and the next tick rediscovers the same dead
  session.

All times are UTC.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

DEFAULT_MAX_ATTEMPTS = 2
DEFAULT_STALE_HOURS = 6

STATUS_TODO = "todo"
STATUS_IN_PROGRESS = "in_progress"
STATUS_DONE = "done"
STATUS_BLOCKED = "blocked"
OPEN_STATUSES = (STATUS_IN_PROGRESS, STATUS_TODO)

OUTCOME_MERGED = "merged"
OUTCOME_NO_CHANGE = "no_change"
OUTCOME_RESEARCHED = "researched"
OUTCOME_REVIEW_REQUIRED = "review_required"
OUTCOME_REPORT_INVALID = "report_invalid"
OUTCOME_CLOSED = "closed_unmerged"
OUTCOME_FAILED = "failed"
OUTCOME_STALE = "stale"
VALID_OUTCOMES = (
    OUTCOME_MERGED, OUTCOME_NO_CHANGE, OUTCOME_RESEARCHED,
    OUTCOME_CLOSED, OUTCOME_FAILED, OUTCOME_STALE,
)
# Outcomes that answer the question the task asked. Failed worker attempts retry
# within budget; defective report packaging is parked separately without retry.
TERMINAL_OUTCOMES = (OUTCOME_MERGED, OUTCOME_NO_CHANGE, OUTCOME_RESEARCHED)

TASK_ID_RE = re.compile(r"AUTONOMOUS_TASK_ID:[ \t]*([^\s<>`]+)")
DISPATCH_KEY_RE = re.compile(r"\[dispatch:([^\]\s]+)\]")
DISPATCH_MARKER_RE = re.compile(r"AUTONOMOUS_DISPATCH_KEY:[ \t]*([^\s<>`]+)")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in ("true", "1", "yes", "y", "on")


def tasks_of(manifest: Mapping[str, Any]) -> list:
    tasks = manifest.get("tasks") if isinstance(manifest, Mapping) else None
    return tasks if isinstance(tasks, list) else []


def find_task(manifest: Mapping[str, Any], task_id: Any) -> dict | None:
    wanted = str(task_id or "").strip()
    if not wanted:
        return None
    for task in tasks_of(manifest):
        if isinstance(task, dict) and str(task.get("id") or "") == wanted:
            return task
    return None


def limits(manifest: Mapping[str, Any]) -> tuple:
    policy = (manifest.get("autonomous_loop_policy") or {}) if isinstance(manifest, Mapping) else {}
    lifecycle = policy.get("lifecycle") or {}
    max_attempts = _int(lifecycle.get("max_attempts")) or DEFAULT_MAX_ATTEMPTS
    stale_hours = _int(lifecycle.get("stale_in_progress_hours")) or DEFAULT_STALE_HOURS
    return max(1, max_attempts), max(1, stale_hours)


def _execution(task: dict) -> dict:
    block = task.get("execution")
    if not isinstance(block, dict):
        block = {}
        task["execution"] = block
    return block


def attempts_of(task: Any) -> int:
    if not isinstance(task, Mapping):
        return 0
    block = task.get("execution")
    if not isinstance(block, Mapping):
        return 0
    return _int(block.get("attempts"))


def recorded_pull_request(task: Any) -> int:
    if not isinstance(task, Mapping):
        return 0
    block = task.get("execution")
    if not isinstance(block, Mapping):
        return 0
    return _int(block.get("pull_request"))


def awaiting_review(task: Mapping[str, Any]) -> bool:
    block = task.get("execution") or {}
    return (task.get("status") == STATUS_BLOCKED
            and block.get("state") == "awaiting_review"
            and block.get("outcome") == OUTCOME_REVIEW_REQUIRED)


def defer_review(task: dict, pull_request: int) -> dict:
    """Park this attempt without spending it or pretending its PR has closed."""
    block = _execution(task)
    task["status"] = STATUS_BLOCKED
    block["state"] = "awaiting_review"
    block["outcome"] = OUTCOME_REVIEW_REQUIRED
    block["pull_request"] = pull_request
    block["note"] = "pull request #" + str(pull_request) + " awaits human review"
    return {"changed": True, "reason": OUTCOME_REVIEW_REQUIRED,
            "task_id": str(task.get("id") or ""), "status": STATUS_BLOCKED,
            "pull_request": pull_request, "attempts": attempts_of(task)}


def awaiting_report(task: Mapping[str, Any]) -> bool:
    block = task.get("execution") or {}
    return (task.get("status") == STATUS_BLOCKED
            and block.get("state") == "awaiting_report"
            and block.get("outcome") == OUTCOME_REPORT_INVALID)


def park_report(manifest: dict, task_id: str, *, code: str, detail: str,
                now: datetime | None = None) -> dict:
    """Retain a completed worker's identity until its report can be reharvested."""
    task = find_task(manifest, task_id)
    if task is None:
        raise ValueError("task not found")
    block = _execution(task)
    if task.get("task_type") != "project_discovery" or not (
        block.get("session_id") and block.get("dispatch_key") and attempts_of(task) > 0
    ):
        raise ValueError("report recovery requires a bound research attempt")
    if awaiting_report(task):
        return {"changed": False, "reason": OUTCOME_REPORT_INVALID, "task_id": task_id,
                "status": STATUS_BLOCKED, "attempts": attempts_of(task)}
    if task.get("status") != STATUS_IN_PROGRESS or block.get("outcome"):
        raise ValueError("only an active attempt can await its report")
    task["status"] = STATUS_BLOCKED
    block["state"] = "awaiting_report"
    block["outcome"] = OUTCOME_REPORT_INVALID
    block["report_error"] = {"code": code, "detail": detail, "reported_at": iso(now or utcnow())}
    block["note"] = "completed worker report requires inspection: " + code
    return {"changed": True, "reason": OUTCOME_REPORT_INVALID, "task_id": task_id,
            "status": STATUS_BLOCKED, "attempts": attempts_of(task)}


def start(
    manifest: dict,
    task_id: Any,
    *,
    session_id: str = "",
    dispatch_key: str = "",
    now: datetime | None = None,
) -> dict:
    """Record a new attempt without spending it again during reconciliation."""
    task = find_task(manifest, task_id)
    if task is None:
        return {"changed": False, "reason": "task_not_found", "task_id": str(task_id or "")}
    block = task.get("execution") or {}
    session_id = str(session_id or "")
    dispatch_key = str(dispatch_key or "")
    same_session = bool(session_id and str(block.get("session_id") or "") == session_id)
    same_key = bool(dispatch_key and str(block.get("dispatch_key") or "") == dispatch_key)
    if same_session or same_key:
        return {
            "changed": False, "reason": "already_dispatched",
            "task_id": str(task.get("id") or ""),
            "status": str(task.get("status") or ""), "attempts": attempts_of(task),
        }
    if str(task.get("status") or "") != STATUS_TODO:
        raise ValueError("task is not available for a new attempt")
    max_attempts, _stale_hours = limits(manifest)
    if attempts_of(task) >= max_attempts:
        raise ValueError("task has exhausted its attempt budget")
    moment = now or utcnow()
    block = _execution(task)
    block["state"] = "dispatched"
    block["session_id"] = str(session_id or "")
    block["dispatch_key"] = str(dispatch_key or "")
    block["attempts"] = attempts_of(task) + 1
    block["started_at"] = iso(moment)
    # The previous result must not survive a new dispatch, or a stale pull
    # request number would later match the wrong attempt.
    block["finished_at"] = ""
    block["pull_request"] = 0
    block["outcome"] = ""
    block["note"] = ""
    task["status"] = STATUS_IN_PROGRESS
    return {
        "changed": True,
        "reason": "dispatched",
        "task_id": str(task.get("id") or ""),
        "status": STATUS_IN_PROGRESS,
        "attempts": block["attempts"],
    }


def _finish(
    manifest: dict,
    task: dict,
    *,
    outcome: str,
    note: str = "",
    pull_request: Any = 0,
    now: datetime | None = None,
    retry_report: bool = False,
) -> dict:
    if outcome not in VALID_OUTCOMES:
        raise ValueError(
            "unknown outcome " + repr(outcome) + "; expected one of " + str(list(VALID_OUTCOMES))
        )
    moment = now or utcnow()
    max_attempts, _stale_hours = limits(manifest)
    block = _execution(task)
    previous_status = str(task.get("status") or "")
    recovering = retry_report and awaiting_report(task) and outcome in (OUTCOME_NO_CHANGE, OUTCOME_RESEARCHED)
    if retry_report and not recovering:
        raise ValueError("report recovery requires a parked report and a valid research outcome")
    parked = recovering or (awaiting_review(task) and outcome in (OUTCOME_MERGED, OUTCOME_CLOSED))
    if not parked and (block.get("outcome") or previous_status not in OPEN_STATUSES):
        return {
            "changed": False, "reason": "task_already_closed",
            "task_id": str(task.get("id") or ""), "status": previous_status,
            "attempts": attempts_of(task),
        }

    # Always materialise the counter, so a task that finished on its first
    # dispatch still records how many attempts it took.
    block["attempts"] = max(1, attempts_of(task) + (previous_status != STATUS_IN_PROGRESS and not parked))
    block["outcome"] = outcome
    block["note"] = str(note or "")
    block["finished_at"] = iso(moment)
    if recovering:
        block.pop("report_error", None)
    number = _int(pull_request)
    if number:
        block["pull_request"] = number

    if outcome in TERMINAL_OUTCOMES:
        task["status"] = STATUS_DONE
        block["state"] = "completed"
    else:
        if attempts_of(task) >= max_attempts:
            task["status"] = STATUS_BLOCKED
            block["state"] = "exhausted"
        else:
            task["status"] = STATUS_TODO
            block["state"] = "retry"

    return {
        "changed": True,
        "reason": outcome,
        "outcome": outcome,
        "task_id": str(task.get("id") or ""),
        "status": str(task.get("status") or ""),
        "attempts": attempts_of(task),
    }


def complete(
    manifest: dict,
    task_id: Any,
    *,
    outcome: str,
    note: str = "",
    pull_request: Any = 0,
    now: datetime | None = None,
    retry_report: bool = False,
) -> dict:
    """Record the result a worker session reported for a task."""
    if outcome not in VALID_OUTCOMES:
        raise ValueError(
            "unknown outcome " + repr(outcome) + "; expected one of " + str(list(VALID_OUTCOMES))
        )
    task = find_task(manifest, task_id)
    if task is None:
        return {"changed": False, "reason": "task_not_found", "task_id": str(task_id or "")}
    return _finish(
        manifest, task, outcome=outcome, note=note, pull_request=pull_request, now=now,
        retry_report=retry_report,
    )


def match_task(
    manifest: Mapping[str, Any],
    *,
    title: str = "",
    body: str = "",
    pull_request: Any = 0,
) -> tuple:
    """Find the task a pull request belongs to, or nothing.

    There is deliberately no "probably this one" fallback: an unidentified pull
    request closed live autonomous work once already.
    """
    text = str(title or "") + "\n" + str(body or "")
    ids = set(TASK_ID_RE.findall(text))
    keys = set(DISPATCH_KEY_RE.findall(text)) | set(DISPATCH_MARKER_RE.findall(text))
    if len(ids) > 1 or len(keys) > 1:
        return None, "ambiguous_markers"

    tasks = [task for task in tasks_of(manifest) if isinstance(task, dict)]
    candidates = tasks
    how = "unmatched"
    if ids:
        candidates = [task for task in candidates if str(task.get("id") or "") in ids]
        how = "task_id_marker"
    if keys:
        candidates = [
            task for task in candidates
            if str((task.get("execution") or {}).get("dispatch_key") or "") in keys
        ]
        how = "dispatch_key"

    number = _int(pull_request)
    recorded = [task for task in tasks if number and recorded_pull_request(task) == number]
    if recorded:
        candidates = [task for task in candidates if any(task is item for item in recorded)]
        how = "recorded_pull_request"
    elif not keys:
        # A task ID identifies work, not an attempt. Only legacy first attempts
        # without a dispatch key can safely use it on its own.
        candidates = [
            task for task in candidates if ids and attempts_of(task) <= 1
            and not (task.get("execution") or {}).get("dispatch_key")
        ]
    if len(candidates) != 1:
        return None, "unmatched"
    task = candidates[0]
    if number and recorded_pull_request(task) not in (0, number):
        return None, "conflicting_pull_request"
    return task, how


def close_from_pr(
    manifest: dict,
    *,
    pull_request: Any,
    title: str = "",
    body: str = "",
    merged: bool = False,
    note: str = "",
    now: datetime | None = None,
) -> dict:
    """Close the task a finished pull request belongs to. Safe to run twice."""
    number = _int(pull_request)
    task, how = match_task(manifest, title=title, body=body, pull_request=number)
    if task is None:
        return {
            "changed": False,
            "reason": "no_matching_task",
            "matched_by": how,
            "task_id": "",
            "pull_request": number,
        }
    status = str(task.get("status") or "")
    if status not in OPEN_STATUSES and not awaiting_review(task):
        return {
            "changed": False,
            "reason": "task_already_closed",
            "matched_by": how,
            "task_id": str(task.get("id") or ""),
            "status": status,
            "pull_request": number,
        }
    outcome = OUTCOME_MERGED if merged else OUTCOME_CLOSED
    default_note = (
        "pull request #" + str(number) + (" was merged" if merged else " was closed without merging")
    )
    result = _finish(
        manifest, task, outcome=outcome, note=note or default_note,
        pull_request=number, now=now,
    )
    result["matched_by"] = how
    result["pull_request"] = number
    return result


def sweep(
    manifest: dict,
    pull_requests: Sequence[Any],
    *,
    now: datetime | None = None,
    config: Mapping[str, Any] | None = None,
) -> dict:
    """Reconcile in-flight tasks against the pull requests the API reports.

    GitHub does not start a workflow run for an event triggered by the loop's
    own token, so completion can never depend on receiving one. This reads the
    current state instead and is safe to run on every tick.
    """
    changes: list = []
    linked: list = []
    matches: dict[int, list] = {}
    blocking_labels = set((config or {}).get("automation", {}).get(
        "blocking_labels", ["human-review", "hold", "do-not-merge", "wip"],
    ))
    for entry in pull_requests or []:
        if not isinstance(entry, Mapping) or not _int(entry.get("number")):
            continue
        task, _how = match_task(
            manifest, title=str(entry.get("title") or ""),
            body=str(entry.get("body") or ""), pull_request=entry.get("number"),
        )
        if task is not None:
            matches.setdefault(id(task), []).append(_int(entry.get("number")))
    for entry in pull_requests or []:
        if not isinstance(entry, Mapping):
            continue
        number = _int(entry.get("number"))
        if not number:
            continue
        state = str(entry.get("state") or "").upper()
        # gh reports state MERGED; the REST API reports state closed plus a
        # merged_at timestamp. Both shapes must mean merged, or a merge read
        # through the API would be recorded as "closed without merging".
        merged = (
            bool(entry.get("merged"))
            or bool(entry.get("mergedAt"))
            or bool(entry.get("merged_at"))
            or state == "MERGED"
        )
        task, how = match_task(
            manifest,
            title=str(entry.get("title") or ""),
            body=str(entry.get("body") or ""),
            pull_request=number,
        )
        if task is None:
            continue
        if len(set(matches.get(id(task), []))) != 1:
            continue
        if str(task.get("status") or "") != STATUS_IN_PROGRESS and not awaiting_review(task):
            continue

        if merged or state == "CLOSED":
            outcome = OUTCOME_MERGED if merged else OUTCOME_CLOSED
            note = (
                "pull request #" + str(number)
                + (" was merged" if merged else " was closed without merging")
                + " (reconciled through the API, not from an event)"
            )
            result = _finish(
                manifest, task, outcome=outcome, note=note, pull_request=number, now=now,
            )
            result["matched_by"] = how
            result["pull_request"] = number
            changes.append(result)
            continue
        if state != "OPEN":
            continue
        labels = {
            str(label.get("name") or "") if isinstance(label, Mapping) else str(label)
            for label in entry.get("labels", [])
        }
        paused = bool(entry.get("draft") or entry.get("isDraft") or labels & blocking_labels)
        if paused and not awaiting_review(task):
            changes.append(defer_review(task, number))
            continue


        # The pull request is still open: remember it so the task can be closed
        # later even if its description is edited.
        if recorded_pull_request(task) != number:
            _execution(task)["pull_request"] = number
            linked.append({"task_id": str(task.get("id") or ""), "pull_request": number})

    if changes:
        reason = "swept"
        task_id = str(changes[0].get("task_id") or "")
    elif linked:
        reason = "linked"
        task_id = str(linked[0].get("task_id") or "")
    else:
        reason = "nothing_to_sweep"
        task_id = ""
    return {
        "changed": bool(changes or linked),
        "reason": reason,
        "changes": changes,
        "linked": linked,
        "task_id": task_id,
    }


def reconcile(manifest: dict, *, now: datetime | None = None) -> dict:
    """Release tasks whose worker session never reported anything."""
    moment = now or utcnow()
    _max_attempts, stale_hours = limits(manifest)
    cutoff = moment - timedelta(hours=stale_hours)
    released: list = []
    for task in tasks_of(manifest):
        if not isinstance(task, dict):
            continue
        if str(task.get("status") or "") != STATUS_IN_PROGRESS:
            continue
        if recorded_pull_request(task):
            # GitHub sweep, not elapsed worker time, owns a linked PR's result.
            continue
        block = task.get("execution")
        started = parse_iso((block or {}).get("started_at")) if isinstance(block, Mapping) else None
        if started is not None and started > cutoff:
            continue
        result = _finish(
            manifest, task, outcome=OUTCOME_STALE,
            note="no result within " + str(stale_hours) + "h", now=moment,
        )
        released.append(result)
    if not released:
        return {"changed": False, "reason": "nothing_stale", "released": [], "task_id": ""}
    return {
        "changed": True,
        "reason": "released_stale",
        "released": released,
        "task_id": str(released[0].get("task_id") or ""),
    }


def counts(manifest: Mapping[str, Any]) -> dict:
    out = {STATUS_TODO: 0, STATUS_IN_PROGRESS: 0, STATUS_DONE: 0, STATUS_BLOCKED: 0}
    for task in tasks_of(manifest):
        if not isinstance(task, dict):
            continue
        status = str(task.get("status") or "")
        if status in out:
            out[status] += 1
    return out


def _read_text(path: Path | None) -> str:
    if not path:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError:
        return ""


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument(
        "--action", required=True,
        choices=("start", "complete", "close-from-pr", "sweep", "reconcile"),
    )
    parser.add_argument("--task-id", default="")
    parser.add_argument("--session-id", default="")
    parser.add_argument("--dispatch-key", default="")
    parser.add_argument("--outcome", default="")
    parser.add_argument("--note", default="")
    parser.add_argument("--pull-request", default="0")
    parser.add_argument("--title", default="")
    parser.add_argument("--body", default="")
    parser.add_argument("--body-file", type=Path)
    parser.add_argument("--merged", default="false")
    parser.add_argument(
        "--pull-requests", default="",
        help="JSON array of pull requests (number, state, title, body) to reconcile against",
    )
    parser.add_argument("--out", type=Path, help="write the manifest here instead of in place")
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args(argv)

    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print("::error::cannot read the task manifest: " + str(exc), file=sys.stderr)
        return 1

    body = args.body or _read_text(args.body_file)

    try:
        if args.action == "start":
            result = start(
                manifest, args.task_id,
                session_id=args.session_id, dispatch_key=args.dispatch_key,
            )
        elif args.action == "complete":
            result = complete(
                manifest, args.task_id, outcome=args.outcome, note=args.note,
                pull_request=args.pull_request,
            )
        elif args.action == "close-from-pr":
            result = close_from_pr(
                manifest, pull_request=args.pull_request, title=args.title, body=body,
                merged=_truthy(args.merged), note=args.note,
            )
        elif args.action == "sweep":
            raw = args.pull_requests or "[]"
            if not raw.lstrip().startswith(("[", "{")) and Path(raw).is_file():
                raw = Path(raw).read_text(encoding="utf-8")
            entries = json.loads(raw)
            if not isinstance(entries, list):
                print("::error::--pull-requests must be a JSON array", file=sys.stderr)
                return 2
            config = json.loads(args.config.read_text(encoding="utf-8")) if args.config else None
            result = sweep(manifest, entries, config=config)
        else:
            result = reconcile(manifest)
    except (OSError, ValueError) as exc:
        print("::error::" + str(exc), file=sys.stderr)
        return 2

    result["queue"] = counts(manifest)
    if result.get("changed"):
        target = args.out or args.manifest
        target.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as handle:
            handle.write("lifecycle_changed=" + ("true" if result.get("changed") else "false") + "\n")
            handle.write("lifecycle_reason=" + str(result.get("reason") or "") + "\n")
            handle.write("lifecycle_task_id=" + str(result.get("task_id") or "") + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
