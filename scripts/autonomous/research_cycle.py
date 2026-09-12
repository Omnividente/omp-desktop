#!/usr/bin/env python3
"""Mint at most one read-only research task when the eligible queue is empty.

Coverage is keyed by trusted area/perspective and committed product blob content,
not the lab branch tip. Existing rows and lifecycle transitions are never edited.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence

from check_change_scope import evaluate, manual_review_hits
from select_task import DEFAULT_MAX_ATTEMPTS, RISK_ORDER, select
from validate_tasks import MAX_PREVIOUS_REPORTS, MAX_PREVIOUS_REPORT_CHARS, validate


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return moment.astimezone(timezone.utc) if moment.tzinfo else None
    except ValueError:
        return None


def validate_config(config: Mapping[str, Any]) -> None:
    research = config.get("research")
    if not isinstance(research, dict) or type(research.get("enabled")) is not bool:
        raise ValueError("research.enabled must be a boolean")
    for key in ("revisit_after_hours", "max_sessions_per_day"):
        if type(research.get(key)) is not int or research[key] < 1:
            raise ValueError("research." + key + " must be a positive integer")
    if not (config.get("product") or {}).get("editable_globs"):
        raise ValueError("trusted product.editable_globs must not be empty")
    for collection in ("areas", "perspectives"):
        entries = research.get(collection)
        if not isinstance(entries, list) or not entries:
            raise ValueError("research." + collection + " must be a non-empty list")
        seen = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("research." + collection + " entries must be objects")
            identifier = entry.get("id")
            if not isinstance(identifier, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", identifier):
                raise ValueError("research IDs must be lowercase slug strings")
            if identifier in seen:
                raise ValueError("duplicate research ID: " + identifier)
            seen.add(identifier)
            if not isinstance(entry.get("title"), str) or not entry["title"].strip():
                raise ValueError("research title must be non-empty")
            field = "paths" if collection == "areas" else "focus"
            values = entry.get(field)
            if not isinstance(values, list) or not values or any(
                not isinstance(value, str) or not value.strip() for value in values
            ):
                raise ValueError("research." + field + " must be a non-empty string list")
            if collection == "areas":
                for value in values:
                    if (value != value.strip() or "\\" in value or ":" in value
                            or any(char in value for char in "*?[]\n\r\0")
                            or PurePosixPath(value).is_absolute()
                            or any(part in (".", "..", ".git") for part in value.split("/"))
                            or not value.rstrip("/")):
                        raise ValueError("research paths must be literal repository-relative paths")
            elif not isinstance(entry.get("instruction"), str) or not entry["instruction"].strip():
                raise ValueError("research perspective instruction must be non-empty")


def scope_fingerprints(config: Mapping[str, Any], repo: Path | str) -> dict[str, str]:
    """Hash sorted (path, blob ID) pairs from HEAD, never control or excluded files."""
    validate_config(config)
    tree = subprocess.run(
        ["git", "-C", str(repo), "ls-tree", "-rz", "--full-tree", "HEAD"],
        check=True, capture_output=True,
    ).stdout
    blobs = []
    for record in tree.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, oid = metadata.split()
        path = raw_path.decode("utf-8", errors="surrogateescape")
        # Symlinks/submodules are not product blobs to investigate outside the tree.
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            continue
        if not evaluate(config, [path])["allowed"] or manual_review_hits(config, [path]):
            continue
        blobs.append((path, raw_path, oid))
    fingerprints = {}
    for area in config["research"]["areas"]:
        roots = [path.rstrip("/") for path in area["paths"]]
        scoped = [(raw, oid) for path, raw, oid in blobs if any(
            path == root or path.startswith(root + "/") for root in roots
        )]
        if not scoped:
            raise ValueError("research area has no allowed tracked product blobs: " + area["id"])
        digest = hashlib.sha256()
        for raw_path, oid in sorted(scoped):
            digest.update(raw_path + b"\0" + oid + b"\0")
        fingerprints[area["id"]] = digest.hexdigest()
    return fingerprints


def _last_activity(task: Mapping[str, Any], now: datetime) -> datetime:
    execution = task.get("execution") or {}
    report = task.get("research_result") or {}
    dates = [_time(value) for value in (
        report.get("completed_at"), execution.get("finished_at"),
        execution.get("started_at"), task.get("created_at"),
    )]
    # Malformed historical timestamps must not allow an immediate retry storm.
    return max((moment for moment in dates if moment is not None), default=now)


def _previous_reports(history: list[dict]) -> list[dict]:
    reports = []
    for task in reversed(history):
        if not isinstance(task.get("research_result"), dict):
            continue
        report = copy.deepcopy(task["research_result"])
        if len(json.dumps(report, ensure_ascii=False)) > MAX_PREVIOUS_REPORT_CHARS // 2:
            def excerpt(text: str, limit: int = 300) -> str:
                return text if len(text) <= limit else text[:limit] + " [excerpt]"
            report["summary"] = excerpt(report["summary"], 1000)
            report["observations"] = [
                {field: excerpt(item[field]) for field in ("scenario", "evidence", "result")}
                for item in report["observations"][:6]
            ]
            report["next_hypotheses"] = [excerpt(item) for item in report["next_hypotheses"][:6]]
            report["proposed_task_ids"] = report["proposed_task_ids"][:10]
            report["deferred_findings"] = [
                {"title": excerpt(item["title"]), "reason": item["reason"],
                 "evidence": excerpt(item["evidence"]),
                 "target_paths": [excerpt(path) for path in item["target_paths"][:6]],
                 "acceptance": [excerpt(value) for value in item["acceptance"][:3]]}
                for item in report.get("deferred_findings", [])[:3]
            ]
        if len(json.dumps([*reports, report], ensure_ascii=False)) > MAX_PREVIOUS_REPORT_CHARS:
            break
        reports.append(report)
        if len(reports) == MAX_PREVIOUS_REPORTS:
            break
    return list(reversed(reports))


def plan_research(
    manifest: Mapping[str, Any], config: Mapping[str, Any], fingerprints: Mapping[str, str], *,
    now: datetime, focus: Sequence[str] | None = None, risk_ceiling: str = "medium",
    task_id: str | None = None,
) -> tuple[dict, dict]:
    """Pure scheduling API; return a new manifest only when one task is appended.

    The daily cap is a rolling 24-hour window of minted research sessions. Failed
    or exhausted sessions consume coverage/cooldown too; real tasks bypass it.
    """
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now = now.astimezone(timezone.utc)
    errors = validate(manifest)
    if errors:
        raise ValueError("invalid task manifest: " + "; ".join(errors))

    def unchanged(reason: str, next_at: datetime | None = None) -> tuple[dict, dict]:
        return manifest, {
            "research_changed": False, "research_reason": reason,
            "research_task_id": "", "research_next_at": _iso(next_at) if next_at else "",
        }

    if task_id:
        return unchanged("explicit_task_selection")
    selection = select(manifest, focus=focus, risk_ceiling=risk_ceiling)
    if selection["selected"] or selection["reason_code"] == "work_in_progress":
        return unchanged("eligible_work_exists" if selection["selected"] else "work_in_progress")
    max_attempts = (manifest["autonomous_loop_policy"].get("lifecycle") or {}).get(
        "max_attempts", DEFAULT_MAX_ATTEMPTS,
    ) or DEFAULT_MAX_ATTEMPTS
    if any(
        task.get("research") and task["status"] == "todo"
        and (task.get("execution") or {}).get("attempts", 0) < max_attempts
        for task in manifest["tasks"]
    ):
        return unchanged("research_pending")
    if not (config.get("research") or {}).get("enabled", False):
        return unchanged("research_disabled")
    validate_config(config)
    if risk_ceiling not in RISK_ORDER:
        raise ValueError("unknown risk ceiling")
    research = config["research"]
    cooldown = timedelta(hours=research["revisit_after_hours"])
    tasks = list(manifest["tasks"])
    research_tasks = [task for task in tasks if isinstance(task.get("research"), dict)]
    recent = sorted(
        created for task in research_tasks
        if (created := _time(task.get("created_at"))) is not None
        and created > now - timedelta(days=1)
    )
    cap_next = None
    if len(recent) >= research["max_sessions_per_day"]:
        cap_next = recent[-research["max_sessions_per_day"]] + timedelta(days=1)
    focus_set = {value.lower() for value in (focus or [])}
    candidates, next_times = [], []
    for area_index, area in enumerate(research["areas"]):
        fingerprint = fingerprints.get(area["id"])
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
            raise ValueError("missing/invalid fingerprint for " + area["id"])
        for perspective_index, perspective in enumerate(research["perspectives"]):
            if focus_set and not focus_set.intersection(value.lower() for value in perspective["focus"]):
                continue
            history = sorted([
                task for task in research_tasks
                if task["research"]["area_id"] == area["id"]
                and task["research"]["perspective_id"] == perspective["id"]
            ], key=lambda task: (_last_activity(task, now), task["id"]))
            eligible_at = now
            last_at = datetime.min.replace(tzinfo=timezone.utc)
            if history:
                latest = history[-1]
                last_at = _last_activity(latest, now)
                # A changed scope is immediately eligible after success; failed
                # attempts cannot bypass their cooldown by changing source blobs.
                unsuccessful = latest["status"] != "done"
                if unsuccessful or latest["research"]["fingerprint"] == fingerprint:
                    eligible_at = max(now, last_at + cooldown)
            if cap_next is not None:
                eligible_at = max(eligible_at, cap_next)
            next_times.append(eligible_at)
            if eligible_at <= now:
                candidates.append((
                    (bool(history), last_at, area_index, perspective_index),
                    area, perspective, history, fingerprint,
                ))
    if not candidates:
        if not next_times:
            return unchanged("focus_mismatch")
        return unchanged("daily_cap" if cap_next is not None else "cooldown", min(next_times))
    _, area, perspective, history, fingerprint = min(candidates, key=lambda item: item[0])
    cycle = max((task["research"]["cycle"] for task in history), default=0) + 1
    identifier = "research-" + area["id"] + "-" + perspective["id"] + "-" + str(cycle)
    existing_ids = {task["id"] for task in tasks}
    while identifier in existing_ids:
        cycle += 1
        identifier = "research-" + area["id"] + "-" + perspective["id"] + "-" + str(cycle)
    task = {
        "id": identifier,
        "title": "Investigate " + area["title"] + ": " + perspective["title"],
        "task_type": "project_discovery", "status": "todo", "focus": list(perspective["focus"]),
        "risk": "low", "priority": 10, "target_paths": list(area["paths"]),
        "created_at": _iso(now),
        "evidence": {
            "source": "autonomous_research",
            "detail": "Read-only scoped investigation; do not change product files or open a PR. "
                      + perspective["instruction"]
                      + " Use isolated synthetic data, never live sessions or credentials. "
                      "Record observed findings or explicit no-change with evidence in "
                      "AUTONOMOUS_RESEARCH_BEGIN/END and concrete proposals in "
                      "AUTONOMOUS_TASKS_BEGIN/END. No release, updater, control or secret changes.",
        },
        "research": {
            "area_id": area["id"], "perspective_id": perspective["id"],
            "fingerprint": fingerprint, "cycle": cycle,
            "previous_reports": _previous_reports(history),
        },
    }
    updated = copy.deepcopy(manifest)
    updated["tasks"].append(task)
    errors = validate(updated)
    if errors:
        raise ValueError("invalid research task: " + "; ".join(errors))
    return updated, {
        "research_changed": True, "research_reason": "research_scheduled",
        "research_task_id": identifier, "research_next_at": "",
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--focus", default="")
    parser.add_argument("--risk-ceiling", default="medium", choices=tuple(RISK_ORDER))
    parser.add_argument("--task-id", default="")
    parser.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT", ""))
    parser.add_argument("--dry-run", action="store_true", help="report the plan without changing the queue")
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        config = json.loads(args.config.read_text(encoding="utf-8"))
        focus = [value.strip() for value in args.focus.split(",") if value.strip()]
        selection = select(manifest, focus=focus, risk_ceiling=args.risk_ceiling)
        fingerprints = {}
        if (not args.task_id and not selection["selected"]
                and selection["reason_code"] != "work_in_progress"
                and (config.get("research") or {}).get("enabled", False)):
            fingerprints = scope_fingerprints(config, args.repo)
        updated, result = plan_research(
            manifest, config, fingerprints, now=datetime.now(timezone.utc),
            focus=focus, risk_ceiling=args.risk_ceiling, task_id=args.task_id or None,
        )
        if args.dry_run:
            result["dry_run"] = True
        if result["research_changed"] and not args.dry_run:
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", dir=args.manifest.parent,
                    prefix=args.manifest.name + ".", suffix=".tmp", delete=False,
                ) as handle:
                    temporary = Path(handle.name)
                    handle.write(json.dumps(updated, ensure_ascii=False, indent=2) + "\n")
                os.replace(temporary, args.manifest)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        print(json.dumps(result, ensure_ascii=False))
        if args.github_output:
            with open(args.github_output, "a", encoding="utf-8") as handle:
                for key, value in result.items():
                    handle.write(key + "=" + (str(value).lower() if isinstance(value, bool) else value) + "\n")
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print("ERROR: research planning failed: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
