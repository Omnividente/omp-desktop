#!/usr/bin/env python3
"""R2-J v2 integration evidence checks, with no network or execution effects.

The caller obtains primary GitHub/provider observations through existing tools.
This module validates bindings, not the authenticity of caller-supplied JSON.
An author-authored PR paragraph is never a provider execution receipt.
"""
from __future__ import annotations

import re
from datetime import datetime

from dot_authority import SHA, changes_check, digest, integer, instant

HASH = re.compile(r"[0-9a-f]{64}\Z")
SAFETY_SCENARIOS = {"fail_closed", "no_replayed_effects", "identity_preservation", "scope_non_escalation"}


def _sha(value, label):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError("invalid " + label)
    return value


def _hash(value, label):
    if not isinstance(value, str) or not HASH.fullmatch(value):
        raise ValueError("invalid " + label)
    return value


def _text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing " + label)
    return value


def review_manifest(policy: dict, packet: dict) -> dict:
    """Canonical exact-content input for *both* independent executions."""
    files = packet["pr_files"]
    if packet.get("files_complete") is not True or not files:
        raise ValueError("complete actual PR file inventory is required")
    paths, lines, _ = changes_check(policy, files)
    task, pr = packet["task"], packet["pr"]
    if (pr.get("changed_files") != len(files) or not paths <= set(task["touched_paths"])
            or lines > integer(task["spent_lines"], "spent_lines")):
        raise ValueError("actual PR diff exceeds reserved paths/work or file inventory")
    risk = packet["risk"]
    if risk.get("level") not in ("ordinary", "critical"):
        raise ValueError("unknown source risk cannot be downgraded")
    _text(risk.get("rationale"), "source risk analysis")
    critical = risk["level"] == "critical"
    manifest_files = []
    for file in files:
        name = file["filename"]
        is_test = name.endswith("_test.py")
        critical |= (not is_test or file["deletions"] > 0 or file.get("status") != "added"
                     or any(term in name for term in policy["critical_source_terms"]))
        if file.get("status") not in ("added", "modified", "removed", "renamed", "copied"):
            raise ValueError("unknown PR file status")
        manifest_files.append({"path": name, "previous_path": file.get("previous_filename", name),
                               "status": file["status"], "mode": file["mode"],
                               "blob_sha": _sha(file.get("sha"), "PR blob SHA"),
                               "sha256": _hash(file.get("sha256"), "PR content SHA-256")})
    return {"schema": 2, "repository": policy["repository"], "policy_sha256": digest(policy),
            "grant_id": packet["grant"]["id"], "task_id": task["id"], "pr_number": pr["number"],
            "pr_node_id": _text(pr.get("node_id"), "primary PR node ID"),
            "base_sha": _sha(packet["main_sha"], "actual main SHA"),
            "head_sha": _sha(task["head_sha"], "task head SHA"),
            "tested_merge_sha": _sha(packet["ci"]["tested_merge_sha"], "tested merge SHA"),
            "tested_tree_sha": _sha(packet["ci"]["tested_tree_sha"], "tested tree SHA"),
            "critical": critical, "risk": risk,
            "files": sorted(manifest_files, key=lambda row: row["path"])}


