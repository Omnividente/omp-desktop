#!/usr/bin/env python3
"""Read-only readiness and wakeup decisions for the autonomous lab controller."""
from __future__ import annotations

import argparse
import copy
import json
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from research_cycle import _iso, _time, plan_research, scope_fingerprints
from select_task import DISCOVERY_TYPE, blocks_lane, is_unresolved, select, valid_research_detachment
from task_lifecycle import awaiting_report, sweep
from validate_tasks import validate
from jules_provenance import trusted_pull_request
from sync_main import busy_reason

STALL_AFTER = timedelta(minutes=90)
POLL_INTERVAL = timedelta(minutes=5)
UNCHANGED_POLL_INTERVAL = timedelta(minutes=15)
UNCHANGED_AFTER = timedelta(minutes=30)
WAITING_POLL_INTERVAL = timedelta(minutes=30)
WAITING_REASONS = {
    "AWAITING_USER_FEEDBACK": "worker_awaiting_feedback",
    "AWAITING_PLAN_APPROVAL": "worker_awaiting_approval",
    "PAUSED": "worker_paused",
}
ACTIVE_RUN_STATUSES = {"queued", "in_progress", "waiting", "pending", "requested"}
FAILED_CONCLUSIONS = {"failure", "timed_out", "cancelled", "action_required", "startup_failure"}


def worker_observation(task: Mapping[str, Any], now: datetime) -> dict:
    execution = task.get("execution") or {}
    identifier = str(execution.get("session_id") or "").removeprefix("sessions/")
    safe_id = identifier if re.fullmatch(r"[A-Za-z0-9_-]+", identifier) else None
    state = execution.get("session_state") or "UNKNOWN"
    return {"task_id": task["id"], "session_id": safe_id,
            "session_url": "https://jules.google.com/session/" + safe_id if safe_id else None,
            "session_state": state, "observed_at": _iso(now),
            "state_changed_at": execution.get("observed_at"),
            "reason": WAITING_REASONS.get(state, "worker_running")}


def poll_due_at(tasks: Sequence[dict], completed_at: datetime | None, now: datetime) -> datetime:
    deadlines = []
    for task in tasks:
        execution = task.get("execution") or {}
        changed_at = max((at for field in ("observed_at", "started_at")
                          if (at := _time(execution.get(field))) is not None), default=None)
        interval = POLL_INTERVAL
        if (task.get("task_type") != DISCOVERY_TYPE or valid_research_detachment(task)
                or execution.get("session_state") in WAITING_REASONS):
            interval = WAITING_POLL_INTERVAL
        elif changed_at and now - changed_at >= UNCHANGED_AFTER:
            interval = UNCHANGED_POLL_INTERVAL
        anchor = max((at for at in (completed_at, changed_at) if at is not None), default=None)
        deadlines.append(anchor + interval if anchor else now)
    return min(deadlines, default=now)


def workflow_runs(value: Any) -> list[dict]:
    if isinstance(value, dict):
        value = value.get("workflow_runs")
    if not isinstance(value, list) or any(not isinstance(run, dict) for run in value):
        raise ValueError("runs must be a workflow_runs object or array")
    return value


def _run_time(run: Mapping[str, Any]) -> datetime | None:
    return max((moment for key in ("created_at", "run_started_at", "updated_at")
                if (moment := _time(run.get(key))) is not None), default=None)


def _run_summary(run: Mapping[str, Any] | None) -> dict | None:
    if run is None:
        return None
    moment = _run_time(run)
    return {"id": run.get("id"), "status": run.get("status"),
            "conclusion": run.get("conclusion"), "observed_at": _iso(moment) if moment else None}


def _sync_main(run: Mapping[str, Any]) -> str:
    match = re.fullmatch(r"Sync main ([0-9a-f]{40})", str(run.get("display_title") or ""))
    return match[1] if match else str(run.get("head_sha") or "")


