#!/usr/bin/env python3
"""Owner terminal checkpoint receipts cannot manufacture runtime or provider rights."""
from __future__ import annotations

import copy
import json
import subprocess
import unittest
from contextlib import ExitStack
from datetime import timedelta
from unittest.mock import patch

import dispatch_journal_test as journal_fixture
import next_no_effect_artifact as artifact
import state_store
from dispatch_journal import (NEXT, OWNER_REPORT_CHECKPOINT, JournalConflict, JournalUncertain,
                              _body, _event, _report_checkpoint_receipt, digest, materialize,
                              normalize_inputs, substantive_digest, validate_journal)
from next_no_effect_artifact_test import FailedCheckpointSource
from owner_report_recovery import claim_recovery, queue_recovery
from owner_report_recovery_test import NOW, research_manifest
from state_store import StateConflict, load_state
from validate_tasks import validate

CONTROL = journal_fixture.CONTROL
CONFIG = {"repository": "synthetic/c-send", "merge_gate": {"owner_approvers": ["owner-a", "owner-b"]}}


class FailedRecoveryCheckpointTests(unittest.TestCase):
    git = journal_fixture.JournalTests.git
    reader = journal_fixture.JournalTests.reader
    trigger = journal_fixture.JournalTests.trigger

    def setUp(self):
        journal_fixture.JournalTests.setUp(self)
        self.config = copy.deepcopy(CONFIG)
        self.data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.data.update(research_manifest())
        self.store.save_manifest(self.data)

    def prepare(self, *, consume=True, acknowledge=True, inputs=None):
        record = queue_recovery(self.data, self.config,
                                inputs={"recover_report": True, "task_id": "first",
                                        "repair_after": "2026-10-03T11:00:00Z"},
                                trigger=self.trigger("40"), now=NOW)
        self.store.save_manifest(self.data)
        command = record["inputs"] if inputs is None else normalize_inputs(NEXT, inputs)
        self.intent, send = self.store.reserve_send(NEXT, command, basis={},
                                                    trigger=self.trigger(), control_sha=CONTROL)
        send.consume()
        _, self.execution = self.store.admit(NEXT, command, key=self.intent["correlation_key"],
                                             trigger=self.trigger("71"), control_sha=CONTROL)
        if consume:
            self.execution.consume()
        self.data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        if acknowledge:
            claim_recovery(self.data, self.config, inputs=command, intent=self.intent,
                           trigger=self.trigger("71"), capability=self.execution,
                           now=NOW + timedelta(minutes=1))
            self.store.save_manifest(self.data)
        self.pin = self.store.current()["state_sha"]
        self.original_request = copy.deepcopy(record)
        self.owner = {**self.trigger("500"), "control_sha": "b" * 40,
                      "workflow": OWNER_REPORT_CHECKPOINT, "ref": "refs/heads/main",
                      "decision_id": self.intent["decision_id"], "expected_state_sha": self.pin}
        self.source = FailedCheckpointSource()
        self.source.run["display_title"] = "Next " + self.intent["correlation_key"]
        for run in (self.source.run, self.source.attempt):
            run["repository"]["full_name"] = CONFIG["repository"]
            run["head_repository"]["full_name"] = CONFIG["repository"]
            run["actor"]["login"] = "owner-a"
            run["triggering_actor"]["login"] = "owner-a"
            run["display_title"] = self.source.run["display_title"]
        self.set_report_pin(self.pin)

    def set_report_pin(self, pin):
        self.source.set_report({"action": "stopped", "merge_mode": "manual", "reason": "state_write_failed",
                                "attention": [{"reason": "state save failed; reload the authoritative queue before continuing"}],
                                "state_sha": pin})

    def transport(self):
        # Inject only GET transport. Source authentication and every Git read are real.
        stack = ExitStack()
        stack.enter_context(patch.object(artifact, "_default_json",
                                          side_effect=lambda repository, endpoint: self.source.get_json(endpoint)))
        stack.enter_context(patch.object(artifact, "_default_archive",
                                          side_effect=lambda repository, endpoint: self.source.get_archive(endpoint)))
        return stack

    def complete(self, *, owner=None, pin=None, store=None, config=None):
        with self.transport():
            return (store or self.store).complete_failed_report_checkpoint(
                decision_id=self.intent["decision_id"], expected_state_sha=self.pin if pin is None else pin,
                owner_trigger=self.owner if owner is None else owner,
                config=self.config if config is None else config)

    def authoritative_bytes(self):
        return state_store._git(self.remote, "show", "refs/heads/autonomous/state:agent_tasks.json").stdout

    def assert_rejected_unchanged(self, **arguments):
        before = self.authoritative_bytes()
        sha = self.git(self.remote, "rev-parse", "refs/heads/autonomous/state")
        with self.assertRaises((JournalConflict, ValueError)):
            self.complete(**arguments)
        self.assertEqual(self.authoritative_bytes(), before)
        self.assertEqual(self.git(self.remote, "rev-parse", "refs/heads/autonomous/state"), sha)

    def native_commit(self, data, *, parent=None, publish=False):
        # Negative fixtures still use actual commit/tree/blob objects, not mocked checkpoints.
        parent = self.pin if parent is None else parent
        sha = state_store._commit(self.repo, (json.dumps(data) + "\n").encode(), parent)
        if publish:
            self.git(self.repo, "push", "--force-with-lease=refs/heads/autonomous/state:" + self.pin,
                     "origin", sha + ":refs/heads/autonomous/state")
            self.pin = sha
            self.owner["expected_state_sha"] = sha
        return sha

    def test_closes_once_preserving_all_bodies_claims_history_and_failure_attention(self):
        self.prepare()
        before = copy.deepcopy(self.data)
        old = materialize(before["dispatch_journal"])
        baseline = self.store._checkpoint_state(old["executor_claims"][self.intent["decision_id"]]["before_state_sha"])
        result = self.complete()
        self.assertEqual(result["outcome"], "completed")
        current = self.store.current()
        saved = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.assertEqual(_body(saved), _body(before))
        self.assertEqual(saved["dispatch_journal"]["events"][:-1], before["dispatch_journal"]["events"])
        for field in ("intents", "send_claims", "executor_claims", "effects", "phase_claims", "stages"):
            self.assertEqual(current[field], old[field])
        self.assertIsNone(current["active_intent"])
        self.assertEqual(current["frontier_seq"], old["frontier_seq"] + 1)
        self.assertEqual(current["predecessor_decision_id"], self.intent["decision_id"])
        receipt = current["completions"][self.intent["decision_id"]]
        self.assertEqual(receipt["type"], "OwnerReportRecoveryCheckpointCompletion")
        self.assertEqual(receipt["kind"], "report_recovery_checkpoint_observed")
        self.assertEqual(receipt["native_report"], self.source.report)
        self.assertEqual(receipt["owner_request"], before["controller"]["owner_recovery_requests"][0])
        self.assertEqual(receipt["evidence"], {
            "status": "failed_before_provider_post", "action": "stopped", "reason": "state_write_failed",
            "request_id": self.original_request["request_id"], "task_id": "first",
            "before_state_sha": old["executor_claims"][self.intent["decision_id"]]["before_state_sha"],
            "after_state_sha": self.pin, "before_digest": substantive_digest(baseline),
            "after_digest": substantive_digest(before),
        })
        self.assertEqual(result["request_id"], self.original_request["request_id"])
        self.assertEqual(validate(saved), [])
        self.assertTrue(self.store.advance(result["receipt_id"]))
        self.assertEqual(self.store.outcome_for_trigger(self.trigger("71")), receipt)
        stable = self.authoritative_bytes()
        reads = self.source.run_reads
        for owner in (self.owner, {**self.owner, "run_attempt": "2"}):
            replay = self.complete(owner=owner, store=self.reader("replay"))
            self.assertEqual(replay["outcome"], "already_completed")
            self.assertEqual(replay["receipt_id"], result["receipt_id"])
        self.assertEqual(self.source.run_reads, reads)
        self.assertEqual(self.authoritative_bytes(), stable)

    def test_old_admission_capability_consume_and_observer_are_terminal_without_new_right(self):
        self.prepare()
        self.complete()
        for attempt in ("1", "2"):
            _, capability = self.reader("late-" + attempt).admit(
                NEXT, self.intent["normalized_inputs"], key=self.intent["correlation_key"],
                trigger=self.trigger("71", attempt), control_sha=CONTROL)
            self.assertIsNone(capability)
        with self.assertRaises(JournalConflict):
            self.execution.consume()
        with self.assertRaises(JournalConflict):
            self.execution.observer_context()
        with self.assertRaises(JournalConflict):
            self.store.record_effect(self.execution, "controller_checkpoint", {})
        self.assertEqual(self.store.nonexecution_outcome(
            self.intent, key=self.intent["correlation_key"], trigger=self.trigger("71"), control_sha=CONTROL)["reason"],
            "execution_outcome_already_recorded")

    def test_changed_owner_authorization_and_state_pin_reject_both_before_and_after_receipt(self):
        self.prepare()
        for completed in (False, True):
            if completed:
                self.complete()
            for overrides in ({"actor": "owner-b"}, {"control_sha": "c" * 40}, {"run_id": "501"},
                              {"repository": "foreign/repository"}, {"ref": "refs/heads/foreign"},
                              {"workflow": "autonomous_complete_next.yml"}):
                # Before append, a different approved actor/run/control is a new valid owner command.
                if not completed and set(overrides) <= {"actor", "control_sha", "run_id"}:
                    continue
                with self.subTest(completed=completed, overrides=overrides):
                    self.assert_rejected_unchanged(owner={**self.owner, **overrides})
            moved = "c" * 40
            self.assert_rejected_unchanged(pin=moved, owner={**self.owner, "expected_state_sha": moved})
            denied = copy.deepcopy(self.config)
            denied["merge_gate"]["owner_approvers"] = ["owner-b"]
            self.assert_rejected_unchanged(config=denied)

    def test_git_body_proof_rejects_any_task_receipt_request_or_clock_delta(self):
        self.prepare()
        changes = ("target_receipt", "unrelated_pending", "request_actor", "request_inputs", "request_identity",
                   "new_request", "request_execution", "clock", "accepted_result")
        for change in changes:
            with self.subTest(change=change):
                altered = copy.deepcopy(self.data)
                record = altered["controller"]["owner_recovery_requests"][0]
                if change == "target_receipt":
                    altered["tasks"][0]["execution"]["report_repair"]["detail"] = "Changed receipt"
                elif change == "unrelated_pending":
                    altered["tasks"][1]["execution"]["report_repair"].update(status="pending", result="unknown")
                elif change == "request_actor":
                    record["source_trigger"]["actor"] = "owner-b"
                elif change == "request_inputs":
                    record["inputs"]["task_id"] = "second"
                elif change == "request_identity":
                    record["identity"]["attempts"] += 1
                elif change == "new_request":
                    queue_recovery(altered, self.config, inputs={"recover_report": True, "task_id": "second",
                                                              "repair_after": "2026-10-03T11:00:00Z"},
                                   trigger=self.trigger("41"), now=NOW)
                elif change == "request_execution":
                    record["execution"]["actor"] = "owner-b"
                elif change == "clock":
                    altered["controller"]["last_tick_at"] = "2026-10-03T11:31:00Z"
                else:
                    altered["protected"]["history"].append({"result": "Foreign accepted result"})
                checkpoint = self.native_commit(altered)
                self.set_report_pin(checkpoint)
                self.assert_rejected_unchanged()
        self.set_report_pin(self.pin)
        self.assertEqual(self.complete()["outcome"], "completed")

    def test_current_substantive_drift_cannot_be_hidden_by_canonical_digest(self):
        self.prepare()
        original_pin = self.pin
        changed = copy.deepcopy(self.data)
        changed["controller"]["last_tick_at"] = "2026-10-03T11:31:00Z"
        self.assertEqual(substantive_digest(changed), substantive_digest(self.data))
        self.native_commit(changed, publish=True)
        self.set_report_pin(original_pin)
        self.assert_rejected_unchanged()

    def test_native_source_only_acknowledgement_is_required_even_if_current_matches(self):
        self.prepare()
        changed = copy.deepcopy(self.data)
        changed["tasks"][0]["execution"]["report_repair"]["detail"] = "Changed native receipt"
        self.native_commit(changed, publish=True)
        self.set_report_pin(self.pin)
        self.assert_rejected_unchanged()

    def test_rebound_foreign_or_unsettled_original_command_is_not_completed(self):
        self.prepare()
        original = self.authoritative_bytes()
        for mutation in ("foreign", "rebound", "receipt", "actor"):
            with self.subTest(mutation=mutation):
                changed = copy.deepcopy(self.data)
                record = changed["controller"]["owner_recovery_requests"][0]
                if mutation == "foreign":
                    record["source_trigger"]["repository"] = "foreign/repository"
                elif mutation == "rebound":
                    changed["tasks"][0]["execution"]["session_id"] = "another-session"
                elif mutation == "receipt":
                    changed["tasks"][0]["execution"]["report_repair"]["status"] = "failed"
                else:
                    record["source_trigger"]["actor"] = "stranger"
                self.set_report_pin(self.native_commit(changed))
                self.assert_rejected_unchanged()
        self.assertEqual(self.authoritative_bytes(), original)

    def test_unconsumed_or_unacknowledged_execution_cannot_supply_consumed_owner_proof(self):
        self.prepare(consume=False, acknowledge=False)
        self.assert_rejected_unchanged()
        with self.assertRaises(JournalConflict):
            claim_recovery(self.data, self.config, inputs=self.intent["normalized_inputs"], intent=self.intent,
                           trigger=self.trigger("71"), capability=self.execution, now=NOW + timedelta(minutes=1))
        self.execution.consume()
        claim_recovery(self.data, self.config, inputs=self.intent["normalized_inputs"], intent=self.intent,
                       trigger=self.trigger("71"), capability=self.execution, now=NOW + timedelta(minutes=1))
        self.store.save_manifest(self.data)
        self.pin = self.store.current()["state_sha"]
        self.owner["expected_state_sha"] = self.pin
        self.set_report_pin(self.pin)
        self.assertEqual(self.complete()["outcome"], "completed")

    def test_original_automatic_execution_is_not_a_report_failure_escape_hatch(self):
        self.prepare(inputs={"automatic": True}, acknowledge=False)
        self.assert_rejected_unchanged()

    def test_already_effected_staged_phased_or_completed_execution_is_fail_closed(self):
        self.prepare()
        for event_type in ("EffectObservation", "ExecutionStage", "PhaseClaim", "ExecutionCompletion"):
            with self.subTest(event_type=event_type):
                changed = copy.deepcopy(self.data)
                claim = materialize(changed["dispatch_journal"])["executor_claims"][self.intent["decision_id"]]
                changed["dispatch_journal"]["events"].append(_event(
                    event_type, decision_id=self.intent["decision_id"], executor_claim_id=claim["claim_id"],
                    kind="controller_checkpoint", phase="sync_prepared", evidence={}))
                self.set_report_pin(self.native_commit(changed))
                self.assert_rejected_unchanged()
        self.set_report_pin(self.pin)
        self.complete()
        self.assert_rejected_unchanged(owner={**self.owner, "run_id": "501"})

    def test_materializer_rejects_receipt_forgery_failure_laundering_or_frontier_rewrite(self):
        self.prepare()
        self.complete()
        saved = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        for change in ("receipt", "failure", "attention", "request", "frontier", "producer"):
            with self.subTest(change=change):
                changed = copy.deepcopy(saved["dispatch_journal"])
                event = changed["events"][-1]
                if change == "receipt":
                    event["receipt_id"] = "f" * 64
                elif change == "failure":
                    event["evidence"]["status"] = "no_effect"
                elif change == "attention":
                    event["native_report"]["attention"] = []
                elif change == "request":
                    event["evidence"]["request_id"] = "f" * 64
                elif change == "frontier":
                    event["frontier_seq"] += 1
                else:
                    event["proof"]["producer"]["run_attempt"] = "2"
                if change != "receipt":
                    event["receipt_id"] = _report_checkpoint_receipt(event)
                event["event_id"] = digest({key: value for key, value in event.items() if key != "event_id"})
                self.assertTrue(validate_journal(changed))

    def test_stale_owner_pin_and_single_cas_conflict_never_retry_or_append(self):
        self.prepare()
        writer = self.reader("competitor")
        writer.observe_delivery(self.intent["decision_id"], {"kind": "fresh observation"})
        self.assert_rejected_unchanged()
        self.pin = self.store.current()["state_sha"]
        self.owner["expected_state_sha"] = self.pin
        with patch.object(self.store, "_write", side_effect=StateConflict("synthetic lease conflict")) as write:
            self.assert_rejected_unchanged()
        self.assertEqual(write.call_count, 1)
        self.assertNotIn(self.intent["decision_id"], self.store.current()["completions"])

    def test_ack_loss_is_durable_but_only_exact_owner_replay_can_reconcile(self):
        self.prepare()
        original_git = state_store._git
        def lose_ack(repo, *args, **kwargs):
            result = original_git(repo, *args, **kwargs)
            if "push" in args:
                raise subprocess.TimeoutExpired("synthetic push ack loss", 90)
            return result
        with patch.object(state_store, "_git", side_effect=lose_ack):
            with self.assertRaises(JournalUncertain):
                self.complete()
        current = self.store.current()
        self.assertIsNone(current["active_intent"])
        receipt = current["completions"][self.intent["decision_id"]]
        self.assertEqual(receipt["evidence"]["status"], "failed_before_provider_post")
        self.assertEqual(self.complete(store=self.reader("ack-reconciliation"))["outcome"], "already_completed")
        self.assert_rejected_unchanged(owner={**self.owner, "actor": "owner-b"})
        with self.assertRaises(JournalConflict):
            self.execution.observer_context()


if __name__ == "__main__":
    unittest.main()
