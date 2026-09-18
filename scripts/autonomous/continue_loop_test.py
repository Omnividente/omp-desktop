#!/usr/bin/env python3
"""Bounded timer and correlated handoff contracts without a scheduler or network."""
from __future__ import annotations

import copy
import json
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from continue_loop import (API_TIMEOUT, CONFIRM_SECONDS, CONTINUE, NEXT, SYNC,
                           ContinuationGitHub, Controller, Disabled, iso, safe_result)

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


def health(action="none", *, due=None, reason="research_cooldown", state="waiting", **changes):
    return {"health": "ok", "action": action, "reason": reason, "due_at": iso(due) if due else None,
            "research_next_at": iso(due) if due else None, "main_sha": MAIN, "lab_sha": LAB,
            "state_sha": "c" * 40, "scheduler": {"state": state}, **changes}


def run(run_id, title, **changes):
    return {"id": run_id, "display_title": title, "status": "queued", "event": "workflow_dispatch",
            "head_branch": "main", "head_repository": {"full_name": REPOSITORY},
            "html_url": f"https://github.com/{REPOSITORY}/actions/runs/{run_id}", **changes}


class Runtime:
    repository = REPOSITORY

    def __init__(self, clock, observe):
        self.clock = clock
        self.observation = observe
        self.disable_at = float("inf")
        self.posts = []
        self.observations = 0
        self.action_runs = {NEXT: [], CONTINUE: [], SYNC: []}
        self.on_post = self.accept
        self.on_runs = None

    def enabled(self):
        return self.clock.seconds < self.disable_at

    def observe(self):
        self.observations += 1
        return copy.deepcopy(self.observation(self))

    def runs(self, workflow):
        if self.on_runs:
            return self.on_runs(workflow)
        return copy.deepcopy(self.action_runs[workflow])

    def dispatch(self, workflow, inputs):
        self.posts.append((workflow, dict(inputs)))
        self.on_post(workflow, inputs)

    def accept(self, workflow, inputs):
        title = ("Sync main " + inputs["main_sha"] if workflow == SYNC else
                 ("Next " if workflow == NEXT else "Continue ") + inputs["continuation_key"])
        self.action_runs[workflow].append(run(100 + len(self.posts), title))


