#!/usr/bin/env python3
"""Research scheduling, manual implementation and unresolved lane boundaries."""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from select_task import blocks_lane, is_unresolved, select, valid_research_detachment


def manifest(*tasks, max_attempts: int = 2) -> dict:
    return {"version": 2, "autonomous_loop_policy": {"lifecycle": {"max_attempts": max_attempts}},
            "tasks": list(tasks)}


def task(task_id: str, **overrides) -> dict:
    base = {"id": task_id, "title": "work on " + task_id, "task_type": "project_discovery",
            "status": "todo", "priority": 40, "risk": "low", "focus": ["quality"],
            "created_at": "2026-09-01T00:00:00Z", "evidence": {"source": "fixture", "detail": "Observed behavior"}}
    base.update(overrides)
    return base


def approval(**overrides):
    value = {"action": "approve", "actor": "maintainer", "at": "2026-09-13T12:00:00Z", "note": "Implement this finding"}
    value.update(overrides)
    return value


def detached():
    return task("waiting", status="in_progress", research={"area_id": "terminal", "perspective_id": "behavior"},
                execution={"attempts": 1, "state": "dispatched", "session_id": "123", "dispatch_key": "attempt-one",
                           "starting_branch": "autonomous/attempt-attempt-one", "base_sha": "a" * 40,
                           "session_state": "AWAITING_USER_FEEDBACK",
                           "research_detached": {"at": "2026-09-13T12:00:00Z", "reason": "AWAITING_USER_FEEDBACK"}})


class SelectionTest(unittest.TestCase):
    def test_proposals_are_never_scheduled_even_after_approval(self):
        for decision in (None, approval()):
            with self.subTest(decision=decision):
                proposal = task("fix", task_type="bugfix", proposal_decision=decision)
                self.assertFalse(select(manifest(proposal))["selected"])
                self.assertEqual(select(manifest(proposal, task("research")))["task_id"], "research")

    def test_explicit_implementation_requires_persisted_human_decision_not_flags(self):
        proposal = task("fix", task_type="bugfix", approved=True, auto_implement=True)
        for decision in (None, approval(action="reject"), approval(actor=" "), approval(note=""),
                         approval(at="2026-09-13T12:00:00")):
            with self.subTest(decision=decision):
                proposal["proposal_decision"] = decision
                self.assertFalse(select(manifest(proposal), task_id="fix")["selected"])
        proposal["proposal_decision"] = approval()
        self.assertTrue(select(manifest(proposal), task_id="fix")["selected"])
        for overrides, options in (({"risk": "high"}, {"risk_ceiling": "low"}),
                                   ({"execution": {"attempts": 2}}, {}),
                                   ({"status": "proposed"}, {}),
                                   ({}, {"excluded_task_ids": ["fix"]})):
            self.assertFalse(select(manifest({**proposal, **overrides}), task_id="fix", **options)["selected"])

    def test_each_lane_blocks_only_its_own_worker(self):
        implementation = task("fix", task_type="bugfix", proposal_decision=approval())
        research = task("research")
        active_impl = task("live", task_type="bugfix", status="in_progress",
                           execution={"session_state": "AWAITING_USER_FEEDBACK"})
        data = manifest(active_impl, implementation, research)
        before = copy.deepcopy(data)
        self.assertEqual(select(data)["task_id"], "research")
        self.assertFalse(select(data, task_id="fix")["selected"])
        self.assertEqual(data, before)
        active_research = task("live", status="in_progress")
        data = manifest(active_research, implementation, research)
        self.assertFalse(select(data)["selected"])
        self.assertEqual(select(data, task_id="fix")["task_id"], "fix")
        active_research.update(status="blocked", execution={"state": "quarantined"})
        self.assertFalse(select(data)["selected"])
        self.assertTrue(select(data, task_id="fix")["selected"])

    def test_awaiting_pr_never_blocks_research(self):
        waiting = task("review", task_type="bugfix", status="blocked",
                       execution={"state": "awaiting_review", "outcome": "review_required"})
        self.assertEqual(select(manifest(waiting, task("research")))["task_id"], "research")

    def test_detachment_frees_lane_but_not_attempt_or_scope_even_after_resume(self):
        waiting = detached()
        duplicate = task("duplicate", research={**waiting["research"], "fingerprint": "b" * 64})
        other = task("other", research={"area_id": "sessions", "perspective_id": "behavior"})
        data = manifest(waiting, duplicate, other)
        for state in ("AWAITING_USER_FEEDBACK", "IN_PROGRESS"):
            waiting["execution"]["session_state"] = state
            self.assertTrue(is_unresolved(waiting))
            self.assertFalse(blocks_lane(waiting, discovery=True))
            self.assertEqual(select(data)["task_id"], "other")
            self.assertFalse(select(data, task_id="waiting")["selected"])
            self.assertFalse(select(data, task_id="duplicate")["selected"])
        other.update(research={"area_id": "terminal", "perspective_id": "reliability"})
        self.assertEqual(select(data)["task_id"], "other")

    def test_invalid_detachment_never_frees_lane(self):
        for field, value in (("base_sha", "bad"), ("starting_branch", "autonomous/lab"),
                             ("session_id", ""), ("attempts", 0),
                             ("research_detached", {"at": "yesterday", "reason": "PAUSED"}),
                             ("research_detached", {"at": "2026-09-13T12:00:00Z", "reason": "UNKNOWN"})):
            with self.subTest(field=field):
                waiting = detached()
                waiting["execution"][field] = value
                self.assertFalse(valid_research_detachment(waiting))
                self.assertFalse(select(manifest(waiting, task("other")))["selected"])
        waiting = detached()
        waiting["task_type"] = "bugfix"
        self.assertFalse(valid_research_detachment(waiting))
        self.assertTrue(blocks_lane(waiting, discovery=False))

    def test_disabled_discovery_does_not_fall_back_to_implementation(self):
        data = manifest(task("research"), task("fix", task_type="bugfix", proposal_decision=approval()))
        self.assertFalse(select(data, allow_discovery=False)["selected"])
        self.assertFalse(select(data, task_id="research", allow_discovery=False)["selected"])
        self.assertTrue(select(data, task_id="fix", allow_discovery=False)["selected"])

    def test_research_filters_attempts_risk_focus_and_exclusions(self):
        data = manifest(task("exhausted", execution={"attempts": 2}), task("risky", risk="high"),
                        task("wrong-focus", focus=["a11y"]), task("excluded"), task("eligible"))
        result = select(data, focus=["quality"], risk_ceiling="low", excluded_task_ids=["excluded"])
        self.assertEqual(result["task_id"], "eligible")
        self.assertFalse(select(manifest(task("closed", status="done")))["selected"])
        self.assertEqual(select(data, task_id="missing")["reason_code"], "explicit_task_missing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
