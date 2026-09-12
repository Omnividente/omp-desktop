#!/usr/bin/env python3
"""Import a discovery backlog from a pull request body into agent_tasks.json.

A discovery run that only *describes* follow-up work is wasted effort: nothing
reads the prose, so the loop rediscovers the same findings next tick. The
discovery prompt therefore requires a machine-readable block:

    <!-- AUTONOMOUS_TASKS_BEGIN -->
    ```json
    [ { "title": "...", "task_type": "bugfix", "evidence": { ... } } ]
    ```
    <!-- AUTONOMOUS_TASKS_END -->

This script parses that block, normalises each entry, drops duplicates and
appends the rest to the queue. The resulting manifest must pass the ordinary
validator, so malformed discovery output fails loudly instead of corrupting the
queue.
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
    VALID_RISKS, VALID_TASK_TYPES, validate,
)

BEGIN = "AUTONOMOUS_TASKS_BEGIN"
END = "AUTONOMOUS_TASKS_END"
BLOCK_RE = re.compile(BEGIN + r"(.*?)" + END, re.DOTALL)
DEFAULT_PRIORITY = 45
DEFAULT_MAX_NEW = 10


def _fingerprint(text: str) -> str:
    return hashlib.sha256(text.strip().lower().encode("utf-8")).hexdigest()[:16]


def extract_block(text: str) -> list:
    """Pull the JSON array out of the marked block, tolerating code fences."""
    match = BLOCK_RE.search(str(text or ""))
    if not match:
        return []
    body = match.group(1)
    start = body.find("[")
    end = body.rfind("]")
    if start < 0 or end <= start:
        return []
    try:
        parsed = json.loads(body[start:end + 1])
    except json.JSONDecodeError:
        return []
    return [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []


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
    except (TypeError, ValueError):
        priority = DEFAULT_PRIORITY
    priority = max(1, min(90, priority))
    focus = entry.get("focus")
    if not isinstance(focus, list):
        focus = ["quality"]
    task_id = str(entry.get("id") or "").strip() or ("discovery-" + _fingerprint(title))
    return {
        "id": task_id,
        "title": title,
        "task_type": task_type,
        "status": "todo",
        "priority": priority,
        "risk": risk,
        "focus": [str(item) for item in focus],
        "created_at": now,
        "acceptance": [
            str(item) for item in (entry.get("acceptance") or [])
        ] or ["A failing-first regression test proves the change"],
        "evidence": {
            "source": str(evidence.get("source") or "project_discovery"),
            "detail": detail,
        },
    }


def import_tasks(manifest: dict, body: str, *, max_new: int = DEFAULT_MAX_NEW,
                 now: str | None = None) -> dict:
    stamp = now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tasks = manifest.setdefault("tasks", [])
    known_ids = {str(t.get("id")) for t in tasks if isinstance(t, dict)}
    known_titles = {
        str(t.get("title") or "").strip().lower() for t in tasks if isinstance(t, dict)
    }

    added, skipped = [], []
    for entry in extract_block(body):
        candidate = normalize(entry, now=stamp)
        if not candidate["title"]:
            skipped.append({"id": candidate["id"], "reason": "missing_title"})
            continue
        if not candidate["evidence"]["detail"]:
            skipped.append({"id": candidate["id"], "reason": "missing_evidence"})
            continue
        if candidate["id"] in known_ids:
            skipped.append({"id": candidate["id"], "reason": "duplicate_id"})
            continue
        if candidate["title"].strip().lower() in known_titles:
            skipped.append({"id": candidate["id"], "reason": "duplicate_title"})
            continue
        if len(added) >= max_new:
            skipped.append({"id": candidate["id"], "reason": "max_new_reached"})
            continue
        tasks.append(candidate)
        known_ids.add(candidate["id"])
        known_titles.add(candidate["title"].strip().lower())
        added.append(candidate["id"])

    return {"changed": bool(added), "added": added, "skipped": skipped}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
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
    result = import_tasks(manifest, body, max_new=args.max_new)

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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
