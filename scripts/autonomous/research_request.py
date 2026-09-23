#!/usr/bin/env python3
"""Controller-owned research intent. A saved prompt is not proof of its claims."""
from __future__ import annotations

import copy
import hashlib
import json
import re
from datetime import datetime, timezone

CONTRACT_VERSION = "post-revisit-v1"
LEGACY_VERSION = "legacy-pr82"
MAX_CONTEXT_ENTRIES = 10
MAX_DECISION_CONTEXT_CHARS = 12000
MAX_REVISIT_TEXT_CHARS = 4000
CHANGE_KINDS = frozenset({"code_change", "new_evidence", "changed_conditions",
                          "different_contract", "rationale_reassessment"})
EVIDENCE_MODES = frozenset({"real_runtime", "static_analysis", "mock_or_model",
                           "hypothesis", "unavailable"})
CONTEXT_BEGIN = "AUTONOMOUS_DECISION_CONTEXT_BEGIN\n"
CONTEXT_END = "\nAUTONOMOUS_DECISION_CONTEXT_END"
ATTEMPT_FIELDS = frozenset({"attempts", "session_id", "dispatch_key", "base_sha",
                            "starting_branch", "research_request"})


def canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_json(value) -> str:
    return sha256_text(canonical_json(value))


def decision_entry(task: dict, delivered_text: str | None = None) -> dict:
    decision = task["proposal_decision"]
    note = decision.get("note") or ""
    text = note if delivered_text is None else delivered_text
    entry = {"task_id": task["id"], "action": decision["action"],
             "decision_at": decision["at"], "full_note_sha256": sha256_text(note),
             "delivered_text": text, "delivered_sha256": sha256_text(text),
             "complete": text == note, "truncated": text != note}
    entry["context_id"] = sha256_json(entry)
    return entry


def snapshot(request: dict, context: list[dict], controller_sha: str) -> dict:
    return {"contract_version": CONTRACT_VERSION, "controller_sha": controller_sha,
            "request_sha256": sha256_json(request), "request": copy.deepcopy(request),
            "decision_context_sha256": sha256_json(context), "decision_context": copy.deepcopy(context)}


