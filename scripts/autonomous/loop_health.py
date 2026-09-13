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
from select_task import select
from task_lifecycle import awaiting_report, sweep
from validate_tasks import validate

STALL_AFTER = timedelta(minutes=90)
POLL_DELAY_SECONDS = 90
ACTIVE_RUN_STATUSES = {"queued", "in_progress", "waiting", "pending", "requested"}
FAILED_CONCLUSIONS = {"failure", "timed_out", "cancelled", "action_required", "startup_failure"}


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
    current_syncs = [run for run in sync_runs if run.get("head_branch") == default_branch
                     and _sync_main(run) == main_sha]
    completed_syncs = [run for run in current_syncs if run.get("status") == "completed"
                       and run.get("conclusion") in FAILED_CONCLUSIONS | {"success"}]
    last_sync = max(completed_syncs, key=lambda run: _run_time(run) or minimum, default=None)
    attention = []
    for task in manifest["tasks"]:
        execution = task.get("execution") or {}
        if awaiting_report(task):
            reported_at = _time((execution.get("report_error") or {}).get("reported_at"))
            attention.append({"reason": "report_invalid", "task_id": task["id"],
                              "observed_at": _iso(reported_at) if reported_at else None})
    failed_sync = not main_is_ancestor and last_sync is not None and last_sync.get("conclusion") in FAILED_CONCLUSIONS
    if failed_sync:
        attention.append({"reason": "sync_failed", "main_sha": main_sha, "run": _run_summary(last_sync)})
    result = {
        "health": "ok", "action": "none", "reason": "idle", "delay_seconds": 0,
        "main_sha": main_sha, "lab_sha": lab_sha, "main_is_ancestor": main_is_ancestor,
        "observed_at": _iso(now), "last_next_task": _run_summary(latest),
        "next_task_age_seconds": max(0, int((now - last_at).total_seconds())) if last_at else None,
        "last_sync": _run_summary(last_sync), "attention": attention,
        "research_next_at": None,
    }

    def decision(reason: str, action: str = "none", *, due: bool = False, delay: int = 0) -> dict:
        stalled = due and (last_at is None or now - last_at > STALL_AFTER)
        result.update(reason=reason, action=action, delay_seconds=delay,
                      health="attention" if attention else "stalled" if stalled else "ok")
        if stalled:
            result["attention"].append({"reason": "next_task_stalled", "observed_at": _iso(last_at) if last_at else None})
        return result

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
    blocking_labels = set(config.get("automation", {}).get(
        "blocking_labels", ["human-review", "hold", "do-not-merge", "wip"],
    ))
    active_prs = []
    for pr in pull_requests:
        labels = {label.get("name", "") if isinstance(label, dict) else label for label in pr.get("labels", [])}
        if str(pr.get("state", "")).lower() == "open" and not (pr.get("draft") or pr.get("isDraft") or labels & blocking_labels):
            active_prs.append(pr["number"])
    result["active_pull_requests"] = sorted(active_prs)
    if active_prs:
        return decision("open_pull_request")
    active_tasks = [task for task in data["tasks"] if task["status"] == "in_progress"]
    if active_tasks:
        if any(not (task.get("execution") or {}).get("session_id") for task in active_tasks):
            attention.append({"reason": "active_session_unbound"})
            return decision("active_session_unbound")
        return decision("active_polling", "next_task", due=True, delay=POLL_DELAY_SECONDS)
    if not main_is_ancestor:
        if failed_sync:
            return decision("sync_failed")
        return decision("sync_required", "sync")
    selection = select(data, risk_ceiling=config.get("risk_ceiling", "medium"))
    if selection["selected"]:
        return decision("work_due", "next_task", due=True)
    _, research = plan_research(data, config, fingerprints, now=now,
                                risk_ceiling=config.get("risk_ceiling", "medium"))
    if research["research_changed"]:
        return decision("research_due", "next_task", due=True)
    result["research_next_at"] = research["research_next_at"] or None
    return decision(research["research_reason"])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    for name in ("manifest", "config", "repo", "runs", "sync-runs", "pull-requests"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--enabled", required=True, choices=("true", "false"))
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
