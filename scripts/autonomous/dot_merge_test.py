#!/usr/bin/env python3
"""Consumer-visible integration gates: exact revision, genuine review roles and CI."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dot_authority import digest, evaluate, prepare_grant
from dot_authority_test import BASE, HEAD, NOW, ROOT, acceptance, change, packet
from dot_merge import SAFETY_SCENARIOS, review_manifest

POLICY = json.loads((ROOT / "docs/dot/r2-j-policy-v2.json").read_text(encoding="utf-8"))
TESTED, TREE = "d" * 40, "e" * 40


def reviews(data, *, safety=True):
    manifest = review_manifest(POLICY, data)
    fingerprint = digest(manifest)
    roles = ("code-review", "safety-review") if safety else ("code-review",)
    reports, receipts = [], []
    cases = ["Regression.test_bug"] + ["Safety.test_" + name for name in sorted(SAFETY_SCENARIOS)]
    for role in roles:
        execution = role + "-execution"
        report = {"execution_id": execution, "role": role, "input_sha256": fingerprint,
                  "verdict": "approve", "sufficient": True, "findings": [],
                  "risk": "critical" if manifest["critical"] else "ordinary",
                  "covered_paths": [row["path"] for row in manifest["files"]],
                  "rationale": "Synthetic independent call-chain and invariant assessment", "test_ids": cases}
        reports.append(report)
        receipts.append({"id": role + "-receipt", "provider": "synthetic-provider", "role": role,
                         "execution_id": execution, "context_id": role + "-context", "model": "fixture",
                         "origin": "provider-tool-result", "permissions": "read-only", "status": "completed",
                         "input_sha256": fingerprint, "result_sha256": digest(report),
                         "evidence_uri": "urn:synthetic:" + role, "completed_at": NOW.isoformat()})
    data["independent_review"] = {"complete": True, "author": {"provider": "synthetic-provider",
                                  "execution_id": "author-execution", "context_id": "author-context"},
                                  "reports": reports, "receipts": receipts}
    data["test_evidence"] = {"complete": True, "input_sha256": fingerprint,
                             "environment": "isolated-synthetic-no-credentials",
                             "reproduction": {"before_sha": BASE, "after_sha": HEAD, "before": "failed-assertion",
                                              "after": "passed", "test_ids": [cases[0]],
                                              "test_manifest_sha256": "f" * 64,
                                              "before_uri": "urn:synthetic:before", "after_uri": "urn:synthetic:after"},
                             "safety": [{"scenario": name, "test_id": "Safety.test_" + name, "outcome": "passed",
                                         "executor_id": "safety-review-execution", "head_sha": HEAD,
                                         "input_sha256": fingerprint, "evidence_uri": "urn:synthetic:safety:" + name}
                                        for name in sorted(SAFETY_SCENARIOS)]}


def integration_packet(*, critical=True, action="ready_for_review"):
    data = packet()
    previous = data["grant"]["id"]
    accepted = acceptance(); accepted["supersedes_grant_id"] = previous
    grant = prepare_grant(POLICY, accepted, NOW - timedelta(hours=1))
    data.update(action=action, grant=grant, index={"schema": 2, "policy_version": 2, "status": "active",
                "repository": POLICY["repository"], "grant": {"id": grant["id"], "sha256": digest(grant),
                "comment_id": 22}, "revoked_grants": [previous]}, main_sha=BASE, changes=[],
                repository={"full_name": POLICY["repository"], "allow_squash_merge": True},
                files_complete=True, state_blob_sha="7" * 40, lease_id="fixture-lease",
                risk={"level": "critical" if critical else "ordinary", "rationale": "Synthetic source impact"},
                rules_complete=True, threads_complete=True, unresolved_threads=[], changes_requested=False,
                review_decision="", branch_rules=[{"type": "deletion"}, {"type": "non_fast_forward"},
                {"type": "required_status_checks", "parameters": {"strict_required_status_checks_policy": True,
                 "required_status_checks": [{"context": "Checks (ubuntu-latest)"}, {"context": "Checks (windows-latest)"}]}},
                {"type": "pull_request", "parameters": {"required_review_thread_resolution": True,
                 "required_approving_review_count": 0, "allowed_merge_methods": ["squash"]}}])
    file = change("scripts/autonomous/loop_health.py" if critical else "scripts/autonomous/observations_test.py",
                  deletions=10 if critical else 0, status="modified" if critical else "added", sha="8" * 40, sha256="9" * 64)
    data["pr_files"] = [file]
    task = data["task"]
    task.update(initial_published=True, touched_paths=[file["filename"]], spent_lines=file["additions"] + file["deletions"],
                pr={"number": 148}, phase="review_required")
    draft = action == "ready_for_review"
    data["pr"] = {"number": 148, "html_url": "https://github.com/" + POLICY["repository"] + "/pull/148",
                  "node_id": "PR_synthetic_148",
                  "requested_reviewers": [], "requested_teams": [],
                  "state": "open", "merged": False, "auto_merge": None, "draft": draft, "changed_files": 1,
                  "head": {"sha": HEAD, "ref": task["branch"], "repo": {"full_name": POLICY["repository"]}},
                  "base": {"sha": BASE, "ref": "main", "repo": {"full_name": POLICY["repository"]}},
                  "mergeable": True, "mergeable_state": "clean", "merge_commit_sha": TESTED}
    data["state"] = {"schema": 2, "grant_id": grant["id"], "active_task": copy.deepcopy(task),
                     "lease": {"id": data["lease_id"], "task_id": task["id"]}, "pending_operation": None}
    data["state"]["retired_task_ids"] = list(data["retired_task_ids"])
    data["active_task_id"] = task["id"]
    data["open_prs"] = [{"branch": task["branch"], "draft": draft, "base": "main",
                         "repository": POLICY["repository"], "head_sha": HEAD}]
    ci = {"complete": True, "head_sha": HEAD, "base_sha": BASE, "tested_merge_sha": TESTED, "tested_tree_sha": TREE,
          "merge_commit": {"sha": TESTED, "parents": [{"sha": BASE}, {"sha": HEAD}], "tree": {"sha": TREE}},
          "runs": [], "jobs": [], "check_runs": [], "checkouts": []}
    job_id = 400
    for run_id, (path, names) in enumerate(POLICY["integration"]["workflows"].items(), 200):
        ci["runs"].append({"id": run_id, "path": path, "event": "pull_request", "head_sha": HEAD,
                           "head_branch": task["branch"],
                           "repository": {"full_name": POLICY["repository"]}, "head_repository": {"full_name": POLICY["repository"]},
                           "pull_requests": [{"number": 148}], "run_attempt": 1, "status": "completed",
                           "conclusion": "success", "check_suite_id": run_id + 1000})
        for name in names:
            job_id += 1
            ci["jobs"].append({"id": job_id, "run_id": run_id, "run_attempt": 1, "head_sha": HEAD,
                               "status": "completed", "conclusion": "success", "name": name,
                               "check_run_url": "https://api.github.com/repos/" + POLICY["repository"] + "/check-runs/" + str(job_id)})
            ci["check_runs"].append({"id": job_id, "name": name, "head_sha": HEAD, "status": "completed", "conclusion": "success",
                                     "app": {"slug": "github-actions", "id": 15368}, "check_suite": {"id": run_id + 1000}})
            ci["checkouts"].append({"run_id": run_id, "job_id": job_id, "run_attempt": 1, "sha": TESTED,
                                    "tree_sha": TREE, "parents": [BASE, HEAD], "origin": "github-job-log",
                                    "evidence_uri": "urn:synthetic:checkout:" + str(job_id)})
    data["ci"] = ci
    reviews(data, safety=critical)
    return data


class IntegrationGateTest(unittest.TestCase):
    def denied(self, data):
        before = copy.deepcopy(data)
        with self.assertRaises(ValueError):
            evaluate(POLICY, data, NOW)
        self.assertEqual(data, before, "denial must not consume counters or rewrite evidence")

    def rehash_report(self, data, index):
        data["independent_review"]["receipts"][index]["result_sha256"] = digest(data["independent_review"]["reports"][index])

    def test_critical_ready_is_bound_to_two_automatic_executions_and_exact_tree(self):
        data = integration_packet()
        result = evaluate(POLICY, data, NOW)["integration"]
        self.assertEqual((result["head_sha"], result["base_sha"], result["tested_tree_sha"]), (HEAD, BASE, TREE))
        self.assertEqual({row["role"] for row in result["reviews"]}, {"code-review", "safety-review"})
        self.assertTrue(result["critical"])

    def test_ordinary_ready_can_merge_without_new_owner_decision(self):
        data = integration_packet(critical=False, action="squash_merge")
        result = evaluate(POLICY, data, NOW)
        self.assertEqual(result["mode"], "r2-j-v2")
        self.assertFalse(result["integration"]["critical"])
        self.assertEqual(result["grant_id"], data["grant"]["id"])

    def test_v1_grant_is_never_reinterpreted_as_v2(self):
        data = integration_packet(); data["grant"] = packet()["grant"]
        data["index"]["grant"] = {"id": data["grant"]["id"], "sha256": digest(data["grant"]), "comment_id": 22}
        self.denied(data)
        legacy = json.loads((ROOT / "docs/dot/r2-j-policy.json").read_text(encoding="utf-8"))
        for action in ("ready_for_review", "squash_merge"):
            old = packet(); old["action"] = action
            with self.assertRaises(ValueError): evaluate(legacy, old, NOW)

    def test_new_grant_must_explicitly_retire_legacy_authority(self):
        for field, value in (("schema", 1), ("policy_version", 1), ("revoked_grants", [])):
            data = integration_packet(); data["index"][field] = value; self.denied(data)

    def test_each_protected_live_or_governance_action_stays_forbidden(self):
        for action in POLICY["protected_operations"]:
            data = integration_packet(); data["action"] = action; self.denied(data)

    def test_ready_and_merge_have_opposite_draft_preconditions(self):
        for action in ("ready_for_review", "squash_merge"):
            data = integration_packet(action=action); data["pr"]["draft"] = not data["pr"]["draft"]; self.denied(data)

    def test_changed_current_head_base_tree_or_preview_withdraws_acceptance(self):
        for mutate in (lambda p: p["pr"]["head"].update(sha="1" * 40),
                       lambda p: p.update(main_sha="1" * 40),
                       lambda p: p["ci"]["merge_commit"]["tree"].update(sha="1" * 40),
                       lambda p: p["pr"].update(merge_commit_sha="1" * 40),
                       lambda p: p["ci"]["merge_commit"].update(parents=[{"sha": HEAD}, {"sha": BASE}])):
            data = integration_packet(); mutate(data); self.denied(data)

    def test_newer_pending_or_failed_workflow_cannot_fall_back_to_old_green(self):
        for status, conclusion in (("in_progress", None), ("completed", "failure")):
            data = integration_packet(); newer = copy.deepcopy(data["ci"]["runs"][0])
            newer.update(id=1000, status=status, conclusion=conclusion); data["ci"]["runs"].append(newer); self.denied(data)

    def test_rerun_attempt_must_match_actual_jobs_and_checkout(self):
        data = integration_packet(); data["ci"]["runs"][0]["run_attempt"] = 2; self.denied(data)
        data = integration_packet(); data["ci"]["checkouts"][0]["run_attempt"] = 2; self.denied(data)

    def test_successful_latest_attempt_is_not_rejected_for_older_failed_jobs(self):
        data = integration_packet()
        run = data["ci"]["runs"][0]
        run["run_attempt"] = 2
        old = copy.deepcopy(data["ci"]["jobs"][0])
        old.update(id=9999, status="completed", conclusion="failure")
        data["ci"]["jobs"].append(old)
        for row in data["ci"]["jobs"]:
            if row["run_id"] == run["id"] and row["id"] != old["id"]:
                row["run_attempt"] = 2
        for row in data["ci"]["checkouts"]:
            if row["run_id"] == run["id"]:
                row["run_attempt"] = 2
        result = evaluate(POLICY, data, NOW)["integration"]
        actual = next(row for row in result["ci_runs"] if row["id"] == run["id"])
        self.assertEqual(actual["attempt"], 2)

    def test_foreign_pr_repository_check_app_or_suite_is_not_ci_evidence(self):
        for mutate in (lambda p: p["ci"]["runs"][0].update(event="workflow_dispatch"),
                       lambda p: p["ci"]["runs"][0].update(pull_requests=[{"number": 149}]),
                       lambda p: p["ci"]["runs"][0]["head_repository"].update(full_name="foreign/repo"),
                       lambda p: p["ci"]["check_runs"][0]["app"].update(slug="author-app"),
                       lambda p: p["ci"]["check_runs"][0]["check_suite"].update(id=1)):
            data = integration_packet(); mutate(data); self.denied(data)

    def test_partial_matrix_or_missing_exact_checkout_blocks_merge(self):
        for field in ("jobs", "checkouts", "check_runs"):
            data = integration_packet(); data["ci"][field].pop(); self.denied(data)
        data = integration_packet(); data["ci"]["complete"] = False; self.denied(data)

    def test_author_context_and_same_execution_cannot_self_review(self):
        for field, value in (("context_id", "author-context"), ("execution_id", "author-execution")):
            data = integration_packet(); data["independent_review"]["receipts"][0][field] = value
            if field == "execution_id":
                data["independent_review"]["reports"][0][field] = value; self.rehash_report(data, 0)
            self.denied(data)

    def test_two_roles_sharing_a_context_are_not_independent(self):
        data = integration_packet(); data["independent_review"]["receipts"][1]["context_id"] = "code-review-context"; self.denied(data)

    def test_author_pr_body_unverifiable_or_mutable_receipts_are_not_review(self):
        for field, value in (("origin", "pr-body"), ("permissions", "write"), ("result_sha256", "0" * 64),
                             ("status", "pending"), ("completed_at", (NOW + timedelta(hours=1)).isoformat())):
            data = integration_packet(); data["independent_review"]["receipts"][0][field] = value; self.denied(data)

    def test_green_ci_alone_or_only_semantic_review_cannot_accept_critical_fix(self):
        data = integration_packet(); data["independent_review"]["reports"] = []; self.denied(data)
        data = integration_packet(); reviews(data, safety=False); self.denied(data)

    def test_unresolved_findings_insufficient_coverage_or_verdict_blocks_merge(self):
        for field, value in (("findings", [{"severity": "high", "status": "open"}]), ("sufficient", False),
                             ("covered_paths", []), ("verdict", "needs-changes")):
            data = integration_packet(); data["independent_review"]["reports"][0][field] = value
            self.rehash_report(data, 0); self.denied(data)

    def test_stale_source_manifest_never_inherits_old_review(self):
        data = integration_packet(); data["pr_files"][0]["sha256"] = "a" * 64; self.denied(data)

    def test_production_cannot_downgrade_itself_to_ordinary(self):
        data = integration_packet(); data["risk"]["level"] = "ordinary"; reviews(data, safety=False); self.denied(data)

    def test_independent_review_may_escalate_an_ordinary_proposal(self):
        data = integration_packet(critical=False)
        data["independent_review"]["reports"][0]["risk"] = "critical"; self.rehash_report(data, 0); self.denied(data)

    def test_safety_tests_require_distinct_execution_and_relevant_boundaries(self):
        for mutate in (lambda p: p["test_evidence"]["safety"].pop(),
                       lambda p: p["test_evidence"]["safety"][0].update(outcome="failed"),
                       lambda p: p["test_evidence"]["safety"][0].update(executor_id="author-execution"),
                       lambda p: p["test_evidence"]["safety"][0].update(head_sha=BASE)):
            data = integration_packet(); mutate(data); self.denied(data)
        data = integration_packet()
        for row in data["test_evidence"]["safety"]: row.update(outcome="not-applicable", rationale="Independent applicability assessment")
        self.denied(data)

    def test_regression_is_assertion_failure_before_and_real_pass_after_not_missing_environment(self):
        for field, value in (("before", "import-error"), ("after", "not-run"), ("before_sha", HEAD), ("after_sha", BASE)):
            data = integration_packet(); data["test_evidence"]["reproduction"][field] = value; self.denied(data)
        data = integration_packet(); data["test_evidence"]["environment"] = "operator-home"; self.denied(data)
        for test_id in ("", " ", 123):
            data = integration_packet()
            data["test_evidence"]["reproduction"]["test_ids"] = [test_id]
            data["independent_review"]["reports"][0]["test_ids"] = [test_id]
            self.rehash_report(data, 0); self.denied(data)

    def test_current_branch_protections_and_threads_cannot_be_ignored(self):
        for mutate in (lambda p: p["branch_rules"][2]["parameters"].update(strict_required_status_checks_policy=False),
                       lambda p: p["branch_rules"][2]["parameters"]["required_status_checks"].append({"context": "new mandatory check"}),
                       lambda p: p["branch_rules"][3]["parameters"].update(required_approving_review_count=1),
                       lambda p: p.update(unresolved_threads=[1]), lambda p: p.update(changes_requested=True),
                       lambda p: p["pr"].update(requested_reviewers=[{"login": "independent-reviewer"}]),
                       lambda p: p.update(rules_complete=False)):
            data = integration_packet(); mutate(data); self.denied(data)

    def test_unknown_pending_or_unowned_task_cannot_start_merge(self):
        for mutate in (lambda p: p["state"].update(pending_operation={"result": "unknown"}),
                       lambda p: p["state"]["lease"].update(task_id="another-task"),
                       lambda p: p["state"]["active_task"].update(head_sha=BASE),
                       lambda p: p.update(state_blob_sha="unknown")):
            data = integration_packet(); mutate(data); self.denied(data)

    def test_unknown_or_post_merge_state_blocks_all_new_source_and_review_effects(self):
        for action in ("develop", "commit", "draft_create", "draft_update", "request_review", "checkpoint", "test"):
            for phase in ("merge_pending", "post_merge"):
                data = integration_packet()
                data["action"] = action
                data["test_environment"] = "isolated-synthetic-no-credentials"
                data["task"]["phase"] = phase
                data["state"]["active_task"] = copy.deepcopy(data["task"])
                self.denied(data)
            data = integration_packet(); data["action"] = action
            data["test_environment"] = "isolated-synthetic-no-credentials"
            data["state"]["pending_operation"] = {"result": "unknown"}
            self.denied(data)
            data["action"] = "observe"
            self.assertFalse(evaluate(POLICY, data, NOW)["write_authorized"])

    def test_supplied_active_task_id_cannot_hide_an_actual_uncompleted_task(self):
        data = integration_packet(); data["action"] = "develop"
        data["active_task_id"] = None
        self.denied(data)
        data = integration_packet(); data["action"] = "develop"
        data["state"]["active_task"] = {**data["task"], "id": "old-uncompleted-task"}
        self.denied(data)

    def test_full_diff_not_only_unreserved_batch_is_scope_checked(self):
        for name in (".github/workflows/pr.yml", "scripts/autonomous/dot_merge.py", "docs/dot/R2_J.md",
                     "scripts/autonomous/DOT_authority.py", "scripts/autonomous/json.py", "scripts/autonomous/yaml.py",
                     "scripts/autonomous/sitecustomize.py", "scripts/autonomous/__init__.py"):
            data = integration_packet(); data["pr_files"][0]["filename"] = name; self.denied(data)
        data = integration_packet(); data["pr_files"][0]["previous_filename"] = ".github/workflows/old.yml"; self.denied(data)
        data = integration_packet(); data["pr_files"][0]["additions"] += 1; self.denied(data)

    def test_an_existing_ready_owned_pr_still_counts_against_the_single_task_cap(self):
        data = integration_packet(action="squash_merge")
        data["open_prs"].append({**data["open_prs"][0], "branch": "dot/jules-another"}); self.denied(data)


if __name__ == "__main__":
    unittest.main()
