#!/usr/bin/env python3
"""Tests for evidence_plan.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from evidence_plan import (  # noqa: E402
    MODE_MISSING_TEST, MODE_NO_SOURCE, MODE_PROOF_TS, MODE_UNSUPPORTED, explain, plan,
)

CONFIG = {
    "product": {
        "excluded": [".github/workflows/**", "package.json", "docs/autonomous/**"],
    },
    "merge_gate": {
        "test_globs": [
            "*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx", "src-tauri/tests/**",
        ],
    },
}


class PlanTest(unittest.TestCase):
    def test_source_change_with_a_test_is_provable(self):
        result = plan(CONFIG, ["src/clock.ts", "src/clock.test.ts"])
        self.assertEqual(result["mode"], MODE_PROOF_TS)
        self.assertTrue(result["proof_supported"])
        self.assertEqual(result["ts_test_files"], ["src/clock.test.ts"])
        self.assertEqual(result["source_files"], ["src/clock.ts"])

    def test_source_change_without_a_test_cannot_be_proven(self):
        """The reported defect: src/App.tsx alone was auto-merged."""
        result = plan(CONFIG, ["src/App.tsx"])
        self.assertEqual(result["mode"], MODE_MISSING_TEST)
        self.assertFalse(result["proof_supported"])

    def test_test_only_change_has_nothing_to_prove(self):
        result = plan(CONFIG, ["src/clock.test.ts"])
        self.assertEqual(result["mode"], MODE_NO_SOURCE)
        self.assertTrue(result["proof_supported"])

    def test_excluded_files_do_not_count_as_product_source(self):
        result = plan(CONFIG, ["docs/autonomous/RUNBOOK.md"])
        self.assertEqual(result["mode"], MODE_NO_SOURCE)

    def test_nested_test_files_are_recognised(self):
        result = plan(CONFIG, ["src/nested/deep/clock.ts", "src/nested/deep/clock.test.tsx"])
        self.assertEqual(result["mode"], MODE_PROOF_TS)

    def test_rust_source_needs_a_human_rather_than_a_fake_pass(self):
        result = plan(CONFIG, ["src-tauri/src/lib.rs", "src-tauri/tests/smoke.rs"])
        self.assertEqual(result["mode"], MODE_UNSUPPORTED)
        self.assertFalse(result["proof_supported"])
        self.assertIn("src-tauri/src/lib.rs", result["unsupported_paths"])

    def test_mixed_rust_and_typescript_is_not_silently_approved(self):
        result = plan(CONFIG, ["src/clock.ts", "src/clock.test.ts", "src-tauri/src/lib.rs"])
        self.assertEqual(result["mode"], MODE_UNSUPPORTED)

    def test_empty_diff_is_not_a_proof_request(self):
        self.assertEqual(plan(CONFIG, [])["mode"], MODE_NO_SOURCE)

    def test_blank_lines_are_ignored(self):
        result = plan(CONFIG, ["  ", "src/clock.ts", "", "src/clock.test.ts"])
        self.assertEqual(result["mode"], MODE_PROOF_TS)

    def test_defaults_apply_when_the_config_omits_test_globs(self):
        result = plan({"product": {}}, ["src/clock.ts", "src/clock.test.ts"])
        self.assertEqual(result["mode"], MODE_PROOF_TS)


class ExplainTest(unittest.TestCase):
    def test_every_mode_produces_a_readable_sentence(self):
        for changed in (
            ["src/clock.ts", "src/clock.test.ts"],
            ["src/App.tsx"],
            ["src/clock.test.ts"],
            ["src-tauri/src/lib.rs", "src-tauri/tests/smoke.rs"],
        ):
            text = explain(plan(CONFIG, changed))
            self.assertTrue(text.strip())
            self.assertNotIn("None", text)

    def test_unsupported_paths_are_named_in_the_explanation(self):
        text = explain(plan(CONFIG, ["src-tauri/src/lib.rs", "src-tauri/tests/smoke.rs"]))
        self.assertIn("src-tauri/src/lib.rs", text)

    def test_rust_change_without_any_test_is_reported_as_missing_test(self):
        self.assertEqual(plan(CONFIG, ["src-tauri/src/lib.rs"])["mode"], MODE_MISSING_TEST)


if __name__ == "__main__":
    unittest.main(verbosity=2)
