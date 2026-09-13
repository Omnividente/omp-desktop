#!/usr/bin/env python3
"""Tests for build_jules_request.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_jules_request import build, dispatch_key, render_prompt  # noqa: E402
from jules_dispatch import extract_key
from task_lifecycle import complete, reconcile, start
from datetime import datetime, timedelta, timezone

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

    def test_request_key_does_not_depend_on_the_base_commit(self):
        one = make(base_sha="a" * 40)["title"]
        two = make(base_sha="b" * 40)["title"]
        self.assertEqual(one, two)

    def test_different_tasks_get_different_keys(self):
        self.assertNotEqual(dispatch_key("r", "auto-1"), dispatch_key("r", "auto-2"))

    def test_different_repositories_get_different_keys(self):
        self.assertNotEqual(dispatch_key("r1", "auto-1"), dispatch_key("r2", "auto-1"))

    def test_retry_changes_identity_but_reconciliation_does_not(self):
        now = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)
        for outcome in ("failed",):
            with self.subTest(outcome=outcome):
                data = {"tasks": [dict(TASK)]}
                item = data["tasks"][0]
                def request_key():
                    return extract_key(build(item, template=TEMPLATE, repo="r",
                                             branch="b", base_sha="s")["prompt"])
                first = request_key()
                start(data, item["id"], session_id="1", dispatch_key=first, now=now)
                self.assertEqual(request_key(), first)
                start(data, item["id"], session_id="1", dispatch_key=first, now=now)
                if outcome == "stale":
                    reconcile(data, now=now + timedelta(hours=7))
                else:
                    complete(data, item["id"], outcome=outcome, now=now)
                second = request_key()
                self.assertNotEqual(first, second)
                start(data, item["id"], session_id="2", dispatch_key=second, now=now)
                complete(data, item["id"], outcome="failed", now=now)
                self.assertEqual(item["status"], "blocked")
                self.assertEqual(item["execution"]["attempts"], 2)

    def test_no_change_finishes_instead_of_scheduling_another_attempt(self):
        data = {"tasks": [dict(TASK)]}
        key = dispatch_key("r", TASK["id"])
        start(data, TASK["id"], session_id="1", dispatch_key=key)
        complete(data, TASK["id"], outcome="no_change")
        self.assertEqual(data["tasks"][0]["status"], "done")
        with self.assertRaises(ValueError):
            start(data, TASK["id"], session_id="2", dispatch_key="next")

    def test_quarantine_and_decline_do_not_generate_a_new_attempt_identity(self):
        now = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)
        for outcome in ("closed_unmerged", "stale"):
            data = {"tasks": [dict(TASK)]}
            first = extract_key(build(data["tasks"][0], template=TEMPLATE, repo="r", branch="lab", base_sha="s")["prompt"])
            start(data, TASK["id"], session_id="7", dispatch_key=first, now=now)
            complete(data, TASK["id"], outcome=outcome, now=now)
            body = build(data["tasks"][0], template=TEMPLATE, repo="r", branch="lab", base_sha="s")
            self.assertEqual(extract_key(body["prompt"]), first)
            with self.assertRaises(ValueError):
                start(data, TASK["id"], session_id="8", dispatch_key="next")


class BuildTest(unittest.TestCase):
    def test_immutable_source_does_not_change_proposal_target(self):
        body = make(starting_branch="autonomous/attempt-first")
        self.assertEqual(body["sourceContext"]["githubRepoContext"]["startingBranch"], "autonomous/attempt-first")
        self.assertIn("branch autonomous/lab", body["prompt"])
        self.assertEqual(extract_key(body["prompt"]), extract_key(make()["prompt"]))

    def test_only_implementation_sessions_create_pull_requests(self):
        discovery = build(dict(TASK, task_type="project_discovery"), template=TEMPLATE,
                          repo="r", branch="lab", base_sha="s")
        self.assertNotIn("automationMode", discovery)
        self.assertFalse(discovery["requirePlanApproval"])
        implementation = make()
        self.assertEqual(implementation["automationMode"], "AUTO_CREATE_PR")
        self.assertFalse(implementation["requirePlanApproval"])

    def test_title_is_capped_for_the_api(self):
        long_task = dict(TASK)
        long_task["title"] = "x" * 500
        body = build(
            long_task, template=TEMPLATE, repo="r", branch="b", base_sha="s",
        )
        self.assertLessEqual(len(body["title"]), 200)


    def test_repeated_placeholders_are_all_replaced(self):
        self.assertEqual(render_prompt("{{A}}-{{A}}", {"A": "z"}), "z-z")


if __name__ == "__main__":
    unittest.main(verbosity=2)
