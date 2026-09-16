#!/usr/bin/env python3
"""Import discovery findings only from an accepted immutable session report.

A discovery run that only *describes* follow-up work is wasted effort: nothing
reads the prose, so the loop rediscovers the same findings next tick. The
discovery prompt therefore requires a machine-readable block:

    <!-- AUTONOMOUS_TASKS_BEGIN -->
    ```json
    [ { "title": "...", "task_type": "bugfix", "evidence": { ... } } ]
    ```
    <!-- AUTONOMOUS_TASKS_END -->

This script parses that block, normalises actionable reports, drops duplicates
and appends reported (not verified) claims to the queue. Findings without a
reproduction stay deferred; malformed packaging still fails loudly. The resulting
manifest must pass the ordinary validator before the controller persists it.

"Loudly" is the whole point: a JSON error used to be swallowed into an empty
backlog, which is indistinguishable from "the worker found nothing". The block is
machine-readable by contract, so a block that is not parseable is reported as
``malformed_block`` with a non-zero exit code and a ``::error::`` annotation. The
caller still commits whatever other queue changes it made, then fails the job.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_tasks import (  # noqa: E402
    VALID_RISKS, VALID_TASK_TYPES, validate, validate_reproduction,
)
from check_change_scope import evaluate as evaluate_scope  # noqa: E402
from task_lifecycle import find_task  # noqa: E402

BEGIN = "AUTONOMOUS_TASKS_BEGIN"
END = "AUTONOMOUS_TASKS_END"
BLOCK_RE = re.compile(BEGIN + r"(.*?)" + END, re.DOTALL)
DEFAULT_PRIORITY = 45
DEFAULT_MAX_NEW = 10

STATUS_OK = "ok"
STATUS_ABSENT = "absent"
STATUS_MALFORMED = "malformed_block"


def _fingerprint(text: str) -> str:
    return hashlib.sha256(text.strip().lower().encode("utf-8")).hexdigest()[:16]


def parse_block(text: str) -> dict:
    """Pull the JSON array out of the marked block and say why it failed.

    Returns ``status`` (ok / absent / malformed_block), the parsed ``entries``
    and a human ``detail``. A missing block is a legitimate answer - not every
    pull request carries a backlog. A *broken* block is a defect: the prompt
    guarantees machine-readable JSON, so silently reading it as "no findings"
    would erase real work.
    """
    text = str(text or "")
    if BEGIN not in text and END not in text:
        return {
            "status": STATUS_ABSENT, "entries": [],
            "detail": "no " + BEGIN + " block was present",
        }
    match = BLOCK_RE.search(text)
    if text.count(BEGIN) != 1 or text.count(END) != 1 or match is None:
        return {
            "status": STATUS_MALFORMED, "entries": [],
            "detail": "expected exactly one ordered pair of backlog delimiters",
        }
    body = match.group(1).strip()
    if body.startswith("-->"):
        body = body[3:].strip()
    if body.endswith("<!--"):
        body = body[:-4].strip()
    fenced = re.fullmatch(r"```(?:json)?\s*\n(.*?)\n```", body, re.DOTALL)
    if fenced:
        body = fenced.group(1)
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        return {
            "status": STATUS_MALFORMED, "entries": [],
            "detail": "the " + BEGIN + " block is not valid JSON: " + str(exc),
        }
    if not isinstance(parsed, list):
        return {
            "status": STATUS_MALFORMED, "entries": [],
            "detail": "the " + BEGIN + " block must contain a JSON array",
        }
    entries = [item for item in parsed if isinstance(item, dict)]
    if len(entries) != len(parsed):
        return {
            "status": STATUS_MALFORMED, "entries": [],
            "detail": "the task array contains entries that are not objects",
        }
    if any(entry.get("acceptance") is not None and not isinstance(entry["acceptance"], list)
           for entry in entries):
        return {
            "status": STATUS_MALFORMED, "entries": [],
            "detail": "task acceptance must be an array",
        }
    return {
        "status": STATUS_OK, "entries": entries,
        "detail": str(len(entries)) + " task entry/entries parsed",
    }


def extract_block(text: str) -> list:
    """Backwards-compatible view of parse_block: the entries only."""
    return parse_block(text)["entries"]


def normalize(entry: Mapping[str, Any], *, now: str) -> dict:
    title = str(entry.get("title") or "").strip()
    evidence = entry.get("evidence")
    if not isinstance(evidence, dict):
        evidence = {}
    detail = str(evidence.get("detail") or entry.get("detail") or "").strip()
    task_type = str(entry.get("task_type") or "product_improvement")
    if task_type not in VALID_TASK_TYPES or task_type == "project_discovery":
        task_type = "product_improvement"
    risk = str(entry.get("risk") or "low")
    if risk not in VALID_RISKS:
        risk = "low"
    try:
        priority = int(entry.get("priority", DEFAULT_PRIORITY))
    except (TypeError, ValueError, OverflowError):
        priority = DEFAULT_PRIORITY
    priority = max(1, min(90, priority))
    focus = entry.get("focus")
    if not isinstance(focus, list):
        focus = ["quality"]
    acceptance = entry.get("acceptance")
    if not isinstance(acceptance, list):
        acceptance = []
    task_id = str(entry.get("id") or "").strip() or ("discovery-" + _fingerprint(title))
    return {
        "id": task_id,
        "title": title,
        "task_type": task_type,
        "status": "proposed",
        "priority": priority,
        "risk": risk,
        "focus": [str(item) for item in focus],
        "created_at": now,
        "acceptance": [
            str(item) for item in acceptance
        ] or ["A failing-first regression test proves the change"],
        "evidence": {
            "source": str(evidence.get("source") or "project_discovery"),
            "detail": detail,
            "status": "reported",
            **({"reproduction": {
                "steps": list(evidence["reproduction"]["steps"]),
                "expected": evidence["reproduction"]["expected"],
                "actual": evidence["reproduction"]["actual"],
            }} if not validate_reproduction(evidence.get("reproduction")) else {}),
        },
        **({"target_paths": list(entry["target_paths"])}
           if isinstance(entry.get("target_paths"), list) else {}),
    }


def finding_error(entry: Mapping[str, Any], config: Mapping[str, Any]) -> str:
    """Worker output cannot expand the trusted product or execution boundary."""
    for field in ("title",):
        if not isinstance(entry.get(field), str) or not entry[field].strip():
            return "missing_" + field
    evidence = entry.get("evidence")
    if not isinstance(evidence, dict) or any(
        not isinstance(evidence.get(field), str) or not evidence[field].strip()
        for field in ("source", "detail")
    ):
        return "missing_evidence"
    for field in ("acceptance", "target_paths"):
        values = entry.get(field)
        if not isinstance(values, list) or not values or any(
            not isinstance(value, str) or not value.strip() for value in values
        ):
            return "missing_" + field
    if entry.get("task_type") == "project_discovery":
        return "unsafe_discovery_child"
    task_type = entry.get("task_type", "product_improvement")
    if not isinstance(task_type, str) or task_type not in VALID_TASK_TYPES:
        return "invalid_task_type"
    risk = entry.get("risk", "low")
    ranks = {"low": 0, "medium": 1, "high": 2}
    if not isinstance(risk, str) or risk not in ranks:
        return "invalid_risk"
    if ranks[risk] > ranks.get(config.get("risk_ceiling", "medium"), 1):
        return "unsafe_risk"
    paths = entry["target_paths"]
    if any(path != path.strip() or "\\" in path or ":" in path or path.startswith("/")
           or any(part in ("", ".", "..") for part in path.split("/"))
           or any(char in path for char in "*?[]") for path in paths):
        return "unsafe_target_paths"
    if not (config.get("product") or {}).get("editable_globs"):
        return "unsafe_missing_product_scope"
    if not evaluate_scope(config, paths)["allowed"]:
        return "unsafe_product_scope"
    return ""


def import_tasks(manifest: dict, body: str, *, max_new: int = DEFAULT_MAX_NEW,
                 now: str | None = None, config: Mapping[str, Any] | None = None,
                 origin: Mapping[str, str] | None = None) -> dict:
    stamp = now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not isinstance(origin, Mapping):
        raise ValueError("discovery import requires an accepted session report origin")
    source = find_task(manifest, origin.get("task_id"))
    execution = (source or {}).get("execution") or {}
    accepted = (source or {}).get("research_result", {}).get("source")
    stored = str(execution.get("session_id") or "")
    resource = stored if stored.startswith("sessions/") else "sessions/" + stored
    if (not source or not stored or not execution.get("dispatch_key")
            or not isinstance(accepted, Mapping) or dict(origin) != {"task_id": source["id"], **accepted}
            or any(origin.get(field) != execution.get(field) for field in ("session_id", "dispatch_key"))
            or not re.fullmatch(re.escape(resource) + r"/activities/[^/]+", str(origin.get("activity_id") or ""))
            or origin.get("report_sha256") != hashlib.sha256(body.encode("utf-8")).hexdigest()):
        raise ValueError("discovery origin does not identify the accepted session report")
    block = parse_block(body)
    tasks = manifest.get("tasks", [])
    known_ids = {str(t.get("id")): t for t in tasks if isinstance(t, dict)}
    known_titles = {str(t.get("title") or "").strip().lower(): str(t.get("id"))
                    for t in tasks if isinstance(t, dict)}
    pending, added, skipped, duplicates, deferred = [], [], [], [], []
    invalid = block["status"] == STATUS_MALFORMED
    for entry in block["entries"]:
        candidate = normalize(entry, now=stamp)
        reason = finding_error(entry, config) if config is not None else (
            "missing_title" if not candidate["title"] else
            "missing_evidence" if not candidate["evidence"]["detail"] else ""
        )
        if not reason and "reproduction" not in candidate["evidence"]:
            reason = "unverified_finding"
        if reason:
            skipped.append({"id": candidate["id"], "reason": reason})
            can_defer = reason.startswith("unsafe_") or reason == "unverified_finding"
            invalid = invalid or not can_defer
            if can_defer:
                deferred.append({"title": candidate["title"], "reason": reason,
                                 "evidence": candidate["evidence"]["detail"],
                                 "target_paths": candidate.get("target_paths", []),
                                 "acceptance": candidate["acceptance"]})
            continue
        existing = known_ids.get(candidate["id"])
        title = candidate["title"].strip().lower()
        if existing is not None:
            if config is not None and str(existing.get("title") or "").strip().lower() != title:
                skipped.append({"id": candidate["id"], "reason": "conflicting_id"})
                invalid = True
            else:
                skipped.append({"id": candidate["id"], "reason": "duplicate_id"})
                duplicates.append(candidate["id"])
            continue
        if title in known_titles:
            skipped.append({"id": candidate["id"], "reason": "duplicate_title"})
            duplicates.append(known_titles[title])
            continue
        if len(added) >= max_new:
            skipped.append({"id": candidate["id"], "reason": "max_new_reached"})
            invalid = True
            continue
        if origin:
            candidate["origin"] = dict(origin)
        pending.append(candidate)
        known_ids[candidate["id"]] = candidate
        known_titles[title] = candidate["id"]
        added.append(candidate["id"])

    if config is not None and invalid:
        return {"changed": False, "added": [], "duplicates": duplicates, "skipped": skipped,
                "status": STATUS_MALFORMED, "detail": "incomplete or unsafe discovery findings"}
    if pending:
        manifest.setdefault("tasks", []).extend(pending)
    return {
        "changed": bool(added), "added": added, "duplicates": duplicates, "skipped": skipped,
        "deferred": deferred,
        "unverified_count": sum(item["reason"] == "unverified_finding" for item in deferred),
        "status": block["status"], "detail": block["detail"],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--source-task-id", default="")
    parser.add_argument("--body-file", type=Path)
    parser.add_argument("--body", default="")
    parser.add_argument("--max-new", type=int, default=DEFAULT_MAX_NEW)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--github-output", default="")
    args = parser.parse_args(argv)

    body = args.body
    if args.body_file and args.body_file.exists():
        body = args.body_file.read_text(encoding="utf-8")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    config = json.loads(args.config.read_text(encoding="utf-8")) if args.config else None
    source = find_task(manifest, args.source_task_id)
    report_source = (source or {}).get("research_result", {}).get("source")
    if not isinstance(report_source, dict):
        print("::error::import requires a previously accepted immutable session report", file=sys.stderr)
        return 1
    origin = {"task_id": source["id"], **report_source}
    try:
        result = import_tasks(manifest, body, max_new=args.max_new, config=config, origin=origin)
    except ValueError as exc:
        print("::error::" + str(exc), file=sys.stderr)
        return 1

    if result["changed"]:
        errors = validate(manifest)
        if errors:
            for err in errors:
                print("::error::imported backlog is invalid: " + err, file=sys.stderr)
            return 1
        (args.out or args.manifest).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            handle.write(
                "imported_changed=" + ("true" if result["changed"] else "false") + "\n"
            )
            handle.write("imported_count=" + str(len(result["added"])) + "\n")
            handle.write("imported_status=" + str(result.get("status", STATUS_OK)) + "\n")
            handle.write("unverified_count=" + str(result.get("unverified_count", 0)) + "\n")
    if result.get("status") == STATUS_MALFORMED:
        print(
            "::error::discovery backlog was not imported: " + str(result.get("detail")),
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
