#!/usr/bin/env python3
"""Tests for automerge_decision.py.

Each class pins a way something could have been merged that nobody checked:

* a revision the gates never verified (the head moved, or no SHA was supplied);
* a diff read from a file list that was truncated, unpinned, or renamed around
  the guardrails;
* a fix with no failing-first proof behind it;
* a gate that had not finished yet, treated as a verdict;
* an ``approved-by-owner`` label, which survives a force-push, treated as an
  approval of the revision being merged.
"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from automerge_decision import (  # noqa: E402
    EXIT_CODES, EXIT_MERGE, EXIT_SCOPE_VIOLATION,
    decide, normalize_author,
)

SHA_A = "a" * 40
SHA_B = "b" * 40
SHORT_A = SHA_A[:12]

DEFAULT_FILES = ("src/clock.ts", "src/clock.test.ts")

CONFIG = {
    "product": {
        "editable_globs": ["src/**", "src-tauri/src/**", "src-tauri/tests/**"],
        "excluded": [
            ".github/workflows/**", "scripts/autonomous/**", "autonomous-project.json",
            "package.json", "src-tauri/tauri.conf.json",
        ],
        "manual_review_paths": ["src/clientUpdater.ts", "src/useClientUpdater.ts"],
    },
    "merge_gate": {
        "require_regression_test": True,
        "evidence_check_name": "Autonomous Evidence Gate",
        "manual_approval_labels": ["approved-by-owner"],
        "test_globs": ["*.test.ts", "*.test.tsx"],
        "required_check_names": ["Checks (ubuntu-latest)", "Checks (windows-latest)"],
        "owner_approvers": ["Omnividente"],
        "max_changed_files": 200,
    },
    "automation": {
        "allowed_pr_authors": ["google-labs-jules[bot]"],
        "blocking_labels": ["hold", "do-not-merge", "human-review", "wip"],
    },
}


def config_with(**gate) -> dict:
    config = copy.deepcopy(CONFIG)
    config["merge_gate"].update(gate)
    return config


def entry(filename: str, previous: str = "") -> dict:
    item = {"filename": filename}
    if previous:
        item["previous_filename"] = previous
    return item


def entries(*paths) -> list:
    return [entry(path) for path in paths]


def approval(login: str = "Omnividente", commit_id: str = SHA_A,
             state: str = "APPROVED") -> dict:
    return {"user": {"login": login}, "commit_id": commit_id, "state": state}


def pull_request(**overrides) -> dict:
    base = {
        "number": 12,
        "state": "OPEN",
        "isDraft": False,
        "baseRefName": "autonomous/lab",
        "labels": [],
        "files": [{"path": path} for path in DEFAULT_FILES],
        "title": "[dispatch:abc] fix clock",
        "author": {"login": "google-labs-jules[bot]"},
        "headRefOid": SHA_A,
    }
    base.update(overrides)
    return base


def call(pr, config=None, **kwargs) -> dict:
    """A pull request whose gates are all green on the verified revision."""
    kwargs.setdefault("ci_sha", SHA_A)
    kwargs.setdefault("quality_state", "passed")
    kwargs.setdefault("evidence_state", "passed")
    if "file_entries" not in kwargs and "changed_files" not in kwargs:
        kwargs["file_entries"] = entries(*DEFAULT_FILES)
    listed = kwargs.get("file_entries")
    if listed is None:
        listed = kwargs.get("changed_files")
    if "expected_file_count" not in kwargs and listed is not None:
        kwargs["expected_file_count"] = len(list(listed))
    return decide(pr, config or CONFIG, **kwargs)


def joined(reasons) -> str:
    return " | ".join(reasons)


class HealthyPullRequestTest(unittest.TestCase):
    def test_a_green_in_scope_pull_request_is_merged(self):
        result = call(pull_request())
        self.assertEqual(result["decision"], "merge")
        self.assertEqual(result["reasons"], [])
        self.assertEqual(result["review_reasons"], [])
        self.assertEqual(result["changed_files"], list(DEFAULT_FILES))
        self.assertTrue(result["changed_files_complete"])
        self.assertEqual(EXIT_CODES[result["decision"]], EXIT_MERGE)

    def test_another_base_branch_is_never_merged_by_the_loop(self):
        result = call(pull_request(baseRefName="main"))
        self.assertEqual(result["decision"], "skip")
        self.assertIn("may only merge into 'autonomous/lab'", joined(result["reasons"]))

    def test_a_draft_is_skipped(self):
        result = call(pull_request(isDraft=True))
        self.assertEqual(result["decision"], "skip")
        self.assertIn("draft", joined(result["reasons"]))

    def test_a_closed_pull_request_is_skipped(self):
        result = call(pull_request(state="CLOSED"))
        self.assertEqual(result["decision"], "skip")
        self.assertIn("state is CLOSED", joined(result["reasons"]))

    def test_a_foreign_author_is_skipped(self):
        result = call(pull_request(author={"login": "some-person"}))
        self.assertEqual(result["decision"], "skip")
        self.assertIn("not an allowed autonomous worker", joined(result["reasons"]))

    def test_a_blocking_label_is_skipped(self):
        result = call(pull_request(labels=[{"name": "hold"}]))
        self.assertEqual(result["decision"], "skip")
        self.assertIn("blocking label(s): hold", joined(result["reasons"]))


class SingleRevisionTest(unittest.TestCase):
    """Reported defect: CI verified one commit, the scope check read another,
    and the merge took whatever the head happened to be."""

    def test_matching_head_and_ci_sha_is_allowed(self):
        self.assertEqual(call(pull_request())["decision"], "merge")

    def test_a_head_that_moved_since_ci_is_skipped(self):
        result = call(pull_request(headRefOid=SHA_B))
        self.assertEqual(result["decision"], "skip")
        self.assertIn("head moved since CI", joined(result["reasons"]))

    def test_no_verified_revision_means_no_merge(self):
        result = call(pull_request(), ci_sha="")
        self.assertEqual(result["decision"], "skip")
        self.assertIn("refusing to merge blind", joined(result["reasons"]))

    def test_pinned_file_list_overrides_the_live_pull_request_files(self):
        """The live file list belongs to the current head, not to the verified one."""
        result = call(pull_request(files=[{"path": "src/clientUpdater.ts"}]))
        self.assertEqual(result["decision"], "merge")
        self.assertEqual(result["changed_files"], list(DEFAULT_FILES))

    def test_unpinned_file_list_is_not_trusted(self):
        result = decide(
            pull_request(), CONFIG, ci_sha=SHA_A, quality_state="passed",
            evidence_state="passed", expected_file_count=len(DEFAULT_FILES),
        )
        self.assertEqual(result["decision"], "manual_review")
        self.assertIn("not pinned to the CI-verified revision", joined(result["review_reasons"]))


class FileListCompletenessTest(unittest.TestCase):
    """Reported defect: GitHub truncates file lists, so a scope check can be run
    against a fragment of the diff and still look green."""

    def test_a_truncated_list_goes_to_a_human(self):
        result = call(pull_request(), expected_file_count=300)
        self.assertEqual(result["decision"], "manual_review")
        self.assertIn("the file list is not complete", joined(result["review_reasons"]))
        self.assertFalse(result["changed_files_complete"])

    def test_an_unknown_file_count_cannot_be_proven_complete(self):
        result = call(pull_request(), expected_file_count=None)
        self.assertEqual(result["decision"], "manual_review")
        self.assertIn("cannot be proven complete", joined(result["review_reasons"]))

    def test_a_matching_count_is_accepted(self):
        result = call(pull_request())
        self.assertTrue(result["changed_files_complete"])
        self.assertEqual(result["expected_file_count"], 2)
        self.assertEqual(result["changed_file_count"], 2)

    def test_a_diff_beyond_the_mechanical_limit_goes_to_a_human(self):
        result = call(pull_request(), config=config_with(max_changed_files=1))
        self.assertEqual(result["decision"], "manual_review")
        self.assertIn("too large to check mechanically", joined(result["review_reasons"]))
    def test_owner_approval_cannot_bypass_a_truncated_file_list(self):
        result = call(pull_request(), expected_file_count=301, approvals=[approval()])
        self.assertEqual(result["decision"], "manual_review")
        self.assertFalse(result["changed_files_complete"])

    def test_duplicate_or_malformed_entries_do_not_prove_completeness(self):
        for bad in ({}, entry("src/clock.ts"), {"filename": "src/new.ts", "status": "renamed"}):
            with self.subTest(entry=bad):
                result = call(pull_request(), file_entries=[entry("src/clock.ts"), bad], expected_file_count=2)
                self.assertEqual(result["decision"], "manual_review")
                self.assertFalse(result["changed_files_complete"])


    def test_a_rename_is_checked_under_both_names(self):
        """Moving a manual-review file to a new name must not hide it."""
        result = call(
            pull_request(),
            file_entries=[entry("src/clock.ts", previous="src/clientUpdater.ts")],
            expected_file_count=1,
        )
        self.assertEqual(result["decision"], "manual_review")
        self.assertIn("src/clientUpdater.ts", result["manual_review_paths"])
        self.assertEqual(
            result["renamed_paths"],
            [{"from": "src/clientUpdater.ts", "to": "src/clock.ts"}],
        )

    def test_a_rename_out_of_the_allowed_scope_is_refused(self):
        result = call(
            pull_request(),
            file_entries=[entry("src/clock.ts", previous=".github/workflows/pr.yml")],
            expected_file_count=1,
        )
        self.assertEqual(result["decision"], "scope_violation")

    def test_an_empty_diff_is_skipped(self):
        result = call(pull_request(), file_entries=[])
        self.assertEqual(result["decision"], "skip")
        self.assertIn("no changed files", joined(result["reasons"]))


class PendingGateTest(unittest.TestCase):
    """Reported defect: an unfinished gate was indistinguishable from a red one,
    so a pull request was labelled for a human and never looked at again."""

    def test_a_running_quality_gate_is_skipped_not_labelled(self):
        result = call(pull_request(), quality_state="pending")
        self.assertEqual(result["decision"], "skip")
        self.assertTrue(result["pending"])
        self.assertEqual(result["review_reasons"], [])
        self.assertIn("still waiting for the quality gate", joined(result["reasons"]))

    def test_a_running_evidence_gate_is_skipped_not_labelled(self):
        result = call(pull_request(), evidence_state="pending")
        self.assertEqual(result["decision"], "skip")
        self.assertTrue(result["pending"])
        self.assertEqual(result["review_reasons"], [])

    def test_both_gates_running_are_named(self):
        result = call(pull_request(), quality_state="pending", evidence_state="pending")
        self.assertEqual(result["decision"], "skip")
        text = joined(result["reasons"])
        self.assertIn("the quality gate", text)
        self.assertIn("the evidence gate", text)
        self.assertIn(SHORT_A, text)

    def test_a_red_quality_gate_is_skipped(self):
        result = call(pull_request(), quality_state="failed")
        self.assertEqual(result["decision"], "skip")
        self.assertFalse(result["pending"])
        self.assertIn("quality gate is red", joined(result["reasons"]))

    def test_a_missing_quality_result_is_skipped(self):
        result = call(pull_request(), quality_state="missing")
        self.assertEqual(result["decision"], "skip")
        self.assertIn("no quality-gate result was found", joined(result["reasons"]))

    def test_an_unknown_quality_value_is_treated_as_missing(self):
        result = call(pull_request(), quality_state="probably-fine")
        self.assertEqual(result["quality_state"], "missing")
        self.assertEqual(result["decision"], "skip")


class EvidenceTest(unittest.TestCase):
    def test_a_proved_fix_is_merged(self):
        self.assertEqual(call(pull_request(), evidence_state="passed")["decision"], "merge")

    def test_a_diff_with_nothing_to_prove_is_merged(self):
        result = call(pull_request(), evidence_state="not_required")
        self.assertEqual(result["decision"], "merge")

    def test_an_unproven_fix_goes_to_a_human(self):
        result = call(pull_request(), evidence_state="missing")
        self.assertEqual(result["decision"], "manual_review")
        self.assertIn("the fix is unproven", joined(result["review_reasons"]))

    def test_a_failed_proof_run_goes_to_a_human(self):
        result = call(pull_request(), evidence_state="failed")
        self.assertEqual(result["decision"], "manual_review")
        self.assertIn("evidence gate is failed", joined(result["review_reasons"]))

    def test_evidence_can_be_waived_by_configuration(self):
        result = call(
            pull_request(), config=config_with(require_regression_test=False),
            evidence_state="missing",
        )
        self.assertEqual(result["decision"], "merge")

    def test_an_unknown_evidence_value_is_treated_as_missing(self):
        result = call(pull_request(), evidence_state="looks-ok")
        self.assertEqual(result["evidence_state"], "missing")
        self.assertEqual(result["decision"], "manual_review")


class ManualReviewPathTest(unittest.TestCase):
    def test_updater_source_is_never_merged_unattended(self):
        result = call(pull_request(), file_entries=entries("src/clientUpdater.ts"))
        self.assertEqual(result["decision"], "manual_review")
        self.assertIn("touches manual-review path(s)", joined(result["review_reasons"]))

    def test_the_updater_hook_is_also_covered(self):
        result = call(pull_request(), file_entries=entries("src/useClientUpdater.ts"))
        self.assertEqual(result["decision"], "manual_review")

    def test_owner_approval_of_the_verified_revision_releases_it(self):
        result = call(
            pull_request(), file_entries=entries("src/clientUpdater.ts"),
            approvals=[approval()],
        )
        self.assertEqual(result["decision"], "merge")
        self.assertEqual(result["approved_by"], ["Omnividente"])
        self.assertTrue(result["overridden_review_reasons"])

    def test_owner_approval_cannot_authorise_an_out_of_scope_diff(self):
        result = call(
            pull_request(), file_entries=entries("package.json"), approvals=[approval()],
        )
        self.assertEqual(result["decision"], "scope_violation")
        self.assertTrue(result["violations"])


class ApprovalTest(unittest.TestCase):
    """Reported defect: the approved-by-owner label survives a force-push, so a
    label was accepted as approval of whatever landed afterwards."""

    def test_the_label_alone_is_not_an_approval(self):
        result = call(
            pull_request(labels=[{"name": "approved-by-owner"}]),
            file_entries=entries("src/clientUpdater.ts"),
        )
        self.assertEqual(result["decision"], "manual_review")
        self.assertIn("is not an approval of " + SHORT_A, joined(result["review_reasons"]))
        self.assertEqual(result["approved_by"], [])
        self.assertEqual(result["label_approvals"], ["approved-by-owner"])

    def test_an_approval_of_another_revision_does_not_count(self):
        result = call(
            pull_request(), file_entries=entries("src/clientUpdater.ts"),
            approvals=[approval(commit_id=SHA_B)],
        )
        self.assertEqual(result["decision"], "manual_review")
        self.assertEqual(result["approved_by"], [])

    def test_a_changes_requested_review_does_not_count(self):
        result = call(
            pull_request(), file_entries=entries("src/clientUpdater.ts"),
            approvals=[approval(state="CHANGES_REQUESTED")],
        )
        self.assertEqual(result["decision"], "manual_review")

    def test_a_stranger_cannot_approve(self):
        result = call(
            pull_request(), file_entries=entries("src/clientUpdater.ts"),
            approvals=[approval(login="passer-by")],
        )
        self.assertEqual(result["decision"], "manual_review")
        self.assertEqual(result["approved_by"], [])

    def test_an_owner_login_is_matched_case_insensitively(self):
        result = call(
            pull_request(), file_entries=entries("src/clientUpdater.ts"),
            approvals=[approval(login="omnividente")],
        )
        self.assertEqual(result["decision"], "merge")

    def test_a_top_level_login_field_is_accepted(self):
        result = call(
            pull_request(), file_entries=entries("src/clientUpdater.ts"),
            approvals=[{"login": "Omnividente", "commit_id": SHA_A, "state": "APPROVED"}],
        )
        self.assertEqual(result["decision"], "merge")

    def test_an_approval_never_clears_a_skip_reason(self):
        result = call(
            pull_request(labels=[{"name": "hold"}]),
            file_entries=entries("src/clientUpdater.ts"), approvals=[approval()],
        )
        self.assertEqual(result["decision"], "skip")
    def test_latest_owner_verdict_revokes_a_previous_approval(self):
        for state in ("CHANGES_REQUESTED", "DISMISSED"):
            with self.subTest(state=state):
                result = call(
                    pull_request(), file_entries=entries("src/clientUpdater.ts"),
                    approvals=[approval(), approval(state=state)],
                )
                self.assertEqual(result["decision"], "manual_review")

    def test_a_comment_does_not_revoke_an_approval(self):
        result = call(
            pull_request(), file_entries=entries("src/clientUpdater.ts"),
            approvals=[approval(), approval(state="COMMENTED")],
        )
        self.assertEqual(result["decision"], "merge")



class GuardTest(unittest.TestCase):
    def test_an_out_of_scope_file_is_refused_outright(self):
        result = call(pull_request(), file_entries=entries("package.json"))
        self.assertEqual(result["decision"], "scope_violation")
        self.assertEqual(EXIT_CODES[result["decision"]], EXIT_SCOPE_VIOLATION)

    def test_a_workflow_change_is_refused(self):
        result = call(pull_request(), file_entries=entries(".github/workflows/pr.yml"))
        self.assertEqual(result["decision"], "scope_violation")

    def test_a_control_plane_change_is_refused(self):
        result = call(
            pull_request(), file_entries=entries("scripts/autonomous/automerge_decision.py"),
        )
        self.assertEqual(result["decision"], "scope_violation")

    def test_a_file_outside_the_editable_roots_is_refused(self):
        result = call(pull_request(), file_entries=entries("docs/notes.md"))
        self.assertEqual(result["decision"], "scope_violation")
        self.assertTrue(
            any(v.get("reason") == "outside_editable_scope" for v in result["violations"])
        )

    def test_a_scope_violation_outranks_manual_review(self):
        result = call(
            pull_request(), file_entries=entries("package.json", "src/clientUpdater.ts"),
        )
        self.assertEqual(result["decision"], "scope_violation")


class AuthorNormalisationTest(unittest.TestCase):
    def test_app_and_bot_decorations_are_stripped(self):
        self.assertEqual(normalize_author("App/Google-Labs-Jules[bot]"),
                         "google-labs-jules[bot]")
        self.assertEqual(normalize_author("bot/worker"), "worker")
        self.assertEqual(normalize_author(None), "")

    def test_a_decorated_allowed_author_still_matches(self):
        config = copy.deepcopy(CONFIG)
        config["automation"]["allowed_pr_authors"] = ["app/Google-Labs-Jules[bot]"]
        self.assertEqual(call(pull_request(), config=config)["decision"], "merge")




if __name__ == "__main__":
    unittest.main(verbosity=2)
