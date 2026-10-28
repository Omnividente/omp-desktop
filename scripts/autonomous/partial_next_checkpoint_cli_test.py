#!/usr/bin/env python3
"""Exercise the actual owner CLI/context/CAS on isolated Git storage."""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

import next_no_effect_artifact as artifact
from dispatch_journal import NEXT, OWNER_PARTIAL_NEXT_CHECKPOINT, _body
import owner_report_recovery_test as research_fixture
from partial_next_checkpoint import FAILURE_KIND, SUPPORTED_PRODUCER
from partial_next_checkpoint_test import PLANNER_CONFIG, install_product, native_source, partial_body
import recover_delivery_test as entry_fixture
from recover_delivery_test import REPOSITORY
from state_store import load_state


class PartialOwnerEntryTests(unittest.TestCase):
    setUp = entry_fixture.OwnerEntryTests.setUp
    git = entry_fixture.OwnerEntryTests.git
    trigger = entry_fixture.OwnerEntryTests.trigger
    start_patch = entry_fixture.OwnerEntryTests.start_patch
    arguments = entry_fixture.OwnerEntryTests.arguments
    invoke = entry_fixture.OwnerEntryTests.invoke
    write_event = entry_fixture.OwnerEntryTests.write_event
    assert_rejected_without_mutation = entry_fixture.OwnerEntryTests.assert_rejected_without_mutation

    def prepare_partial(self):
        self.config = {**entry_fixture.CONFIG, **PLANNER_CONFIG}
        self.control = install_product(self, self.config)
        for variable in ("GITHUB_SHA", "GITHUB_WORKFLOW_SHA", "CONTROL_SHA"):
            os.environ[variable] = self.control
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        with patch.object(research_fixture, "BASE", self.control):
            data.update(research_fixture.research_manifest())
        self.store.save_manifest(data)
        trigger = {**self.trigger(), "control_sha": SUPPORTED_PRODUCER}
        self.intent, send = self.store.reserve_send(NEXT, {"automatic": True}, basis={},
                                                    trigger=trigger, control_sha=SUPPORTED_PRODUCER)
        send.consume()
        _, self.execution = self.store.admit(NEXT, {"automatic": True}, key=self.intent["correlation_key"],
                                             trigger={**trigger, "run_id": "71"}, control_sha=SUPPORTED_PRODUCER)
        self.execution.consume()
        self.store.observe_delivery(self.intent["decision_id"], {"kind": "synthetic original delivery"})
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        partial_body(data, self.config, self.repo)
        self.store.save_manifest(data)
        self.before = self.store.current()
        self.expected = self.before["state_sha"]
        self.event = {"repository": {"full_name": REPOSITORY}, "ref": "refs/heads/main",
                      "sender": {"login": "owner"}, "inputs": {
                          "expected_state_sha": self.expected, "decision_id": self.intent["decision_id"]}}
        self.write_event()
        os.environ["GITHUB_RUN_ID"] = "72"
        os.environ["GITHUB_WORKFLOW_REF"] = (
            REPOSITORY + "/.github/workflows/" + OWNER_PARTIAL_NEXT_CHECKPOINT + "@refs/heads/main")
        self.source = native_source(self.intent, self.expected, task=data["tasks"][-2], repository=REPOSITORY, actor="owner")
        self.start_patch(patch.object(artifact, "_default_json", side_effect=lambda repository, endpoint:
                                     self.source.get_json(endpoint)))
        self.start_patch(patch.object(artifact, "_default_archive", side_effect=lambda repository, endpoint:
                                     self.source.get_archive(endpoint)))

    def test_exact_partial_workflow_acknowledges_once_preserves_body_and_exact_rerun_is_read_only(self):
        self.prepare_partial()
        args = self.arguments("partial_next_checkpoint")
        old = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        pushes = self.pushes
        status, result = self.invoke(args)
        self.assertEqual((status, result["outcome"], result["kind"]), (0, "completed", FAILURE_KIND))
        self.assertEqual(self.pushes, pushes + 1)
        self.assertEqual(set(result), {"outcome", "kind", "decision_id", "receipt_id", "state_sha", "frontier_seq"})
        saved = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.assertEqual(_body(saved), _body(old))
        self.assertEqual(saved["dispatch_journal"]["events"][:-1], old["dispatch_journal"]["events"])
        self.assertNotIn("Synthetic diagnostic must not be retained", json.dumps(saved["dispatch_journal"]["events"][-1]))
        os.environ["GITHUB_RUN_ATTEMPT"] = "2"
        reads = len(self.source.calls)
        replay_status, replay = self.invoke(args)
        self.assertEqual((replay_status, replay), (0, {**result, "outcome": "already_completed"}))
        self.assertEqual((len(self.source.calls), self.pushes), (reads, pushes + 1))
        self.assertEqual(load_state(self.repo, self.store.manifest_path, self.store.revision_path), saved)

    def test_operation_context_and_original_event_inputs_cannot_cross_owner_workflows(self):
        self.prepare_partial()
        args = self.arguments("partial_next_checkpoint")
        for workflow in ("autonomous_complete_next.yml", "autonomous_complete_failed_next.yml",
                         "autonomous_complete_report_recovery.yml", "autonomous_recover_delivery.yml"):
            with self.subTest(workflow=workflow):
                os.environ["GITHUB_WORKFLOW_REF"] = REPOSITORY + "/.github/workflows/" + workflow + "@refs/heads/main"
                result = self.assert_rejected_without_mutation(args)
                self.assertEqual(result["reason"], "owner_partial_next_checkpoint_context_rejected")
        self.assertEqual(self.source.calls, [])
        os.environ["GITHUB_WORKFLOW_REF"] = (
            REPOSITORY + "/.github/workflows/" + OWNER_PARTIAL_NEXT_CHECKPOINT + "@refs/heads/main")
        self.event["inputs"]["unexpected_retry"] = "true"
        self.write_event()
        self.assert_rejected_without_mutation(args)

    def test_owner_identity_checked_main_no_key_and_rerun_actor_are_all_required(self):
        self.prepare_partial()
        for key, value in (("GITHUB_ACTOR", "foreign"), ("GITHUB_TRIGGERING_ACTOR", "foreign"),
                           ("GITHUB_SHA", "c" * 40), ("GITHUB_WORKFLOW_SHA", "c" * 40),
                           ("CONTROL_SHA", "c" * 40), ("CONTINUATION_KEY", "c" * 32),
                           ("GITHUB_REF", "refs/heads/foreign"), ("GITHUB_EVENT_NAME", "schedule"),
                           ("GITHUB_REPOSITORY", "foreign/repository")):
            with self.subTest(key=key), patch.dict(os.environ, {key: value}):
                self.assert_rejected_without_mutation(self.arguments("partial_next_checkpoint"))
        self.assertEqual(self.source.calls, [])

    def test_lost_ack_is_safe_blocked_and_rerun_only_observes_already_committed_receipt(self):
        self.prepare_partial()
        args = self.arguments("partial_next_checkpoint")
        self.lose_ack = True
        pushes = self.pushes
        status, result = self.invoke(args)
        self.assertEqual((status, result), (1, {"outcome": "blocked",
            "reason": "owner_partial_next_checkpoint_acknowledgement_unknown"}))
        self.assertEqual(self.pushes, pushes + 1)
        committed = self.store.current()
        receipt = committed["completions"][self.intent["decision_id"]]
        self.assertEqual(receipt["kind"], FAILURE_KIND)
        self.lose_ack = False
        os.environ["GITHUB_RUN_ATTEMPT"] = "2"
        status, replay = self.invoke(args)
        self.assertEqual((status, replay["outcome"], replay["receipt_id"]),
                         (0, "already_completed", receipt["receipt_id"]))
        self.assertEqual((self.store.current(), self.pushes), (committed, pushes + 1))
        self.event["inputs"]["expected_state_sha"] = committed["state_sha"]
        self.write_event()
        self.assert_rejected_without_mutation(args)


if __name__ == "__main__":
    unittest.main()
