#!/usr/bin/env python3
"""Prepare a real main merge without changing the checked-out lab or publishing it."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Mapping
from validate_tasks import validate


QUEUE = "agent_tasks.json"
SHA = re.compile(r"[0-9a-f]{40}\Z")


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull,
         "-c", "rerere.enabled=false", *args],
        check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def revision(repo: Path, ref: str) -> str:
    return git(repo, "rev-parse", "--verify", ref + "^{commit}").stdout.decode().strip()


def busy_reason(manifest: Mapping[str, Any], pull_requests: list, config: Mapping[str, Any]) -> str:
    # New workers use immutable starting refs; legacy workers on lab must finish
    # before moving their source. Human proposals and foreign PRs never block.
    for task in manifest["tasks"]:
        if task.get("status") != "in_progress":
            continue
        execution = task.get("execution") or {}
        key = execution.get("dispatch_key")
        if (not key or execution.get("starting_branch") != "autonomous/attempt-" + key
                or not SHA.fullmatch(str(execution.get("base_sha", "")))):
            return "legacy_active_task"
    return ""


def prepare_sync(
    repo: Path, main_sha: str, manifest: Path, pull_requests: list,
    config: Mapping[str, Any], *, lab_sha: str = "", state_sha: str = "",
) -> dict:
    result = {
        "status": "conflict", "reason": "invalid_input",
        "main_sha": main_sha if SHA.fullmatch(main_sha) else "",
        "lab_sha": "", "candidate_sha": "", "conflicts": [], "queue_blob": "",
        "state_sha": state_sha,
    }
    if not SHA.fullmatch(main_sha) or (lab_sha and not SHA.fullmatch(lab_sha)):
        return result
    head = revision(repo, "HEAD")
    result["lab_sha"] = head
    if lab_sha and head != lab_sha:
        return dict(result, reason="stale_lab")
    if revision(repo, main_sha) != main_sha:
        return result
    remote_main = git(repo, "rev-parse", "--verify", "refs/remotes/origin/main", check=False)
    if remote_main.returncode == 0 and remote_main.stdout.decode().strip() != main_sha:
        return dict(result, reason="stale_main")
    if git(repo, "status", "--porcelain", "--untracked-files=all").stdout:
        return dict(result, reason="dirty_worktree")
    if manifest.resolve() == (repo / QUEUE).resolve():
        return dict(result, reason="manifest_not_external")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    if validate(data):
        return dict(result, reason="invalid_manifest")
    # This is immutable legacy content only, never the active state snapshot.
    queue = git(repo, "show", head + ":" + QUEUE).stdout
    result["queue_blob"] = git(repo, "rev-parse", head + ":" + QUEUE).stdout.decode().strip()
    if not isinstance(pull_requests, list) or not all(isinstance(pr, dict) for pr in pull_requests):
        return result
    ancestry = git(repo, "merge-base", "--is-ancestor", main_sha, head, check=False)
    if ancestry.returncode == 0:
        return dict(result, status="up_to_date", reason="main_already_integrated")
    if ancestry.returncode != 1:
        return dict(result, reason="ancestry_failed")
    busy = busy_reason(data, pull_requests, config)
    if busy:
        return dict(result, status="busy", reason=busy)

    # The original index/worktree/branch are never used for the merge. Even a
    # failed merge lives only in this disposable detached worktree. Its commit
    # remains in the object database for the trusted workflow to publish by SHA.
    with tempfile.TemporaryDirectory(prefix="autonomous-sync-") as temporary:
        candidate = Path(temporary) / "candidate"
        git(repo, "worktree", "add", "--detach", str(candidate), head)
        try:
            merged = git(
                candidate, "-c", "user.name=github-actions[bot]",
                "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                "merge", "--no-ff", "--no-commit", main_sha, check=False,
            )
            conflicts = git(candidate, "diff", "--name-only", "--diff-filter=U", "-z").stdout
            paths = [path.decode("utf-8", errors="replace") for path in conflicts.split(b"\0") if path]
            product_conflicts = [path for path in paths if path != QUEUE]
            if product_conflicts:
                return dict(result, reason="merge_conflict", conflicts=product_conflicts)
            if merged.returncode and not paths:
                return dict(result, reason="merge_failed")
            # Preserve the *blob*, not parsed/reserialized JSON. This is also the
            # sole allowed automatic conflict resolution, including delete/modify.
            git(candidate, "restore", "--source=" + head, "--staged", "--worktree", "--", QUEUE)
            git(
                candidate, "-c", "user.name=github-actions[bot]",
                "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m",
                "chore(autonomous): integrate main " + main_sha,
            )
            candidate_sha = revision(candidate, "HEAD")
            if git(candidate, "show", candidate_sha + ":" + QUEUE).stdout != queue:
                return dict(result, reason="candidate_queue_changed")
            git(candidate, "merge-base", "--is-ancestor", main_sha, candidate_sha)
            git(candidate, "merge-base", "--is-ancestor", head, candidate_sha)
            return dict(result, status="prepared", reason="candidate_ready", candidate_sha=candidate_sha)
        finally:
            git(repo, "worktree", "remove", "--force", str(candidate))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--main-sha", required=True)
    parser.add_argument("--lab-sha", default="")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--state-revision", type=Path, required=True)
    parser.add_argument("--pull-requests", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = prepare_sync(
            args.repo.resolve(), args.main_sha, args.manifest.resolve(),
            json.loads(args.pull_requests.read_text(encoding="utf-8")),
            json.loads(args.config.read_text(encoding="utf-8")), lab_sha=args.lab_sha,
            state_sha=json.loads(args.state_revision.read_text(encoding="utf-8")).get("state_sha") or "",
        )
    except (OSError, ValueError, TypeError, AttributeError, KeyError, subprocess.CalledProcessError):
        # Git diagnostics and PR bodies can contain private data; artifacts only
        # contain the fixed result schema, never subprocess output or inputs.
        result = {
            "status": "conflict", "reason": "preparation_failed",
            "main_sha": args.main_sha if SHA.fullmatch(args.main_sha) else "",
            "lab_sha": "", "candidate_sha": "", "conflicts": [], "queue_blob": "",
            "state_sha": "",
        }
    encoded = json.dumps(result, ensure_ascii=True, indent=2) + "\n"
    args.out.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 1 if result["status"] == "conflict" else 0


if __name__ == "__main__":
    raise SystemExit(main())
