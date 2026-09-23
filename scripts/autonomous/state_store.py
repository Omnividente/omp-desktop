#!/usr/bin/env python3
"""Persist the lab's one JSON queue without advancing the product branch.

The first successful save migrates the legacy lab blob verbatim. Every later
save has the previously read state commit as its parent and an explicit lease.
A failed/ambiguous push never authorizes overwriting a newer queue.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

from validate_tasks import validate
from research_request import ATTEMPT_FIELDS, CONTRACT_VERSION

STATE_BRANCH = "autonomous/state"
QUEUE = "agent_tasks.json"
SHA = re.compile(r"[0-9a-f]{40}\Z")


class StateConflict(RuntimeError):
    """Another writer advanced the queue; reload, do not overwrite it."""


def _git(repo: Path, *args: str, data: bytes | None = None, check: bool = True):
    result = subprocess.run(
        ["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
        input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90,
    )
    if check and result.returncode:
        # Git stderr can include credential-bearing remote URLs.
        raise RuntimeError("state git operation failed: " + args[0])
    return result


def _ref(branch: str) -> str:
    if branch != STATE_BRANCH:
        raise ValueError("the state store may only write autonomous/state")
    return "refs/heads/" + branch


def _remote_head(repo: Path, branch: str) -> str:
    ref = _ref(branch)
    result = _git(repo, "ls-remote", "--exit-code", "origin", ref, check=False)
    if result.returncode == 2:
        return ""
    if result.returncode:
        raise RuntimeError("cannot read the state ref; refusing a fallback queue")
    rows = result.stdout.decode("utf-8").splitlines()
    if len(rows) != 1:
        raise RuntimeError("ambiguous state ref response")
    sha, name = rows[0].split("\t", 1)
    if name != ref or not SHA.fullmatch(sha):
        raise RuntimeError("invalid state ref response")
    return sha


def _atomic_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _manifest(raw: bytes) -> dict:
    data = json.loads(raw)
    errors = validate(data)
    if errors:
        raise ValueError("invalid state queue: " + "; ".join(errors))
    return data


def _record(path: Path, *, revision: str, raw: bytes, branch: str, source: str,
            seed_blob: str = "") -> None:
    _atomic_bytes(path, (json.dumps({
        "state_sha": revision, "digest": hashlib.sha256(raw).hexdigest(),
        "branch": branch, "source": source,
        "seed_blob": seed_blob,
    }, indent=2) + "\n").encode("utf-8"))


def load_state(
    repo: Path, manifest_path: Path, revision_path: Path,
    branch: str = STATE_BRANCH, seed_path: Path | None = None,
) -> dict:
    """Read authoritative state, or an untouched legacy seed if no ref exists."""
    repo, manifest_path, revision_path = map(Path, (repo, manifest_path, revision_path))
    _ref(branch)
    seed = Path(seed_path) if seed_path is not None else repo / QUEUE
    if manifest_path.resolve() == seed.resolve():
        raise ValueError("state output must not overwrite the legacy product queue")
    revision = _remote_head(repo, branch)
    if revision:
        _git(repo, "fetch", "--no-tags", "origin", revision)
        raw = _git(repo, "show", revision + ":" + QUEUE).stdout
    else:
        # Missing state is distinct from a network/authentication failure.
        raw = seed.read_bytes()
    data = _manifest(raw)
    _atomic_bytes(manifest_path, raw)
    seed_blob = _git(repo, "hash-object", "-w", "--stdin", data=raw).stdout.decode().strip() if not revision else ""
    _record(revision_path, revision=revision, raw=raw, branch=branch,
            source="state" if revision else "legacy", seed_blob=seed_blob)
    return data


def _commit(repo: Path, raw: bytes, parent: str = "") -> str:
    blob = _git(repo, "hash-object", "-w", "--stdin", data=raw).stdout.decode().strip()
    tree = _git(repo, "mktree", data=("100644 blob " + blob + "\t" + QUEUE + "\n").encode()).stdout.decode().strip()
    return _git(
        repo, "-c", "user.name=github-actions[bot]", "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "-c", "commit.gpgsign=false", "commit-tree", tree, *(["-p", parent] if parent else []),
        data=b"chore(autonomous): record laboratory state\n",
    ).stdout.decode().strip()


def save_state(
    repo: Path, manifest_path: Path, revision_path: Path,
    branch: str = STATE_BRANCH,
) -> str:
    """Publish one validated queue revision using compare-and-swap."""
    repo, manifest_path, revision_path = map(Path, (repo, manifest_path, revision_path))
    ref = _ref(branch)
    metadata = json.loads(revision_path.read_text(encoding="utf-8"))
    expected = metadata.get("state_sha", "")
    if metadata.get("branch") != branch or (expected and not SHA.fullmatch(expected)):
        raise ValueError("invalid state revision metadata")
    if manifest_path.resolve() == (repo / QUEUE).resolve():
        raise ValueError("state output must not be the product queue")
    raw = manifest_path.read_bytes()
    data = _manifest(raw)
    if _remote_head(repo, branch) != expected:
        raise StateConflict("state advanced since it was read")
    if expected and hashlib.sha256(raw).hexdigest() == metadata.get("digest"):
        return expected
    parent = expected
    if not expected:
        seed_blob = metadata.get("seed_blob", "")
        if not SHA.fullmatch(seed_blob):
            raise ValueError("migration requires the original legacy seed blob")
        original = _git(repo, "cat-file", "blob", seed_blob).stdout
        if hashlib.sha256(original).hexdigest() != metadata.get("digest"):
            raise ValueError("legacy seed no longer matches the loaded revision")
        _manifest(original)
        parent = _commit(repo, original)
        commit = parent if raw == original else _commit(repo, raw, parent)
    else:
        previous = _manifest(_git(repo, "show", expected + ":" + QUEUE).stdout)
        if previous["version"] == CONTRACT_VERSION and data["version"] != CONTRACT_VERSION:
            raise ValueError("the research contract cannot be downgraded")
        current_tasks = {task["id"]: task for task in data["tasks"]}
        for task in previous["tasks"]:
            old = task.get("execution") or {}
            if "research_request" not in old:
                continue
            new = current_tasks.get(task["id"], {}).get("execution") or {}
            if old["research_request"] == new.get("research_request"):
                if (new.get("attempts"), new.get("dispatch_key")) != (old.get("attempts"), old.get("dispatch_key")):
                    raise ValueError("a saved research request cannot change its attempt identity")
                if new.get("research_request_history", []) != old.get("research_request_history", []):
                    raise ValueError("research request history is immutable")
                continue
            if (new.get("attempts") != old["attempts"] + 1 or new.get("state") != "dispatching"
                    or new.get("dispatch_key") == old["dispatch_key"]
                    or (new.get("research_request") or {}).get("contract_version") != CONTRACT_VERSION):
                raise ValueError("a saved research request is immutable within its attempt")
            archived = {field: old[field] for field in ATTEMPT_FIELDS if field in old}
            if new.get("research_request_history") != [*old.get("research_request_history", []), archived]:
                raise ValueError("a new attempt must retain the previous research request")
        commit = _commit(repo, raw, parent)
    for attempt in range(3):
        try:
            result = _git(
                repo, "-c", "http.https://github.com/.extraheader=", "-c", "credential.helper=",
                "-c", "credential.https://github.com.helper=!gh auth git-credential",
                "push", "--force-with-lease=" + ref + ":" + expected,
                "origin", commit + ":" + ref, check=False,
            )
        except subprocess.TimeoutExpired:
            result = None
        observed = _remote_head(repo, branch)
        if observed == commit:
            _record(revision_path, revision=commit, raw=raw, branch=branch, source="state")
            return commit
        if observed != expected:
            raise StateConflict("state changed during publication; local result retained")
        if result is not None and result.returncode == 0:
            raise RuntimeError("state publication could not be verified")
        if attempt < 2:
            time.sleep(attempt + 1)
    raise RuntimeError("state publication failed; durable attempt must be reconciled before retry")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("load", "save"), required=True)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--revision-file", required=True, type=Path)
    parser.add_argument("--branch", default=STATE_BRANCH)
    parser.add_argument("--seed", type=Path)
    args = parser.parse_args(argv)
    if args.action == "load":
        load_state(args.repo, args.manifest, args.revision_file, args.branch, args.seed)
        print(args.revision_file.read_text(encoding="utf-8"))
    else:
        print(json.dumps({"state_sha": save_state(args.repo, args.manifest, args.revision_file, args.branch)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
