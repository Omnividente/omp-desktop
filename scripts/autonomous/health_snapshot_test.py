#!/usr/bin/env python3
"""Exact executor reads and bounded workflow snapshots remain read-only."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dispatch_journal import NEXT, SYNC, digest, normalize_inputs
from health_snapshot import WORKFLOWS, _snapshot_workflows, inspect_health, main
from loop_health import assess_health
from loop_health_test import LAB, MAIN, NOW, queue, run, settings, task


class SnapshotAPI:
    """Record the same GET endpoints consumed by the production gh adapter."""
    def __init__(self, exact=None):
        self.exact = exact
        self.calls = []
        self.recent = {workflow: [run(id=identifier) for identifier in range(200, 300)]
                       for workflow, _ in WORKFLOWS.values()}
        self.active = {}
        self.list_error = None

    def __call__(self, path, *, paginate=False):
        self.calls.append((path, paginate))
        if path == "actions/runs/20":
            if isinstance(self.exact, Exception):
                raise self.exact
            return copy.deepcopy(self.exact)
        parsed = urlsplit(path)
        workflow = parsed.path.removeprefix("actions/workflows/").removesuffix("/runs")
        if workflow not in self.recent:
            raise AssertionError("unexpected snapshot endpoint: " + path)
        if self.list_error is not None:
            raise self.list_error
        status = parse_qs(parsed.query)["status"][0]
        values = self.recent[workflow] if status == "completed" else self.active.get((workflow, status), [])
        page = {"total_count": len(values), "workflow_runs": copy.deepcopy(values)}
        return [page] if paginate else page


def manifest_with_executor(workflow=NEXT, *, quarantined=False, history=False):
    tasks = [task(status="blocked", execution={"state": "quarantined", "session_id": "123",
             "dispatch_key": "legacy-attempt", "attempts": 1, "started_at": NOW.isoformat(),
             "outcome": "stale"})] if quarantined else []
    manifest = queue(*tasks)
    events = []
    manifest["dispatch_journal"] = {"version": 1, "events": events}
    def append(kind, **fields):
        event = {"type": kind, "at": "2026-09-01T12:00:00+00:00", **fields}
        event["event_id"] = digest(event)
        events.append(event)
        return event
    initial = append("Init", control_sha=MAIN,
                     basis={"kind": "fenced_bootstrap", "legacy_senders_fenced": True,
                            "pending_legacy": "none", "state_sha": LAB})
    decision = digest([initial["event_id"], 0, ""])
    key = digest([decision, "dispatch"])[:32]
    trigger = {"run_id": "10", "run_attempt": "1", "event_name": "workflow_dispatch", "control_sha": MAIN}
    inputs = normalize_inputs(workflow, {"main_sha": MAIN, "lab_sha": LAB} if workflow == SYNC else {})
    append("Intent", decision_id=decision, frontier_seq=0, predecessor_decision_id="",
           correlation_key=key, workflow=workflow, normalized_inputs=inputs, input_hash=digest(inputs),
           basis={}, source_kind="sender", control_sha=MAIN, first_source_trigger=trigger,
           source_identity=digest(["workflow_dispatch", "10"]))
    append("SendClaim", decision_id=decision, trigger=trigger, claim_id=digest([decision, "send"]))
    append("ExecutorClaim", decision_id=decision, trigger={**trigger, "run_id": "20"},
           correlation_key=key, claim_id=digest([decision, "execute"]),
           before_state_sha=LAB, before_digest="c" * 64)
    if history:
        append("DeliveryObservation", decision_id=decision,
               observation={"kind": "run_observed", "run_id": "20", "run_attempt": "1",
                            "run_status": "in_progress"})
    return manifest


class WorkflowSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.config = settings()
        self.config["research"]["enabled"] = False

    def inspect(self, manifest, api, *, enabled=True, **arguments):
        with patch("health_snapshot.revision", side_effect=[MAIN, LAB]), \
                patch("health_snapshot.git", return_value=subprocess.CompletedProcess([], 0)):
            return inspect_health(manifest, self.config, repo=".", enabled=enabled, now=NOW,
                                  get=api, **arguments)

    def test_old_failed_executor_is_observed_by_inspection_and_cli_snapshots(self):
        for workflow, filename in WORKFLOWS.values():
            for conclusion in ("failure", "cancelled"):
                with self.subTest(workflow=workflow, conclusion=conclusion):
                    manifest = manifest_with_executor(workflow)
                    before = copy.deepcopy(manifest)
                    exact = run(id=20, conclusion=conclusion, updated_at="2026-09-01T12:00:00+00:00")
                    inspection_api = SnapshotAPI(exact)
                    observed = self.inspect(manifest, inspection_api)
                    with tempfile.TemporaryDirectory() as temporary:
                        root = Path(temporary)
                        manifest_path, config_path = root / "manifest.json", root / "config.json"
                        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                        config_path.write_text(json.dumps(self.config), encoding="utf-8")
                        cli_api = SnapshotAPI(exact)
                        with patch("health_snapshot.gh_get", side_effect=lambda repository, path, **options: cli_api(path, **options)), \
                                patch.dict(os.environ, {"GITHUB_EVENT_PATH": ""}):
                            self.assertEqual(main(["--manifest", str(manifest_path), "--config", str(config_path),
                                                   "--out-dir", str(root)]), 0)
                        snapshots = {name: json.loads((root / name).read_text(encoding="utf-8"))
                                     for _, name in WORKFLOWS.values()}
                        monitor = assess_health(manifest, self.config, main_sha=MAIN, lab_sha=LAB,
                            main_is_ancestor=True, fingerprints={}, runs=snapshots["next-runs.json"],
                            sync_runs=snapshots["sync-runs.json"], wakeup_runs=snapshots["wakeup-runs.json"],
                            pull_requests=json.loads((root / "pull-requests.json").read_text(encoding="utf-8")),
                            enabled=True, now=NOW)
                    self.assertEqual(monitor, observed)
                    self.assertEqual(observed["action"], "none")
                    active = observed["dispatch_journal"]["active_intent"]
                    self.assertEqual((active["run"]["id"], active["run"]["conclusion"]), (20, conclusion))
                    self.assertIn("journal_run_failed", {item["reason"] for item in observed["attention"]})
                    self.assertEqual([item for item in snapshots[filename] if item["id"] == 20], [exact])
                    self.assertEqual(inspection_api.calls, cli_api.calls)
                    self.assertEqual(manifest, before)

    def test_unavailable_exact_run_remains_unknown_without_erasing_history_or_task_attention(self):
        unavailable = [None, KeyError("missing"), FileNotFoundError("gh"),
                       subprocess.CalledProcessError(1, ["gh", "api"], stderr="HTTP 404"),
                       subprocess.TimeoutExpired(["gh", "api"], 120), RuntimeError("continuation API request failed")]
        for value in unavailable:
            for enabled in (True, False):
                with self.subTest(error=type(value).__name__, enabled=enabled):
                    manifest = manifest_with_executor(quarantined=True, history=True)
                    before = copy.deepcopy(manifest)
                    result = self.inspect(manifest, SnapshotAPI(value), enabled=enabled)
                    active = result["dispatch_journal"]["active_intent"]
                    self.assertIsNone(active["run"])
                    self.assertEqual(active["delivery_observations"][0]["status"], "in_progress")
                    self.assertEqual(active["phase"], "executor_spent")
                    self.assertEqual((result["health"], result["action"]),
                                     ("attention" if enabled else "disabled", "none"))
                    self.assertEqual({item["reason"] for item in result["attention"]},
                                     {"quarantined", "journal_executor_without_receipt"})
                    self.assertEqual(manifest, before)

    def test_wrong_or_malformed_exact_identity_is_not_unknown(self):
        manifest = manifest_with_executor()
        for malformed in ([run(id=20)], {}, run(id=21), "20"):
            with self.subTest(payload=malformed):
                with self.assertRaises(ValueError):
                    _snapshot_workflows(SnapshotAPI(malformed), manifest, self.config["repository"])

    def test_exact_read_is_scoped_to_executors_workflow(self):
        manifest = manifest_with_executor()
        api = SnapshotAPI(run(id=20, conclusion="failure"))
        api.recent[SYNC].append(run(id=20))
        snapshots = _snapshot_workflows(api, manifest, self.config["repository"])
        self.assertEqual(next(item for item in snapshots["next-runs.json"] if item["id"] == 20)["conclusion"], "failure")
        self.assertEqual(next(item for item in snapshots["sync-runs.json"] if item["id"] == 20)["conclusion"], "success")
        self.assertIn(("actions/runs/20", False), api.calls)

    def test_recent_executor_uses_matching_snapshot_without_direct_read(self):
        manifest = manifest_with_executor()
        api = SnapshotAPI(AssertionError("unexpected exact read"))
        api.recent[NEXT].append(run(id=20, conclusion="cancelled"))
        result = self.inspect(manifest, api)
        self.assertEqual(result["dispatch_journal"]["active_intent"]["run"]["conclusion"], "cancelled")
        self.assertNotIn(("actions/runs/20", False), api.calls)

    def test_completion_webhook_refreshes_list_without_redundant_pinned_read(self):
        manifest = manifest_with_executor()
        api = SnapshotAPI(run(id=20, conclusion="cancelled"))
        api.recent[NEXT].append(run(id=20, status="in_progress", conclusion=None))
        snapshots = _snapshot_workflows(api, manifest, self.config["repository"], completed={
            "name": "Autonomous Next Task", "id": 20, "head_repository": {"full_name": self.config["repository"]}})
        self.assertEqual([item for item in snapshots["next-runs.json"] if item["id"] == 20],
                         [run(id=20, conclusion="cancelled")])
        self.assertEqual(api.calls.count(("actions/runs/20", False)), 1)

    def test_workflow_list_read_failure_is_not_downgraded_to_unknown(self):
        for failure in (subprocess.CalledProcessError(1, ["gh", "api"]), RuntimeError("continuation API request failed")):
            with self.subTest(error=type(failure).__name__):
                api = SnapshotAPI(None)
                api.list_error = failure
                with self.assertRaises(type(failure)):
                    _snapshot_workflows(api, manifest_with_executor(), self.config["repository"])


    def test_observer_metadata_with_wrong_claim_cannot_release_executor_fence(self):
        manifest = manifest_with_executor(history=True)
        before = copy.deepcopy(manifest)
        claim = next(event for event in manifest["dispatch_journal"]["events"] if event["type"] == "ExecutorClaim")
        observer = {"kind": "execute", "decision_id": claim["decision_id"], "claim_id": "f" * 64,
                    "trigger": dict(claim["trigger"]), "control_sha": MAIN}
        result = self.inspect(manifest, SnapshotAPI(None), current_run_id="20", observer_context=observer)
        self.assertFalse(result["dispatch_journal"]["current_executor"])
        self.assertEqual(result["action"], "none")
        self.assertIsNone(result["dispatch_journal"]["active_intent"]["run"])
        self.assertEqual(manifest, before)

if __name__ == "__main__":
    unittest.main()
