#!/usr/bin/env python3
"""Tests for automerge_decision.py.

The two headline regressions are covered first: merging a revision CI never
verified, and merging an unproven fix.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from automerge_decision import (  # noqa: E402
    EXIT_MANUAL_REVIEW, EXIT_MERGE, EXIT_SCOPE_VIOLATION, EXIT_SKIP, EXIT_CODES,
    decide, normalize_author,
)

SHA_A = "a" * 40
SHA_B = "b" * 40

CONFIG = {
    "product": {
        "editable_globs": ["src/**", "src-tauri/src/**", "src-tauri/tests/**"],
        "excluded": [".github/workflows/**", "package.json", "src-tauri/tauri.conf.json"],
        "manual_review_paths": ["src/clientUpdater.ts", "src/useClientUpdater.ts"],
    },
    "merge_gate": {
        "require_regression_test": True,
        "evidence_check_name": "Autonomous Evidence Gate",
        "manual_approval_labels": ["approved-by-owner"],
        "test_globs": ["*.test.ts", "*.test.tsx"],
    },
    "automation": {
        "allowed_pr_authors": ["google-labs-jules[bot]"],
        "blocking_labels": ["hold", "do-not-merge", "human-review", "wip"],
    },
}


def pull_request(**overrides) -> dict:
    base = {
        "number": 12,
        "state": "OPEN",
        "isDraft": False,
        "baseRefName": "autonomous/lab",
        "labels": [],
        "files": [{"path": "src/clock.ts"}, {"path": "src/clock.test.ts"}],
        "title": "[dispatch:abc] fix clock",
        "author": {"login": "google-labs-jules[bot]"},
        "headRefOid": SHA_A,
    }
    base.update(overrides)
    return base


def call(pr, **kwargs):
    kwargs.setdefault("ci_sha", SHA_A)
    kwargs.setdefault("evidence_state", "passed")
    kwargs.setdefault("changed_files", ["src/clock.ts", "src/clock.test.ts"])
    return decide(pr, CONFIG, "autonomous/lab", **kwargs)


class SingleRevisionTest(unittest.TestCase):
    """Reported defect: CI verified A, scope checked B, merge targeted C."""

    def test_head_moved_since_ci_is_refused(self):
        result = call(pull_request(headRefOid=SHA_B))
        self.assertEqual(result["decision"], "skip")
        self.assertTrue(any("head moved" in r for r in result["reasons"]))

    def test_merging_blind_without_a_verified_sha_is_refused(self):
        result = call(pull_request(), ci_sha="")
        self.assertEqual(result["decision"], "skip")
        self.assertTrue(any("CI-verified" in r for r in result["reasons"]))

    def test_matching_head_and_ci_sha_is_allowed(self):
        result = call(pull_request())
        self.assertEqual(result["decision"], "merge")
        self.assertEqual(result["ci_sha"], SHA_A)
        self.assertEqual(result["head_sha"], SHA_A)

    def test_unpinned_file_list_is_not_trusted(self):
        result = call(pull_request(), changed_files=None)
        self.assertEqual(result["decision"], "manual_review")
        self.assertTrue(any("not pinned" in r for r in result["review_reasons"]))

    def test_pinned_file_list_overrides_the_live_pull_request_files(self):
        pr = pull_request(files=[{"path": "package.json"}])
        result = call(pr, changed_files=["src/clock.ts", "src/clock.test.ts"])
        self.assertEqual(result["decision"], "merge")
        self.assertEqual(result["changed_files"], ["src/clock.ts", "src/clock.test.ts"])


class EvidenceTest(unittest.TestCase):
    """Reported defect: src/App.tsx with no test and no evidence got 'merge'."""

    def test_unproven_source_change_goes_to_a_human(self):
        result = call(
            pull_request(files=[{"path": "src/App.tsx"}]),
            changed_files=["src/App.tsx"], evidence_state="missing",
        )
        self.assertEqual(result["decision"], "manual_review")
        self.assertTrue(any("unproven" in r for r in result["review_reasons"]))

    def test_failed_proof_run_goes_to_a_human(self):
        result = call(pull_request(), evidence_state="failed")
        self.assertEqual(result["decision"], "manual_review")

    def test_proved_fix_is_merged(self):
        self.assertEqual(call(pull_request(), evidence_state="passed")["decision"], "merge")

    def test_diff_with_nothing_to_prove_is_merged(self):
        result = call(
            pull_request(files=[{"path": "src/clock.test.ts"}]),
            changed_files=["src/clock.test.ts"], evidence_state="not_required",
        )
        self.assertEqual(result["decision"], "merge")

    def test_unknown_evidence_value_is_treated_as_missing(self):
        result = call(pull_request(), evidence_state="looks-fine-to-me")
        self.assertEqual(result["evidence_state"], "missing")
        self.assertEqual(result["decision"], "manual_review")

    def test_evidence_can_be_waived_by_configuration(self):
        config = {k: dict(v) for k, v in CONFIG.items()}
        config["merge_gate"] = dict(CONFIG["merge_gate"])
        config["merge_gate"]["require_regression_test"] = False
        result = decide(
            pull_request(), config, "autonomous/lab", ci_sha=SHA_A,
            changed_files=["src/App.tsx"], evidence_state="missing",
        )
        self.assertEqual(result["decision"], "merge")


class ManualReviewPathTest(unittest.TestCase):
    """Reported defect: the auto-update sources were merge-eligible."""

    def test_updater_source_is_never_merged_unattended(self):
        result = call(
            pull_request(files=[{"path": "src/clientUpdater.ts"}]),
            changed_files=["src/clientUpdater.ts", "src/clientUpdater.test.ts"],
        )
        self.assertEqual(result["decision"], "manual_review")
        self.assertEqual(result["manual_review_paths"], ["src/clientUpdater.ts"])

    def test_updater_hook_is_also_covered(self):
        result = call(
            pull_request(), changed_files=["src/useClientUpdater.ts", "src/x.test.ts"]
        )
        self.assertEqual(result["decision"], "manual_review")

    def test_owner_approval_label_accepts_a_manual_review_case(self):
        result = call(
            pull_request(labels=[{"name": "approved-by-owner"}]),
            changed_files=["src/clientUpdater.ts"], evidence_state="missing",
        )
        self.assertEqual(result["decision"], "merge")
        self.assertEqual(result["approved_by"], ["approved-by-owner"])

    def test_owner_approval_cannot_authorise_an_out_of_scope_diff(self):
        result = call(
            pull_request(labels=[{"name": "approved-by-owner"}]),
            changed_files=["package.json"],
        )
        self.assertEqual(result["decision"], "scope_violation")

    def test_owner_approval_cannot_authorise_a_stale_revision(self):
        result = call(
            pull_request(headRefOid=SHA_B, labels=[{"name": "approved-by-owner"}])
        )
        self.assertEqual(result["decision"], "skip")


class GuardTest(unittest.TestCase):
    def test_pull_request_against_the_default_branch_is_refused(self):
        result = call(pull_request(baseRefName="main"))
        self.assertEqual(result["decision"], "skip")
        self.assertTrue(any("base branch" in r for r in result["reasons"]))

    def test_human_pull_request_is_ignored(self):
        result = call(pull_request(author={"login": "Omnividente"}))
        self.assertEqual(result["decision"], "skip")

    def test_draft_is_ignored(self):
        self.assertEqual(call(pull_request(isDraft=True))["decision"], "skip")

    def test_closed_pull_request_is_ignored(self):
        self.assertEqual(call(pull_request(state="MERGED"))["decision"], "skip")

    def test_blocking_label_wins(self):
        result = call(pull_request(labels=[{"name": "human-review"}]))
        self.assertEqual(result["decision"], "skip")

    def test_empty_diff_is_ignored(self):
        result = call(pull_request(files=[]), changed_files=[])
        self.assertEqual(result["decision"], "skip")

    def test_out_of_scope_file_is_refused_outright(self):
        result = call(pull_request(), changed_files=[".github/workflows/pr.yml"])
        self.assertEqual(result["decision"], "scope_violation")

    def test_file_outside_the_editable_roots_is_refused(self):
        result = call(pull_request(), changed_files=["README.md"])
        self.assertEqual(result["decision"], "scope_violation")


class AuthorNormalisationTest(unittest.TestCase):
    def test_app_and_bot_decorations_are_stripped(self):
        self.assertEqual(normalize_author("app/google-labs-jules"), "google-labs-jules")
        self.assertEqual(normalize_author("google-labs-jules[bot]"), "google-labs-jules")
        self.assertEqual(normalize_author(None), "")


class ExitCodeTest(unittest.TestCase):
    def test_every_decision_maps_to_a_distinct_exit_code(self):
        self.assertEqual(EXIT_CODES["merge"], EXIT_MERGE)
        self.assertEqual(EXIT_CODES["skip"], EXIT_SKIP)
        self.assertEqual(EXIT_CODES["scope_violation"], EXIT_SCOPE_VIOLATION)
        self.assertEqual(EXIT_CODES["manual_review"], EXIT_MANUAL_REVIEW)
        self.assertEqual(len(set(EXIT_CODES.values())), 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
