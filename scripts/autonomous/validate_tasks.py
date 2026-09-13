#!/usr/bin/env python3
"""Validate agent_tasks.json structure, lifecycle bookkeeping and evidence."""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta
import sys
from pathlib import Path
from typing import Any

VALID_STATUSES = {"todo", "in_progress", "done", "blocked"}
VALID_RISKS = {"low", "medium", "high"}
VALID_TASK_TYPES = {
    "product_improvement", "bugfix", "test_coverage", "refactor",
    "project_discovery", "chore",
}
VALID_OUTCOMES = {
    "", "merged", "no_change", "researched", "review_required", "report_invalid", "closed_unmerged", "failed", "stale",
}
VALID_EXECUTION_STATES = {
    "", "dispatched", "completed", "retry", "exhausted", "awaiting_review", "awaiting_report",
}

MAX_PREVIOUS_REPORTS = 3
MAX_PREVIOUS_REPORT_CHARS = 24000


def _nonblank(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _string_list(value: Any) -> bool:
    return isinstance(value, list) and all(_nonblank(item) for item in value)


def _utc_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or "T" not in value:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0)
    except ValueError:
        return False


def validate_research_result(block: Any, prefix: str = "research_result") -> list:
    if not isinstance(block, dict):
        return [prefix + " must be an object"]
    errors = []
    if not _nonblank(block.get("summary")):
        errors.append(prefix + ".summary must be a non-empty string")
    observations = block.get("observations")
    if not isinstance(observations, list) or not observations:
        errors.append(prefix + ".observations must be a non-empty list")
    else:
        for index, observation in enumerate(observations):
            if not isinstance(observation, dict) or any(
                not _nonblank(observation.get(field))
                for field in ("scenario", "evidence", "result")
            ):
                errors.append(prefix + ".observations[" + str(index)
                              + "] requires non-empty scenario, evidence and result strings")
    for field in ("next_hypotheses", "proposed_task_ids"):
        if not _string_list(block.get(field)):
            errors.append(prefix + "." + field + " must be a list of non-empty strings")
    if not _utc_timestamp(block.get("completed_at")):
        errors.append(prefix + ".completed_at must be an ISO UTC timestamp")
    deferred = block.get("deferred_findings", [])
    if not isinstance(deferred, list):
        errors.append(prefix + ".deferred_findings must be a list")
    else:
        for item in deferred:
            if (not isinstance(item, dict)
                    or any(not _nonblank(item.get(field)) for field in ("title", "reason", "evidence"))
                    or any(not _string_list(item.get(field)) or not item[field]
                           for field in ("target_paths", "acceptance"))):
                errors.append(prefix + ".deferred_findings requires a proposal and its exclusion reason")
    return errors


def _validate_research(task: dict, prefix: str) -> list:
    errors = []
    research = task.get("research")
    if "research" in task:
        if not isinstance(research, dict):
            return [prefix + ".research must be an object"]
        if task.get("task_type") != "project_discovery":
            errors.append(prefix + ".research requires project_discovery task_type")
        for field in ("area_id", "perspective_id"):
            if not _nonblank(research.get(field)):
                errors.append(prefix + ".research." + field + " must be a non-empty string")
        if not isinstance(research.get("fingerprint"), str) or not re.fullmatch(
            r"[0-9a-f]{64}", research.get("fingerprint", "")
        ):
            errors.append(prefix + ".research.fingerprint must be a SHA-256 hex digest")
        cycle = research.get("cycle")
        if type(cycle) is not int or cycle < 1:
            errors.append(prefix + ".research.cycle must be a positive integer")
        reports = research.get("previous_reports")
        if not isinstance(reports, list) or len(reports) > MAX_PREVIOUS_REPORTS:
            errors.append(prefix + ".research.previous_reports must be a bounded list")
        else:
            if len(json.dumps(reports, ensure_ascii=False)) > MAX_PREVIOUS_REPORT_CHARS:
                errors.append(prefix + ".research.previous_reports exceeds context bound")
            for index, report in enumerate(reports):
                errors.extend(validate_research_result(
                    report, prefix + ".research.previous_reports[" + str(index) + "]",
                ))
    if "research_result" in task:
        errors.extend(validate_research_result(task["research_result"], prefix + ".research_result"))
    if research and task.get("status") == "done" and "research_result" not in task:
        errors.append(prefix + ".completed research requires research_result")
    execution = task.get("execution")
    if isinstance(execution, dict):
        outcome, state = execution.get("outcome"), execution.get("state")
        if outcome == "researched" and (
            task.get("status") != "done" or state != "completed"
            or "research_result" not in task
        ):
            errors.append(prefix + ".researched requires done/completed and research_result")
        if state == "awaiting_review" or outcome == "review_required":
            if (task.get("status"), state, outcome) != ("blocked", "awaiting_review", "review_required"):
                errors.append(prefix + ".manual review requires blocked/awaiting_review/review_required")
        if state == "awaiting_report" or outcome == "report_invalid" or "report_error" in execution:
            if (task.get("status"), state, outcome) != ("blocked", "awaiting_report", "report_invalid"):
                errors.append(prefix + ".report recovery requires blocked/awaiting_report/report_invalid")
            if (task.get("task_type") != "project_discovery"
                    or not _nonblank(execution.get("session_id"))
                    or not _nonblank(execution.get("dispatch_key"))
                    or type(execution.get("attempts")) is not int or execution["attempts"] < 1
                    or execution.get("pull_request")):
                errors.append(prefix + ".report recovery requires a bound research attempt without a PR")
            issue = execution.get("report_error")
            if (not isinstance(issue, dict)
                    or not _nonblank(issue.get("code")) or not _nonblank(issue.get("detail"))
                    or not _utc_timestamp(issue.get("reported_at"))):
                errors.append(prefix + ".report_error requires code, detail and an ISO UTC reported_at")
    return errors

