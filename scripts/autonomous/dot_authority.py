#!/usr/bin/env python3
"""Portable R2-J record/preflight validator; no GitHub client, scheduler or Jules calls.

The native Dot workflow supplies complete fresh plugin observations and retains
operation intents. This helper audits those records; it is not a credential
broker or technical separation between two users sharing one GitHub identity.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

SHA = re.compile(r"[0-9a-f]{40}\Z")
TASK = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
LIMITS = {"active_tasks": 1, "active_drafts": 1, "files": 10, "lines": 1000, "ci_revisions": 3}
V2_LIMITS = {"active_tasks": 1, "active_prs": 1, "files": 10, "lines": 1000, "ci_revisions": 3}
V2_ACTIONS = {"develop", "test", "commit", "draft_create", "draft_update", "checkpoint",
              "request_review", "ready_for_review", "squash_merge"}
RESERVED_MODULES = sys.stdlib_module_names | {"__init__", "sitecustomize", "usercustomize", "yaml"}


def digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()


def instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset().total_seconds() != 0:
        raise ValueError("timestamps must use UTC")
    return parsed


def integer(value, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(label + " must be a nonnegative integer")
    return value


def policy_check(policy: dict) -> None:
    version = policy.get("schema")
    if (version not in (1, 2) or policy.get("kind") != "dot-r2-j-policy"
            or policy.get("limits") != (LIMITS if version == 1 else V2_LIMITS)
            or policy.get("identity_mode") != "shared-github-procedural"
            or policy.get("repository") != "Omnividente/omp-desktop"
            or policy.get("branch_prefix") != "dot/jules-" or policy.get("base_branch") != "main"
            or policy.get("schedule_minutes") != 60):
        raise ValueError("unsupported R2-J policy; owner policy changes require separate acceptance")
    if version == 2 and (policy.get("version") != 2
                         or set(policy.get("allowed_actions", [])) != V2_ACTIONS):
        raise ValueError("unsupported autonomous-integration policy version/actions")


def _acceptance_check(acceptance: dict) -> None:
    if acceptance.get("decision") != "accept" or not acceptance.get("decision_ref"):
        raise ValueError("separate exact-revision owner acceptance is required")
    for key in ("accepted_head_sha", "accepted_base_sha", "accepted_main_sha"):
        if not SHA.fullmatch(str(acceptance.get(key, ""))):
            raise ValueError("acceptance requires " + key)
    if integer(acceptance.get("accepted_pr"), "accepted_pr") == 0:
        raise ValueError("acceptance requires a PR")
    checks = acceptance.get("check_runs")
    if not isinstance(checks, list) or not checks:
        raise ValueError("acceptance must retain exact check run identities and attempts")
    for check in checks:
        if (not isinstance(check, dict) or check.get("conclusion") != "success"
                or check.get("head_sha") != acceptance["accepted_head_sha"]
                or integer(check.get("run_id"), "run_id") == 0
                or integer(check.get("attempt"), "attempt") == 0):
            raise ValueError("checks must be successful on the accepted head")


def prepare_grant(policy: dict, acceptance: dict, now: datetime) -> dict:
    """Owner-only preparation; emitting bytes neither publishes nor activates them."""
    policy_check(policy)
    _acceptance_check(acceptance)
    version = policy["schema"]
    grant = {"schema": version, "kind": "dot-r2-j-grant",
             "id": ("r2-j-" if version == 1 else "r2-j-v2-") + uuid.uuid4().hex,
             "repository": policy["repository"], "policy_sha256": digest(policy),
             "identity_mode": policy["identity_mode"], "issued_at": now.isoformat(),
             "expires_at": None, "acceptance": deepcopy(acceptance)}
    if version == 2:
        previous = acceptance.get("supersedes_grant_id")
        if not isinstance(previous, str) or not re.fullmatch(r"r2-j-(?:v2-)?[0-9a-f]{32}", previous):
            raise ValueError("v2 acceptance must explicitly supersede the old grant")
        grant.update(version=2, policy_path="docs/dot/r2-j-policy-v2.json",
                     supersedes_grant_id=previous)
    return grant


def authority(policy: dict, packet: dict, now: datetime) -> str:
    policy_check(policy)
    grant, index, issue = packet["grant"], packet["index"], packet["issue"]
    version = policy["schema"]
    identity = r"r2-j-[0-9a-f]{32}" if version == 1 else r"r2-j-v2-[0-9a-f]{32}"
    if not isinstance(grant.get("id"), str) or not re.fullmatch(identity, grant["id"]):
        raise ValueError("immutable grant identity is required")
    if (issue.get("html_url") != policy["control_issue"] or issue.get("state") != "open"
            or index.get("schema") != version or index.get("status") != "active"
            or index.get("repository") != policy["repository"]
            or not isinstance(index.get("grant"), dict)):
        raise ValueError("authority is staged, unavailable or revoked")
    binding = index["grant"]
    if (grant.get("schema") != version or grant.get("kind") != "dot-r2-j-grant"
            or grant.get("repository") != policy["repository"]
            or grant.get("identity_mode") != policy["identity_mode"]
            or grant.get("policy_sha256") != digest(policy)
            or binding.get("id") != grant.get("id") or binding.get("sha256") != digest(grant)
            or integer(binding.get("comment_id"), "comment_id") == 0
            or not isinstance(index.get("revoked_grants"), list)
            or grant["id"] in index["revoked_grants"]):
        raise ValueError("grant/index/export binding is invalid or revoked")
    _acceptance_check(grant.get("acceptance") or {})
    previous = grant.get("supersedes_grant_id")
    if version == 2 and (grant.get("version") != 2 or index.get("policy_version") != 2
                         or grant.get("policy_path") != "docs/dot/r2-j-policy-v2.json"
                         or not isinstance(previous, str)
                         or not re.fullmatch(r"r2-j-(?:v2-)?[0-9a-f]{32}", previous)
                         or previous != grant["acceptance"].get("supersedes_grant_id")
                         or previous not in index["revoked_grants"]):
        raise ValueError("new owner grant/index must explicitly supersede, not reinterpret, v1")
    issued = instant(grant["issued_at"])
    if issued > now or (grant["expires_at"] is not None and instant(grant["expires_at"]) <= now):
        raise ValueError("grant is not currently effective")
    events = packet["issue_events"]
    if packet.get("events_complete") is not True or not isinstance(events, list):
        raise ValueError("complete revocation history is required")
    ids = [event["id"] for event in events]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate revocation events")
    if any(event.get("event") == "closed" and instant(event["created_at"]) >= issued for event in events):
        raise ValueError("closing permanently revokes this grant; reopening is not reactivation")
    return grant["id"]


def allowed_path(policy: dict, name: str) -> bool:
    path = PurePosixPath(name)
    if (not name or "\\" in name or "\x00" in name or name != str(path)
            or path.is_absolute() or any(part in ("..", ".") for part in path.parts)
            or path.name.lower() in ("agents.md", "claude.md")
            or name in policy["protected_paths"] or path.name.lower().startswith("dot_")
            or (name.startswith("scripts/autonomous/") and path.stem.lower() in RESERVED_MODULES)):
        return False
    return ((name.startswith("scripts/autonomous/") and path.suffix == ".py")
            or (name.startswith("docs/autonomous/") and path.suffix in (".md", ".rst", ".txt")))


def changes_check(policy: dict, changes: list) -> tuple[set, int, list]:
    paths, seen, lines, critical = set(), set(), 0, []
    for change in changes:
        name = change["filename"]
        previous = change.get("previous_filename", name)
        if (not allowed_path(policy, name) or not allowed_path(policy, previous)
                or change.get("mode") not in ("100644", "100755")
                or change.get("binary") is not False):
            raise ValueError("excluded, unknown-mode or binary change: " + name)
        if name in seen:
            raise ValueError("duplicate changed-file metadata")
        seen.add(name)
        paths.update((name, previous))
        lines += integer(change["additions"], "additions") + integer(change["deletions"], "deletions")
        if (name.startswith("docs/autonomous/")
                or any(term in name for term in policy["critical_source_terms"])):
            critical.append(name)
    return paths, lines, critical


def evaluate(policy: dict, packet: dict, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    policy_check(policy)
    action = packet["action"]
    if action == "observe":
        return {"mode": "observe", "write_authorized": False}
    if action not in policy["allowed_actions"]:
        raise ValueError("operation requires separate owner authorization")
    if action not in ("commit", "develop") and packet["changes"]:
        raise ValueError("metadata and test actions must not include unreserved source changes")
    grant_id = authority(policy, packet, now)
    task = packet["task"]
    task_id = task["id"]
    retired = packet.get("retired_task_ids")
    if (not isinstance(retired, list)
            or any(not isinstance(item, str) or not TASK.fullmatch(item) for item in retired)
            or "active_task_id" not in packet or "unresolved_operation" not in task
            or type(task.get("initial_published")) is not bool):
        raise ValueError("complete known task history and publication/operation state are required")
    if (not TASK.fullmatch(task_id) or task["branch"] != policy["branch_prefix"] + task_id
            or not SHA.fullmatch(task["base_sha"]) or not SHA.fullmatch(task["head_sha"])
            or task_id in retired):
        raise ValueError("invalid or reused task/branch identity")
    if (packet.get("active_task_id") not in (None, task_id)
            or task.get("unresolved_operation") is not None):
        raise ValueError("another task or unresolved operation forbids new effects; reconcile read-only")
    if packet.get("inventory_complete") is not True:
        raise ValueError("complete fresh PR/file/rename inventory is required")
    for pr in packet["open_prs"]:
        if pr["branch"].startswith("dot/"):
            current_state = (pr["draft"] is True if policy["schema"] == 1
                             else type(pr["draft"]) is bool)
            if (pr["branch"] != task["branch"] or not current_state
                    or pr["base"] != "main" or pr["repository"] != policy["repository"]
                    or pr["head_sha"] != task["head_sha"]):
                raise ValueError("only one owned current proposal is permitted")
    if len([pr for pr in packet["open_prs"] if pr["branch"].startswith("dot/")]) > 1:
        raise ValueError("multiple active Dot Drafts")
    if packet.get("freshness_verified") is not True or packet.get("overlap_checked") is not True:
        raise ValueError("fresh main/head/lease and semantic-overlap evidence are required")
    if action == "test" and packet.get("test_environment") not in (
            "secret-free-pr-ci", "isolated-synthetic-no-credentials"):
        raise ValueError("candidate code requires isolated synthetic execution, never production credentials")
    paths, lines, critical = changes_check(policy, packet["changes"])
    prior_paths = task["touched_paths"]
    if not isinstance(prior_paths, list) or any(not allowed_path(policy, name) for name in prior_paths):
        raise ValueError("invalid retained task paths")
    paths |= set(prior_paths)
    lines += integer(task["spent_lines"], "spent_lines")
    revisions = integer(task["ci_revisions"], "ci_revisions")
    revision = packet.get("ci_driven_revision")
    if type(revision) is not bool:
        raise ValueError("explicit CI revision accounting is required")
    if action in ("commit", "develop") and packet["changes"]:
        if task["initial_published"] and not revision:
            raise ValueError("source changes after initial publication consume a CI revision")
        revisions += int(revision)
    if len(paths) > 10 or lines > 1000 or revisions > 3:
        raise ValueError("R2-J task budget exhausted; preserve Draft/history and hand off")
    result = {"mode": "r2-j" if policy["schema"] == 1 else "r2-j-v2",
              "write_authorized": True, "grant_id": grant_id,
              "counters": {"touched_paths": sorted(paths), "spent_lines": lines, "ci_revisions": revisions},
              "critical_review_paths": critical}
    if action in ("ready_for_review", "squash_merge"):
        from dot_merge import integration_check
        try:
            result["integration"] = integration_check(policy, packet, now)
        except (KeyError, TypeError, AttributeError) as exc:
            raise ValueError("incomplete or malformed integration evidence") from exc
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare-grant", "check", "migrate-state"))
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    try:
        policy = json.loads(args.policy.read_text(encoding="utf-8"))
        packet = json.loads(args.input.read_text(encoding="utf-8"))
        if args.command == "prepare-grant":
            result = prepare_grant(policy, packet, datetime.now(timezone.utc))
        elif args.command == "migrate-state":
            from dot_state import migrate_state
            policy_check(policy)
            if policy["schema"] != 2 or packet["grant"].get("policy_sha256") != digest(policy):
                raise ValueError("owner migration requires the accepted v2 policy and bound new grant")
            _acceptance_check(packet["grant"].get("acceptance") or {})
            result = migrate_state(packet["state"], packet["grant"], packet["acceptance"],
                                   expected_blob_sha=packet["expected_blob_sha"], now=datetime.now(timezone.utc))
        else:
            result = evaluate(policy, packet)
        text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
        if args.out:
            with args.out.open("x", encoding="utf-8") as handle:
                handle.write(text)
        print(text, end="")
        return 0
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print("R2-J denied: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
