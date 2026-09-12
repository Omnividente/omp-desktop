#!/usr/bin/env python3
"""Tests for build_jules_request.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_jules_request import build, dispatch_key, render_prompt  # noqa: E402

TASK = {
    "id": "auto-tsc-abc123",
    "title": "Fix TS2345 in clock.ts",
    "task_type": "bugfix",
    "status": "todo",
    "risk": "low",
    "evidence": {"source": "tsc", "detail": "TS2345 at src/clock.ts:42"},
}
TEMPLATE = (
    "Repo {{PROJECT_REPO}} branch {{INTEGRATION_BRANCH}} base {{BASE_COMMIT}}\n"
    "Task {{TASK_ID}}: {{TASK_TITLE}} ({{TASK_TYPE}})\n"
    "Focus {{FOCUS}} ceiling {{RISK_CEILING}}\n{{TASK_JSON}}"
)


def make(**overrides):
    kwargs = {
        "template": TEMPLATE,
        "repo": "Omnividente/omp-desktop",
        "branch": "autonomous/lab",
        "base_sha": "a" * 40,
        "focus": "quality",
        "risk_ceiling": "medium",
    }
    kwargs.update(overrides)
    return build(TASK, **kwargs)


class DispatchKeyTest(unittest.TestCase):
    """Reported defect: base_sha in the key produced duplicate sessions."""

    def test_key_is_stable_when_the_branch_moves(self):
        first = dispatch_key("Omnividente/omp-desktop", "auto-1")
        second = dispatch_key("Omnividente/omp-desktop", "auto-1")
        self.assertEqual(first, second)

    def test_request_key_does_not_depend_on_the_base_commit(self):
        one = make(base_sha="a" * 40)["title"]
        two = make(base_sha="b" * 40)["title"]
        self.assertEqual(one, two)

    def test_different_tasks_get_different_keys(self):
        self.assertNotEqual(dispatch_key("r", "auto-1"), dispatch_key("r", "auto-2"))

    def test_different_repositories_get_different_keys(self):
        self.assertNotEqual(dispatch_key("r1", "auto-1"), dispatch_key("r2", "auto-1"))

    def test_key_is_short_and_hex(self):
        key = dispatch_key("r", "auto-1")
        self.assertEqual(len(key), 24)
        self.assertTrue(all(c in "0123456789abcdef" for c in key))


class BuildTest(unittest.TestCase):
    def test_both_markers_are_present_for_reconciliation_and_lifecycle(self):
        body = make()
        key = dispatch_key("Omnividente/omp-desktop", TASK["id"])
        self.assertIn("AUTONOMOUS_DISPATCH_KEY: " + key, body["prompt"])
        self.assertIn("AUTONOMOUS_TASK_ID: " + TASK["id"], body["prompt"])
        self.assertIn("[dispatch:" + key + "]", body["title"])

    def test_worker_still_learns_the_base_commit_as_context(self):
        self.assertIn("a" * 40, make()["prompt"])

    def test_source_context_points_at_the_integration_branch(self):
        body = make()
        self.assertEqual(body["sourceContext"]["source"], "sources/github/Omnividente/omp-desktop")
        self.assertEqual(
            body["sourceContext"]["githubRepoContext"]["startingBranch"], "autonomous/lab"
        )

    def test_pull_request_creation_is_automatic_and_unattended(self):
        body = make()
        self.assertEqual(body["automationMode"], "AUTO_CREATE_PR")
        self.assertFalse(body["requirePlanApproval"])

    def test_title_is_capped_for_the_api(self):
        long_task = dict(TASK)
        long_task["title"] = "x" * 500
        body = build(
            long_task, template=TEMPLATE, repo="r", branch="b", base_sha="s",
        )
        self.assertLessEqual(len(body["title"]), 200)

    def test_placeholders_are_all_substituted(self):
        prompt = make()["prompt"]
        self.assertNotIn("{{", prompt)
        self.assertIn("Fix TS2345 in clock.ts", prompt)
        self.assertIn("quality", prompt)

    def test_task_json_travels_with_the_prompt(self):
        self.assertIn("TS2345 at src/clock.ts:42", make()["prompt"])


class RenderPromptTest(unittest.TestCase):
    def test_unknown_placeholders_are_left_alone(self):
        self.assertEqual(render_prompt("a {{B}} c", {"X": "1"}), "a {{B}} c")

    def test_repeated_placeholders_are_all_replaced(self):
        self.assertEqual(render_prompt("{{A}}-{{A}}", {"A": "z"}), "z-z")


if __name__ == "__main__":
    unittest.main(verbosity=2)