def assess_health(
    manifest: Mapping[str, Any], config: Mapping[str, Any], *,
    main_sha: str, lab_sha: str, main_is_ancestor: bool,
    fingerprints: Mapping[str, str], runs: Sequence[dict], sync_runs: Sequence[dict],
    pull_requests: Sequence[dict], enabled: bool, now: datetime,
    state_sha: str = "", sync_result: Mapping[str, Any] | None = None,
) -> dict:
    """Plan against a private queue copy, never mint, reconcile or dispatch work."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now = now.astimezone(timezone.utc)
    errors = validate(manifest)
    if errors:
        raise ValueError("invalid task manifest")
    default_branch = config.get("default_branch", "main")
    ticks = [run for run in runs if run.get("head_branch") == default_branch
             and run.get("event") in {"schedule", "workflow_dispatch"}]
    minimum = datetime.min.replace(tzinfo=timezone.utc)
    latest = max(ticks, key=lambda run: _run_time(run) or minimum, default=None)
    last_at = _run_time(latest) if latest else None
    completed_at = max((_run_time(run) for run in ticks if run.get("status") == "completed"
                        and _run_time(run) is not None), default=None)
    current_syncs = [run for run in sync_runs if run.get("head_branch") == default_branch
                     and _sync_main(run) == main_sha]
    completed_syncs = [run for run in current_syncs if run.get("status") == "completed"
                       and run.get("conclusion") in FAILED_CONCLUSIONS | {"success"}]
    last_sync = max(completed_syncs, key=lambda run: _run_time(run) or minimum, default=None)
    attention = []
    proposals = []
    repository = config.get("repository", "")
    for task in manifest["tasks"]:
        execution = task.get("execution") or {}
        changed_at = max((at for field in ("observed_at", "started_at")
                          if (at := _time(execution.get(field))) is not None), default=None)
        age = max(0, int((now - changed_at).total_seconds())) if changed_at else None
        waiting = execution.get("session_state") in WAITING_REASONS
        if execution.get("state") == "quarantined":
            attention.append({"reason": "quarantined", "task_id": task["id"], "age_seconds": age})
        elif not waiting and task.get("status") == "in_progress" and (age is None or age > 24 * 3600):
            attention.append({"reason": "worker_stale", "task_id": task["id"], "age_seconds": age})
        for pr in pull_requests:
            if pr.get("state") != "open" or not trusted_pull_request(task, pr, repository, "autonomous/lab"):
                continue
            updated = _time(pr.get("updated_at"))
            proposal_age = max(0, int((now - updated).total_seconds())) if updated else None
            proposal = {"task_id": task["id"], "pull_request": pr["number"],
                        "head_sha": pr["head"]["sha"], "age_seconds": proposal_age,
                        "awaiting_human": execution.get("state") == "awaiting_review"}
            proposals.append(proposal)
            if pr.get("mergeable") is False or pr.get("mergeable_state") == "dirty":
                attention.append({"reason": "proposal_conflict", **proposal})
            elif pr.get("mergeable_state") == "behind":
                attention.append({"reason": "proposal_base_stale", **proposal})
            elif proposal_age is None or proposal_age > 7 * 24 * 3600:
                attention.append({"reason": "proposal_stale", **proposal})
    observed_sync = sync_result if sync_result and sync_result.get("main_sha") == main_sha else None
    if observed_sync and (observed_sync.get("publication") == "blocked" or observed_sync.get("status") == "conflict"):
        attention.append({"reason": "sync_outcome_blocked", "main_sha": main_sha,
                          "outcome": observed_sync.get("reason")})
    if observed_sync and (observed_sync.get("refresh") or {}).get("outcome") == "attention":
        attention.append({"reason": "proposal_refresh_attention", "refresh": observed_sync["refresh"]})
    if observed_sync and observed_sync.get("status") == "unknown":
        attention.append({"reason": "sync_outcome_missing"})
    for task in manifest["tasks"]:
        execution = task.get("execution") or {}
        if awaiting_report(task):
            reported_at = _time((execution.get("report_error") or {}).get("reported_at"))
            attention.append({"reason": "report_invalid", "task_id": task["id"],
                              "observed_at": _iso(reported_at) if reported_at else None})
    failed_sync = not main_is_ancestor and last_sync is not None and last_sync.get("conclusion") in FAILED_CONCLUSIONS
    failed_sync = failed_sync or bool(observed_sync and (observed_sync.get("publication") == "blocked" or observed_sync.get("status") == "conflict"))
    if failed_sync:
        attention.append({"reason": "sync_failed", "main_sha": main_sha, "run": _run_summary(last_sync)})
    result = {
        "health": "ok", "action": "none", "reason": "idle", "delay_seconds": 0,
        "main_sha": main_sha, "lab_sha": lab_sha, "main_is_ancestor": main_is_ancestor,
        "code_sha": lab_sha, "state_sha": state_sha, "sync_outcome": observed_sync,
        "proposals": proposals,
        "pending_proposals": sum(
            task.get("task_type") != DISCOVERY_TYPE
            and (task.get("status") == "proposed"
                 or (task.get("status") == "todo" and not task.get("proposal_decision")))
            for task in manifest["tasks"]
        ),
        "approved_proposals": sum(
            task.get("task_type") != DISCOVERY_TYPE and task.get("status") == "todo"
            and (task.get("proposal_decision") or {}).get("action") == "approve"
            for task in manifest["tasks"]
        ),
        "waiting_workers": [worker_observation(task, now) for task in manifest["tasks"]
                            if is_unresolved(task)
                            and (task.get("execution") or {}).get("session_state") in WAITING_REASONS],
        "observed_at": _iso(now), "last_next_task": _run_summary(latest),
        "next_task_age_seconds": max(0, int((now - last_at).total_seconds())) if last_at else None,
        "last_sync": _run_summary(last_sync), "attention": attention,
        "research_next_at": None, "due_at": None,
    }

    def decision(reason: str, action: str = "none", *, due: bool = False, delay: int = 0) -> dict:
        stalled = due and (last_at is None or now - last_at > STALL_AFTER)
        result.update(reason=reason, action=action, delay_seconds=delay,
                      health="attention" if attention else "stalled" if stalled else "ok")
        if stalled:
            result["attention"].append({"reason": "next_task_stalled", "observed_at": _iso(last_at) if last_at else None})
        return result

    def polling(reason: str, tasks: Sequence[dict]) -> dict:
        deadline = poll_due_at(tasks, completed_at, now)
        result["due_at"] = _iso(deadline)
        waiting = [worker_observation(task, now) for task in tasks
                   if (task.get("execution") or {}).get("session_state") in WAITING_REASONS]
        if waiting:
            reason = waiting[0]["reason"]
        if now < deadline:
            return decision(reason, delay=max(1, int((deadline - now).total_seconds())))
        # Human waiting is informational, not a controller failure or stalled processing.
        # Scheduled observations remain visible through next_task_age_seconds.
        return decision(reason, "next_task", due=not waiting)

    if not enabled:
        result.update(health="disabled", reason="loop_disabled")
        return result
    if any(run.get("status") in ACTIVE_RUN_STATUSES for run in runs):
        return decision("next_task_running", due=True)
    if any(run.get("status") in ACTIVE_RUN_STATUSES for run in sync_runs):
        return decision("sync_running")

    data = copy.deepcopy(manifest)
    reconciled = sweep(data, pull_requests, config=config, now=now)
    if reconciled["changed"]:
        return decision("reconciliation_due", "next_task", due=True)
    sync_blocker = busy_reason(data, [], config)
    unresolved = [task for task in data["tasks"] if is_unresolved(task)]
    if not main_is_ancestor:
        if sync_blocker:
            reason = "legacy_worker_reconciliation" if any(
                (task.get("execution") or {}).get("state") == "quarantined" for task in unresolved
            ) else "active_polling"
            return polling(reason, unresolved)
        if failed_sync:
            return decision("sync_failed")
        return decision("sync_required", "sync")
    for task in unresolved:
        execution = task.get("execution") or {}
        state = execution.get("session_state")
        if (task.get("task_type") == DISCOVERY_TYPE and state in WAITING_REASONS
                and "research_detached" not in execution):
            candidate = {**task, "execution": {**execution, "research_detached": {
                "at": _iso(now), "reason": state,
            }}}
            if valid_research_detachment(candidate):
                return decision("research_detachment_due", "next_task")
    foreground = [task for task in unresolved if blocks_lane(task, discovery=True)]
    if foreground:
        if any(not (task.get("execution") or {}).get("session_id") for task in foreground):
            attention.append({"reason": "active_session_unbound"})
            return polling("active_session_unbound", foreground)
        return polling("active_polling", foreground)
    selection = select(data, risk_ceiling=config.get("risk_ceiling", "medium"),
                       allow_discovery=(config.get("research") or {}).get("enabled", False))
    if selection["selected"]:
        return decision("work_due", "next_task", due=True)
    _, research = plan_research(data, config, fingerprints, now=now,
                                risk_ceiling=config.get("risk_ceiling", "medium"))
    if research["research_changed"]:
        return decision("research_due", "next_task", due=True)
    result["research_next_at"] = research["research_next_at"] or None
    if unresolved:
        return polling("active_polling", unresolved)
    return decision(research["research_reason"])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    for name in ("manifest", "config", "repo", "runs", "sync-runs", "pull-requests"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--enabled", required=True, choices=("true", "false"))
    parser.add_argument("--state-revision", type=Path)
    parser.add_argument("--sync-result", type=Path)
    parser.add_argument("--now")
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        now = _time(args.now) if args.now else datetime.now(timezone.utc)
        if now is None:
            raise ValueError("invalid now timestamp")
        main_ref = "refs/remotes/origin/" + config.get("default_branch", "main")
        def git(*command: str) -> str:
            return subprocess.check_output(["git", "-C", str(args.repo), *command], text=True, stderr=subprocess.DEVNULL).strip()
        main_sha, lab_sha = git("rev-parse", main_ref), git("rev-parse", "HEAD")
        ancestry = subprocess.run(["git", "-C", str(args.repo), "merge-base", "--is-ancestor", main_sha, lab_sha],
                                  check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
        if ancestry not in (0, 1):
            raise ValueError("cannot determine lab ancestry")
        fingerprints = scope_fingerprints(config, args.repo) if config.get("research", {}).get("enabled") else {}
        result = assess_health(
            manifest, config, main_sha=main_sha, lab_sha=lab_sha, main_is_ancestor=ancestry == 0,
            fingerprints=fingerprints, now=now, enabled=args.enabled == "true",
            runs=workflow_runs(json.loads(args.runs.read_text(encoding="utf-8"))),
            sync_runs=workflow_runs(json.loads(args.sync_runs.read_text(encoding="utf-8"))),
            pull_requests=json.loads(args.pull_requests.read_text(encoding="utf-8")),
            state_sha=(json.loads(args.state_revision.read_text(encoding="utf-8")).get("state_sha") or "") if args.state_revision else "",
            sync_result=json.loads(args.sync_result.read_text(encoding="utf-8")) if args.sync_result else None,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Never echo exception text: queue/report or subprocess data can contain secrets.
        print(json.dumps({"health": "attention", "action": "none", "reason": "health_input_error",
                          "delay_seconds": 0, "main_sha": None, "lab_sha": None}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
