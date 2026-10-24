#!/usr/bin/env python3
"""Exercise the deployed YAML event graph with real admission on synthetic inputs.

The local pending-slot model is not hosted GitHub evidence. It checks whether an
unrelated event can reach the shared queue at all, including forged lab subjects.
"""
from __future__ import annotations

import ast
import copy
import fnmatch
from pathlib import Path
import re
import unittest

import yaml

from dispatch_integration_test import REPOSITORY as QUEUE_REPOSITORY
from dispatch_review_test import ActionsQueue
from review_event_admission_test import ReviewSource, saved_proposal

ROOT = Path(__file__).resolve().parents[2]
REVIEW = "autonomous_review.yml"
CONTINUE = "autonomous_continue.yml"
QUALITY = "pr.yml"
EVIDENCE = "autonomous_evidence_gate.yml"


def expression(value, context):
    value = value.strip()
    if value.startswith("${{"):
        value = value[3:-2].strip()
    value = value.replace("&&", "and").replace("||", "or")
    value = re.sub(r"\b(?:github|inputs|vars|needs)\.[A-Za-z0-9_.]+",
                   lambda match: "field(" + repr(match[0]) + ")", value)
    tree = ast.parse(" ".join(value.split()), mode="eval")
    allowed = (ast.Expression, ast.BoolOp, ast.Compare, ast.Call, ast.Name,
               ast.Load, ast.Constant, ast.And, ast.Or, ast.Eq, ast.NotEq)
    if any(not isinstance(node, allowed) for node in ast.walk(tree)):
        raise ValueError("unsupported fixture Actions expression")
    if any(isinstance(node, ast.Name) and node.id not in {"field", "format"} for node in ast.walk(tree)):
        raise ValueError("unsupported fixture Actions expression function")
    def field(path):
        value = context
        for part in path.split("."):
            value = value.get(part, "") if isinstance(value, dict) else ""
        return value
    return eval(compile(tree, "workflow-condition", "eval"), {"__builtins__": {}},
                {"field": field, "format": lambda value, *args: value.format(*args)})


class EventGraph:
    def __init__(self, root=ROOT):
        self.root = root
        self.workflows = {name: yaml.load((root / ".github/workflows" / name).read_text(encoding="utf-8"),
                                           Loader=yaml.BaseLoader)
                          for name in (REVIEW, CONTINUE, QUALITY, EVIDENCE)}

    def triggered(self, workflow, event, payload):
        triggers = self.workflows[workflow]["on"]
        if event not in triggers:
            return False
        settings = triggers[event] or {}
        if "types" in settings and payload.get("action") not in settings["types"]:
            return False
        if event == "workflow_run" and payload["workflow_run"]["name"] not in settings["workflows"]:
            return False
        if event == "pull_request" and "branches" in settings:
            return any(fnmatch.fnmatchcase(payload["pull_request"]["base"]["ref"], branch)
                       for branch in settings["branches"])
        return True

    def job(self, workflow, name, event, payload, *, admitted=""):
        context = {"github": {"ref": "refs/heads/main", "repository": "owner/repo",
                               "event_name": event, "event": payload},
                   "vars": {"JULES_LOOP_ENABLED": "true"},
                   "needs": {"admission": {"outputs": {"admitted": admitted}}}}
        return bool(expression(self.workflows[workflow]["jobs"][name].get("if", "'true'"), context))

    def review_candidate(self, source, manifest):
        if not self.triggered(REVIEW, "workflow_run", source.event):
            return False
        if not self.job(REVIEW, "admission", "workflow_run", source.event):
            return False
        try:
            metadata = source.review()
            verified = source.review(expected=metadata["pull_requests"], manifest=manifest)
        except (ValueError, KeyError, RuntimeError):
            return False
        return self.job(REVIEW, "review", "workflow_run", source.event,
                        admitted=str(verified["admitted"]).lower())


