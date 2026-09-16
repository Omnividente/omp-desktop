#!/usr/bin/env python3
"""Proposal authority comes from exact session outputs, not public PR metadata."""
from __future__ import annotations

import copy
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jules_provenance import bind_proposal, session_pull_request, trusted_pull_request
from select_task import select
from task_lifecycle import close_from_pr, quarantine, reserve, start, sweep

NOW = datetime(2026, 9, 13, 12, tzinfo=timezone.utc)
REPOSITORY = "owner/project"
TASK_ID = "fix-clock"
BRANCH = "autonomous/attempt-first"


def manifest():
    data = {"version": 2, "autonomous_loop_policy": {}, "tasks": [
        {"id": TASK_ID, "title": "Fix clock", "task_type": "bugfix", "status": "todo",
         "risk": "low", "priority": 50},
        {"id": "next", "title": "Inspect resume", "task_type": "bugfix", "status": "todo",
         "risk": "low", "priority": 40},
    ]}
    for task in data["tasks"]:
        task["proposal_decision"] = {"action": "approve", "actor": "owner",
                                    "at": "2026-09-13T11:00:00Z", "note": "Approved fixture"}
    reserve(data, TASK_ID, "first", base_sha="a" * 40, starting_branch=BRANCH, now=NOW)
    start(data, TASK_ID, session_id="7", dispatch_key="first", now=NOW)
    return data


def proposal():
    return {"number": 7, "html_url": "https://github.com/owner/project/pull/7",
            "base": {"ref": "autonomous/lab", "repo": {"full_name": REPOSITORY}},
            "head": {"ref": "jules/clock", "sha": "b" * 40, "repo": {"full_name": REPOSITORY}},
            "state": "open", "merged": False, "user": {"login": "owner"},
            "title": "Fix clock", "body": "Owner-authored proposal without markers"}


def session(state="COMPLETED"):
    return {"id": "7", "name": "sessions/7", "state": state, "title": "[dispatch:first] Fix clock",
            "sourceContext": {"source": "sources/github/owner/project",
                              "githubRepoContext": {"startingBranch": BRANCH}},
            "outputs": [{"pullRequest": {"url": proposal()["html_url"]}}]}


