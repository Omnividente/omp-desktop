#!/usr/bin/env python3
"""Behavior regressions for acknowledged one-use claims and causal state transitions."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import state_store
from dispatch_journal import CONTINUE, NEXT, SYNC, JournalConflict, JournalStore, JournalUncertain
from state_store import StateConflict, load_state, save_state

CONTROL = "a" * 40


class JournalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo, self.remote = self.root / "repo", self.root / "remote.git"
        self.git(self.root, "init", "--bare", str(self.remote))
        self.git(self.root, "init", str(self.repo))
        self.git(self.repo, "config", "user.name", "synthetic")
        self.git(self.repo, "config", "user.email", "fixture@example.invalid")
        self.git(self.repo, "config", "commit.gpgsign", "false")
        self.seed = {"version": 2, "autonomous_loop_policy": {}, "tasks": [],
                     "protected": {"request": "synthetic immutable", "owner": "owner-a",
                                   "history": [{"result": "synthetic accepted"}]}}
        (self.repo / "agent_tasks.json").write_text(json.dumps(self.seed), encoding="utf-8")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "synthetic fixture")
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.git(self.repo, "push", "origin", "HEAD:refs/heads/autonomous/lab")
        self.store = self.reader("primary")
        load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        original = save_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.basis = {"kind": "fenced_bootstrap", "state_sha": original,
                      "legacy_senders_fenced": True, "pending_legacy": "none"}
        self.initial = self.store.initialize(original, CONTROL, self.basis)

    def git(self, repo, *args):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
                              check=True, capture_output=True).stdout.strip().decode()

    def reader(self, name):
        return JournalStore(self.repo, self.root / (name + ".json"), self.root / (name + "-revision.json"))

    def trigger(self, run="10", attempt="1"):
        return {"run_id": run, "run_attempt": attempt, "event_name": "workflow_dispatch",
                "control_sha": CONTROL, "repository": "synthetic/c-send", "actor": "owner-a"}

    def reserve(self, store=None, workflow=NEXT, inputs=None, trigger=None):
        store = store or self.store
        state = store.current()
        predecessor = state["predecessor_decision_id"]
        outcome = state["effects"].get(predecessor) or state["completions"].get(predecessor)
        basis = {"receipt_id": outcome["receipt_id"]} if outcome else {}
        return store.reserve_send(workflow, inputs or {}, basis=basis,
                                  trigger=trigger or self.trigger(), control_sha=CONTROL)

    def execute(self, workflow=NEXT, inputs=None):
        intent, send = self.reserve(workflow=workflow, inputs=inputs)
        send.consume()
        _, execution = self.store.admit(workflow, inputs or {}, key=intent["correlation_key"],
                                        trigger=self.trigger("20"), control_sha=CONTROL)
        execution.consume()
        return intent, execution

    def checkpoint(self, capability):
        before = self.store.current()["state_sha"]
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        data["meaningful_owner_result"] = {"outcome": "synthetic completed", "source": "fixture"}
        after = self.store.save_manifest(data)
        return self.store.record_effect(capability, "controller_checkpoint",
                                        {"before_state_sha": before, "after_state_sha": after})

    def test_existing_claim_noop_reload_and_new_owner_never_issue_another_capability(self):
        intent, capability = self.reserve()
        capability.consume()
        with self.assertRaises(JournalConflict):
            capability.consume()
        for index, trigger in enumerate((self.trigger(), self.trigger("10", "2"), self.trigger("999"))):
            other, cap = self.reserve(self.reader("owner-" + str(index)), trigger=trigger)
            self.assertEqual(other["decision_id"], intent["decision_id"])
            self.assertEqual(other["correlation_key"], intent["correlation_key"])
            self.assertIsNone(cap)
        current = self.store.current()
        self.assertEqual(len(current["send_claims"]), 1)
        self.assertEqual(current["frontier_seq"], 0)

    def test_changed_inputs_workflow_or_control_do_not_create_conflicting_intents(self):
        self.reserve()
        for workflow, inputs, control in ((NEXT, {"task_id": "foreign"}, CONTROL),
                                         (SYNC, {}, CONTROL), (NEXT, {}, "b" * 40)):
            with self.assertRaises(JournalConflict):
                self.store.reserve_send(workflow, inputs, basis={},
                                        trigger={**self.trigger("11"), "control_sha": control}, control_sha=control)
        self.assertEqual(len(self.store.current()["intents"]), 1)

    def test_lost_cas_ack_is_durable_but_never_returns_send_or_execution_capability(self):
        original_git = state_store._git
        def lost_ack(repo, *args, **kwargs):
            result = original_git(repo, *args, **kwargs)
            if "push" in args:
                raise subprocess.TimeoutExpired("synthetic git push", 90)
            return result
        with patch.object(state_store, "_git", side_effect=lost_ack):
            with self.assertRaises(JournalUncertain):
                self.reserve()
        intent, cap = self.reserve(self.reader("restart"), trigger=self.trigger("99"))
        self.assertIsNone(cap)
        with patch.object(state_store, "_git", side_effect=lost_ack):
            with self.assertRaises(JournalUncertain):
                self.store.admit(NEXT, {}, key=intent["correlation_key"], trigger=self.trigger("20"), control_sha=CONTROL)
        _, cap = self.reader("receiver-restart").admit(NEXT, {}, key=intent["correlation_key"],
                                                     trigger=self.trigger("20", "2"), control_sha=CONTROL)
        self.assertIsNone(cap)

    def test_executor_is_separate_and_rerun_or_late_receiver_cannot_execute_again(self):
        intent, execution = self.execute()
        for trigger in (self.trigger("20", "2"), self.trigger("21")):
            _, cap = self.reader("receiver-" + trigger["run_id"]).admit(
                NEXT, {}, key=intent["correlation_key"], trigger=trigger, control_sha=CONTROL)
            self.assertIsNone(cap)
        receipt = self.checkpoint(execution)
        self.store.advance(receipt["receipt_id"])
        _, cap = self.store.admit(NEXT, {}, key=intent["correlation_key"], trigger=self.trigger("23"), control_sha=CONTROL)
        self.assertIsNone(cap)

    def test_keyless_ingress_cannot_execute_or_advance_a_pending_internal_timer(self):
        intent, send = self.reserve(workflow=CONTINUE)
        send.consume()
        self.store.observe_delivery(intent["decision_id"], {"kind": "post_unknown"})
        before = self.store.current()
        for event in ("schedule", "workflow_dispatch", "workflow_run"):
            with self.subTest(event=event):
                trigger = {**self.trigger("99", "2"), "event_name": event, "actor": "owner-b"}
                if event == "workflow_run":
                    trigger.update(source_run_id="88", source_run_attempt="1")
                bound, capability = self.reader(event).admit(
                    CONTINUE, {}, key="", trigger=trigger, control_sha=CONTROL)
                self.assertEqual(bound["decision_id"], intent["decision_id"])
                self.assertIsNone(capability)
                self.assertEqual(self.store.current(), before)
        _, execution = self.store.admit(CONTINUE, {}, key=intent["correlation_key"],
                                        trigger=self.trigger("20"), control_sha=CONTROL)
        self.assertIsNotNone(execution)

    def test_source_workflow_rerun_cannot_create_another_callback_frontier(self):
        trigger = {**self.trigger("20"), "event_name": "workflow_run",
                   "source_run_id": "77", "source_run_attempt": "1"}
        intent, execution = self.store.admit(CONTINUE, {}, key="", trigger=trigger, control_sha=CONTROL)
        execution.consume()
        state_sha = self.store.current()["state_sha"]
        head = self.git(self.repo, "rev-parse", "HEAD")
        receipt = self.store.record_effect(execution, "continue_handoff", {
            **trigger, "decision_id": intent["decision_id"], "stage": "bounded_observe_wait",
            "stage_started_at": "2026-10-01T00:00:00Z", "stage_completed_at": "2026-10-01T00:01:00Z",
            "waited_seconds": 60, "switch_enabled": True,
            "observation": {"health": "ok", "action": "none", "reason": "terminal",
                            "main_sha": head, "lab_sha": head, "state_sha": state_sha, "due_at": None}})
        self.store.advance(receipt["receipt_id"])
        before = self.store.current()
        rerun = {**trigger, "run_id": "99", "run_attempt": "2", "source_run_attempt": "2"}
        bound, capability = self.reader("source-rerun").admit(
            CONTINUE, {}, key="", trigger=rerun, control_sha=CONTROL)
        self.assertIsNone(bound)
        self.assertIsNone(capability)
        self.assertEqual(self.store.current(), before)

    def test_journal_and_timestamp_only_changes_do_not_advance(self):
        intent, execution = self.execute()
        before = self.store.current()["state_sha"]
        self.store.observe_delivery(intent["decision_id"], {"kind": "run_observed", "run_id": "20"})
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        data["controller"] = {"last_tick_at": "2026-10-01T00:00:00Z", "run_id": "20"}
        after = self.store.save_manifest(data)
        with self.assertRaises(ValueError):
            self.store.record_effect(execution, "controller_checkpoint", {"before_state_sha": before, "after_state_sha": after})
        state = self.store.current()
        self.assertEqual(state["frontier_seq"], 0)
        self.assertEqual(state["effects"], {})
        with self.assertRaises(JournalConflict):
            self.store.advance("b" * 64)

    def test_receipt_advances_once_and_sender_reuses_original_causal_frontier(self):
        _, execution = self.execute()
        receipt = self.checkpoint(execution)
        self.assertEqual(self.store.outcome_for_trigger(self.trigger("20")), receipt)
        self.assertIsNone(self.store.outcome_for_trigger(self.trigger("20", "2")))
        self.store.advance(receipt["receipt_id"])
        intent, cap = self.reserve(workflow=CONTINUE, trigger=self.trigger("20"))
        cap.consume()
        for _ in range(3):
            self.store.advance(receipt["receipt_id"])
        repeated, cap = self.reserve(self.reader("callback"), workflow=CONTINUE, trigger=self.trigger("999"))
        self.assertIsNone(cap)
        self.assertEqual(repeated["decision_id"], intent["decision_id"])
        self.assertEqual(self.store.current()["frontier_seq"], 1)

    def test_journal_only_writer_preserves_every_substantive_field_and_prefix(self):
        original = load_state(self.repo, self.root / "original.json", self.root / "original-revision.json")
        self.reserve()
        current = load_state(self.repo, self.root / "current.json", self.root / "current-revision.json")
        self.assertEqual({key: value for key, value in original.items() if key != "dispatch_journal"},
                         {key: value for key, value in current.items() if key != "dispatch_journal"})
        prefix = original["dispatch_journal"]["events"]
        self.assertEqual(current["dispatch_journal"]["events"][:len(prefix)], prefix)

    def test_stale_substantive_writer_is_rejected_but_journal_only_rebase_is_safe(self):
        self.store.current()
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        other = self.reader("other")
        self.reserve(other)
        data["legitimate_result"] = "first"
        self.store.save_manifest(data)
        other.current()
        stale = load_state(self.repo, other.manifest_path, other.revision_path)
        newer = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        newer["legitimate_result"] = "newer"
        self.store.manifest_path.write_text(json.dumps(newer), encoding="utf-8")
        save_state(self.repo, self.store.manifest_path, self.store.revision_path)
        stale["legitimate_result"] = "stale"
        with self.assertRaises(JournalConflict):
            other.save_manifest(stale)
        self.assertEqual(load_state(self.repo, self.root / "read.json", self.root / "read-revision.json")["legitimate_result"], "newer")

    def test_direct_writer_cannot_drop_rewrite_or_truncate_journal(self):
        self.reserve()
        for mutation in ("drop", "truncate", "rewrite"):
            manifest, revision = self.root / (mutation + ".json"), self.root / (mutation + "-revision.json")
            data = load_state(self.repo, manifest, revision)
            if mutation == "drop":
                data.pop("dispatch_journal")
            elif mutation == "truncate":
                data["dispatch_journal"]["events"] = data["dispatch_journal"]["events"][:1]
            else:
                data["dispatch_journal"]["events"][0]["basis"]["pending_legacy"] = "invented"
            manifest.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError):
                save_state(self.repo, manifest, revision)

    def test_initialize_is_not_a_reset_and_requires_exact_state_pin(self):
        with self.assertRaises(JournalConflict):
            self.store.initialize(self.initial, CONTROL, {**self.basis, "state_sha": self.initial})
        with self.assertRaises(JournalConflict):
            self.store.initialize("b" * 40, CONTROL, {**self.basis, "state_sha": "b" * 40})
        self.assertEqual(self.store.current()["frontier_seq"], 0)

    def test_sync_finalization_is_one_original_run_attempt_phase_not_a_second_executor(self):
        _, execution = self.execute(SYNC, {"main_sha": CONTROL, "lab_sha": "b" * 40})
        evidence = {"status": "prepared", "main_sha": CONTROL, "lab_sha": "b" * 40,
                    "candidate_sha": "c" * 40, "queue_blob": "d" * 40,
                    "candidate_branch": "autonomous/sync-20-1", "candidate_owned": True}
        reference = self.store.record_checkpoint(execution, "sync_prepared", evidence)
        with self.assertRaises(JournalConflict):
            self.store.claim_phase(execution.decision_id, "sync_finalize", self.trigger("20", "2"), CONTROL, reference)
        with self.assertRaises(JournalConflict):
            self.store.claim_phase(execution.decision_id, "sync_finalize", self.trigger("20"), CONTROL,
                                   {**reference, "evidence": {**evidence, "candidate_sha": "e" * 40}})
        cap = self.store.claim_phase(execution.decision_id, "sync_finalize", self.trigger("20"), CONTROL, reference)
        cap.consume()
        self.assertIsNone(self.reader("finalize-restart").claim_phase(
            execution.decision_id, "sync_finalize", self.trigger("20"), CONTROL, reference))
        state = self.store.current()
        self.assertEqual(len(state["executor_claims"]), 1)
        self.assertEqual(state["frontier_seq"], 0)
        self.assertEqual(state["effects"], {})

    def test_proven_noop_sync_closes_without_effect_or_reissued_execution(self):
        head = self.git(self.repo, "rev-parse", "HEAD")
        self.git(self.repo, "push", "origin", "HEAD:refs/heads/main")
        intent, execution = self.execute(SYNC, {"main_sha": head, "lab_sha": head})
        evidence = {"status": "up_to_date", "reason": "main_already_integrated",
                    "main_sha": head, "lab_sha": head, "candidate_sha": "",
                    "queue_blob": self.git(self.repo, "rev-parse", "HEAD:agent_tasks.json"),
                    "candidate_branch": "autonomous/sync-20-1"}
        completion = self.store.record_completion(execution, evidence)
        state = self.store.current()
        self.assertIsNone(state["active_intent"])
        self.assertEqual(state["effects"], {})
        self.assertEqual(state["frontier_seq"], 1)
        self.assertEqual(state["completed_receipts"], {completion["receipt_id"]})
        self.assertEqual(self.store.outcome_for_trigger(self.trigger("20")), completion)
        before = state["state_sha"]
        self.assertTrue(self.store.advance(completion["receipt_id"]))
        _, replay = self.store.admit(SYNC, intent["normalized_inputs"], key=intent["correlation_key"],
                                     trigger=self.trigger("20", "2"), control_sha=CONTROL)
        self.assertIsNone(replay)
        self.assertEqual(self.store.current()["state_sha"], before)
        _, next_execution = self.store.admit(NEXT, {}, key="", trigger=self.trigger("30"), control_sha=CONTROL)
        self.assertIsNotNone(next_execution)
        saved = load_state(self.repo, self.root / "no-effect.json", self.root / "no-effect-revision.json")
        self.assertEqual(saved["protected"], self.seed["protected"])
        self.assertNotIn("controller", saved)

    def test_noop_completion_rejects_published_candidate(self):
        head = self.git(self.repo, "rev-parse", "HEAD")
        self.git(self.repo, "push", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/autonomous/sync-20-1")
        _, execution = self.execute(SYNC, {"main_sha": head, "lab_sha": head})
        with self.assertRaises(JournalConflict):
            self.store.record_completion(execution, {
                "status": "up_to_date", "reason": "main_already_integrated", "main_sha": head,
                "lab_sha": head, "candidate_sha": "", "candidate_branch": "autonomous/sync-20-1",
                "queue_blob": self.git(self.repo, "rev-parse", "HEAD:agent_tasks.json")})
        self.assertEqual(self.store.current()["frontier_seq"], 0)
        self.assertEqual(self.store.current()["completions"], {})

    def test_superseded_receipt_cannot_authorize_a_new_sender(self):
        _, first = self.execute()
        receipt_a = self.checkpoint(first)
        self.store.advance(receipt_a["receipt_id"])
        successor, _ = self.reserve(workflow=CONTINUE)
        _, executor = self.store.admit(CONTINUE, {}, key=successor["correlation_key"],
                                       trigger=self.trigger("30"), control_sha=CONTROL)
        executor.consume()
        state_sha = self.store.current()["state_sha"]
        head = self.git(self.repo, "rev-parse", "HEAD")
        receipt_b = self.store.record_effect(executor, "continue_handoff", {
            **self.trigger("30"), "decision_id": successor["decision_id"], "switch_enabled": True,
            "stage": "bounded_observe_wait", "stage_started_at": "2026-10-01T00:00:00Z",
            "stage_completed_at": "2026-10-01T00:00:00Z", "waited_seconds": 0,
            "observation": {"health": "ok", "action": "none", "reason": "terminal", "due_at": None,
                            "main_sha": head, "lab_sha": head, "state_sha": state_sha}})
        self.store.advance(receipt_b["receipt_id"])
        before = self.store.current()["state_sha"]
        self.assertFalse(self.store.advance(receipt_a["receipt_id"]))
        with self.assertRaises(JournalConflict):
            self.store.reserve_send(CONTINUE, {}, basis={"receipt_id": receipt_a["receipt_id"]},
                                    trigger=self.trigger("20"), control_sha=CONTROL)
        self.assertEqual(self.store.current()["state_sha"], before)
        current, capability = self.store.reserve_send(CONTINUE, {}, basis={"receipt_id": receipt_b["receipt_id"]},
                                                     trigger=self.trigger("30"), control_sha=CONTROL)
        self.assertIsNotNone(capability)
        self.assertEqual(current["predecessor_decision_id"], successor["decision_id"])

    def test_next_no_effect_closes_once_without_useful_progress_or_task_mutation(self):
        intent, execution = self.execute()
        before = self.store.current()["state_sha"]
        receipt = self.store.record_completion(execution, {
            "status": "no_effect", "action": "none", "reason": "explicit_task_not_todo",
            "before_state_sha": before, "after_state_sha": before})
        state = self.store.current()
        self.assertIsNone(state["active_intent"])
        self.assertEqual(state["effects"], {})
        self.assertEqual(state["frontier_seq"], 1)
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.assertEqual({key: value for key, value in data.items() if key != "dispatch_journal"}, self.seed)
        self.assertTrue(self.store.advance(receipt["receipt_id"]))
        _, replay = self.store.admit(NEXT, {}, key=intent["correlation_key"],
                                     trigger=self.trigger("20", "2"), control_sha=CONTROL)
        self.assertIsNone(replay)
        with self.assertRaises(JournalConflict):
            self.store.record_completion(execution, receipt["evidence"])
        successor, send = self.reserve(workflow=CONTINUE, trigger=self.trigger("20"))
        self.assertEqual(successor["predecessor_decision_id"], intent["decision_id"])
        self.assertIsNotNone(send)

    def test_next_no_effect_rejects_changed_substance_and_does_not_free_frontier(self):
        intent, execution = self.execute()
        before = self.store.current()["state_sha"]
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        data["protected"]["owner"] = "changed"
        after = self.store.save_manifest(data)
        with self.assertRaises(ValueError):
            self.store.record_completion(execution, {
                "status": "no_effect", "action": "none", "reason": "explicit_task_not_todo",
                "before_state_sha": before, "after_state_sha": after})
        state = self.store.current()
        self.assertEqual(state["active_intent"]["decision_id"], intent["decision_id"])
        self.assertEqual((state["frontier_seq"], state["completions"], state["effects"]), (0, {}, {}))

    def test_unknown_next_result_cannot_be_completed_as_a_normal_no_effect(self):
        _, execution = self.execute()
        before = self.store.current()["state_sha"]
        with self.assertRaises(ValueError):
            self.store.record_completion(execution, {
                "status": "no_effect", "action": "none", "reason": "report_unknown",
                "before_state_sha": before, "after_state_sha": before})
        self.assertEqual(self.store.current()["frontier_seq"], 0)

    def test_duplicate_receiver_only_coalesces_with_trusted_live_executor_evidence(self):
        intent, _ = self.execute(CONTINUE)
        trigger = self.trigger("99")
        live = {"id": 20, "run_attempt": 1, "event": "workflow_dispatch", "head_branch": "main",
                "head_repository": {"full_name": "synthetic/c-send"}, "status": "in_progress"}
        before = self.store.current()
        outcome = self.store.nonexecution_outcome(intent, key=intent["correlation_key"],
                                                  trigger=trigger, control_sha=CONTROL, runs=[live])
        self.assertEqual(outcome["outcome"], "coalesced")
        for wrong in (dict(live, run_attempt=2), dict(live, id=21),
                      dict(live, status="completed"), dict(live, head_branch="foreign"),
                      dict(live, head_repository={"full_name": "foreign/repo"})):
            outcome = self.store.nonexecution_outcome(intent, key=intent["correlation_key"],
                                                      trigger=trigger, control_sha=CONTROL, runs=[wrong])
            self.assertEqual(outcome["outcome"], "blocked")
        # The original claimant cannot turn a lost outcome into permission to resume.
        outcome = self.store.nonexecution_outcome(intent, key=intent["correlation_key"],
                                                  trigger=self.trigger("20"), control_sha=CONTROL, runs=[live])
        self.assertEqual(outcome["reason"], "executor_without_outcome")
        self.assertEqual(self.store.current(), before)

    def test_new_checked_external_ingress_observes_old_pin_without_changing_it(self):
        intent, _ = self.execute(NEXT)
        trigger = {**self.trigger("99"), "event_name": "schedule", "control_sha": "b" * 40}
        before = self.store.current()
        bound, capability = self.store.admit(CONTINUE, {}, key="", trigger=trigger, control_sha="b" * 40)
        self.assertIsNone(capability)
        self.assertEqual(bound, intent)
        live = {"id": 20, "run_attempt": 1, "event": "workflow_dispatch", "head_branch": "main",
                "head_repository": {"full_name": "synthetic/c-send"}, "status": "in_progress"}
        outcome = self.store.nonexecution_outcome(bound, key="", trigger=trigger,
                                                  control_sha="b" * 40, runs=[live])
        self.assertEqual(outcome["outcome"], "coalesced")
        self.assertEqual(self.store.current(), before)



if __name__ == "__main__":
    unittest.main(verbosity=2)
