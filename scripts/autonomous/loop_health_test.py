#!/usr/bin/env python3
"""Controller decisions from queue, Git ancestry and actual Actions activity."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from loop_health import assess_health, main, workflow_runs
from research_cycle import plan_research
from select_task import select
from health_snapshot import inspect_health, snapshot_proposals, snapshot_runs
from urllib.parse import parse_qs, urlsplit

NOW = datetime(2026, 9, 13, 12, tzinfo=timezone.utc)
MAIN = "a" * 40
LAB = "b" * 40


def settings():
    return {
        "default_branch": "main", "risk_ceiling": "medium",
        "repository": "owner/repo",
        "automation": {"blocking_labels": ["human-review", "hold"]},
        "product": {"editable_globs": ["src/**"], "excluded": [], "manual_review_paths": []},
        "research": {
            "enabled": True, "revisit_after_hours": 24, "max_sessions_per_day": 24,
            "areas": [{"id": "terminal", "title": "Terminal", "paths": ["src/terminal.ts"]}],
            "perspectives": [{"id": "behavior", "title": "Behavior", "focus": ["quality"],
                              "instruction": "Observe one isolated scenario."}],
        },
    }


def queue(*tasks):
    return {"version": 2, "autonomous_loop_policy": {"lifecycle": {"max_attempts": 2}}, "tasks": list(tasks)}


def task(**overrides):
    result = {"id": "fix", "title": "Fix observed behavior", "task_type": "bugfix", "status": "todo",
              "risk": "low", "priority": 40, "focus": ["quality"],
              "evidence": {"source": "reproduction", "detail": "Isolated fixture loses a session"}}
    result.update(overrides)
    return result


def proposal():
    pr = {"number": 9, "html_url": "https://github.com/owner/repo/pull/9", "state": "open",
          "updated_at": NOW.isoformat(), "base": {"ref": "autonomous/lab", "sha": LAB, "repo": {"full_name": "owner/repo"}},
          "head": {"ref": "fix-proposal", "sha": "d" * 40, "repo": {"full_name": "owner/repo"}}}
    execution = {"state": "awaiting_review", "outcome": "review_required", "session_id": "123",
                 "dispatch_key": "attempt-one", "attempts": 1, "pull_request": 9,
                 "started_at": NOW.isoformat(), "finished_at": NOW.isoformat()}
    execution["provenance"] = {"session_id": "123", "dispatch_key": "attempt-one", "pull_request": 9,
                               "url": pr["html_url"], "repository": "owner/repo", "base_branch": "autonomous/lab",
                               "head_repository": "owner/repo", "head_ref": "fix-proposal", "head_sha": "d" * 40,
                               "verified_at": NOW.isoformat()}
    return task(status="blocked", execution=execution), pr


def run(at=NOW, **overrides):
    value = {"id": 1, "head_branch": "main", "event": "workflow_dispatch", "status": "completed",
             "conclusion": "success", "updated_at": at.isoformat(), "head_sha": MAIN}
    value.update(overrides)
    return value


def health(data=None, config=None, **overrides):
    arguments = dict(main_sha=MAIN, lab_sha=LAB, main_is_ancestor=True,
                     fingerprints={"terminal": "c" * 64}, runs=[run()], sync_runs=[],
                     pull_requests=[], enabled=True, now=NOW)
    arguments.update(overrides)
    return assess_health(data if data is not None else queue(), config or settings(), **arguments)


class DecisionTest(unittest.TestCase):
    def test_disabled_never_wakes_even_with_due_work_and_stale_base(self):
        result = health(queue(task()), enabled=False, main_is_ancestor=False, runs=[])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("disabled", "none", "loop_disabled"))

    def test_due_work_uses_useful_tick_not_empty_completion(self):
        old = NOW - timedelta(minutes=91)
        data = queue(task(task_type="project_discovery", created_at=NOW.isoformat()))
        data["controller"] = {"last_tick_at": old.isoformat(), "run_id": "7"}
        result = health(data, runs=[run(old, id=7), run(id=8), run(id=9, head_branch="feature/untrusted")])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("stalled", "next_task", "work_due"))
        self.assertEqual(result["last_next_task"]["id"], 8)
        self.assertEqual(result["scheduler"]["overdue_seconds"], 91 * 60)
        self.assertEqual(result["scheduler"]["state"], "overdue")
        data["controller"]["last_tick_at"] = (NOW - timedelta(minutes=90)).isoformat()
        self.assertEqual(health(data)["health"], "ok")
        self.assertEqual(health(queue(task()), runs=[])["health"], "stalled")
        stuck = health(queue(task()), runs=[run(NOW - timedelta(hours=2), status="queued", conclusion=None)])
        self.assertEqual((stuck["health"], stuck["action"]), ("stalled", "none"))

    def test_empty_queue_is_due_only_when_real_research_planner_allows_it(self):
        result = health(runs=[])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("stalled", "next_task", "research_due"))
        config = settings()
        data, _ = plan_research(queue(), config, {"terminal": "c" * 64}, now=NOW)
        data["tasks"][0].update(status="done", execution={"state": "completed", "outcome": "no_change", "finished_at": NOW.isoformat()})
        data["tasks"][0]["research_result"] = {
            "summary": "No defect observed", "completed_at": NOW.isoformat(),
            "observations": [{"scenario": "Reopen", "evidence": "Synthetic fixture", "result": "State preserved"}],
            "next_hypotheses": ["Try concurrent cancellation"], "proposed_task_ids": [],
        }
        before = copy.deepcopy(data)
        result = health(data, config, runs=[])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("ok", "none", "cooldown"))
        self.assertEqual(result["research_next_at"], "2026-09-14T12:00:00Z")
        self.assertEqual((result["due_at"], result["delay_seconds"], result["scheduler"]["state"]),
                         ("2026-09-14T12:00:00Z", 86400, "waiting"))
        self.assertEqual(data, before)
        config["research"]["max_sessions_per_day"] = 1
        self.assertEqual(health(data, config)["reason"], "daily_cap")

    def test_waiting_proposal_and_foreign_pr_do_not_block_sync_or_research(self):
        pending, pr = proposal()
        data = queue(pending)
        result = health(data, pull_requests=[pr], main_is_ancestor=False, runs=[])
        self.assertEqual(result["action"], "sync")
        self.assertTrue(result["proposals"][0]["awaiting_human"])
        self.assertEqual(health(data, pull_requests=[pr])["action"], "next_task")
        pr["head"]["repo"]["full_name"] = "foreign/repo"
        result = health(data, pull_requests=[pr], main_is_ancestor=False)
        self.assertEqual(result["action"], "sync")
        self.assertEqual(result["proposals"], [])

    def test_active_bound_worker_polls_old_base_without_dispatching_new_attempt(self):
        data = queue(task(status="in_progress", execution={"state": "dispatched", "session_id": "123", "dispatch_key": "attempt-one", "attempts": 1, "started_at": NOW.isoformat()}))
        before = copy.deepcopy(data)
        failed = run(conclusion="failure", display_title="Sync main " + MAIN)
        result = health(data, main_is_ancestor=False, sync_runs=[failed])
        self.assertEqual((result["health"], result["action"], result["reason"], result["delay_seconds"]),
                         ("attention", "none", "active_polling", 1800))
        self.assertEqual(data, before)
        data["tasks"][0]["execution"].pop("session_id")
        self.assertEqual(health(data, main_is_ancestor=False)["action"], "none")

    def test_immutable_implementation_can_sync_and_quarantine_does_not_block_research(self):
        execution = {"state": "dispatched", "session_id": "123", "dispatch_key": "attempt-one",
                     "attempts": 1, "started_at": NOW.isoformat(), "base_sha": LAB,
                     "starting_branch": "autonomous/attempt-attempt-one"}
        data = queue(task(status="in_progress", execution=execution))
        self.assertEqual(health(data, main_is_ancestor=False)["action"], "sync")
        data["tasks"][0]["status"] = "blocked"
        execution.update(state="quarantined", outcome="stale")
        data["tasks"].append(task(id="other"))
        result = health(data)
        self.assertEqual((result["health"], result["action"], result["reason"]), ("attention", "next_task", "research_due"))
        self.assertEqual(health(data, main_is_ancestor=False)["action"], "sync")

    def test_migrated_legacy_quarantine_is_reconciled_before_sync(self):
        data = queue(task(status="blocked", execution={"state": "quarantined", "session_id": "123",
                     "dispatch_key": "legacy-attempt", "attempts": 1, "started_at": NOW.isoformat(), "outcome": "stale"}))
        before = copy.deepcopy(data)
        result = health(data, main_is_ancestor=False)
        self.assertEqual((result["action"], result["reason"], result["delay_seconds"]),
                         ("none", "legacy_worker_reconciliation", 1800))
        self.assertEqual(data, before)

    def test_live_controller_runs_make_wakeups_idempotent(self):
        for status in ("queued", "in_progress", "pending", "waiting", "requested"):
            with self.subTest(status=status):
                self.assertEqual(health(queue(task()), runs=[run(status=status, conclusion=None)])["action"], "none")
                result = health(main_is_ancestor=False, sync_runs=[run(status=status, conclusion=None)])
                self.assertEqual((result["action"], result["reason"]), ("none", "sync_running"))

    def test_same_main_failed_sync_stops_automatic_retries_but_new_revision_can_sync(self):
        failed = run(conclusion="failure", display_title="Sync main " + MAIN, head_sha="d" * 40)
        result = health(main_is_ancestor=False, sync_runs=[failed])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("attention", "none", "sync_failed"))
        self.assertEqual(result["attention"][0]["run"]["conclusion"], "failure")
        self.assertIsNone(result["due_at"])
        self.assertEqual((result["delay_seconds"], result["scheduler"]["state"]), (0, "blocked"))
        result = health(main_is_ancestor=False, main_sha="e" * 40, sync_runs=[failed])
        self.assertEqual((result["action"], result["reason"]), ("sync", "sync_required"))
        result = health(main_is_ancestor=True, sync_runs=[failed])
        self.assertEqual((result["health"], result["action"]), ("stalled", "next_task"))

    def test_successful_manual_sync_supersedes_failure_for_same_revision(self):
        failed = run(NOW - timedelta(hours=1), conclusion="failure", display_title="Sync main " + MAIN)
        fixed = run(id=2, display_title="Sync main " + MAIN)
        result = health(main_is_ancestor=False, sync_runs=[fixed, failed])
        self.assertEqual((result["health"], result["action"]), ("ok", "sync"))

    def test_parked_malformed_report_is_visible_but_unrelated_work_can_run(self):
        data, _ = plan_research(queue(), settings(), {"terminal": "c" * 64}, now=NOW)
        data["tasks"][0].update(status="blocked", execution={
            "state": "awaiting_report", "outcome": "report_invalid", "attempts": 1,
            "session_id": "123", "dispatch_key": "attempt-one", "started_at": NOW.isoformat(),
            "report_error": {"code": "research_invalid", "detail": "PRIVATE_WORKER_PROSE secret=never-print", "reported_at": NOW.isoformat()},
        })
        data["tasks"].append(task(task_type="project_discovery"))
        result = health(data)
        self.assertEqual((result["health"], result["action"], result["reason"]), ("attention", "next_task", "work_due"))
        self.assertEqual(result["attention"], [{"reason": "report_invalid", "task_id": data["tasks"][0]["id"], "observed_at": "2026-09-13T12:00:00Z"}])
        self.assertNotIn("PRIVATE_WORKER_PROSE", json.dumps(result))
        self.assertNotIn("attempt-one", json.dumps(result))
        self.assertNotIn("never-print", json.dumps(result))

    def test_pending_report_repair_is_polled_without_occupying_implementation_lane(self):
        data, _ = plan_research(queue(), settings(), {"terminal": "c" * 64}, now=NOW)
        data["tasks"][0].update(status="blocked", execution={
            "state": "awaiting_report", "outcome": "report_invalid", "attempts": 1,
            "session_id": "123", "dispatch_key": "attempt-one", "started_at": NOW.isoformat(),
            "session_state": "COMPLETED",
            "report_error": {"code": "research_invalid", "detail": "unmarked report", "reported_at": NOW.isoformat()},
            "report_repair": {"at": NOW.isoformat(), "result": "unknown", "status": "pending"},
        })
        data["controller"] = {"last_poll_at": NOW.isoformat()}
        result = health(data)
        self.assertEqual((result["action"], result["delay_seconds"]), ("none", 300))
        due = health(data, now=NOW + timedelta(minutes=5))
        self.assertEqual((due["action"], due["reason"]), ("next_task", "active_polling"))
        self.assertEqual(due["attention"][0]["repair_status"], "pending")
        self.assertEqual(health(data, enabled=False)["action"], "none")
        data["tasks"].append(task(proposal_decision={"action": "approve", "actor": "owner",
                              "at": NOW.isoformat(), "note": "Explicit implementation approval"}))
        self.assertTrue(select(data, task_id="fix")["selected"])
        self.assertEqual(health(data)["action"], "none")

    def test_completed_verified_pr_requires_reconciliation_without_mutating_queue(self):
        pending, pr = proposal()
        data = queue(pending)
        before = copy.deepcopy(data)
        pr.update(state="closed", merged_at=NOW.isoformat())
        result = health(data, main_is_ancestor=False, pull_requests=[pr])
        self.assertEqual((result["action"], result["reason"]), ("next_task", "reconciliation_due"))
        self.assertEqual(data, before)

    def test_machine_outcome_and_stale_proposal_are_not_masked_by_green_runs(self):
        pending, pr = proposal()
        pr["mergeable"] = False
        result = health(queue(pending, task(id="other")), pull_requests=[pr], state_sha="e" * 40,
                        sync_result={"main_sha": MAIN, "status": "prepared", "publication": "published",
                                     "refresh": {"outcome": "attention", "proposals": [{"pull_request": 9, "outcome": "refresh_conflict"}]}})
        self.assertEqual((result["health"], result["action"]), ("attention", "next_task"))
        self.assertEqual((result["code_sha"], result["state_sha"]), (LAB, "e" * 40))
        self.assertIn("proposal_conflict", {entry["reason"] for entry in result["attention"]})
        self.assertIn("proposal_refresh_attention", {entry["reason"] for entry in result["attention"]})

    def test_workflow_runs_accepts_rest_envelope_and_array(self):
        self.assertEqual(health(runs=workflow_runs({"workflow_runs": [run()]}))["action"], "next_task")
        self.assertEqual(health(runs=workflow_runs([run()]))["action"], "next_task")
        with self.assertRaises(ValueError):
            workflow_runs({"unrelated": []})

    def test_durable_poll_anchors_unchanged_worker_not_duplicate_completions(self):
        old = NOW - timedelta(hours=2)
        data = queue(task(task_type="project_discovery", status="in_progress", execution={"state": "dispatched", "session_id": "123",
                     "dispatch_key": "attempt-one", "attempts": 1, "started_at": old.isoformat(),
                     "observed_at": old.isoformat(), "session_state": "IN_PROGRESS"}))
        data["controller"] = {"last_poll_at": (NOW - timedelta(minutes=1)).isoformat()}
        recent = [run(NOW - timedelta(minutes=1)), run(id=2), run(id=3, conclusion="skipped")]
        result = health(data, runs=recent)
        self.assertEqual((result["action"], result["delay_seconds"], result["due_at"]),
                         ("none", 14 * 60, "2026-09-13T12:14:00Z"))
        self.assertEqual(health(data, runs=recent, now=NOW + timedelta(minutes=14))["action"], "next_task")
        data["tasks"][0]["execution"].update(observed_at=NOW.isoformat())
        resumed = health(data, runs=recent)
        self.assertEqual((resumed["action"], resumed["due_at"]), ("none", "2026-09-13T12:05:00Z"))
        self.assertEqual(health(data, runs=recent, now=NOW + timedelta(minutes=5))["action"], "next_task")
        del data["controller"]
        data["tasks"][0]["execution"]["observed_at"] = old.isoformat()
        legacy = health(data, runs=recent)
        self.assertEqual((legacy["action"], legacy["due_at"]), ("next_task", "2026-09-13T10:15:00Z"))
        self.assertEqual(legacy["scheduler"]["overdue_seconds"], 105 * 60)

    def test_human_wait_keeps_identity_and_thirty_minute_cadence_without_false_failure(self):
        for state, reason in (("AWAITING_USER_FEEDBACK", "worker_awaiting_feedback"),
                              ("AWAITING_PLAN_APPROVAL", "worker_awaiting_approval"),
                              ("PAUSED", "worker_paused")):
            with self.subTest(state=state):
                old = (NOW - timedelta(days=2)).isoformat()
                data = queue(task(status="in_progress", execution={"state": "dispatched", "session_id": "123",
                             "dispatch_key": "attempt-one", "attempts": 1, "started_at": old,
                             "observed_at": old, "session_state": state}))
                config = settings()
                config["research"]["enabled"] = False
                data["controller"] = {"last_tick_at": NOW.isoformat()}
                result = health(data, config)
                self.assertEqual((result["action"], result["reason"], result["due_at"]),
                                 ("none", reason, "2026-09-13T12:30:00Z"))
                self.assertEqual(result["waiting_workers"][0]["session_url"], "https://jules.google.com/session/123")
                self.assertEqual(result["waiting_workers"][0]["task_id"], "fix")
                del data["controller"]
                overdue = health(data, config, runs=[run(NOW - timedelta(hours=3))])
                self.assertEqual((overdue["health"], overdue["action"], overdue["reason"]),
                                 ("ok", "next_task", reason))
                self.assertEqual(overdue["attention"], [])

    def test_recent_completion_frees_slot_for_immediate_useful_work(self):
        finished = task(status="done", execution={"state": "completed", "outcome": "no_change",
                        "session_id": "123", "dispatch_key": "attempt-one", "attempts": 1,
                        "session_state": "COMPLETED", "finished_at": NOW.isoformat()})
        result = health(queue(finished, task(id="next", task_type="project_discovery")), runs=[run()])
        self.assertEqual((result["action"], result["reason"], result["delay_seconds"]),
                         ("next_task", "work_due", 0))

    def test_proposal_backlog_and_legacy_wait_never_starve_research(self):
        old = (NOW - timedelta(days=2)).isoformat()
        waiting = task(status="in_progress", execution={
            "state": "dispatched", "session_id": "123", "dispatch_key": "original-attempt", "attempts": 1,
            "started_at": old, "observed_at": old, "session_state": "AWAITING_USER_FEEDBACK",
        })
        data = queue(waiting, task(id="legacy"), *(task(id="proposal-" + str(i), status="proposed") for i in range(60)))
        before = copy.deepcopy(data)
        result = health(data)
        self.assertEqual((result["action"], result["reason"]), ("next_task", "research_due"))
        self.assertEqual(result["pending_proposals"], 61)
        self.assertEqual(result["waiting_workers"][0]["session_id"], "123")
        self.assertEqual(data, before)
        data["tasks"].append(task(id="queued-research", task_type="project_discovery"))
        self.assertEqual(health(data)["reason"], "work_due")
        self.assertEqual(health(data, enabled=False)["action"], "none")
        self.assertEqual(health(data, runs=[run(status="in_progress")])["action"], "none")

    def test_first_waiting_research_detach_needs_tick_then_other_scope_can_run(self):
        config = settings()
        data, _ = plan_research(queue(), config, {"terminal": "c" * 64}, now=NOW)
        research = data["tasks"][0]
        research.update(status="in_progress", execution={
            "state": "dispatched", "session_id": "123", "dispatch_key": "research-attempt", "attempts": 1,
            "starting_branch": "autonomous/attempt-research-attempt", "base_sha": LAB,
            "started_at": NOW.isoformat(), "session_state": "AWAITING_PLAN_APPROVAL",
        })
        result = health(data)
        self.assertEqual((result["action"], result["reason"]), ("next_task", "research_detachment_due"))
        self.assertNotIn("research_detached", research["execution"])
        research["execution"]["research_detached"] = {"at": NOW.isoformat(), "reason": "AWAITING_PLAN_APPROVAL"}
        idle = health(data)
        self.assertEqual((idle["action"], idle["due_at"]), ("none", "2026-09-13T12:30:00Z"))
        config["research"]["perspectives"].append({
            "id": "reliability", "title": "Reliability", "focus": ["quality"], "instruction": "Observe recovery.",
        })
        self.assertEqual(health(data, config)["reason"], "research_due")
        research["execution"]["session_state"] = "IN_PROGRESS"
        self.assertEqual(health(data, config)["reason"], "research_due")
        config["research"]["max_sessions_per_day"] = 1
        self.assertEqual(health(data, config)["due_at"], "2026-09-13T12:30:00Z")

    def test_idle_implementation_poll_anchors_useful_tick_without_chaining(self):
        config = settings()
        config["research"]["enabled"] = False
        old = (NOW - timedelta(hours=2)).isoformat()
        data = queue(task(status="in_progress", execution={
            "state": "dispatched", "session_id": "123", "dispatch_key": "attempt-one", "attempts": 1,
            "started_at": old, "observed_at": old, "session_state": "IN_PROGRESS",
        }))
        data["controller"] = {"last_tick_at": (NOW - timedelta(minutes=1)).isoformat()}
        result = health(data, config)
        self.assertEqual((result["action"], result["delay_seconds"]), ("none", 29 * 60))
        data["controller"]["last_tick_at"] = (NOW - timedelta(minutes=30)).isoformat()
        self.assertEqual(health(data, config)["action"], "next_task")
        del data["controller"]
        self.assertEqual(health(data, config)["action"], "next_task")

    def test_disabled_research_does_not_dispatch_existing_research_or_approved_proposal(self):
        config = settings()
        config["research"]["enabled"] = False
        data = queue(task(task_type="project_discovery"), task(id="approved", proposal_decision={
            "action": "approve", "actor": "maintainer", "at": NOW.isoformat(), "note": "Implement finding",
        }))
        result = health(data, config)
        self.assertEqual((result["action"], result["reason"]), ("none", "research_disabled"))
        self.assertEqual(result["approved_proposals"], 1)

    def test_locked_automatic_guard_ignores_workflow_waiters_and_old_handoffs(self):
        active = [run(id=11, status="in_progress", conclusion=None),
                  run(id=12, status="pending", conclusion=None),
                  run(id=13, status="queued", conclusion=None)]
        data = queue(task(task_type="project_discovery"))
        self.assertEqual(health(data, runs=active)["reason"], "next_task_running")
        before = copy.deepcopy(data)
        result = health(data, runs=active, current_run_id="11")
        self.assertEqual((result["action"], result["reason"]), ("next_task", "work_due"))
        self.assertEqual(data, before)
        active.append(run(id=14, status="in_progress", conclusion=None))
        self.assertEqual(health(data, runs=active, current_run_id="11")["action"], "next_task")
        self.assertEqual(health(data, runs=active)["reason"], "next_task_running")

    def test_foreign_runs_cannot_block_or_delay_local_research(self):
        foreign = [run(id=1, status="in_progress", head_branch="untrusted"),
                   run(id=2, status="pending", head_repository={"full_name": "foreign/repo"}),
                   run(id=3, conclusion="failure", event="pull_request")]
        result = health(runs=foreign, sync_runs=foreign, wakeup_runs=foreign)
        self.assertEqual((result["action"], result["reason"]), ("next_task", "research_due"))
        self.assertEqual(result["scheduler"]["failed_ticks"], 0)
        self.assertIsNone(result["scheduler"]["wakeup_run"])
        self.assertEqual(result["scheduler"]["pending_wakeups"], [])

    def test_main_push_sync_blocks_duplicate_dispatch_and_preserves_failure_gate(self):
        pushed = run(event="push", status="in_progress", conclusion=None,
                     head_repository={"full_name": "owner/repo"})
        result = health(main_is_ancestor=False, sync_runs=[pushed], runs=[])
        self.assertEqual((result["action"], result["reason"]), ("none", "sync_running"))
        pushed.update(status="completed", conclusion="failure")
        result = health(main_is_ancestor=False, sync_runs=[pushed], runs=[])
        self.assertEqual((result["action"], result["reason"]), ("none", "sync_failed"))
        self.assertIsNone(result["due_at"])

    def test_failed_ticks_back_off_without_green_or_skipped_run_reset(self):
        data = queue(task(task_type="project_discovery"))
        data["controller"] = {"last_tick_at": (NOW - timedelta(hours=1)).isoformat(), "run_id": "10"}
        failures = []
        data["controller"]["last_poll_at"] = NOW.isoformat()
        for number, delay in ((1, 300), (2, 900), (3, 1800), (4, 1800)):
            failures.append(run(id=number, conclusion="failure"))
            observations = failures + [run(id=20), run(id=21, conclusion="skipped")]
            result = health(data, runs=observations)
            self.assertEqual((result["action"], result["reason"], result["delay_seconds"]),
                             ("none", "tick_backoff", delay))
            self.assertEqual(result["scheduler"]["state"], "waiting")
            self.assertEqual(health(data, runs=observations, now=NOW + timedelta(seconds=delay))["action"], "next_task")
        data["controller"]["last_tick_at"] = (NOW + timedelta(seconds=1)).isoformat()
        recovered = health(data, runs=observations, now=NOW + timedelta(seconds=1))
        self.assertEqual((recovered["action"], recovered["scheduler"]["failed_ticks"]), ("next_task", 0))

    def test_old_failure_before_durable_tick_cannot_delay_poll(self):
        data = queue(task(task_type="project_discovery", status="in_progress", execution={
            "state": "dispatched", "session_id": "123", "dispatch_key": "attempt", "attempts": 1,
            "started_at": (NOW - timedelta(hours=2)).isoformat(), "session_state": "IN_PROGRESS",
        }))
        data["controller"] = {"last_tick_at": (NOW - timedelta(minutes=15)).isoformat()}
        result = health(data, runs=[run(NOW - timedelta(minutes=16), conclusion="failure"), run(id=2)])
        self.assertEqual((result["action"], result["due_at"]), ("next_task", "2026-09-13T12:00:00Z"))
        self.assertEqual(result["scheduler"]["failed_ticks"], 0)

    def test_proposal_attention_cannot_hide_overdue_scheduler(self):
        pending, pr = proposal()
        pr.update(updated_at=(NOW - timedelta(days=8)).isoformat())
        data = queue(pending)
        data["controller"] = {"last_tick_at": (NOW - timedelta(hours=2)).isoformat()}
        result = health(data, pull_requests=[pr], runs=[run(), run(id=2, conclusion="skipped")],
                        wakeup_runs=[run(id=30, status="in_progress"), run(id=31, status="pending")])
        self.assertEqual((result["health"], result["action"]), ("attention", "next_task"))
        self.assertEqual((result["scheduler"]["state"], result["scheduler"]["overdue_seconds"]), ("overdue", 7200))
        self.assertIn("proposal_stale", {entry["reason"] for entry in result["attention"]})
        self.assertEqual(result["scheduler"]["wakeup_run"]["id"], 30)
        self.assertEqual([item["id"] for item in result["scheduler"]["pending_wakeups"]], [31])

    def test_waiting_worker_does_not_hide_earlier_research_cooldown(self):
        config = settings()
        data, _ = plan_research(queue(), config, {"terminal": "c" * 64}, now=NOW - timedelta(hours=24) + timedelta(minutes=10))
        data["tasks"][0].update(status="blocked", execution={"state": "exhausted", "attempts": 2,
                               "outcome": "failed", "finished_at": data["tasks"][0]["created_at"]})
        data["tasks"].append(task(status="in_progress", execution={
            "state": "dispatched", "session_id": "123", "dispatch_key": "attempt", "attempts": 1,
            "started_at": NOW.isoformat(), "session_state": "PAUSED",
        }))
        result = health(data, config)
        self.assertEqual((result["action"], result["due_at"], result["delay_seconds"]),
                         ("none", "2026-09-13T12:10:00Z", 600))
        self.assertEqual(health(data, config, now=NOW + timedelta(minutes=10))["reason"], "research_due")

    def test_active_snapshot_keeps_old_pending_run_beyond_completed_window(self):
        old = run(NOW - timedelta(days=10), id=1, status="pending", conclusion=None)
        def get(path, paginate=False):
            state = parse_qs(urlsplit(path).query)["status"][0]
            values = [old] if state == "pending" else []
            if state == "completed":
                return {"total_count": 50000, "workflow_runs": [run(id=number) for number in range(100, 200)]}
            return [{"total_count": len(values), "workflow_runs": values}]
        observed = snapshot_runs(get, "autonomous_next_task.yml")
        result = health(queue(task()), runs=observed)
        self.assertEqual((result["action"], result["reason"]), ("none", "next_task_running"))

    def test_active_transition_between_filters_cannot_claim_idle(self):
        active = run(id=42, status="pending", conclusion=None)
        def get(path, paginate=False):
            state = parse_qs(urlsplit(path).query)["status"][0]
            values = [dict(active)] if active["status"] == state else []
            if state == "in_progress":
                active["status"] = "in_progress"
            page = {"total_count": len(values), "workflow_runs": values}
            return [page] if paginate else page
        observed = snapshot_runs(get, "autonomous_next_task.yml")
        result = health(queue(task()), runs=observed)
        self.assertEqual((result["action"], result["reason"]), ("none", "next_task_running"))

    def test_active_count_race_recovers_without_admitting_duplicate_work(self):
        active = run(id=42, status="queued", conclusion=None)
        complete = {"total_count": 1, "workflow_runs": [active]}
        queued = iter([{"total_count": 1, "workflow_runs": []}, complete])
        def get(path, paginate=False):
            state = parse_qs(urlsplit(path).query)["status"][0]
            page = next(queued, complete) if state == "queued" else {"total_count": 0, "workflow_runs": []}
            return [page] if paginate else page
        observed = snapshot_runs(get, "autonomous_next_task.yml")
        result = health(queue(task()), runs=observed)
        self.assertEqual((result["action"], result["reason"]), ("none", "next_task_running"))

    def test_snapshot_retry_preserves_runs_seen_on_partial_pages(self):
        active = run(id=42, status="queued", conclusion=None)
        empty = {"total_count": 0, "workflow_runs": []}
        queued = iter([{"total_count": 2, "workflow_runs": [active]}, empty])
        def get(path, paginate=False):
            state = parse_qs(urlsplit(path).query)["status"][0]
            page = next(queued, empty) if state == "queued" else empty
            return [page] if paginate else page
        observed = snapshot_runs(get, "autonomous_next_task.yml")
        result = health(queue(task()), runs=observed)
        self.assertEqual((result["action"], result["reason"]), ("none", "next_task_running"))

    def test_partial_active_snapshot_cannot_claim_idle(self):
        for total in (1, 1000):
            with self.subTest(total=total):
                def get(path, paginate=False):
                    page = {"total_count": total, "workflow_runs": []}
                    return [page] if paginate else page
                with self.assertRaises(ValueError):
                    snapshot_runs(get, "autonomous_next_task.yml")

    def test_old_queue_owned_proposal_is_reconciled_without_pr_history(self):
        pending, pr = proposal()
        pending["execution"]["started_at"] = (NOW - timedelta(days=60)).isoformat()
        pr.update(state="closed", merged_at=NOW.isoformat())
        foreign = task(id="foreign", status="blocked", execution={"state": "awaiting_review", "outcome": "review_required",
                       "pull_request": 999, "session_id": "foreign", "dispatch_key": "foreign", "attempts": 1})
        data = queue(pending, foreign)
        observed = snapshot_proposals(lambda path: {"pulls/9": pr}[path], data, "owner/repo")
        result = health(data, pull_requests=observed)
        self.assertEqual((result["action"], result["reason"]), ("next_task", "reconciliation_due"))
        pr["head"]["repo"]["full_name"] = "foreign/repo"
        with self.assertRaises(ValueError):
            snapshot_proposals(lambda path: pr, data, "owner/repo")


class GitReadinessTest(unittest.TestCase):
    def test_cli_observes_real_ancestry_and_preserves_queue_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "lab"
            repo.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-C", str(repo), *args], text=True, stderr=subprocess.DEVNULL).strip()
            git("init", "-b", "main")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            (repo / "src").mkdir()
            (repo / "src" / "terminal.ts").write_text("base", encoding="utf-8")
            git("add", ".")
            git("commit", "-m", "base")
            initial = git("rev-parse", "HEAD")
            git("branch", "lab")
            (repo / "src" / "terminal.ts").write_text("accepted", encoding="utf-8")
            git("commit", "-am", "accepted main")
            accepted = git("rev-parse", "HEAD")
            git("update-ref", "refs/remotes/origin/main", accepted)
            git("checkout", "lab")
            data = queue(task())
            config = settings()
            config["research"]["enabled"] = False
            own = run(id=11, status="in_progress", conclusion=None)
            pending = run(NOW - timedelta(days=10), id=12, status="pending", conclusion=None)
            wakeup = run(id=30, status="pending", conclusion=None)
            active_syncs = []

            def get(path, *, paginate=False):
                workflow = path.split("/")[2]
                status = parse_qs(urlsplit(path).query)["status"][0]
                values = []
                if workflow == "autonomous_next_task.yml":
                    values = [item for item in (own, pending) if item["status"] == status]
                elif workflow == "autonomous_continue.yml" and status == "pending":
                    values = [wakeup]
                elif workflow == "autonomous_sync.yml":
                    values = [item for item in active_syncs if item["status"] == status]
                page = {"total_count": len(values), "workflow_runs": values}
                return [page] if paginate else page

            inspected = inspect_health(data, config, repo=repo, enabled=True, now=NOW,
                                       state_sha="e" * 40, current_run_id="11", get=get)
            self.assertEqual((inspected["action"], inspected["main_sha"], inspected["lab_sha"]),
                             ("sync", accepted, initial))
            self.assertEqual(inspected["state_sha"], "e" * 40)
            self.assertEqual(inspected["scheduler"]["pending_wakeups"][0]["id"], 30)
            active_syncs.append(run(NOW - timedelta(days=10), id=40, status="waiting", conclusion=None))
            busy = inspect_health(data, config, repo=repo, enabled=True, now=NOW, current_run_id="11", get=get)
            self.assertEqual((busy["action"], busy["reason"]), ("none", "sync_running"))
            active_syncs.clear()
            paths = {name: root / (name + ".json") for name in ("manifest", "config", "runs", "sync-runs", "pull-requests", "wakeup-runs")}
            for name, value in (("manifest", data), ("config", config), ("runs", [own, pending]),
                                ("sync-runs", []), ("pull-requests", []), ("wakeup-runs", [wakeup])):
                paths[name].write_text(json.dumps(value) + "\n", encoding="utf-8")
            before = paths["manifest"].read_bytes()
            arguments = [value for name, path in paths.items() for value in ("--" + name, str(path))]
            arguments += ["--repo", str(repo), "--enabled", "true", "--now", NOW.isoformat(), "--current-run-id", "11"]
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(arguments), 0)
            result = json.loads(output.getvalue())
            self.assertEqual((result["action"], result["main_sha"], result["lab_sha"]), ("sync", accepted, initial))
            git("merge", "--ff-only", accepted)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(arguments), 0)
            result = json.loads(output.getvalue())
            self.assertEqual((result["action"], result["reason"]), ("none", "research_disabled"))
            self.assertEqual(paths["manifest"].read_bytes(), before)
            config["research"]["enabled"] = True
            inspected = inspect_health(data, config, repo=repo, enabled=True, now=NOW,
                                       current_run_id="11", get=get)
            self.assertTrue(inspected["main_is_ancestor"])
            self.assertEqual((inspected["action"], inspected["reason"]), ("next_task", "research_due"))
            self.assertEqual(paths["manifest"].read_bytes(), before)
            git("update-ref", "-d", "refs/remotes/origin/main")
            with self.assertRaises(subprocess.CalledProcessError):
                inspect_health(data, config, repo=repo, enabled=True, now=NOW, get=get)


if __name__ == "__main__":
    unittest.main(verbosity=2)
