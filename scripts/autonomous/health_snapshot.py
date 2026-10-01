#!/usr/bin/env python3
"""Read active Actions runs completely, recent completions and queue-owned PRs."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from dispatch_journal import materialize
from jules_provenance import trusted_pull_request
from loop_health import ACTIVE_RUN_STATUSES, assess_health, workflow_runs
from research_cycle import scope_fingerprints
from sync_main import git, revision
from validate_tasks import validate

RECENT_COMPLETED = 100
ACTIVE_READ_ATTEMPTS = 3
WORKFLOWS = {"Autonomous Next Task": ("autonomous_next_task.yml", "next-runs.json"),
             "Autonomous Sync Main": ("autonomous_sync.yml", "sync-runs.json"),
             "Autonomous Continue": ("autonomous_continue.yml", "wakeup-runs.json")}


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
    # The status queries are not atomic: a pending run may start just after the
    # in_progress query and disappear from both filters. Collect twice and keep
    # every observed active run; a racing completion may delay work, not admit it.
    for _ in range(2):
        for status in sorted(ACTIVE_RUN_STATUSES):
            for attempt in range(ACTIVE_READ_ATTEMPTS):
                pages = get(endpoint + urlencode({"status": status, "per_page": 100}), paginate=True)
                if not isinstance(pages, list) or not pages:
                    raise ValueError(f"incomplete active run snapshot: {workflow} {status}")
                found = {}
                for page in pages:
                    for run in workflow_runs(page):
                        found[run["id"]] = run
                totals = [page.get("total_count") for page in pages]
                # The filtered endpoint caps results at 1000. Never accept that
                # cap or a malformed count as evidence of an idle slot.
                if any(type(total) is not int or total < 0 or total >= 1000 for total in totals):
                    raise ValueError(f"active run snapshot is capped or invalid: {workflow} {status}")
                runs.update(found)
                if all(total <= len(found) for total in totals):
                    break
                # Status transitions can update the count before the run list.
                # Require a complete re-read, keeping every observed active run.
                if attempt + 1 == ACTIVE_READ_ATTEMPTS:
                    raise ValueError(f"active run snapshot remains incomplete: {workflow} {status}")
                time.sleep(2 ** attempt)
    return list(runs.values())


def _exact_run(get, run_id: str) -> dict | None:
    run = get("actions/runs/" + run_id)
    if run is None:
        return None
    if not isinstance(run, dict) or str(run.get("id")) != run_id:
        raise ValueError("exact workflow run identity changed")
    return run


def _snapshot_workflows(get, manifest: dict, repository: str, *, completed=None) -> dict:
    """Collect bounded history, complete active reads and the pinned executor."""
    completed = completed or {}
    snapshots = {}
    for name, (workflow, filename) in WORKFLOWS.items():
        runs = snapshot_runs(get, workflow)
        # Completion webhooks may precede the list endpoint's update. Keep
        # failure/busy diagnostics fresh; completion is not a useful tick clock.
        if (completed.get("name") == name and type(completed.get("id")) is int
                and (completed.get("head_repository") or {}).get("full_name") == repository):
            observed = _exact_run(get, str(completed["id"]))
            if observed is None:
                raise ValueError("completion webhook run is unavailable")
            runs = [run for run in runs if run["id"] != observed["id"]] + [observed]
        snapshots[filename] = runs
    # Recent completions are bounded. An unfinished executor is pinned to one
    # exact run, so read that run when it has aged out of its workflow snapshot.
    if manifest.get("dispatch_journal") is not None:
        state = materialize(manifest["dispatch_journal"])
        intent = state["active_intent"]
        executor = state["executor_claims"].get(intent["decision_id"]) if intent else None
        if executor:
            run_id = executor["trigger"]["run_id"]
            filename = next(filename for workflow, filename in WORKFLOWS.values() if workflow == intent["workflow"])
            if not any(str(run.get("id")) == run_id for run in snapshots[filename]):
                try:
                    pinned = _exact_run(get, run_id)
                except (KeyError, OSError, subprocess.SubprocessError, RuntimeError):
                    # A missing or temporarily unreadable exact run is unknown.
                    # Injected GitHub adapters report transport failure as RuntimeError.
                    # Saved observations remain history, not current run state.
                    pinned = None
                if pinned is not None:
                    snapshots[filename].append(pinned)
    return snapshots


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


def inspect_health(manifest, config, *, repo, enabled, now=None, state_sha="", current_run_id="",
                   observer_context=None, get=None) -> dict:
    """Inspect fetched refs and complete live snapshots without updating any state."""
    repository = config["repository"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("invalid repository")
    if validate(manifest):
        raise ValueError("invalid manifest")
    repo = Path(repo)
    main_sha = revision(repo, "refs/remotes/origin/" + config.get("default_branch", "main"))
    lab_sha = revision(repo, "HEAD")
    ancestry = git(repo, "merge-base", "--is-ancestor", main_sha, lab_sha, check=False).returncode
    if ancestry not in (0, 1):
        raise ValueError("cannot determine lab ancestry")
    fingerprints = scope_fingerprints(config, repo) if (config.get("research") or {}).get("enabled") else {}
    if get is None:
        def get(path, *, paginate=False):
            return gh_get(repository, path, paginate=paginate)
    snapshots = _snapshot_workflows(get, manifest, repository)
    return assess_health(
        manifest, config, main_sha=main_sha, lab_sha=lab_sha, main_is_ancestor=ancestry == 0,
        fingerprints=fingerprints, runs=snapshots["next-runs.json"], sync_runs=snapshots["sync-runs.json"],
        wakeup_runs=snapshots["wakeup-runs.json"], pull_requests=snapshot_proposals(get, manifest, repository),
        enabled=enabled, now=now if now is not None else datetime.now(timezone.utc),
        state_sha=state_sha, current_run_id=current_run_id, observer_context=observer_context,
    )


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
        outputs = _snapshot_workflows(get, manifest, repository, completed=completed)
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
