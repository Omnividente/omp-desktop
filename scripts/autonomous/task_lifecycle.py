#!/usr/bin/env python3
"""Own every transition of a task's life, so the queue stays truthful.

The queue is the loop's memory. If a transition is lost, the loop either keeps
working on something already finished or keeps waiting for a worker that died.
Four lessons are baked into this module:

* **Human acceptance is observed, never performed here.** ``sweep()`` and
  ``close_from_pr()`` reconcile trusted proposals idempotently, but a closed PR
  cannot release a worker whose session is still active or unknown.
* **Only an identified pull request may close a task.** A persisted receipt
  from the exact session output is required; public markers are not authority.
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

from jules_dispatch import session_is_active
from select_task import blocks_lane, select

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
TERMINAL_OUTCOMES = (OUTCOME_MERGED, OUTCOME_NO_CHANGE, OUTCOME_RESEARCHED, OUTCOME_CLOSED)



def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


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
                now: datetime | None = None, source: dict | None = None) -> dict:
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
        changed = bool(source and not block.get("report_repair")
                       and source != block["report_error"].get("source"))
        if changed:
            block["report_error"]["source"] = source
        return {"changed": changed, "reason": OUTCOME_REPORT_INVALID, "task_id": task_id,
                "status": STATUS_BLOCKED, "attempts": attempts_of(task)}
    if task.get("status") != STATUS_IN_PROGRESS or block.get("outcome"):
        raise ValueError("only an active attempt can await its report")
    task["status"] = STATUS_BLOCKED
    block["state"] = "awaiting_report"
    block["outcome"] = OUTCOME_REPORT_INVALID
    block["report_error"] = {"code": code, "detail": detail, "reported_at": iso(now or utcnow())}
    if source:
        block["report_error"]["source"] = source
    block["note"] = "completed worker report requires inspection: " + code
    return {"changed": True, "reason": OUTCOME_REPORT_INVALID, "task_id": task_id,
            "status": STATUS_BLOCKED, "attempts": attempts_of(task)}


def reserve(manifest: dict, task_id: str, dispatch_key: str, *, base_sha: str,
            starting_branch: str, now: datetime | None = None) -> dict:
    """Persist one attempt before its single permitted CreateSession call."""
    task = find_task(manifest, task_id)
    if task is None:
        raise ValueError("task not found")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", dispatch_key or ""):
        raise ValueError("invalid dispatch key")
    if not re.fullmatch(r"[0-9a-fA-F]{40}", base_sha or "") or starting_branch != "autonomous/attempt-" + dispatch_key:
        raise ValueError("reservation requires the immutable attempt ref and base SHA")
    block = task.get("execution") or {}
    if block.get("dispatch_key") == dispatch_key:
        if block.get("base_sha") != base_sha or block.get("starting_branch") != starting_branch:
            raise ValueError("reservation identity conflicts with the stored attempt")
        return {"changed": False, "reason": "already_reserved", "task_id": task_id,
                "attempts": attempts_of(task)}
    selection = select(manifest, task_id=task["id"])
    if not selection["selected"]:
        raise ValueError("task is not available for reservation: " + selection["reason"])
    block = _execution(task)
    block.update(attempts=attempts_of(task) + 1, state="dispatching", session_id="",
                 dispatch_key=dispatch_key, base_sha=base_sha, starting_branch=starting_branch,
                 started_at=iso(now or utcnow()), finished_at="", pull_request=0,
                 outcome="", note="")
    block.pop("provenance", None)
    block.pop("session_state", None)
    block.pop("research_detached", None)
    block.pop("feedback_nudge", None)
    task["status"] = STATUS_IN_PROGRESS
    return {"changed": True, "reason": "reserved", "task_id": task_id,
            "status": STATUS_IN_PROGRESS, "attempts": block["attempts"]}


def quarantine(manifest: dict, task_id: str, *, reason: str, now: datetime | None = None) -> dict:
    """Retain uncertain external identity; never turn uncertainty into a retry."""
    task = find_task(manifest, task_id)
    if task is None:
        raise ValueError("task not found")
    block = _execution(task)
    if task.get("status") == STATUS_DONE or awaiting_review(task) or awaiting_report(task):
        return {"changed": False, "reason": "attempt_already_resolved", "task_id": task_id}
    changed = block.get("state") != "quarantined"
    if changed:
        task["status"] = STATUS_BLOCKED
        block.update(state="quarantined", outcome=OUTCOME_STALE, note=reason,
                     quarantined_at=iso(now or utcnow()))
    return {"changed": changed, "reason": "quarantined", "task_id": task_id,
            "status": task.get("status"), "attempts": attempts_of(task)}


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
    if same_session and dispatch_key and not same_key:
        raise ValueError("stored session belongs to a different dispatch key")
    if same_key and session_id and block.get("session_id") and not same_session:
        raise ValueError("dispatch attempt already has a different session")
    if same_key and session_id and not block.get("session_id"):
        if block.get("state") not in ("dispatching", "quarantined", "dispatched"):
            raise ValueError("attempt is not waiting for its session")
        block["session_id"] = session_id
        if block.get("state") != "quarantined":
            block["state"] = "dispatched"
        return {"changed": True, "reason": "dispatched", "task_id": str(task_id),
                "status": task.get("status"), "attempts": attempts_of(task)}
    if same_session or same_key:
        return {
            "changed": False, "reason": "already_dispatched",
            "task_id": str(task.get("id") or ""),
            "status": str(task.get("status") or ""), "attempts": attempts_of(task),
        }
    if str(task.get("status") or "") != STATUS_TODO or block.get("outcome") == OUTCOME_CLOSED:
        raise ValueError("task is not available for a new attempt")
    max_attempts, _stale_hours = limits(manifest)
    if attempts_of(task) >= max_attempts:
        raise ValueError("task has exhausted its attempt budget")
    if any(isinstance(other, Mapping) and other is not task
           and blocks_lane(other, discovery=task.get("task_type") == "project_discovery")
           for other in tasks_of(manifest)):
        raise ValueError("another worker in this lane is active or quarantined")
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
    block.pop("provenance", None)
    block.pop("session_state", None)
    block.pop("research_detached", None)
    block.pop("feedback_nudge", None)
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
    resolved_quarantine = block.get("state") == "quarantined" and outcome in (*TERMINAL_OUTCOMES, OUTCOME_FAILED)
    parked = recovering or resolved_quarantine or (awaiting_review(task) and outcome in (OUTCOME_MERGED, OUTCOME_CLOSED))
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
        block.pop("last_error", None)
        if block.get("report_repair"):
            block["report_repair"]["status"] = "resolved"
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
    if outcome == OUTCOME_STALE:
        return quarantine(manifest, str(task_id), reason=note or "worker outcome unknown", now=now)
    return _finish(
        manifest, task, outcome=outcome, note=note, pull_request=pull_request, now=now,
        retry_report=retry_report,
    )


def match_task(manifest: Mapping[str, Any], *, pull_request: Any = 0,
               pr: Mapping | None = None, repository: str = "",
               integration_branch: str = "autonomous/lab") -> tuple:
    """Only an exact controller receipt can identify an external PR."""
    from jules_provenance import trusted_pull_request
    if not isinstance(pr, Mapping) or not repository:
        return None, "unmatched"
    if pull_request and _int(pull_request) != pr.get("number"):
        return None, "conflicting_pull_request"
    candidates = [task for task in tasks_of(manifest) if isinstance(task, Mapping)
                  and trusted_pull_request(task, pr, repository, integration_branch)]
    return (candidates[0], "session_provenance") if len(candidates) == 1 else (None, "unmatched")


def close_from_pr(
    manifest: dict,
    *,
    pull_request: Any,
    merged: bool = False,
    note: str = "",
    now: datetime | None = None,
    pr: Mapping | None = None,
    repository: str = "",
    integration_branch: str = "autonomous/lab",
) -> dict:
    """Close the task a finished pull request belongs to. Safe to run twice."""
    number = _int(pull_request)
    task, how = match_task(manifest, pull_request=number, pr=pr, repository=repository,
                           integration_branch=integration_branch)
    if task is None:
        return {
            "changed": False,
            "reason": "no_matching_task",
            "matched_by": how,
            "task_id": "",
            "pull_request": number,
        }
    status = str(task.get("status") or "")
    execution = task.get("execution") or {}
    if status not in OPEN_STATUSES and not awaiting_review(task) and execution.get("state") != "quarantined":
        return {
            "changed": False,
            "reason": "task_already_closed",
            "matched_by": how,
            "task_id": str(task.get("id") or ""),
            "status": status,
            "pull_request": number,
        }
    if not awaiting_review(task) and session_is_active({"state": execution.get("session_state")}):
        return {"changed": False, "reason": "session_not_terminal", "matched_by": how,
                "task_id": str(task.get("id") or ""), "status": status, "pull_request": number}
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


def sweep(manifest: dict, pull_requests: Sequence[Any], *, now: datetime | None = None,
          config: Mapping[str, Any] | None = None, repository: str = "") -> dict:
    """Observe trusted proposals; only session completion frees an active worker."""
    config = config or {}
    project = config.get("project") or {}
    repository = repository or config.get("repository") or (project.get("repository", "") if isinstance(project, Mapping) else "")
    branch = config.get("automation", {}).get("integration_branch", "autonomous/lab")
    changes = []
    for entry in pull_requests or []:
        if not isinstance(entry, Mapping):
            continue
        task, how = match_task(manifest, pr=entry, repository=repository, integration_branch=branch)
        execution = (task or {}).get("execution") or {}
        if task is None or (task.get("status") != STATUS_IN_PROGRESS and not awaiting_review(task)
                            and execution.get("state") != "quarantined"):
            continue
        if not awaiting_review(task) and session_is_active({"state": execution.get("session_state")}):
            continue
        state = str(entry.get("state") or "").upper()
        merged = entry.get("merged") is True or bool(entry.get("merged_at")) or bool(entry.get("mergedAt")) or state == "MERGED"
        if merged or state == "CLOSED":
            result = _finish(manifest, task, outcome=OUTCOME_MERGED if merged else OUTCOME_CLOSED,
                             pull_request=entry["number"], now=now,
                             note="trusted proposal merged" if merged else "proposal declined; no automatic retry")
            result.update(matched_by=how, pull_request=entry["number"])
            if result["changed"]:
                changes.append(result)
        elif state == "OPEN" and not awaiting_review(task):
            changes.append(defer_review(task, entry["number"]))
    return {"changed": bool(changes), "reason": "swept" if changes else "nothing_to_sweep",
            "changes": changes, "linked": [], "task_id": changes[0]["task_id"] if changes else ""}


def reconcile(manifest: dict, *, now: datetime | None = None) -> dict:
    """Normalize local state before API reads without inventing worker outcomes."""
    moment = now or utcnow()
    max_attempts, stale_hours = limits(manifest)
    cutoff = moment - timedelta(hours=stale_hours)
    released = []
    for task in tasks_of(manifest):
        if not isinstance(task, dict):
            continue
        block = task.get("execution") or {}
        if task.get("status") == STATUS_TODO and block.get("outcome") == OUTCOME_CLOSED:
            task["status"] = STATUS_DONE
            block["state"] = "completed"
            released.append({"changed": True, "reason": OUTCOME_CLOSED, "task_id": task["id"]})
        elif task.get("status") == STATUS_TODO and attempts_of(task) >= max_attempts:
            task["status"] = STATUS_BLOCKED
            block["state"] = "exhausted"
            released.append({"changed": True, "reason": "exhausted", "task_id": task["id"]})
        elif task.get("status") == STATUS_IN_PROGRESS:
            # Waiting for the owner is not stale processing. Preserve identity;
            # explicit loop-disabled quarantine remains a separate transition.
            if block.get("session_state") in {"AWAITING_USER_FEEDBACK", "AWAITING_PLAN_APPROVAL", "PAUSED"}:
                continue
            changed_at = max((transition for field in ("observed_at", "started_at")
                              if (transition := parse_iso(block.get(field))) is not None), default=None)
            if changed_at is None or changed_at <= cutoff:
                released.append(quarantine(manifest, task["id"], reason="worker outcome unknown after " + str(stale_hours) + "h", now=moment))
    return {"changed": bool(released), "reason": "reconciled" if released else "nothing_stale",
            "released": released, "task_id": released[0]["task_id"] if released else ""}


def counts(manifest: Mapping[str, Any]) -> dict:
    out = {"proposed": 0, STATUS_TODO: 0, STATUS_IN_PROGRESS: 0, STATUS_DONE: 0, STATUS_BLOCKED: 0}
    for task in tasks_of(manifest):
        if not isinstance(task, dict):
            continue
        status = str(task.get("status") or "")
        if status in out:
            out[status] += 1
    return out




def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument(
        "--action", required=True,
        choices=("reserve", "quarantine", "start", "complete", "close-from-pr", "sweep", "reconcile"),
    )
    parser.add_argument("--task-id", default="")
    parser.add_argument("--session-id", default="")
    parser.add_argument("--dispatch-key", default="")
    parser.add_argument("--base-sha", default="")
    parser.add_argument("--starting-branch", default="")
    parser.add_argument("--repository", default="")
    parser.add_argument("--pr-json", type=Path)
    parser.add_argument("--outcome", default="")
    parser.add_argument("--note", default="")
    parser.add_argument("--pull-request", default="0")
    parser.add_argument("--merged", default="false")
    parser.add_argument(
        "--pull-requests", default="",
        help="JSON array of REST pull requests with repository, base and head identity",
    )
    parser.add_argument("--out", type=Path, help="write the manifest here instead of in place")
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args(argv)

    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print("::error::cannot read the task manifest: " + str(exc), file=sys.stderr)
        return 1

    try:
        if args.action == "reserve":
            result = reserve(manifest, args.task_id, args.dispatch_key,
                             base_sha=args.base_sha, starting_branch=args.starting_branch)
        elif args.action == "quarantine":
            result = quarantine(manifest, args.task_id, reason=args.note)
        elif args.action == "start":
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
                manifest, pull_request=args.pull_request,
                merged=_truthy(args.merged), note=args.note,
                pr=json.loads(args.pr_json.read_text(encoding="utf-8")) if args.pr_json else None,
                repository=args.repository,
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
            result = sweep(manifest, entries, config=config, repository=args.repository)
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
