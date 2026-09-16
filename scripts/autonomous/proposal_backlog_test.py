#!/usr/bin/env python3
"""Human authorization, immutable worker history and real local CAS regressions."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import proposal_backlog
from proposal_backlog import backlog, decide, main, render_summary
from state_store import StateConflict, load_state, save_state
from validate_tasks import validate

NOW = "2026-09-14T12:00:00Z"
CONFIG = {"merge_gate": {"owner_approvers": ["Owner"]}}


def proposal(task_id="finding", **overrides):
    return {"id": task_id, "title": "Fix observable clock drift", "task_type": "bugfix",
            "status": "proposed", "priority": 40, "risk": "low", "focus": ["quality"],
            "target_paths": ["src/clock.ts"], "acceptance": ["Resume refreshes the clock"],
            "evidence": {"source": "tsc", "detail": "TS2345 at src/clock.ts:42"},
            "origin": {"task_id": "research-clock", "session_id": "7", "dispatch_key": "first",
                       "activity_id": "sessions/7/activities/report", "activity_created_at": NOW,
                       "report_sha256": "a" * 64}, **overrides}


def manifest(*tasks):
    return {"version": 2, "autonomous_loop_policy": {}, "tasks": list(tasks),
            "history": [{"event": "original queue"}]}


def decision(data, action="approve", **kwargs):
    return decide(data, CONFIG, action=action, task_id="finding", actor="Owner",
                  note="Inspected the reported behavior", now=NOW, **kwargs)


class DecisionTests(unittest.TestCase):
    def test_approval_never_dispatches_and_external_resolution_preserves_evidence(self):
        data = manifest(proposal())
        original = copy.deepcopy(data)
        decision(data)
        approved = copy.deepcopy(data)
        self.assertEqual(data["tasks"][0]["status"], "todo")
        self.assertNotIn("execution", data["tasks"][0])
        self.assertEqual(data["tasks"][0]["origin"], original["tasks"][0]["origin"])
        self.assertFalse(decision(data)["changed"])
        self.assertEqual(data, approved)
        decision(data, "resolve")
        self.assertEqual(backlog(data)["tasks"][0]["review_state"], "resolved")
        self.assertEqual(data["tasks"][0]["evidence"], original["tasks"][0]["evidence"])
        self.assertEqual(data["history"], original["history"])
        self.assertNotIn("execution", data["tasks"][0])
        self.assertEqual(validate(data), [])

    def test_unknown_actor_blank_note_and_invalid_date_cannot_mutate_queue(self):
        for changes in ({"actor": "stranger"}, {"actor": ""}, {"note": " "},
                        {"now": "2026-09-14T12:00:00+03:00"}):
            data = manifest(proposal())
            before = copy.deepcopy(data)
            args = {"action": "approve", "task_id": "finding", "actor": "Owner", "note": "Reviewed", "now": NOW}
            args.update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                decide(data, CONFIG, **args)
            self.assertEqual(data, before)

    def test_repeated_decision_keeps_original_actor_timestamp_and_note(self):
        data = manifest(proposal())
        decision(data)
        before = copy.deepcopy(data)
        result = decide(data, CONFIG, action="approve", task_id="finding", actor="owner",
                        note="Inspected the reported behavior", now="2026-09-15T12:00:00Z")
        self.assertFalse(result["changed"])
        self.assertEqual(data, before)
        with self.assertRaises(ValueError):
            decide(data, CONFIG, action="approve", task_id="finding", actor="Owner", note="Rewritten audit")
        self.assertEqual(data, before)

    def test_failed_settled_attempt_can_be_rejected_without_fabricating_cancellation(self):
        execution = {"state": "exhausted", "outcome": "failed", "attempts": 2,
                     "session_id": "saved-session", "session_state": "FAILED", "dispatch_key": "original",
                     "observed_at": NOW, "starting_branch": "autonomous/attempt-original", "base_sha": "b" * 40}
        data = manifest(proposal(status="blocked", execution=copy.deepcopy(execution)))
        origin = copy.deepcopy(data["tasks"][0]["origin"])
        decision(data, "reject")
        self.assertEqual(data["tasks"][0]["execution"], execution)
        self.assertEqual(data["tasks"][0]["origin"], origin)
        self.assertEqual(backlog(data)["tasks"][0]["review_state"], "rejected")
        self.assertEqual(validate(data), [])
        before = copy.deepcopy(data)
        self.assertFalse(decision(data, "reject")["changed"])
        for action in ("approve", "resolve"):
            with self.assertRaises(ValueError):
                decision(data, action)
        self.assertEqual(data, before)

    def test_active_quarantined_unknown_and_pending_pr_work_cannot_be_dismissed(self):
        cases = [
            ("in_progress", {"state": "dispatched", "session_id": "saved", "session_state": "AWAITING_USER_FEEDBACK"}),
            ("blocked", {"state": "quarantined", "outcome": "stale", "session_id": "saved", "session_state": "COMPLETED"}),
            ("todo", {"state": "retry", "outcome": "failed", "session_id": "saved", "session_state": "UNKNOWN"}),
            ("todo", {"state": "retry", "outcome": "failed", "session_id": "saved"}),
            ("blocked", {"state": "awaiting_review", "outcome": "review_required", "pull_request": 53,
                         "session_id": "saved", "session_state": "COMPLETED"}),
        ]
        for status, execution in cases:
            for action in ("approve", "reject", "resolve"):
                data = manifest(proposal(status=status, execution={**execution, "attempts": 1}))
                before = copy.deepcopy(data)
                with self.subTest(status=status, action=action), self.assertRaises(ValueError):
                    decision(data, action)
                self.assertEqual(data, before)

    def test_dozens_of_historical_and_new_proposals_are_listed_without_mutation_or_markup(self):
        tasks = [proposal("finding-" + str(index), status="todo" if index % 2 else "proposed") for index in range(80)]
        tasks[0]["title"] = '</summary><script>alert("x")</script> [click](https://invalid)'
        tasks[0]["evidence"]["detail"] = "```\n<img src=x onerror=alert(1)>"
        data = manifest(*tasks)
        before = copy.deepcopy(data)
        view = backlog(data)
        self.assertEqual([item["id"] for item in view["tasks"]], [item["id"] for item in tasks])
        self.assertEqual(view["counts"], {"pending": 80})
        rendered = render_summary(view)
        self.assertIn("finding-79", rendered)
        self.assertNotIn("<script>", rendered)
        self.assertNotIn("<img", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertEqual(data, before)


class BacklogStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "lab"
        self.remote = self.root / "remote.git"
        self.git(self.root, "init", "--bare", str(self.remote))
        self.git(self.root, "init", str(self.repo))
        self.git(self.repo, "config", "user.name", "fixture")
        self.git(self.repo, "config", "user.email", "fixture@example.invalid")
        self.git(self.repo, "config", "commit.gpgsign", "false")
        self.seed = (json.dumps(manifest(proposal())) + "\n").encode()
        (self.repo / "agent_tasks.json").write_bytes(self.seed)
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "fixture")
        self.git(self.repo, "branch", "-M", "autonomous/lab")
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.git(self.repo, "push", "origin", "HEAD")
        self.head = self.git(self.repo, "rev-parse", "HEAD")
        self.config = self.root / "control-config.json"
        self.config.write_text(json.dumps(CONFIG), encoding="utf-8")
        self.queue = self.root / "queue.json"
        self.revision = self.root / "revision.json"
        self.view = self.root / "backlog.json"
        self.summary = self.root / "summary.txt"
        self.argv = ["--repo", str(self.repo), "--config", str(self.config), "--manifest", str(self.queue),
                     "--revision-file", str(self.revision), "--actor", "Owner", "--task-id", "finding",
                     "--note", "Reviewed report", "--json-out", str(self.view), "--summary-out", str(self.summary)]

    def git(self, repo, *args):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()

    def call(self, action):
        with patch.dict(os.environ, {"GITHUB_ACTOR": "Owner"}), redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            return main([*self.argv, "--action", action])

    def test_cli_persists_authoritative_idempotent_decision_and_retains_state_history(self):
        self.assertEqual(self.call("list"), 0)
        self.assertEqual(self.queue.read_bytes(), self.seed)
        self.assertEqual(self.call("approve"), 0)
        approved_sha = self.git(self.remote, "rev-parse", "autonomous/state").decode()
        self.assertEqual(json.loads(self.git(self.repo, "show", approved_sha + "^:agent_tasks.json")), json.loads(self.seed))
        approved = json.loads(self.queue.read_bytes())
        self.assertEqual(approved["tasks"][0]["proposal_decision"]["actor"], "Owner")
        (self.repo / "agent_tasks.json").write_text('{"tasks": []}', encoding="utf-8")
        self.assertEqual(self.call("approve"), 0)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), approved_sha)
        self.assertEqual(self.call("resolve"), 0)
        resolved_sha = self.git(self.remote, "rev-parse", "autonomous/state").decode()
        self.assertEqual(json.loads(self.git(self.repo, "show", resolved_sha + "^:agent_tasks.json")), approved)
        self.assertEqual(json.loads(self.view.read_bytes())["tasks"][0]["review_state"], "resolved")
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/lab"), self.head)

    def test_stale_human_decision_cannot_overwrite_newer_state(self):
        stale_queue, stale_revision = self.root / "stale.json", self.root / "stale-revision.json"
        stale = load_state(self.repo, stale_queue, stale_revision)
        self.assertEqual(self.call("approve"), 0)
        approved_sha = self.git(self.remote, "rev-parse", "autonomous/state")
        decision(stale, "reject")
        stale_queue.write_text(json.dumps(stale), encoding="utf-8")
        with self.assertRaises(StateConflict):
            save_state(self.repo, stale_queue, stale_revision)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state"), approved_sha)
        self.assertEqual(self.call("list"), 0)
        self.assertEqual(json.loads(self.view.read_bytes())["tasks"][0]["review_state"], "approved")

    def test_github_actor_cannot_be_overridden_to_impersonate_owner(self):
        with patch.dict(os.environ, {"GITHUB_ACTOR": "stranger"}), redirect_stderr(StringIO()):
            self.assertEqual(main([*self.argv, "--action", "reject"]), 1)
        self.assertFalse(self.queue.exists())
        self.assertEqual((self.repo / "agent_tasks.json").read_bytes(), self.seed)


if __name__ == "__main__":
    unittest.main()
