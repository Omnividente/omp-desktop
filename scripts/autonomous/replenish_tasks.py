#!/usr/bin/env python3
"""Turn real failing checks into evidence-backed autonomous tasks.

This is the anti-churn heart of the loop: tasks may only be created from a
concrete diagnostic emitted by the project's own tooling (eslint / tsc), one
task per defect class (tool + rule + file), never from speculation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Iterable, Mapping

TSC_RE = re.compile(
    r"^(?P<path>[^(]+)\((?P<line>\d+),\d+\):\s*error\s+(?P<rule>TS\d+):\s*(?P<msg>.+)$"
)
BACKSLASH = chr(92)


def fingerprint(tool: str, rule: str, path: str) -> str:
    material = str(tool) + "|" + str(rule) + "|" + str(path)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _rel(path: str) -> str:
    value = str(path or "").replace(BACKSLASH, "/")
    for marker in ("/src/", "/src-tauri/"):
        index = value.find(marker)
        if index != -1:
            return value[index + 1:]
    if value.startswith("./"):
        return value[2:]
    return value


def parse_eslint(data: Any, *, min_severity: int = 2) -> list:
    findings = []
    if not isinstance(data, list):
        return findings
    for entry in data:
        if not isinstance(entry, dict):
            continue
        path = _rel(entry.get("filePath") or "")
        for message in entry.get("messages") or []:
            if not isinstance(message, dict):
                continue
            try:
                severity = int(message.get("severity") or 0)
            except (TypeError, ValueError):
                severity = 0
            if severity < min_severity:
                continue
            findings.append({
                "tool": "eslint",
                "rule": str(message.get("ruleId") or "eslint"),
                "path": path,
                "line": int(message.get("line") or 0),
                "message": str(message.get("message") or "").strip(),
            })
    return findings


def parse_tsc(text: str) -> list:
    findings = []
    for line in (text or "").splitlines():
        match = TSC_RE.match(line.strip())
        if not match:
            continue
        findings.append({
            "tool": "tsc",
            "rule": match.group("rule"),
            "path": _rel(match.group("path")),
            "line": int(match.group("line")),
            "message": match.group("msg").strip(),
        })
    return findings


def finding_to_task(finding: Mapping[str, Any], base_commit: str = "") -> dict:
    tool = str(finding.get("tool") or "check")
    rule = str(finding.get("rule") or "unknown")
    path = str(finding.get("path") or "")
    fp = fingerprint(tool, rule, path)
    detail = (
        tool + " reported " + rule + " at " + path + ":" + str(finding.get("line") or 0)
        + " - " + str(finding.get("message") or "")
    )
    return {
        "id": "auto-" + tool + "-" + fp,
        "title": "Fix " + rule + " in " + path,
        "task_type": "bugfix",
        "status": "proposed",
        "focus": ["quality"] if tool == "eslint" else ["quality", "compat"],
        "risk": "low",
        "priority": 40,
        "target_paths": [path],
        "evidence": {
            "source": tool,
            "detail": detail,
            "base_commit": str(base_commit or ""),
            "fingerprint": fp,
        },
        "created_at": "",
    }


def merge_tasks(manifest: Mapping[str, Any], new_tasks: Iterable[Mapping[str, Any]]) -> tuple:
    updated = json.loads(json.dumps(manifest))
    tasks = updated.setdefault("tasks", [])
    existing = {str(t.get("id")) for t in tasks if isinstance(t, dict)}
    added = []
    for task in new_tasks:
        task_id = str(task.get("id"))
        if task_id in existing:
            continue
        tasks.append(dict(task))
        existing.add(task_id)
        added.append(task_id)
    return updated, added


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--eslint-json", type=Path)
    parser.add_argument("--tsc-log", type=Path)
    parser.add_argument("--base-commit", default="")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--max-new", type=int, default=10)
    args = parser.parse_args(argv)

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    findings = []
    if args.eslint_json and args.eslint_json.exists():
        try:
            findings += parse_eslint(json.loads(args.eslint_json.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            pass
    if args.tsc_log and args.tsc_log.exists():
        findings += parse_tsc(args.tsc_log.read_text(encoding="utf-8"))

    seen = set()
    unique = []
    for finding in findings:
        fp = fingerprint(finding["tool"], finding["rule"], finding["path"])
        if fp in seen:
            continue
        seen.add(fp)
        unique.append(finding)

    new_tasks = [finding_to_task(f, args.base_commit) for f in unique][: args.max_new]
    updated, added = merge_tasks(manifest, new_tasks)
    out = args.out or args.manifest
    out.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"findings": len(unique), "added": added}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
