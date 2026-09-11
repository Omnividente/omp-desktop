#!/usr/bin/env python3
"""Validate agent_tasks.json structure and anti-churn required fields."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

VALID_STATUSES = {"todo", "in_progress", "done", "blocked"}
VALID_RISKS = {"low", "medium", "high"}
VALID_TASK_TYPES = {
    "product_improvement", "bugfix", "test_coverage", "refactor",
    "project_discovery", "chore",
}


def validate(manifest: Any) -> list:
    errors: list = []
    if not isinstance(manifest, dict):
        return ["manifest must be a JSON object"]
    if not isinstance(manifest.get("version"), int):
        errors.append("version must be an integer")
    if not isinstance(manifest.get("autonomous_loop_policy"), dict):
        errors.append("autonomous_loop_policy must be an object")
    tasks = manifest.get("tasks")
    if not isinstance(tasks, list):
        return errors + ["tasks must be a list"]
    seen_ids: set = set()
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
        if str(task.get("status")) not in VALID_STATUSES:
            errors.append(prefix + ".status must be one of " + str(sorted(VALID_STATUSES)))
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