def _ci_check(policy: dict, ci: dict, *, head: str, base: str, branch: str, pr_number: int) -> dict:
    if ci.get("complete") is not True or ci.get("head_sha") != head or ci.get("base_sha") != base:
        raise ValueError("complete exact-head/base CI observations are required")
    tested = _sha(ci["tested_merge_sha"], "CI tested merge SHA")
    tree = _sha(ci["tested_tree_sha"], "CI tested tree SHA")
    commit = ci["merge_commit"]
    if (commit.get("sha") != tested or commit.get("tree", {}).get("sha") != tree
            or [row["sha"] for row in commit["parents"]] != [base, head]):
        raise ValueError("tested merge must have the exact current base/head and tree")
    workflows = policy["integration"]["workflows"]
    ids, latest = set(), {}
    for run in ci["runs"]:
        run_id = integer(run["id"], "run id")
        if run_id == 0 or run_id in ids:
            raise ValueError("duplicate or invalid CI run identity")
        ids.add(run_id)
        path = run.get("path")
        if path not in workflows:
            continue
        if (run.get("event") != "pull_request" or run.get("head_sha") != head
                or run.get("head_branch") != branch
                or run.get("repository", {}).get("full_name") != policy["repository"]
                or run.get("head_repository", {}).get("full_name") != policy["repository"]
                or pr_number not in [row["number"] for row in run["pull_requests"]]):
            raise ValueError("CI run source/PR/repository mismatch")
        if path not in latest or latest[path]["id"] < run_id:
            latest[path] = run
    if set(latest) != set(workflows):
        raise ValueError("missing required source CI workflow")
    checks = {row["id"]: row for row in ci["check_runs"]}
    if len(checks) != len(ci["check_runs"]):
        raise ValueError("duplicate CI check observations")
    job_ids, proven, result = set(), {}, []
    for path, run in latest.items():
        attempt = integer(run["run_attempt"], "run attempt")
        if not attempt or run.get("status") != "completed" or run.get("conclusion") != "success":
            raise ValueError("latest workflow/attempt is not successfully completed")
        jobs = [row for row in ci["jobs"] if row["run_id"] == run["id"]
                and row.get("run_attempt") == attempt]
        names = set()
        for job in jobs:
            job_id = integer(job["id"], "job id")
            if not job_id or job_id in job_ids:
                raise ValueError("duplicate or invalid CI job")
            job_ids.add(job_id)
            if (job.get("run_attempt") != attempt or job.get("head_sha") != head
                    or job.get("status") != "completed" or job.get("conclusion") != "success"):
                raise ValueError("current workflow job/attempt is not successful")
            check_url = job.get("check_run_url", "")
            prefix = "https://api.github.com/repos/" + policy["repository"] + "/check-runs/"
            if not check_url.startswith(prefix) or not check_url[len(prefix):].isdigit():
                raise ValueError("job lacks a primary GitHub check identity")
            check = checks.get(int(check_url[len(prefix):]), {})
            if (check.get("name") != job["name"] or check.get("head_sha") != head
                    or check.get("status") != "completed" or check.get("conclusion") != "success"
                    or check.get("app", {}).get("slug") != "github-actions"
                    or check.get("check_suite", {}).get("id") != run["check_suite_id"]):
                raise ValueError("job/check/app/suite binding mismatch")
            checkout = [row for row in ci["checkouts"]
                        if row["run_id"] == run["id"] and row["job_id"] == job_id]
            if (len(checkout) != 1 or checkout[0].get("run_attempt") != attempt
                    or checkout[0].get("sha") != tested or checkout[0].get("tree_sha") != tree
                    or checkout[0].get("parents") != [base, head]
                    or checkout[0].get("origin") != "github-job-log"):
                raise ValueError("exact tested checkout evidence is missing or stale")
            _text(checkout[0].get("evidence_uri"), "primary checkout log URI")
            names.add(job["name"])
            proven[job["name"]] = check
        if not set(workflows[path]) <= names:
            raise ValueError("required CI matrix/job is missing")
        result.append({"id": run["id"], "attempt": attempt, "path": path,
                       "head_sha": head, "tested_merge_sha": tested, "conclusion": "success"})
    return {"runs": result, "checks": proven, "tested_merge_sha": tested, "tested_tree_sha": tree}


def _protections_check(policy: dict, packet: dict, checks: dict) -> None:
    if packet.get("rules_complete") is not True or packet.get("threads_complete") is not True:
        raise ValueError("complete current protections and review threads are required")
    rules = packet["branch_rules"]
    status = [row["parameters"] for row in rules if row["type"] == "required_status_checks"]
    review = [row["parameters"] for row in rules if row["type"] == "pull_request"]
    if (len(status) != 1 or status[0].get("strict_required_status_checks_policy") is not True
            or len(review) != 1 or review[0].get("required_review_thread_resolution") is not True
            or "squash" not in review[0].get("allowed_merge_methods", [])
            or not {"non_fast_forward", "deletion"} <= {row["type"] for row in rules}):
        raise ValueError("current protected strict squash-merge policy cannot be confirmed")
    if packet["repository"].get("allow_squash_merge") is not True:
        raise ValueError("repository does not permit squash merge")
    if (packet.get("unresolved_threads") != [] or packet.get("changes_requested") is not False
            or packet.get("review_decision") in ("CHANGES_REQUESTED", "REVIEW_REQUIRED")):
        raise ValueError("unresolved review/blocking branch protection")
    if review[0].get("required_approving_review_count", 0) > 0 and packet.get("review_decision") != "APPROVED":
        raise ValueError("GitHub-required approvals are unsatisfied; never self-approve or bypass")
    required = status[0].get("required_status_checks")
    if not required:
        raise ValueError("current required check contexts are missing")
    for rule in required:
        check = checks.get(rule["context"])
        if check is None or (rule.get("integration_id") is not None
                             and check["app"]["id"] != rule["integration_id"]):
            raise ValueError("current mandatory check is not authenticated and successful")


