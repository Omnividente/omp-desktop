#!/usr/bin/env python3
"""Harvest a bound, completed Jules attempt without requiring a pull request."""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_discovery_tasks import BEGIN, END, STATUS_OK, import_tasks, parse_block
from jules_dispatch import (
    DEFAULT_API_BASE, KeyRing, get_session, list_activities, session_id,
    session_matches, session_resource, session_state, urllib_transport,
)
from task_lifecycle import complete, find_task, iso, parse_iso, utcnow
from validate_tasks import validate, validate_research_result

RESEARCH_BEGIN = "AUTONOMOUS_RESEARCH_BEGIN"
RESEARCH_END = "AUTONOMOUS_RESEARCH_END"
MARKERS = (BEGIN, END, RESEARCH_BEGIN, RESEARCH_END)


class InvalidReport(ValueError):
    """A terminal worker output is defective, so spend this attempt once."""


def latest_report(activities: list) -> str:
    reports = []
    for activity in activities:
        message = activity.get("agentMessaged")
        texts = []
        if isinstance(message, dict) and isinstance(message.get("agentMessage"), str):
            texts.append(message["agentMessage"])
        if activity.get("originator") == "agent" or "sessionCompleted" in activity:
            description = activity.get("description")
            if isinstance(description, str) and description not in texts:
                texts.append(description)
        for text in texts:
            if not any(marker in text for marker in MARKERS):
                continue
            stamp = parse_iso(activity.get("createTime"))
            if stamp is None:
                raise InvalidReport("report activity lacks a valid createTime")
            reports.append((stamp, text))
    if not reports:
        raise InvalidReport("completed discovery has no marked report")
    newest = max(stamp for stamp, _text in reports)
    latest = {text for stamp, text in reports if stamp == newest}
    if len(latest) != 1:
        raise InvalidReport("conflicting reports have the same createTime")
    return next(iter(latest))


def research_report(text: str, *, completed_at: str) -> dict:
    match = re.search(RESEARCH_BEGIN + r"(.*?)" + RESEARCH_END, text, re.DOTALL)
    if text.count(RESEARCH_BEGIN) != 1 or text.count(RESEARCH_END) != 1 or match is None:
        raise InvalidReport("expected exactly one ordered research report block")
    raw = match.group(1).strip()
    if raw.startswith("-->"):
        raw = raw[3:].strip()
    if raw.endswith("<!--"):
        raw = raw[:-4].strip()
    fenced = re.fullmatch(r"```(?:json)?\s*\n(.*?)\n```", raw, re.DOTALL)
    if fenced:
        raw = fenced.group(1)
    try:
        report = json.loads(raw)
    except json.JSONDecodeError:
        raise InvalidReport("research report is not valid JSON") from None
    if not isinstance(report, dict):
        raise InvalidReport("research report must be an object")
    report = {field: report.get(field) for field in ("summary", "observations", "next_hypotheses")}
    report["proposed_task_ids"] = []
    report["completed_at"] = completed_at
    errors = validate_research_result(report)
    if errors:
        raise InvalidReport("research report does not satisfy the observation schema")
    return report


def bound_session(session: Mapping[str, Any], execution: Mapping[str, Any], resource: str = "") -> str:
    stored = str(execution.get("session_id") or "")
    if not stored or not session_matches(session, str(execution.get("dispatch_key") or "")):
        raise ValueError("session does not match the recorded dispatch attempt")
    name = str(session.get("name") or session_resource(session_id(session)))
    if stored not in (session_id(session), name) or (resource and name != resource):
        raise ValueError("session does not match the recorded session identity")
    return session_resource(name)


