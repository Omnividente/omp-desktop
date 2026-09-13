#!/usr/bin/env python3
"""Tests for check_change_scope.py."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_change_scope import evaluate, manual_review_hits  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]

CONFIG = {
    "product": {
        "editable_globs": ["src/**", "src-tauri/src/**", "src-tauri/tests/**"],
        "excluded": [
            ".github/workflows/**",
            "package.json",
            "src-tauri/tauri.conf.json",
            "scripts/autonomous/**",
            "**/*.png",
        ],
        "manual_review_paths": [
            "src/clientUpdater.ts",
            "src/useClientUpdater.ts",
            "src-tauri/src/updater*",
        ],
    }
}


class HardScopeTest(unittest.TestCase):
    def test_product_source_is_allowed(self):
        result = evaluate(CONFIG, ["src/clock.ts", "src-tauri/src/lib.rs"])
        self.assertTrue(result["allowed"])
        self.assertEqual(result["violations"], [])

    def test_release_workflow_is_blocked(self):
        result = evaluate(CONFIG, ["src/clock.ts", ".github/workflows/release-artifacts.yml"])
        self.assertFalse(result["allowed"])
        self.assertEqual(result["violations"][0]["reason"], "excluded")

    def test_version_files_are_blocked(self):
        for path in ("package.json", "src-tauri/tauri.conf.json"):
            self.assertFalse(evaluate(CONFIG, [path])["allowed"], path)

    def test_loop_cannot_edit_its_own_control_plane(self):
        result = evaluate(CONFIG, ["scripts/autonomous/select_task.py"])
        self.assertFalse(result["allowed"])

    def test_file_outside_the_editable_roots_is_blocked(self):
        result = evaluate(CONFIG, ["README.md"])
        self.assertEqual(result["violations"][0]["reason"], "outside_editable_scope")

    def test_binary_assets_are_blocked_anywhere(self):
        self.assertFalse(evaluate(CONFIG, ["src/assets/logo.png"])["allowed"])

    def test_empty_diff_is_vacuously_allowed(self):
        self.assertTrue(evaluate(CONFIG, [])["allowed"])

    def test_blank_lines_are_ignored(self):
        self.assertTrue(evaluate(CONFIG, ["", "   ", "src/clock.ts"])["allowed"])

    def test_nested_paths_match_star_patterns(self):
        self.assertTrue(evaluate(CONFIG, ["src/a/b/c/deep.ts"])["allowed"])


class ManualReviewTest(unittest.TestCase):
    """Reported defect: the auto-update sources were inside plain src/** scope."""

    def test_updater_sources_are_flagged_for_a_human(self):
        hits = manual_review_hits(CONFIG, ["src/clientUpdater.ts", "src/clock.ts"])
        self.assertEqual(hits, ["src/clientUpdater.ts"])

    def test_updater_hook_is_flagged(self):
        self.assertEqual(
            manual_review_hits(CONFIG, ["src/useClientUpdater.ts"]),
            ["src/useClientUpdater.ts"],
        )

    def test_rust_updater_prefix_is_flagged(self):
        self.assertEqual(
            manual_review_hits(CONFIG, ["src-tauri/src/updater_bridge.rs"]),
            ["src-tauri/src/updater_bridge.rs"],
        )

    def test_flagging_is_a_soft_block_not_a_hard_one(self):
        self.assertTrue(evaluate(CONFIG, ["src/clientUpdater.ts"])["allowed"])

    def test_ordinary_source_is_not_flagged(self):
        self.assertEqual(manual_review_hits(CONFIG, ["src/clock.ts"]), [])

    def test_missing_configuration_flags_nothing(self):
        self.assertEqual(manual_review_hits({"product": {}}, ["src/clientUpdater.ts"]), [])


class RealConfigTest(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(
            (REPO_ROOT / "autonomous-project.json").read_text(encoding="utf-8")
        )

    def test_every_updater_file_in_the_repository_needs_a_human(self):
        updater_files = [
            "src/clientUpdater.ts",
            "src/useClientUpdater.ts",
            "src/useClientUpdater.test.tsx",
            "src/ClientUpdateNotice.tsx",
            "src/UpdateNotice.tsx",
            "src/UpdateNotices.test.tsx",
            "src/updateReminder.ts",
            "src/updateReminder.test.ts",
            "src-tauri/src/update.rs",
            "src-tauri/tests/update.rs",
        ]
        hits = manual_review_hits(self.config, updater_files)
        self.assertEqual(sorted(hits), sorted(updater_files))

    def test_release_tooling_is_still_hard_blocked(self):
        for path in (
            ".github/workflows/promote-release.yml",
            ".github/scripts/verify-release-assets.mjs",
            "package.json",
            "src-tauri/Cargo.toml",
            "agent_tasks.json",
            "autonomous-project.json",
        ):
            self.assertFalse(evaluate(self.config, [path])["allowed"], path)

    def test_normal_product_work_is_still_permitted(self):
        self.assertTrue(
            evaluate(self.config, ["src/clock.ts", "src/clock.test.ts"])["allowed"]
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
