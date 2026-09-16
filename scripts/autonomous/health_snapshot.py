#!/usr/bin/env python3
"""Read active Actions runs completely, recent completions and queue-owned PRs."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlencode

from jules_provenance import trusted_pull_request
from loop_health import ACTIVE_RUN_STATUSES, workflow_runs
from validate_tasks import validate

RECENT_COMPLETED = 100
WORKFLOWS = {"Autonomous Next Task": ("autonomous_next_task.yml", "next-runs.json"),
             "Autonomous Sync Main": ("autonomous_sync.yml", "sync-runs.json")}


def gh_get(repository: str, path: str, *, paginate: bool = False):
    command = ["gh", "api", "--method", "GET", "/repos/" + repository + "/" + path]
    if paginate:
        command += ["--paginate", "--slurp"]
    completed = subprocess.run(command, check=True, text=True, encoding="utf-8",
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    return json.loads(completed.stdout)


def snapshot_runs(get, workflow: str) -> list[dict]:
    endpoint = "actions/workflows/" + workflow + "/runs?"
    # Completed history is only a recency signal, never evidence of idle slots.
    recent = get(endpoint + urlencode({"status": "completed", "per_page": RECENT_COMPLETED}))
    runs = {run["id"]: run for run in workflow_runs(recent)}
    for status in sorted(ACTIVE_RUN_STATUSES):
        pages = get(endpoint + urlencode({"status": status, "per_page": 100}), paginate=True)
        if not isinstance(pages, list) or not pages:
            raise ValueError("incomplete active run snapshot")
        found = {}
        for page in pages:
            for run in workflow_runs(page):
                found[run["id"]] = run
        # GitHub caps filtered searches at 1000. Never turn a capped/partial
        # response into 'all idle'; a later scheduler tick can retry the read.
        totals = [page.get("total_count") for page in pages]
        if any(type(total) is not int or total >= 1000 or total > len(found) for total in totals):
            raise ValueError("active run snapshot is capped or incomplete")
        runs.update(found)
    return list(runs.values())


def snapshot_proposals(get, manifest: dict, repository: str) -> list[dict]:
    tasks_by_number = {}
    for task in manifest["tasks"]:
        execution = task.get("execution") or {}
        if task.get("status") != "in_progress" and execution.get("state") not in {"awaiting_review", "quarantined"}:
            continue
        receipt = execution.get("provenance") or {}
        number = execution.get("pull_request")
        if (type(number) is not int or number <= 0 or receipt.get("repository") != repository
                or not execution.get("session_id") or not execution.get("dispatch_key")
                or any(receipt.get(field) != execution.get(field)
                       for field in ("session_id", "dispatch_key", "pull_request"))):
            continue
        tasks_by_number.setdefault(number, []).append(task)
    proposals = []
    for number, tasks in tasks_by_number.items():
        pr = get("pulls/" + str(number))
        if not any(trusted_pull_request(task, pr, repository) for task in tasks):
            raise ValueError("saved proposal identity changed")
        proposals.append(pr)
    return proposals


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--out-dir", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        repository = config["repository"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("invalid repository")
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        if validate(manifest):
            raise ValueError("invalid manifest")
        def get(path, **options):
            return gh_get(repository, path, **options)
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        event = json.loads(Path(event_path).read_text(encoding="utf-8")) if event_path else {}
        completed = event.get("workflow_run") or {}
        outputs = {}
        for name, (workflow, filename) in WORKFLOWS.items():
            runs = snapshot_runs(get, workflow)
            # Completion webhooks may precede the list endpoint's update. An
            # exact fresh read anchors cadence even when queue bytes did not change.
            if (completed.get("name") == name and type(completed.get("id")) is int
                    and (completed.get("head_repository") or {}).get("full_name") == repository):
                observed = get("actions/runs/" + str(completed["id"]))
                runs = [run for run in runs if run["id"] != observed["id"]] + [observed]
            outputs[filename] = runs
        outputs["pull-requests.json"] = snapshot_proposals(get, manifest, repository)
        args.out_dir.mkdir(parents=True, exist_ok=True)
        for filename, value in outputs.items():
            (args.out_dir / filename).write_text(json.dumps(value) + "\n", encoding="utf-8")
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print(json.dumps({"health": "attention", "action": "none", "reason": "snapshot_incomplete"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