class EventIsolationTest(unittest.TestCase):
    def setUp(self):
        self.graph = EventGraph()

    def test_dot_draft_create_update_and_ci_outcomes_keep_quality_without_jules_callbacks(self):
        for action in ("opened", "synchronize", "reopened", "edited"):
            for conclusion in ("success", "failure", "cancelled", "skipped"):
                with self.subTest(action=action, conclusion=conclusion):
                    source = ReviewSource()
                    source.pr.update(draft=True)
                    source.pr["base"]["ref"] = "main"
                    source.pr["head"].update(ref="dot/synthetic-clock", sha="d" * 40)
                    event = {"action": action, "pull_request": source.pr}
                    self.assertTrue(self.graph.triggered(QUALITY, "pull_request", event))
                    self.assertFalse(self.graph.triggered(EVIDENCE, "pull_request", event))
                    self.assertFalse(self.graph.triggered(REVIEW, "pull_request", event))
                    source.source.update(name="Quality Gate", conclusion=conclusion)
                    source.event["action"] = "completed"
                    self.assertFalse(self.graph.triggered(REVIEW, "workflow_run", source.event))
                    self.assertFalse(self.graph.triggered(CONTINUE, "workflow_run", source.event))
        for action in ("submitted", "dismissed"):
            self.assertFalse(self.graph.triggered(REVIEW, "pull_request_review", {"action": action}))

    def test_real_jules_lab_evidence_reaches_a_provenance_bound_report(self):
        source = ReviewSource()
        self.assertTrue(self.graph.triggered(QUALITY, "pull_request", {"action": "synchronize", "pull_request": source.pr}))
        self.assertTrue(self.graph.triggered(EVIDENCE, "pull_request", {"action": "synchronize", "pull_request": source.pr}))
        self.assertTrue(self.graph.review_candidate(source, saved_proposal(source.pr)))
        self.assertFalse(self.graph.triggered(CONTINUE, "workflow_run", source.event))

    def test_every_review_conclusion_is_disconnected_and_cannot_join_continue_ingress(self):
        queue = ActionsQueue(ROOT)
        queue.submit({"id": 1, "event": "schedule"})
        group = queue.submit({"id": 2, "event": "schedule"})
        for identifier, conclusion in enumerate(("success", "failure", "cancelled", "skipped"), 100):
            source = {"name": "Autonomous Proposal Review", "head_branch": "main",
                      "head_repository": {"full_name": "owner/repo"}, "conclusion": conclusion}
            payload = {"action": "completed", "workflow_run": source}
            self.assertFalse(self.graph.triggered(CONTINUE, "workflow_run", payload))
            self.assertFalse(self.graph.job(CONTINUE, "continue", "workflow_run", payload))
            # Even bypassing subscription cannot replace the real pending slot.
            queue_source = {**source, "head_repository": {"full_name": QUEUE_REPOSITORY}}
            ignored = queue.submit({"id": identifier, "event": "workflow_run", "source": queue_source})
            self.assertNotEqual(ignored, group)
        self.assertEqual(queue.pending[group], 2)
        self.assertNotIn(2, queue.cancelled)

    def test_permitted_main_callbacks_keep_non_success_recovery_and_main_push(self):
        for name in ("Autonomous Next Task", "Autonomous Sync Main", "Autonomous Loop Switch", "Autonomous Replenish"):
            for conclusion in ("success", "failure", "cancelled", "skipped"):
                with self.subTest(name=name, conclusion=conclusion):
                    payload = {"action": "completed", "workflow_run": {"name": name, "head_branch": "main",
                               "head_repository": {"full_name": "owner/repo"}, "conclusion": conclusion}}
                    self.assertTrue(self.graph.triggered(CONTINUE, "workflow_run", payload))
                    self.assertTrue(self.graph.job(CONTINUE, "continue", "workflow_run", payload))
                    payload["workflow_run"]["head_branch"] = "dot/synthetic-clock"
                    self.assertFalse(self.graph.job(CONTINUE, "continue", "workflow_run", payload))
        for event in ("push", "schedule", "workflow_dispatch"):
            self.assertTrue(self.graph.triggered(CONTINUE, event, {}))
            self.assertTrue(self.graph.job(CONTINUE, "continue", event, {}))

    def test_foreign_main_or_forged_lab_burst_cannot_evict_pending_jules_report(self):
        jobs = self.graph.workflows[REVIEW]["jobs"]
        # No event can seize a workflow-level lock before admission has run.
        running, pending, evicted = None, None, []
        def submit(identifier, source, manifest):
            nonlocal running, pending
            if not self.graph.review_candidate(source, manifest):
                return
            if "concurrency" in self.graph.workflows[REVIEW]:
                self.fail("an unadmitted event could take the workflow-level reporting slot")
            if jobs["review"]["concurrency"]["cancel-in-progress"] != "false":
                self.fail("report admission could cancel an active report")
            if running is None:
                running = identifier
            else:
                if pending is not None:
                    evicted.append(pending)
                pending = identifier
        genuine = ReviewSource()
        manifest = saved_proposal(genuine.pr)
        submit(1, genuine, manifest)
        submit(2, genuine, manifest)
        for identifier in range(100, 200):
            foreign = ReviewSource()
            if identifier % 2:
                foreign.pr["base"]["ref"] = "main"
            else:
                # Authentic same-repo Evidence, copied labels/actor, no saved identity.
                foreign.pr.update(body="AUTONOMOUS_TASK_ID: clock", user={"login": "owner"})
            submit(identifier, foreign, {"tasks": []})
        self.assertEqual((running, pending, evicted), (1, 2, []))


if __name__ == "__main__":
    unittest.main(verbosity=2)
