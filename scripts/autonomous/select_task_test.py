#!/usr/bin/env python3
"""Tests for select_task.py."""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from select_task import select  # noqa: E402


def manifest(*tasks, min_todo: int = 3, max_attempts: int = 2) -> dict:
    return {
        "version": 2,
        "autonomous_loop_policy": {
            "min_todo_tasks": min_todo,
            "lifecycle": {"max_attempts": max_attempts},
        },
        "tasks": list(tasks),
    }


def task(task_id: str, **overrides) -> dict:
    base = {
        "id": task_id,
        "title": "work on " + task_id,
        "task_type": "bugfix",
        "status": "todo",
        "priority": 40,
        "risk": "low",
        "focus": ["quality"],
        "created_at": "2026-09-01T00:00:00Z",
        "evidence": {"source": "tsc", "detail": "TS2345"},
    }
    base.update(overrides)
    return base


class DiscoveryPreemptionTest(unittest.TestCase):
    """The reported defect: discovery outranked real work and repeated forever."""

    def test_concrete_task_wins_even_when_discovery_has_higher_priority(self):
        data = manifest(
            task("project-discovery-0001", task_type="project_discovery", priority=100),
            task("auto-tsc-abc", priority=40),
        )
        result = select(data)
        self.assertTrue(result["selected"])
        self.assertEqual(result["task_id"], "auto-tsc-abc")
        self.assertEqual(result["reason_code"], "ready")
        self.assertTrue(result["deferred_discovery"])

    def test_discovery_runs_only_when_no_concrete_task_is_available(self):
        data = manifest(
            task("project-discovery-0001", task_type="project_discovery", priority=10),
        )
        result = select(data)
        self.assertTrue(result["selected"])
        self.assertEqual(result["task_id"], "project-discovery-0001")
        self.assertEqual(result["reason_code"], "ready_discovery")
        self.assertFalse(result["deferred_discovery"])

    def test_discovery_can_be_switched_off_entirely(self):
        data = manifest(task("d", task_type="project_discovery", priority=10))
        result = select(data, allow_discovery=False)
        self.assertFalse(result["selected"])
        self.assertEqual(result["reason_code"], "discovery_disabled")


class InFlightTest(unittest.TestCase):
    def test_nothing_is_selected_while_a_task_is_in_progress(self):
        data = manifest(task("auto-1", status="in_progress"), task("auto-2"))
        result = select(data)
        self.assertFalse(result["selected"])
        self.assertEqual(result["reason_code"], "work_in_progress")
        self.assertEqual(result["task_id"], "auto-1")


class EligibilityTest(unittest.TestCase):
    def test_priority_then_age_decides_between_concrete_tasks(self):
        data = manifest(
            task("low", priority=10),
            task("high", priority=70),
            task("mid", priority=40),
        )
        self.assertEqual(select(data)["task_id"], "high")

    def test_oldest_wins_a_priority_tie(self):
        data = manifest(
            task("newer", created_at="2026-09-05T00:00:00Z"),
            task("older", created_at="2026-09-01T00:00:00Z"),
        )
        self.assertEqual(select(data)["task_id"], "older")

    def test_risk_above_the_ceiling_is_skipped(self):
        data = manifest(task("risky", risk="high", priority=99), task("safe", risk="low"))
        self.assertEqual(select(data, risk_ceiling="medium")["task_id"], "safe")

    def test_focus_filter_narrows_the_queue(self):
        data = manifest(
            task("a11y-task", focus=["a11y"], priority=90),
            task("test-task", focus=["tests"], priority=10),
        )
        self.assertEqual(select(data, focus=["tests"])["task_id"], "test-task")

    def test_task_that_used_up_its_attempts_is_not_retried(self):
        data = manifest(
            task("exhausted", priority=90, execution={"attempts": 2}),
            task("fresh", priority=10),
            max_attempts=2,
        )
        self.assertEqual(select(data)["task_id"], "fresh")

    def test_explicitly_excluded_task_is_skipped(self):
        data = manifest(task("skip-me", priority=90), task("take-me", priority=10))
        result = select(data, excluded_task_ids=["skip-me"])
        self.assertEqual(result["task_id"], "take-me")

    def test_done_and_blocked_tasks_are_invisible(self):
        data = manifest(task("a", status="done"), task("b", status="blocked"))
        result = select(data)
        self.assertFalse(result["selected"])
        self.assertEqual(result["reason_code"], "no_todo_tasks")

    def test_no_eligible_task_is_distinguished_from_an_empty_queue(self):
        data = manifest(task("risky", risk="high"))
        result = select(data, risk_ceiling="low")
        self.assertFalse(result["selected"])
        self.assertEqual(result["reason_code"], "no_eligible_autonomous_task")


class ExplicitTaskTest(unittest.TestCase):
    def test_explicit_task_is_honoured(self):
        data = manifest(task("a", priority=90), task("b", priority=10))
        result = select(data, task_id="b")
        self.assertTrue(result["selected"])
        self.assertEqual(result["reason_code"], "explicit_task_selected")

    def test_explicit_missing_task_reports_clearly(self):
        result = select(manifest(task("a")), task_id="nope")
        self.assertEqual(result["reason_code"], "explicit_task_missing")

    def test_explicit_non_todo_task_is_refused(self):
        result = select(manifest(task("a", status="done")), task_id="a")
        self.assertEqual(result["reason_code"], "explicit_task_not_todo")

    def test_explicit_ineligible_task_is_refused(self):
        data = manifest(task("a", risk="high"))
        result = select(data, task_id="a", risk_ceiling="low")
        self.assertEqual(result["reason_code"], "explicit_task_ineligible")


class ReplenishmentTest(unittest.TestCase):
    def test_thin_queue_asks_for_replenishment(self):
        data = manifest(task("a"), min_todo=3)
        result = select(data)
        self.assertTrue(result["replenishment_required"])
        self.assertEqual(result["todo_count"], 1)

    def test_healthy_queue_does_not(self):
        data = manifest(task("a"), task("b"), task("c"), min_todo=3)
        self.assertFalse(select(data)["replenishment_required"])


class PurityTest(unittest.TestCase):
    def test_selection_never_mutates_the_manifest(self):
        data = manifest(task("a"))
        before = copy.deepcopy(data)
        select(data)
        self.assertEqual(data, before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
