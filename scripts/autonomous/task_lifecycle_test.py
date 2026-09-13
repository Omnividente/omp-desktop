#!/usr/bin/env python3
"""Tests for task_lifecycle.py.

Every regression these tests pin was a real way for the loop to spin:

* a merge performed by the loop delivers no ``pull_request: closed`` event, so
  the task stayed ``in_progress`` until it was swept up as stale;
* an unrelated, hand-written pull request closed live autonomous work;
* ``no_change`` returned the task to the queue, so the same question was asked
  for ever;
* a worker session that was already dead was never counted as an attempt, so
  the dispatch key never changed and the loop rediscovered the same session.
"""
from __future__ import annotations

import copy
import json
import tempfile
from contextlib import redirect_stdout
from io import StringIO
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from task_lifecycle import (  # noqa: E402
    OUTCOME_CLOSED, OUTCOME_FAILED, OUTCOME_MERGED, OUTCOME_NO_CHANGE,
    attempts_of, close_from_pr, complete, counts, find_task,
    main, match_task, park_report, reconcile, start, sweep,
)
from select_task import select

NOW = datetime(2026, 9, 12, 12, 0, 0, tzinfo=timezone.utc)
TASK_ID = "auto-clock-1"
MARKER = "AUTONOMOUS_TASK_ID: " + TASK_ID


def task(task_id: str = TASK_ID, **overrides) -> dict:
    base = {
        "id": task_id,
        "title": "fix the clock",
        "task_type": "bugfix",
        "status": "todo",
        "priority": 50,
        "risk": "low",
    }
    base.update(overrides)
    return base


def manifest(*tasks, max_attempts: int = 2, stale_hours: int = 6) -> dict:
    return {
        "version": 2,
        "autonomous_loop_policy": {
            "integration_branch": "autonomous/lab",
            "lifecycle": {
                "max_attempts": max_attempts,
                "stale_in_progress_hours": stale_hours,
            },
        },
        "tasks": [dict(item) for item in tasks],
    }


def execution(data: dict, task_id: str = TASK_ID) -> dict:
    return find_task(data, task_id).get("execution") or {}


def status_of(data: dict, task_id: str = TASK_ID) -> str:
    return str(find_task(data, task_id).get("status"))


