#!/usr/bin/env python3
"""Tests for verify_policy.py, including the real repository config."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from verify_policy import REQUIRED_MANUAL_REVIEW, verify  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "autonomous-project.json"


def load() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


class RealConfigTest(unittest.TestCase):
    def test_the_shipped_config_satisfies_the_policy(self):
        self.assertEqual(verify(load()), [])



class ReleasePolicyTest(unittest.TestCase):
    def test_enabling_release_automation_is_rejected(self):
        config = load()
        config["release_policy"]["automation"] = "enabled"
        self.assertTrue(any("automation" in p for p in verify(config)))

    def test_dropping_the_human_gate_is_rejected(self):
        config = load()
        config["release_policy"]["human_gated"] = False
        self.assertTrue(any("human_gated" in p for p in verify(config)))


class ParallelModeTest(unittest.TestCase):
    def test_pointing_the_loop_at_the_default_branch_is_rejected(self):
        config = load()
        config["parallel_mode"]["integration_branch"] = "main"
        config["parallel_mode"]["merge_target"] = "main"
        problems = verify(config)
        self.assertTrue(problems)

    def test_merge_target_must_match_the_integration_branch(self):
        config = load()
        config["parallel_mode"]["merge_target"] = "autonomous/other"
        self.assertTrue(any("merge_target" in p for p in verify(config)))

    def test_allowing_default_branch_merges_is_rejected(self):
        config = load()
        config["parallel_mode"]["never_merge_to_default"] = False
        self.assertTrue(any("never_merge_to_default" in p for p in verify(config)))


class ScopeTest(unittest.TestCase):
    def test_each_current_guardrail_exclusion_cannot_be_removed(self):
        # Keep this independent of the verifier's constants: a forgotten
        # guardrail must not silently disappear from both code and coverage.
        guardrails = [
            path for path in load()["product"]["excluded"]
            if path not in ("**/*.png", "**/*.ico", "**/*.icns")
        ]
        for pattern in guardrails:
            with self.subTest(path=pattern):
                config = load()
                config["product"]["excluded"].remove(pattern)
                self.assertTrue(
                    any(pattern in p for p in verify(config)),
                    "removing " + pattern + " must be rejected",
                )

    def test_removing_the_updater_from_manual_review_is_rejected(self):
        config = load()
        config["product"]["manual_review_paths"] = []
        problems = verify(config)
        self.assertTrue(any("manual_review_paths" in p for p in problems))

    def test_hard_excluding_the_updater_is_also_acceptable(self):
        config = load()
        config["product"]["manual_review_paths"] = []
        config["product"]["excluded"] = list(config["product"]["excluded"]) + list(
            REQUIRED_MANUAL_REVIEW
        )
        self.assertEqual(verify(config), [])

    def test_empty_editable_scope_is_rejected(self):
        config = load()
        config["product"]["editable_globs"] = []
        self.assertTrue(any("editable_globs" in p for p in verify(config)))

    def test_granting_workflow_access_is_rejected(self):
        config = load()
        config["product"]["editable_globs"] = [".github/**"]
        self.assertTrue(any("editable_globs" in p for p in verify(config)))

    def test_granting_whole_repository_access_is_rejected(self):
        config = load()
        config["product"]["editable_globs"] = ["**"]
        self.assertTrue(any("editable_globs" in p for p in verify(config)))


class MergeGateTest(unittest.TestCase):
    def test_turning_off_the_fix_evidence_requirement_is_rejected(self):
        config = load()
        config["merge_gate"]["require_regression_test"] = False
        self.assertTrue(any("require_regression_test" in p for p in verify(config)))

    def test_removing_the_approval_label_is_rejected(self):
        config = load()
        config["merge_gate"]["manual_approval_labels"] = []
        self.assertTrue(any("manual_approval_labels" in p for p in verify(config)))

    def test_removing_the_test_globs_is_rejected(self):
        config = load()
        config["merge_gate"]["test_globs"] = []
        self.assertTrue(any("test_globs" in p for p in verify(config)))

    def test_unnamed_evidence_check_is_rejected(self):
        config = load()
        config["merge_gate"]["evidence_check_name"] = ""
        self.assertTrue(any("evidence_check_name" in p for p in verify(config)))

    def test_deleting_the_merge_gate_entirely_is_rejected(self):
        config = load()
        config.pop("merge_gate")
        self.assertTrue(verify(config))


class EmptyConfigTest(unittest.TestCase):
    def test_an_empty_config_fails_loudly(self):
        self.assertTrue(verify({}))

    def test_verification_does_not_mutate_the_config(self):
        config = load()
        before = copy.deepcopy(config)
        verify(config)
        self.assertEqual(config, before)


class MergeGateContractTest(unittest.TestCase):
    """The policy check must cover everything the merge decision reads, or the
    configuration can be weakened without the check noticing."""

    def test_removing_the_required_check_names_is_rejected(self):
        config = load()
        config["merge_gate"].pop("required_check_names", None)
        self.assertTrue(any("required_check_names" in p for p in verify(config)))

    def test_an_empty_required_check_list_is_rejected(self):
        config = load()
        config["merge_gate"]["required_check_names"] = []
        self.assertTrue(any("required_check_names" in p for p in verify(config)))

    def test_substituting_workflow_or_dropping_a_platform_is_rejected(self):
        for checks in (
            ["Quality Gate"],
            ["Checks (ubuntu-latest)"],
            ["Checks (windows-latest)"],
            ["Checks (ubuntu-latest)", "Checks (windows-latest) "],
            "Checks (ubuntu-latest), Checks (windows-latest)",
        ):
            with self.subTest(checks=checks):
                config = load()
                config["merge_gate"]["required_check_names"] = checks
                self.assertTrue(any("required_check_names" in p for p in verify(config)))

    def test_adding_another_required_check_can_only_tighten_policy(self):
        config = load()
        config["merge_gate"]["required_check_names"].append("Additional security check")
        self.assertEqual(verify(config), [])

    def test_substituting_a_nonempty_evidence_check_is_rejected(self):
        config = load()
        config["merge_gate"]["evidence_check_name"] = "Quality Gate"
        self.assertTrue(any("evidence_check_name" in p for p in verify(config)))

    def test_removing_the_owner_approvers_is_rejected(self):
        config = load()
        config["merge_gate"].pop("owner_approvers", None)
        self.assertTrue(any("owner_approvers" in p for p in verify(config)))

    def test_an_unlimited_diff_size_is_rejected(self):
        config = load()
        config["merge_gate"]["max_changed_files"] = 0
        self.assertTrue(any("max_changed_files" in p for p in verify(config)))

    def test_every_updater_path_is_required_not_just_the_first_two(self):
        for path in load()["product"]["manual_review_paths"]:
            config = load()
            config["product"]["manual_review_paths"] = [
                kept for kept in config["product"]["manual_review_paths"]
                if kept != path
            ]
            with self.subTest(path=path):
                self.assertTrue(any(path in problem for problem in verify(config)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