def _review_check(policy: dict, packet: dict, manifest: dict, now: datetime) -> tuple[bool, list]:
    evidence = packet["independent_review"]
    if evidence.get("complete") is not True:
        raise ValueError("independent provider execution evidence is incomplete")
    author = evidence["author"]
    for key in ("provider", "execution_id", "context_id"):
        _text(author.get(key), "author " + key)
    input_hash = digest(manifest)
    roles, executions, contexts, receipt_ids = {}, set(), set(), set()
    paths = {name for row in manifest["files"] for name in (row["path"], row["previous_path"])}
    critical = manifest["critical"]
    for report in evidence["reports"]:
        matches = [row for row in evidence["receipts"] if row.get("execution_id") == report.get("execution_id")]
        if len(matches) != 1:
            raise ValueError("report has no unique primary provider receipt")
        receipt = matches[0]
        role = report.get("role")
        execution = (receipt.get("provider"), receipt.get("execution_id"))
        context = (receipt.get("provider"), receipt.get("context_id"))
        if (receipt.get("origin") != policy["review"]["origin"]
                or receipt.get("permissions") != policy["review"]["permissions"]
                or receipt.get("status") != "completed" or receipt.get("role") != role
                or role not in policy["review"]["critical_executions"] or role in roles
                or execution in executions or context in contexts
                or execution == (author["provider"], author["execution_id"])
                or context == (author["provider"], author["context_id"])):
            raise ValueError("review must be a distinct read-only provider execution/context, never its author")
        for key in ("id", "provider", "execution_id", "context_id", "model", "evidence_uri"):
            _text(receipt.get(key), "provider receipt " + key)
        if receipt["id"] in receipt_ids or instant(receipt["completed_at"]) > now:
            raise ValueError("duplicate/future provider receipt")
        if (receipt.get("input_sha256") != input_hash or report.get("input_sha256") != input_hash
                or receipt.get("result_sha256") != digest(report)
                or report.get("verdict") != "approve" or report.get("sufficient") is not True
                or report.get("findings") != [] or report.get("risk") not in ("ordinary", "critical")
                or set(report.get("covered_paths", [])) != paths):
            raise ValueError("review is stale, insufficient, incomplete or has unresolved findings")
        _text(report.get("rationale"), "independent sufficiency analysis")
        critical |= report["risk"] == "critical"
        roles[role] = {"report": report, "receipt": receipt}
        executions.add(execution); contexts.add(context); receipt_ids.add(receipt["id"])
    expected = policy["review"]["critical_executions" if critical else "ordinary_executions"]
    if not set(expected) <= set(roles):
        raise ValueError("critical change lacks an independent automatic safety execution")
    _tests_check(packet["test_evidence"], roles, manifest, critical)
    return critical, [{"role": role, "execution_id": row["receipt"]["execution_id"],
                       "receipt_id": row["receipt"]["id"], "input_sha256": input_hash,
                       "result_sha256": row["receipt"]["result_sha256"],
                       "evidence_uri": row["receipt"]["evidence_uri"]} for role, row in roles.items()]


