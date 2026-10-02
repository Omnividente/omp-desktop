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
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from loop_health import assess_health, main, workflow_runs
from dispatch_journal import (CONTINUE, NEXT, SYNC, OWNER_RECOVERY, OWNER_CONTINUE_CUTOVER,
                              digest, normalize_inputs, substantive_digest,
                              _owner_fence_receipt_id, _owner_cutover_receipt_id)
from research_cycle import plan_research
from select_task import select
from health_snapshot import inspect_health, snapshot_proposals, snapshot_runs
from proposal_backlog import close_research_unaccepted
from research_disposition import append_recovery_event
from owner_report_recovery import queue_recovery
from task_lifecycle import complete
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


class JournalHealthTest(unittest.TestCase):
    def fixture(self, *, age=timedelta(), send=True, executor=False, workflow=NEXT, tasks=(), repository="",
                source_kind="sender", event_name="workflow_dispatch"):
        self.data = queue(*tasks)
        self.events = []
        self.data["dispatch_journal"] = {"version": 1, "events": self.events}
        self.at = (NOW - age).isoformat()
        initial = self.append("Init", control_sha=MAIN,
                              basis={"kind": "fenced_bootstrap", "legacy_senders_fenced": True,
                                     "pending_legacy": "none", "state_sha": LAB})
        self.decision = digest([initial["event_id"], 0, ""])
        self.key = digest([self.decision, "dispatch"])[:32]
        self.trigger = {"run_id": "10", "run_attempt": "1", "event_name": event_name,
                        "control_sha": MAIN}
        if repository:
            self.trigger["repository"] = repository
        inputs = normalize_inputs(workflow, {"main_sha": MAIN, "lab_sha": LAB} if workflow == SYNC else {})
        self.append("Intent", decision_id=self.decision, frontier_seq=0, predecessor_decision_id="",
                    correlation_key=self.key, workflow=workflow, normalized_inputs=inputs,
                    input_hash=digest(inputs), basis={}, source_kind=source_kind, control_sha=MAIN,
                    first_source_trigger=self.trigger, source_identity=digest([event_name, "10"]))
        if send:
            self.append("SendClaim", decision_id=self.decision, trigger=self.trigger,
                        claim_id=digest([self.decision, "send"]))
        if executor:
            self.append("ExecutorClaim", decision_id=self.decision,
                        trigger={**self.trigger, "run_id": "10" if source_kind == "external" else "20"}, correlation_key=self.key,
                        claim_id=digest([self.decision, "execute"]),
                        before_state_sha=LAB, before_digest="c" * 64)
        return self.data

    def append(self, event_type, **fields):
        event = {"type": event_type, "at": self.at, **fields}
        event["event_id"] = digest(event)
        self.events.append(event)
        return event

    def observer_context(self, kind="execute"):
        claim_type = "ExecutorClaim" if kind == "execute" else "SendClaim"
        claim = next(event for event in self.events if event["type"] == claim_type)
        return {"kind": kind, "decision_id": self.decision, "claim_id": claim["claim_id"],
                "trigger": copy.deepcopy(claim["trigger"]), "control_sha": MAIN}

    def delivery(self, kind, **metadata):
        self.append("DeliveryObservation", decision_id=self.decision,
                    observation={"kind": kind, "observed_at": self.at, **metadata})

    def observe(self, **kwargs):
        config = settings()
        config["research"]["enabled"] = False
        kwargs.setdefault("runs", [])
        return health(self.data, config, **kwargs)

    def reasons(self, result):
        return {item["reason"] for item in result["attention"]}

    def test_short_pending_and_exact_grace_do_not_report_lost_ack(self):
        for send in (False, True):
            with self.subTest(send=send):
                self.fixture(age=timedelta(minutes=5), send=send)
                result = self.observe()
                self.assertEqual((result["health"], result["action"]), ("ok", "none"))
                self.assertEqual(self.reasons(result), set())
                active = result["dispatch_journal"]["active_intent"]
                self.assertEqual(active["send_claim_consumed"], send)
                self.assertFalse(active["executor_claim_consumed"])
                self.assertIn("executor_claim", active["missing"])

    def test_lost_ack_is_immediate_but_claim_only_becomes_attention_after_grace(self):
        self.fixture()
        self.delivery("post_unknown")
        unknown = self.observe()
        self.assertEqual(unknown["health"], "attention")
        self.assertEqual(self.reasons(unknown), {"journal_delivery_unknown"})
        self.fixture(age=timedelta(minutes=5, seconds=1))
        spent = self.observe()
        self.assertEqual(self.reasons(spent), {"journal_send_spent_without_receipt"})
        self.assertEqual(spent["dispatch_journal"]["active_intent"]["phase"], "send_spent")
        self.delivery("post_acknowledged")
        self.assertEqual(self.reasons(self.observe()), {"journal_executor_overdue"})

    def test_historical_active_delivery_does_not_mask_executor_overdue(self):
        self.fixture(age=timedelta(minutes=6))
        self.delivery("run_observed", run_id="20", run_status="in_progress")
        result = self.observe()
        self.assertEqual(self.reasons(result), {"journal_executor_overdue"})
        active = result["dispatch_journal"]["active_intent"]
        self.assertIsNone(active["run"])
        self.assertEqual(active["delivery_observations"][-1]["status"], "in_progress")

    def test_executor_live_run_is_distinct_from_failed_or_missing_terminal_receipt(self):
        self.fixture(age=timedelta(hours=2), executor=True)
        active = self.observe(wakeup_runs=[], sync_runs=[], runs=[run(id=20, status="in_progress", conclusion=None)])
        self.assertEqual(self.reasons(active), set())
        self.assertEqual(active["dispatch_journal"]["active_intent"]["phase"], "executing")
        for conclusion in ("failure", "cancelled"):
            with self.subTest(conclusion=conclusion):
                failed = self.observe(runs=[run(id=20, conclusion=conclusion)])
                self.assertEqual(self.reasons(failed), {"journal_run_failed"})
        self.assertEqual(self.reasons(self.observe()), {"journal_executor_without_receipt"})
        self.assertEqual(self.reasons(self.observe(runs=[run(id=20)])), {"journal_executor_without_receipt"})

    def test_task_attention_and_disabled_observations_survive_without_mutation(self):
        self.fixture(tasks=(task(status="blocked", execution={"state": "quarantined", "session_id": "123",
                     "dispatch_key": "legacy-attempt", "attempts": 1, "started_at": NOW.isoformat(), "outcome": "stale"}),))
        self.delivery("post_unknown", url="private://not-exported", display_title="not-exported",
                      run_id="unsafe", run_status={"bad": "shape"}, conclusion=["bad"])
        before = json.dumps(self.data, sort_keys=True)
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                result = self.observe(enabled=enabled)
                self.assertEqual(self.reasons(result), {"quarantined", "journal_delivery_unknown"})
                self.assertEqual(result["health"], "attention" if enabled else "disabled")
                self.assertEqual(result["action"], "none")
                observation = result["dispatch_journal"]["active_intent"]["delivery_observations"][0]
                self.assertEqual(set(observation), {"kind", "observed_at"})
        self.assertEqual(json.dumps(self.data, sort_keys=True), before)

    def test_current_durable_executor_can_observe_due_work_without_self_deadlock(self):
        self.fixture(age=timedelta(hours=2), executor=True,
                     tasks=(task(task_type="project_discovery", status="in_progress", execution={
                         "state": "dispatched", "session_id": "123", "dispatch_key": "attempt-one", "attempts": 1,
                         "session_state": "IN_PROGRESS", "started_at": (NOW - timedelta(hours=1)).isoformat(),
                         "observed_at": (NOW - timedelta(hours=1)).isoformat()}),))
        before = copy.deepcopy(self.data)
        self.assertEqual(self.observe(current_run_id="21")["action"], "none")
        self.assertEqual(self.observe(current_run_id="20")["action"], "none")
        owner = self.observe(current_run_id="20", observer_context=self.observer_context())
        self.assertEqual(owner["action"], "next_task")
        self.assertNotIn("journal_executor_without_receipt", self.reasons(owner))
        self.assertTrue(owner["dispatch_journal"]["current_executor"])
        self.assertEqual(self.data, before)

    def test_foreign_claim_descriptor_cannot_bypass_a_due_worker_fence(self):
        self.fixture(age=timedelta(hours=2), executor=True,
                     tasks=(task(task_type="project_discovery", status="in_progress", execution={
                         "state": "dispatched", "session_id": "123", "dispatch_key": "attempt-one", "attempts": 1,
                         "session_state": "IN_PROGRESS", "started_at": (NOW - timedelta(hours=1)).isoformat(),
                         "observed_at": (NOW - timedelta(hours=1)).isoformat()}),))
        before = copy.deepcopy(self.data)
        valid = self.observer_context()
        forged = [{**valid, "kind": "send"}, {**valid, "decision_id": "d" * 64},
                  {**valid, "claim_id": "d" * 64}, {**valid, "control_sha": "d" * 40},
                  {**valid, "trigger": {**valid["trigger"], "run_attempt": "2"}},
                  {**valid, "trigger": {**valid["trigger"], "actor": "stranger"}}]
        for observer in forged:
            with self.subTest(observer=observer):
                result = self.observe(current_run_id="20", observer_context=observer)
                self.assertEqual(result["action"], "none")
                self.assertFalse(result["dispatch_journal"]["current_executor"])
        self.assertEqual(self.data, before)

    def test_own_send_claim_allows_readiness_but_unknown_delivery_does_not(self):
        self.fixture(tasks=(task(task_type="project_discovery"),))
        observer = self.observer_context("send")
        before = copy.deepcopy(self.data)
        ready = health(self.data, runs=[], current_run_id="10", observer_context=observer)
        self.assertEqual(ready["action"], "next_task")
        self.assertTrue(ready["dispatch_journal"]["current_sender"])
        self.assertEqual(self.data, before)
        self.delivery("post_unknown")
        before = copy.deepcopy(self.data)
        replay = health(self.data, runs=[], current_run_id="10", observer_context=observer)
        self.assertEqual(replay["action"], "none")
        self.assertFalse(replay["dispatch_journal"]["current_sender"])
        self.assertIn("journal_delivery_unknown", self.reasons(replay))
        self.assertEqual(self.data, before)

    def test_saved_queued_delivery_is_historical_without_a_fresh_run(self):
        self.fixture(age=timedelta(hours=2), executor=True)
        self.delivery("run_observed", run_id="20", run_attempt="1", status="queued")
        before = copy.deepcopy(self.data)
        result = self.observe()
        self.assertEqual((result["health"], result["action"]), ("attention", "none"))
        self.assertIn("journal_executor_without_receipt", self.reasons(result))
        active = result["dispatch_journal"]["active_intent"]
        self.assertEqual(active["phase"], "executor_spent")
        self.assertIsNone(active["run"])
        self.assertEqual(active["delivery_observations"][-1]["status"], "queued")
        self.assertEqual(self.data, before)

    def test_snapshot_observes_old_pinned_failure_and_does_not_block_current_executor(self):
        self.fixture(age=timedelta(hours=2), executor=True,
                     tasks=(task(task_type="project_discovery", status="in_progress", execution={
                         "state": "dispatched", "session_id": "123", "dispatch_key": "attempt-one", "attempts": 1,
                         "session_state": "IN_PROGRESS", "started_at": (NOW - timedelta(hours=1)).isoformat(),
                         "observed_at": (NOW - timedelta(hours=1)).isoformat()}),))
        config = settings()
        config["research"]["enabled"] = False
        def get(path, *, paginate=False):
            if path == "actions/runs/20":
                return run(id=20, conclusion="cancelled")
            page = {"total_count": 0, "workflow_runs": []}
            return [page] if paginate else page
        before = copy.deepcopy(self.data)
        with patch("health_snapshot.revision", side_effect=[MAIN, LAB, MAIN, LAB]), \
             patch("health_snapshot.git", return_value=subprocess.CompletedProcess([], 0)):
            foreign = inspect_health(self.data, config, repo=".", enabled=True, now=NOW, get=get)
            owner = inspect_health(self.data, config, repo=".", enabled=True, now=NOW, get=get,
                                   current_run_id="20", observer_context=self.observer_context())
        self.assertEqual((foreign["action"], self.reasons(foreign)), ("none", {"journal_run_failed"}))
        self.assertEqual(owner["action"], "next_task")
        self.assertIn("journal_run_failed", self.reasons(owner))
        self.assertEqual(self.data, before)


    def test_no_effect_completion_closes_frontier_without_useful_progress(self):
        self.fixture(age=timedelta(hours=2), executor=True, workflow=SYNC)
        evidence = {"status": "up_to_date", "reason": "main_already_integrated",
                    "main_sha": MAIN, "lab_sha": LAB, "queue_blob": "e" * 40,
                    "candidate_branch": "autonomous/sync-20-1", "candidate_sha": ""}
        claim = digest([self.decision, "execute"])
        self.append("ExecutionCompletion", decision_id=self.decision, executor_claim_id=claim,
                    kind="sync_no_effect", evidence=evidence, frontier_seq=1,
                    receipt_id=digest([self.decision, claim, "sync_no_effect", evidence]))
        before = copy.deepcopy(self.data)
        result = self.observe()
        self.assertEqual((result["health"], result["action"]), ("ok", "none"))
        self.assertIsNone(result["dispatch_journal"]["active_intent"])
        self.assertEqual(result["dispatch_journal"]["completed_receipts"], 1)
        self.assertEqual(result["dispatch_journal"]["frontier_seq"], 1)
        self.assertIsNone(result["scheduler"]["last_tick_at"])
        self.assertIsNone(result["scheduler"]["last_poll_at"])
        self.assertEqual(self.data, before)

    def fenced_fixture(self, workflow=NEXT):
        self.fixture(workflow=workflow, tasks=(task(),), repository="owner/repo")
        trigger = {"run_id": "30", "run_attempt": "1", "event_name": "workflow_dispatch",
                   "control_sha": MAIN, "repository": "owner/repo", "actor": "owner",
                   "workflow": OWNER_RECOVERY, "ref": "refs/heads/main",
                   "expected_state_sha": LAB, "decision_id": self.decision}
        before = substantive_digest(self.data)
        self.append("OwnerFence", decision_id=self.decision, kind="owner_revoked_unclaimed",
                    owner_trigger=trigger, before_state_sha=LAB, before_digest=before,
                    frontier_seq=1, receipt_id=_owner_fence_receipt_id(self.decision, trigger, LAB, before))
        title = ("Sync main " + MAIN + " " if workflow == SYNC else
                 "Continue " if workflow == CONTINUE else "Next ") + self.key
        return run(id=20, status="queued", conclusion=None, display_title=title,
                   head_repository={"full_name": "owner/repo"})

    def test_owner_fenced_delivery_no_longer_blocks_readiness_or_creates_tick_backoff(self):
        for workflow in (NEXT, SYNC, CONTINUE):
            statuses = ("queued", "in_progress") if workflow == CONTINUE else ("queued", "in_progress", "completed")
            for status in statuses:
                with self.subTest(workflow=workflow, status=status):
                    stale = self.fenced_fixture(workflow)
                    stale.update(status=status, conclusion="cancelled" if status == "completed" else None)
                    before = copy.deepcopy(self.data)
                    kwargs = {NEXT: "runs", SYNC: "sync_runs", CONTINUE: "wakeup_runs"}
                    result = self.observe(main_is_ancestor=False, **{kwargs[workflow]: [stale]})
                    self.assertEqual((result["action"], result["reason"]), ("sync", "sync_required"))
                    self.assertEqual(result["scheduler"]["failed_ticks"], 0)
                    self.assertIsNone(result["scheduler"]["retry_at"])
                    if workflow == CONTINUE:
                        self.assertIsNone(result["scheduler"]["wakeup_run"])
                        self.assertEqual(result["scheduler"]["pending_wakeups"], [])
                    self.assertEqual(self.data, before)

    def test_fence_does_not_hide_unbound_pin_key_repository_or_unkeyed_runs(self):
        for workflow in (NEXT, SYNC):
            for change in ({"head_sha": "d" * 40}, {"display_title": "unbound"},
                           {"head_repository": {}}, {"event": "schedule"}):
                with self.subTest(workflow=workflow, change=change):
                    active = self.fenced_fixture(workflow)
                    active.update(change)
                    result = self.observe(**{("runs" if workflow == NEXT else "sync_runs"): [active]})
                    self.assertEqual(result["action"], "none")
                    self.assertEqual(result["reason"], "next_task_running" if workflow == NEXT else "sync_running")
            stale = self.fenced_fixture(workflow)
            live = {**stale, "id": 21, "display_title": "another delivery"}
            result = self.observe(**{("runs" if workflow == NEXT else "sync_runs"): [stale, live]})
            self.assertEqual(result["action"], "none")

    def test_correlation_metadata_without_owner_fence_cannot_release_the_lane(self):
        for workflow in (NEXT, SYNC):
            active = self.fenced_fixture(workflow)
            self.events.pop()
            result = self.observe(main_is_ancestor=False, current_run_id="10",
                                  observer_context=self.observer_context("send"),
                                  **{("runs" if workflow == NEXT else "sync_runs"): [active]})
            self.assertEqual(result["action"], "none")
            self.assertEqual(result["reason"], "next_task_running" if workflow == NEXT else "sync_running")

    def cutover_fixture(self, *, external=False, executor=True):
        self.fixture(workflow=CONTINUE, tasks=(task(),), repository="owner/repo",
                     send=not external, executor=executor,
                     source_kind="external" if external else "sender",
                     event_name="schedule" if external else "workflow_dispatch")
        trigger = {"run_id": "30", "run_attempt": "1", "event_name": "workflow_dispatch",
                   "control_sha": MAIN, "repository": "owner/repo", "actor": "owner",
                   "workflow": OWNER_CONTINUE_CUTOVER, "ref": "refs/heads/main",
                   "expected_state_sha": LAB, "decision_id": self.decision}
        before = substantive_digest(self.data)
        self.append("OwnerContinueCutover", decision_id=self.decision, kind="owner_cutover_continue",
                    owner_trigger=trigger, before_state_sha=LAB, before_digest=before,
                    frontier_seq=1, receipt_id=_owner_cutover_receipt_id(self.decision, trigger, LAB, before))
        return run(id=10 if external else 20, run_attempt=1, event=self.trigger["event_name"],
                   status="in_progress", conclusion=None,
                   display_title="Autonomous Continue" if external else "Continue " + self.key,
                   head_repository={"full_name": "owner/repo"})

    def test_owner_cutover_removes_only_closed_continue_from_wakeup_readiness(self):
        for external, executor in ((False, False), (False, True), (True, True)):
            for status in ("queued", "in_progress", "completed"):
                with self.subTest(external=external, executor=executor, status=status):
                    stale = self.cutover_fixture(external=external, executor=executor)
                    stale.update(status=status, conclusion="failure" if status == "completed" else None)
                    before = copy.deepcopy(self.data)
                    result = self.observe(main_is_ancestor=False, wakeup_runs=[stale])
                    self.assertEqual((result["action"], result["reason"]), ("sync", "sync_required"))
                    self.assertIsNone(result["scheduler"]["wakeup_run"])
                    self.assertEqual(result["scheduler"]["pending_wakeups"], [])
                    self.assertEqual(result["scheduler"]["failed_ticks"], 0)
                    self.assertEqual(self.data, before)

    def test_cutover_does_not_hide_unbound_external_continue_runtime(self):
        for change in ({"id": 21}, {"run_attempt": 2}, {"run_attempt": None},
                       {"event": "workflow_dispatch"}, {"head_repository": {}}):
            with self.subTest(change=change):
                live = self.cutover_fixture(external=True)
                live.update(change)
                result = self.observe(wakeup_runs=[live])
                self.assertEqual(result["scheduler"]["wakeup_run"]["id"], live["id"])

    def test_runtime_identity_without_owner_cutover_cannot_hide_external_continue(self):
        live = self.cutover_fixture(external=True)
        self.events.pop()
        result = self.observe(wakeup_runs=[live], current_run_id="10",
                              observer_context=self.observer_context())
        self.assertEqual(result["scheduler"]["wakeup_run"]["id"], live["id"])

    def test_cutover_matches_captured_executor_when_event_main_differs_from_frozen_checkout(self):
        for external in (False, True):
            with self.subTest(external=external):
                live = self.cutover_fixture(external=external)
                live["head_sha"] = "d" * 40
                result = self.observe(wakeup_runs=[live])
                self.assertIsNone(result["scheduler"]["wakeup_run"])


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

    def test_research_transition_keeps_actual_cooldown_deadline_and_lateness(self):
        config = settings()
        finished_at = NOW - timedelta(hours=24)
        data, _ = plan_research(queue(), config, {"terminal": "c" * 64}, now=finished_at)
        data["tasks"][0].update(status="done", execution={
            "state": "completed", "outcome": "no_change", "finished_at": finished_at.isoformat(),
        })
        data["tasks"][0]["research_result"] = {
            "summary": "No defect observed", "completed_at": finished_at.isoformat(),
            "observations": [{"scenario": "resume", "evidence": "synthetic clock", "result": "clock advanced"}],
            "next_hypotheses": [], "proposed_task_ids": [],
        }
        before = health(data, config, now=NOW - timedelta(seconds=1), runs=[])
        self.assertEqual((before["action"], before["research_next_at"], before["due_at"]),
                         ("none", "2026-09-13T12:00:00Z", "2026-09-13T12:00:00Z"))
        after = health(data, config, now=NOW + timedelta(seconds=44), runs=[])
        self.assertEqual((after["action"], after["reason"], after["due_at"]),
                         ("next_task", "research_due", "2026-09-13T12:00:00Z"))
        self.assertEqual(after["scheduler"]["overdue_seconds"], 44)
        backed_off = health(data, config, now=NOW + timedelta(seconds=44), runs=[run(conclusion="failure")])
        self.assertEqual((backed_off["action"], backed_off["reason"], backed_off["due_at"]),
                         ("none", "tick_backoff", "2026-09-13T12:05:00Z"))
        running = health(data, config, now=NOW + timedelta(seconds=44),
                         runs=[run(status="in_progress", conclusion=None)])
        self.assertEqual((running["action"], running["reason"], running["due_at"]),
                         ("none", "next_task_running", "2026-09-13T12:00:00Z"))
        self.assertEqual(running["scheduler"]["overdue_seconds"], 44)

    def test_daily_cap_deadline_survives_expiration_for_a_new_scope(self):
        config = settings()
        config["research"].update(max_sessions_per_day=1, revisit_after_hours=48)
        data, _ = plan_research(queue(), config, {"terminal": "c" * 64}, now=NOW - timedelta(days=1))
        data["tasks"][0].update(status="blocked", execution={"state": "exhausted", "outcome": "failed", "attempts": 2})
        config["research"]["areas"].append({"id": "clock", "title": "Clock", "paths": ["src/clock.ts"]})
        fingerprints = {"terminal": "c" * 64, "clock": "d" * 64}
        before = health(data, config, now=NOW - timedelta(seconds=1), fingerprints=fingerprints)
        after = health(data, config, now=NOW + timedelta(seconds=44), fingerprints=fingerprints)
        self.assertEqual((before["reason"], before["due_at"]), ("daily_cap", "2026-09-13T12:00:00Z"))
        self.assertEqual((after["reason"], after["due_at"], after["scheduler"]["overdue_seconds"]),
                         ("research_due", "2026-09-13T12:00:00Z", 44))

    def test_reconciliation_deadline_wins_over_active_worker_poll_deadline(self):
        pending, pr = proposal()
        closed_at = NOW - timedelta(seconds=12)
        pr.update(state="closed", merged_at=closed_at.isoformat(), updated_at=closed_at.isoformat())
        active = task(id="active", status="in_progress", execution={
            "state": "dispatched", "session_id": "456", "dispatch_key": "active-attempt",
            "attempts": 1, "started_at": (NOW - timedelta(hours=2)).isoformat(),
            "observed_at": (NOW - timedelta(hours=2)).isoformat(), "session_state": "IN_PROGRESS",
        })
        data = queue(pending, active)
        data["controller"] = {"last_poll_at": NOW.isoformat()}
        result = health(data, pull_requests=[pr], main_is_ancestor=False, runs=[])
        self.assertEqual((result["action"], result["reason"], result["due_at"]),
                         ("next_task", "reconciliation_due", "2026-09-13T11:59:48Z"))
        self.assertEqual(result["scheduler"]["overdue_seconds"], 12)


    def test_reconciliation_transition_uses_proposal_event_deadline(self):
        pending, pr = proposal()
        closed_at = NOW - timedelta(seconds=12)
        pr.update(state="closed", merged_at=closed_at.isoformat(), updated_at=closed_at.isoformat())
        result = health(queue(pending), pull_requests=[pr], main_is_ancestor=False, runs=[])
        self.assertEqual((result["action"], result["reason"], result["due_at"]),
                         ("next_task", "reconciliation_due", "2026-09-13T11:59:48Z"))
        self.assertEqual(result["scheduler"]["overdue_seconds"], 12)

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
                                 ("attention", "next_task", reason))
                self.assertEqual(overdue["attention"][0]["reason"], "worker_wait_prolonged")
                self.assertEqual(overdue["attention"][0]["age_seconds"], 2 * 24 * 3600)

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

    def test_wait_without_age_is_observed_without_claiming_a_prolonged_stall(self):
        data = queue(task(status="in_progress", execution={
            "state": "dispatched", "session_id": "123", "dispatch_key": "legacy-attempt",
            "attempts": 1, "session_state": "AWAITING_USER_FEEDBACK",
        }))
        data["controller"] = {"last_tick_at": NOW.isoformat()}
        before = copy.deepcopy(data)
        result = health(data)
        self.assertEqual(result["waiting_workers"][0]["reason"], "worker_awaiting_feedback")
        self.assertFalse(any(item["reason"] == "worker_wait_prolonged" for item in result["attention"]))
        self.assertEqual(data, before)

    def test_sent_nudge_does_not_hide_prolonged_wait_or_block_detached_research(self):
        old = NOW - timedelta(hours=2)
        config = settings()
        config["research"]["areas"].append({"id": "clock", "title": "Clock", "paths": ["src/clock.ts"]})
        data, _ = plan_research(queue(), config, {"terminal": "c" * 64, "clock": "d" * 64}, now=old)
        research = data["tasks"][0]
        research.update(status="in_progress", execution={
            "state": "dispatched", "session_id": "123", "dispatch_key": "research-attempt", "attempts": 1,
            "starting_branch": "autonomous/attempt-research-attempt", "base_sha": LAB,
            "started_at": old.isoformat(), "observed_at": old.isoformat(),
            "session_state": "AWAITING_USER_FEEDBACK",
            "research_detached": {"at": old.isoformat(), "reason": "AWAITING_USER_FEEDBACK"},
            "feedback_nudge": {"at": (old + timedelta(minutes=5)).isoformat(), "result": "sent"},
        })
        before = copy.deepcopy(data)
        result = health(data, config, fingerprints={"terminal": "c" * 64, "clock": "d" * 64})
        self.assertEqual((result["health"], result["action"], result["reason"]),
                         ("attention", "next_task", "research_due"))
        observation = next(item for item in result["attention"] if item["reason"] == "worker_wait_prolonged")
        self.assertEqual((observation["feedback_result"], observation["age_seconds"]), ("sent", 7200))
        self.assertEqual(observation["session_url"], "https://jules.google.com/session/123")
        self.assertEqual(data, before)
        boundary = health(data, config, now=old + timedelta(minutes=90),
                          fingerprints={"terminal": "c" * 64, "clock": "d" * 64})
        self.assertFalse(any(item["reason"] == "worker_wait_prolonged" for item in boundary["attention"]))

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

    def test_plain_run_id_does_not_hide_active_next_workflows(self):
        active = [run(id=11, status="in_progress", conclusion=None),
                  run(id=12, status="pending", conclusion=None),
                  run(id=13, status="queued", conclusion=None)]
        data = queue(task(task_type="project_discovery"))
        before = copy.deepcopy(data)
        result = health(data, runs=active, current_run_id="11")
        self.assertEqual((result["action"], result["reason"]), ("none", "next_task_running"))
        self.assertEqual(data, before)


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