def _validate_execution(block: Any, prefix: str) -> list:
    errors: list = []
    if block is None:
        return errors
    if not isinstance(block, dict):
        return [prefix + ".execution must be an object"]
    if not isinstance(block.get("attempts", 0), int):
        errors.append(prefix + ".execution.attempts must be an integer")
    if str(block.get("outcome", "")) not in VALID_OUTCOMES:
        errors.append(
            prefix + ".execution.outcome must be one of " + str(sorted(VALID_OUTCOMES))
        )
    if str(block.get("state", "")) not in VALID_EXECUTION_STATES:
        errors.append(
            prefix + ".execution.state must be one of " + str(sorted(VALID_EXECUTION_STATES))
        )
    if not isinstance(block.get("pull_request", 0), int):
        errors.append(prefix + ".execution.pull_request must be an integer")
    return errors


def validate(manifest: Any) -> list:
    errors: list = []
    if not isinstance(manifest, dict):
        return ["manifest must be a JSON object"]
    if not isinstance(manifest.get("version"), int):
        errors.append("version must be an integer")
    policy = manifest.get("autonomous_loop_policy")
    if not isinstance(policy, dict):
        errors.append("autonomous_loop_policy must be an object")
    else:
        lifecycle = policy.get("lifecycle")
        if lifecycle is not None:
            if not isinstance(lifecycle, dict):
                errors.append("autonomous_loop_policy.lifecycle must be an object")
            else:
                for field in ("max_attempts", "stale_in_progress_hours"):
                    value = lifecycle.get(field)
                    if value is not None and (not isinstance(value, int) or value < 1):
                        errors.append(
                            "autonomous_loop_policy.lifecycle." + field
                            + " must be a positive integer"
                        )
    tasks = manifest.get("tasks")
    if not isinstance(tasks, list):
        return errors + ["tasks must be a list"]

    seen_ids: set = set()
    in_progress = 0
    for index, task in enumerate(tasks):
        prefix = "tasks[" + str(index) + "]"
        if not isinstance(task, dict):
            errors.append(prefix + " must be an object")
            continue
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id.strip():
            errors.append(prefix + ".id must be a non-empty string")
        else:
            if task_id in seen_ids:
                errors.append(prefix + ".id " + repr(task_id) + " is duplicated")
            seen_ids.add(task_id)
        if not isinstance(task.get("title"), str) or not str(task.get("title")).strip():
            errors.append(prefix + ".title must be a non-empty string")
        status = str(task.get("status"))
        if status not in VALID_STATUSES:
            errors.append(prefix + ".status must be one of " + str(sorted(VALID_STATUSES)))
        if status == "in_progress":
            in_progress += 1
        if str(task.get("task_type")) not in VALID_TASK_TYPES:
            errors.append(prefix + ".task_type must be one of " + str(sorted(VALID_TASK_TYPES)))
        if str(task.get("risk")) not in VALID_RISKS:
            errors.append(prefix + ".risk must be one of " + str(sorted(VALID_RISKS)))
        if not isinstance(task.get("priority"), int):
            errors.append(prefix + ".priority must be an integer")
        if not isinstance(task.get("focus"), list):
            errors.append(prefix + ".focus must be a list")
        evidence = task.get("evidence")
        if not isinstance(evidence, dict):
            errors.append(prefix + ".evidence must be an object")
        else:
            if not str(evidence.get("source") or "").strip():
                errors.append(prefix + ".evidence.source is required")
            if not str(evidence.get("detail") or "").strip():
                errors.append(prefix + ".evidence.detail is required")
        errors.extend(_validate_execution(task.get("execution"), prefix))
        errors.extend(_validate_research(task, prefix))

    # The loop runs one worker session at a time; more than one in-flight task
    # means a lifecycle transition was lost and the queue is no longer truthful.
    if in_progress > 1:
        errors.append(
            "only one task may be in_progress at a time, found " + str(in_progress)
        )
    return errors


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print("ERROR: cannot read manifest: " + str(exc), file=sys.stderr)
        return 1
    errors = validate(manifest)
    if errors:
        for err in errors:
            print("ERROR: " + err, file=sys.stderr)
        return 1
    print("agent_tasks.json is valid (" + str(len(manifest.get("tasks", []))) + " task(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
