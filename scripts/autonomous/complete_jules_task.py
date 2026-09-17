#!/usr/bin/env python3
"""Harvest a bound, completed Jules attempt without requiring a pull request."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import quote, quote_plus

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_discovery_tasks import BEGIN, END, STATUS_OK, STATUS_ABSENT, import_tasks, parse_block
from jules_dispatch import (
    DEFAULT_API_BASE, KeyRing, get_session, list_activities, session_id,
    session_matches, session_resource, session_state, urllib_transport,
)
from task_lifecycle import awaiting_report, complete, find_task, iso, park_report, parse_iso, utcnow
from validate_tasks import _validate_report_source, validate, validate_research_result

RESEARCH_BEGIN = "AUTONOMOUS_RESEARCH_BEGIN"
RESEARCH_END = "AUTONOMOUS_RESEARCH_END"
MARKERS = (BEGIN, END, RESEARCH_BEGIN, RESEARCH_END)
MAX_REPORT_CHARS = 24000
SECRET_NAME = re.compile(r"secret|token|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key", re.I)


class InvalidReport(ValueError):
    """A completed worker needs report repair, not another dispatched attempt."""

    def __init__(self, detail: str, code: str = "research_invalid", text: str = ""):
        super().__init__(detail)
        self.code = code
        self.text = text


def configured_secrets(config: Mapping[str, Any], keys) -> list[str]:
    values = list(keys)

    def collect(value, sensitive=False):
        if isinstance(value, Mapping):
            for name, child in value.items():
                collect(child, sensitive or bool(SECRET_NAME.search(str(name))))
        elif isinstance(value, (list, tuple)):
            for child in value:
                collect(child, sensitive)
        elif sensitive and isinstance(value, str) and value:
            values.append(value)

    collect(config)
    collect(os.environ)
    return sorted(set(value for value in values if value), key=len, reverse=True)


def redact(text: str, secrets) -> str:
    # Redact before truncation so credential prefixes cannot survive the bound.
    for secret in secrets:
        if not secret:
            continue
        for encoded in (secret, json.dumps(secret, ensure_ascii=False)[1:-1], quote(secret, safe=""), quote_plus(secret)):
            if encoded:
                text = text.replace(encoded, "[REDACTED]")
    text = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)",
                  "[REDACTED PRIVATE KEY]", text, flags=re.S)
    text = re.sub(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s<>\"']+",
                  lambda match: re.sub(r"([?#]).*", r"\1[REDACTED]",
                                       re.sub(r"(://)[^/]*@", r"\1[REDACTED]@", match.group())), text)
    text = re.sub(r"(?i)\b(?:bearer|basic)\s+[^\s\"'<>]+", "[REDACTED AUTH]", text)
    text = re.sub(r"(?i)(?:[\"']?)(?:[\w-]*(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|credential)[\w-]*)(?:[\"']?)\s*[:=]\s*[^\r\n]+",
                  "[REDACTED CREDENTIAL]", text)
    text = re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AIza[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b",
                  "[REDACTED TOKEN]", text)
    return text


def latest_report(activities: list) -> tuple[str, dict]:
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
            if not text.strip():
                continue
            # An unmarked final agent message is still the newest output. Never
            # resurrect an older valid report after a malformed replacement.
            if not (isinstance(message, dict) and text == message.get("agentMessage")) and not any(marker in text for marker in MARKERS):
                continue
            stamp = parse_iso(activity.get("createTime"))
            if stamp is None:
                raise InvalidReport("report activity lacks a valid createTime", "report_timestamp", text)
            name = str(activity.get("name") or "")
            reports.append((stamp, text, name))
    if not reports:
        raise InvalidReport("completed discovery has no worker report", "report_absent")
    newest = max(stamp for stamp, _text, _name in reports)
    latest = {(text, name) for stamp, text, name in reports if stamp == newest}
    if len(latest) != 1:
        raise InvalidReport("conflicting reports have the same createTime", "report_ambiguous", "\n\n".join(sorted({text for text, _name in latest})))
    text, name = next(iter(latest))
    return text, {"activity_id": name, "report_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                  "activity_created_at": iso(newest)}


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
    except json.JSONDecodeError as exc:
        raise InvalidReport("research report is not valid JSON: " + str(exc), "research_json") from None
    if not isinstance(report, dict):
        raise InvalidReport("research report must be an object", "research_shape")
    report = {field: report.get(field) for field in ("summary", "observations", "next_hypotheses")}
    report["proposed_task_ids"] = []
    report["completed_at"] = completed_at
    errors = validate_research_result(report)
    if errors:
        raise InvalidReport("; ".join(errors), "research_schema")
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
            api_keys=(), now: datetime | None = None, max_new: int = 10,
            retry_report: bool = False, diagnostics: Path | None = None) -> dict:
    """Stage imports and the authoritative lifecycle transition as one mutation.

    Transport/read failures leave the queue untouched. Malformed report packaging
    parks the bound attempt; recovery accepts only a newer, valid report.
    """
    task = find_task(manifest, task_id)
    if task is None:
        raise ValueError("task not found")
    execution = task.get("execution") or {}
    resource = bound_session(snapshot, execution)
    if retry_report and task.get("status") == "done" and execution.get("outcome") in ("no_change", "researched"):
        return {"changed": False, "reason": "attempt_already_resolved", "task_id": task_id,
                "imported_count": 0}
    recovering = retry_report and awaiting_report(task)
    if retry_report and (not recovering or task.get("task_type") != "project_discovery"
                         or session_state(snapshot) != "COMPLETED"):
        raise ValueError("report retry requires the stored completed research attempt")
    quarantined = task.get("status") == "blocked" and execution.get("state") == "quarantined"
    if not recovering and not quarantined and (task.get("status") != "in_progress" or execution.get("outcome")):
        return {"changed": False, "reason": "attempt_already_resolved", "task_id": task_id,
                "imported_count": 0}
    ring = api_keys if isinstance(api_keys, KeyRing) else KeyRing(api_keys)
    if not ring:
        raise RuntimeError("no Jules API key is configured")
    session = get_session(transport, api_base, ring, resource)
    bound_session(session, execution, resource)
    from jules_provenance import session_pull_request
    repository = config.get("repository") or (config.get("project") or {}).get("repository", "")
    if repository:
        session_pull_request(session, execution, repository)
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
    if quarantined:
        staged_task["status"] = "in_progress"
        staged_task["execution"].update(state="dispatched", outcome="")
    report = None
    secrets = configured_secrets(config, ring.keys)
    diagnostic = {"task_id": task_id, "session_id": str(execution.get("session_id") or ""),
                  "session_resource": resource, "dispatch_key": str(execution.get("dispatch_key") or ""),
                  "attempts": execution.get("attempts"), "collected_at": iso(moment),
                  "session_state": "COMPLETED", "selection": {"status": "not_checked", "detail": ""},
                  "tasks_parser": {"status": "not_checked", "detail": ""},
                  "research_parser": {"status": "not_checked", "detail": ""},
                  "findings_parser": {"status": "not_checked", "detail": ""}}
    text = ""
    source = None
    fresh_report = False
    try:
        if task.get("task_type") == "project_discovery":
            # Finish all API reads before any mutation, even for invalid output.
            text, source = latest_report(list_activities(transport, api_base, ring, resource))
            source.update(session_id=str(execution["session_id"]), dispatch_key=str(execution["dispatch_key"]))
            if _validate_report_source(source, "report.source"):
                source = None
                raise InvalidReport("report activity provenance is invalid", "report_provenance")
            if recovering:
                receipt = execution.get("report_repair") or {}
                previous = receipt.get("source") or (execution.get("report_error") or {}).get("source") or {}
                created = parse_iso(source["activity_created_at"])
                boundary = parse_iso(previous.get("activity_created_at"))
                requested = parse_iso(receipt.get("at"))
                if ((previous and (source["activity_id"] == previous.get("activity_id")
                                   or (boundary and created <= boundary)))
                        or (requested and created < requested)):
                    return {"changed": False, "reason": "report_unchanged", "task_id": task_id,
                            "imported_count": 0}
            fresh_report = True
            diagnostic["source"] = source
            diagnostic["selection"] = {"status": "ok", "detail": "latest worker report selected"}
            block = parse_block(text)
            diagnostic["tasks_parser"] = {key: block[key] for key in ("status", "detail")}
            try:
                report = research_report(text, completed_at=iso(moment))
            except InvalidReport as exc:
                diagnostic["research_parser"] = {"status": exc.code, "detail": str(exc)}
                raise
            diagnostic["research_parser"] = {"status": "ok", "detail": "valid observation report"}
            if block["status"] not in (STATUS_OK, STATUS_ABSENT):
                raise InvalidReport(block["detail"], "tasks_" + block["status"])
            report["source"] = source
            staged_task["research_result"] = report
            imported = import_tasks(staged, text, config=config, max_new=max_new, now=iso(moment),
                                    origin={"task_id": task_id, **source})
            diagnostic["findings_parser"] = {key: imported[key] for key in ("status", "detail")}
            if imported["status"] not in (STATUS_OK, STATUS_ABSENT):
                reasons = sorted({item["reason"] for item in imported["skipped"]})
                detail = imported["detail"] + (": " + ", ".join(reasons) if reasons else "")
                diagnostic["findings_parser"]["detail"] = detail
                raise InvalidReport(detail, "findings_invalid")
            report["proposed_task_ids"] = list(dict.fromkeys(imported["added"] + imported["duplicates"]))
            report["deferred_findings"] = imported["deferred"]
        useful = bool(imported["added"] or imported["duplicates"] or imported.get("deferred"))
        result = complete(staged, task_id, outcome="researched" if useful else "no_change",
                          note="completed Jules session without a pull request", now=moment,
                          retry_report=recovering)
        if imported["skipped"]:
            staged_task["execution"]["note"] += "; skipped findings: " + ", ".join(
                sorted({item["reason"] for item in imported["skipped"]}))
        errors = validate(staged)
        if errors:
            raise InvalidReport("; ".join(errors), "queue_invalid")
    except InvalidReport as exc:
        staged = copy.deepcopy(manifest)
        if quarantined:
            pending = find_task(staged, task_id)
            pending["status"] = "in_progress"
            pending["execution"].update(state="dispatched", outcome="")
        text = exc.text or text
        if diagnostic["selection"]["status"] == "not_checked":
            diagnostic["selection"] = {"status": exc.code, "detail": str(exc)}
        diagnostic["error_code"] = exc.code
        result = park_report(staged, task_id, code=exc.code,
                             detail=redact(str(exc), secrets)[:2000], now=moment, source=source)
        repair = find_task(staged, task_id)["execution"].get("report_repair")
        if recovering and fresh_report and repair:
            repair["source"] = source
            if repair["status"] == "pending":
                repair.update(status="invalid", detail=redact(str(exc), secrets)[:2000])
            result["changed"] = True
        imported = {"added": []}
    errors = validate(staged)
    if errors:
        raise ValueError("completion queue failed validation")
    if diagnostics is not None:
        diagnostic["outcome"] = result["reason"]
        diagnostic["markers"] = {marker: text.count(marker) for marker in MARKERS}
        for key in ("selection", "tasks_parser", "research_parser", "findings_parser"):
            diagnostic[key]["detail"] = redact(diagnostic[key]["detail"], secrets)[:2000]
        sanitized = redact(text, secrets)
        diagnostic["worker_report"] = sanitized[:MAX_REPORT_CHARS]
        diagnostic["report_truncated"] = len(sanitized) > MAX_REPORT_CHARS
        atomic_write(Path(diagnostics), json.dumps(diagnostic, ensure_ascii=False, indent=2) + "\n")
    manifest.clear()
    manifest.update(staged)
    result["imported_count"] = len(imported["added"])
    if source:
        result["report_source"] = source
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
    parser.add_argument("--diagnostics", type=Path)
    parser.add_argument("--retry-report", action="store_true")
    parser.add_argument("--api-base", default=os.environ.get("JULES_API_BASE", DEFAULT_API_BASE))
    parser.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT", ""))
    args = parser.parse_args(argv)
    try:
        if args.diagnostics and args.diagnostics.resolve() in {
            args.manifest.resolve(), args.config.resolve(), args.session_file.resolve()
        }:
            raise ValueError("diagnostics must not overwrite an input file")
        original = args.manifest.read_bytes()
        manifest = json.loads(original)
        config = json.loads(args.config.read_text(encoding="utf-8"))
        snapshot = json.loads(args.session_file.read_text(encoding="utf-8"))
        if not isinstance(snapshot, dict):
            raise ValueError("invalid session snapshot")
        result = harvest(manifest, config, args.task_id, snapshot, api_base=args.api_base,
                         retry_report=args.retry_report, diagnostics=args.diagnostics,
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