class OwnerRecoveryHealthTest(unittest.TestCase):
    def fixture(self, *, cap=24, queued=True):
        config = settings()
        config["merge_gate"] = {"owner_approvers": ["Owner"]}
        config["research"]["max_sessions_per_day"] = cap
        data, _ = plan_research(queue(), config, {"terminal": "c" * 64},
                                now=NOW - timedelta(minutes=30))
        research = data["tasks"][0]
        repair_at = (NOW - timedelta(minutes=20)).isoformat()
        research.update(status="blocked", execution={
            "state": "awaiting_report", "outcome": "report_invalid", "attempts": 1,
            "session_id": "123", "dispatch_key": "attempt-one", "base_sha": LAB,
            "starting_branch": "autonomous/attempt-attempt-one", "session_state": "COMPLETED",
            "started_at": (NOW - timedelta(minutes=30)).isoformat(),
            "report_error": {"code": "research_invalid", "detail": "Unmarked report",
                             "reported_at": repair_at},
            "report_repair": {"at": repair_at, "result": "sent", "status": "invalid",
                              "detail": "Report remained unmarked after repair"},
        })
        inputs = normalize_inputs(NEXT, {"task_id": research["id"], "recover_report": True,
                                         "repair_after": repair_at})
        trigger = {"run_id": "30", "run_attempt": "1", "event_name": "workflow_dispatch",
                   "control_sha": MAIN, "repository": "owner/repo", "actor": "Owner"}
        if queued:
            queue_recovery(data, config, inputs=inputs, trigger=trigger,
                           now=NOW - timedelta(minutes=12))
        return data, config, inputs, trigger

    def test_explicit_recovery_precedes_cooldown_and_daily_cap_without_approving_work(self):
        for cap, reason in ((24, "cooldown"), (1, "daily_cap")):
            with self.subTest(cap=cap):
                data, config, inputs, trigger = self.fixture(cap=cap, queued=False)
                data["tasks"].append(task())
                baseline = health(data, config)
                self.assertEqual((baseline["action"], baseline["reason"]), ("none", reason))
                self.assertEqual(baseline["health"], "attention")
                request = queue_recovery(data, config, inputs=inputs, trigger=trigger,
                                         now=NOW - timedelta(minutes=12))
                before = copy.deepcopy(data)
                result = health(data, config)
                self.assertEqual((result["action"], result["reason"], result["due_at"]),
                                 ("next_task", "owner_report_recovery_due", "2026-09-13T11:48:00Z"))
                self.assertEqual(result["owner_recovery"],
                                 {"request_id": request["request_id"], "inputs": inputs})
                self.assertEqual(result["health"], "attention")
                self.assertIn("report_invalid", [item["reason"] for item in result["attention"]])
                self.assertEqual((result["pending_proposals"], result["approved_proposals"]), (1, 0))
                self.assertEqual((result["scheduler"]["overdue_seconds"], result["scheduler"]["state"]),
                                 (12 * 60, "overdue"))
                self.assertFalse(select(data, task_id="fix")["selected"])
                self.assertEqual(data, before)

    def test_busy_next_disabled_switch_and_sync_compatibility_keep_authority(self):
        data, config, _, _ = self.fixture()
        before = copy.deepcopy(data)
        for overrides, reason in (
            ({"enabled": False}, "loop_disabled"),
            ({"runs": [run(status="in_progress", conclusion=None)]}, "next_task_running"),
            ({"sync_runs": [run(status="in_progress", conclusion=None)]}, "sync_running"),
        ):
            with self.subTest(reason=reason):
                result = health(data, config, **overrides)
                self.assertEqual((result["action"], result["reason"]), ("none", reason))
        incompatible = health(data, config, main_is_ancestor=False)
        self.assertEqual((incompatible["action"], incompatible["reason"]), ("sync", "sync_required"))
        self.assertEqual(data, before)

    def test_current_receiver_does_not_grant_an_unclaimed_observer_executor_rights(self):
        data, config, inputs, trigger = self.fixture(queued=False)
        journal = JournalHealthTest()
        data = journal.fixture(tasks=data["tasks"], executor=True, workflow=CONTINUE,
                               repository="owner/repo")
        request = queue_recovery(data, config, inputs=inputs, trigger=trigger,
                                 now=NOW - timedelta(minutes=12))
        before = copy.deepcopy(data)
        receiver = run(id=20, status="in_progress", conclusion=None,
                       head_repository={"full_name": "owner/repo"})
        blocked = health(data, config, runs=[], wakeup_runs=[receiver], current_run_id="20")
        self.assertEqual((blocked["action"], blocked["reason"]), ("none", "dispatch_journal_executing"))
        admitted = health(data, config, runs=[], wakeup_runs=[receiver], current_run_id="20",
                          observer_context=journal.observer_context())
        self.assertEqual((admitted["action"], admitted["reason"]),
                         ("next_task", "owner_report_recovery_due"))
        self.assertEqual(admitted["owner_recovery"]["request_id"], request["request_id"])
        self.assertEqual(data, before)

    def test_failed_ticks_back_off_the_owner_command_without_losing_it(self):
        data, config, _, _ = self.fixture()
        before = copy.deepcopy(data)
        result = health(data, config, runs=[run(conclusion="failure")])
        self.assertEqual((result["action"], result["reason"], result["due_at"]),
                         ("none", "tick_backoff", "2026-09-13T12:05:00Z"))
        self.assertEqual((result["scheduler"]["failed_ticks"], result["scheduler"]["state"]), (1, "waiting"))
        resumed = health(data, config, now=NOW + timedelta(minutes=5), runs=[run(conclusion="failure")])
        self.assertEqual((resumed["action"], resumed["reason"]), ("next_task", "owner_report_recovery_due"))
        self.assertEqual(result["owner_recovery"], resumed["owner_recovery"])
        self.assertEqual(data, before)

    def test_invalid_authorization_or_rebound_attempt_blocks_instead_of_automatic_fallback(self):
        for change in ("owner", "repository", "session_id", "dispatch_key", "attempts", "base_sha", "inputs"):
            with self.subTest(change=change):
                data, config, _, _ = self.fixture()
                data["tasks"].append(task(id="ordinary-research", task_type="project_discovery"))
                if change == "owner":
                    config["merge_gate"]["owner_approvers"] = ["DifferentOwner"]
                elif change == "repository":
                    config["repository"] = "foreign/repo"
                elif change == "inputs":
                    data["controller"]["owner_recovery_requests"][0]["inputs"]["automatic"] = True
                else:
                    data["tasks"][0]["execution"][change] = {
                        "session_id": "456", "dispatch_key": "attempt-two", "attempts": 2, "base_sha": MAIN,
                    }[change]
                    if change == "dispatch_key":
                        data["tasks"][0]["execution"]["starting_branch"] = "autonomous/attempt-attempt-two"
                before = copy.deepcopy(data)
                result = health(data, config)
                self.assertEqual((result["health"], result["action"], result["reason"]),
                                 ("attention", "none", "owner_report_recovery_invalid"))
                self.assertEqual(result["scheduler"]["state"], "blocked")
                self.assertNotIn("owner_recovery", result)
                self.assertIn("owner_report_recovery_invalid", [item["reason"] for item in result["attention"]])
                self.assertIn("report_invalid", [item["reason"] for item in result["attention"]])
                self.assertEqual(data, before)