def _tests_check(tests: dict, roles: dict, manifest: dict, critical: bool) -> None:
    if (tests.get("complete") is not True or tests.get("input_sha256") != digest(manifest)
            or tests.get("environment") not in ("secret-free-pr-ci", "isolated-synthetic-no-credentials")):
        raise ValueError("actual isolated regression execution is required")
    reproduction = tests["reproduction"]
    if (reproduction.get("before_sha") != manifest["base_sha"]
            or reproduction.get("after_sha") != manifest["head_sha"]
            or reproduction.get("before") != "failed-assertion" or reproduction.get("after") != "passed"
            or not reproduction.get("test_ids") or not isinstance(reproduction["test_ids"], list)
            or len(set(reproduction["test_ids"])) != len(reproduction["test_ids"])):
        raise ValueError("exact failing-before/passing-after regression is not confirmed")
    for test_id in reproduction["test_ids"]:
        _text(test_id, "executed regression test identity")
    _hash(reproduction.get("test_manifest_sha256"), "executed regression manifest")
    for key in ("before_uri", "after_uri"):
        _text(reproduction.get(key), "regression execution " + key)
    if not set(reproduction["test_ids"]) <= set(roles["code-review"]["report"].get("test_ids", [])):
        raise ValueError("independent review did not assess the executed regression")
    if not critical:
        return
    scenarios = tests.get("safety")
    if not isinstance(scenarios, list) or {row["scenario"] for row in scenarios} != SAFETY_SCENARIOS or len(scenarios) != len(SAFETY_SCENARIOS):
        raise ValueError("critical safety boundary coverage is incomplete")
    safety = roles["safety-review"]
    passed = False
    for row in scenarios:
        if (row.get("executor_id") != safety["receipt"]["execution_id"]
                or row.get("head_sha") != manifest["head_sha"] or row.get("input_sha256") != digest(manifest)
                or row.get("outcome") not in ("passed", "not-applicable")):
            raise ValueError("safety tests were not executed/assessed independently on the candidate")
        _text(row.get("test_id"), "safety case identity")
        _text(row.get("evidence_uri"), "actual safety execution evidence")
        if row["outcome"] == "not-applicable":
            _text(row.get("rationale"), "independent safety applicability rationale")
        passed |= row["outcome"] == "passed"
    if (not passed or not {row["test_id"] for row in scenarios}
            <= set(safety["report"].get("test_ids", []))):
        raise ValueError("critical safety review has no executed relevant cases")


def integration_check(policy: dict, packet: dict, now: datetime) -> dict:
    """Verify one Ready or protected squash intent; never send it or replay it."""
    if policy["schema"] != 2 or policy["integration"].get("method") != "squash":
        raise ValueError("v1 owner grants never authorize autonomous integration")
    pr, task, state = packet["pr"], packet["task"], packet["state"]
    repository = policy["repository"]
    number = integer(pr["number"], "PR number")
    if pr.get("requested_reviewers") != [] or pr.get("requested_teams") != []:
        raise ValueError("pending GitHub review requests block autonomous integration")
    head, base = task["head_sha"], _sha(packet["main_sha"], "current main")
    if (not number or pr.get("html_url") != "https://github.com/" + repository + "/pull/" + str(number)
            or pr.get("state") != "open" or pr.get("merged") is not False or pr.get("auto_merge") is not None
            or pr.get("head", {}).get("sha") != head or pr["head"].get("ref") != task["branch"]
            or pr["head"].get("repo", {}).get("full_name") != repository
            or pr.get("base", {}).get("sha") != base or pr["base"].get("ref") != "main"
            or pr["base"].get("repo", {}).get("full_name") != repository
            or packet["repository"].get("full_name") != repository
            or pr.get("mergeable") is not True or pr.get("mergeable_state") != "clean"):
        raise ValueError("PR/repository/current base/head/protected mergeability changed")
    expected_draft = packet["action"] == "ready_for_review"
    if pr.get("draft") is not expected_draft:
        raise ValueError("Ready must observe Draft; merge must observe already Ready")
    if (state.get("schema") != 2 or state.get("grant_id") != packet["grant"]["id"]
            or state.get("active_task") != task or state.get("pending_operation") is not None
            or state.get("lease", {}).get("id") != packet.get("lease_id")
            or state["lease"].get("task_id") != task["id"]
            or not packet.get("lease_id") or task.get("pr", {}).get("number") != number):
        raise ValueError("exact CAS-owned Dot task/lease and no unfinished operation are required")
    blob = _sha(packet["state_blob_sha"], "current Dot state blob SHA")
    manifest = review_manifest(policy, packet)
    ci = _ci_check(policy, packet["ci"], head=head, base=base, branch=task["branch"], pr_number=number)
    if pr.get("merge_commit_sha") != ci["tested_merge_sha"]:
        raise ValueError("current merge preview is not the tested revision")
    _protections_check(policy, packet, ci["checks"])
    critical, reviews = _review_check(policy, packet, manifest, now)
    evidence = {"grant_id": packet["grant"]["id"], "task_id": task["id"], "branch": task["branch"],
                "pr_number": number, "head_sha": head, "base_sha": base,
                "pr_node_id": _text(pr.get("node_id"), "primary PR node ID"),
                "tested_merge_sha": ci["tested_merge_sha"], "tested_tree_sha": ci["tested_tree_sha"],
                "policy_sha256": digest(policy), "expected_state_blob_sha": blob,
                "input_manifest_sha256": digest(manifest), "critical": critical,
                "reviews": reviews, "ci_runs": ci["runs"], "action": packet["action"]}
    evidence["preflight_sha256"] = digest(evidence)
    return evidence
