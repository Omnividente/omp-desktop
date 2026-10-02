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
from dispatch_journal import JournalStore
from state_store import load_state
from workflow_admission import add_arguments, context, recheck_context
from refresh_proposals import refresh


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
        execution = task.get("execution") or {}
        if task.get("status") != "in_progress" and execution.get("state") != "quarantined":
            continue
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


def push(repo, source, target):
    git(repo, "-c", "http.https://github.com/.extraheader=", "-c", "credential.helper=",
        "-c", "credential.https://github.com.helper=!gh auth git-credential",
        "push", "origin", source + ":refs/heads/" + target)


def prepare_execution(args, config, binding, store, github):
    inputs = {"main_sha": args.main_sha, "lab_sha": args.lab_sha}
    intent, capability = binding.admit(store, inputs)
    if capability is None:
        from health_snapshot import gh_get, snapshot_runs
        runs = (snapshot_runs(lambda path, **options: gh_get(config["repository"], path, **options),
                              intent["workflow"]) if intent else ())
        recheck_context(binding)
        disposition = store.nonexecution_outcome(
            intent, key=binding.key, trigger=binding.trigger, control_sha=binding.control_sha, runs=runs)
        return {"status": "blocked" if disposition["outcome"] == "blocked" else "skipped", **disposition,
                "main_sha": args.main_sha, "lab_sha": args.lab_sha}
    expected_branch = "autonomous/sync-" + binding.trigger["run_id"] + "-" + binding.trigger["run_attempt"]
    if args.candidate_branch != expected_branch:
        raise ValueError("candidate branch is not bound to the executor")
    if not github.enabled():
        recheck_context(binding)
        capability.consume()
        result = {"status": "disabled", "reason": "loop_disabled", "decision_id": intent["decision_id"],
                  "main_sha": args.main_sha, "lab_sha": args.lab_sha, "candidate_sha": "",
                  "queue_blob": "", "candidate_branch": args.candidate_branch}
        completion = store.record_completion(capability, result)
        return dict(result, completion_receipt_id=completion["receipt_id"])
    if github.head("main") != args.main_sha or github.head("autonomous/lab") != args.lab_sha:
        raise ValueError("sync pins changed before preparation")
    recheck_context(binding)
    capability.consume()
    result = prepare_sync(
        args.repo.resolve(), args.main_sha, args.manifest.resolve(),
        json.loads(args.pull_requests.read_text(encoding="utf-8")), config,
        lab_sha=args.lab_sha,
        state_sha=json.loads(args.state_revision.read_text(encoding="utf-8"))["state_sha"],
    )
    result["decision_id"] = intent["decision_id"]
    result["candidate_branch"] = args.candidate_branch
    if result["status"] != "prepared":
        recheck_context(binding)
        completion = store.record_completion(capability, result)
        return dict(result, completion_receipt_id=completion["receipt_id"])
    if git(args.repo, "ls-remote", "--heads", "origin", "refs/heads/" + args.candidate_branch).stdout:
        raise ValueError("candidate ref already exists")
    if not github.enabled() or github.head("main") != args.main_sha or github.head("autonomous/lab") != args.lab_sha:
        raise ValueError("sync conditions changed before candidate publication")
    recheck_context(binding)
    push(args.repo, result["candidate_sha"], args.candidate_branch)
    published = git(args.repo, "ls-remote", "--heads", "origin", "refs/heads/" + args.candidate_branch).stdout.decode().split()
    if not published or published[0] != result["candidate_sha"]:
        raise ValueError("candidate publication unconfirmed")
    evidence = {key: result[key] for key in ("status", "main_sha", "lab_sha", "candidate_sha", "queue_blob", "candidate_branch")}
    evidence["candidate_owned"] = True
    result["prepared_stage"] = store.record_checkpoint(capability, "sync_prepared", evidence)
    result["prepared_evidence"] = evidence
    result["candidate_owned"] = True
    return result


