#!/usr/bin/env python3
"""Bounded continuation and durable dispatch behavior with isolated Git state."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from continue_loop import CONFIRM_SECONDS, CONTINUE, NEXT, SYNC, Controller, Disabled, iso, safe_result
from dispatch_journal import JournalStore, normalize_inputs
from state_store import load_state
from workflow_admission import OWNER_RECOVERY

NOW = datetime(2026, 9, 16, 12, tzinfo=timezone.utc)
REPOSITORY = "owner/repo"
MAIN = "a" * 40
LAB = "b" * 40


class Clock:
    def __init__(self):
        self.seconds = 0
        self.sleeps = []

    def now(self):
        return NOW + timedelta(seconds=self.seconds)

    def monotonic(self):
        return self.seconds

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.seconds += seconds


def health(action="none", *, due=None, reason="research_cooldown", **changes):
    return {"health": "ok", "action": action, "reason": reason,
            "due_at": iso(due) if due else None, "main_sha": MAIN, "lab_sha": LAB,
            "scheduler": {"state": "waiting"}, **changes}


def run(run_id, title, **changes):
    return {"id": run_id, "display_title": title, "status": "queued", "event": "workflow_dispatch",
            "head_branch": "main", "head_repository": {"full_name": REPOSITORY},
            "html_url": f"https://github.com/{REPOSITORY}/actions/runs/{run_id}", **changes}


class Runtime:
    repository = REPOSITORY
    control_sha = MAIN

    def __init__(self, fixture, clock, observation, *, run_id="50", attempt="1", event="schedule"):
        self.fixture = fixture
        self.clock = clock
        self.observation = observation
        self.journal = fixture.store("runtime-" + run_id + "-" + attempt)
        self.trigger = {"run_id": run_id, "run_attempt": attempt, "event_name": event,
                        "control_sha": MAIN, "repository": REPOSITORY, "actor": "fixture"}
        self.continuation_key = ""
        self.receipt_id = ""
        self.disable_at = float("inf")
        self.posts = []
        self.observations = 0
        self.action_runs = {NEXT: [], CONTINUE: [], SYNC: []}
        self.on_post = self.accept
        self.on_runs = None
        self.on_context = None

    def recheck_context(self):
        if self.on_context:
            self.on_context()

    def enabled(self):
        return self.clock.seconds < self.disable_at

    def observe(self, *, observer_context=None):
        self.observations += 1
        value = copy.deepcopy(self.observation(self))
        revision = self.fixture.root / "observation-revision.json"
        load_state(self.fixture.repo, self.fixture.root / "observation.json", revision)
        value["state_sha"] = json.loads(revision.read_text(encoding="utf-8"))["state_sha"]
        return value

    def runs(self, workflow):
        if self.on_runs:
            return self.on_runs(workflow)
        return copy.deepcopy(self.action_runs[workflow])

    def dispatch(self, workflow, inputs):
        self.posts.append((workflow, dict(inputs)))
        self.on_post(workflow, inputs)

    def accept(self, workflow, inputs):
        title = ("Sync main " + inputs["main_sha"] + " " + inputs["continuation_key"] if workflow == SYNC else
                 ("Next " if workflow == NEXT else "Continue ") + inputs["continuation_key"])
        self.action_runs[workflow].append(run(100 + len(self.posts), title))


class ContinuationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.remote = self.root / "remote.git"
        self.repo = self.root / "lab"
        self.git(self.root, "init", "--bare", str(self.remote))
        self.git(self.root, "init", str(self.repo))
        self.git(self.repo, "config", "user.name", "fixture")
        self.git(self.repo, "config", "user.email", "fixture@example.invalid")
        self.git(self.repo, "config", "commit.gpgsign", "false")
        (self.repo / "agent_tasks.json").write_text(json.dumps({"version": 2, "tasks": [],
                                                                "autonomous_loop_policy": {}}), encoding="utf-8")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "synthetic fixture")
        self.git(self.repo, "branch", "-M", "autonomous/lab")
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.git(self.repo, "push", "origin", "HEAD")
        revision = self.root / "initial-revision.json"
        load_state(self.repo, self.root / "initial.json", revision)
        initial = json.loads(revision.read_text(encoding="utf-8"))["state_sha"]
        self.store("initialize").initialize(expected_sha=initial, control_sha=MAIN,
                                             basis={"kind": "fenced_bootstrap", "state_sha": initial,
                                                    "legacy_senders_fenced": True, "pending_legacy": "none"})

    def git(self, repo, *args):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()

    def store(self, name):
        return JournalStore(self.repo, self.root / (name + ".json"), self.root / (name + "-revision.json"))

    def controller(self, observation, **options):
        clock = Clock()
        runtime = Runtime(self, clock, observation)
        reports = []
        return (Controller(runtime, clock=clock, current_run_id=runtime.trigger["run_id"],
                           publish=reports.append, **options), runtime, clock, reports)

    def assert_dispatch(self, runtime, workflow, semantic):
        self.assertEqual(len(runtime.posts), 1)
        selected, inputs = runtime.posts[0]
        self.assertEqual(selected, workflow)
        posted_semantic = {key: value for key, value in inputs.items()
                           if key not in {"continuation_key", "control_sha"}}
        self.assertEqual(normalize_inputs(workflow, posted_semantic), normalize_inputs(workflow, semantic))
        self.assertEqual(inputs["control_sha"], MAIN)
        # Correlation is read back from the shared durable intent, not a local UUID.
        state = runtime.journal.current()
        intent, capability = runtime.journal.reserve_send(
            workflow, semantic, basis=state["active_intent"]["basis"], trigger=runtime.trigger, control_sha=MAIN)
        self.assertIsNone(capability)
        self.assertEqual(inputs["continuation_key"], intent["correlation_key"])
        return intent

    def test_future_due_self_continues_without_cron(self):
        due = NOW + timedelta(seconds=75)
        controller, runtime, clock, reports = self.controller(
            lambda rt: health(due=due) if rt.clock.now() < due else health("next_task", reason="research_due"))
        result = controller.run()
        self.assertEqual(result["outcome"], "handed_off")
        self.assert_dispatch(runtime, NEXT, {"automatic": "true"})
        self.assertGreaterEqual(clock.seconds, 75)
        self.assertEqual(result["handoff"]["run_id"], 101)
        self.assertTrue(any(report["outcome"] == "waiting" for report in reports))

    def test_long_cooldown_advances_once_and_exits_without_successor_wait(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health(due=NOW + timedelta(hours=3)))
        runtime.on_post = lambda workflow, inputs: None
        result = controller.run()
        self.assertEqual(result["outcome"], "handed_off")
        self.assertEqual(result["handoff"]["status"], "pending")
        self.assert_dispatch(runtime, CONTINUE, {})
        self.assertEqual(clock.seconds, 1800)
        receipt = runtime.journal.outcome_for_trigger(runtime.trigger)
        self.assertEqual(receipt["receipt_id"], controller.effect_receipt["receipt_id"])
        runtime.journal.advance(receipt["receipt_id"])
        repeated = Controller(runtime, clock=clock, current_run_id="50").run(handoff=True)
        self.assertEqual(len(runtime.posts), 1)
        self.assertNotEqual(repeated["outcome"], "error")

    def test_disable_during_wait_exits_without_dispatch(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health(due=NOW + timedelta(hours=3)))
        runtime.disable_at = 41
        self.assertEqual(controller.run()["outcome"], "disabled")
        self.assertEqual(runtime.posts, [])
        self.assertLessEqual(clock.seconds, 71)
        self.assertIsNone(runtime.journal.outcome_for_trigger(runtime.trigger))

    def test_busy_writer_is_waited_then_ready_work_dispatched(self):
        controller, runtime, clock, _ = self.controller(
            lambda rt: health(reason="next_task_running") if rt.clock.seconds < 60
            else health("next_task", reason="work_due"))
        self.assertEqual(controller.run()["outcome"], "handed_off")
        self.assertGreaterEqual(clock.seconds, 60)
        self.assert_dispatch(runtime, NEXT, {"automatic": "true"})

    def test_busy_writer_outlives_budget_and_timer_transfers(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health(reason="sync_running"), max_wait_seconds=60)
        self.assertEqual(controller.run()["outcome"], "handed_off")
        self.assert_dispatch(runtime, CONTINUE, {})
        self.assertEqual(clock.seconds, 60)

    def test_changed_queue_before_claim_prevents_stale_next(self):
        controller, runtime, _, _ = self.controller(
            lambda rt: health("next_task") if rt.observations == 1 else health(reason="awaiting_manual_approval"))
        result = controller.run()
        self.assertEqual(result["outcome"], "stopped")
        self.assertEqual(runtime.posts, [])

    def test_changed_heads_before_claim_refresh_sync_inputs(self):
        controller, runtime, _, _ = self.controller(
            lambda rt: health("sync", main_sha=MAIN if rt.observations == 1 else "e" * 40))
        self.assertEqual(controller.run()["outcome"], "handed_off")
        self.assert_dispatch(runtime, SYNC, {"main_sha": "e" * 40, "lab_sha": LAB})

    def test_changed_queue_after_claim_spends_permission_without_post(self):
        controller, runtime, _, _ = self.controller(
            lambda rt: health("next_task") if rt.observations < 3 else health(reason="awaiting_manual_approval"))
        result = controller.run()
        self.assertEqual(result["outcome"], "blocked")
        self.assertEqual(runtime.posts, [])
        state = runtime.journal.current()
        intent, cap = runtime.journal.reserve_send(NEXT, {"automatic": "true"}, basis=state["active_intent"]["basis"],
                                                  trigger=runtime.trigger, control_sha=MAIN)
        self.assertIsNone(cap)

    def test_lost_ack_reconciles_exact_run_without_retry(self):
        controller, runtime, _, _ = self.controller(lambda rt: health("next_task"))
        def lost_ack(workflow, inputs):
            runtime.accept(workflow, inputs)
            raise subprocess.TimeoutExpired("redacted", 20)
        runtime.on_post = lost_ack
        result = controller.run()
        self.assertEqual(result["handoff"]["status"], "confirmed")
        self.assertEqual(len(runtime.posts), 1)

    def test_lost_ack_stays_one_post_across_new_owner_and_attempt(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health("next_task"))
        runtime.on_post = lambda *args: (_ for _ in ()).throw(TimeoutError("lost ACK"))
        self.assertEqual(controller.run()["outcome"], "unknown")
        self.assertEqual(clock.seconds, CONFIRM_SECONDS)
        for run_id, attempt in (("50", "2"), ("70", "1")):
            other = Runtime(self, Clock(), lambda rt: health("next_task"), run_id=run_id, attempt=attempt)
            result = Controller(other, clock=other.clock, current_run_id=run_id).run()
            self.assertEqual(result["outcome"], "blocked")
            self.assertEqual(other.posts, [])
        self.assertEqual(len(runtime.posts), 1)

    def test_sync_lost_ack_keeps_durable_key_and_never_matches_old_main_title(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health("sync"))
        runtime.action_runs[SYNC] = [run(12, "Sync main " + MAIN, status="completed", conclusion="success")]
        runtime.on_post = lambda *args: (_ for _ in ()).throw(TimeoutError("lost ACK"))
        result = controller.run()
        self.assertEqual(result["outcome"], "unknown")
        self.assert_dispatch(runtime, SYNC, {"main_sha": MAIN, "lab_sha": LAB})
        self.assertNotIn("run_id", result["handoff"])
        self.assertEqual(clock.seconds, CONFIRM_SECONDS)

    def test_foreign_changed_inputs_active_slot_is_blocked(self):
        controller, runtime, _, _ = self.controller(lambda rt: health("sync"))
        runtime.journal.reserve_send(NEXT, {"automatic": "true"}, basis={},
                                     trigger={**runtime.trigger, "run_id": "49"}, control_sha=MAIN)
        self.assertEqual(controller.run()["outcome"], "blocked")
        self.assertEqual(runtime.posts, [])

    def test_title_only_callbacks_cannot_replace_or_grant_next_send(self):
        controller, runtime, _, _ = self.controller(lambda rt: health("next_task"))
        def cancelled(workflow, inputs):
            runtime.accept(workflow, inputs)
            runtime.action_runs[workflow][-1].update(status="completed", conclusion="cancelled")
            runtime.action_runs[CONTINUE].append(run(102, "Continue trusted callback 102", event="workflow_run",
                                                      status="in_progress", head_sha=MAIN))
        runtime.on_post = cancelled
        result = controller.run()
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(result["handoff"]["run_id"], 101)
        self.assertEqual(len(runtime.posts), 1)
        repeated = Controller(runtime, clock=runtime.clock, current_run_id="50").run()
        self.assertEqual(repeated["outcome"], "blocked")
        self.assertEqual(len(runtime.posts), 1)

    def test_handoff_requires_verified_source_receipt(self):
        controller, runtime, _, _ = self.controller(lambda rt: health("next_task"))
        self.assertEqual(controller.run(handoff=True)["outcome"], "blocked")
        self.assertEqual(runtime.posts, [])
        self.assertEqual(runtime.observations, 0)

    def test_wrong_receipt_id_cannot_authorize_handoff(self):
        controller, runtime, _, _ = self.controller(lambda rt: health(due=NOW + timedelta(hours=2)), max_wait_seconds=30)
        controller.run()
        runtime.receipt_id = "foreign-receipt"
        result = Controller(runtime, clock=runtime.clock, current_run_id="50").run(handoff=True)
        self.assertEqual(result["outcome"], "blocked")
        self.assertEqual(len(runtime.posts), 1)

    def test_observed_disable_is_terminal_even_if_switch_is_reenabled(self):
        controller, runtime, _, _ = self.controller(lambda rt: health("next_task"))
        runtime.on_post = lambda *args: (_ for _ in ()).throw(TimeoutError("lost"))
        def briefly_disabled(workflow):
            runtime.on_runs = None
            raise Disabled("loop_disabled")
        runtime.on_runs = briefly_disabled
        self.assertEqual(controller.run()["outcome"], "disabled")
        self.assertEqual(len(runtime.posts), 1)

    def test_reconciliation_failure_never_retries_post(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health("next_task"))
        def unavailable(*args):
            raise TimeoutError("private endpoint body")
        runtime.on_post = unavailable
        runtime.on_runs = unavailable
        result = controller.run()
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(len(runtime.posts), 1)
        self.assertEqual(clock.seconds, CONFIRM_SECONDS)
        self.assertNotIn("private endpoint", json.dumps(result))

    def test_ack_without_trusted_matching_successor_is_pending(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health("next_task"))
        def foreign(workflow, inputs):
            title = "Next " + inputs["continuation_key"]
            runtime.action_runs[NEXT] = [run(51, title, head_branch="feature"), run(52, title, event="push"),
                                        run(53, title, head_repository={"full_name": "fork/repo"}),
                                        run(50, title, status="in_progress")]
        runtime.on_post = foreign
        self.assertEqual(controller.run()["outcome"], "pending")
        self.assertEqual(len(runtime.posts), 1)
        self.assertEqual(clock.seconds, CONFIRM_SECONDS)

    def test_snapshot_failure_backs_off_then_stops_redacted(self):
        def unavailable(rt):
            raise RuntimeError("secret transport body")
        controller, runtime, clock, _ = self.controller(unavailable)
        result = controller.run()
        self.assertEqual(result["outcome"], "error")
        self.assertEqual(clock.seconds, 50)
        self.assertEqual(runtime.posts, [])
        self.assertNotIn("secret transport body", json.dumps(result))

    def test_manual_block_does_not_dispatch(self):
        controller, runtime, _, _ = self.controller(lambda rt: health(reason="awaiting_manual_approval"))
        self.assertEqual(controller.run()["outcome"], "stopped")
        self.assertEqual(runtime.posts, [])

    def test_uninitialized_journal_fails_closed(self):
        self.git(self.remote, "update-ref", "-d", "refs/heads/autonomous/state")
        controller, runtime, _, _ = self.controller(lambda rt: health("next_task"))
        self.assertIn(controller.run()["outcome"], {"blocked", "error"})
        self.assertEqual(runtime.posts, [])

    def test_slow_switch_reads_never_request_negative_sleep(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health())
        def slow_enabled():
            clock.seconds += 6
            return True
        runtime.enabled = slow_enabled
        controller.pause(5)
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(clock.seconds, 12)

    def test_output_redacts_nested_secret_values(self):
        result = safe_result({"health": {"reason": "failed private-value"},
                              "handoff": {"url": "https://github.com/o/r/actions/runs/1?secret=private-value"}},
                             ["private-value"])
        self.assertNotIn("private-value", json.dumps(result))
        self.assertIn("REDACTED", result["health"]["reason"])

    def test_coalescible_callback_cannot_replace_a_live_pending_receiver(self):
        controller, runtime, _, _ = self.controller(lambda rt: health(due=NOW + timedelta(hours=3)),
                                                   max_wait_seconds=1)
        self.assertEqual(controller.run()["outcome"], "handed_off")
        intent = runtime.journal.current()["active_intent"]
        before = runtime.journal.current()
        clock = Clock()
        callback = Runtime(self, clock, lambda rt: health("next_task"), run_id="99", event="workflow_run")
        callback.trigger.update(source_run_id="77", source_run_attempt="1")
        callback.action_runs[CONTINUE] = copy.deepcopy(runtime.action_runs[CONTINUE])
        result = Controller(callback, clock=clock, current_run_id="99").run()
        self.assertEqual((result["outcome"], result["reason"]), ("coalesced", "existing_receiver_active"))
        self.assertEqual((callback.posts, callback.observations), ([], 0))
        self.assertEqual(result["decision_id"], intent["decision_id"])
        self.assertEqual(runtime.journal.current(), before)

    def assert_fenced_late_wake(self, workflow, *, handoff):
        clock = Clock()
        sender = Runtime(self, clock, lambda rt: health("next_task"), run_id="70")
        inputs = ({"main_sha": MAIN, "lab_sha": LAB} if workflow == SYNC else
                  {"automatic": "true"} if workflow == NEXT else {})
        intent, send = sender.journal.reserve_send(
            workflow, inputs, basis={}, trigger=sender.trigger, control_sha=MAIN)
        send.consume()
        state = sender.journal.current()
        owner = {"run_id": "71", "run_attempt": "1", "event_name": "workflow_dispatch",
                 "control_sha": MAIN, "repository": REPOSITORY, "actor": "owner",
                 "workflow": OWNER_RECOVERY, "ref": "refs/heads/main",
                 "expected_state_sha": state["state_sha"], "decision_id": intent["decision_id"]}
        sender.journal.fence_unclaimed(
            decision_id=intent["decision_id"], expected_state_sha=state["state_sha"],
            owner_trigger=owner, config={"repository": REPOSITORY,
                                         "merge_gate": {"owner_approvers": ["owner"]}})
        before = sender.journal.current()
        late = Runtime(self, clock, lambda rt: health("next_task"), run_id="72", event="workflow_dispatch")
        late.continuation_key = intent["correlation_key"]
        if handoff:
            late.control_sha = "d" * 40
            late.trigger["control_sha"] = late.control_sha
        def unavailable_runs(workflow):
            raise AssertionError("a durable owner fence must not need Actions delivery observations")
        late.on_runs = unavailable_runs
        result = Controller(late, clock=clock, current_run_id="72").run(handoff=handoff)
        self.assertEqual((result["outcome"], result["reason"]), ("stopped", "delivery_owner_fenced"))
        self.assertEqual(result["decision_id"], intent["decision_id"])
        self.assertEqual((late.posts, late.observations, clock.seconds), ([], 0, 0))
        self.assertEqual(sender.journal.current(), before)
        self.assertEqual((before["effects"], before["completions"], before["executor_claims"]), ({}, {}, {}))

    def test_fenced_late_continue_stops_without_observation_or_send(self):
        self.assert_fenced_late_wake(CONTINUE, handoff=False)

    def test_fenced_late_next_handoff_cannot_create_a_completion_or_successor(self):
        self.assert_fenced_late_wake(NEXT, handoff=True)

    def test_fenced_late_sync_handoff_uses_owner_stop_not_an_execution_outcome(self):
        self.assert_fenced_late_wake(SYNC, handoff=True)


    def test_spent_executor_without_outcome_is_not_suppressed_as_benign(self):
        clock = Clock()
        original = Runtime(self, clock, lambda rt: health("next_task"), run_id="88", event="schedule")
        intent, capability = original.journal.admit(CONTINUE, {}, key="", trigger=original.trigger, control_sha=MAIN)
        capability.consume()
        before = original.journal.current()
        for handoff in (False, True):
            with self.subTest(handoff=handoff):
                result = Controller(original, clock=clock, current_run_id="88").run(handoff=handoff)
                self.assertEqual((result["outcome"], result["reason"]), ("blocked", "executor_without_outcome"))
                self.assertEqual((original.posts, original.observations), ([], 0))
                self.assertEqual(result["decision_id"], intent["decision_id"])
                self.assertEqual(original.journal.current(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
