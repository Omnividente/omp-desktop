#!/usr/bin/env python3
"""Actual CLI/Git/loopback regressions for finalization and checked-main cutover."""
from __future__ import annotations

import copy
from pathlib import Path
import shutil
import tempfile
import unittest

from dispatch_integration_test import (
    CONTINUE, NEXT, REPOSITORY, child, git, make_fixture, source_checkout, state_snapshot,
    Endpoint,
)
from dispatch_journal import materialize

CHECKOUT = Path(__file__).resolve().parents[2]


class FinalizationCLI(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="jules-finalization-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        legacy = self.root / "legacy"
        legacy.mkdir()
        self.old_source = source_checkout(legacy, CHECKOUT, "current", None)
        self.old_control = git(self.old_source, "rev-parse", "HEAD").stdout.strip()
        self.source = self.root / "control"
        git(self.root, "clone", "--no-hardlinks", str(self.old_source), str(self.source))
        git(self.source, "config", "user.name", "synthetic-fixture")
        git(self.source, "config", "user.email", "fixture@example.invalid")
        git(self.source, "config", "commit.gpgsign", "false")
        git(self.source, "commit", "--allow-empty", "-m", "synthetic next checked-main revision")
        self.control = git(self.source, "rev-parse", "HEAD").stdout.strip()
        self.repo, self.remote, self.seed, sha = make_fixture(self.root, research=True)
        git(self.source, "remote", "set-url", "origin", str(self.remote))
        self.health = {"health": "ok", "action": "none", "reason": "research_cooldown",
                       "main_sha": sha, "lab_sha": sha, "state_sha": "", "control_sha": self.control,
                       "scheduler": {"state": "waiting"}, "due_at": "2026-10-02T00:00:00Z"}
        self.endpoint = Endpoint(self.remote, self.health, "finalization")
        self.addCleanup(self.endpoint.close)

    def step(self, operation, *, source=None, **options):
        return child(source or self.source, self.root, self.endpoint, operation, **options)

    def snapshot(self):
        return state_snapshot(self.remote)

    def test_normal_next_no_effect_has_one_receipt_and_one_causal_handoff(self):
        self.assertEqual(self.step("initialize")["exit"], 0)
        before = self.snapshot()
        step = self.step("receiver", run="900", event="workflow_dispatch", task_id="protected")
        self.assertEqual(step["exit"], 0, step)
        self.assertEqual((step["output"]["action"], step["output"]["reason"]),
                         ("none", "explicit_task_not_todo"))
        completed = self.snapshot()
        state = materialize(completed["dispatch_journal"])
        self.assertEqual(completed["tasks"], before["tasks"])
        self.assertEqual(completed["synthetic_protected"], before["synthetic_protected"])
        self.assertIsNone(state["active_intent"])
        self.assertEqual(state["effects"], {})
        self.assertEqual(state["frontier_seq"], 1)
        receipt = next(iter(state["completions"].values()))
        self.assertEqual(receipt["receipt_id"], step["output"]["effect_receipt_id"])
        handoff = self.step("handoff", run="900", event="workflow_dispatch", workflow=NEXT,
                            task_id="protected")
        self.assertEqual(handoff["exit"], 0, handoff)
        self.assertEqual(len(self.endpoint.posts), 1)
        self.assertEqual(self.endpoint.posts[0]["workflow"], CONTINUE)
        self.assertEqual(self.endpoint.sessions, [])
        handed_off = self.snapshot()
        replay = self.step("receiver", run="900", attempt="2", event="workflow_dispatch",
                           task_id="protected")
        self.assertEqual(replay["exit"], 0, replay)
        self.assertEqual(self.snapshot(), handed_off)
        self.step("handoff", run="900", event="workflow_dispatch", workflow=NEXT, task_id="protected")
        # DeliveryObservation may append diagnostics, but never another claim.
        replayed = self.snapshot()
        self.assertEqual(replayed["tasks"], handed_off["tasks"])
        replay_state = materialize(replayed["dispatch_journal"])
        previous_state = materialize(handed_off["dispatch_journal"])
        for field in ("intents", "send_claims", "executor_claims", "effects", "completions", "frontier_seq"):
            self.assertEqual(replay_state[field], previous_state[field])
        self.assertEqual(len(self.endpoint.posts), 1)

    def test_callback_coalesces_only_while_original_receiver_is_observed_live(self):
        self.assertEqual(self.step("initialize")["exit"], 0)
        sender = self.step("sender", run="700")
        self.assertEqual(sender["exit"], 0, sender)
        self.assertEqual(self.endpoint.posts[0]["workflow"], CONTINUE)
        before = self.snapshot()
        callback = self.step("sender", run="701", event="workflow_run", source_run_id="700")
        self.assertEqual(callback["exit"], 0, callback)
        self.assertEqual((callback["output"]["outcome"], callback["output"]["reason"]),
                         ("coalesced", "existing_receiver_active"))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(self.endpoint.posts), 1)
        self.endpoint.runs[0].update(status="completed", conclusion="failure")
        unresolved = self.step("sender", run="702", event="workflow_run", source_run_id="700")
        self.assertEqual(unresolved["exit"], 1, unresolved)
        self.assertEqual((unresolved["output"]["outcome"], unresolved["output"]["reason"]),
                         ("blocked", "delivery_unresolved"))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual((len(self.endpoint.posts), self.endpoint.sessions), (1, []))

    def test_next_sync_refusal_and_handoff_are_benign_only_with_live_receiver(self):
        self.assertEqual(self.step("initialize")["exit"], 0)
        self.assertEqual(self.step("sender", run="700")["exit"], 0)
        before = self.snapshot()
        for index, (operation, workflow) in enumerate((("receiver", NEXT), ("sync", "autonomous_sync.yml"))):
            with self.subTest(operation=operation):
                run_id = str(701 + index)
                ingress = self.step(operation, run=run_id, event="workflow_dispatch")
                self.assertEqual(ingress["exit"], 0, ingress)
                self.assertEqual((ingress["output"]["outcome"], ingress["output"]["reason"]),
                                 ("coalesced", "existing_receiver_active"))
                handoff = self.step("handoff", run=run_id, event="workflow_dispatch", workflow=workflow)
                self.assertEqual(handoff["exit"], 0, handoff)
                self.assertEqual((handoff["output"]["outcome"], handoff["output"]["reason"]),
                                 ("coalesced", "existing_receiver_active"))
                self.assertEqual(self.snapshot(), before)
        self.endpoint.runs[0].update(status="completed", conclusion="failure")
        for index, (operation, workflow) in enumerate((("receiver", NEXT), ("sync", "autonomous_sync.yml"))):
            with self.subTest(operation=operation, receiver="no longer live"):
                run_id = str(710 + index)
                ingress = self.step(operation, run=run_id, event="workflow_dispatch")
                self.assertEqual(ingress["exit"], 1, ingress)
                self.assertEqual((ingress["output"]["outcome"], ingress["output"]["reason"]),
                                 ("blocked", "delivery_unresolved"))
                handoff = self.step("handoff", run=run_id, event="workflow_dispatch", workflow=workflow)
                self.assertEqual(handoff["exit"], 1, handoff)
                self.assertEqual((handoff["output"]["outcome"], handoff["output"]["reason"]),
                                 ("blocked", "delivery_unresolved"))
                self.assertEqual(self.snapshot(), before)
        self.assertEqual((len(self.endpoint.posts), self.endpoint.sessions), (1, []))

    def test_original_spent_executor_without_outcome_remains_blocked(self):
        self.assertEqual(self.step("initialize")["exit"], 0)
        failed = self.step("receiver", run="800", event="workflow_dispatch", fault="executor-before-effect")
        self.assertEqual(failed["exit"], 86, failed)
        before = self.snapshot()
        callback = self.step("sender", run="801", event="workflow_run", source_run_id="800")
        self.assertEqual(callback["exit"], 1, callback)
        self.assertEqual((callback["output"]["outcome"], callback["output"]["reason"]),
                         ("blocked", "executor_without_outcome"))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual((self.endpoint.posts, self.endpoint.sessions), ([], []))
        self.assertEqual(materialize(before["dispatch_journal"])["completions"], {})
        handoff = self.step("handoff", run="800", event="workflow_dispatch", workflow=NEXT)
        self.assertEqual(handoff["exit"], 1, handoff)
        self.assertEqual((handoff["output"]["outcome"], handoff["output"]["reason"]),
                         ("blocked", "executor_without_outcome"))
        rerun = self.step("receiver", run="800", attempt="2", event="workflow_dispatch")
        self.assertEqual(rerun["exit"], 1, rerun)
        self.assertEqual((rerun["output"]["outcome"], rerun["output"]["reason"]),
                         ("blocked", "executor_without_outcome"))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual((self.endpoint.posts, self.endpoint.sessions), ([], []))

    def test_frozen_receiver_and_new_checked_handoff_adopt_control_without_repinning(self):
        self.assertEqual(self.step("initialize", source=self.old_source)["exit"], 0)
        old_sender = self.step("sender", source=self.old_source, run="700")
        self.assertEqual(old_sender["exit"], 0, old_sender)
        inputs = copy.deepcopy(self.endpoint.posts[0]["inputs"])
        self.assertEqual(inputs["control_sha"], self.old_control)
        key = inputs["continuation_key"]
        before = self.snapshot()
        gate = self.step("control-pin", run="1001", event="workflow_dispatch", workflow=CONTINUE,
                         key=key, original_control_sha=self.old_control)
        self.assertEqual(gate["exit"], 0, gate)
        self.assertEqual(gate["output"]["control_sha"], self.old_control)
        self.assertEqual(self.snapshot(), before)
        rejected = self.step("control-pin", run="1002", event="workflow_dispatch", workflow=CONTINUE,
                             key=key, original_control_sha=self.control)
        self.assertEqual(rejected["exit"], 1, rejected)
        self.assertEqual(self.snapshot(), before)
        ingress = self.step("sender", run="701", event="push")
        self.assertEqual(ingress["exit"], 0, ingress)
        self.assertEqual(ingress["output"]["outcome"], "coalesced")
        self.assertEqual(self.snapshot(), before)
        self.health.update(action="next_task", reason="work_due", due_at=None,
                           scheduler={"state": "ready"})
        original = self.step("sender", source=self.old_source, run="1001", event="workflow_dispatch",
                             key=key, original_control_sha=self.old_control, event_sha=self.control)
        self.assertEqual(original["exit"], 0, original)
        next_inputs = self.endpoint.posts[-1]["inputs"]
        self.assertEqual(self.endpoint.posts[-1]["workflow"], NEXT)
        self.assertEqual(next_inputs["control_sha"], self.old_control)
        self.endpoint.runs[0].update(status="completed", conclusion="success")
        gate = self.step("control-pin", run="1002", event="workflow_dispatch", workflow=NEXT,
                         key=next_inputs["continuation_key"], original_control_sha=self.old_control)
        self.assertEqual(gate["exit"], 0, gate)
        next_step = self.step("receiver", source=self.old_source, run="1002", event="workflow_dispatch",
                              key=next_inputs["continuation_key"], original_control_sha=self.old_control,
                              event_sha=self.control)
        self.assertEqual(next_step["exit"], 0, next_step)
        self.assertEqual(len(self.endpoint.sessions), 1)
        before_handoff = self.snapshot()
        old_intents = copy.deepcopy(materialize(before_handoff["dispatch_journal"])["intents"])
        handoff = self.step("handoff", run="1002", event="workflow_dispatch", workflow=NEXT,
                            key=next_inputs["continuation_key"], original_control_sha=self.old_control)
        self.assertEqual(handoff["exit"], 0, handoff)
        self.assertEqual(self.endpoint.posts[-1]["workflow"], CONTINUE)
        self.assertEqual(self.endpoint.posts[-1]["inputs"]["control_sha"], self.control)
        state = materialize(self.snapshot()["dispatch_journal"])
        for identifier, intent in old_intents.items():
            self.assertEqual(state["intents"][identifier], intent)
        self.assertEqual(state["active_intent"]["control_sha"], self.control)
        self.assertEqual(self.snapshot()["synthetic_protected"], self.seed["synthetic_protected"])
        self.assertEqual(len(self.endpoint.posts), 3)
        self.step("handoff", run="1002", event="workflow_dispatch", workflow=NEXT,
                  key=next_inputs["continuation_key"], original_control_sha=self.old_control)
        self.assertEqual(len(self.endpoint.posts), 3)
        self.assertEqual(len(self.endpoint.sessions), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
