#!/usr/bin/env python3
"""Read-only full-state proof around the EXISTING owner fence command.

No mutation, dispatch, replay, or permission is implemented here. The runner's
Git object database retains the full baseline; only bounded hashes/identities
are exposed to the caller. Native recovery admission/CAS remains authoritative.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess

REPOSITORY = "Omnividente/omp-desktop"
WORKFLOW = "autonomous_recover_delivery.yml"
STATE_REF = "refs/heads/autonomous/state"
QUEUE = "agent_tasks.json"
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
MAX_METADATA = 8192


def require(ok, code):
    if not ok:
        raise ValueError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def strict_json(raw):
    def pairs(rows):
        obj = {}
        for key, value in rows:
            require(key not in obj, "duplicate_json_key")
            obj[key] = value
        return obj
    def constant(_):
        raise ValueError("nonfinite_json")
    def finite(token):
        value = float(token)
        require(math.isfinite(value), "nonfinite_json")
        return value
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant, parse_float=finite)
    require(type(value) is dict, "not_json_object")
    return value


def git(repo, *args):
    # Never follow replace refs or leak credential-bearing Git stderr.
    env = {**os.environ, "GIT_NO_REPLACE_OBJECTS": "1", "GIT_TERMINAL_PROMPT": "0"}
    result = subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull,
                             *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env=env, timeout=180, check=False)
    require(result.returncode == 0, "git_read_failed")
    return result.stdout


def live_sha(repo):
    rows = git(repo, "ls-remote", "--exit-code", "origin", STATE_REF).decode().splitlines()
    require(len(rows) == 1, "ambiguous_state_ref")
    sha, ref = rows[0].split("\t")
    require(SHA.fullmatch(sha) and ref == STATE_REF, "invalid_state_ref")
    return sha


def fetch_state(repo, expected):
    require(SHA.fullmatch(expected), "invalid_state_sha")
    require(live_sha(repo) == expected, "state_pin_moved")
    # Read-only fetch, without moving any local or remote branch. Full ancestry.
    git(repo, "fetch", "--no-tags", "origin", expected)
    require(live_sha(repo) == expected, "state_pin_moved")


def snapshot(repo, sha):
    require(SHA.fullmatch(sha), "invalid_state_sha")
    require(git(repo, "cat-file", "-t", sha).strip() == b"commit", "not_commit")
    entries = git(repo, "ls-tree", "-z", sha).split(b"\0")
    require(len(entries) == 2 and entries[-1] == b"", "unexpected_state_tree")
    mode, kind, entry = entries[0].split(b" ", 2)
    blob, path = entry.split(b"\t", 1)
    require(mode == b"100644" and kind == b"blob" and path == QUEUE.encode()
            and SHA.fullmatch(blob.decode()), "unexpected_state_blob")
    size = int(git(repo, "cat-file", "-s", blob.decode()).strip())
    raw = git(repo, "cat-file", "blob", blob.decode())
    actual = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    require(len(raw) == size and actual == blob.decode(), "blob_integrity_failed")
    data = strict_json(raw)
    meta = {"commit_sha": sha, "blob_sha": actual, "bytes": size,
            "sha256": hashlib.sha256(raw).hexdigest()}
    return data, meta


def checked_context(repo, expected, decision):
    require(SHA.fullmatch(expected) and DIGEST.fullmatch(decision), "invalid_inputs")
    env = os.environ
    control = env.get("GITHUB_SHA", "")
    require(SHA.fullmatch(control), "invalid_control")
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY
            and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and env.get("GITHUB_REF") == "refs/heads/main"
            and env.get("CONTROL_SHA") == control
            and env.get("GITHUB_WORKFLOW_SHA") == control
            and env.get("GITHUB_WORKFLOW_REF") == REPOSITORY + "/.github/workflows/" + WORKFLOW + "@refs/heads/main",
            "wrong_workflow_context")
    require(git(repo, "rev-parse", "HEAD").decode().strip() == control, "wrong_checkout")
    origin = git(repo, "remote", "get-url", "--all", "origin").decode().strip()
    require(origin in ("https://github.com/" + REPOSITORY,
                       "https://github.com/" + REPOSITORY + ".git"), "wrong_origin")
    event = strict_json(Path(env["GITHUB_EVENT_PATH"]).read_bytes())
    actor = env.get("GITHUB_ACTOR", "")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9\[\]-]{0,99}", actor)
            and env.get("GITHUB_TRIGGERING_ACTOR") == actor
            and event.get("sender", {}).get("login") == actor
            and event.get("repository", {}).get("full_name") == REPOSITORY
            and event.get("ref") in ("main", "refs/heads/main")
            and event.get("inputs") == {"expected_state_sha": expected, "decision_id": decision},
            "wrong_owner_event")
    for field in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"):
        require(re.fullmatch(r"[1-9][0-9]*", env.get(field, "")), "invalid_run")
    return {"repository": REPOSITORY, "workflow": WORKFLOW, "ref": "refs/heads/main",
            "event_name": "workflow_dispatch", "control_sha": control,
            "run_id": env["GITHUB_RUN_ID"], "run_attempt": env["GITHUB_RUN_ATTEMPT"],
            "actor": actor, "expected_state_sha": expected, "decision_id": decision}


def compare_full_states(before, after, result, context):
    """Exact full-body/prefix equality, NOT a selected-field health digest."""
    require(set(result) == {"outcome", "decision_id", "receipt_id", "state_sha", "frontier_seq"}
            and result["outcome"] == "fenced"
            and result["decision_id"] == context["decision_id"]
            and SHA.fullmatch(str(result["state_sha"]))
            and DIGEST.fullmatch(str(result["receipt_id"]))
            and type(result["frontier_seq"]) is int and result["frontier_seq"] > 0,
            "not_acknowledged_new_fence")
    old_body = {k: v for k, v in before.items() if k != "dispatch_journal"}
    new_body = {k: v for k, v in after.items() if k != "dispatch_journal"}
    # Canonical bytes distinguish bool/int and every timestamp/unknown field.
    body_hash = digest(old_body)
    require(body_hash == digest(new_body), "substantive_body_changed")
    old, new = before.get("dispatch_journal"), after.get("dispatch_journal")
    require(type(old) is dict and type(new) is dict
            and type(old.get("events")) is list and old["events"]
            and type(new.get("events")) is list, "invalid_journal")
    require(canonical({k: v for k, v in old.items() if k != "events"}) ==
            canonical({k: v for k, v in new.items() if k != "events"}), "journal_header_changed")
    count = len(old["events"])
    require(len(new["events"]) == count + 1, "not_one_event")
    prefix_hash = digest(old["events"])
    require(prefix_hash == digest(new["events"][:count]), "journal_prefix_changed")
    event = new["events"][-1]
    require(type(event) is dict and set(event) == {
        "type", "at", "decision_id", "kind", "owner_trigger", "before_state_sha",
        "before_digest", "receipt_id", "frontier_seq", "event_id"}, "wrong_fence_fields")
    require(event["type"] == "OwnerFence" and event["kind"] == "owner_revoked_unclaimed"
            and event["decision_id"] == context["decision_id"]
            and event["before_state_sha"] == context["expected_state_sha"]
            and canonical(event["owner_trigger"]) == canonical(context)
            and type(event["frontier_seq"]) is int
            and event["frontier_seq"] == result["frontier_seq"]
            and event["receipt_id"] == result["receipt_id"], "fence_identity_changed")
    require(event["event_id"] == digest({k: v for k, v in event.items() if k != "event_id"}),
            "invalid_event_hash")
    require(DIGEST.fullmatch(str(event["before_digest"])), "invalid_native_digest")
    receipt = digest([context["decision_id"], digest(["workflow_dispatch", context["run_id"]]),
                      "owner_revoked_unclaimed", {"owner_trigger": context,
                       "before_state_sha": context["expected_state_sha"], "before_digest": event["before_digest"]}])
    require(receipt == result["receipt_id"], "invalid_receipt_hash")
    return {"body_sha256": body_hash, "prior_journal_sha256": prefix_hash,
            "prior_event_count": count, "added_event_id": event["event_id"],
            "added_event_count": 1, "native_receipt_id": receipt,
            "native_frontier_seq": result["frontier_seq"]}


def prepare(repo, expected, context):
    fetch_state(repo, expected)
    _, meta = snapshot(repo, expected)
    return {"schema": 1, "kind": "owner-fence-baseline", "context": context, "before": meta}


def verify(repo, baseline, result, context):
    require(set(baseline) == {"schema", "kind", "context", "before"}
            and type(baseline["schema"]) is int and baseline["schema"] == 1
            and baseline["kind"] == "owner-fence-baseline"
            and canonical(baseline["context"]) == canonical(context), "baseline_context_changed")
    expected = context["expected_state_sha"]
    before, before_meta = snapshot(repo, expected)
    require(canonical(before_meta) == canonical(baseline["before"]), "baseline_object_changed")
    require(result.get("outcome") == "fenced", "not_acknowledged_new_fence")
    after_sha = result.get("state_sha", "")
    fetch_state(repo, after_sha)
    parents = git(repo, "rev-list", "--parents", "-n", "1", after_sha).decode().split()
    require(parents == [after_sha, expected], "wrong_state_parent")
    after, after_meta = snapshot(repo, after_sha)
    checks = compare_full_states(before, after, result, context)
    require(live_sha(repo) == after_sha, "state_pin_moved")
    return {"schema": 1, "kind": "owner-fence-full-state-proof", "status": "verified",
            "context": context, "before": before_meta, "after": after_meta,
            "checks": checks, "native_outcome": "fenced", "allows_sync": True}


def write_record(path, value):
    raw = canonical(value) + b"\n"
    require(len(raw) <= MAX_METADATA, "report_too_large")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation prevents stale output reuse on an accidentally repeated step.
    with path.open("xb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    return raw


def small_record(path):
    require(path.stat().st_size <= MAX_METADATA, "metadata_too_large")
    return strict_json(path.read_bytes())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("before", "after"))
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--expected-state-sha", required=True)
    parser.add_argument("--decision-id", required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--result", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    try:
        # Outputs must be outside the checked source and separate from inputs.
        paths = [p.resolve() for p in (args.baseline, args.result, args.out) if p is not None]
        require(len(paths) == len(set(paths)) and all(
            not p.is_relative_to(args.repo.resolve()) for p in paths), "unsafe_record_paths")
        context = checked_context(args.repo, args.expected_state_sha, args.decision_id)
        if args.phase == "before":
            require(args.result is None and args.out is None and not args.baseline.exists(), "wrong_before_inputs")
            record = prepare(args.repo, args.expected_state_sha, context)
            write_record(args.baseline, record)
            print("OWNER_FENCE_BASELINE=" + canonical(record).decode())
        else:
            require(args.result is not None and args.out is not None and not args.out.exists(), "wrong_after_inputs")
            record = verify(args.repo, small_record(args.baseline), small_record(args.result), context)
            raw = write_record(args.out, record)
            print("OWNER_FENCE_PROOF=" + raw.decode().strip())
        return 0
    except (ValueError, KeyError, TypeError, AttributeError, OSError, RecursionError,
            OverflowError, subprocess.SubprocessError):
        # No exception text, paths, URLs or queue contents in public logs.
        print('OWNER_FENCE_PROOF={"schema":1,"status":"blocked","allows_sync":false}')
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