class ResearchDispositionHealthTest(unittest.TestCase):
    def closed(self, *, exhausted=False):
        stamp = NOW.isoformat()
        source = {"session_id": "saved", "dispatch_key": "attempt",
                  "activity_id": "sessions/saved/activities/report", "activity_created_at": stamp,
                  "report_sha256": "a" * 64}
        execution = {"state": "awaiting_report", "outcome": "report_invalid", "session_id": "saved",
                     "dispatch_key": "attempt", "attempts": 2, "session_state": "FAILED",
                     "finished_at": stamp,
                     "report_error": {"code": "research_json", "detail": "Malformed report",
                                      "reported_at": stamp, "source": source}}
        if exhausted:
            execution.update(state="exhausted", outcome="failed")
            del execution["report_error"]
        data = queue(task(id="research", task_type="project_discovery", status="blocked", execution=execution))
        data["controller"] = {"last_tick_at": stamp}
        close_research_unaccepted(data, {"merge_gate": {"owner_approvers": ["Owner"]}},
                                  task_id="research", actor="Owner", note="Reviewed incident", now=stamp)
        return data

    def test_acknowledged_failures_remain_visible_without_repeating_old_attention(self):
        for exhausted in (False, True):
            with self.subTest(exhausted=exhausted):
                data = self.closed(exhausted=exhausted)
                before = copy.deepcopy(data)
                result = health(data)
                self.assertEqual([item["task_id"] for item in result["acknowledged"]], ["research"])
                self.assertEqual(result["acknowledged"][0]["disposition"],
                                 data["tasks"][0]["research_disposition"]["events"][0])
                self.assertFalse(any(item.get("task_id") == "research" for item in result["attention"]))
                self.assertEqual(data, before)
                del data["tasks"][0]["research_disposition"]
                fresh = health(data)
                self.assertEqual(fresh["acknowledged"], [])
                self.assertIn("research_failed" if exhausted else "report_invalid",
                              [item["reason"] for item in fresh["attention"]])

    def test_new_diagnostics_source_identity_and_unsettled_repair_restore_attention(self):
        for change in ("fresh_error", "source", "identity", "last_error", "pending_repair", "unknown"):
            with self.subTest(change=change):
                data = self.closed()
                execution = data["tasks"][0]["execution"]
                if change == "fresh_error":
                    execution["report_error"]["reported_at"] = (NOW + timedelta(minutes=1)).isoformat()
                elif change == "source":
                    execution["report_error"]["source"]["report_sha256"] = "b" * 64
                elif change == "identity":
                    execution["session_id"] = "replacement"
                    source = execution["report_error"]["source"]
                    source.update(session_id="replacement", activity_id="sessions/replacement/activities/report")
                elif change == "last_error":
                    execution["last_error"] = "Session GET failed"
                elif change == "pending_repair":
                    execution["report_repair"] = {"at": NOW.isoformat(), "result": "sent", "status": "pending"}
                else:
                    execution["session_state"] = "UNKNOWN"
                before = copy.deepcopy(data)
                result = health(data)
                self.assertEqual(result["acknowledged"], [])
                self.assertEqual(result["health"], "attention")
                self.assertIn("research_disposition_attention", [item["reason"] for item in result["attention"]])
                self.assertEqual(data, before)

    def test_recovery_authorization_and_transport_failure_need_attention_but_parser_failure_can_stay_acknowledged(self):
        for reason in (None, "research_json", "report_source_unavailable"):
            with self.subTest(reason=reason):
                data = self.closed()
                research = data["tasks"][0]
                append_recovery_event(research, "recover_authorized", now=NOW.isoformat(), actor="Owner",
                                      source=research["execution"]["report_error"]["source"])
                if reason:
                    append_recovery_event(research, "recovery_failed", now=NOW.isoformat(), reason=reason)
                result = health(data)
                self.assertEqual(bool(result["acknowledged"]), reason == "research_json")
                self.assertEqual(any(item["reason"] == "research_disposition_attention"
                                    for item in result["attention"]), reason != "research_json")

    def test_active_worker_and_real_proposal_are_never_hidden_by_old_closure(self):
        for active in (True, False):
            with self.subTest(active=active):
                data = self.closed()
                research = data["tasks"][0]
                execution = research["execution"]
                del execution["report_error"]
                prs = []
                if active:
                    research["status"] = "in_progress"
                    execution.update(state="dispatched", outcome="", session_state="IN_PROGRESS",
                                     observed_at=(NOW - timedelta(days=2)).isoformat())
                else:
                    proposed, pr = proposal()
                    execution.update(copy.deepcopy(proposed["execution"]))
                    execution["session_state"] = "COMPLETED"
                    pr["mergeable"] = False
                    prs.append(pr)
                before = copy.deepcopy(data)
                result = health(data, pull_requests=prs)
                self.assertEqual(result["acknowledged"], [])
                self.assertIn("worker_stale" if active else "proposal_conflict",
                              [item["reason"] for item in result["attention"]])
                self.assertIn("research_disposition_attention", [item["reason"] for item in result["attention"]])
                if not active:
                    self.assertEqual(result["proposals"][0]["pull_request"], 9)
                self.assertEqual(data, before)


    def test_successful_recovery_retires_old_attention_but_not_new_execution_errors(self):
        data = self.closed()
        research = data["tasks"][0]
        source = copy.deepcopy(research["execution"]["report_error"]["source"])
        append_recovery_event(research, "recover_authorized", now=NOW.isoformat(), actor="Owner", source=source)
        research["research_result"] = {
            "summary": "Recovered observations", "completed_at": NOW.isoformat(), "source": source,
            "observations": [{"scenario": "Resume", "evidence": "Clock trace", "result": "Advanced"}],
            "next_hypotheses": [], "proposed_task_ids": [],
        }
        complete(data, "research", outcome="no_change", retry_report=True, now=NOW)
        append_recovery_event(research, "report_accepted", now=NOW.isoformat(), source=source)
        result = health(data)
        self.assertEqual(result["acknowledged"], [])
        self.assertFalse(any(item.get("task_id") == "research" for item in result["attention"]))
        research["execution"]["last_error"] = "Subsequent identity lookup failed"
        result = health(data)
        self.assertEqual(result["health"], "attention")
        self.assertIn("research_disposition_attention", [item["reason"] for item in result["attention"]])


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
            next_runs = [own, pending]
            active_syncs = []

            def get(path, *, paginate=False):
                workflow = path.split("/")[2]
                status = parse_qs(urlsplit(path).query)["status"][0]
                values = []
                if workflow == "autonomous_next_task.yml":
                    values = [item for item in next_runs if item["status"] == status]
                elif workflow == "autonomous_continue.yml" and status == "pending":
                    values = [wakeup]
                elif workflow == "autonomous_sync.yml":
                    values = [item for item in active_syncs if item["status"] == status]
                page = {"total_count": len(values), "workflow_runs": values}
                return [page] if paginate else page

            blocked = inspect_health(data, config, repo=repo, enabled=True, now=NOW,
                                     current_run_id="11", get=get)
            self.assertEqual((blocked["action"], blocked["reason"]), ("none", "next_task_running"))
            next_runs.clear()
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
            for name, value in (("manifest", data), ("config", config), ("runs", []),
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