def finalize_execution(args, config, binding, store, github):
    result = json.loads(args.preparation.read_text(encoding="utf-8"))
    if result.get("status") != "prepared":
        return result
    reference = result["prepared_stage"]
    stage = store.checkpoint(reference["stage_id"])
    evidence = stage["evidence"]
    if result.get("prepared_evidence") != evidence:
        raise ValueError("artifact evidence differs from durable preparation")
    capability = store.claim_phase(stage["decision_id"], "sync_finalize",
                                   binding.trigger, binding.control_sha,
                                   {**reference, "evidence": evidence})
    if capability is None:
        return dict(result, publication="skipped", reason="finalization_already_claimed")
    if args.gates != "success":
        return dict(result, publication="blocked", reason="quality_gate_failed")
    main_sha, lab_sha, candidate_sha = (evidence[key] for key in ("main_sha", "lab_sha", "candidate_sha"))
    branch = evidence["candidate_branch"]
    git(args.repo, "fetch", "origin", "main", "autonomous/lab")
    git(args.repo, "fetch", "origin", "refs/heads/" + branch)
    if revision(args.repo, "FETCH_HEAD") != candidate_sha:
        raise ValueError("candidate ref changed")
    if revision(args.repo, "refs/remotes/origin/main") != main_sha or revision(args.repo, "refs/remotes/origin/autonomous/lab") != lab_sha:
        raise ValueError("sync heads changed")
    git(args.repo, "merge-base", "--is-ancestor", main_sha, candidate_sha)
    git(args.repo, "merge-base", "--is-ancestor", lab_sha, candidate_sha)
    for pin in (lab_sha, candidate_sha):
        if git(args.repo, "rev-parse", pin + ":" + QUEUE).stdout.decode().strip() != evidence["queue_blob"]:
            raise ValueError("candidate legacy queue changed")
    if not github.enabled():
        return dict(result, publication="disabled", reason="loop_disabled_before_publish")
    if github.head("main") != main_sha or github.head("autonomous/lab") != lab_sha:
        raise ValueError("sync heads changed before publication")
    recheck_context(binding)
    capability.consume()
    push(args.repo, candidate_sha, "autonomous/lab")
    published_lab_sha = github.head("autonomous/lab")
    if published_lab_sha != candidate_sha:
        raise ValueError("lab publication unconfirmed")
    receipt = store.record_effect(capability, "sync_publication", {
        "stage_id": stage["stage_id"], "main_sha": main_sha, "lab_sha": lab_sha,
        "candidate_sha": candidate_sha, "published_lab_sha": published_lab_sha,
        "queue_blob": evidence["queue_blob"], "candidate_branch": branch, "quality_gate": "success",
    })
    result.update(publication="published", reason="verified_fast_forward", effect_receipt_id=receipt["receipt_id"])
    # Both mutations remain inside the one consumed finalize capability. A rerun
    # cannot repeat refresh or cleanup even when publication itself was successful.
    if github.enabled():
        manifest = load_state(args.repo, args.manifest, args.state_revision)
        result["refresh"] = refresh(manifest, config["repository"], candidate_sha)
    remote = git(args.repo, "ls-remote", "--heads", "origin", "refs/heads/" + branch).stdout.decode().split()
    if github.enabled() and remote and remote[0] == candidate_sha:
        git(args.repo, "-c", "http.https://github.com/.extraheader=", "-c", "credential.helper=",
            "-c", "credential.https://github.com.helper=!gh auth git-credential", "push",
            "--force-with-lease=refs/heads/" + branch + ":" + candidate_sha,
            "origin", ":refs/heads/" + branch)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--action", choices=("prepare", "finalize"), default="prepare")
    parser.add_argument("--main-sha", default="")
    parser.add_argument("--lab-sha", default="")
    parser.add_argument("--candidate-branch", default="")
    parser.add_argument("--preparation", type=Path)
    parser.add_argument("--gates", default="")
    add_arguments(parser)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--state-revision", type=Path, required=True)
    parser.add_argument("--pull-requests", type=Path)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    preparation = {}
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        from lab_controller import GitHub
        binding = context(args, "autonomous_sync.yml", config)
        store = JournalStore(args.repo, args.manifest, args.state_revision)
        github = GitHub(config["repository"])
        if args.action == "prepare":
            load_state(args.repo, args.manifest, args.state_revision)
            result = prepare_execution(args, config, binding, store, github)
        else:
            preparation = json.loads(args.preparation.read_text(encoding="utf-8"))
            result = finalize_execution(args, config, binding, store, github)
    except (OSError, ValueError, RuntimeError, TypeError, AttributeError, KeyError, subprocess.CalledProcessError):
        # Git diagnostics and PR bodies can contain private data; artifacts only
        # contain the fixed result schema, never subprocess output or inputs.
        result = {
            "status": "conflict", "reason": "finalization_failed" if args.action == "finalize" else "preparation_failed",
            "main_sha": (preparation.get("main_sha", "") if isinstance(preparation, dict) else "") if args.action == "finalize" else args.main_sha,
            "lab_sha": "", "candidate_sha": "", "conflicts": [], "queue_blob": "",
            "state_sha": "", "publication": "unknown" if args.action == "finalize" else "not_prepared",
        }
        if not SHA.fullmatch(str(result["main_sha"])):
            result["main_sha"] = ""
    encoded = json.dumps(result, ensure_ascii=True, indent=2) + "\n"
    args.out.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 1 if result["status"] in {"conflict", "blocked"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
