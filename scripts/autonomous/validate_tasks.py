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
    "", "dispatching", "dispatched", "quarantined", "completed", "retry", "exhausted", "awaiting_review", "awaiting_report",
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


def _validate_report_source(source: Any, prefix: str) -> list:
    if not isinstance(source, dict):
        return [prefix + " must be an object"]
    errors = []
    session = str(source.get("session_id") or "")
    resource = session if session.startswith("sessions/") else "sessions/" + session
    if not re.fullmatch(r"sessions/[A-Za-z0-9_-]+", resource):
        errors.append(prefix + ".session_id must identify a Jules session")
    if not re.fullmatch(re.escape(resource) + r"/activities/[^/]+", str(source.get("activity_id") or "")):
        errors.append(prefix + ".activity_id must belong to the source session")
    if not _nonblank(source.get("dispatch_key")):
        errors.append(prefix + ".dispatch_key is required")
    if not re.fullmatch(r"[0-9a-f]{64}", str(source.get("report_sha256") or "")):
        errors.append(prefix + ".report_sha256 must be a SHA-256 digest")
    if not _utc_timestamp(source.get("activity_created_at")):
        errors.append(prefix + ".activity_created_at must be an ISO UTC timestamp")
    return errors


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
    if "source" in block:
        errors.extend(_validate_report_source(block["source"], prefix + ".source"))
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
    if type(block.get("attempts", 0)) is not int or block.get("attempts", 0) < 0:
        errors.append(prefix + ".execution.attempts must be a non-negative integer")
    if str(block.get("outcome", "")) not in VALID_OUTCOMES:
        errors.append(
            prefix + ".execution.outcome must be one of " + str(sorted(VALID_OUTCOMES))
        )
    if str(block.get("state", "")) not in VALID_EXECUTION_STATES:
        errors.append(
            prefix + ".execution.state must be one of " + str(sorted(VALID_EXECUTION_STATES))
        )
    if type(block.get("pull_request", 0)) is not int or block.get("pull_request", 0) < 0:
        errors.append(prefix + ".execution.pull_request must be a non-negative integer")
    if block.get("session_id") and not re.fullmatch(r"(?:sessions/)?[A-Za-z0-9_-]+", str(block["session_id"])):
        errors.append(prefix + ".execution.session_id must identify a Jules session")
    if "base_sha" in block or "starting_branch" in block or block.get("state") == "dispatching":
        if not re.fullmatch(r"[0-9a-fA-F]{40}", str(block.get("base_sha") or "")):
            errors.append(prefix + ".execution.base_sha must be an immutable commit SHA")
        key = block.get("dispatch_key")
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", key) or block.get("starting_branch") != "autonomous/attempt-" + key:
            errors.append(prefix + ".execution.starting_branch must identify the reserved attempt")
    receipt = block.get("provenance")
    if receipt is not None:
        if not isinstance(receipt, dict):
            errors.append(prefix + ".execution.provenance must be an object")
        else:
            if any(not block.get(field) or receipt.get(field) != block.get(field) for field in ("session_id", "dispatch_key", "pull_request")):
                errors.append(prefix + ".execution.provenance must belong to the current attempt")
            repository = receipt.get("repository")
            if not isinstance(repository, str) or not re.fullmatch(r"[^/\s]+/[^/\s]+", repository):
                errors.append(prefix + ".execution.provenance.repository is invalid")
            elif receipt.get("url") != "https://github.com/" + repository + "/pull/" + str(block.get("pull_request")):
                errors.append(prefix + ".execution.provenance.url must identify the recorded PR")
            if receipt.get("head_repository") != repository or any(not _nonblank(receipt.get(field)) for field in ("base_branch", "head_ref")):
                errors.append(prefix + ".execution.provenance requires same-repository branch identity")
            if not re.fullmatch(r"[0-9a-fA-F]{40}", str(receipt.get("head_sha") or "")) or not _utc_timestamp(receipt.get("verified_at")):
                errors.append(prefix + ".execution.provenance requires verified head SHA and timestamp")
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
        elif not re.fullmatch(r"[^\s<>`]+", task_id):
            errors.append(prefix + ".id must round-trip through task markers without whitespace or delimiters")
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
        execution = task.get("execution")
        if isinstance(execution, dict):
            state, outcome = execution.get("state"), execution.get("outcome", "")
            expected = {"dispatching": "in_progress", "dispatched": "in_progress",
                        "quarantined": "blocked", "completed": "done", "retry": "todo", "exhausted": "blocked"}
            if state in expected and status != expected[state]:
                errors.append(prefix + ".execution.state contradicts task status")
            if state in ("dispatching", "dispatched") and outcome:
                errors.append(prefix + ".active execution cannot have an outcome")
            if state == "dispatching" and (execution.get("session_id") or type(execution.get("attempts")) is not int or execution["attempts"] < 1):
                errors.append(prefix + ".dispatching requires one reserved unbound attempt")
            if state == "quarantined" and outcome != "stale":
                errors.append(prefix + ".quarantined execution requires stale outcome")
            source = (task.get("research_result") or {}).get("source") if isinstance(task.get("research_result"), dict) else None
            if isinstance(source, dict) and any(source.get(field) != execution.get(field) for field in ("session_id", "dispatch_key")):
                errors.append(prefix + ".research_result.source must belong to the stored attempt")
        origin = task.get("origin")
        if isinstance(origin, dict) and ("activity_id" in origin or "report_sha256" in origin):
            errors.extend(_validate_report_source(origin, prefix + ".origin"))
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
