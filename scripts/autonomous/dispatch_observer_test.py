#!/usr/bin/env python3
"""Offline real-observer regressions, separate from the injected-health matrix.

python -m unittest discover -s scripts/autonomous -p dispatch_observer_test.py
python scripts/autonomous/dispatch_observer_test.py --report observer.json

Only external GitHub/Jules HTTP and elapsed timer clock are synthetic. Production
Runtime.observe, its --_snapshot-child, admission, policy and receipts execute.
No live repository, authentication, installed provider or workflow is touched.
"""
from __future__ import annotations

import argparse
import copy
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from dispatch_integration_test import (CONTINUE, NEXT, SYNC, Endpoint, child, git,
                                       make_fixture, source_checkout, state_snapshot)


class ProductionObserverTest(unittest.TestCase):
    reports = []

    @contextmanager
    def fixture(self, name):
        with tempfile.TemporaryDirectory(prefix="c-send-real-observer-") as temporary:
            root = Path(temporary)
            source = source_checkout(root, Path(__file__).resolve().parents[2], "candidate", "")
            fixture = root / "fixture"
            fixture.mkdir()
            repo, remote, seed, sha = make_fixture(fixture, research=True)
            control = git(source, "rev-parse", "HEAD").stdout.strip()
            # This object supplies only external ref/dispatch metadata in this mode;
            # /fixture/health is never consumed by a production observer.
            health = {"main_sha": sha, "lab_sha": sha, "control_sha": control}
            endpoint = Endpoint(remote, health, name, observer_mode="production")
            evidence = []
            def run(operation, **options):
                value = child(source, fixture, endpoint, operation,
                              observer_mode="production", **options)
                evidence.append(value)
                return value
            try:
                self.assertEqual(run("initialize")["exit"], 0)
                yield endpoint, run, remote, fixture
            finally:
                final = state_snapshot(remote)
                preserved = (final["synthetic_protected"] == seed["synthetic_protected"]
                             and next(t for t in final["tasks"] if t["id"] == "protected") == seed["tasks"][1]
                             and next(t for t in final["tasks"] if t["id"] == "disposed") == seed["tasks"][2])
                self.reports.append({"test": self.id(), "scenario": name,
                                     "observer_mode": "production", "clock": "accelerated elapsed timer / diagnostic --now only",
                                     "protected_state_preserved": preserved, "subprocesses": evidence,
                                     "external_requests": copy.deepcopy(endpoint.requests),
                                     "python_children": copy.deepcopy(endpoint.processes),
                                     "accepted_posts": copy.deepcopy(endpoint.posts),
                                     "worker_sessions": copy.deepcopy(endpoint.sessions),
                                     "saved_state": final})
                endpoint.close()
                self.assertTrue(preserved, "observer fixture changed protected requests/history/dispositions")

    def assert_snapshot_children(self, endpoint):
        self.assertTrue(any("--_snapshot-child" in process["argv"] for process in endpoint.processes),
                        "Runtime.observe must launch the actual snapshot child")
        self.assertTrue(any(request["method"] == "GET" and "/actions/workflows/" in request["path"]
                            for request in endpoint.requests), "real observer must issue external gh reads")

    def start_next(self, endpoint, run):
        sender = run("sender", run="101")
        self.assertEqual(sender["exit"], 0, sender)
        self.assertEqual(sender["output"]["outcome"], "handed_off", sender)
        self.assertEqual([post["workflow"] for post in endpoint.posts], [NEXT])
        self.assert_snapshot_children(endpoint)
        return endpoint.posts[0]["inputs"]["continuation_key"]

    def test_no_effect_sync_keyed_continue_worker_checkpoint_and_further_continue(self):
        with self.fixture("causal-no-effect-sync") as (endpoint, run, remote, fixture):
            sync = run("sync", run="300", event="workflow_dispatch")
            self.assertEqual(sync["exit"], 0, sync)
            synced = state_snapshot(remote)
            completions = [event for event in synced["dispatch_journal"]["events"]
                           if event["type"] == "ExecutionCompletion"]
            self.assertEqual([event["kind"] for event in completions], ["sync_no_effect"])
            handoff = run("handoff", run="300", event="workflow_dispatch", workflow=SYNC)
            self.assertEqual(handoff["output"]["outcome"], "handed_off", handoff)
            self.assertEqual([post["workflow"] for post in endpoint.posts], [CONTINUE])
            continue_key = endpoint.posts[0]["inputs"]["continuation_key"]
            endpoint.runs[0].update(status="in_progress")
            sender = run("sender", run="1001", event="workflow_dispatch", key=continue_key)
            self.assertEqual(sender["output"]["outcome"], "handed_off", sender)
            self.assertEqual([post["workflow"] for post in endpoint.posts], [CONTINUE, NEXT])
            self.assert_snapshot_children(endpoint)
            endpoint.runs[0].update(status="completed", conclusion="success")
            endpoint.runs[1].update(status="in_progress")
            next_key = endpoint.posts[1]["inputs"]["continuation_key"]
            worker = run("receiver", run="1002", event="workflow_dispatch", key=next_key)
            self.assertEqual(worker["exit"], 0, worker)
            self.assertEqual(worker["output"]["action"], "dispatched", worker)
            self.assertTrue(worker["output"]["effect_receipt_id"], worker)
            checkpoint = state_snapshot(remote)
            selected = next(task for task in checkpoint["tasks"] if task["id"] == "selected")
            execution = selected["execution"]
            self.assertEqual(selected["status"], "in_progress")
            self.assertEqual(execution["session_state"], "IN_PROGRESS")
            self.assertEqual(checkpoint["controller"]["run_id"], "1002")
            self.assertEqual(len(endpoint.sessions), 1)
            session = endpoint.sessions[0]
            self.assertEqual(str(execution["session_id"]).removeprefix("sessions/"), session["id"])
            self.assertEqual(session["sourceContext"]["githubRepoContext"]["startingBranch"], execution["starting_branch"])
            self.assertIn("AUTONOMOUS_DISPATCH_KEY: " + execution["dispatch_key"], session["prompt"])
            effects = [event for event in checkpoint["dispatch_journal"]["events"]
                       if event["type"] == "EffectObservation" and event["kind"] == "controller_checkpoint"]
            self.assertEqual(len(effects), 1)
            self.assertEqual(effects[0]["receipt_id"], worker["output"]["effect_receipt_id"])
            self.assertEqual(effects[0]["evidence"]["poll_observations"][0]["session_state"], "IN_PROGRESS")
            self.assertTrue(any(path.endswith("/sessions/1") for path in endpoint.worker_gets))
            # Replays, changed attempts and foreign runs cannot run the worker again.
            for options in ({"run": "1002"}, {"run": "1002", "attempt": "2"}, {"run": "1099"}):
                gets = len(endpoint.worker_gets)
                replay = run("receiver", event="workflow_dispatch", key=next_key, **options)
                self.assertEqual(replay["output"]["reason"], "execution_already_claimed", replay)
                self.assertEqual(len(endpoint.worker_gets), gets)
                self.assertEqual(state_snapshot(remote), checkpoint)
            next_handoff = run("handoff", run="1002", event="workflow_dispatch", workflow=NEXT, key=next_key)
            self.assertEqual(next_handoff["output"]["outcome"], "handed_off", next_handoff)
            endpoint.runs[1].update(status="completed", conclusion="success")
            endpoint.runs[2].update(status="in_progress")
            further_key = endpoint.posts[2]["inputs"]["continuation_key"]
            further = run("sender", run="1003", event="workflow_dispatch", key=further_key)
            self.assertEqual(further["output"]["outcome"], "handed_off", further)
            self.assertEqual([post["workflow"] for post in endpoint.posts], [CONTINUE, NEXT, CONTINUE, CONTINUE])
            self.assertEqual(len(endpoint.sessions), 1)
            self.assertEqual(state_snapshot(remote)["tasks"], checkpoint["tasks"])

    def test_scheduled_continue_real_observer_and_replay_foreign_attempt(self):
        with self.fixture("scheduled-real-observer") as (endpoint, run, remote, fixture):
            self.start_next(endpoint, run)
            before = state_snapshot(remote)
            for options in ({"run": "101"}, {"run": "101", "attempt": "2"},
                            {"run": "102", "event": "workflow_dispatch", "key": "f" * 64}):
                result = run("sender", **options)
                self.assertIn(result["output"]["outcome"], {"blocked", "stopped"}, result)
                self.assertEqual(endpoint.posts[0]["workflow"], NEXT)
                self.assertEqual(len(endpoint.posts), 1)
                self.assertEqual(state_snapshot(remote), before)

    def test_post_own_send_claim_live_changes_prevent_post(self):
        for fault in ("switch-after-claim", "refs-after-claim", "readiness-after-claim", "context-after-claim",
                      "owner-after-claim", "inputs-after-claim"):
            with self.subTest(fault=fault), self.fixture(fault) as (endpoint, run, remote, fixture):
                result = run("sender", run="101", fault=fault)
                self.assertIn(result["output"]["outcome"], {"blocked", "disabled", "error"}, result)
                self.assertEqual(endpoint.posts, [])
                before = state_snapshot(remote)
                claims = [event for event in before["dispatch_journal"]["events"] if event["type"] == "SendClaim"]
                self.assertEqual(len(claims), 1, "fault must occur after a real durable own SendClaim")
                endpoint.enabled = True
                repeated = run("sender", run="101", attempt="2")
                self.assertEqual(endpoint.posts, [])
                self.assertEqual(state_snapshot(remote), before, repeated)
                self.assert_snapshot_children(endpoint)

    def test_lost_ack_consumed_claim_never_resends(self):
        with self.fixture("lost-ack-real-observer") as (endpoint, run, remote, fixture):
            result = run("sender", run="101")
            self.assertEqual(result["output"]["outcome"], "unknown", result)
            self.assertEqual([post["workflow"] for post in endpoint.posts], [NEXT])
            before = state_snapshot(remote)
            observations = [event["observation"] for event in before["dispatch_journal"]["events"]
                            if event["type"] == "DeliveryObservation"]
            self.assertTrue(any(value["kind"] == "post_unknown" for value in observations))
            for options in ({"run": "101", "attempt": "2"}, {"run": "102", "owner": "owner-b"}):
                repeated = run("sender", **options)
                self.assertEqual(len(endpoint.posts), 1, repeated)
                self.assertEqual(state_snapshot(remote), before)
            self.assert_snapshot_children(endpoint)

    def test_monitor_pins_failed_cancelled_executor_outside_recent_100_without_writes(self):
        for conclusion in ("failure", "cancelled"):
            scenario = "monitor-old-executor-" + ("failed" if conclusion == "failure" else "stopped")
            with self.subTest(conclusion=conclusion), self.fixture(scenario) as (endpoint, run, remote, fixture):
                key = self.start_next(endpoint, run)
                queued = state_snapshot(remote)
                saved_runs = [event["observation"] for event in queued["dispatch_journal"]["events"]
                              if event["type"] == "DeliveryObservation" and event["observation"].get("run_id")]
                self.assertEqual(saved_runs[-1]["run_status"], "queued")
                crashed = run("receiver", run="1001", event="workflow_dispatch", key=key,
                              fault="executor-before-effect")
                self.assertEqual(crashed["exit"], 86, crashed)
                before = state_snapshot(remote)
                state_ref = git(remote, "rev-parse", "refs/heads/autonomous/state").stdout.strip()
                executor = endpoint.runs[0]
                executor.update(status="completed", conclusion=conclusion)
                for index in range(100):
                    endpoint.runs.append(dict(executor, id=2000 + index, conclusion="success",
                                              display_title="Synthetic newer completion " + str(index)))
                health = run("health", run="700")
                self.assertEqual(health["output"]["action"], "none", health)
                reasons = {item["reason"] for item in health["output"]["attention"]}
                self.assertIn("journal_run_failed", reasons)
                pinned_path = "/repos/synthetic/c-send/actions/runs/1001"
                self.assertTrue(any(request["method"] == "GET" and request["path"] == pinned_path
                                    for request in endpoint.requests))
                observed = json.loads((fixture / "process-700-1-health" / "next-runs.json").read_text(encoding="utf-8"))
                self.assertTrue(any(str(value["id"]) == "1001" and value["conclusion"] == conclusion for value in observed))
                self.assertEqual(state_snapshot(remote), before)
                self.assertEqual(git(remote, "rev-parse", "refs/heads/autonomous/state").stdout.strip(), state_ref)
                # Missing pinned data is incomplete observation, never queued evidence.
                endpoint.unavailable_runs.add("1001")
                unavailable = run("health", run="701", time_offset=7200)
                self.assertEqual((unavailable["output"]["health"], unavailable["output"]["action"]), ("attention", "none"))
                self.assertEqual({item["reason"] for item in unavailable["output"]["attention"]},
                                 {"journal_executor_without_receipt"})
                unknown = unavailable["output"]["dispatch_journal"]["active_intent"]
                self.assertIsNone(unknown["run"])
                self.assertEqual(unknown["phase"], "executor_spent")
                self.assertEqual(unknown["delivery_observations"][-1]["status"], "queued")
                self.assertEqual(state_snapshot(remote), before)
                self.assertEqual(git(remote, "rev-parse", "refs/heads/autonomous/state").stdout.strip(), state_ref)
                endpoint.enabled = False
                disabled = run("health", run="702", time_offset=7200)
                self.assertEqual((disabled["output"]["health"], disabled["output"]["action"]), ("disabled", "none"))
                self.assertIsNone(disabled["output"]["dispatch_journal"]["active_intent"]["run"])
                self.assertEqual(state_snapshot(remote), before)
                self.assertEqual(git(remote, "rev-parse", "refs/heads/autonomous/state").stdout.strip(), state_ref)
                self.assertTrue(any(Path(process["argv"][0]).name == "health_snapshot.py" for process in endpoint.processes))
                self.assertTrue(any(Path(process["argv"][0]).name == "loop_health.py" for process in endpoint.processes))
                historical = [event["observation"] for event in before["dispatch_journal"]["events"]
                              if event["type"] == "DeliveryObservation" and event["observation"].get("run_id")]
                self.assertEqual(historical[-1]["run_status"], "queued")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    options = parser.parse_args(argv)
    ProductionObserverTest.reports = []
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ProductionObserverTest)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if options.report:
        report = {"observer_mode": "production", "legacy_matrix_mode": "injected-health (not run here)",
                  "status": "pass" if result.wasSuccessful() else "fail", "tests_run": result.testsRun,
                  "failures": [{"test": str(test), "detail": detail} for test, detail in result.failures],
                  "errors": [{"test": str(test), "detail": detail} for test, detail in result.errors],
                  "scenarios": ProductionObserverTest.reports}
        options.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
