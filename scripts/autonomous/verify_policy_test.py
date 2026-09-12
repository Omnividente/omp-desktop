#!/usr/bin/env python3
"""Tests for verify_policy.py, including the real repository config."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from verify_policy import (  # noqa: E402
    REQUIRED_EXCLUSIONS, REQUIRED_MANUAL_REVIEW, verify,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "autonomous-project.json"


def load() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


class RealConfigTest(unittest.TestCase):
    def test_the_shipped_config_satisfies_the_policy(self):
        self.assertEqual(verify(load()), [])

    def test_the_shipped_config_puts_the_updater_behind_a_human(self):
        manual = load()["product"]["manual_review_paths"]
        for path in REQUIRED_MANUAL_REVIEW:
            self.assertIn(path, manual)


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
    def test_every_required_exclusion_is_enforced(self):
        for pattern in REQUIRED_EXCLUSIONS:
            config = load()
            config["product"]["excluded"] = [
                item for item in config["product"]["excluded"] if item != pattern
            ]
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
        self.assertTrue(len(verify({})) >= 5)

    def test_verification_does_not_mutate_the_config(self):
        config = load()
        before = copy.deepcopy(config)
        verify(config)
        self.assertEqual(config, before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