class ContinuationTest(unittest.TestCase):
    def controller(self, observation, **options):
        clock = Clock()
        runtime = Runtime(clock, observation)
        reports = []
        controller = Controller(runtime, clock=clock, current_run_id="50", publish=reports.append,
                                new_key=lambda: "opaque-key", **options)
        return controller, runtime, clock, reports

    def test_future_due_self_continues_without_cron(self):
        due = NOW + timedelta(seconds=75)
        controller, runtime, clock, reports = self.controller(
            lambda rt: health(due=due) if rt.clock.now() < due else health("next_task", reason="research_due"))
        result = controller.run()
        self.assertEqual(result["outcome"], "handed_off")
        self.assertEqual(runtime.posts, [(NEXT, {"automatic": "true", "continuation_key": "opaque-key"})])
        self.assertGreaterEqual(clock.seconds, 75)
        self.assertEqual(result["handoff"]["run_id"], 101)
        self.assertTrue(any(report["outcome"] == "waiting" for report in reports))

    def test_long_cooldown_waits_full_window_then_hands_to_continue(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health(due=NOW + timedelta(hours=3)))
        # Seeing oneself in the run list must never establish a successor.
        runtime.action_runs[CONTINUE] = [run(50, "Continue parent", status="in_progress")]
        result = controller.run()
        self.assertEqual(runtime.posts, [(CONTINUE, {"continuation_key": "opaque-key"})])
        self.assertGreaterEqual(clock.seconds, 1800)
        self.assertLess(clock.seconds, 1800 + CONFIRM_SECONDS)
        self.assertEqual(result["handoff"]["run_id"], 101)

    def test_disable_during_wait_exits_without_dispatch(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health(due=NOW + timedelta(hours=3)))
        runtime.disable_at = 41
        result = controller.run()
        self.assertEqual(result["outcome"], "disabled")
        self.assertEqual(runtime.posts, [])
        self.assertLessEqual(clock.seconds, 71)

    def test_busy_writer_is_waited_not_abandoned_to_completion_event(self):
        controller, runtime, clock, _ = self.controller(
            lambda rt: health(reason="next_task_running", state="blocked") if rt.clock.seconds < 60
            else health("next_task", reason="work_due"))
        result = controller.run()
        self.assertEqual(result["outcome"], "handed_off")
        self.assertGreaterEqual(clock.seconds, 60)
        self.assertEqual([post[0] for post in runtime.posts], [NEXT])

    def test_busy_writer_outlives_budget_and_timer_transfers(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health(reason="sync_running", state="blocked"),
                                                       max_wait_seconds=60)
        result = controller.run()
        self.assertEqual(result["outcome"], "handed_off")
        self.assertEqual([post[0] for post in runtime.posts], [CONTINUE])
        self.assertGreaterEqual(clock.seconds, 60)

    def test_changed_queue_before_effect_prevents_stale_next(self):
        controller, runtime, _, _ = self.controller(
            lambda rt: health("next_task", reason="work_due") if rt.observations == 1
            else health(reason="awaiting_manual_approval", state="blocked", state_sha="d" * 40))
        result = controller.run()
        self.assertEqual(result["outcome"], "stopped")
        self.assertEqual(result["reason"], "awaiting_manual_approval")
        self.assertEqual(runtime.posts, [])

    def test_changed_heads_refresh_sync_inputs_before_dispatch(self):
        controller, runtime, _, _ = self.controller(
            lambda rt: health("sync", reason="sync_required", main_sha=MAIN if rt.observations == 1 else "e" * 40))
        result = controller.run()
        self.assertEqual(result["outcome"], "handed_off")
        self.assertEqual(runtime.posts, [(SYNC, {"main_sha": "e" * 40, "lab_sha": LAB})])

    def test_repeated_signal_reuses_pending_but_not_running_continue(self):
        controller, runtime, _, _ = self.controller(lambda rt: health())
        runtime.action_runs[CONTINUE] = [run(50, "Continue self", status="in_progress"),
                                         run(60, "Continue pending", status="pending")]
        first = controller.run(handoff=True)
        second = controller.run(handoff=True)
        self.assertEqual(first["handoff"]["run_id"], 60)
        self.assertEqual(second["handoff"]["run_id"], 60)
        self.assertEqual(runtime.posts, [])

    def test_pending_fallback_can_take_over_but_foreign_run_cannot(self):
        controller, runtime, _, _ = self.controller(lambda rt: health())
        runtime.action_runs[CONTINUE] = [run(1, "Continue foreign", head_repository={"full_name": "fork/repo"}),
                                         run(60, "Autonomous Continue", event="schedule")]
        result = controller.run(handoff=True)
        self.assertEqual(result["handoff"]["run_id"], 60)
        self.assertEqual(runtime.posts, [])

    def test_unverified_callback_cannot_replace_an_explicit_successor(self):
        controller, runtime, _, _ = self.controller(lambda rt: health())
        # workflow_run itself uses main even if its upstream feature/fork run
        # makes the continuation job ineligible. The listing omits that proof.
        runtime.action_runs[CONTINUE] = [run(60, "Autonomous Continue", event="workflow_run")]
        result = controller.run(handoff=True)
        self.assertEqual(result["handoff"]["run_id"], 101)
        self.assertEqual(runtime.posts, [(CONTINUE, {"continuation_key": "opaque-key"})])

    def test_timeout_reconciles_exact_run_before_any_retry(self):
        controller, runtime, _, _ = self.controller(lambda rt: health("next_task", reason="work_due"))
        def lost_ack(workflow, inputs):
            runtime.accept(workflow, inputs)
            raise subprocess.TimeoutExpired("redacted", 20)
        runtime.on_post = lost_ack
        result = controller.run()
        self.assertEqual(result["handoff"]["status"], "confirmed")
        self.assertEqual(len(runtime.posts), 1)

    def test_cancelled_successor_is_not_confirmed_delivery(self):
        controller, runtime, _, _ = self.controller(lambda rt: health("next_task", reason="work_due"))
        def cancelled(workflow, inputs):
            runtime.accept(workflow, inputs)
            runtime.action_runs[workflow][-1].update(status="completed", conclusion="cancelled")
        runtime.on_post = cancelled
        result = controller.run()
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(result["handoff"]["status"], "failed")
        self.assertEqual(result["handoff"]["run_id"], 101)
        self.assertEqual(len(runtime.posts), 1)

    def test_observed_disable_is_terminal_even_if_switch_is_reenabled(self):
        controller, runtime, _, _ = self.controller(lambda rt: health("next_task", reason="work_due"))
        def timeout(*args):
            raise TimeoutError("lost acknowledgement")
        def briefly_disabled(workflow):
            runtime.on_runs = None
            raise Disabled("loop_disabled")
        runtime.on_post = timeout
        runtime.on_runs = briefly_disabled
        result = controller.run()
        self.assertEqual(result["outcome"], "disabled")
        self.assertEqual(len(runtime.posts), 1)

    def test_ambiguous_retry_keeps_one_operation_identity(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health("next_task", reason="work_due"))
        def retry_once(workflow, inputs):
            if len(runtime.posts) == 1:
                raise TimeoutError("transport lost")
            runtime.accept(workflow, inputs)
        runtime.on_post = retry_once
        result = controller.run()
        self.assertEqual(result["handoff"]["status"], "confirmed")
        self.assertEqual(runtime.posts, [(NEXT, {"automatic": "true", "continuation_key": "opaque-key"})] * 2)
        self.assertGreaterEqual(clock.seconds, 15)

    def test_reconciliation_failure_never_blindly_retries_post(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health("next_task", reason="work_due"))
        def timeout(*args):
            raise TimeoutError("private endpoint body")
        runtime.on_post = timeout
        runtime.on_runs = timeout
        result = controller.run()
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(len(runtime.posts), 1)
        self.assertGreaterEqual(clock.seconds, CONFIRM_SECONDS)
        self.assertNotIn("private endpoint", json.dumps(result))

    def test_ack_without_matching_successor_is_not_confirmation(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health("next_task", reason="work_due"))
        runtime.on_post = lambda workflow, inputs: None
        runtime.action_runs[NEXT] = [run(51, "Next different"),
                                    run(52, "Next opaque-key", head_branch="feature"),
                                    run(53, "Next opaque-key", event="push"),
                                    run(54, "Next opaque-key", head_repository={"full_name": "fork/repo"}),
                                    run(50, "Next opaque-key", status="in_progress")]
        result = controller.run()
        self.assertEqual(result["handoff"]["status"], "pending")
        self.assertEqual(result["outcome"], "pending")
        self.assertNotIn("run_id", result["handoff"])
        self.assertEqual(len(runtime.posts), 1)
        self.assertEqual(clock.seconds, CONFIRM_SECONDS)

    def test_permanent_ambiguous_timeout_bounds_posts_and_wait(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health("next_task", reason="work_due"))
        def timeout(*args):
            raise TimeoutError("lost")
        runtime.on_post = timeout
        result = controller.run()
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(len(runtime.posts), 2)
        self.assertEqual(clock.seconds, CONFIRM_SECONDS)
        self.assertTrue(all(seconds > 0 for seconds in clock.sleeps))

    def test_sync_never_correlates_old_same_main_or_retries_ambiguous_post(self):
        controller, runtime, _, _ = self.controller(lambda rt: health("sync", reason="sync_required"))
        runtime.action_runs[SYNC] = [run(12, "Sync main " + MAIN, status="completed")]
        def timeout(*args):
            raise TimeoutError("lost")
        runtime.on_post = timeout
        result = controller.run()
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(len(runtime.posts), 1)
        self.assertNotIn("continuation_key", runtime.posts[0][1])
        self.assertNotIn("run_id", result["handoff"])

    def test_snapshot_failure_backs_off_then_stops_redacted(self):
        def fail(rt):
            raise RuntimeError("secret transport body")
        controller, runtime, clock, _ = self.controller(fail)
        result = controller.run()
        self.assertEqual(result["outcome"], "error")
        self.assertEqual(clock.seconds, 50)
        self.assertEqual(runtime.posts, [])
        self.assertNotIn("secret transport body", json.dumps(result))

    def test_manual_block_does_not_dispatch_implementation_inputs(self):
        controller, runtime, _, _ = self.controller(lambda rt: health(reason="awaiting_manual_approval", state="blocked"))
        result = controller.run()
        self.assertEqual(result["outcome"], "stopped")
        self.assertEqual(runtime.posts, [])

    def test_switch_read_longer_than_wait_never_requests_negative_sleep(self):
        controller, runtime, clock, _ = self.controller(lambda rt: health())
        def slow_enabled():
            clock.seconds += 6
            return True
        runtime.enabled = slow_enabled
        controller.pause(5)
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(clock.seconds, 12)

    def test_switch_transport_timeout_is_one_bounded_call_without_retry(self):
        github = ContinuationGitHub(REPOSITORY)
        with patch("continue_loop.subprocess.run", side_effect=subprocess.TimeoutExpired("gh", API_TIMEOUT)) as execute:
            with self.assertRaises(subprocess.TimeoutExpired):
                github.enabled()
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(execute.call_args.kwargs["timeout"], API_TIMEOUT)

    def test_output_remains_json_and_redacts_secret_values(self):
        result = safe_result({"health": {"reason": "failed private-value"},
                              "handoff": {"url": "https://github.com/o/r/actions/runs/1?secret=private-value"}},
                             ["private-value"])
        self.assertNotIn("private-value", json.dumps(result))
        self.assertIn("REDACTED", result["health"]["reason"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
