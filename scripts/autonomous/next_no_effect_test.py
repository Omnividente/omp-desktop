#!/usr/bin/env python3
"""Native scheduler pauses close NEXT without hiding parked-report warnings."""
from __future__ import annotations

import copy
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import lab_controller
from dispatch_integration_test import REPOSITORY, git, make_fixture, state_snapshot, write_json
from dispatch_journal import CONTINUE, NEXT, JournalConflict, JournalStore, materialize, normalize_inputs
from owner_report_recovery_test import add_attempt
from state_store import load_state, save_state
from workflow_admission import control_revision


class NativeNextNoEffectTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="next-no-effect-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo, self.remote, seed, _head = make_fixture(self.root, research=True)
        selected = seed["tasks"][0]
        selected.pop("research")
        seed["tasks"] = []
        for index in range(1, 7):
            task = copy.deepcopy(selected)
            task["id"] = "parked-" + str(index)
            seed["tasks"].append(task)
            add_attempt(seed, task, "parked-session-" + str(index))
        seed["controller"] = {"last_tick_at": "2026-10-03T09:00:00Z",
                              "last_poll_at": "2026-10-03T09:10:00Z", "run_id": "90"}
        write_json(self.repo / "agent_tasks.json", seed)
        git(self.repo, "add", "agent_tasks.json")
        git(self.repo, "commit", "-m", "synthetic parked report warnings")
        git(self.repo, "push", "origin", "HEAD", "HEAD:refs/heads/main")
        self.lab_sha = git(self.repo, "rev-parse", "HEAD").stdout.strip()
        self.main_sha = git(self.repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD",
                            "-m", "synthetic newer main frontier").stdout.strip()
        git(self.repo, "push", "origin", self.main_sha + ":refs/heads/main")
        self.control = control_revision()
        self.queue, self.revision = self.root / "queue.json", self.root / "revision.json"
        self.store = JournalStore(self.repo, self.queue, self.revision)
        load_state(self.repo, self.queue, self.revision)
        original = save_state(self.repo, self.queue, self.revision)
        self.store.initialize(original, self.control, {
            "kind": "fenced_bootstrap", "state_sha": original,
            "legacy_senders_fenced": True, "pending_legacy": "none",
        })
        self.inputs = normalize_inputs(NEXT, {"automatic": True})
        self.intent, send = self.store.reserve_send(
            NEXT, self.inputs, basis={}, trigger=self.trigger("700"), control_sha=self.control)
        send.consume()
        self.before = state_snapshot(self.remote)
        self.expected_attention = [
            {"reason": "report_invalid", "task_id": task["id"],
             "observed_at": task["execution"]["report_error"]["reported_at"],
             "repair_status": "invalid", "repair_result": "sent"}
            for task in self.before["tasks"]
        ]
        self.out = self.root / "lab-result.json"
        self.event = self.root / "event.json"
        write_json(self.event, {"inputs": {**self.inputs, "control_sha": self.control,
                                          "continuation_key": self.intent["correlation_key"]}})
        current = {"id": 900, "run_attempt": 1, "head_branch": "main",
                   "event": "workflow_dispatch", "status": "in_progress", "conclusion": None,
                   "head_sha": self.control, "head_repository": {"full_name": REPOSITORY},
                   "display_title": "Next " + self.intent["correlation_key"],
                   "updated_at": datetime.now(timezone.utc).isoformat()}
        self.runs = {NEXT: [current], "autonomous_sync.yml": [], CONTINUE: []}
        self.on_snapshot = None

    def trigger(self, run="900"):
        return {"run_id": run, "run_attempt": "1", "event_name": "workflow_dispatch",
                "control_sha": self.control, "repository": REPOSITORY, "actor": "owner-a"}

    def sync_run(self, *, status="in_progress", conclusion=None):
        return {"id": 800, "run_attempt": 1, "head_branch": "main",
                "event": "workflow_dispatch", "status": status, "conclusion": conclusion,
                "head_sha": self.main_sha, "head_repository": {"full_name": REPOSITORY},
                "display_title": "Sync main " + self.main_sha,
                "updated_at": datetime.now(timezone.utc).isoformat()}

    def github_api(self, _github, path, *, method="GET", body=None, missing=False):
        self.assertEqual(method, "GET", "a scheduler pause must not mutate GitHub")
        self.assertEqual(path, "actions/variables/JULES_LOOP_ENABLED")
        return {"value": "true"}

    def snapshot_api(self, repository, path, *, paginate=False):
        self.assertEqual(repository, REPOSITORY)
        parts = urlsplit(path)
        self.assertTrue(parts.path.startswith("actions/workflows/"), path)
        workflow = parts.path.split("/")[2]
        status = parse_qs(parts.query)["status"][0]
        if self.on_snapshot is not None:
            callback, self.on_snapshot = self.on_snapshot, None
            callback()
        runs = [run for run in self.runs[workflow] if run["status"] == status]
        page = {"total_count": len(runs), "workflow_runs": copy.deepcopy(runs)}
        return [page] if paginate else page

    def native(self):
        # Only external GitHub reads are replaced. Admission, context rechecks,
        # tick readiness, Git ancestry, CAS and completion receipts are real.
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(("GITHUB_", "JULES_API_KEY"))
                       and key not in {"GH_TOKEN", "GH_ENTERPRISE_TOKEN", "CONTROL_SHA", "CONTINUATION_KEY"}}
        environment.update(GITHUB_RUN_ID="900", GITHUB_RUN_ATTEMPT="1",
                           GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF="refs/heads/main",
                           GITHUB_REPOSITORY=REPOSITORY, GITHUB_ACTOR="owner-a",
                           GITHUB_EVENT_PATH=str(self.event), CONTROL_SHA=self.control,
                           CONTINUATION_KEY=self.intent["correlation_key"],
                           GITHUB_WORKFLOW_REF=REPOSITORY + "/.github/workflows/" + NEXT + "@refs/heads/main")
        with patch.dict(os.environ, environment, clear=True), \
                patch.object(lab_controller.GitHub, "api", autospec=True, side_effect=self.github_api), \
                patch("health_snapshot.gh_get", side_effect=self.snapshot_api), \
                redirect_stdout(io.StringIO()):
            code = lab_controller.main([
                "--repo", str(self.repo), "--config", str(self.root / "config.json"),
                "--manifest", str(self.queue), "--revision-file", str(self.revision),
                "--automatic", "--out", str(self.out),
            ])
        return code, json.loads(self.out.read_text(encoding="utf-8"))

    def body(self, manifest):
        return {key: value for key, value in manifest.items() if key != "dispatch_journal"}

    def assert_blocked(self, after):
        state = materialize(after["dispatch_journal"])
        self.assertEqual(state["active_intent"]["decision_id"], self.intent["decision_id"])
        self.assertEqual(state["effects"], {})
        self.assertEqual(state["completions"], {})
        self.assertEqual(state["frontier_seq"], 0)
        self.assertEqual(state["stages"], {})
        self.assertEqual(state["phase_claims"], {})
        with self.assertRaises(JournalConflict):
            self.store.reserve_send(CONTINUE, {}, basis={}, trigger=self.trigger("901"),
                                    control_sha=self.control)
        before_replay = state_snapshot(self.remote)
        code, replay = self.native()
        self.assertEqual(code, 1)
        self.assertEqual((replay["outcome"], replay["reason"]),
                         ("blocked", "executor_without_outcome"))
        self.assertEqual(state_snapshot(self.remote), before_replay)

    def assert_completed_pause(self, reason):
        code, result = self.native()
        self.assertEqual(code, 1, "existing report attention must retain the native warning exit")
        self.assertEqual((result["action"], result["reason"], result["skipped"], result["automatic"]),
                         ("none", reason, True, True))
        self.assertEqual(result["attention"], self.expected_attention)
        for field in ("observations", "proposals", "waiting_workers"):
            self.assertEqual(result[field], [])
        self.assertEqual(result["research"], {})
        after = state_snapshot(self.remote)
        self.assertEqual(self.body(after), self.body(self.before),
                         "closure must preserve requests, reports, history and useful clocks exactly")
        events = after["dispatch_journal"]["events"]
        previous = self.before["dispatch_journal"]["events"]
        self.assertEqual(events[:len(previous)], previous)
        self.assertEqual([event["type"] for event in events[len(previous):]],
                         ["ExecutorClaim", "ExecutionCompletion"])
        state = materialize(after["dispatch_journal"])
        self.assertIsNone(state["active_intent"])
        self.assertEqual(state["effects"], {})
        self.assertEqual(state["stages"], {})
        self.assertEqual(state["phase_claims"], {})
        self.assertEqual(state["frontier_seq"], 1)
        completion = state["completions"][self.intent["decision_id"]]
        self.assertEqual(completion["kind"], "next_no_effect")
        self.assertEqual(completion["receipt_id"], result["effect_receipt_id"])
        self.assertEqual(completion["evidence"]["reason"], reason)
        for field in ("before_state_sha", "after_state_sha"):
            checkpoint = json.loads(git(self.repo, "show", completion["evidence"][field]
                                        + ":agent_tasks.json").stdout)
            self.assertEqual(self.body(checkpoint), self.body(self.before))
        self.assertEqual(result["state_sha"], self.store.current()["state_sha"])
        successor, send = self.store.reserve_send(
            CONTINUE, {}, basis={"receipt_id": completion["receipt_id"]},
            trigger=self.trigger("901"), control_sha=self.control)
        send.consume()
        self.assertEqual(successor["predecessor_decision_id"], self.intent["decision_id"])
        self.assertEqual(successor["frontier_seq"], 1)
        self.assertEqual(self.store.current()["effects"], {})
        self.assertEqual(self.body(state_snapshot(self.remote)), self.body(self.before))

    def test_sync_running_with_six_parked_reports_closes_and_allows_successor(self):
        self.runs["autonomous_sync.yml"] = [self.sync_run()]
        self.assert_completed_pause("sync_running")

    def test_sync_required_with_six_parked_reports_closes_and_allows_successor(self):
        self.assert_completed_pause("sync_required")

    def test_unclassified_readiness_result_remains_spent_and_blocked(self):
        self.runs["autonomous_sync.yml"] = [self.sync_run(status="completed", conclusion="failure")]
        code, result = self.native()
        self.assertEqual(code, 1)
        self.assertEqual((result["action"], result["reason"]), ("none", "sync_failed"))
        self.assertEqual(result["attention"][:6], self.expected_attention)
        self.assertNotIn("effect_receipt_id", result)
        after = state_snapshot(self.remote)
        self.assertEqual(self.body(after), self.body(self.before))
        self.assert_blocked(after)

    def test_readiness_error_remains_spent_and_blocked(self):
        def unavailable_snapshot():
            raise RuntimeError("synthetic GitHub snapshot unavailable")
        self.on_snapshot = unavailable_snapshot
        code, result = self.native()
        self.assertEqual(code, 1)
        self.assertEqual((result["action"], result["reason"]), ("stopped", "controller_error"))
        self.assertNotIn("effect_receipt_id", result)
        after = state_snapshot(self.remote)
        self.assertEqual(self.body(after), self.body(self.before))
        self.assert_blocked(after)

    def test_concurrent_substantive_state_change_cannot_be_completed_as_pause(self):
        expected = copy.deepcopy(self.before)
        expected["tasks"][0]["evidence"]["detail"] = "Synthetic concurrent owner observation"
        def concurrent_update():
            writer = JournalStore(self.repo, self.root / "owner-queue.json", self.root / "owner-revision.json")
            writer.current()
            current = load_state(self.repo, writer.manifest_path, writer.revision_path)
            current["tasks"][0]["evidence"]["detail"] = expected["tasks"][0]["evidence"]["detail"]
            writer.save_manifest(current)
        self.on_snapshot = concurrent_update
        code, result = self.native()
        self.assertEqual(code, 1)
        self.assertEqual((result["action"], result["reason"]), ("stopped", "controller_error"))
        self.assertNotIn("effect_receipt_id", result)
        after = state_snapshot(self.remote)
        self.assertEqual(self.body(after), self.body(expected))
        self.assert_blocked(after)


if __name__ == "__main__":
    unittest.main(verbosity=2)