class StartTest(unittest.TestCase):
    def test_dispatch_records_the_session_and_counts_the_attempt(self):
        data = manifest(task())
        result = start(data, TASK_ID, session_id="sessions/1",
                       dispatch_key="deadbeefcafe0001", now=NOW)
        self.assertTrue(result["changed"])
        self.assertEqual(result["reason"], "dispatched")
        self.assertEqual(status_of(data), "in_progress")
        block = execution(data)
        self.assertEqual(block["attempts"], 1)
        self.assertEqual(block["session_id"], "sessions/1")
        self.assertEqual(block["dispatch_key"], "deadbeefcafe0001")
        self.assertEqual(block["started_at"], "2026-09-12T12:00:00Z")
        self.assertEqual(block["state"], "dispatched")

    def test_a_second_dispatch_counts_a_second_attempt(self):
        data = manifest(task(execution={"attempts": 1, "state": "retry"}))
        start(data, TASK_ID, dispatch_key="second", now=NOW)
        self.assertEqual(execution(data)["attempts"], 2)

    def test_dispatch_clears_the_previous_result(self):
        data = manifest(task(execution={
            "attempts": 1, "state": "retry", "outcome": OUTCOME_CLOSED,
            "pull_request": 41, "note": "closed without merging",
        }))
        start(data, TASK_ID, dispatch_key="second", now=NOW)
        block = execution(data)
        self.assertEqual(block["outcome"], "")
        self.assertEqual(block["pull_request"], 0)
        self.assertEqual(block["note"], "")

    def test_reconciled_start_preserves_attempt_age_and_linked_pr(self):
        data = manifest(task())
        start(data, TASK_ID, session_id="1", dispatch_key="first", now=NOW)
        execution(data)["pull_request"] = 7
        before = copy.deepcopy(data)
        result = start(data, TASK_ID, session_id="1", dispatch_key="first",
                       now=NOW + timedelta(hours=5))
        self.assertFalse(result["changed"])
        self.assertEqual(data, before)

    def test_rediscovering_a_finished_attempt_does_not_reopen_it(self):
        data = manifest(task())
        start(data, TASK_ID, session_id="1", dispatch_key="first", now=NOW)
        complete(data, TASK_ID, outcome=OUTCOME_FAILED, now=NOW)
        before = copy.deepcopy(data)
        self.assertFalse(start(data, TASK_ID, session_id="1", dispatch_key="first")["changed"])
        self.assertEqual(data, before)

    def test_new_session_cannot_replace_live_or_exhausted_work(self):
        data = manifest(task(), max_attempts=1)
        start(data, TASK_ID, dispatch_key="first", now=NOW)
        with self.assertRaises(ValueError):
            start(data, TASK_ID, dispatch_key="second", now=NOW)
        complete(data, TASK_ID, outcome=OUTCOME_FAILED, now=NOW)
        with self.assertRaises(ValueError):
            start(data, TASK_ID, dispatch_key="second", now=NOW)
        self.assertEqual(attempts_of(find_task(data, TASK_ID)), 1)

    def test_unknown_task_changes_nothing(self):
        data = manifest(task())
        result = start(data, "does-not-exist", now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(result["reason"], "task_not_found")
        self.assertEqual(status_of(data), "todo")


class MatchTest(unittest.TestCase):
    def test_task_id_marker_matches(self):
        data = manifest(task(status="in_progress"))
        matched, how = match_task(data, title="fix the clock", body=MARKER)
        self.assertEqual(how, "task_id_marker")
        self.assertEqual(matched["id"], TASK_ID)

    def test_dispatch_key_in_the_title_matches(self):
        data = manifest(task(status="in_progress", execution={"dispatch_key": "abc123"}))
        matched, how = match_task(data, title="[dispatch:abc123] fix the clock")
        self.assertEqual(how, "dispatch_key")
        self.assertEqual(matched["id"], TASK_ID)

    def test_recorded_pull_request_matches(self):
        data = manifest(task(status="in_progress", execution={"pull_request": 41}))
        matched, how = match_task(data, title="no markers", pull_request=41)
        self.assertEqual(how, "recorded_pull_request")
        self.assertEqual(matched["id"], TASK_ID)

    def test_a_pull_request_without_any_marker_is_unmatched(self):
        """Reported defect: a hand-written pull request closed live work."""
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        matched, how = match_task(
            data, title="chore: bump dependencies", body="no markers here",
            pull_request=999,
        )
        self.assertIsNone(matched)
        self.assertEqual(how, "unmatched")


class CloseFromPullRequestTest(unittest.TestCase):
    def test_merged_pull_request_finishes_the_task(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        result = close_from_pr(data, pull_request=7, body=MARKER, merged=True, now=NOW)
        self.assertEqual(result["reason"], OUTCOME_MERGED)
        self.assertEqual(result["status"], "done")
        self.assertEqual(status_of(data), "done")
        block = execution(data)
        self.assertEqual(block["pull_request"], 7)
        self.assertEqual(block["state"], "completed")
        self.assertEqual(block["finished_at"], "2026-09-12T12:00:00Z")

    def test_closed_pull_request_returns_the_task_to_the_queue(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        result = close_from_pr(data, pull_request=8, body=MARKER, merged=False, now=NOW)
        self.assertEqual(result["reason"], OUTCOME_CLOSED)
        self.assertEqual(result["status"], "todo")
        self.assertEqual(execution(data)["state"], "retry")

    def test_task_is_blocked_once_attempts_are_exhausted(self):
        data = manifest(task(), max_attempts=2)
        start(data, TASK_ID, dispatch_key="first", now=NOW)
        close_from_pr(data, pull_request=1, body=MARKER + "\n[dispatch:first]", merged=False, now=NOW)
        self.assertEqual(status_of(data), "todo")
        start(data, TASK_ID, dispatch_key="second", now=NOW)
        result = close_from_pr(data, pull_request=2, body=MARKER + "\n[dispatch:second]", merged=False, now=NOW)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(execution(data)["state"], "exhausted")
        self.assertEqual(attempts_of(find_task(data, TASK_ID)), 2)

    def test_unrelated_pull_request_cannot_close_a_task(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        result = close_from_pr(
            data, pull_request=999, title="chore: bump dependencies",
            body="opened by hand", merged=True, now=NOW,
        )
        self.assertFalse(result["changed"])
        self.assertEqual(result["reason"], "no_matching_task")
        self.assertEqual(result["matched_by"], "unmatched")
        self.assertEqual(status_of(data), "in_progress")

    def test_a_finished_task_is_left_alone(self):
        data = manifest(task(status="done", execution={"attempts": 1, "outcome": OUTCOME_MERGED}))
        result = close_from_pr(data, pull_request=7, body=MARKER, merged=False, now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(result["reason"], "task_already_closed")
        self.assertEqual(status_of(data), "done")

    def test_old_or_conflicting_markers_cannot_close_a_new_attempt(self):
        data = manifest(task(), task("other"))
        start(data, TASK_ID, dispatch_key="first", now=NOW)
        close_from_pr(data, pull_request=1, title="[dispatch:first]", merged=False, now=NOW)
        start(data, TASK_ID, dispatch_key="second", now=NOW)
        start(data, "other", dispatch_key="third", now=NOW)
        before = copy.deepcopy(data)
        for markers in (
            MARKER,
            MARKER + "\n[dispatch:first]",
            MARKER + "\n[dispatch:third]",
            MARKER + "\n[dispatch:second]\nAUTONOMOUS_TASK_ID: other",
            MARKER + "\n[dispatch:second]\n[dispatch:first]",
            "AUTONOMOUS_TASK_ID: missing\n[dispatch:second]",
            MARKER + "\nAUTONOMOUS_DISPATCH_KEY: secondlonger",
        ):
            with self.subTest(markers=markers):
                self.assertFalse(close_from_pr(data, pull_request=1, body=markers,
                                               merged=True, now=NOW)["changed"])
                self.assertEqual(data, before)
        result = close_from_pr(data, pull_request=2, body=MARKER + "\nAUTONOMOUS_DISPATCH_KEY: second",
                               merged=True, now=NOW)
        self.assertTrue(result["changed"])
        self.assertEqual(status_of(data), "done")
        self.assertEqual(status_of(data, "other"), "in_progress")

    def test_repeated_unmerged_close_does_not_spend_another_attempt(self):
        data = manifest(task())
        start(data, TASK_ID, dispatch_key="first", now=NOW)
        close_from_pr(data, pull_request=1, title="[dispatch:first]", now=NOW)
        before = copy.deepcopy(data)
        result = close_from_pr(data, pull_request=1, title="[dispatch:first]", now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(data, before)

    def test_contradictory_recorded_pr_cannot_close_another_task(self):
        data = manifest(task(status="in_progress", execution={"pull_request": 7}),
                        task("other", status="in_progress", execution={"dispatch_key": "otherkey"}))
        before = copy.deepcopy(data)
        self.assertFalse(close_from_pr(data, pull_request=7, title="[dispatch:otherkey]",
                                      merged=True, now=NOW)["changed"])
        self.assertEqual(data, before)


class CompleteTest(unittest.TestCase):
    def test_report_parking_prevents_redispatch_and_requires_explicit_completion(self):
        data = manifest(task(task_type="project_discovery"), max_attempts=1)
        start(data, TASK_ID, session_id="7", dispatch_key="first", now=NOW)
        park_report(data, TASK_ID, code="research_json", detail="invalid JSON", now=NOW)
        before = copy.deepcopy(data)
        self.assertFalse(reconcile(data, now=NOW + timedelta(days=1))["changed"])
        self.assertFalse(complete(data, TASK_ID, outcome=OUTCOME_NO_CHANGE, now=NOW)["changed"])
        self.assertFalse(park_report(data, TASK_ID, code="research_schema", detail="still invalid",
                                    now=NOW + timedelta(days=1))["changed"])
        self.assertEqual(data, before)
        with self.assertRaises(ValueError):
            start(data, TASK_ID, session_id="8", dispatch_key="second", now=NOW)
        with self.assertRaises(ValueError):
            complete(data, TASK_ID, outcome=OUTCOME_FAILED, retry_report=True, now=NOW)
        result = complete(data, TASK_ID, outcome=OUTCOME_NO_CHANGE, retry_report=True, now=NOW)
        self.assertEqual(result["status"], "done")
        self.assertEqual(execution(data)["attempts"], 1)
        self.assertEqual(execution(data)["session_id"], "7")
        self.assertEqual(execution(data)["dispatch_key"], "first")
        self.assertNotIn("report_error", execution(data))

    def test_merged_is_terminal(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        result = complete(data, TASK_ID, outcome=OUTCOME_MERGED, pull_request=5, now=NOW)
        self.assertEqual(result["status"], "done")
        self.assertEqual(execution(data)["pull_request"], 5)

    def test_no_change_is_terminal(self):
        """Reported defect: "nothing to change" was retried for ever."""
        data = manifest(task(status="in_progress", execution={"attempts": 1}), max_attempts=5)
        result = complete(data, TASK_ID, outcome=OUTCOME_NO_CHANGE, now=NOW)
        self.assertEqual(result["status"], "done")
        self.assertEqual(execution(data)["state"], "completed")

    def test_failure_is_retried_while_the_budget_lasts(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}), max_attempts=2)
        result = complete(data, TASK_ID, outcome=OUTCOME_FAILED, now=NOW)
        self.assertEqual(result["status"], "todo")
        self.assertEqual(execution(data)["state"], "retry")

    def test_a_session_that_was_already_dead_still_counts_as_an_attempt(self):
        """Reported defect: an unrecorded failure left the dispatch key unchanged,
        so the next tick found the same terminal session again."""
        data = manifest(task(status="todo"), max_attempts=2)
        result = complete(data, TASK_ID, outcome=OUTCOME_FAILED, now=NOW)
        self.assertEqual(execution(data)["attempts"], 1)
        self.assertEqual(result["status"], "todo")

    def test_a_dead_session_cannot_be_rediscovered_for_ever(self):
        data = manifest(task(status="todo"), max_attempts=1)
        result = complete(data, TASK_ID, outcome=OUTCOME_FAILED, now=NOW)
        self.assertEqual(result["status"], "blocked")

    def test_repeated_completion_cannot_spend_or_rewrite_an_attempt(self):
        data = manifest(task())
        complete(data, TASK_ID, outcome=OUTCOME_FAILED, now=NOW)
        before = copy.deepcopy(data)
        for outcome in (OUTCOME_FAILED, OUTCOME_NO_CHANGE):
            self.assertFalse(complete(data, TASK_ID, outcome=outcome, now=NOW)["changed"])
            self.assertEqual(data, before)

    def test_unknown_outcome_is_rejected(self):
        data = manifest(task(status="in_progress"))
        with self.assertRaises(ValueError):
            complete(data, TASK_ID, outcome="probably_fine", now=NOW)

    def test_unknown_task_changes_nothing(self):
        data = manifest(task(status="in_progress"))
        result = complete(data, "does-not-exist", outcome=OUTCOME_MERGED, now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(result["reason"], "task_not_found")


class SweepTest(unittest.TestCase):
    """GitHub starts no workflow run for an event the loop's own token caused,
    so completion may never depend on receiving one."""

    def test_review_pr_parks_attempt_without_blocking_other_work_and_later_merges(self):
        data = manifest(task(), task("other"))
        start(data, TASK_ID, session_id="1", dispatch_key="first", now=NOW)
        pr = {"number": 7, "state": "OPEN", "title": "[dispatch:first]",
              "labels": ["human-review"], "draft": False}
        sweep(data, [pr], now=NOW)
        self.assertEqual(status_of(data), "blocked")
        self.assertEqual(execution(data)["state"], "awaiting_review")
        self.assertEqual(execution(data)["outcome"], "review_required")
        self.assertFalse(sweep(data, [pr], now=NOW)["changed"])
        start(data, "other", dispatch_key="other-key", now=NOW)
        self.assertEqual(status_of(data, "other"), "in_progress")
        pr.update(state="MERGED", title="edited")
        sweep(data, [pr], now=NOW)
        self.assertEqual(status_of(data), "done")
        self.assertEqual(execution(data)["attempts"], 1)
        self.assertEqual(execution(data)["outcome"], "merged")
        self.assertEqual(status_of(data, "other"), "in_progress")

    def test_draft_closed_review_retries_and_old_attempt_cannot_close_new_one(self):
        data = manifest(task())
        start(data, TASK_ID, dispatch_key="first", now=NOW)
        pr = {"number": 7, "state": "OPEN", "title": "[dispatch:first]", "isDraft": True}
        sweep(data, [pr], now=NOW)
        self.assertEqual(status_of(data), "blocked")
        close_from_pr(data, pull_request=7, title="[dispatch:first]", now=NOW)
        self.assertEqual(status_of(data), "todo")
        self.assertEqual(execution(data)["attempts"], 1)
        start(data, TASK_ID, dispatch_key="second", now=NOW)
        pr.update(state="MERGED")
        self.assertFalse(sweep(data, [pr], now=NOW)["changed"])
        self.assertEqual(status_of(data), "in_progress")

    def test_linked_open_pr_is_not_timed_out_as_a_dead_worker(self):
        data = manifest(task())
        start(data, TASK_ID, dispatch_key="first", now=NOW)
        sweep(data, [{"number": 7, "state": "OPEN", "title": "[dispatch:first]"}], now=NOW)
        self.assertFalse(reconcile(data, now=NOW + timedelta(hours=12))["changed"])
        self.assertEqual(status_of(data), "in_progress")

    def test_merged_pull_request_is_swept_without_any_event(self):
        data = manifest(task(status="in_progress",
                             execution={"attempts": 1, "dispatch_key": "abc123"}))
        result = sweep(data, [{
            "number": 7, "state": "MERGED", "title": "[dispatch:abc123] fix the clock",
            "body": "",
        }], now=NOW)
        self.assertTrue(result["changed"])
        self.assertEqual(result["reason"], "swept")
        self.assertEqual(result["task_id"], TASK_ID)
        self.assertEqual(status_of(data), "done")
        self.assertEqual(execution(data)["pull_request"], 7)

    def test_a_rest_shaped_pull_request_counts_as_merged(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        result = sweep(data, [{
            "number": 7, "state": "closed", "merged_at": "2026-09-12T11:00:00Z",
            "title": "fix the clock", "body": MARKER,
        }], now=NOW)
        self.assertEqual(result["changes"][0]["outcome"], OUTCOME_MERGED)
        self.assertEqual(status_of(data), "done")

    def test_closed_pull_request_returns_the_task_to_the_queue(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}), max_attempts=2)
        result = sweep(data, [{
            "number": 8, "state": "CLOSED", "title": "fix the clock", "body": MARKER,
        }], now=NOW)
        self.assertEqual(result["changes"][0]["outcome"], OUTCOME_CLOSED)
        self.assertEqual(status_of(data), "todo")

    def test_deferred_review_frees_worker_and_eventually_closes_same_attempt(self):
        for pause in ({"labels": ["custom-review"]}, {"draft": True}):
            with self.subTest(pause=pause):
                data = manifest(task(), task("next-work"))
                start(data, TASK_ID, session_id="7", dispatch_key="first", now=NOW)
                pr = {"number": 9, "state": "open", "title": "[dispatch:first] fix", **pause}
                config = {"automation": {"blocking_labels": ["custom-review"]}}
                sweep(data, [pr], now=NOW, config=config)
                self.assertEqual(status_of(data), "blocked")
                self.assertEqual(execution(data)["outcome"], "review_required")
                self.assertEqual(select(data)["task_id"], "next-work")
                self.assertFalse(sweep(data, [pr], now=NOW, config=config)["changed"])
                start(data, "next-work", session_id="8", dispatch_key="second", now=NOW)
                sweep(data, [dict(pr, state="closed", merged=True)], now=NOW, config=config)
                self.assertEqual(status_of(data), "done")
                self.assertEqual(execution(data)["outcome"], "merged")
                self.assertEqual(execution(data)["attempts"], 1)
                self.assertEqual(status_of(data, "next-work"), "in_progress")

    def test_an_open_pull_request_is_only_linked(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        result = sweep(data, [{
            "number": 9, "state": "OPEN", "title": "fix the clock", "body": MARKER,
        }], now=NOW)
        self.assertTrue(result["changed"])
        self.assertEqual(result["reason"], "linked")
        self.assertEqual(result["linked"], [{"task_id": TASK_ID, "pull_request": 9}])
        self.assertEqual(status_of(data), "in_progress")
        self.assertEqual(execution(data)["pull_request"], 9)

    def test_sweeping_the_same_state_twice_changes_nothing(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        pull_requests = [{
            "number": 9, "state": "OPEN", "title": "fix the clock", "body": MARKER,
        }]
        sweep(data, pull_requests, now=NOW)
        again = sweep(data, pull_requests, now=NOW)
        self.assertFalse(again["changed"])
        self.assertEqual(again["reason"], "nothing_to_sweep")

    def test_sweeping_a_finished_task_changes_nothing(self):
        data = manifest(task(status="done", execution={"attempts": 1, "pull_request": 7}))
        result = sweep(data, [{
            "number": 7, "state": "MERGED", "title": "fix the clock", "body": MARKER,
        }], now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(result["reason"], "nothing_to_sweep")

    def test_an_unmatched_pull_request_is_ignored(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        result = sweep(data, [{
            "number": 999, "state": "MERGED", "title": "chore: bump dependencies",
            "body": "opened by hand",
        }], now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(status_of(data), "in_progress")

    def test_a_linked_pull_request_can_be_closed_later_even_if_the_body_is_edited(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        sweep(data, [{"number": 9, "state": "OPEN", "title": "fix", "body": MARKER}], now=NOW)
        result = sweep(data, [{"number": 9, "state": "MERGED", "title": "fix", "body": ""}],
                       now=NOW)
        self.assertEqual(result["changes"][0]["matched_by"], "recorded_pull_request")
        self.assertEqual(status_of(data), "done")

    def test_garbage_entries_are_skipped(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1}))
        result = sweep(data, ["nonsense", {}, {"number": 0}], now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(status_of(data), "in_progress")

    def test_multiple_prs_claiming_an_attempt_are_not_resolved_by_list_order(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1, "dispatch_key": "first"}))
        before = copy.deepcopy(data)
        entries = [
            {"number": 1, "state": "MERGED", "title": "[dispatch:first]"},
            {"number": 2, "state": "CLOSED", "title": "[dispatch:first]"},
        ]
        for ordered in (entries, list(reversed(entries))):
            self.assertFalse(sweep(data, ordered, now=NOW)["changed"])
            self.assertEqual(data, before)

    def test_cli_reads_api_snapshot_file_and_persists_completion_once(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.json"
            snapshot = Path(directory) / "prs.json"
            queue.write_text(json.dumps(manifest(task(status="in_progress",
                execution={"attempts": 1, "dispatch_key": "first"}))), encoding="utf-8")
            snapshot.write_text(json.dumps([{"number": 7, "state": "closed",
                "merged_at": "2026-09-12T11:00:00Z", "title": "[dispatch:first]"}]), encoding="utf-8")
            argv = ["--manifest", str(queue), "--action", "sweep", "--pull-requests", str(snapshot)]
            with redirect_stdout(StringIO()):
                self.assertEqual(main(argv), 0)
                once = queue.read_bytes()
                self.assertEqual(main(argv), 0)
            self.assertEqual(queue.read_bytes(), once)
            self.assertEqual(json.loads(once)["tasks"][0]["status"], "done")


class ReconcileTest(unittest.TestCase):
    def test_stale_task_returns_to_the_queue(self):
        data = manifest(
            task(status="in_progress",
                 execution={"attempts": 1, "started_at": "2026-09-12T02:00:00Z"}),
            stale_hours=6,
        )
        result = reconcile(data, now=NOW)
        self.assertTrue(result["changed"])
        self.assertEqual(result["reason"], "released_stale")
        self.assertEqual(status_of(data), "todo")

    def test_fresh_task_is_left_alone(self):
        data = manifest(
            task(status="in_progress",
                 execution={"attempts": 1, "started_at": "2026-09-12T11:30:00Z"}),
            stale_hours=6,
        )
        result = reconcile(data, now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(result["reason"], "nothing_stale")
        self.assertEqual(status_of(data), "in_progress")

    def test_stale_task_without_budget_is_blocked(self):
        data = manifest(
            task(status="in_progress",
                 execution={"attempts": 2, "started_at": "2026-09-11T12:00:00Z"}),
            max_attempts=2, stale_hours=6,
        )
        reconcile(data, now=NOW)
        self.assertEqual(status_of(data), "blocked")
        self.assertEqual(execution(data)["state"], "exhausted")


class QueueTest(unittest.TestCase):
    def test_counts_every_status(self):
        data = manifest(
            task("a", status="todo"), task("b", status="in_progress"),
            task("c", status="done"), task("d", status="blocked"),
            task("e", status="todo"),
        )
        self.assertEqual(counts(data), {"todo": 2, "in_progress": 1, "done": 1, "blocked": 1})


if __name__ == "__main__":
    unittest.main(verbosity=2)