class ProvenanceTest(unittest.TestCase):
    def test_owner_authored_exact_output_is_accepted_for_manual_review(self):
        data = manifest()
        pr = proposal()
        bind_proposal(data, TASK_ID, session(), pr, repository=REPOSITORY, now=NOW)
        task = data["tasks"][0]
        self.assertTrue(trusted_pull_request(task, pr, REPOSITORY))
        self.assertEqual(task["status"], "blocked")
        self.assertEqual(task["execution"]["state"], "awaiting_review")
        self.assertEqual(task["execution"]["outcome"], "review_required")
        self.assertTrue(select(data, task_id="next")["selected"])

    def test_public_markers_and_foreign_outputs_cannot_bind_a_proposal(self):
        cases = []
        spoofed = proposal()
        spoofed.update(number=8, html_url="https://github.com/owner/project/pull/8",
                       title="[dispatch:first] Fix clock",
                       body="AUTONOMOUS_TASK_ID: fix-clock\nAUTONOMOUS_DISPATCH_KEY: first")
        cases.append((session(), spoofed))
        no_output = session()
        no_output["outputs"] = []
        cases.append((no_output, proposal()))
        foreign = proposal()
        foreign["head"]["repo"]["full_name"] = "stranger/project"
        cases.append((session(), foreign))
        wrong_target = proposal()
        wrong_target["base"]["ref"] = "main"
        cases.append((session(), wrong_target))
        foreign_source = session()
        foreign_source["sourceContext"]["source"] = "sources/github/stranger/project"
        cases.append((foreign_source, proposal()))
        for output in ("https://github.com/stranger/project/pull/7",
                       "https://github.com/owner/project/pull/7?spoof=1"):
            wrong_output = session()
            wrong_output["outputs"][0]["pullRequest"]["url"] = output
            cases.append((wrong_output, proposal()))
        for snapshot, pr in cases:
            with self.subTest(snapshot=snapshot, pr=pr):
                data = manifest()
                before = copy.deepcopy(data)
                self.assertFalse(trusted_pull_request(data["tasks"][0], pr, REPOSITORY))
                with self.assertRaises(ValueError):
                    bind_proposal(data, TASK_ID, snapshot, pr, repository=REPOSITORY, now=NOW)
                self.assertEqual(data, before)

    def test_exact_session_identity_key_and_starting_branch_are_required(self):
        for field, value in (("id", "8"), ("name", "sessions/8"),
                             ("title", "[dispatch:other]"),
                             ("sourceContext", {"githubRepoContext": {"startingBranch": "autonomous/lab"}})):
            with self.subTest(field=field):
                data = manifest()
                before = copy.deepcopy(data)
                snapshot = session()
                snapshot[field] = value
                with self.assertRaises(ValueError):
                    bind_proposal(data, TASK_ID, snapshot, proposal(), repository=REPOSITORY, now=NOW)
                self.assertEqual(data, before)

    def test_legacy_attempt_without_starting_branch_can_gain_provenance(self):
        data = manifest()
        execution = data["tasks"][0]["execution"]
        del execution["starting_branch"]
        del execution["base_sha"]
        bind_proposal(data, TASK_ID, session(), proposal(), repository=REPOSITORY, now=NOW)
        self.assertTrue(trusted_pull_request(data["tasks"][0], proposal(), REPOSITORY))
        self.assertEqual(execution["attempts"], 1)

    def test_no_output_is_not_a_proposal_and_multiple_outputs_are_ambiguous(self):
        execution = manifest()["tasks"][0]["execution"]
        snapshot = session()
        snapshot["outputs"] = []
        self.assertIsNone(session_pull_request(snapshot, execution, REPOSITORY))
        snapshot["outputs"] = session()["outputs"] * 2
        with self.assertRaises(ValueError):
            session_pull_request(snapshot, execution, REPOSITORY)

    def test_head_can_advance_on_same_ref_but_conflicting_receipt_cannot_replace_it(self):
        data = manifest()
        pr = proposal()
        bind_proposal(data, TASK_ID, session(), pr, repository=REPOSITORY, now=NOW)
        pr["head"]["sha"] = "c" * 40
        pr["body"] = "Rewritten body with no authority"
        self.assertTrue(trusted_pull_request(data["tasks"][0], pr, REPOSITORY))
        bind_proposal(data, TASK_ID, session(), pr, repository=REPOSITORY, now=NOW)
        before = copy.deepcopy(data)
        pr["head"]["ref"] = "jules/replacement"
        self.assertFalse(trusted_pull_request(data["tasks"][0], pr, REPOSITORY))
        with self.assertRaises(ValueError):
            bind_proposal(data, TASK_ID, session(), pr, repository=REPOSITORY, now=NOW)
        self.assertEqual(data, before)
        another = session()
        another["outputs"][0]["pullRequest"]["url"] = "https://github.com/owner/project/pull/8"
        pr = proposal()
        pr.update(number=8, html_url="https://github.com/owner/project/pull/8")
        with self.assertRaises(ValueError):
            bind_proposal(data, TASK_ID, another, pr, repository=REPOSITORY, now=NOW)
        self.assertEqual(data, before)

    def test_failed_worker_with_output_parks_proposal_but_paused_worker_stays_busy(self):
        for state in ("FAILED", "PAUSED"):
            with self.subTest(state=state):
                data = manifest()
                bind_proposal(data, TASK_ID, session(state), proposal(), repository=REPOSITORY, now=NOW)
                task = data["tasks"][0]
                if state == "FAILED":
                    self.assertEqual(task["execution"]["state"], "awaiting_review")
                    self.assertTrue(select(data, task_id="next")["selected"])
                else:
                    self.assertEqual(task["status"], "in_progress")
                    self.assertFalse(select(data, task_id="next")["selected"])
                self.assertEqual(task["execution"]["attempts"], 1)

    def test_terminal_quarantine_resolves_without_incrementing_or_retrying_declined_work(self):
        for observer in ("close", "sweep"):
            with self.subTest(observer=observer):
                data = manifest()
                pr = proposal()
                bind_proposal(data, TASK_ID, session("IN_PROGRESS"), pr, repository=REPOSITORY, now=NOW)
                quarantine(data, TASK_ID, reason="session read unavailable", now=NOW)
                pr["state"] = "closed"
                def observe():
                    if observer == "sweep":
                        return sweep(data, [pr], repository=REPOSITORY, now=NOW)
                    return close_from_pr(data, pull_request=7, pr=pr, repository=REPOSITORY, now=NOW)
                before = copy.deepcopy(data)
                self.assertFalse(observe()["changed"])
                self.assertEqual(data, before)
                data["tasks"][0]["execution"]["session_state"] = "COMPLETED"
                self.assertTrue(observe()["changed"])
                task = data["tasks"][0]
                self.assertEqual(task["status"], "done")
                self.assertEqual(task["execution"]["outcome"], "closed_unmerged")
                self.assertEqual(task["execution"]["attempts"], 1)
                self.assertFalse(observe()["changed"])
                self.assertTrue(select(data, task_id="next")["selected"])

    def test_quarantined_failed_output_returns_to_human_review_not_retry_queue(self):
        data = manifest()
        quarantine(data, TASK_ID, reason="ambiguous response", now=NOW)
        bind_proposal(data, TASK_ID, session("FAILED"), proposal(), repository=REPOSITORY, now=NOW)
        task = data["tasks"][0]
        self.assertEqual(task["status"], "blocked")
        self.assertEqual(task["execution"]["state"], "awaiting_review")
        self.assertEqual(task["execution"]["attempts"], 1)
        self.assertTrue(select(data, task_id="next")["selected"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
