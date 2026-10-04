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
from dispatch_journal import (CONTINUE, NEXT, OWNER_CONTINUE_CUTOVER, OWNER_RECOVERY, SYNC,
                              JournalConflict, JournalStore, JournalUncertain, digest, materialize,
                              substantive_digest, _owner_cutover_receipt_id)
from state_store import StateConflict, load_state, save_state

CONTROL = "a" * 40
OWNER_CONFIG = {"repository": "synthetic/c-send", "merge_gate": {"owner_approvers": ["owner-a"]}}


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
        outcome = (state["effects"].get(predecessor) or state["completions"].get(predecessor)
                   or state["owner_fences"].get(predecessor))
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

    def owner_trigger(self, intent, state_sha, run="500"):
        return {**self.trigger(run), "control_sha": "b" * 40, "workflow": OWNER_RECOVERY,
                "ref": "refs/heads/main", "expected_state_sha": state_sha, "decision_id": intent["decision_id"]}

    def fence(self, store, intent, state_sha, trigger=None):
        return store.fence_unclaimed(decision_id=intent["decision_id"], expected_state_sha=state_sha,
                                    owner_trigger=trigger or self.owner_trigger(intent, state_sha), config=OWNER_CONFIG)

    def cutover_trigger(self, intent, state_sha):
        return {**self.owner_trigger(intent, state_sha), "workflow": OWNER_CONTINUE_CUTOVER}

    def cutover(self, store, intent, state_sha, trigger=None, config=None):
        return store.cutover_continue(decision_id=intent["decision_id"], expected_state_sha=state_sha,
                                      owner_trigger=trigger or self.cutover_trigger(intent, state_sha),
                                      config=OWNER_CONFIG if config is None else config)

    def handoff_evidence(self, intent):
        head = self.git(self.repo, "rev-parse", "HEAD")
        return {**self.trigger("20"), "decision_id": intent["decision_id"], "switch_enabled": True,
                "stage": "bounded_observe_wait", "stage_started_at": "2026-10-01T00:00:00Z",
                "stage_completed_at": "2026-10-01T00:00:00Z", "waited_seconds": 0,
                "observation": {"health": "ok", "action": "none", "reason": "terminal", "due_at": None,
                                "main_sha": head, "lab_sha": head, "state_sha": self.store.current()["state_sha"]}}

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

    def test_manual_next_cannot_complete_as_an_automatic_busy_pause(self):
        intent, execution = self.execute()
        before = self.store.current()["state_sha"]
        with self.assertRaises(ValueError):
            self.store.record_completion(execution, {
                "status": "no_effect", "action": "none", "reason": "next_task_running",
                "before_state_sha": before, "after_state_sha": before})
        state = self.store.current()
        self.assertEqual(state["active_intent"]["decision_id"], intent["decision_id"])
        self.assertEqual((state["frontier_seq"], state["completions"], state["effects"]), (0, {}, {}))

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

    def test_owner_fence_revokes_old_key_without_creating_runtime_progress(self):
        intent, send = self.reserve()
        send.consume()
        before = self.store.current()
        queue_before = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        owner = self.owner_trigger(intent, before["state_sha"])
        outcome = self.fence(self.store, intent, before["state_sha"], owner)
        after = self.store.current()
        queue_after = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.assertEqual(outcome["outcome"], "fenced")
        self.assertEqual(after["frontier_seq"], before["frontier_seq"] + 1)
        self.assertIsNone(after["active_intent"])
        self.assertEqual(after["predecessor_decision_id"], intent["decision_id"])
        for field in ("intents", "send_claims", "executor_claims", "effects", "completions", "completed_receipts"):
            self.assertEqual(after[field], before[field])
        self.assertEqual({key: value for key, value in queue_after.items() if key != "dispatch_journal"},
                         {key: value for key, value in queue_before.items() if key != "dispatch_journal"})
        self.assertEqual(queue_after["dispatch_journal"]["events"][:-1], queue_before["dispatch_journal"]["events"])
        _, capability = self.reader("late-executor").admit(
            NEXT, {}, key=intent["correlation_key"], trigger=self.trigger("20"), control_sha=CONTROL)
        self.assertIsNone(capability)
        stopped = self.store.nonexecution_outcome(intent, key=intent["correlation_key"],
                                                trigger=self.trigger("20"), control_sha=CONTROL)
        self.assertEqual((stopped["outcome"], stopped["reason"]), ("stopped", "delivery_owner_fenced"))
        self.assertIsNone(self.store.outcome_for_trigger(owner))
        with self.assertRaises(JournalConflict):
            self.store.advance(outcome["receipt_id"])
        self.assertEqual(self.store.current(), after)

    def test_owner_fence_rejects_foreign_or_changed_authorization(self):
        intent, _ = self.reserve()
        before = self.store.current()
        owner = self.owner_trigger(intent, before["state_sha"])
        for field, value in (("actor", "nonowner"), ("repository", "foreign/repo"),
                             ("workflow", NEXT), ("ref", "refs/heads/foreign"),
                             ("expected_state_sha", "c" * 40), ("decision_id", "d" * 64)):
            with self.subTest(field=field), self.assertRaises((ValueError, JournalConflict)):
                self.fence(self.store, intent, before["state_sha"], {**owner, field: value})
            self.assertEqual(self.store.current(), before)
        stale = "c" * 40
        with self.assertRaises(JournalConflict):
            self.fence(self.store, intent, stale)
        self.assertEqual(self.store.current(), before)

    def test_executor_wins_cas_race_owner_fence_cannot_close_consumed_right(self):
        intent, _ = self.reserve()
        before = self.store.current()
        original_write = self.store._write
        competing = self.reader("executor-winner")
        won = []
        def competing_write(data):
            _, capability = competing.admit(NEXT, {}, key=intent["correlation_key"],
                                             trigger=self.trigger("20"), control_sha=CONTROL)
            won.append(capability)
            return original_write(data)
        with patch.object(self.store, "_write", side_effect=competing_write), self.assertRaises(JournalConflict):
            self.fence(self.store, intent, before["state_sha"])
        self.assertEqual(len(won), 1)
        won[0].consume()
        after = self.store.current()
        self.assertEqual(after["owner_fences"], {})
        self.assertEqual(after["frontier_seq"], before["frontier_seq"])
        self.assertEqual(after["active_intent"], intent)
        self.assertEqual(after["executor_claims"][intent["decision_id"]]["trigger"], self.trigger("20"))
        with self.assertRaises(JournalConflict):
            self.fence(self.store, intent, after["state_sha"])
        self.assertEqual(self.store.current(), after)

    def test_owner_wins_cas_race_old_executor_never_gets_capability(self):
        intent, _ = self.reserve()
        before = self.store.current()
        original_write = self.store._write
        competing = self.reader("owner-winner")
        fenced = []
        def competing_write(data):
            fenced.append(self.fence(competing, intent, before["state_sha"]))
            return original_write(data)
        with patch.object(self.store, "_write", side_effect=competing_write):
            bound, capability = self.store.admit(NEXT, {}, key=intent["correlation_key"],
                                                 trigger=self.trigger("20"), control_sha=CONTROL)
        self.assertIsNone(capability)
        self.assertEqual(bound, intent)
        self.assertEqual(len(fenced), 1)
        after = self.store.current()
        self.assertEqual(after["executor_claims"], {})
        self.assertEqual(after["frontier_seq"], before["frontier_seq"] + 1)
        self.assertIn(intent["decision_id"], after["owner_fences"])

    def test_owner_fence_unknown_ack_is_durable_without_automatic_followup(self):
        intent, _ = self.reserve()
        before = self.store.current()
        original_git = state_store._git
        def lost_ack(repo, *args, **kwargs):
            result = original_git(repo, *args, **kwargs)
            if "push" in args:
                raise subprocess.TimeoutExpired("synthetic owner fence push", 90)
            return result
        with patch.object(state_store, "_git", side_effect=lost_ack), self.assertRaises(JournalUncertain):
            self.fence(self.store, intent, before["state_sha"])
        after = self.store.current()
        self.assertIsNone(after["active_intent"])
        self.assertEqual(after["executor_claims"], {})
        self.assertEqual(after["effects"], {})
        self.assertEqual(after["completions"], {})
        replay = self.fence(self.store, intent, before["state_sha"])
        self.assertEqual(replay["outcome"], "already_fenced")
        self.assertEqual(self.store.current(), after)

    def test_owner_fence_replay_does_not_consume_or_rebind_successor(self):
        intent, _ = self.reserve()
        before = self.store.current()
        fence = self.fence(self.store, intent, before["state_sha"])
        successor, send = self.reserve(workflow=CONTINUE, trigger=self.trigger("501"))
        send.consume()
        active = self.store.current()
        replay = self.fence(self.reader("owner-replay"), intent, before["state_sha"])
        self.assertEqual((replay["outcome"], replay["receipt_id"]), ("already_fenced", fence["receipt_id"]))
        self.assertEqual(self.store.current(), active)
        self.assertEqual(active["active_intent"], successor)
        with self.assertRaises(JournalConflict):
            self.store.reserve_send(CONTINUE, {}, basis={"receipt_id": None},
                                    trigger=self.trigger("502"), control_sha=CONTROL)
        self.assertEqual(self.store.current(), active)

    def test_continue_cutover_preserves_tasks_claims_receipts_and_journal_prefix(self):
        self.store.current()
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        data["tasks"] = [{"id": "immutable-worker", "title": "Saved worker identity", "status": "in_progress",
                          "task_type": "chore", "risk": "low", "priority": 1, "focus": [],
                          "evidence": {"source": "synthetic", "detail": "immutable accepted work"},
                          "execution": {"session_id": "sessions/saved-worker", "attempts": 1,
                                        "state": "dispatched", "dispatch_key": "saved-key", "pull_request": 7,
                                        "base_sha": CONTROL, "starting_branch": "autonomous/attempt-saved-key",
                                        "history": [{"session_id": "sessions/older-worker", "result": "retained"}]}}]
        self.store.save_manifest(data)
        intent, executor = self.execute(CONTINUE)
        before = self.store.current()
        queue_before = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        result = self.cutover(self.store, intent, before["state_sha"])
        after = self.store.current()
        queue_after = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.assertEqual(result, {"outcome": "cut_over", "decision_id": intent["decision_id"],
                                  "receipt_id": after["continue_cutovers"][intent["decision_id"]]["receipt_id"],
                                  "state_sha": after["state_sha"], "frontier_seq": 1})
        self.assertIsNone(after["active_intent"])
        self.assertEqual(after["predecessor_decision_id"], intent["decision_id"])
        for field in ("intents", "send_claims", "executor_claims", "effects", "completions", "owner_fences",
                      "stages", "phase_claims", "completed_receipts", "advanced_receipts"):
            self.assertEqual(after[field], before[field])
        self.assertEqual(substantive_digest(queue_after), substantive_digest(queue_before))
        self.assertEqual({key: value for key, value in queue_after.items() if key != "dispatch_journal"},
                         {key: value for key, value in queue_before.items() if key != "dispatch_journal"})
        self.assertEqual(queue_after["dispatch_journal"]["events"][:-1], queue_before["dispatch_journal"]["events"])
        for operation in (executor.observer_context,
                          lambda: self.store.record_effect(executor, "continue_handoff", self.handoff_evidence(intent)),
                          lambda: self.store.advance(result["receipt_id"]),
                          lambda: self.store.reserve_send(CONTINUE, {}, basis={"receipt_id": result["receipt_id"]},
                                                          trigger=self.trigger("10"), control_sha=CONTROL)):
            with self.assertRaises(JournalConflict):
                operation()
        _, late = self.store.admit(CONTINUE, {}, key=intent["correlation_key"],
                                  trigger=self.trigger("20", "2"), control_sha=CONTROL)
        self.assertIsNone(late)
        stopped = self.store.nonexecution_outcome(intent, key=intent["correlation_key"],
                                                 trigger=self.trigger("20"), control_sha=CONTROL)
        self.assertEqual((stopped["outcome"], stopped["reason"]), ("stopped", "continue_owner_cut_over"))
        self.assertIsNone(self.store.outcome_for_trigger(self.cutover_trigger(intent, before["state_sha"])))
        self.assertIsNone(self.store.outcome_for_trigger(self.trigger("20")))
        self.assertEqual(self.store.current(), after)

    def test_cutover_revokes_unconsumed_sender(self):
        intent, send = self.reserve(workflow=CONTINUE)
        self.cutover(self.store, intent, self.store.current()["state_sha"])
        with self.assertRaises(JournalConflict):
            send.consume()
        after = self.store.current()
        self.assertEqual(after["effects"], {})
        self.assertEqual(after["executor_claims"], {})
        self.assertEqual(after["frontier_seq"], 1)

    def test_cutover_revokes_consumed_sender_observation(self):
        intent, send = self.reserve(workflow=CONTINUE)
        send.consume()
        self.cutover(self.store, intent, self.store.current()["state_sha"])
        after = self.store.current()
        with self.assertRaises(JournalConflict):
            send.observer_context()
        self.assertEqual(self.store.current(), after)

    def test_cutover_revokes_executor_before_consume_and_never_reissues_it(self):
        intent, send = self.reserve(workflow=CONTINUE)
        send.consume()
        _, executor = self.store.admit(CONTINUE, {}, key=intent["correlation_key"],
                                      trigger=self.trigger("20"), control_sha=CONTROL)
        self.cutover(self.store, intent, self.store.current()["state_sha"])
        with self.assertRaises(JournalConflict):
            executor.consume()
        _, replay = self.reader("late-claim").admit(CONTINUE, {}, key=intent["correlation_key"],
                                                   trigger=self.trigger("21"), control_sha=CONTROL)
        self.assertIsNone(replay)

    def test_cutover_rejects_changed_owner_configuration_context_and_source(self):
        intent, _ = self.reserve(workflow=CONTINUE)
        before = self.store.current()
        owner = self.cutover_trigger(intent, before["state_sha"])
        for field, value in (("actor", "nonowner"), ("repository", "foreign/repo"),
                             ("workflow", OWNER_RECOVERY), ("event_name", "schedule"),
                             ("ref", "refs/heads/foreign"), ("control_sha", "invalid"),
                             ("expected_state_sha", "c" * 40), ("decision_id", "d" * 64),
                             ("run_id", "10"), ("run_attempt", "0")):
            with self.subTest(field=field), self.assertRaises((ValueError, JournalConflict)):
                self.cutover(self.store, intent, before["state_sha"], {**owner, field: value})
            self.assertEqual(self.store.current(), before)
        for config in ({**OWNER_CONFIG, "repository": "foreign/repo"},
                       {**OWNER_CONFIG, "merge_gate": {"owner_approvers": ["other-owner"]}}):
            with self.assertRaises((ValueError, JournalConflict)):
                self.cutover(self.store, intent, before["state_sha"], config=config)
        with self.assertRaises(JournalConflict):
            self.cutover(self.store, intent, self.initial)
        self.assertEqual(self.store.current(), before)

    def test_cutover_replay_rechecks_original_owner_and_never_mutates_successor(self):
        intent, _ = self.execute(CONTINUE)
        before = self.store.current()
        owner = self.cutover_trigger(intent, before["state_sha"])
        result = self.cutover(self.store, intent, before["state_sha"], owner)
        head = self.git(self.repo, "rev-parse", "HEAD")
        successor, execution = self.store.admit(SYNC, {"main_sha": head, "lab_sha": head}, key="",
                                                trigger={**self.trigger("600"), "control_sha": "b" * 40},
                                                control_sha="b" * 40)
        execution.consume()
        active = self.store.current()
        replay = self.cutover(self.reader("owner-replay-cutover"), intent, before["state_sha"],
                              {**owner, "run_attempt": "2"})
        self.assertEqual((replay["outcome"], replay["receipt_id"]), ("already_cut_over", result["receipt_id"]))
        self.assertEqual(successor["basis"], {"kind": "external_ingress", "state_sha": result["state_sha"],
                                            "owner_cutover": result["receipt_id"]})
        for field, value in (("control_sha", "c" * 40), ("run_id", "501"), ("repository", "foreign/repo"),
                             ("actor", "nonowner"), ("workflow", OWNER_RECOVERY)):
            with self.subTest(field=field), self.assertRaises((ValueError, JournalConflict)):
                self.cutover(self.store, intent, before["state_sha"], {**owner, field: value})
        with self.assertRaises(JournalConflict):
            self.cutover(self.store, intent, active["state_sha"])
        with self.assertRaises(ValueError):
            self.cutover(self.store, intent, before["state_sha"], owner,
                         {**OWNER_CONFIG, "merge_gate": {"owner_approvers": ["other-owner"]}})
        self.assertEqual(self.store.current(), active)

    def test_cutover_authority_cannot_become_timer_or_sender_permission(self):
        intent, _ = self.reserve(workflow=CONTINUE)
        result = self.cutover(self.store, intent, self.store.current()["state_sha"])
        before = self.store.current()
        head = self.git(self.repo, "rev-parse", "HEAD")
        for workflow, inputs, event in ((CONTINUE, {}, "workflow_dispatch"), (NEXT, {}, "workflow_dispatch"),
                                        (SYNC, {"main_sha": head, "lab_sha": head}, "schedule"),
                                        (SYNC, {"main_sha": head, "lab_sha": head}, "workflow_run")):
            trigger = {**self.trigger("600"), "event_name": event, "source_run_id": "599", "source_run_attempt": "1"}
            with self.subTest(workflow=workflow, event=event), self.assertRaises(JournalConflict):
                self.store.admit(workflow, inputs, key="", trigger=trigger, control_sha=CONTROL)
        bound, capability = self.store.admit(SYNC, {"main_sha": head, "lab_sha": head}, key="",
                                            trigger=self.cutover_trigger(intent, result["state_sha"]),
                                            control_sha="b" * 40)
        self.assertIsNone(bound)
        self.assertIsNone(capability)
        for workflow, inputs in ((NEXT, {}), (CONTINUE, {}), (SYNC, {"main_sha": head, "lab_sha": head})):
            with self.assertRaises(JournalConflict):
                self.store.reserve_send(workflow, inputs, basis={"receipt_id": result["receipt_id"]},
                                        trigger=self.trigger("600"), control_sha=CONTROL)
        self.assertEqual(self.store.current(), before)

    def test_claim_wins_owner_cutover_cas_is_not_retried_on_new_head(self):
        intent, _ = self.reserve(workflow=CONTINUE)
        before = self.store.current()
        original_write = self.store._write
        competing = self.reader("cutover-claim-winner")
        def competing_write(data):
            competing.admit(CONTINUE, {}, key=intent["correlation_key"], trigger=self.trigger("20"), control_sha=CONTROL)
            return original_write(data)
        with patch.object(self.store, "_write", side_effect=competing_write), self.assertRaises(JournalConflict):
            self.cutover(self.store, intent, before["state_sha"])
        after = self.store.current()
        self.assertEqual(after["continue_cutovers"], {})
        self.assertEqual(after["frontier_seq"], 0)
        self.assertEqual(after["active_intent"], intent)
        self.assertIn(intent["decision_id"], after["executor_claims"])
        self.cutover(self.store, intent, after["state_sha"])
        self.assertIsNone(self.store.current()["active_intent"])

    def test_effect_wins_owner_cutover_cas_and_blocks_new_owner_attempt(self):
        intent, executor = self.execute(CONTINUE)
        evidence = self.handoff_evidence(intent)
        before = self.store.current()
        original_write = self.store._write
        competing = self.reader("cutover-effect-winner")
        def competing_write(data):
            competing.record_effect(executor, "continue_handoff", evidence)
            return original_write(data)
        with patch.object(self.store, "_write", side_effect=competing_write), self.assertRaises(JournalConflict):
            self.cutover(self.store, intent, before["state_sha"])
        after = self.store.current()
        self.assertEqual(after["continue_cutovers"], {})
        self.assertIn(intent["decision_id"], after["effects"])
        with self.assertRaises(JournalConflict):
            self.cutover(self.store, intent, after["state_sha"])
        self.assertEqual(self.store.current(), after)

    def test_owner_cutover_wins_executor_claim_and_effect_cas_races(self):
        intent, _ = self.reserve(workflow=CONTINUE)
        before = self.store.current()
        original_write = self.store._write
        competing = self.reader("cutover-owner-winner")
        def competing_write(data):
            self.cutover(competing, intent, before["state_sha"])
            return original_write(data)
        with patch.object(self.store, "_write", side_effect=competing_write):
            bound, executor = self.store.admit(CONTINUE, {}, key=intent["correlation_key"],
                                              trigger=self.trigger("20"), control_sha=CONTROL)
        self.assertEqual(bound, intent)
        self.assertIsNone(executor)
        self.assertEqual(self.store.current()["executor_claims"], {})

    def test_owner_cutover_wins_effect_cas_consumed_executor_cannot_retry(self):
        intent, executor = self.execute(CONTINUE)
        evidence = self.handoff_evidence(intent)
        before = self.store.current()
        original_write = self.store._write
        competing = self.reader("cutover-owner-effect-winner")
        def competing_write(data):
            self.cutover(competing, intent, before["state_sha"])
            return original_write(data)
        with patch.object(self.store, "_write", side_effect=competing_write), self.assertRaises(JournalConflict):
            self.store.record_effect(executor, "continue_handoff", evidence)
        after = self.store.current()
        self.assertEqual(after["effects"], {})
        self.assertEqual(after["frontier_seq"], 1)
        with self.assertRaises(JournalConflict):
            executor.observer_context()

    def test_cutover_unknown_ack_is_durable_replay_only_and_not_a_second_event(self):
        intent, _ = self.execute(CONTINUE)
        before = self.store.current()
        original_git = state_store._git
        def lost_ack(repo, *args, **kwargs):
            result = original_git(repo, *args, **kwargs)
            if "push" in args:
                raise subprocess.TimeoutExpired("synthetic owner cutover push", 90)
            return result
        with patch.object(state_store, "_git", side_effect=lost_ack), self.assertRaises(JournalUncertain):
            self.cutover(self.store, intent, before["state_sha"])
        after = self.store.current()
        result = self.cutover(self.reader("cutover-ack-replay"), intent, before["state_sha"])
        self.assertEqual(result["outcome"], "already_cut_over")
        self.assertEqual(result["receipt_id"], after["continue_cutovers"][intent["decision_id"]]["receipt_id"])
        self.assertEqual(self.store.current(), after)

    def test_materialization_rejects_forged_cutover_authority_and_sender_child(self):
        intent, _ = self.execute(CONTINUE)
        before = self.store.current()
        self.cutover(self.store, intent, before["state_sha"])
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        journal = data["dispatch_journal"]
        for field, value in (("workflow", OWNER_RECOVERY), ("repository", "foreign/repo"),
                             ("ref", "refs/heads/foreign"), ("decision_id", "d" * 64), ("run_id", "20")):
            forged = copy.deepcopy(journal)
            event = forged["events"][-1]
            event["owner_trigger"][field] = value
            event["receipt_id"] = _owner_cutover_receipt_id(event["decision_id"], event["owner_trigger"],
                                                         event["before_state_sha"], event["before_digest"])
            event["event_id"] = digest({key: val for key, val in event.items() if key != "event_id"})
            with self.subTest(field=field), self.assertRaises((ValueError, JournalConflict)):
                materialize(forged)
        state = self.store.current()
        child = self.store._new_intent(state, CONTINUE, {}, {"receipt_id": journal["events"][-1]["receipt_id"]},
                                       self.trigger("600"), CONTROL, "sender")
        with self.assertRaises(JournalConflict):
            materialize({"version": 1, "events": [*journal["events"], child]})

    def test_cutover_never_closes_claimed_next_or_prepared_finalizing_sync(self):
        for workflow, phase in ((NEXT, "sender"), (NEXT, "execute"), (SYNC, "sender"),
                                (SYNC, "execute"), (SYNC, "sync_prepared"), (SYNC, "sync_finalize")):
            with self.subTest(workflow=workflow, phase=phase):
                isolated = JournalTests(methodName="test_cutover_never_closes_claimed_next_or_prepared_finalizing_sync")
                isolated.setUp()
                try:
                    inputs = {"main_sha": CONTROL, "lab_sha": "b" * 40} if workflow == SYNC else {}
                    if phase == "sender":
                        intent, _ = isolated.reserve(workflow=workflow, inputs=inputs)
                    else:
                        intent, executor = isolated.execute(workflow, inputs)
                    if phase in {"sync_prepared", "sync_finalize"}:
                        reference = isolated.store.record_checkpoint(executor, "sync_prepared", {
                            "status": "prepared", "main_sha": CONTROL, "lab_sha": "b" * 40,
                            "candidate_sha": "c" * 40, "queue_blob": "d" * 40,
                            "candidate_branch": "autonomous/sync-20-1", "candidate_owned": True})
                        if phase == "sync_finalize":
                            isolated.store.claim_phase(intent["decision_id"], "sync_finalize", isolated.trigger("20"),
                                                       CONTROL, reference)
                    before = isolated.store.current()
                    with self.assertRaises(JournalConflict):
                        isolated.cutover(isolated.store, intent, before["state_sha"])
                    self.assertEqual(isolated.store.current(), before)
                finally:
                    isolated.doCleanups()

    def test_cutover_closes_claimed_external_continue_without_inventing_sender(self):
        trigger = {**self.trigger("20"), "event_name": "workflow_run", "source_run_id": "19", "source_run_attempt": "1"}
        intent, executor = self.store.admit(CONTINUE, {}, key="", trigger=trigger, control_sha=CONTROL)
        executor.consume()
        before = self.store.current()
        result = self.cutover(self.store, intent, before["state_sha"])
        after = self.store.current()
        self.assertEqual(after["send_claims"], {})
        self.assertEqual(after["executor_claims"], before["executor_claims"])
        self.assertEqual(after["effects"], {})
        self.assertEqual(after["completions"], {})
        self.assertEqual(result["outcome"], "cut_over")
        with self.assertRaises(JournalConflict):
            executor.observer_context()





if __name__ == "__main__":
    unittest.main(verbosity=2)
