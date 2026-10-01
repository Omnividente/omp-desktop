#!/usr/bin/env python3
"""C-SEND R1..R5 behavior regressions: real CLIs/Git/HTTP, modeled Actions queue.

The bounded queue implements documented GitHub pending replacement, not hosted
proof. Group expressions and artifact paths come from the actual workflows.
"""
from __future__ import annotations

import argparse
import ast
import copy
import json
from pathlib import Path
import re
import tempfile
import unittest

from dispatch_integration_test import (BASE, CONTINUE, NEXT, SYNC, REPOSITORY, Endpoint,
                                       child, git, make_fixture, source_checkout,
                                       state_snapshot, write_json)
from dispatch_journal import materialize


class ActionsQueue:
    def __init__(self, source, workflow=CONTINUE):
        text = (source / ".github/workflows" / workflow).read_text(encoding="utf-8")
        match = re.search(r"(?ms)^concurrency:\s*\n\s+group: >-\s*\n(.*?)\n\s+cancel-in-progress: false", text)
        if match is None:
            raise ValueError("fixture requires workflow-level non-cancelling expression")
        expression = match[1].strip()
        if not expression.startswith("${{") or not expression.endswith("}}"):
            raise ValueError("invalid concurrency expression")
        expression = expression[3:-2].strip().replace("&&", "and").replace("||", "or")
        expression = re.sub(r"\b(?:github|inputs)\.[A-Za-z0-9_.]+",
                            lambda value: "field(" + repr(value[0]) + ")", expression)
        tree = ast.parse(" ".join(expression.split()), mode="eval")
        allowed = (ast.Expression, ast.BoolOp, ast.Compare, ast.Call, ast.Name,
                   ast.Load, ast.Constant, ast.And, ast.Or, ast.Eq, ast.NotEq)
        if any(not isinstance(node, allowed) for node in ast.walk(tree)):
            raise ValueError("unsupported fixture expression")
        if any(isinstance(node, ast.Name) and node.id not in {"field", "format"} for node in ast.walk(tree)):
            raise ValueError("unsupported fixture expression name")
        self.expression = compile(tree, "workflow-concurrency", "eval")
        self.running, self.pending, self.cancelled = {}, {}, []

    def group(self, run):
        context = {"github": {"ref": run.get("ref", "refs/heads/main"), "event_name": run["event"],
                               "run_id": run["id"], "repository": REPOSITORY,
                               "event": {"workflow_run": run.get("source", {})}},
                   "inputs": {"continuation_key": run.get("key", "")}}
        def field(path):
            value = context
            for name in path.split("."):
                value = value.get(name, "") if isinstance(value, dict) else ""
            return value
        return str(eval(self.expression, {"__builtins__": {}},
                        {"field": field, "format": lambda pattern, *args: pattern.format(*args)})).casefold()

    def submit(self, run):
        group = self.group(run)
        if group not in self.running:
            self.running[group] = run["id"]
        else:
            if group in self.pending:
                self.cancelled.append(self.pending[group])
            self.pending[group] = run["id"]
        return group

    def finish(self, run):
        group = next(group for group, identifier in self.running.items() if identifier == run)
        del self.running[group]
        if group in self.pending:
            self.running[group] = self.pending.pop(group)


