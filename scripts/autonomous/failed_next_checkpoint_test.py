#!/usr/bin/env python3
"""Disposable native Git closure and synthetic authenticated GitHub source boundaries."""
from __future__ import annotations

import copy
import json
import subprocess
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import dispatch_journal_test as journal_fixture
import next_no_effect_artifact as artifact
import state_store
from dispatch_journal import (NEXT, OWNER_FAILED_NEXT_CHECKPOINT, JournalConflict, JournalUncertain,
                              _body, _event, _failed_next_checkpoint_receipt, digest, materialize,
                              normalize_inputs, substantive_digest, validate_journal)
from failed_next_checkpoint import FAILURE_KIND, SUPPORTED_PRODUCER, mutation_candidates
from lab_controller_test import task as implementation_task
from next_no_effect_artifact_test import FailedCheckpointSource
from owner_report_recovery import queue_recovery
from owner_report_recovery_test import NOW, research_manifest
from state_store import load_state
from task_lifecycle import reserve, start
from validate_tasks import validate

CONFIG = {"repository": "synthetic/c-send", "research": {"enabled": True},
          "merge_gate": {"owner_approvers": ["owner-a", "owner-b"]}}


class FailedNextCheckpointTests(unittest.TestCase):
    git = journal_fixture.JournalTests.git
    reader = journal_fixture.JournalTests.reader

    def trigger(self, run="10", attempt="1"):
        return {**journal_fixture.JournalTests.trigger(self, run, attempt), "control_sha": SUPPORTED_PRODUCER}

    def setUp(self):
        journal_fixture.JournalTests.setUp(self)
        self.config = copy.deepcopy(CONFIG)
        self.data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        parked = research_manifest()
        parked["tasks"] = parked["tasks"][:2]
        self.data.update(parked)
        # The original malformed worker report is irrelevant without a pending
        # repair/poll predicate. It remains byte-for-structure conserved, not parsed.
        self.data["tasks"][0]["execution"]["pending_report"] = {"invalid": "original worker prose"}
        queue_recovery(self.data, self.config,
                       inputs={"recover_report": True, "task_id": "first",
                               "repair_after": "2026-10-03T11:00:00Z"},
                       trigger=self.trigger("40"), now=NOW)
        self.assertEqual(validate(self.data), [])
        self.store.save_manifest(self.data)

    def prepare(self, *, inputs=None, control=SUPPORTED_PRODUCER, run="71", attempt="1"):
        command = normalize_inputs(NEXT, {"automatic": True} if inputs is None else inputs)
        sender = {**self.trigger(), "control_sha": control}
        receiver = {**self.trigger(run, attempt), "control_sha": control}
        self.intent, send = self.store.reserve_send(NEXT, command, basis={}, trigger=sender, control_sha=control)
        send.consume()
        _, self.execution = self.store.admit(NEXT, command, key=self.intent["correlation_key"],
                                             trigger=receiver, control_sha=control)
        self.execution.consume()
        self.pin = self.store.current()["state_sha"]
        self.data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.owner = {**self.trigger("500"), "control_sha": "b" * 40,
                      "workflow": OWNER_FAILED_NEXT_CHECKPOINT, "ref": "refs/heads/main",
                      "decision_id": self.intent["decision_id"], "expected_state_sha": self.pin}
        self.source = FailedCheckpointSource()
        title = "Next " + self.intent["correlation_key"]
        for native in (self.source.run, self.source.attempt):
            native["head_sha"] = SUPPORTED_PRODUCER
            native["repository"]["full_name"] = CONFIG["repository"]
            native["head_repository"]["full_name"] = CONFIG["repository"]
            native["actor"]["login"] = "owner-a"
            native["triggering_actor"]["login"] = "owner-a"
            native["display_title"] = title
        self.source.jobs[0]["head_sha"] = SUPPORTED_PRODUCER
        self.source.artifacts[0]["workflow_run"]["head_sha"] = SUPPORTED_PRODUCER
        self.set_report_pin(self.pin)

    def set_report_pin(self, pin):
        self.source.set_report({"action": "stopped", "merge_mode": "manual", "reason": "state_write_failed",
                                "attention": [{"reason": "state save failed; reload the authoritative queue before continuing"}],
                                "state_sha": pin})

    def complete(self, *, owner=None, pin=None, config=None, store=None, decision=None):
        with ExitStack() as stack:
            # Only transport is injected: real source/ZIP validators and real Git
            # blob/commit/lineage/CAS/receipt logic run against disposable storage.
            stack.enter_context(patch.object(artifact, "_default_json", side_effect=lambda repository, endpoint:
                                             self.source.get_json(endpoint)))
            stack.enter_context(patch.object(artifact, "_default_archive", side_effect=lambda repository, endpoint:
                                             self.source.get_archive(endpoint)))
            return (store or self.store).complete_failed_next_checkpoint(
                decision_id=decision or self.intent["decision_id"],
                expected_state_sha=self.pin if pin is None else pin,
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

    def publish(self, data):
        sha = state_store._commit(self.repo, (json.dumps(data) + "\n").encode(), self.pin)
        self.git(self.repo, "push", "--force-with-lease=refs/heads/autonomous/state:" + self.pin,
                 "origin", sha + ":refs/heads/autonomous/state")
        self.pin = sha
        self.owner["expected_state_sha"] = sha
        self.set_report_pin(sha)
        return sha

    def case(self):
        fixture = self.__class__("runTest")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        return fixture

    def test_first_closure_is_one_acknowledged_cas_terminal_failure_and_conserves_every_body(self):
        self.prepare()
        before = copy.deepcopy(self.data)
        old = materialize(before["dispatch_journal"])
        claim = old["executor_claims"][self.intent["decision_id"]]
        baseline = self.store._checkpoint_state(claim["before_state_sha"])
        self.assertEqual(_body(baseline), _body(before))
        with patch.object(self.store, "_write", wraps=self.store._write) as writes:
            result = self.complete()
        self.assertEqual(writes.call_count, 1)
        self.assertEqual(set(result), {"outcome", "decision_id", "receipt_id", "kind", "state_sha", "frontier_seq"})
        self.assertEqual((result["outcome"], result["kind"]), ("completed", FAILURE_KIND))
        saved = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        current = materialize(saved["dispatch_journal"])
        self.assertEqual(_body(saved), _body(before))
        self.assertEqual(saved["dispatch_journal"]["events"][:-1], before["dispatch_journal"]["events"])
        for field in ("intents", "send_claims", "executor_claims", "effects", "phase_claims", "stages"):
            self.assertEqual(current[field], old[field])
        event = current["completions"][self.intent["decision_id"]]
        self.assertEqual(event["type"], "OwnerFailedNextCheckpointCompletion")
        self.assertEqual(event["native_report"], self.source.report)
        self.assertEqual(event["evidence"], {
            "status": "failed_before_external_mutation", "action": "stopped", "reason": "state_write_failed",
            "before_state_sha": claim["before_state_sha"], "after_state_sha": self.pin,
            "before_digest": substantive_digest(baseline), "after_digest": substantive_digest(before),
            "body_sha256": digest(_body(before)),
        })
        self.assertIsNone(current["active_intent"])
        self.assertEqual(current["frontier_seq"], old["frontier_seq"] + 1)
        self.assertEqual(current["predecessor_decision_id"], self.intent["decision_id"])
        self.assertIn(event["receipt_id"], current["completed_receipts"])
        self.assertEqual(validate(saved), [])
        self.assertEqual(self.store.outcome_for_trigger(self.trigger("71")), event)
        self.assertTrue(self.store.advance(event["receipt_id"]))

    def test_changed_protected_body_including_digest_ignored_clocks_is_rejected(self):
        for change in ("clock", "identity", "history", "request", "task"):
            with self.subTest(change=change):
                case = self.case()
                case.prepare()
                changed = copy.deepcopy(case.data)
                if change == "clock":
                    changed["controller"]["last_tick_at"] = "2026-10-03T11:31:00Z"
                    self.assertEqual(substantive_digest(changed), substantive_digest(case.data))
                elif change == "identity":
                    changed["tasks"][1]["execution"]["session_id"] = "foreign"
                elif change == "history":
                    changed["protected"]["history"].append({"result": "unrelated"})
                elif change == "request":
                    changed["controller"]["owner_recovery_requests"][0]["source_trigger"]["actor"] = "owner-b"
                else:
                    changed["tasks"][1]["title"] = "Changed task"
                case.publish(changed)
                case.assert_rejected_unchanged()

    def test_effect_completion_phase_stage_or_other_journal_delta_is_rejected(self):
        for event_type in ("EffectObservation", "ExecutionCompletion", "ExecutionStage", "PhaseClaim",
                           "DeliveryObservation"):
            with self.subTest(event_type=event_type):
                case = self.case()
                case.prepare()
                changed = copy.deepcopy(case.data)
                claim = materialize(changed["dispatch_journal"])["executor_claims"][case.intent["decision_id"]]
                fields = {"decision_id": case.intent["decision_id"], "executor_claim_id": claim["claim_id"]}
                if event_type == "EffectObservation":
                    fields.update(kind="controller_checkpoint", evidence={
                        "before_state_sha": claim["before_state_sha"], "after_state_sha": case.pin,
                        "before_digest": claim["before_digest"], "after_digest": claim["before_digest"],
                        "poll_observations": [{"task_id": "first", "session_id": "1",
                                               "session_state": "COMPLETED", "observed_at": "2026-10-03T12:00:00Z"}]})
                elif event_type == "ExecutionCompletion":
                    fields.update(kind="next_no_effect", evidence={"status": "no_effect", "action": "none",
                        "reason": "no_todo_tasks", "before_state_sha": claim["before_state_sha"],
                        "after_state_sha": case.pin, "before_digest": claim["before_digest"],
                        "after_digest": claim["before_digest"]}, frontier_seq=1)
                elif event_type == "DeliveryObservation":
                    fields.update(observation={"kind": "late observation"})
                else:
                    fields.update(phase="sync_prepared", evidence={})
                if event_type in ("EffectObservation", "ExecutionCompletion"):
                    from dispatch_journal import _receipt_id
                    fields["receipt_id"] = _receipt_id(case.intent["decision_id"], claim["claim_id"],
                                                       fields["kind"], fields["evidence"])
                changed["dispatch_journal"]["events"].append(_event(event_type, **fields))
                case.publish(changed)
                case.assert_rejected_unchanged()

    def test_every_actual_poll_nudge_repair_rejection_review_reserved_release_and_selection_candidate_is_denied(self):
        for candidate in ("poll", "research_nudge", "implementation_nudge", "pending_repair", "rejection",
                          "review", "quarantine", "reserved_allow_create_false", "release_ref", "selected_todo"):
            with self.subTest(candidate=candidate):
                case = self.case()
                if candidate == "pending_repair":
                    case.data["tasks"][0]["execution"]["report_repair"]["status"] = "pending"
                else:
                    worker = copy.deepcopy(research_manifest()["tasks"][2])
                    if candidate in ("implementation_nudge", "rejection", "review", "release_ref"):
                        worker = implementation_task("worker")
                        key = "a" * 24
                        reserve({"tasks": [worker]}, worker["id"], key, base_sha="b" * 40,
                                starting_branch="autonomous/attempt-" + key, now=NOW)
                        start({"tasks": [worker]}, worker["id"], session_id="worker-session", dispatch_key=key, now=NOW)
                        worker["proposal_decision"]["actor"] = "owner-a"
                        worker["execution"]["session_state"] = "IN_PROGRESS"
                    execution = worker["execution"]
                    if candidate == "research_nudge":
                        execution.update(session_state="AWAITING_USER_FEEDBACK",
                                         research_detached={"at": "2026-10-03T11:00:00Z", "reason": "AWAITING_USER_FEEDBACK"})
                    elif candidate == "implementation_nudge":
                        execution["session_state"] = "AWAITING_USER_FEEDBACK"
                    elif candidate == "rejection":
                        worker["status"] = "blocked"
                        execution.update(state="quarantined", outcome="stale")
                        worker["proposal_decision"] = {"action": "reject", "status": "pending", "actor": "owner-a",
                                                       "session_id": execution["session_id"], "dispatch_key": execution["dispatch_key"],
                                                       "note": "Stop this worker", "at": "2026-10-03T12:00:00Z"}
                    elif candidate == "review":
                        worker["status"] = "blocked"
                        execution.update(state="awaiting_review", outcome="review_required", pull_request=59)
                    elif candidate == "quarantine":
                        worker["status"] = "blocked"
                        execution.update(state="quarantined", outcome="stale")
                    elif candidate == "reserved_allow_create_false":
                        execution.pop("session_id")
                        execution.pop("started_at")
                        execution.pop("session_state")
                        execution["state"] = "dispatching"
                    elif candidate == "release_ref":
                        worker["status"] = "done"
                        execution.update(state="completed", outcome="no_change", session_state="COMPLETED")
                    elif candidate == "selected_todo":
                        worker["status"] = "todo"
                        worker.pop("execution")
                    case.data["tasks"].append(worker)
                self.assertEqual(validate(case.data), [])
                self.assertTrue(mutation_candidates(case.data, normalize_inputs(NEXT, {"automatic": True})))
                case.store.save_manifest(case.data)
                case.prepare()
                case.assert_rejected_unchanged()

    def test_current_research_disable_cannot_hide_a_historically_selected_existing_task(self):
        todo = copy.deepcopy(research_manifest()["tasks"][2])
        todo["status"] = "todo"
        todo.pop("execution")
        self.data["tasks"].append(todo)
        self.assertEqual(validate(self.data), [])
        self.store.save_manifest(self.data)
        self.prepare()
        config = copy.deepcopy(self.config)
        config["research"]["enabled"] = False
        self.assert_rejected_unchanged(config=config)

    def test_foreign_forged_corrupt_archive_and_native_identity_are_rejected_without_writes(self):
        for change in ("digest", "zip", "report", "actor", "repository", "title", "job", "artifact_run"):
            with self.subTest(change=change):
                case = self.case()
                case.prepare()
                if change == "digest":
                    case.source.detail["digest"] = "sha256:" + "f" * 64
                elif change == "zip":
                    case.source.set_archive(b"not a zip")
                elif change == "report":
                    case.source.set_report({**case.source.report, "action": "none"})
                elif change == "actor":
                    case.source.attempt["actor"]["login"] = "foreign"
                elif change == "repository":
                    case.source.run["repository"]["full_name"] = "foreign/repository"
                elif change == "title":
                    case.source.run["display_title"] = "Next " + "f" * 32
                elif change == "job":
                    case.source.jobs[0]["head_sha"] = "f" * 40
                else:
                    case.source.artifacts[0]["workflow_run"]["id"] = 72
                case.assert_rejected_unchanged()

    def test_artifact_cannot_be_reassigned_to_foreign_decision_or_run(self):
        self.prepare()
        decision = "f" * 64
        self.assert_rejected_unchanged(decision=decision, owner={**self.owner, "decision_id": decision})
        case = self.case()
        case.prepare(run="72")
        case.assert_rejected_unchanged()

    def test_unknown_historical_producer_is_denied_before_native_read(self):
        self.prepare(control="c" * 40)
        self.assert_rejected_unchanged()
        self.assertEqual(self.source.calls, [])

    def test_original_attempt_two_and_nonexact_automatic_inputs_are_denied(self):
        for command, attempt in (({"automatic": True}, "2"), ({"automatic": False}, "1"),
                                 ({"automatic": True, "focus": "quality"}, "1"),
                                 ({"automatic": True, "risk_ceiling": "high"}, "1"),
                                 ({"automatic": True, "recover_report": True, "task_id": "first"}, "1")):
            with self.subTest(command=command, attempt=attempt):
                case = self.case()
                case.prepare(inputs=command, attempt=attempt)
                case.assert_rejected_unchanged()
                self.assertEqual(case.source.calls, [])

    def test_native_report_must_name_requested_current_pin_and_exact_parent(self):
        self.prepare()
        claim = materialize(self.data["dispatch_journal"])["executor_claims"][self.intent["decision_id"]]
        self.set_report_pin(claim["before_state_sha"])
        self.assert_rejected_unchanged()
        self.publish(self.data)  # Even a same-content extra commit is outside claim-only lineage.
        self.assert_rejected_unchanged()

    def test_cas_competitor_preserved_with_one_attempt_and_no_retry(self):
        self.prepare()
        competitor = self.reader("competitor")
        real_write = self.store._write
        writes = []
        def race(data):
            writes.append(1)
            competitor.current()
            fresh = load_state(self.repo, competitor.manifest_path, competitor.revision_path)
            fresh["protected"]["history"].append({"result": "competitor must survive"})
            competitor.save_manifest(fresh)
            return real_write(data)
        with patch.object(self.store, "_write", side_effect=race):
            with self.assertRaises(JournalConflict):
                self.complete()
        self.assertEqual(len(writes), 1)
        saved = json.loads(self.authoritative_bytes())
        self.assertEqual(saved["protected"]["history"][-1], {"result": "competitor must survive"})
        self.assertNotIn(self.intent["decision_id"], materialize(saved["dispatch_journal"])["completions"])

    def test_committed_lost_ack_grants_nothing_and_exact_replay_recovers_without_cas(self):
        self.prepare()
        original_git = state_store._git
        pushes = []
        def lose_ack(repo, *args, **kwargs):
            result = original_git(repo, *args, **kwargs)
            if "push" in args:
                pushes.append(1)
                raise subprocess.TimeoutExpired("synthetic lost push ack", 90)
            return result
        with patch.object(state_store, "_git", side_effect=lose_ack):
            with self.assertRaises(JournalUncertain):
                self.complete()
        self.assertEqual(len(pushes), 1)
        saved = json.loads(self.authoritative_bytes())
        self.assertEqual(len(saved["dispatch_journal"]["events"]), len(self.data["dispatch_journal"]["events"]) + 1)
        receipt = materialize(saved["dispatch_journal"])["completions"][self.intent["decision_id"]]
        self.assertEqual(receipt["kind"], FAILURE_KIND)
        reads = self.source.run_reads
        reader = self.reader("reconcile")
        with patch.object(reader, "_write", side_effect=AssertionError("replay must not write")):
            result = self.complete(store=reader, owner={**self.owner, "run_attempt": "2"})
        self.assertEqual((result["outcome"], result["receipt_id"]), ("already_completed", receipt["receipt_id"]))
        self.assertEqual(self.source.run_reads, reads)
        with self.assertRaises(JournalConflict):
            self.execution.observer_context()

    def test_exact_replay_owner_rerun_returns_same_receipt_without_proof_or_write(self):
        self.prepare()
        first = self.complete()
        stable = self.authoritative_bytes()
        reads = self.source.run_reads
        reader = self.reader("exact-replay")
        with patch.object(reader, "_write", side_effect=AssertionError("replay must not write")):
            for owner in (self.owner, {**self.owner, "run_attempt": "2"}):
                result = self.complete(owner=owner, store=reader)
                self.assertEqual(result, {**first, "outcome": "already_completed"})
        self.assertEqual(self.source.run_reads, reads)
        self.assertEqual(self.authoritative_bytes(), stable)

    def test_replay_changed_pin_event_type_or_any_owner_context_is_denied_before_native_read(self):
        self.prepare()
        result = self.complete()
        reads = self.source.run_reads
        for overrides in ({"actor": "owner-b"}, {"run_id": "501"}, {"control_sha": "c" * 40},
                          {"workflow": "autonomous_complete_next.yml"}, {"repository": "foreign/repository"},
                          {"ref": "refs/heads/foreign"}, {"event_name": "schedule"}):
            with self.subTest(overrides=overrides):
                self.assert_rejected_unchanged(owner={**self.owner, **overrides})
        self.assert_rejected_unchanged(pin=result["state_sha"],
                                       owner={**self.owner, "expected_state_sha": result["state_sha"]})
        self.assertEqual(self.source.run_reads, reads)
        changed = json.loads(self.authoritative_bytes())
        event = changed["dispatch_journal"]["events"][-1]
        event["type"] = "OwnerNextCompletion"
        event["event_id"] = digest({key: value for key, value in event.items() if key != "event_id"})
        self.assertTrue(validate_journal(changed["dispatch_journal"]))

    def test_current_owner_producer_and_repository_authorization_are_required_even_on_replay(self):
        self.prepare()
        # Use a different currently authorized closing owner to test the producer independently.
        self.owner["actor"] = "owner-b"
        self.complete()
        for allowed in (["owner-a"], ["owner-b"]):
            config = copy.deepcopy(self.config)
            config["merge_gate"]["owner_approvers"] = allowed
            self.assert_rejected_unchanged(config=config)
        self.assert_rejected_unchanged(config={**self.config, "repository": "foreign/repository"})

    def test_second_distinct_authorization_cannot_append_another_terminal(self):
        self.prepare()
        self.complete()
        self.assert_rejected_unchanged(owner={**self.owner, "run_id": "501"})
        self.assertEqual(sum(event["type"] == "OwnerFailedNextCheckpointCompletion"
                             for event in json.loads(self.authoritative_bytes())["dispatch_journal"]["events"]), 1)

    def test_late_original_receiver_capability_and_observer_are_terminal(self):
        self.prepare()
        self.complete()
        stable = self.authoritative_bytes()
        for attempt in ("1", "2"):
            reader = self.reader("late-" + attempt)
            intent, cap = reader.admit(NEXT, self.intent["normalized_inputs"], key=self.intent["correlation_key"],
                                       trigger=self.trigger("71", attempt), control_sha=SUPPORTED_PRODUCER)
            self.assertIsNone(cap)
            self.assertEqual(reader.nonexecution_outcome(intent, key=self.intent["correlation_key"],
                trigger=self.trigger("71", attempt), control_sha=SUPPORTED_PRODUCER)["reason"],
                "execution_outcome_already_recorded")
        for operation in (self.execution.consume, self.execution.observer_context,
                          lambda: self.store.record_effect(self.execution, "controller_checkpoint", {})):
            with self.assertRaises(JournalConflict):
                operation()
        self.assertEqual(self.authoritative_bytes(), stable)

    def test_materializer_rejects_rehashed_forgery_failure_laundering_and_receipt_frontier_drift(self):
        self.prepare()
        self.complete()
        saved = json.loads(self.authoritative_bytes())
        for change in ("receipt", "kind", "status", "attention", "producer", "report_pin", "frontier", "extra"):
            with self.subTest(change=change):
                journal = copy.deepcopy(saved["dispatch_journal"])
                event = journal["events"][-1]
                if change == "receipt":
                    event["receipt_id"] = "f" * 64
                elif change == "kind":
                    event["kind"] = "next_no_effect"
                elif change == "status":
                    event["evidence"]["status"] = "no_effect"
                elif change == "attention":
                    event["native_report"]["attention"] = []
                elif change == "producer":
                    event["proof"]["producer"]["run_attempt"] = "2"
                elif change == "report_pin":
                    event["native_report"]["state_sha"] = "f" * 40
                elif change == "frontier":
                    event["frontier_seq"] += 1
                else:
                    event["capability"] = True
                if change != "receipt":
                    event["receipt_id"] = _failed_next_checkpoint_receipt(event)
                event["event_id"] = digest({key: value for key, value in event.items() if key != "event_id"})
                self.assertTrue(validate_journal(journal))


if __name__ == "__main__":
    unittest.main()
