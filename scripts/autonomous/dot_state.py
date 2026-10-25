#!/usr/bin/env python3
"""Pure Dot state transitions, not a GitHub client or an execution authority.

The caller authenticates observations and runs the accepted-policy preflight.
Persist each returned intent with the CURRENT GitHub content.sha CAS before its
single send. An unknown CAS permits no send. Reconciliation only consumes GET
observations; it never issues a replacement claim, even after explicit rejection.
Migration prepares owner-accepted bytes, never activates a grant or writes state.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import re

from dot_authority import digest

REPOSITORY = "Omnividente/omp-desktop"
WORKFLOWS = (".github/workflows/pr.yml",
             ".github/workflows/autonomous_control_ci.yml",
             ".github/workflows/codeql.yml")


def _object(value, label):
    if not isinstance(value, dict):
        raise ValueError(label + " must be an object")
    return value


def _text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(label + " is required")
    return value


def _hex(value, length, label):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{%d}" % length, value):
        raise ValueError(label + " must be a lowercase hexadecimal digest")
    return value


def _integer(value, label, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(label + " must be an integer >= " + str(minimum))
    return value


def _time(value):
    if (not isinstance(value, datetime) or value.tzinfo is None
            or value.utcoffset() != timezone.utc.utcoffset(value)):
        raise ValueError("now must be a UTC datetime")
    return value.isoformat()


def _timestamp(value, now):
    try:
        parsed = datetime.fromisoformat(_text(value, "timestamp").replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid timestamp") from exc
    _time(parsed)
    if parsed > now:
        raise ValueError("observation timestamp is in the future")


def _json(value):
    try:
        digest(value)
    except (TypeError, ValueError, OverflowError, RecursionError) as exc:
        raise ValueError("state and evidence must be finite JSON values") from exc


def _state(state, schema):
    _object(state, "state")
    _json(state)
    if type(state.get("schema")) is not int or state["schema"] != schema:
        raise ValueError("unexpected state schema")
    _text(state.get("grant_id"), "grant_id")
    for key in ("active_task", "lease", "pending_operation"):
        if key not in state:
            raise ValueError("missing state field " + key)
        if state[key] is not None:
            _object(state[key], key)
    for key in ("operations", "retired_task_ids", "backlog"):
        if not isinstance(state.get(key), list):
            raise ValueError("missing state history " + key)
    for key in ("completed_tasks", "migrations"):
        if key in state and not isinstance(state[key], list):
            raise ValueError("invalid state history " + key)
    if any(not isinstance(row, dict) for row in state["operations"]):
        raise ValueError("invalid operation history")
    retired = state["retired_task_ids"]
    if any(not isinstance(item, str) or not item for item in retired) or len(set(retired)) != len(retired):
        raise ValueError("invalid retired task history")


def _task(state):
    task = _object(state["active_task"], "active_task")
    task_id = _text(task.get("id"), "task id")
    if (not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", task_id)
            or task.get("branch") != "dot/jules-" + task_id or task_id in state["retired_task_ids"]):
        raise ValueError("invalid or retired active task identity")
    for key in ("base_sha", "head_sha"):
        _hex(task.get(key), 40, key)
    for key in ("spent_lines", "ci_revisions"):
        _integer(task.get(key), key)
    pr = _object(task.get("pr"), "task PR")
    _integer(pr.get("number"), "PR number", 1)
    if pr.get("repository", REPOSITORY) != REPOSITORY:
        raise ValueError("foreign task PR repository")
    if "unresolved_operation" not in task or task["unresolved_operation"] is not None:
        raise ValueError("a missing or unresolved task operation forbids transitions")
    return task


def _expected(state, task, evidence):
    _object(evidence, "evidence")
    _json(evidence)
    for key, value in (("grant_id", state["grant_id"]), ("task_id", task["id"]),
                       ("branch", task["branch"]), ("head_sha", task["head_sha"]),
                       ("pr_number", task["pr"]["number"])):
        if evidence.get(key) != value or type(evidence.get(key)) is not type(value):
            raise ValueError("preflight identity mismatch: " + key)
    _integer(evidence["pr_number"], "PR number", 1)
    if evidence.get("repository", REPOSITORY) != REPOSITORY:
        raise ValueError("foreign preflight repository")
    for key in ("base_sha", "tested_merge_sha", "tested_tree_sha", "expected_state_blob_sha"):
        _hex(evidence.get(key), 40, key)
    for key in ("policy_sha256", "preflight_sha256"):
        _hex(evidence.get(key), 64, key)
    # task.base_sha is its ORIGINAL base, never rebound to the current main.
    return {"repository": REPOSITORY, "number": task["pr"]["number"],
            "node_id": _text(evidence.get("pr_node_id"), "primary PR node ID"),
            "branch": task["branch"], "head_sha": task["head_sha"],
            "base_sha": evidence["base_sha"], "tested_merge_sha": evidence["tested_merge_sha"],
            "tested_tree_sha": evidence["tested_tree_sha"]}


def _request(kind, expected, operation_id):
    if expected.get("repository") != REPOSITORY:
        raise ValueError("foreign request repository")
    _integer(expected.get("number"), "PR number", 1)
    _hex(expected.get("head_sha"), 40, "head_sha")
    _text(expected.get("node_id"), "primary PR node ID")
    _text(operation_id, "operation_id")
    if kind == "ready_for_review":
        # The existing plugin exposes only repository/number. Neither this call
        # nor optional GraphQL clientMutationId provides expected-head or replay
        # protection; those remain bound to the CAS intent and pre/post GETs.
        return {"tool": "mark_pull_request_ready_for_review",
                "arguments": {"repository_full_name": expected["repository"],
                              "pr_number": expected["number"]}}
    if kind == "squash_merge":
        return {"method": "PUT", "path": "/repos/" + expected["repository"]
                + "/pulls/" + str(expected["number"]) + "/merge",
                "body": {"sha": expected["head_sha"], "merge_method": "squash"}}
    raise ValueError("unsupported state operation")


def prepare_operation(state, kind, evidence, *, operation_id, lease_id, now):
    """Reserve one consumed intent BEFORE sending; preserve all task counters.

    evidence binds grant_id/task_id/branch/pr_number/head_sha, current base_sha,
    tested_merge_sha/tested_tree_sha, policy_sha256/preflight_sha256 and the
    freshly read expected_state_blob_sha. Ready records the existing plugin call;
    exact pre/post GETs bind its refs. Merge still uses the protected exact-head PUT.
    """
    stamp = _time(now)
    _state(state, 2)
    task = _task(state)
    _text(operation_id, "operation_id")
    _text(lease_id, "lease_id")
    lease = _object(state["lease"], "lease")
    if lease.get("id") != lease_id or lease.get("task_id") != task["id"]:
        raise ValueError("operation requires the actual matching task lease")
    if state["pending_operation"] is not None or task.get("phase") in ("ready_pending", "merge_pending", "post_merge"):
        raise ValueError("pending effect or post-merge proof forbids a new intent")
    expected = _expected(state, task, evidence)
    request = _request(kind, expected, operation_id)
    for previous in state["operations"]:
        if previous.get("id") == operation_id:
            raise ValueError("operation id was already consumed")
        if (previous.get("task_id") == task["id"] and previous.get("kind") == kind
                and previous.get("head_sha") == task["head_sha"]):
            raise ValueError("this task/kind/head already consumed its one send")
    intent = {"operation_id": operation_id, "kind": kind, "grant_id": state["grant_id"],
              "task_id": task["id"], "lease_id": lease_id, "prepared_at": stamp,
              "expected": expected, "request": request,
              "expected_state_blob_sha": evidence["expected_state_blob_sha"],
              "policy_sha256": evidence["policy_sha256"],
              "preflight_sha256": evidence["preflight_sha256"]}
    operation = {"id": operation_id, "kind": kind, "task_id": task["id"],
                 "head_sha": task["head_sha"], "status": "pending", "intent": intent,
                 "intent_sha256": digest(intent), "request_sha256": digest(request),
                 "send_claim": {"consumed": True, "lease_id": lease_id}}
    result = deepcopy(state)
    result["operations"].append(deepcopy(operation))
    result["pending_operation"] = deepcopy(operation)
    result["active_task"]["phase"] = "ready_pending" if kind == "ready_for_review" else "merge_pending"
    return result


def _operation(state, task, operation):
    _object(operation, "operation")
    intent = _object(operation.get("intent"), "intent")
    expected = _object(intent.get("expected"), "expected refs")
    _text(operation.get("id"), "operation id")
    _text(intent.get("lease_id"), "consumed lease id")
    _text(intent.get("prepared_at"), "intent preparation timestamp")
    claim = _object(operation.get("send_claim"), "consumed send claim")
    if (operation.get("intent_sha256") != digest(intent)
            or operation.get("request_sha256") != digest(intent.get("request"))
            or intent.get("request") != _request(operation.get("kind"), expected, intent.get("operation_id"))
            or claim != {"consumed": True, "lease_id": intent["lease_id"]}
            or claim.get("consumed") is not True
            or operation.get("id") != intent.get("operation_id")
            or operation.get("kind") != intent.get("kind")
            or intent.get("grant_id") != state["grant_id"]
            or operation.get("task_id") != task["id"] or intent.get("task_id") != task["id"]
            or operation.get("head_sha") != task["head_sha"]
            or expected.get("repository") != REPOSITORY
            or expected.get("number") != task["pr"]["number"]
            or expected.get("branch") != task["branch"] or expected.get("head_sha") != task["head_sha"]):
        raise ValueError("consumed operation intent does not match the active task")
    for key in ("head_sha", "base_sha", "tested_merge_sha", "tested_tree_sha"):
        _hex(expected.get(key), 40, key)
    _hex(intent.get("expected_state_blob_sha"), 40, "expected_state_blob_sha")
    for key in ("policy_sha256", "preflight_sha256"):
        _hex(intent.get(key), 64, key)
    matches = [row for row in state["operations"] if row.get("id") == operation.get("id")]
    if len(matches) != 1 or matches[0] != operation:
        raise ValueError("pending/receipt operation disagrees with durable history")
    return intent, expected


def _pr_matches(pr, expected):
    complete = True
    for key in ("repository", "number", "node_id", "branch", "head_sha", "base_sha"):
        if key not in pr:
            complete = False
        elif pr[key] != expected[key] or type(pr[key]) is not type(expected[key]):
            raise ValueError("observed PR identity mismatch: " + key)
    return complete


def _evidence_uri(evidence):
    if evidence.get("evidence_uri"):
        _text(evidence["evidence_uri"], "evidence_uri")
        return
    uris = evidence.get("evidence_uris")
    if not isinstance(uris, list) or not uris:
        raise ValueError("primary-source evidence URI is required")
    for uri in uris:
        _text(uri, "evidence_uri")


def _merge_proof(observation, expected, now):
    pr = _object(observation.get("pr"), "merged PR")
    if not _pr_matches(pr, expected) or pr.get("merged") is not True or pr.get("state") != "closed":
        raise ValueError("merge receipt requires the exact closed, merged PR")
    merge_sha = _hex(pr.get("merge_commit_sha"), 40, "merge_commit_sha")
    _timestamp(pr.get("merged_at"), now)
    commit = _object(observation.get("commit"), "merge commit")
    if (commit.get("sha") != merge_sha or commit.get("parents") != [expected["base_sha"]]
            or commit.get("tree_sha") != expected["tested_tree_sha"]):
        raise ValueError("squash commit does not install the tested tree on the expected base")
    _hex(observation.get("current_main_sha"), 40, "current_main_sha")
    if (observation.get("main_contains_merge") is not True
            or observation.get("installed_tree_matches") is not True
            or observation.get("installed_files_match") is not True):
        raise ValueError("actual main ancestry/tree/files proof is required")
    _evidence_uri(observation)
    return merge_sha


def reconcile_operation(state, observation, *, now):
    """Reconcile {pr: {...}, commit: {...}, ...} from actual read-only observations.

    Unbound rejection/error/unknown and unchanged Draft/unmerged PRs preserve the
    pending intent. Only rejection={operation_id, request_sha256, http_status,
    evidence_uri} from a primary 405/409/422 response can settle it as rejected.
    That frees review, NOT a resend: the consumed task/kind/head stays unique.
    Contradictory identities/proofs raise without changing any input.
    """
    stamp = _time(now)
    _state(state, 2)
    task = _task(state)
    pending = _object(state["pending_operation"], "pending_operation")
    _, expected = _operation(state, task, pending)
    kind = pending["kind"]
    phase = "ready_pending" if kind == "ready_for_review" else "merge_pending"
    if pending.get("status") != "pending" or task.get("phase") != phase:
        raise ValueError("operation is not a pending single-send intent")
    _object(observation, "observation")
    _json(observation)
    result = deepcopy(state)
    index = next(i for i, row in enumerate(state["operations"]) if row.get("id") == pending["id"])
    pr = observation.get("pr")
    complete_pr = False
    if pr is not None:
        complete_pr = _pr_matches(_object(pr, "observed PR"), expected)
    rejection = observation.get("rejection")
    if rejection is not None:
        _object(rejection, "primary rejection response")
        for key, value in (("operation_id", pending["id"]),
                           ("request_sha256", pending["request_sha256"])):
            if key in rejection and rejection[key] != value:
                raise ValueError("rejection belongs to a different request: " + key)
        if (rejection.get("operation_id") == pending["id"]
                and rejection.get("request_sha256") == pending["request_sha256"]
                and type(rejection.get("http_status")) is int
                and rejection["http_status"] in (405, 409, 422)
                and isinstance(rejection.get("evidence_uri"), str)
                and rejection["evidence_uri"].strip()):
            if pr is not None and pr.get("merged") is True:
                raise ValueError("a merged PR contradicts a known rejection")
            receipt = {"status": "rejected", "operation_id": pending["id"],
                       "intent_sha256": pending["intent_sha256"], "rejected_at": stamp,
                       "observation": deepcopy(observation)}
            result["operations"][index].update(status="rejected", receipt=deepcopy(receipt))
            result["pending_operation"] = None
            result["active_task"]["phase"] = "review_required"
            return result
        return result
    if not complete_pr:
        return result
    if observation.get("error") or observation.get("result") in ("unknown", "error", "rejected"):
        return result
    if kind == "ready_for_review":
        if pr.get("merged") is True or pr.get("state") == "closed":
            raise ValueError("Ready observation is already closed or merged")
        if pr.get("draft") is not False or pr.get("state") != "open" or pr.get("merged") is not False:
            return result
    else:
        if pr.get("merged") is not True:
            return result
        _merge_proof(observation, expected, now)
    receipt = {"status": "confirmed", "operation_id": pending["id"],
               "intent_sha256": pending["intent_sha256"], "confirmed_at": stamp,
               "grant_id": state["grant_id"], "task_id": task["id"],
               **deepcopy(expected), "observation": deepcopy(observation)}
    if kind == "squash_merge":
        receipt["merge_commit_sha"] = pr["merge_commit_sha"]
        receipt["merged_at"] = pr["merged_at"]
    result["operations"][index].update(status="confirmed", receipt=deepcopy(receipt))
    result["pending_operation"] = None
    result["active_task"]["phase"] = "ready" if kind == "ready_for_review" else "post_merge"
    if kind == "squash_merge":
        result["active_task"]["merge_receipt"] = deepcopy(receipt)
    return result


def complete_task(state, post_merge, *, now):
    """Retire only after all three exact push-main workflows succeed.

    completed_tasks entries retain {task: FULL task, evidence: FULL post_merge,
    completed_at}. A repeated completion is invalid, not a second append. Clearing
    active_task/lease is the only transition here that permits selecting next work.
    """
    stamp = _time(now)
    _state(state, 2)
    task = _task(state)
    if state["pending_operation"] is not None or task.get("phase") != "post_merge":
        raise ValueError("completion requires a confirmed merge and no pending operation")
    receipt = _object(task.get("merge_receipt"), "merge_receipt")
    matches = [row for row in state["operations"] if row.get("id") == receipt.get("operation_id")]
    if len(matches) != 1:
        raise ValueError("missing unique merge operation")
    operation = matches[0]
    _, expected = _operation(state, task, operation)
    if (operation.get("kind") != "squash_merge" or operation.get("status") != "confirmed"
            or operation.get("receipt") != receipt or receipt.get("status") != "confirmed"
            or receipt.get("intent_sha256") != operation["intent_sha256"]
            or any(receipt.get(key) != value for key, value in expected.items())
            or receipt.get("grant_id") != state["grant_id"] or receipt.get("task_id") != task["id"]):
        raise ValueError("task merge receipt does not match confirmed operation history")
    merge_sha = _hex(receipt.get("merge_commit_sha"), 40, "merge_commit_sha")
    observation = _object(receipt.get("observation"), "confirmed merge observation")
    if (_merge_proof(observation, expected, now) != merge_sha
            or receipt.get("merged_at") != observation["pr"]["merged_at"]):
        raise ValueError("merge receipt differs from its original observations")
    _object(post_merge, "post_merge")
    _json(post_merge)
    for key, value in (("grant_id", state["grant_id"]), ("task_id", task["id"]),
                       ("merge_commit_sha", merge_sha)):
        if post_merge.get(key) != value:
            raise ValueError("post-merge identity mismatch: " + key)
    lease = _object(state["lease"], "completion lease")
    if (lease.get("task_id") != task["id"] or not lease.get("id")
            or post_merge.get("lease_id") != lease["id"]):
        raise ValueError("completion cannot release another invocation's lease")
    _hex(post_merge.get("actual_main_sha"), 40, "actual_main_sha")
    if post_merge.get("main_contains_merge") is not True or post_merge.get("installed_files_match") is not True:
        raise ValueError("post-main ancestry and installed-file proof is required")
    _text(post_merge.get("evidence_uri"), "evidence_uri")
    ci = _object(post_merge.get("post_ci"), "post_ci")
    if ci.get("head_sha") != merge_sha or ci.get("status") != "completed" or ci.get("conclusion") != "success":
        raise ValueError("post-merge CI must have completed successfully on the exact squash commit")
    runs = ci.get("runs")
    if not isinstance(runs, list) or len(runs) != len(WORKFLOWS):
        raise ValueError("all three standard post-main workflows are mandatory")
    ids, paths = set(), set()
    for run in runs:
        _object(run, "post-main workflow run")
        run_id = _integer(run.get("id"), "run id", 1)
        _integer(run.get("attempt"), "run attempt", 1)
        path = _text(run.get("path"), "workflow path")
        if (run_id in ids or path in paths or path not in WORKFLOWS
                or run.get("head_sha") != merge_sha or run.get("event") != "push"
                or run.get("conclusion") != "success"
                or run.get("status", "completed") != "completed"):
            raise ValueError("post-main workflow identity/attempt/result mismatch")
        ids.add(run_id)
        paths.add(path)
    completed = state.get("completed_tasks", [])
    for row in completed:
        row = _object(row, "completed task")
        if _object(row.get("task"), "completed task snapshot").get("id") == task["id"]:
            raise ValueError("task already completed")
    result = deepcopy(state)
    result.setdefault("completed_tasks", []).append(
        {"task": deepcopy(task), "evidence": deepcopy(post_merge), "completed_at": stamp})
    result["retired_task_ids"].append(task["id"])
    result["active_task"] = None
    result["lease"] = None
    return result


def _migrate_state(state, new_grant, acceptance, *, expected_blob_sha, now, source_schema, policy_version):
    """Prepare owner-only exact-snapshot migration; never perform the CAS.

    acceptance requires decision=accept, decision_ref, supersedes_grant_id,
    expected_state_blob_sha, state_sha256 (canonical digest of the FULL original
    state), adopted_task_id, adopted_pr (number), adopted_head_sha. The caller
    verifies the separate owner's provenance; an author-supplied boolean is not
    authentication. CAS MUST use expected_blob_sha, never a remembered constant.
    """
    stamp = _time(now)
    _state(state, source_schema)
    task = _task(state)
    if state["lease"] is not None or state["pending_operation"] is not None:
        raise ValueError("migration requires quiet state; no lease stealing or pending effect")
    if task.get("phase") in ("ready_pending", "merge_pending", "post_merge"):
        raise ValueError("migration cannot discard an unfinished integration")
    _hex(expected_blob_sha, 40, "expected_blob_sha")
    _object(new_grant, "new_grant")
    _object(acceptance, "acceptance")
    _json(new_grant)
    _json(acceptance)
    if (type(new_grant.get("schema")) is not int or new_grant["schema"] != 2
            or type(new_grant.get("version")) is not int or new_grant["version"] != policy_version
            or new_grant.get("kind") != "dot-r2-j-grant"
            or new_grant.get("repository") != REPOSITORY
            or not isinstance(new_grant.get("id"), str)
            or not re.fullmatch(r"r2-j-v2-[0-9a-f]{32}", new_grant["id"])
            or new_grant.get("id") == state["grant_id"]
            or new_grant.get("supersedes_grant_id") != state["grant_id"]
            or new_grant.get("policy_path") != "docs/dot/r2-j-policy-v%d.json" % policy_version
            or new_grant.get("acceptance") != acceptance):
        raise ValueError("migration requires a distinct v2 grant explicitly superseding the old grant")
    _hex(new_grant.get("policy_sha256"), 64, "policy_sha256")
    if acceptance.get("decision") != "accept":
        raise ValueError("separate owner migration acceptance is required")
    _text(acceptance.get("decision_ref"), "owner decision_ref")
    for key, value in (("supersedes_grant_id", state["grant_id"]),
                       ("expected_state_blob_sha", expected_blob_sha), ("state_sha256", digest(state)),
                       ("adopted_task_id", task["id"]), ("adopted_pr", task["pr"]["number"]),
                       ("adopted_head_sha", task["head_sha"])):
        if acceptance.get(key) != value or type(acceptance.get(key)) is not type(value):
            raise ValueError("owner snapshot acceptance mismatch: " + key)
    result = deepcopy(state)
    result["schema"] = 2
    result["grant_id"] = new_grant["id"]
    result["active_task"]["phase"] = "review_required"
    result.setdefault("migrations", []).append(
        {"from_schema": source_schema, "to_schema": 2, "old_grant_id": state["grant_id"],
         "new_grant_id": new_grant["id"], "expected_state_blob_sha": expected_blob_sha,
         "state_sha256": digest(state), "grant_sha256": digest(new_grant),
         "acceptance": deepcopy(acceptance), "prepared_at": stamp})
    return result


def migrate_state(state, new_grant, acceptance, *, expected_blob_sha, now):
    """Owner-only schema-1 to schema-2 migration; no network effects."""
    return _migrate_state(state, new_grant, acceptance, expected_blob_sha=expected_blob_sha,
                          now=now, source_schema=1, policy_version=2)


def regrant_state(state, new_grant, acceptance, *, expected_blob_sha, now):
    """Owner-only schema-2 regrant for policy v3; preserve all task history.

    Caller verifies accepted policy/grant provenance and explicit old-grant
    revocation, freezes only the Dot writer, then uses the current content.sha
    CAS. This pure preparation is not authority, a CAS, or a lease acquisition.
    Prior review evidence remains historical; a new full preflight is required.
    """
    return _migrate_state(state, new_grant, acceptance, expected_blob_sha=expected_blob_sha,
                          now=now, source_schema=2, policy_version=3)