class ReviewSequences(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="c-send-review-sequences-")
        cls.root = Path(cls.temporary.name)
        cls.source = source_checkout(cls.root, cls.checkout, "candidate", BASE)
        cls.results = []

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.fixture = self.root / self._testMethodName
        self.fixture.mkdir()
        self.repo, self.remote, self.seed, sha = make_fixture(
            self.fixture, research=self._testMethodName.startswith(("test_R1_", "test_R2_")))
        self.health = {"health": "ok", "action": "none", "reason": "terminal", "main_sha": sha,
                       "lab_sha": sha, "state_sha": "", "control_sha": git(self.source, "rev-parse", "HEAD").stdout.strip(),
                       "scheduler": {"state": "ready"}, "due_at": None}
        self.endpoint = Endpoint(self.remote, self.health, "review-sequence")
        self.addCleanup(self.endpoint.close)
        self.steps = []
        self.addCleanup(self.retain)
        self.invoke("initialize")
        self.initial = state_snapshot(self.remote)

    def retain(self):
        final = state_snapshot(self.remote)
        self.assertEqual(final["synthetic_protected"], self.initial["synthetic_protected"])
        self.assertEqual(final["tasks"][1:], self.initial["tasks"][1:])
        self.results.append({"scenario": self._testMethodName, "steps": self.steps,
                             "posts": copy.deepcopy(self.endpoint.posts), "worker_posts": len(self.endpoint.sessions),
                             "journal_events": final["dispatch_journal"]["events"], "protected_state_preserved": True})

    def invoke(self, operation, *, expected=0, **options):
        step = child(self.source, self.fixture, self.endpoint, operation, **options)
        self.steps.append(step)
        self.assertEqual(step["exit"], expected, step)
        return step["output"]

    def state(self):
        return materialize(state_snapshot(self.remote)["dispatch_journal"])

    def advance_main(self):
        git(self.repo, "checkout", "-b", "main")
        (self.repo / "src/clock.ts").write_text("export const clock = 1;\n", encoding="utf-8")
        git(self.repo, "add", "src/clock.ts")
        git(self.repo, "commit", "-m", "synthetic accepted main change")
        git(self.repo, "push", "origin", "main")
        self.health["main_sha"] = git(self.repo, "rev-parse", "HEAD").stdout.strip()
        git(self.repo, "checkout", "autonomous/lab")

    def test_R1_noop_replay_then_legal_executor(self):
        result = self.invoke("sync", run="300", event="workflow_dispatch")
        self.assertEqual(result["status"], "up_to_date")
        state = self.state()
        self.assertIsNone(state["active_intent"])
        self.assertEqual(state["effects"], {})
        self.assertEqual(state_snapshot(self.remote).get("controller"), self.initial.get("controller"))
        before = state_snapshot(self.remote)
        replay = self.invoke("sync", run="300", attempt="2", event="workflow_dispatch")
        self.assertEqual(replay["reason"], "execution_already_claimed")
        self.assertEqual(state_snapshot(self.remote), before)
        self.invoke("handoff", run="300", event="workflow_dispatch", workflow=SYNC)
        key = self.endpoint.posts[-1]["inputs"]["continuation_key"]
        self.health.update(action="next_task", reason="work_due")
        self.invoke("sender", run="1001", event="workflow_dispatch", key=key)
        next_key = self.endpoint.posts[-1]["inputs"]["continuation_key"]
        self.invoke("receiver", run="1002", event="workflow_dispatch", key=next_key)
        self.assertEqual(len(self.endpoint.sessions), 1)
        self.assertEqual([post["workflow"] for post in self.endpoint.posts], [CONTINUE, NEXT])
        self.assertEqual(len(self.state()["completions"]), 1)

    def chain(self, duplicate=False):
        self.health.update(reason="research_cooldown", due_at="2026-10-02T00:00:00Z")
        self.invoke("sender", run="101")
        key = self.endpoint.posts[-1]["inputs"]["continuation_key"]
        queue = ActionsQueue(self.source)
        queue.submit({"id": 1001, "event": "workflow_dispatch", "key": key})
        self.invoke("sender", run="1001", event="workflow_dispatch", key=key)
        successor_key = self.endpoint.posts[-1]["inputs"]["continuation_key"]
        chain_group = queue.submit({"id": 1002, "event": "workflow_dispatch", "key": successor_key})
        for identifier in range(2001, 3001):
            event = ("schedule", "push", "workflow_dispatch", "workflow_run")[(identifier - 2001) % 4]
            queue.submit({"id": identifier, "event": event,
                          "source": {"head_branch": "main", "head_repository": {"full_name": REPOSITORY}}})
        self.assertEqual(queue.pending[chain_group], 1002)
        self.assertNotIn(1002, queue.cancelled)
        self.assertEqual(len(queue.running), 2)
        self.assertEqual(len(queue.pending), 2)
        self.invoke("sender", run="2001", expected=1)
        self.assertEqual(len(self.endpoint.posts), 2)
        selected = 1002
        if duplicate:
            selected = 1010
            queue.submit({"id": selected, "event": "workflow_dispatch", "key": successor_key})
            self.assertIn(1002, queue.cancelled)
        queue.finish(1001)
        self.assertEqual(queue.running[chain_group], selected)
        self.health.update(action="next_task", reason="work_due", due_at=None)
        self.invoke("sender", run=str(selected), event="workflow_dispatch", key=successor_key)
        claim = next(claim for claim in self.state()["executor_claims"].values()
                     if claim["trigger"]["run_id"] == str(selected))
        self.assertIn(claim["decision_id"], self.state()["effects"])
        self.invoke("sender", run="1099", event="workflow_dispatch", key=successor_key, expected=1)
        next_key = self.endpoint.posts[-1]["inputs"]["continuation_key"]
        self.invoke("receiver", run="1003", event="workflow_dispatch", key=next_key)
        self.assertEqual(len(self.endpoint.sessions), 1)
        self.assertEqual([post["workflow"] for post in self.endpoint.posts], [CONTINUE, CONTINUE, NEXT])
        self.steps.append({"queue_model": "documented one running/one pending replacement",
                           "signal_count": 1000, "cancelled_signal_count": len(queue.cancelled),
                           "legitimate_executor_run_id": selected, "hosted_execution": False})

    def test_R2_signal_burst_preserves_and_executes_successor(self):
        self.chain()

    def test_R2_duplicate_key_coalesces_but_executes_once(self):
        self.chain(duplicate=True)

    def test_R3_old_handoff_after_new_progress_does_not_send(self):
        self.invoke("receiver", run="900", event="workflow_dispatch")
        self.invoke("handoff", run="900", event="workflow_dispatch", workflow=NEXT)
        key = self.endpoint.posts[-1]["inputs"]["continuation_key"]
        self.invoke("sender", run="1001", event="workflow_dispatch", key=key)
        before = state_snapshot(self.remote)
        replay = self.invoke("handoff", run="900", event="workflow_dispatch", workflow=NEXT)
        self.assertEqual(replay["outcome"], "stopped")
        self.invoke("sender", run="201", event="workflow_run", source_run_id="900")
        self.assertEqual(state_snapshot(self.remote), before)
        self.assertEqual(len(self.endpoint.posts), 1)
        self.invoke("handoff", run="1001", event="workflow_dispatch", workflow=CONTINUE)
        self.assertEqual(len(self.endpoint.posts), 2)
        current = self.state()["active_intent"]
        predecessor = self.state()["effects"][current["predecessor_decision_id"]]
        self.assertEqual(current["basis"]["receipt_id"], predecessor["receipt_id"])

    def artifact(self, result, variant):
        text = (self.source / ".github/workflows" / SYNC).read_text(encoding="utf-8")
        member = re.search(r"name: autonomous-sync-result[^\n]*\n\s+path: ([^\n]+)", text)[1].strip()
        directory = self.fixture / variant / "sync-outcome"
        directory.mkdir(parents=True)
        write_json(directory / member, result)
        monitor = (self.source / ".github/workflows/autonomous_monitor.yml").read_text(encoding="utf-8")
        consumer = re.search(r"sync_args=\(--sync-result ([^\)]+)\)", monitor)[1].strip()
        return self.invoke("health", run=variant, sync_result=directory.parent / consumer)

    def sync_artifact(self, variant):
        if variant != "noop":
            self.advance_main()
        prep = self.invoke("sync", run="300", event="workflow_dispatch")
        if variant == "failure":
            reference = self.fixture / "process-300-1-sync/out.json"
            corrupted = copy.deepcopy(prep)
            corrupted["prepared_evidence"]["candidate_sha"] = "f" * 40
            write_json(reference, corrupted)
        result = self.invoke("sync-finalize", run="300", event="workflow_dispatch",
                             gates="failure" if variant == "blocked" else "success",
                             expected=1 if variant == "failure" else 0)
        if variant == "published":
            self.assertEqual(result["publication"], "published")
            git(self.repo, "fetch", "origin", "autonomous/lab")
            git(self.repo, "checkout", "--detach", result["candidate_sha"])
        if variant == "failure":
            self.assertEqual(result["reason"], "finalization_failed")
            self.assertEqual(result["main_sha"], prep["main_sha"])
        health = self.artifact(result, "400")
        self.assertEqual(health["sync_outcome"], result)
        reasons = {item["reason"] for item in health["attention"]}
        if variant in {"failure", "blocked"}:
            self.assertIn("sync_outcome_blocked", reasons)
            self.assertIn("sync_failed", reasons)
        else:
            self.assertNotIn("sync_failed", reasons)
        self.assertNotEqual(health["reason"], "health_input_error")
        self.assertEqual(self.endpoint.posts, [])
        self.assertEqual(self.endpoint.sessions, [])

    def test_R4_published_artifact_real_monitor_consumer(self):
        self.sync_artifact("published")

    def test_R4_noop_artifact_real_monitor_consumer(self):
        self.sync_artifact("noop")

    def test_R4_blocked_artifact_preserves_attention(self):
        self.sync_artifact("blocked")

    def test_R4_failure_artifact_preserves_attention(self):
        self.sync_artifact("failure")

    def test_R5_lost_ack_and_spent_claim_real_monitor(self):
        self.health.update(reason="research_cooldown", due_at="2026-10-02T00:00:00Z")
        self.endpoint.scenario = "lost-ack"
        self.invoke("sender", run="77", expected=1)
        before = state_snapshot(self.remote)
        health = self.invoke("health", run="400", time_offset=61)
        self.assertIn("journal_delivery_unknown", {item["reason"] for item in health["attention"]})
        self.assertEqual(health["action"], "none")
        self.endpoint.enabled = False
        disabled = self.invoke("health", run="401", time_offset=61)
        self.assertEqual(disabled["health"], "disabled")
        self.assertIn("journal_delivery_unknown", {item["reason"] for item in disabled["attention"]})
        self.assertEqual(state_snapshot(self.remote), before)
        self.assertEqual(len(self.endpoint.posts), 1)


ReviewSequences.checkout = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, default=ReviewSequences.checkout)
    parser.add_argument("--report", type=Path, help="Optional JSON report; tests run without it.")
    args = parser.parse_args()
    ReviewSequences.checkout = args.checkout.resolve()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ReviewSequences))
    report = {"tests_run": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
              "success": result.wasSuccessful(), "scenarios": ReviewSequences.results,
              "limits": ["GitHub queue is a workflow-derived local model; no hosted concurrency or platform gates"]}
    if args.report:
        write_json(args.report, report)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
