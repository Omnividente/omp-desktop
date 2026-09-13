#!/usr/bin/env python3
"""Tests for validate_tasks.py, including the shipped queue."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_tasks import validate  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPO_ROOT / "agent_tasks.json"


def task(task_id: str = "auto-1", **overrides) -> dict:
    base = {
        "id": task_id,
        "title": "Fix something specific",
        "task_type": "bugfix",
        "status": "todo",
        "priority": 40,
        "risk": "low",
        "focus": ["quality"],
        "evidence": {"source": "tsc", "detail": "TS2345 at src/clock.ts:42"},
    }
    base.update(overrides)
    return base


def manifest(*tasks, **policy) -> dict:
    loop_policy = {"integration_branch": "autonomous/lab"}
    loop_policy.update(policy)
    return {"version": 2, "autonomous_loop_policy": loop_policy, "tasks": list(tasks)}


class ShippedManifestTest(unittest.TestCase):
    def test_the_shipped_queue_is_valid(self):
        data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        self.assertEqual(validate(data), [])



class StructureTest(unittest.TestCase):
    def test_minimal_valid_manifest(self):
        self.assertEqual(validate(manifest(task())), [])

    def test_non_object_manifest_is_rejected(self):
        self.assertTrue(validate([]))

    def test_missing_version_is_rejected(self):
        data = manifest(task())
        data.pop("version")
        self.assertTrue(any("version" in e for e in validate(data)))

    def test_missing_policy_is_rejected(self):
        data = manifest(task())
        data.pop("autonomous_loop_policy")
        self.assertTrue(any("autonomous_loop_policy" in e for e in validate(data)))

    def test_tasks_must_be_a_list(self):
        data = manifest(task())
        data["tasks"] = {}
        self.assertTrue(any("tasks must be a list" in e for e in validate(data)))

    def test_duplicate_ids_are_rejected(self):
        self.assertTrue(any("duplicated" in e for e in validate(manifest(task(), task()))))

    def test_blank_title_is_rejected(self):
        self.assertTrue(any(".title" in e for e in validate(manifest(task(title="  ")))))

    def test_unknown_status_is_rejected(self):
        self.assertTrue(any(".status" in e for e in validate(manifest(task(status="maybe")))))

    def test_unknown_task_type_is_rejected(self):
        self.assertTrue(
            any(".task_type" in e for e in validate(manifest(task(task_type="vibes"))))
        )

    def test_unknown_risk_is_rejected(self):
        self.assertTrue(any(".risk" in e for e in validate(manifest(task(risk="spicy")))))

    def test_non_integer_priority_is_rejected(self):
        self.assertTrue(any(".priority" in e for e in validate(manifest(task(priority="40")))))


class EvidenceTest(unittest.TestCase):
    def test_evidence_is_mandatory(self):
        data = manifest(task())
        data["tasks"][0].pop("evidence")
        self.assertTrue(any(".evidence" in e for e in validate(data)))

    def test_evidence_source_is_mandatory(self):
        data = manifest(task(evidence={"detail": "something"}))
        self.assertTrue(any("evidence.source" in e for e in validate(data)))

    def test_evidence_detail_is_mandatory(self):
        data = manifest(task(evidence={"source": "tsc", "detail": "   "}))
        self.assertTrue(any("evidence.detail" in e for e in validate(data)))


class LifecycleTest(unittest.TestCase):
    def test_valid_execution_block_is_accepted(self):
        data = manifest(task(status="in_progress", execution={
            "attempts": 1, "state": "dispatched", "session_id": "sessions/1",
            "dispatch_key": "abc", "outcome": "", "pull_request": 0,
        }))
        self.assertEqual(validate(data), [])

    def test_unknown_outcome_is_rejected(self):
        data = manifest(task(execution={"outcome": "probably-fine"}))
        self.assertTrue(any("execution.outcome" in e for e in validate(data)))

    def test_unknown_execution_state_is_rejected(self):
        data = manifest(task(execution={"state": "thinking"}))
        self.assertTrue(any("execution.state" in e for e in validate(data)))

    def test_non_integer_attempts_is_rejected(self):
        data = manifest(task(execution={"attempts": "two"}))
        self.assertTrue(any("execution.attempts" in e for e in validate(data)))

    def test_non_integer_pull_request_is_rejected(self):
        data = manifest(task(execution={"pull_request": "53"}))
        self.assertTrue(any("execution.pull_request" in e for e in validate(data)))

    def test_execution_must_be_an_object(self):
        data = manifest(task(execution=[]))
        self.assertTrue(any("execution must be an object" in e for e in validate(data)))

    def test_two_tasks_in_progress_means_a_lost_transition(self):
        data = manifest(
            task("auto-1", status="in_progress"), task("auto-2", status="in_progress")
        )
        self.assertTrue(any("only one task may be in_progress" in e for e in validate(data)))

    def test_one_task_in_progress_is_fine(self):
        data = manifest(task("auto-1", status="in_progress"), task("auto-2"))
        self.assertEqual(validate(data), [])

    def test_negative_max_attempts_is_rejected(self):
        data = manifest(task(), lifecycle={"max_attempts": 0})
        self.assertTrue(any("max_attempts" in e for e in validate(data)))

    def test_non_integer_stale_window_is_rejected(self):
        data = manifest(task(), lifecycle={"stale_in_progress_hours": "six"})
        self.assertTrue(any("stale_in_progress_hours" in e for e in validate(data)))

    def test_lifecycle_must_be_an_object(self):
        data = manifest(task(), lifecycle=[])
        self.assertTrue(any("lifecycle must be an object" in e for e in validate(data)))


class ResearchSchemaTest(unittest.TestCase):
    def test_report_recovery_requires_bound_research_and_truthful_parked_state(self):
        execution = {"state": "awaiting_report", "outcome": "report_invalid", "attempts": 1,
                     "session_id": "7", "dispatch_key": "first", "pull_request": 0,
                     "report_error": {"code": "research_json", "detail": "invalid JSON",
                                      "reported_at": "2026-09-13T12:00:00Z"}}
        entry = task(task_type="project_discovery", status="blocked", execution=execution)
        self.assertEqual(validate(manifest(entry)), [])
        for field, value in (("session_id", ""), ("dispatch_key", ""), ("attempts", 0),
                             ("pull_request", 53), ("state", "retry"), ("outcome", "failed"),
                             ("report_error", {"code": "research_json"})):
            with self.subTest(field=field):
                invalid = copy.deepcopy(entry)
                invalid["execution"][field] = value
                self.assertTrue(validate(manifest(invalid)))
        for field, value in (("status", "todo"), ("task_type", "bugfix")):
            invalid = copy.deepcopy(entry)
            invalid[field] = value
            self.assertTrue(validate(manifest(invalid)))

    def research_task(self):
        return task(
            task_type="project_discovery", status="done",
            research={
                "area_id": "terminal-input", "perspective_id": "behavior",
                "fingerprint": "a" * 64, "cycle": 1, "previous_reports": [],
            },
            research_result={
                "summary": "Cancellation preserves state",
                "observations": [{"scenario": "Cancel input", "evidence": "Synthetic session transcript", "result": "No input lost"}],
                "next_hypotheses": ["Exercise concurrent cancellation"],
                "proposed_task_ids": [], "completed_at": "2026-09-13T12:00:00Z",
            },
            execution={"state": "completed", "outcome": "researched", "attempts": 1},
        )

    def test_completed_research_and_legacy_done_tasks_coexist(self):
        data = manifest(self.research_task(), task("legacy", status="done", execution={
            "state": "completed", "outcome": "no_change", "attempts": 1,
        }))
        self.assertEqual(validate(data), [])
        data["tasks"][0]["execution"]["outcome"] = "no_change"
        self.assertEqual(validate(data), [])

    def test_malformed_new_results_are_rejected(self):
        invalid = {
            "summary": " ", "observations": [{"scenario": "x", "evidence": 4, "result": "x"}],
            "next_hypotheses": "repeat", "proposed_task_ids": [3],
            "completed_at": "2026-09-13T12:00:00",
        }
        for field, value in invalid.items():
            entry = self.research_task()
            entry["research_result"][field] = value
            with self.subTest(field=field):
                self.assertTrue(any(field in error for error in validate(manifest(entry))))

    def test_completed_scheduled_research_cannot_omit_report(self):
        entry = self.research_task()
        del entry["research_result"]
        self.assertTrue(any("research_result" in error for error in validate(manifest(entry))))
        entry["execution"]["outcome"] = "no_change"
        self.assertTrue(any("research_result" in error for error in validate(manifest(entry))))

    def test_cycle_fingerprint_and_prior_context_are_validated(self):
        for field, value in (("cycle", True), ("cycle", 0), ("fingerprint", "commit-tip"),
                             ("previous_reports", [{}]), ("area_id", "")):
            entry = self.research_task()
            entry["research"][field] = value
            with self.subTest(field=field, value=value):
                self.assertTrue(any(field in error for error in validate(manifest(entry))))
        entry = self.research_task()
        report = copy.deepcopy(entry["research_result"])
        entry["research"]["previous_reports"] = [report]
        self.assertEqual(validate(manifest(entry)), [])
        entry["research"]["previous_reports"] = [report] * 4
        self.assertTrue(any("bounded" in error for error in validate(manifest(entry))))

    def test_deferred_review_requires_complete_truthful_state(self):
        entry = task(status="blocked", execution={
            "state": "awaiting_review", "outcome": "review_required", "pull_request": 53,
        })
        self.assertEqual(validate(manifest(entry)), [])
        entry["status"] = "in_progress"
        self.assertTrue(any("manual review" in error for error in validate(manifest(entry))))


if __name__ == "__main__":
    unittest.main(verbosity=2)