def _utc(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return stamp.tzinfo is not None and stamp.utcoffset() == timezone.utc.utcoffset(stamp)
    except ValueError:
        return False


def accepted_report(task: dict) -> bool:
    execution = task.get("execution") or {}
    return (task.get("status") == "done" and execution.get("state") == "completed"
            and execution.get("outcome") in {"researched", "no_change"}
            and isinstance(task.get("research_result"), dict))


def validate_task_request(task: dict, *, required: bool = False, prefix: str = "task") -> list[str]:
    errors = _validate_attempt_request(task, required=required, prefix=prefix)
    execution = task.get("execution")
    if not isinstance(execution, dict):
        return errors
    history = execution.get("research_request_history", [])
    if not isinstance(history, list) or (history and task.get("task_type") != "project_discovery"):
        return errors + [prefix + ".execution.research_request_history must contain research attempts"]
    previous_attempt = 0
    keys = {execution.get("dispatch_key")} if isinstance(execution.get("dispatch_key"), str) else set()
    for index, record in enumerate(history):
        location = prefix + ".execution.research_request_history[" + str(index) + "]"
        if (not isinstance(record, dict) or set(record) - ATTEMPT_FIELDS
                or "research_request" not in record or type(record.get("attempts")) is not int
                or type(execution.get("attempts")) is not int
                or not previous_attempt < record["attempts"] < execution["attempts"]
                or not isinstance(record.get("session_id", ""), str)
                or not isinstance(record.get("dispatch_key"), str) or not record["dispatch_key"]
                or record["dispatch_key"] in keys):
            errors.append(location + " must retain an ordered, unique earlier attempt")
            continue
        previous_attempt = record["attempts"]
        keys.add(record["dispatch_key"])
        errors.extend(_validate_attempt_request(dict(task, execution=record), prefix=location))
    return errors


def _validate_attempt_request(task: dict, *, required: bool = False, prefix: str = "task") -> list[str]:
    execution = task.get("execution")
    if not isinstance(execution, dict):
        return []  # The task validator reports invalid execution shapes.
    block = execution.get("research_request")
    location = prefix + ".execution.research_request"
    if block is None:
        if (required and task.get("task_type") == "project_discovery"
                and execution.get("attempts", 0) and not accepted_report(task)):
            return [location + " is required for this attempted research"]
        return []
    if task.get("task_type") != "project_discovery" or not isinstance(block, dict):
        return [location + " requires a research task and object"]
    if block.get("contract_version") == LEGACY_VERSION:
        return ([] if block == {"contract_version": LEGACY_VERSION, "context_provenance": "not_recorded"}
                and type(execution.get("attempts")) is int and execution["attempts"] > 0
                else [location + " requires an existing legacy attempt with unrecorded context"])
    if block.get("contract_version") != CONTRACT_VERSION:
        return [location + " has an unsupported contract version"]
    errors = []
    if not re.fullmatch(r"[0-9a-f]{40}", str(block.get("controller_sha") or "")):
        errors.append(location + ".controller_sha must pin the controller revision")
    context = block.get("decision_context")
    try:
        if (not isinstance(context, list) or len(context) > MAX_CONTEXT_ENTRIES
                or len(canonical_json(context)) > MAX_DECISION_CONTEXT_CHARS
                or block.get("decision_context_sha256") != sha256_json(context)):
            raise ValueError("context snapshot")
        seen = set()
        for entry in context:
            if (not isinstance(entry, dict) or not isinstance(entry.get("task_id"), str)
                    or not entry["task_id"] or entry["task_id"] in seen
                    or entry.get("action") not in {"reject", "resolve"}
                    or not _utc(entry.get("decision_at"))
                    or type(entry.get("complete")) is not bool
                    or type(entry.get("truncated")) is not bool
                    or entry["complete"] == entry["truncated"]
                    or not isinstance(entry.get("delivered_text"), str)
                    or entry.get("delivered_sha256") != sha256_text(entry["delivered_text"])
                    or not re.fullmatch(r"[0-9a-f]{64}", str(entry.get("full_note_sha256") or ""))
                    or (entry["complete"] and entry["delivered_sha256"] != entry["full_note_sha256"])
                    or entry.get("context_id") != sha256_json({k: v for k, v in entry.items() if k != "context_id"})):
                raise ValueError("decision context entry")
            seen.add(entry["task_id"])
    except (ValueError, TypeError, KeyError):
        errors.append(location + " has invalid decision context identity or budget")
    request = block.get("request")
    try:
        prompt = request["prompt"]
        expected_markers = ("AUTONOMOUS_DISPATCH_KEY: " + execution["dispatch_key"]
                            + "\nAUTONOMOUS_TASK_ID: " + task["id"] + "\n\n")
        if (set(request) != {"prompt", "title", "sourceContext", "requirePlanApproval"}
                or not isinstance(prompt, str) or not prompt.startswith(expected_markers)
                or not isinstance(request["title"], str)
                or not request["title"].startswith("[dispatch:" + execution["dispatch_key"] + "] ")
                or request["requirePlanApproval"] is not False
                or not re.fullmatch(r"sources/github/[^/\s]+/[^/\s]+", request["sourceContext"]["source"])
                or request["sourceContext"]["githubRepoContext"]["startingBranch"] != execution["starting_branch"]
                or execution["starting_branch"] != "autonomous/attempt-" + execution["dispatch_key"]
                or not re.fullmatch(r"[0-9a-f]{40}", str(execution.get("base_sha") or ""))
                or ("Research only on exact pinned base " + execution["base_sha"] + ".") not in prompt
                or type(execution.get("attempts")) is not int or execution["attempts"] < 1
                or CONTEXT_BEGIN + canonical_json(context) + CONTEXT_END not in prompt
                or block.get("request_sha256") != sha256_json(request)):
            raise ValueError("request identity")
    except (ValueError, TypeError, KeyError):
        errors.append(location + " does not match the saved request and attempt")
    return errors


def saved_request(task: dict) -> dict | None:
    """Only v1 has reproducible bytes. Legacy lookup never gains create authority."""
    errors = validate_task_request(task)
    if errors:
        raise ValueError("; ".join(errors))
    block = (task.get("execution") or {}).get("research_request") or {}
    return copy.deepcopy(block["request"]) if block.get("contract_version") == CONTRACT_VERSION else None


def migrate_legacy(manifest: dict) -> tuple[dict, list[str]]:
    """Upgrade the live schema; old integer-only readers fail closed after cutover."""
    policy = manifest.get("autonomous_loop_policy") or {}
    version = policy.get("research_contract")
    if version not in (None, CONTRACT_VERSION):
        raise ValueError("unsupported research policy version")
    if version == CONTRACT_VERSION and manifest.get("version") == CONTRACT_VERSION:
        errors = [error for task in manifest.get("tasks", [])
                  for error in validate_task_request(task, required=True)]
        if errors:
            raise ValueError("; ".join(errors))
        return manifest, []
    updated = copy.deepcopy(manifest)
    tagged = []
    for task in updated.get("tasks", []):
        execution = task.get("execution") or {}
        if (task.get("task_type") == "project_discovery" and execution.get("attempts", 0)
                and not accepted_report(task) and "research_request" not in execution):
            execution["research_request"] = {"contract_version": LEGACY_VERSION,
                                              "context_provenance": "not_recorded"}
            tagged.append(task["id"])
    updated["version"] = CONTRACT_VERSION
    updated.setdefault("autonomous_loop_policy", {})["research_contract"] = CONTRACT_VERSION
    return updated, tagged