def harvest(manifest: dict, config: Mapping[str, Any], task_id: str, snapshot: Mapping[str, Any],
            *, transport=urllib_transport, api_base: str = DEFAULT_API_BASE,
            api_keys=(), now: datetime | None = None, max_new: int = 10) -> dict:
    """Stage imports and the authoritative lifecycle transition as one mutation.

    Transport/read failures leave the queue untouched. A malformed terminal report
    consumes the existing attempt through lifecycle.complete, never as no_change.
    """
    task = find_task(manifest, task_id)
    if task is None:
        raise ValueError("task not found")
    execution = task.get("execution") or {}
    resource = bound_session(snapshot, execution)
    if task.get("status") != "in_progress" or execution.get("outcome"):
        return {"changed": False, "reason": "attempt_already_resolved", "task_id": task_id,
                "imported_count": 0}
    ring = api_keys if isinstance(api_keys, KeyRing) else KeyRing(api_keys)
    if not ring:
        raise RuntimeError("no Jules API key is configured")
    session = get_session(transport, api_base, ring, resource)
    bound_session(session, execution, resource)
    if session_state(session) != "COMPLETED":
        return {"changed": False, "reason": "session_not_completed", "task_id": task_id,
                "imported_count": 0}
    outputs = session.get("outputs", [])
    if outputs is None:
        outputs = []
    if not isinstance(outputs, list) or any(not isinstance(output, dict) for output in outputs):
        raise RuntimeError("Jules GetSession returned invalid outputs")
    if execution.get("pull_request") or any("pullRequest" in output for output in outputs):
        return {"changed": False, "reason": "pull_request_pending_sweep", "task_id": task_id,
                "imported_count": 0}
    moment = now or utcnow()
    staged = copy.deepcopy(manifest)
    staged_task = find_task(staged, task_id)
    imported = {"added": [], "duplicates": [], "skipped": []}
    report = None
    try:
        if task.get("task_type") == "project_discovery":
            # Finish all API reads before any mutation, even for invalid output.
            text = latest_report(list_activities(transport, api_base, ring, resource))
            block = parse_block(text)
            if block["status"] != STATUS_OK:
                raise InvalidReport("completed discovery lacks a valid task array")
            report = research_report(text, completed_at=iso(moment))
            imported = import_tasks(staged, text, config=config, max_new=max_new, now=iso(moment),
                                    origin={"task_id": task_id,
                                            "session_id": str(execution["session_id"]),
                                            "dispatch_key": str(execution["dispatch_key"])})
            if imported["status"] != STATUS_OK:
                reasons = sorted({item["reason"] for item in imported["skipped"]})
                raise InvalidReport("invalid discovery findings" + (": " + ", ".join(reasons) if reasons else ""))
            report["proposed_task_ids"] = list(dict.fromkeys(imported["added"] + imported["duplicates"]))
            report["deferred_findings"] = imported["deferred"]
            staged_task["research_result"] = report
        useful = bool(imported["added"] or imported["duplicates"] or imported.get("deferred"))
        result = complete(staged, task_id, outcome="researched" if useful else "no_change",
                          note="completed Jules session without a pull request", now=moment)
        if imported["skipped"]:
            staged_task["execution"]["note"] += "; skipped findings: " + ", ".join(
                sorted({item["reason"] for item in imported["skipped"]}))
        errors = validate(staged)
        if errors:
            raise InvalidReport("staged discovery queue failed validation")
    except InvalidReport as exc:
        staged = copy.deepcopy(manifest)
        result = complete(staged, task_id, outcome="failed", note=str(exc), now=moment)
        imported = {"added": []}
    errors = validate(staged)
    if errors:
        raise ValueError("completion queue failed validation")
    manifest.clear()
    manifest.update(staged)
    result["imported_count"] = len(imported["added"])
    return result


def atomic_write(path: Path, content: str) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--session-file", required=True, type=Path)
    parser.add_argument("--api-base", default=os.environ.get("JULES_API_BASE", DEFAULT_API_BASE))
    parser.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT", ""))
    args = parser.parse_args(argv)
    try:
        original = args.manifest.read_bytes()
        manifest = json.loads(original)
        config = json.loads(args.config.read_text(encoding="utf-8"))
        snapshot = json.loads(args.session_file.read_text(encoding="utf-8"))
        if not isinstance(snapshot, dict):
            raise ValueError("invalid session snapshot")
        result = harvest(manifest, config, args.task_id, snapshot, api_base=args.api_base,
                         api_keys=[os.environ.get("JULES_API_KEY", ""),
                                   os.environ.get("JULES_API_KEY_BACKUP", "")])
        if result["changed"]:
            if args.manifest.read_bytes() != original:
                raise RuntimeError("task queue changed while harvesting; retry against the current queue")
            atomic_write(args.manifest, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    except (OSError, ValueError, RuntimeError):
        # Do not print upstream response bodies, prompts, or filesystem secrets.
        print("::error::Jules completion could not be read or persisted; queue left unchanged", file=sys.stderr)
        return 1
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            handle.write("lifecycle_changed=" + ("true" if result["changed"] else "false") + "\n")
            handle.write("lifecycle_reason=" + result["reason"] + "\n")
            handle.write("lifecycle_task_id=" + result["task_id"] + "\n")
            handle.write("imported_count=" + str(result["imported_count"]) + "\n")
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
