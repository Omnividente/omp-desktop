#!/usr/bin/env python3
"""Tests for task_lifecycle.py.

Every regression these tests pin was a real way for the loop to spin:

* a human merge can be missed between controller ticks, so terminal proposals
  must be reconciled without releasing workers whose sessions are still active;
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
    main, match_task, park_report, quarantine, reconcile, reserve, start, sweep,
)
from select_task import select
from jules_provenance import bind_proposal

NOW = datetime(2026, 9, 12, 12, 0, 0, tzinfo=timezone.utc)
TASK_ID = "auto-clock-1"
MARKER = "AUTONOMOUS_TASK_ID: " + TASK_ID
REPOSITORY = "owner/project"


def proposal(number=7, **overrides):
    item = {"number": number, "html_url": f"https://github.com/{REPOSITORY}/pull/{number}",
            "base": {"ref": "autonomous/lab", "repo": {"full_name": REPOSITORY}},
            "head": {"ref": "jules/fix", "sha": "a" * 40, "repo": {"full_name": REPOSITORY}},
            "state": "open", "merged": False}
    item.update(overrides)
    return item


def bind(data, pr=None, state="COMPLETED"):
    pr = proposal() if pr is None else pr
    start(data, TASK_ID, session_id="7", dispatch_key="first", now=NOW)
    snapshot = {"name": "sessions/7", "state": state, "title": "[dispatch:first]",
                "outputs": [{"pullRequest": {"url": pr["html_url"]}}]}
    bind_proposal(data, TASK_ID, snapshot, pr, repository=REPOSITORY, now=NOW)
    return pr


def task(task_id: str = TASK_ID, **overrides) -> dict:
    base = {
        "id": task_id,
        "title": "fix the clock",
        "task_type": "bugfix",
        "status": "todo",
        "priority": 50,
        "risk": "low",
    }
    if overrides.get("task_type", "bugfix") != "project_discovery":
        base["proposal_decision"] = {"action": "approve", "actor": "owner",
                                     "at": "2026-09-12T11:00:00Z", "note": "Approved fixture"}
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
            "attempts": 1, "state": "retry", "outcome": OUTCOME_FAILED,
            "pull_request": 41, "note": "worker failed",
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
    def test_markers_and_legacy_pr_numbers_are_not_provenance(self):
        data = manifest(task(status="in_progress", execution={"attempts": 1,
                        "dispatch_key": "first", "pull_request": 7}))
        before = copy.deepcopy(data)
        pr = proposal(title="[dispatch:first]", body=MARKER)
        self.assertIsNone(match_task(data, pr=pr, repository=REPOSITORY)[0])
        self.assertFalse(sweep(data, [dict(pr, state="closed", merged=True)], repository=REPOSITORY)["changed"])
        self.assertEqual(data, before)

    def test_exact_receipt_survives_edited_body_but_not_foreign_head(self):
        data = manifest(task())
        pr = bind(data)
        matched, _ = match_task(data, pr=dict(pr, body="edited", title="manual title"), repository=REPOSITORY)
        self.assertIs(matched, data["tasks"][0])
        foreign = copy.deepcopy(pr)
        foreign["head"]["repo"]["full_name"] = "stranger/project"
        self.assertIsNone(match_task(data, pr=foreign, repository=REPOSITORY)[0])




class CloseFromPullRequestTest(unittest.TestCase):
    def test_closed_proposal_is_terminal_and_idempotent(self):
        data = manifest(task())
        pr = bind(data)
        pr["state"] = "closed"
        result = close_from_pr(data, pull_request=7, pr=pr, repository=REPOSITORY, now=NOW)
        self.assertEqual(result["reason"], OUTCOME_CLOSED)
        self.assertEqual(status_of(data), "done")
        before = copy.deepcopy(data)
        self.assertFalse(close_from_pr(data, pull_request=7, pr=pr, repository=REPOSITORY, now=NOW)["changed"])
        with self.assertRaises(ValueError):
            start(data, TASK_ID, dispatch_key="second", now=NOW)
        self.assertEqual(data, before)

    def test_unrelated_pr_cannot_close_or_spend_an_attempt(self):
        data = manifest(task())
        before = copy.deepcopy(data)
        self.assertFalse(close_from_pr(data, pull_request=7,
                                      pr=proposal(body=MARKER), repository=REPOSITORY,
                                      merged=True, now=NOW)["changed"])
        self.assertEqual(data, before)

    def test_closed_pr_waits_for_terminal_session_in_both_reconciliation_paths(self):
        for observer in ("close", "sweep"):
            for state in ("IN_PROGRESS", "PAUSED", "UNKNOWN", "FUTURE_STATE"):
                for merged in (False, True):
                    with self.subTest(observer=observer, state=state, merged=merged):
                        data = manifest(task(), task("other"))
                        pr = bind(data, state=state)
                        pr.update(state="closed", merged=merged)
                        before = copy.deepcopy(data)
                        def observe():
                            if observer == "sweep":
                                return sweep(data, [pr], repository=REPOSITORY, now=NOW)
                            return close_from_pr(data, pull_request=7, pr=pr,
                                                 repository=REPOSITORY, merged=merged, now=NOW)
                        self.assertFalse(observe()["changed"])
                        self.assertEqual(data, before)
                        self.assertFalse(select(data, task_id="other")["selected"])
                        execution(data)["session_state"] = "FAILED"
                        self.assertTrue(observe()["changed"])
                        self.assertEqual(status_of(data), "done")
                        self.assertEqual(execution(data)["outcome"], OUTCOME_MERGED if merged else OUTCOME_CLOSED)
                        self.assertEqual(execution(data)["attempts"], 1)
                        self.assertEqual(select(data, task_id="other")["task_id"], "other")
                        self.assertFalse(observe()["changed"])




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
    def test_completed_proposal_frees_worker_and_later_merges_without_an_event(self):
        data = manifest(task(), task("other"))
        pr = bind(data)
        self.assertEqual(status_of(data), "blocked")
        self.assertTrue(select(data, task_id="other")["selected"])
        self.assertFalse(sweep(data, [pr], repository=REPOSITORY, now=NOW)["changed"])
        start(data, "other", session_id="8", dispatch_key="other", now=NOW)
        pr.update(state="closed", merged_at="2026-09-12T12:00:00Z", body="edited")
        result = sweep(data, [pr], repository=REPOSITORY, now=NOW)
        self.assertEqual(result["changes"][0]["outcome"], OUTCOME_MERGED)
        self.assertEqual(status_of(data), "done")
        self.assertEqual(status_of(data, "other"), "in_progress")
        self.assertEqual(execution(data)["attempts"], 1)

    def test_active_session_is_not_released_by_pr_labels_or_draft(self):
        data = manifest(task(), task("other"))
        pr = bind(data, proposal(draft=True, labels=["human-review"]), state="IN_PROGRESS")
        self.assertFalse(sweep(data, [pr], repository=REPOSITORY, now=NOW)["changed"])
        self.assertEqual(status_of(data), "in_progress")
        self.assertFalse(select(data, task_id="other")["selected"])

    def test_declining_a_proposal_never_retries(self):
        data = manifest(task())
        pr = bind(data)
        sweep(data, [dict(pr, state="closed")], repository=REPOSITORY, now=NOW)
        self.assertEqual(status_of(data), "done")
        self.assertEqual(execution(data)["outcome"], OUTCOME_CLOSED)
        self.assertEqual(execution(data)["attempts"], 1)

    def test_spoofed_pr_does_not_change_which_proposal_is_closed(self):
        for reverse in (False, True):
            data = manifest(task())
            pr = bind(data)
            entries = [dict(pr, state="closed"), proposal(8, state="closed", merged=True,
                       title="[dispatch:first]", body=MARKER)]
            sweep(data, list(reversed(entries)) if reverse else entries, repository=REPOSITORY, now=NOW)
            self.assertEqual(execution(data)["outcome"], OUTCOME_CLOSED)

    def test_garbage_entries_are_skipped(self):
        data = manifest(task())
        before = copy.deepcopy(data)
        self.assertFalse(sweep(data, ["nonsense", {}, {"number": 0}], repository=REPOSITORY)["changed"])
        self.assertEqual(data, before)

    def test_cli_persists_completion_once(self):
        data = manifest(task())
        pr = bind(data)
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.json"
            snapshot = Path(directory) / "prs.json"
            queue.write_text(json.dumps(data), encoding="utf-8")
            snapshot.write_text(json.dumps([dict(pr, state="closed", merged=True)]), encoding="utf-8")
            argv = ["--manifest", str(queue), "--action", "sweep", "--pull-requests", str(snapshot),
                    "--repository", REPOSITORY]
            with redirect_stdout(StringIO()):
                self.assertEqual(main(argv), 0)
                once = queue.read_bytes()
                self.assertEqual(main(argv), 0)
            self.assertEqual(queue.read_bytes(), once)
            self.assertEqual(json.loads(once)["tasks"][0]["status"], "done")




class ReconcileTest(unittest.TestCase):
    def test_stale_reserved_intent_is_quarantined_and_binds_without_double_count(self):
        data = manifest(task(), task("other"))
        reserve(data, TASK_ID, "first", base_sha="a" * 40, starting_branch="autonomous/attempt-first", now=NOW)
        before = copy.deepcopy(data)
        self.assertFalse(reserve(data, TASK_ID, "first", base_sha="a" * 40,
                                 starting_branch="autonomous/attempt-first", now=NOW)["changed"])
        self.assertEqual(data, before)
        reconcile(data, now=NOW + timedelta(hours=7))
        self.assertEqual(execution(data)["state"], "quarantined")
        self.assertFalse(select(data)["selected"])
        with self.assertRaises(ValueError):
            reserve(data, "other", "other", base_sha="a" * 40, starting_branch="autonomous/attempt-other")
        start(data, TASK_ID, session_id="7", dispatch_key="first", now=NOW)
        self.assertEqual(execution(data)["attempts"], 1)
        self.assertEqual(execution(data)["state"], "quarantined")
        complete(data, TASK_ID, outcome="failed", now=NOW)
        self.assertEqual(status_of(data), "todo")
        self.assertEqual(execution(data)["attempts"], 1)

    def test_binding_reserved_attempt_retains_base_and_rejects_identity_change(self):
        data = manifest(task())
        reserve(data, TASK_ID, "first", base_sha="a" * 40, starting_branch="autonomous/attempt-first", now=NOW)
        start(data, TASK_ID, session_id="7", dispatch_key="first", now=NOW)
        before = copy.deepcopy(data)
        self.assertFalse(start(data, TASK_ID, session_id="7", dispatch_key="first", now=NOW)["changed"])
        for session_id, key in (("8", "first"), ("7", "other")):
            with self.assertRaises(ValueError):
                start(data, TASK_ID, session_id=session_id, dispatch_key=key)
        self.assertEqual(data, before)
        self.assertEqual(execution(data)["base_sha"], "a" * 40)
        self.assertEqual(execution(data)["attempts"], 1)

    def test_legacy_stale_worker_retains_all_evidence_until_terminal_proof(self):
        data = manifest(task())
        pr = bind(data, state="IN_PROGRESS")
        prior = copy.deepcopy(execution(data))
        reconcile(data, now=NOW + timedelta(hours=7))
        self.assertEqual(execution(data)["state"], "quarantined")
        for field in ("session_id", "dispatch_key", "provenance", "pull_request", "attempts"):
            self.assertEqual(execution(data)[field], prior[field])
        bind(data, pr)
        self.assertEqual(execution(data)["state"], "awaiting_review")
        self.assertEqual(execution(data)["attempts"], 1)

    def test_fresh_task_is_left_alone(self):
        data = manifest(task())
        start(data, TASK_ID, dispatch_key="first", now=NOW)
        before = copy.deepcopy(data)
        self.assertFalse(reconcile(data, now=NOW)["changed"])
        self.assertEqual(data, before)

    def test_exhausted_and_legacy_declined_todo_are_normalized(self):
        data = manifest(task(execution={"attempts": 2, "state": "retry", "outcome": "failed"}),
                        task("declined", execution={"attempts": 1, "state": "retry", "outcome": OUTCOME_CLOSED}))
        reconcile(data, now=NOW)
        self.assertEqual(execution(data)["state"], "exhausted")
        self.assertEqual(status_of(data, "declined"), "done")
        self.assertFalse(select(data)["selected"])

    def test_known_human_wait_is_not_stale_and_explicit_quarantine_still_wins(self):
        for state in ("AWAITING_USER_FEEDBACK", "AWAITING_PLAN_APPROVAL", "PAUSED"):
            with self.subTest(state=state):
                data = manifest(task())
                start(data, TASK_ID, session_id="7", dispatch_key="first", now=NOW)
                execution(data)["session_state"] = state
                before = copy.deepcopy(data)
                self.assertFalse(reconcile(data, now=NOW + timedelta(days=7))["changed"])
                self.assertEqual(data, before)
                quarantine(data, TASK_ID, reason="loop_disabled", now=NOW + timedelta(days=7))
                reconcile(data, now=NOW + timedelta(days=8))
                self.assertEqual((status_of(data), execution(data)["state"], execution(data)["session_id"]),
                                 ("blocked", "quarantined", "7"))

    def test_resumed_processing_gets_transition_ttl_not_started_age(self):
        data = manifest(task())
        start(data, TASK_ID, session_id="7", dispatch_key="first", now=NOW)
        resumed = NOW + timedelta(hours=7)
        execution(data).update(session_state="IN_PROGRESS", observed_at=resumed.isoformat())
        self.assertFalse(reconcile(data, now=resumed + timedelta(minutes=30))["changed"])
        self.assertEqual((status_of(data), execution(data)["session_id"], execution(data)["attempts"]),
                         ("in_progress", "7", 1))
        self.assertTrue(reconcile(data, now=resumed + timedelta(hours=6))["changed"])
        self.assertEqual((execution(data)["state"], execution(data)["session_id"]), ("quarantined", "7"))




class QueueTest(unittest.TestCase):
    def test_counts_every_status(self):
        data = manifest(
            task("a", status="todo"), task("b", status="in_progress"),
            task("c", status="done"), task("d", status="blocked"),
            task("e", status="todo"), task("proposal", status="proposed"),
        )
        self.assertEqual(counts(data), {"proposed": 1, "todo": 2, "in_progress": 1, "done": 1, "blocked": 1})


if __name__ == "__main__":
    unittest.main(verbosity=2)
