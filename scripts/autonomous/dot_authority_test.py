#!/usr/bin/env python3
"""Authority lifecycle, cumulative budgets and protected-operation boundaries."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dot_authority import authority, digest, evaluate, policy_check, prepare_grant

ROOT = Path(__file__).resolve().parents[2]
POLICY = json.loads((ROOT / "docs/dot/r2-j-policy.json").read_text(encoding="utf-8"))
NOW = datetime(2026, 10, 25, tzinfo=timezone.utc)
HEAD, BASE, MAIN = "a" * 40, "b" * 40, "c" * 40


def acceptance():
    return {"decision": "accept", "decision_ref": "urn:synthetic:owner-decision:1",
            "accepted_pr": 7, "accepted_head_sha": HEAD, "accepted_base_sha": BASE,
            "accepted_main_sha": MAIN,
            "check_runs": [{"run_id": 9, "attempt": 1, "head_sha": HEAD, "conclusion": "success"}]}


def change(name="scripts/autonomous/dispatch_journal.py", additions=20, deletions=10, **extra):
    return {"filename": name, "additions": additions, "deletions": deletions,
            "mode": "100644", "binary": False, **extra}


def packet():
    grant = prepare_grant(POLICY, acceptance(), NOW - timedelta(hours=1))
    return {"action": "develop", "grant": grant,
            "index": {"schema": 1, "status": "active", "repository": POLICY["repository"],
                      "grant": {"id": grant["id"], "sha256": digest(grant), "comment_id": 11},
                      "revoked_grants": []},
            "issue": {"html_url": POLICY["control_issue"], "state": "open"},
            "issue_events": [], "events_complete": True,
            "task": {"id": "journal-cas", "branch": "dot/jules-journal-cas", "base_sha": BASE,
                     "head_sha": HEAD, "ci_revisions": 0, "initial_published": False,
                     "spent_lines": 0, "touched_paths": [], "unresolved_operation": None},
            "active_task_id": None, "retired_task_ids": [], "changes": [change()],
            "open_prs": [], "inventory_complete": True, "freshness_verified": True,
            "overlap_checked": True, "ci_driven_revision": False}


class AuthorityTest(unittest.TestCase):
    def assert_denied(self, data):
        before = copy.deepcopy(data)
        with self.assertRaises(ValueError):
            evaluate(POLICY, data, NOW)
        self.assertEqual(data, before, "denial must preserve evidence and counters")

    def test_full_controller_safety_fixes_are_proposable_not_live_capabilities(self):
        data = packet()
        data["changes"] = [change(name) for name in (
            "scripts/autonomous/dispatch_journal.py", "scripts/autonomous/workflow_admission.py",
            "scripts/autonomous/state_store.py", "scripts/autonomous/jules_dispatch_test.py")]
        result = evaluate(POLICY, data, NOW)
        self.assertEqual(result["counters"]["spent_lines"], 120)
        self.assertEqual(set(result["critical_review_paths"]), {row["filename"] for row in data["changes"]})
        for action in POLICY["protected_operations"]:
            data["action"] = action
            self.assert_denied(data)

    def test_staged_missing_acceptance_hash_mismatch_and_changed_policy_fail_closed(self):
        for mutate in (
            lambda p: p["index"].update(status="staged"),
            lambda p: p["grant"]["acceptance"].update(decision="reject"),
            lambda p: p["index"]["grant"].update(sha256="0" * 64),
            lambda p: p["grant"].update(policy_sha256="0" * 64),
            lambda p: p["issue"].update(html_url="https://github.com/foreign/repo/issues/1"),
        ):
            data = packet(); mutate(data); self.assert_denied(data)

    def test_issuer_needs_exact_owner_decision_and_checked_revision_not_actor_label(self):
        for key, value in (("decision_ref", ""), ("accepted_head_sha", "bad"),
                           ("check_runs", []), ("decision", "approve")):
            data = acceptance(); data[key] = value
            with self.assertRaises(ValueError):
                prepare_grant(POLICY, data, NOW)
        data = acceptance(); data["check_runs"][0]["head_sha"] = MAIN
        with self.assertRaises(ValueError):
            prepare_grant(POLICY, data, NOW)
        data = packet(); data["grant"]["acceptance"]["accepted_head_sha"] = "bad"
        data["index"]["grant"]["sha256"] = digest(data["grant"])
        self.assert_denied(data)

    def test_close_and_reopen_cannot_revive_a_grant(self):
        data = packet(); data["issue"]["state"] = "closed"; self.assert_denied(data)
        data["issue"]["state"] = "open"
        data["issue_events"] = [{"id": 1, "event": "closed", "created_at": NOW.isoformat()},
                                {"id": 2, "event": "reopened", "created_at": NOW.isoformat()}]
        self.assert_denied(data)
        data["issue_events"] = []
        data["index"]["revoked_grants"] = [data["grant"]["id"]]
        self.assert_denied(data)

    def test_expiry_future_start_and_incomplete_revocation_reads_deny_writes(self):
        for key, value in (("issued_at", (NOW + timedelta(minutes=1)).isoformat()),
                           ("expires_at", NOW.isoformat())):
            data = packet(); data["grant"][key] = value
            data["index"]["grant"]["sha256"] = digest(data["grant"])
            self.assert_denied(data)
        data = packet(); data["events_complete"] = False; self.assert_denied(data)

    def test_unknown_effect_blocks_writes_but_observation_remains_possible(self):
        data = packet(); data["task"]["unresolved_operation"] = {"id": "same-intent", "result": "unknown"}
        self.assert_denied(data)
        data["action"] = "observe"
        self.assertEqual(evaluate(POLICY, data, NOW), {"mode": "observe", "write_authorized": False})
        self.assertEqual(data["task"]["unresolved_operation"]["id"], "same-intent")

    def test_only_one_task_and_current_owned_draft(self):
        data = packet(); data["active_task_id"] = "other-task"; self.assert_denied(data)
        for fields in ({"branch": "dot/jules-other"}, {"draft": False}, {"head_sha": MAIN},
                       {"base": "autonomous/lab"}, {"repository": "foreign/repo"}):
            data = packet()
            data["open_prs"] = [{"branch": data["task"]["branch"], "draft": True,
                                 "head_sha": HEAD, "base": "main", "repository": POLICY["repository"], **fields}]
            self.assert_denied(data)
        data = packet(); data["inventory_complete"] = False; self.assert_denied(data)
        data = packet(); data["retired_task_ids"] = [data["task"]["id"]]; self.assert_denied(data)

    def test_file_and_line_budgets_include_prior_failed_revisions_and_rename_paths(self):
        data = packet()
        data["changes"] = [change("scripts/autonomous/new.py", previous_filename="scripts/autonomous/old.py")]
        data["task"]["touched_paths"] = [f"scripts/autonomous/prior{i}.py" for i in range(8)]
        data["task"]["spent_lines"] = 970
        result = evaluate(POLICY, data, NOW)["counters"]
        self.assertEqual((len(result["touched_paths"]), result["spent_lines"]), (10, 1000))
        data["task"]["spent_lines"] = 971; self.assert_denied(data)
        data["task"]["spent_lines"] = 970
        data["task"]["touched_paths"].append("scripts/autonomous/prior8.py"); self.assert_denied(data)

    def test_rename_then_replacement_at_old_path_counts_distinct_paths_not_duplicate_rows(self):
        data = packet()
        data["changes"] = [change("scripts/autonomous/new.py", previous_filename="scripts/autonomous/old.py"),
                           change("scripts/autonomous/old.py")]
        result = evaluate(POLICY, data, NOW)["counters"]
        self.assertEqual(set(result["touched_paths"]), {"scripts/autonomous/new.py", "scripts/autonomous/old.py"})
        self.assertEqual(result["spent_lines"], 60)

    def test_three_ci_revisions_are_a_cumulative_cap_not_reset_by_reopening(self):
        data = packet(); data["task"].update(initial_published=True, ci_revisions=2)
        data["ci_driven_revision"] = True
        self.assertEqual(evaluate(POLICY, data, NOW)["counters"]["ci_revisions"], 3)
        data["task"]["ci_revisions"] = 3; self.assert_denied(data)
        data["ci_driven_revision"] = False; self.assert_denied(data)

    def test_metadata_cannot_smuggle_source_changes_without_revision_accounting(self):
        for action in ("checkpoint", "draft_create", "draft_update", "test", "unknown_op"):
            data = packet(); data["action"] = action
            data["test_environment"] = "secret-free-pr-ci"
            self.assert_denied(data)

    def test_unknown_history_or_missing_grant_identity_is_not_an_empty_history(self):
        data = packet(); data["retired_task_ids"] = None; self.assert_denied(data)
        data = packet(); del data["active_task_id"]; self.assert_denied(data)
        data = packet(); del data["task"]["unresolved_operation"]; self.assert_denied(data)
        data = packet(); data["task"]["initial_published"] = None; self.assert_denied(data)
        data = packet(); data["grant"]["id"] = None; data["index"]["grant"]["id"] = None
        data["index"]["grant"]["sha256"] = digest(data["grant"])
        self.assert_denied(data)

    def test_governance_workflows_product_binary_symlink_and_forbidden_rename_are_denied(self):
        for name in (".github/workflows/pr.yml", "agent_tasks.json", "autonomous-project.json", "AGENTS.md",
                     "docs/dot/WORKFLOW.md", "src/uiUtils.ts", "scripts/autonomous/dot_authority.py",
                     "scripts/autonomous/../outside.py", "scripts/autonomous/AGENTS.md"):
            data = packet(); data["changes"] = [change(name)]; self.assert_denied(data)
        for extra in ({"previous_filename": ".github/workflows/old.py"}, {"mode": "120000"}, {"binary": True}):
            data = packet(); data["changes"] = [change(**extra)]; self.assert_denied(data)
        data = packet(); data["changes"][0]["additions"] = True; self.assert_denied(data)

    def test_candidate_tests_require_isolation_and_fresh_semantic_inventory(self):
        data = packet(); data["action"] = "test"; data["test_environment"] = "operator-home"; data["changes"] = []
        self.assert_denied(data)
        data["test_environment"] = "secret-free-pr-ci"
        self.assertEqual(evaluate(POLICY, data, NOW)["mode"], "r2-j")
        for key in ("overlap_checked", "freshness_verified"):
            data = packet(); data[key] = False; self.assert_denied(data)



class PolicyV3AuthorityTest(unittest.TestCase):
    def setUp(self):
        self.policy = json.loads((ROOT / "docs/dot/r2-j-policy-v3.json").read_text())
        self.data = packet()
        accepted = acceptance()
        accepted["supersedes_grant_id"] = "r2-j-v2-" + "1" * 32
        grant = prepare_grant(self.policy, accepted, NOW - timedelta(hours=1))
        self.data.update(grant=grant, index={
            "schema": 2, "policy_version": 3, "policy_path": grant["policy_path"],
            "policy_sha256": digest(self.policy), "status": "active",
            "repository": self.policy["repository"],
            "grant": {"id": grant["id"], "sha256": digest(grant), "comment_id": 23},
            "revoked_grants": [accepted["supersedes_grant_id"]]})

    def test_new_policy_requires_new_bound_grant_and_explicit_old_revocation(self):
        self.assertEqual(authority(self.policy, self.data, NOW), self.data["grant"]["id"])
        for key, value in (("policy_version", 2), ("policy_path", "docs/dot/r2-j-policy-v2.json"),
                           ("policy_sha256", "0" * 64), ("revoked_grants", [])):
            data = copy.deepcopy(self.data); data["index"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                authority(self.policy, data, NOW)

    def test_old_policy_and_grant_cannot_select_new_review_semantics(self):
        old = json.loads((ROOT / "docs/dot/r2-j-policy-v2.json").read_text())
        with self.assertRaises(ValueError): authority(old, self.data, NOW)
        grant = prepare_grant(old, self.data["grant"]["acceptance"], NOW - timedelta(hours=1))
        self.data["grant"] = grant
        self.data["index"]["grant"].update(id=grant["id"], sha256=digest(grant))
        with self.assertRaises(ValueError): authority(self.policy, self.data, NOW)

    def test_v3_cannot_claim_provider_attestation_or_weaken_review_roles(self):
        for key, value in (("origin", "provider-tool-result"), ("permissions", "read-only"),
                           ("independence", "provider-attested"), ("ordinary_executions", ["code-review"]),
                           ("critical_executions", ["safety-review"])):
            changed = copy.deepcopy(self.policy); changed["review"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): policy_check(changed)
        self.assertEqual(self.policy["review"]["ordinary_executions"], ["code-review", "safety-review"])
        self.assertEqual(self.policy["review"]["critical_executions"], ["code-review", "safety-review"])

    def test_v3_unknown_version_or_reopened_revocation_stays_closed(self):
        policy = copy.deepcopy(self.policy); policy["version"] = 4
        with self.assertRaises(ValueError): policy_check(policy)
        self.data["issue_events"] = [{"id": 2, "event": "closed", "created_at": NOW.isoformat()},
                                     {"id": 3, "event": "reopened", "created_at": NOW.isoformat()}]
        with self.assertRaises(ValueError): authority(self.policy, self.data, NOW)

if __name__ == "__main__":
    unittest.main()

