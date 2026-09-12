#!/usr/bin/env python3
"""Tests for task_lifecycle.py - the queue must actually advance."""
from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import task_lifecycle as lifecycle  # noqa: E402

NOW = datetime(2026, 9, 12, 12, 0, 0, tzinfo=timezone.utc)


def manifest(*tasks, max_attempts: int = 2, stale_hours: int = 6) -> dict:
    return {
        "version": 2,
        "autonomous_loop_policy": {
            "lifecycle": {
                "max_attempts": max_attempts,
                "stale_in_progress_hours": stale_hours,
            }
        },
        "tasks": list(tasks),
    }


def task(task_id: str, **overrides) -> dict:
    base = {
        "id": task_id,
        "title": "fix " + task_id,
        "task_type": "bugfix",
        "status": "todo",
        "priority": 40,
        "risk": "low",
        "focus": ["quality"],
        "evidence": {"source": "tsc", "detail": "TS2345"},
    }
    base.update(overrides)
    return base


class StartTest(unittest.TestCase):
    def test_start_records_session_and_marks_in_progress(self):
        data = manifest(task("auto-1"))
        result = lifecycle.start(
            data, "auto-1", session_id="sessions/9", dispatch_key="abc123", now=NOW
        )
        self.assertTrue(result["changed"])
        self.assertEqual(result["attempts"], 1)
        entry = data["tasks"][0]
        self.assertEqual(entry["status"], "in_progress")
        self.assertEqual(entry["execution"]["session_id"], "sessions/9")
        self.assertEqual(entry["execution"]["dispatch_key"], "abc123")
        self.assertEqual(entry["execution"]["started_at"], "2026-09-12T12:00:00Z")

    def test_unknown_task_is_reported_not_invented(self):
        data = manifest(task("auto-1"))
        result = lifecycle.start(data, "nope", now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(result["reason"], "task_not_found")


class CloseFromPullRequestTest(unittest.TestCase):
    def test_merged_pull_request_closes_the_task(self):
        data = manifest(task("auto-1"))
        lifecycle.start(data, "auto-1", session_id="s1", dispatch_key="k1", now=NOW)
        result = lifecycle.close_from_pr(
            data, pull_request=77, title="[dispatch:k1] fix",
            body="AUTONOMOUS_TASK_ID: auto-1", merged=True, now=NOW,
        )
        self.assertEqual(result["matched_by"], "task_id_marker")
        self.assertEqual(data["tasks"][0]["status"], "done")
        self.assertEqual(data["tasks"][0]["execution"]["pull_request"], 77)
        self.assertEqual(data["tasks"][0]["execution"]["outcome"], "merged")

    def test_dispatch_key_in_title_is_enough_to_match(self):
        data = manifest(task("auto-1"))
        lifecycle.start(data, "auto-1", session_id="s1", dispatch_key="k9", now=NOW)
        result = lifecycle.close_from_pr(
            data, pull_request=5, title="[dispatch:k9] whatever", merged=True, now=NOW
        )
        self.assertEqual(result["matched_by"], "dispatch_key")
        self.assertEqual(data["tasks"][0]["status"], "done")

    def test_closed_without_merge_returns_task_to_the_queue(self):
        data = manifest(task("auto-1"))
        lifecycle.start(data, "auto-1", now=NOW)
        lifecycle.close_from_pr(data, pull_request=8, title="x", merged=False, now=NOW)
        self.assertEqual(data["tasks"][0]["status"], "todo")
        self.assertEqual(data["tasks"][0]["execution"]["attempts"], 1)

    def test_task_is_blocked_once_attempts_are_exhausted(self):
        data = manifest(task("auto-1"), max_attempts=2)
        lifecycle.start(data, "auto-1", now=NOW)
        lifecycle.close_from_pr(data, pull_request=8, title="x", merged=False, now=NOW)
        lifecycle.start(data, "auto-1", now=NOW)
        lifecycle.close_from_pr(data, pull_request=9, title="x", merged=False, now=NOW)
        self.assertEqual(data["tasks"][0]["status"], "blocked")
        self.assertEqual(data["tasks"][0]["execution"]["state"], "exhausted")

    def test_unrelated_pull_request_changes_nothing(self):
        data = manifest(task("auto-1"), task("auto-2"))
        result = lifecycle.close_from_pr(
            data, pull_request=1, title="chore: unrelated", merged=True, now=NOW
        )
        self.assertFalse(result["changed"])
        self.assertEqual(result["reason"], "no_matching_task")
        self.assertEqual(data["tasks"][0]["status"], "todo")


class CompleteTest(unittest.TestCase):
    def test_worker_finishing_with_no_change_frees_the_task(self):
        data = manifest(task("auto-1"))
        lifecycle.start(data, "auto-1", now=NOW)
        result = lifecycle.complete(
            data, "auto-1", outcome="no_change", note="session ended without a PR", now=NOW
        )
        self.assertTrue(result["changed"])
        self.assertEqual(data["tasks"][0]["status"], "todo")
        self.assertEqual(data["tasks"][0]["execution"]["outcome"], "no_change")

    def test_invalid_outcome_is_rejected(self):
        data = manifest(task("auto-1"))
        with self.assertRaises(ValueError):
            lifecycle.complete(data, "auto-1", outcome="probably-fine", now=NOW)


class ReconcileTest(unittest.TestCase):
    def test_stale_in_progress_task_is_released(self):
        data = manifest(task("auto-1"), stale_hours=6)
        lifecycle.start(data, "auto-1", now=NOW - timedelta(hours=9))
        result = lifecycle.reconcile(data, now=NOW)
        self.assertTrue(result["changed"])
        self.assertEqual(data["tasks"][0]["status"], "todo")
        self.assertEqual(data["tasks"][0]["execution"]["outcome"], "stale")

    def test_fresh_in_progress_task_is_left_alone(self):
        data = manifest(task("auto-1"), stale_hours=6)
        lifecycle.start(data, "auto-1", now=NOW - timedelta(hours=1))
        result = lifecycle.reconcile(data, now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(data["tasks"][0]["status"], "in_progress")


class RegressionTest(unittest.TestCase):
    def test_finished_work_is_never_handed_out_again(self):
        """The reported defect: a completed task stayed selectable forever."""
        import select_task

        data = manifest(task("auto-1"))
        lifecycle.start(data, "auto-1", session_id="s", dispatch_key="k", now=NOW)
        lifecycle.close_from_pr(
            data, pull_request=3, body="AUTONOMOUS_TASK_ID: auto-1", merged=True, now=NOW
        )
        self.assertEqual(data["tasks"][0]["status"], "done")
        self.assertFalse(select_task.select(data)["selected"])

    def test_queue_counts_are_reported(self):
        data = manifest(task("auto-1"), task("auto-2", status="done"))
        self.assertEqual(lifecycle.counts(data)["todo"], 1)
        self.assertEqual(lifecycle.counts(data)["done"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
