#!/usr/bin/env python3
"""Owner entry authorization, safe acknowledgements and frozen receiver denial."""
from __future__ import annotations

from argparse import Namespace
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import recover_delivery
import state_store
import next_no_effect_artifact
from next_no_effect_artifact_test import SyntheticSource
import workflow_admission
from dispatch_journal import (CONTINUE, NEXT, SYNC, OWNER_CONTINUE_CUTOVER, OWNER_DISPATCH_BINDING,
                              OWNER_DISPATCH_OBSERVATION, OWNER_NEXT_COMPLETION,
                              OWNER_RECOVERY, JournalStore, JournalUncertain, substantive_digest)
from state_store import load_state, save_state

REPOSITORY = "synthetic/owner-entry"
CONFIG = {"repository": REPOSITORY, "merge_gate": {"owner_approvers": ["owner"]}}


class OwnerEntryTests(unittest.TestCase):
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
        (self.repo / "agent_tasks.json").write_text(json.dumps({
            "version": 2, "autonomous_loop_policy": {}, "tasks": [],
            "protected": {"identity": "immutable synthetic history"},
        }), encoding="utf-8")
        self.config_path = self.repo / "autonomous-project.json"
        self.config_path.write_text(json.dumps(CONFIG), encoding="utf-8")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "synthetic owner entry")
        self.control = self.git(self.repo, "rev-parse", "HEAD")
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.store = JournalStore(self.repo, self.root / "queue.json", self.root / "revision.json")
        load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        original = save_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.store.initialize(original, self.control, {
            "kind": "fenced_bootstrap", "state_sha": original,
            "legacy_senders_fenced": True, "pending_legacy": "none",
        })
        # Check real configured origin identity, but route only state transport to
        # a disposable bare Git remote. No fixture can contact GitHub or run gh.
        self.git(self.repo, "remote", "set-url", "origin", "https://github.com/" + REPOSITORY)
        native_git = state_store._git
        self.lose_ack = False
        self.pushes = 0

        def local_state_transport(repo, *args, **kwargs):
            args = tuple(str(self.remote) if arg == "origin" else arg for arg in args)
            result = native_git(repo, *args, **kwargs)
            if "push" in args:
                self.pushes += 1
                if self.lose_ack:
                    raise subprocess.TimeoutExpired("synthetic acknowledged state push", 90)
            return result

        self.start_patch(patch.object(state_store, "_git", side_effect=local_state_transport))
        # Resolve checked control HEAD and config using a real isolated Git tree.
        for module in (recover_delivery, workflow_admission):
            self.start_patch(patch.object(module, "__file__", str(
                self.repo / "scripts" / "autonomous" / (module.__name__ + ".py"))))
        self.event_path = self.root / "event.json"
        self.result_path = self.root / "result.json"
        self.start_patch(patch.dict(os.environ, {
            **{name: os.environ[name] for name in
               ("PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP") if name in os.environ},
            "GITHUB_RUN_ID": "71", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": REPOSITORY,
            "GITHUB_REF": "refs/heads/main", "GITHUB_ACTOR": "owner",
            "GITHUB_TRIGGERING_ACTOR": "owner", "GITHUB_SHA": self.control,
            "GITHUB_WORKFLOW_SHA": self.control, "CONTROL_SHA": self.control,
            "CONTINUATION_KEY": "", "GITHUB_EVENT_PATH": str(self.event_path),
        }, clear=True))

    def start_patch(self, patcher):
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def git(self, repo, *args):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
                              check=True, capture_output=True, text=True).stdout.strip()

    def trigger(self, run="10"):
        return {"run_id": run, "run_attempt": "1", "event_name": "workflow_dispatch",
                "control_sha": self.control, "repository": REPOSITORY, "actor": "owner"}

    def prepare(self, workflow=CONTINUE, *, claimed=False, owner_workflow=OWNER_CONTINUE_CUTOVER,
                inputs=None, execution_run="20"):
        self.intent, send = self.store.reserve_send(
            workflow, inputs or {}, basis={}, trigger=self.trigger(), control_sha=self.control)
        send.consume()
        if claimed:
            _, execution = self.store.admit(workflow, inputs or {}, key=self.intent["correlation_key"],
                                             trigger=self.trigger(execution_run), control_sha=self.control)
            execution.consume()
            self.execution = execution
        self.before = self.store.current()
        self.expected = self.before["state_sha"]
        self.event = {"repository": {"full_name": REPOSITORY}, "ref": "refs/heads/main",
                      "sender": {"login": "owner"}, "inputs": {
                          "expected_state_sha": self.expected, "decision_id": self.intent["decision_id"]}}
        self.write_event()
        os.environ["GITHUB_WORKFLOW_REF"] = (
            REPOSITORY + "/.github/workflows/" + owner_workflow + "@refs/heads/main")

    def write_event(self):
        self.event_path.write_text(json.dumps(self.event), encoding="utf-8")

    def arguments(self, operation="continue_cutover"):
        args = ["--repo", str(self.repo), "--config", str(self.config_path),
                "--manifest", str(self.store.manifest_path), "--revision-file", str(self.store.revision_path),
                "--expected-state-sha", self.expected, "--decision-id", self.intent["decision_id"],
                "--out", str(self.result_path)]
        return args if operation is None else ["--operation", operation, *args]

    def invoke(self, args=None):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            status = recover_delivery.main(args if args is not None else self.arguments())
        result = json.loads(output.getvalue())
        self.assertEqual(json.loads(self.result_path.read_text(encoding="utf-8")), result)
        return status, result

    def assert_rejected_without_mutation(self, args=None):
        before = self.store.current()
        pushes = self.pushes
        status, result = self.invoke(args)
        self.assertEqual(status, 1)
        self.assertEqual(result["outcome"], "blocked")
        self.assertEqual(self.store.current(), before)
        self.assertEqual(self.pushes, pushes)
        return result

    def assert_native_cutover_and_replay(self, *, claimed):
        self.prepare(claimed=claimed)
        manifest = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        prefix = copy.deepcopy(manifest["dispatch_journal"]["events"])
        substantive = substantive_digest(manifest)
        pushes = self.pushes
        status, result = self.invoke()
        self.assertEqual((status, result["outcome"]), (0, "cut_over"))
        self.assertEqual(set(result), {"outcome", "decision_id", "receipt_id", "state_sha", "frontier_seq"})
        after = self.store.current()
        receipt = after["continue_cutovers"][self.intent["decision_id"]]
        self.assertEqual(result["receipt_id"], receipt["receipt_id"])
        self.assertEqual(result["state_sha"], after["state_sha"])
        self.assertEqual(result["frontier_seq"], self.before["frontier_seq"] + 1)
        self.assertEqual(self.pushes, pushes + 1)
        self.assertEqual((after["effects"], after["completions"], after["owner_fences"]), ({}, {}, {}))
        manifest = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.assertEqual(manifest["dispatch_journal"]["events"][:-1], prefix)
        self.assertEqual(substantive_digest(manifest), substantive)
        os.environ["GITHUB_RUN_ATTEMPT"] = "2"
        replay_status, replay = self.invoke()
        self.assertEqual((replay_status, replay["outcome"]), (0, "already_cut_over"))
        self.assertEqual({k: v for k, v in replay.items() if k != "outcome"},
                         {k: v for k, v in result.items() if k != "outcome"})
        self.assertEqual(self.store.current(), after)
        self.assertEqual(self.pushes, pushes + 1)

    def test_sender_only_continue_native_cutover_and_owner_rerun_replay(self):
        self.assert_native_cutover_and_replay(claimed=False)

    def test_claimed_continue_native_cutover_and_owner_rerun_replay(self):
        self.assert_native_cutover_and_replay(claimed=True)

    def test_selected_next_cannot_be_cut_over(self):
        self.prepare(NEXT)
        result = self.assert_rejected_without_mutation()
        self.assertEqual(result["reason"], "owner_continue_cutover_conflict")

    def test_selected_sync_cannot_be_cut_over(self):
        self.prepare(SYNC)
        self.assert_rejected_without_mutation()

    def test_default_delivery_remains_distinct_unclaimed_owner_fence(self):
        self.prepare(owner_workflow=OWNER_RECOVERY)
        status, result = self.invoke(self.arguments(None))
        self.assertEqual((status, result["outcome"]), (0, "fenced"))
        state = self.store.current()
        self.assertIn(self.intent["decision_id"], state["owner_fences"])
        self.assertEqual(state["continue_cutovers"], {})

    def test_default_delivery_cannot_close_claimed_continue(self):
        self.prepare(claimed=True, owner_workflow=OWNER_RECOVERY)
        self.assert_rejected_without_mutation(self.arguments(None))

    def test_operation_requires_its_exact_workflow(self):
        self.prepare()
        for operation in (None, "delivery", "foreign"):
            with self.subTest(operation=operation):
                self.assert_rejected_without_mutation(self.arguments(operation))
        os.environ["GITHUB_WORKFLOW_REF"] = (
            REPOSITORY + "/.github/workflows/" + OWNER_RECOVERY + "@refs/heads/main")
        self.assert_rejected_without_mutation()

    def test_owner_entry_rejects_untrusted_actor_repo_ref_revision_rerun_and_keys(self):
        self.prepare()
        changes = (("GITHUB_ACTOR", "foreign"), ("GITHUB_TRIGGERING_ACTOR", "foreign"),
                   ("GITHUB_TRIGGERING_ACTOR", ""), ("GITHUB_REPOSITORY", "foreign/repo"),
                   ("GITHUB_REF", "refs/heads/foreign"), ("GITHUB_WORKFLOW_SHA", "b" * 40),
                   ("GITHUB_SHA", "b" * 40), ("CONTROL_SHA", "b" * 40),
                   ("CONTINUATION_KEY", "c" * 32), ("GITHUB_EVENT_NAME", "schedule"))
        for variable, value in changes:
            with self.subTest(variable=variable), patch.dict(os.environ, {variable: value}):
                self.assert_rejected_without_mutation()

    def test_original_payload_must_bind_exact_inputs_repository_sender_and_ref(self):
        self.prepare()
        original = copy.deepcopy(self.event)
        variants = [
            {**original, "inputs": {**original["inputs"], "operation": "continue_cutover"}},
            {**original, "inputs": {**original["inputs"], "continuation_key": "c" * 32}},
            {**original, "inputs": {**original["inputs"], "expected_state_sha": "b" * 40}},
            {**original, "inputs": {**original["inputs"], "decision_id": "d" * 64}},
            {**original, "repository": {"full_name": "foreign/repo"}},
            {**original, "sender": {"login": "foreign"}},
            {**original, "ref": "refs/heads/foreign"},
        ]
        for index, event in enumerate(variants):
            with self.subTest(variant=index):
                self.event = event
                self.write_event()
                self.assert_rejected_without_mutation()

    def test_checked_config_and_state_repository_cannot_be_substituted(self):
        self.prepare()
        raw = self.config_path.read_bytes()
        self.config_path.write_text(json.dumps({**CONFIG, "merge_gate": {"owner_approvers": ["foreign"]}}),
                                    encoding="utf-8")
        self.assert_rejected_without_mutation()
        self.config_path.write_bytes(raw)
        self.git(self.repo, "remote", "set-url", "origin", "https://github.com/foreign/repo")
        self.assert_rejected_without_mutation()

    def test_context_payload_or_config_change_at_final_recheck_cannot_publish(self):
        self.prepare()
        original_recheck = recover_delivery.recheck_context
        variables = ("GITHUB_ACTOR", "GITHUB_TRIGGERING_ACTOR", "GITHUB_WORKFLOW_REF",
                     "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "GITHUB_WORKFLOW_SHA",
                     "GITHUB_EVENT_NAME", "CONTROL_SHA")
        for variable in variables:
            def change_context(binding):
                original_recheck(binding)
                os.environ.pop(variable, None)
            with self.subTest(variable=variable), patch.dict(os.environ), patch.object(
                    recover_delivery, "recheck_context", side_effect=change_context):
                self.assert_rejected_without_mutation()
        original_event = copy.deepcopy(self.event)
        raw_config = self.config_path.read_bytes()
        for source in ("payload", "configuration"):
            def change_source(binding):
                original_recheck(binding)
                if source == "payload":
                    self.event["inputs"]["decision_id"] = "d" * 64
                    self.write_event()
                else:
                    self.config_path.write_bytes(raw_config + b"\n")
            with self.subTest(source=source), patch.object(
                    recover_delivery, "recheck_context", side_effect=change_source):
                self.assert_rejected_without_mutation()
            self.event = copy.deepcopy(original_event)
            self.write_event()
            self.config_path.write_bytes(raw_config)

    def test_lost_native_cas_ack_retains_only_safe_unknown_and_replay_observes_receipt(self):
        self.prepare(claimed=True)
        pushes = self.pushes
        self.lose_ack = True
        status, result = self.invoke()
        self.assertEqual((status, result), (1, {"outcome": "blocked",
                         "reason": "owner_continue_cutover_acknowledgement_unknown"}))
        self.lose_ack = False
        after = self.store.current()
        self.assertIn(self.intent["decision_id"], after["continue_cutovers"])
        self.assertEqual(self.pushes, pushes + 1)
        status, result = self.invoke()
        self.assertEqual((status, result["outcome"]), (0, "already_cut_over"))
        self.assertEqual(result["receipt_id"], after["continue_cutovers"][self.intent["decision_id"]]["receipt_id"])
        self.assertEqual(self.store.current(), after)
        self.assertEqual(self.pushes, pushes + 1)

    def test_result_retention_failure_cannot_report_success_or_authorize_retry(self):
        self.prepare()
        args = self.arguments()
        args[args.index("--out") + 1] = str(self.root)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            status = recover_delivery.main(args)
        self.assertEqual((status, json.loads(output.getvalue())), (1, {
            "outcome": "blocked", "reason": "owner_continue_cutover_result_retention_failed"}))
        after = self.store.current()
        pushes = self.pushes
        status, result = self.invoke()
        self.assertEqual((status, result["outcome"]), (0, "already_cut_over"))
        self.assertEqual(result["receipt_id"], after["continue_cutovers"][self.intent["decision_id"]]["receipt_id"])
        self.assertEqual(self.store.current(), after)
        self.assertEqual(self.pushes, pushes)

    def test_late_keyed_receiver_is_rejected_before_old_control_checkout(self):
        self.prepare(claimed=True)
        frozen = self.control
        self.git(self.repo, "commit", "--allow-empty", "-m", "synthetic checked-main update")
        self.control = self.git(self.repo, "rev-parse", "HEAD")
        os.environ.update(GITHUB_SHA=self.control, GITHUB_WORKFLOW_SHA=self.control,
                          CONTROL_SHA=self.control)
        owner_event = copy.deepcopy(self.event)

        def receiver_context():
            os.environ.update(GITHUB_RUN_ID="20", GITHUB_ACTOR="github-actions[bot]",
                              GITHUB_WORKFLOW_REF=REPOSITORY + "/.github/workflows/" + CONTINUE + "@refs/heads/main",
                              CONTINUATION_KEY=self.intent["correlation_key"])
            self.event["inputs"] = {**self.intent["normalized_inputs"],
                                    "continuation_key": self.intent["correlation_key"], "control_sha": frozen}
            self.write_event()
            return Namespace(repo=self.repo, workflow=CONTINUE, run_id="20", run_attempt="1",
                             event_name="workflow_dispatch", control_sha=self.control,
                             continuation_key=self.intent["correlation_key"])

        with patch.dict(os.environ):
            args = receiver_context()
            self.assertEqual(workflow_admission.checked_control_pin(args, CONFIG, self.store), frozen)
        self.event = owner_event
        self.write_event()
        status, result = self.invoke()
        self.assertEqual((status, result["outcome"]), (0, "cut_over"))
        before = self.store.current()
        args = receiver_context()
        with self.assertRaisesRegex(ValueError, "cut over"):
            workflow_admission.checked_control_pin(args, CONFIG, self.store)
        self.assertEqual(self.store.current(), before)

    def prepare_next_completion(self):
        self.prepare(NEXT, claimed=True, owner_workflow=OWNER_NEXT_COMPLETION,
                     inputs={"automatic": True}, execution_run="71")
        os.environ["GITHUB_RUN_ID"] = "72"
        source = SyntheticSource()
        source.run.update(head_sha=self.control, display_title="Next " + self.intent["correlation_key"])
        for field in ("repository", "head_repository"):
            source.run[field]["full_name"] = REPOSITORY
        for field in ("actor", "triggering_actor"):
            source.run[field]["login"] = "owner"
        source.attempt = copy.deepcopy(source.run)
        source.jobs[0]["head_sha"] = self.control
        source.artifacts[0]["workflow_run"]["head_sha"] = self.control
        source.report.update(decision_id=self.intent["decision_id"], state_sha=self.expected)
        source.set_report(source.report)

        def metadata(repository, endpoint):
            self.assertEqual(repository, REPOSITORY)
            return source.get_json(endpoint)

        def archive(repository, endpoint):
            self.assertEqual(repository, REPOSITORY)
            return source.get_archive(endpoint)

        self.start_patch(patch.object(next_no_effect_artifact, "_default_json", side_effect=metadata))
        self.start_patch(patch.object(next_no_effect_artifact, "_default_archive", side_effect=archive))
        return source

    def prepare_failed_automatic_next(self):
        from dispatch_journal import OWNER_FAILED_NEXT_CHECKPOINT
        from next_no_effect_artifact_test import FailedCheckpointSource
        producer = next_no_effect_artifact.FAILED_AUTOMATIC_NEXT_PRODUCER
        source_trigger = {**self.trigger(), "control_sha": producer}
        inputs = {"automatic": True}
        self.intent, send = self.store.reserve_send(
            NEXT, inputs, basis={}, trigger=source_trigger, control_sha=producer)
        send.consume()
        _, self.execution = self.store.admit(
            NEXT, inputs, key=self.intent["correlation_key"],
            trigger={**source_trigger, "run_id": "71"}, control_sha=producer)
        self.execution.consume()
        self.before = self.store.current()
        self.expected = self.before["state_sha"]
        self.event = {"repository": {"full_name": REPOSITORY}, "ref": "refs/heads/main",
                      "sender": {"login": "owner"}, "inputs": {
                          "expected_state_sha": self.expected, "decision_id": self.intent["decision_id"]}}
        self.write_event()
        os.environ["GITHUB_RUN_ID"] = "72"
        os.environ["GITHUB_WORKFLOW_REF"] = (
            REPOSITORY + "/.github/workflows/" + OWNER_FAILED_NEXT_CHECKPOINT + "@refs/heads/main")
        source = FailedCheckpointSource()
        for run in (source.run, source.attempt):
            run.update(head_sha=producer, display_title="Next " + self.intent["correlation_key"])
            for field in ("repository", "head_repository"):
                run[field]["full_name"] = REPOSITORY
            for field in ("actor", "triggering_actor"):
                run[field]["login"] = "owner"
        source.jobs[0]["head_sha"] = producer
        source.artifacts[0]["workflow_run"]["head_sha"] = producer
        source.set_report({**source.report, "state_sha": self.expected})
        self.start_patch(patch.object(next_no_effect_artifact, "_default_json",
                                     side_effect=lambda repository, endpoint: source.get_json(endpoint)))
        self.start_patch(patch.object(next_no_effect_artifact, "_default_archive",
                                     side_effect=lambda repository, endpoint: source.get_archive(endpoint)))
        return source

    def test_failed_automatic_next_cli_requires_own_workflow_and_is_replayable_without_write(self):
        from dispatch_journal import OWNER_FAILED_NEXT_CHECKPOINT
        source = self.prepare_failed_automatic_next()
        before = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        args = self.arguments("failed_next_checkpoint")
        os.environ["GITHUB_WORKFLOW_REF"] = (
            REPOSITORY + "/.github/workflows/" + OWNER_NEXT_COMPLETION + "@refs/heads/main")
        self.assert_rejected_without_mutation(args)
        self.assertEqual(source.calls, [])
        os.environ["GITHUB_WORKFLOW_REF"] = (
            REPOSITORY + "/.github/workflows/" + OWNER_FAILED_NEXT_CHECKPOINT + "@refs/heads/main")
        pushes = self.pushes
        status, result = self.invoke(args)
        self.assertEqual((status, result["outcome"]), (0, "completed"))
        self.assertEqual(result["kind"], "automatic_next_failed_before_external_mutation")
        self.assertEqual(self.pushes, pushes + 1)
        saved = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.assertEqual({key: value for key, value in before.items() if key != "dispatch_journal"},
                         {key: value for key, value in saved.items() if key != "dispatch_journal"})
        self.assertEqual(saved["dispatch_journal"]["events"][:-1], before["dispatch_journal"]["events"])
        receipt = self.store.current()["completions"][self.intent["decision_id"]]
        self.assertEqual(receipt["native_report"], source.report)
        self.assertEqual((self.store.current()["effects"], self.store.current()["phase_claims"]), ({}, {}))
        os.environ["GITHUB_RUN_ATTEMPT"] = "2"
        reads, pushes = len(source.calls), self.pushes
        status, replay = self.invoke(args)
        self.assertEqual((status, replay["outcome"]), (0, "already_completed"))
        self.assertEqual(replay["receipt_id"], result["receipt_id"])
        self.assertEqual((len(source.calls), self.pushes), (reads, pushes))
        self.assertEqual(load_state(self.repo, self.store.manifest_path, self.store.revision_path), saved)

    def test_failed_next_cli_lost_ack_is_not_success_and_exact_rerun_recovers_only_existing_receipt(self):
        self.prepare_failed_automatic_next()
        args = self.arguments("failed_next_checkpoint")
        self.lose_ack = True
        pushes = self.pushes
        status, result = self.invoke(args)
        self.assertEqual((status, result), (1, {
            "outcome": "blocked", "reason": "owner_failed_next_checkpoint_acknowledgement_unknown"}))
        self.assertEqual(self.pushes, pushes + 1)
        committed = self.store.current()
        receipt = committed["completions"][self.intent["decision_id"]]
        self.assertEqual(receipt["kind"], "automatic_next_failed_before_external_mutation")
        self.assertEqual((committed["effects"], committed["phase_claims"], committed["stages"]), ({}, {}, {}))
        self.lose_ack = False
        os.environ["GITHUB_RUN_ATTEMPT"] = "2"
        status, replay = self.invoke(args)
        self.assertEqual((status, replay["outcome"]), (0, "already_completed"))
        self.assertEqual(replay["receipt_id"], receipt["receipt_id"])
        self.assertEqual(self.store.current(), committed)
        self.assertEqual(self.pushes, pushes + 1)

    def test_failed_next_cli_changed_original_owner_inputs_remain_rejected_after_closure(self):
        self.prepare_failed_automatic_next()
        args = self.arguments("failed_next_checkpoint")
        self.invoke(args)
        os.environ["GITHUB_RUN_ATTEMPT"] = "2"
        self.event["inputs"]["expected_state_sha"] = self.store.current()["state_sha"]
        self.write_event()
        self.assert_rejected_without_mutation(args)

    def test_failed_report_checkpoint_uses_distinct_owner_workflow_and_preserves_original_body(self):
        from dispatch_journal import OWNER_REPORT_CHECKPOINT
        from next_no_effect_artifact_test import FailedCheckpointSource
        from owner_report_recovery import claim_recovery, queue_recovery
        from owner_report_recovery_test import research_manifest
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        data.update(research_manifest())
        request = queue_recovery(data, CONFIG,
            inputs={"task_id": "first", "recover_report": True, "repair_after": "2026-10-03T11:00:00Z"},
            trigger=self.trigger("40"))
        self.store.save_manifest(data)
        self.prepare(NEXT, claimed=True, owner_workflow=OWNER_REPORT_CHECKPOINT,
                     inputs=request["inputs"], execution_run="71")
        os.environ["GITHUB_RUN_ID"] = "72"
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        claim_recovery(data, CONFIG, inputs=request["inputs"], intent=self.intent,
                       trigger=self.trigger("71"), capability=self.execution)
        self.store.save_manifest(data)
        self.before = self.store.current()
        self.expected = self.before["state_sha"]
        self.event["inputs"]["expected_state_sha"] = self.expected
        self.write_event()
        source = FailedCheckpointSource()
        for run in (source.run, source.attempt):
            run.update(head_sha=self.control, display_title="Next " + self.intent["correlation_key"])
            for field in ("repository", "head_repository"):
                run[field]["full_name"] = REPOSITORY
            for field in ("actor", "triggering_actor"):
                run[field]["login"] = "owner"
        source.jobs[0]["head_sha"] = self.control
        source.artifacts[0]["workflow_run"]["head_sha"] = self.control
        source.set_report({**source.report, "state_sha": self.expected})
        self.start_patch(patch.object(next_no_effect_artifact, "_default_json",
                                     side_effect=lambda repository, endpoint: source.get_json(endpoint)))
        self.start_patch(patch.object(next_no_effect_artifact, "_default_archive",
                                     side_effect=lambda repository, endpoint: source.get_archive(endpoint)))
        os.environ["GITHUB_WORKFLOW_REF"] = REPOSITORY + "/.github/workflows/" + OWNER_NEXT_COMPLETION + "@refs/heads/main"
        self.assert_rejected_without_mutation(self.arguments("report_checkpoint"))
        os.environ["GITHUB_WORKFLOW_REF"] = REPOSITORY + "/.github/workflows/" + OWNER_REPORT_CHECKPOINT + "@refs/heads/main"
        status, result = self.invoke(self.arguments("report_checkpoint"))
        self.assertEqual((status, result["outcome"]), (0, "completed"))
        saved = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.assertEqual({key: value for key, value in saved.items() if key != "dispatch_journal"},
                         {key: value for key, value in data.items() if key != "dispatch_journal"})
        after = self.store.current()
        for field in ("send_claims", "executor_claims", "stages", "phase_claims", "effects"):
            self.assertEqual(after[field], self.before[field])
        receipt = after["completions"][self.intent["decision_id"]]
        self.assertEqual(receipt["native_report"], source.report)
        self.assertEqual(receipt["evidence"]["request_id"], request["request_id"])
        self.assertEqual(receipt["evidence"]["status"], "failed_before_provider_post")
        self.assertIsNone(after["active_intent"])


    def assert_observed_next_completion(self, reason):
        source = self.prepare_next_completion()
        source.set_report(dict(source.report, reason=reason))
        if reason == "active_polling":
            source.active_polling()
        before_body = json.loads(self.store.manifest_path.read_text(encoding="utf-8"))
        pushes = self.pushes
        status, result = self.invoke(self.arguments("next_completion"))
        self.assertEqual((status, result["outcome"]), (0, "completed"))
        after = self.store.current()
        after_body = json.loads(self.store.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual({k: v for k, v in before_body.items() if k != "dispatch_journal"},
                         {k: v for k, v in after_body.items() if k != "dispatch_journal"})
        self.assertEqual(after_body["dispatch_journal"]["events"][:-1],
                         before_body["dispatch_journal"]["events"])
        self.assertEqual(after["executor_claims"], self.before["executor_claims"])
        self.assertEqual(after["send_claims"], self.before["send_claims"])
        self.assertEqual((after["effects"], after["stages"], after["phase_claims"]), ({}, {}, {}))
        self.assertIsNone(after["active_intent"])
        self.assertEqual(after["frontier_seq"], self.before["frontier_seq"] + 1)
        completion = after["completions"][self.intent["decision_id"]]
        self.assertEqual(completion["proof"]["producer"],
                         self.before["executor_claims"][self.intent["decision_id"]]["trigger"])
        self.assertEqual(completion["owner_trigger"]["run_id"], "72")
        self.assertEqual(self.pushes, pushes + 1)
        calls = list(source.calls)
        os.environ["GITHUB_RUN_ATTEMPT"] = "2"
        status, replay = self.invoke(self.arguments("next_completion"))
        self.assertEqual((status, replay["outcome"], replay["receipt_id"]),
                         (0, "already_completed", result["receipt_id"]))
        self.assertEqual((self.store.current(), self.pushes, source.calls), (after, pushes + 1, calls))
        _, denied = self.store.admit(NEXT, {"automatic": True}, key=self.intent["correlation_key"],
                                     trigger=self.trigger("71"), control_sha=self.control)
        self.assertIsNone(denied)
        self.assertEqual(self.store.current(), after)

    def test_observed_next_completion_preserves_body_rights_and_original_history(self):
        self.assert_observed_next_completion("sync_running")

    def test_observed_busy_next_preserves_body_rights_and_original_history(self):
        self.assert_observed_next_completion("next_task_running")

    def test_observed_active_polling_successful_cli_preserves_body_and_closes_only_original_claim(self):
        self.assert_observed_next_completion("active_polling")

    def test_completion_cannot_be_rebound_to_another_owner_event(self):
        self.prepare_next_completion()
        status, result = self.invoke(self.arguments("next_completion"))
        self.assertEqual((status, result["outcome"]), (0, "completed"))
        os.environ["GITHUB_RUN_ID"] = "73"
        self.assert_rejected_without_mutation(self.arguments("next_completion"))

    def test_source_checkpoint_must_contain_the_original_executor(self):
        source = self.prepare_next_completion()
        source.report["state_sha"] = self.before["executor_claims"][self.intent["decision_id"]]["before_state_sha"]
        source.set_report(source.report)
        self.assert_rejected_without_mutation(self.arguments("next_completion"))

    def test_a_fresh_cas_pin_does_not_authorize_changed_controller_or_task_body(self):
        self.prepare_next_completion()
        load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        body = json.loads(self.store.manifest_path.read_text(encoding="utf-8"))
        body["controller"] = {"last_useful_tick_at": "2026-01-01T00:00:00Z"}
        self.store.manifest_path.write_text(json.dumps(body), encoding="utf-8")
        self.expected = save_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.event["inputs"]["expected_state_sha"] = self.expected
        self.write_event()
        self.assert_rejected_without_mutation(self.arguments("next_completion"))

    def test_race_after_authentication_cannot_be_retried_or_overwritten(self):
        source = self.prepare_next_completion()
        original_download = source.get_archive

        def competing_writer(endpoint):
            archive = original_download(endpoint)
            other = JournalStore(self.repo, self.root / "other-queue.json", self.root / "other-revision.json")
            load_state(self.repo, other.manifest_path, other.revision_path)
            body = json.loads(other.manifest_path.read_text(encoding="utf-8"))
            body["protected"]["identity"] = "competing owner change"
            other.manifest_path.write_text(json.dumps(body), encoding="utf-8")
            save_state(self.repo, other.manifest_path, other.revision_path)
            return archive

        source.get_archive = competing_writer
        status, result = self.invoke(self.arguments("next_completion"))
        self.assertEqual((status, result["outcome"]), (1, "blocked"))
        after = self.store.current()
        self.assertNotIn(self.intent["decision_id"], after["completions"])
        body = json.loads(self.store.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(body["protected"]["identity"], "competing owner change")
        self.assertEqual(after["executor_claims"], self.before["executor_claims"])

    def test_lost_completion_ack_only_observes_the_same_original_receipt_on_replay(self):
        source = self.prepare_next_completion()
        self.lose_ack = True
        pushes = self.pushes
        status, result = self.invoke(self.arguments("next_completion"))
        self.assertEqual((status, result["outcome"], result["reason"]),
                         (1, "blocked", "owner_next_completion_acknowledgement_unknown"))
        self.lose_ack = False
        after = self.store.current()
        calls = list(source.calls)
        status, result = self.invoke(self.arguments("next_completion"))
        self.assertEqual((status, result["outcome"]), (0, "already_completed"))
        self.assertEqual((self.store.current(), self.pushes, source.calls), (after, pushes + 1, calls))

    def test_owner_completion_cannot_observe_a_manual_next(self):
        self.prepare(NEXT, claimed=True, owner_workflow=OWNER_NEXT_COMPLETION)
        self.assert_rejected_without_mutation(self.arguments("next_completion"))

    def test_owner_completion_cannot_observe_an_unclaimed_next(self):
        self.prepare(NEXT, owner_workflow=OWNER_NEXT_COMPLETION, inputs={"automatic": True})
        self.assert_rejected_without_mutation(self.arguments("next_completion"))

    def test_other_owner_workflows_cannot_close_next_execution(self):
        self.prepare_next_completion()
        os.environ["GITHUB_WORKFLOW_REF"] = REPOSITORY + "/.github/workflows/" + OWNER_CONTINUE_CUTOVER + "@refs/heads/main"
        self.assert_rejected_without_mutation(self.arguments("next_completion"))

    def test_each_operation_rejects_other_operations_acknowledgement(self):
        acknowledged = {"decision_id": "d" * 64, "receipt_id": "e" * 64,
                        "state_sha": "a" * 40, "frontier_seq": 1}
        for operation, foreign_outcomes in (("delivery", ("cut_over", "already_cut_over")),
                                            ("continue_cutover", ("fenced", "already_fenced"))):
            for outcome in foreign_outcomes:
                with self.subTest(operation=operation, outcome=outcome), self.assertRaises(JournalUncertain):
                    recover_delivery._acknowledged_result({**acknowledged, "outcome": outcome},
                                                          acknowledged["decision_id"], operation)

    def test_reserved_dispatch_workflows_cannot_close_continue_or_revoke_delivery(self):
        self.prepare(claimed=True)
        for operation, workflow in (("dispatch_observation", OWNER_DISPATCH_OBSERVATION),
                                    ("dispatch_binding", OWNER_DISPATCH_BINDING)):
            os.environ["GITHUB_WORKFLOW_REF"] = REPOSITORY + "/.github/workflows/" + workflow + "@refs/heads/main"
            with self.subTest(operation=operation):
                self.assert_rejected_without_mutation(self.arguments(operation))
                for other in ("delivery", "continue_cutover", "next_completion", "report_checkpoint"):
                    self.assert_rejected_without_mutation(self.arguments(other))

    def test_observation_cannot_be_treated_as_a_mutating_receipt(self):
        value = {"outcome": "observed", "decision_id": "d" * 64,
                 "state_sha": "a" * 40, "frontier_seq": 1}
        for operation in ("delivery", "continue_cutover", "next_completion", "report_checkpoint", "dispatch_binding"):
            with self.subTest(operation=operation), self.assertRaises(JournalUncertain):
                recover_delivery._acknowledged_result(value, value["decision_id"], operation)

    def test_binding_acknowledgement_rejects_foreign_or_incomplete_outcomes(self):
        value = {"outcome": "bound", "decision_id": "d" * 64, "receipt_id": "e" * 64,
                 "state_sha": "a" * 40, "frontier_seq": 1}
        invalid = [{**value, "outcome": "completed"}, {**value, "decision_id": "f" * 64},
                   {**value, "receipt_id": "raw private provider text"},
                   {**value, "state_sha": "unknown"}, {**value, "frontier_seq": True},
                   {key: item for key, item in value.items() if key != "receipt_id"}]
        for item in invalid:
            with self.subTest(item=item), self.assertRaises(JournalUncertain):
                recover_delivery._acknowledged_result(item, value["decision_id"], "dispatch_binding")


    def test_reserved_owner_entries_reject_actor_pin_payload_and_context_changes_before_observation(self):
        self.prepare(NEXT, claimed=True, inputs={"automatic": True}, execution_run="70")
        original_event = copy.deepcopy(self.event)
        original_recheck = recover_delivery.recheck_context
        for operation, workflow in (("dispatch_observation", OWNER_DISPATCH_OBSERVATION),
                                    ("dispatch_binding", OWNER_DISPATCH_BINDING)):
            os.environ["GITHUB_WORKFLOW_REF"] = REPOSITORY + "/.github/workflows/" + workflow + "@refs/heads/main"
            changes = (("GITHUB_ACTOR", "foreign"), ("GITHUB_TRIGGERING_ACTOR", "foreign"),
                       ("GITHUB_WORKFLOW_SHA", "f" * 40), ("GITHUB_SHA", "f" * 40),
                       ("CONTROL_SHA", "f" * 40), ("GITHUB_REF", "refs/heads/foreign"),
                       ("CONTINUATION_KEY", "d" * 32))
            for variable, value in changes:
                with self.subTest(operation=operation, variable=variable), patch.dict(os.environ, {variable: value}):
                    result = self.assert_rejected_without_mutation(self.arguments(operation))
                    self.assertEqual(result["reason"], "owner_" + operation + "_context_rejected")
            self.event["inputs"]["control_sha"] = self.control
            self.write_event()
            result = self.assert_rejected_without_mutation(self.arguments(operation))
            self.assertEqual(result["reason"], "owner_" + operation + "_context_rejected")
            self.event = copy.deepcopy(original_event)
            self.write_event()

            def change_actor(binding):
                original_recheck(binding)
                os.environ["GITHUB_TRIGGERING_ACTOR"] = "foreign"

            with patch.dict(os.environ), patch.object(recover_delivery, "recheck_context", side_effect=change_actor):
                result = self.assert_rejected_without_mutation(self.arguments(operation))
                self.assertEqual(result["reason"], "owner_" + operation + "_context_rejected")

class ObservationOutputTests(unittest.TestCase):
    def setUp(self):
        from dispatch_recovery_test import (REPOSITORY as provider_repository, PRIMARY,
                                            Transport, observe, page, provider_session, reserved_task)
        from jules_dispatch import Response
        from next_no_effect_artifact_test import DECISION, KEY, TRIGGER, FailedCheckpointSource
        task = reserved_task()
        self.session = provider_session(task)
        transport = Transport([page(self.session), Response(200, copy.deepcopy(self.session))])
        observed = observe(task, transport)
        source = FailedCheckpointSource()
        for run in (source.run, source.attempt):
            for name in ("repository", "head_repository"):
                run[name]["full_name"] = provider_repository
        producer = {**TRIGGER, "repository": provider_repository}
        native = next_no_effect_artifact.authenticated_failed_save_checkpoint(
            provider_repository, producer, DECISION, KEY,
            get_json=source.get_json, get_archive=source.get_archive)
        report = native.pop("report")
        self.value = {"outcome": "observed", "decision_id": DECISION, "state_sha": report["state_sha"],
                      "frontier_seq": 3, "identity": observed["identity"], "provider_proof": observed["proof"],
                      "native_proof": native, "native_report": report}
        self.config = {"repository": provider_repository}
        self.private = (PRIMARY, self.session["prompt"], self.session["title"],
                        "SYNTHETIC_PRIVATE_WORKER_PROSE", "SYNTHETIC_PRIVATE_REQUEST")

    def validate(self, value=None):
        return recover_delivery._observed_result(self.value if value is None else value,
                                                self.value["decision_id"], self.value["state_sha"], self.config)

    def test_real_authenticated_proof_retains_no_private_provider_material(self):
        before = copy.deepcopy(self.value)
        result = self.validate()
        self.assertEqual(result, before)
        text = json.dumps(result)
        for private in self.private:
            self.assertNotIn(private, text)
        result["native_proof"]["producer"]["actor"] = "foreign"
        result["native_report"]["attention"][0]["reason"] = "foreign"
        self.assertEqual(self.value, before)

    def test_every_retained_object_rejects_unknown_or_missing_keys(self):
        for name in (None, "identity", "provider_proof", "native_proof", "native_report", "producer"):
            for change in ("extra", "missing"):
                value = copy.deepcopy(self.value)
                target = (value if name is None else value["native_proof"]["producer"]
                          if name == "producer" else value[name])
                if change == "extra":
                    target["private"] = self.session
                else:
                    target.pop(next(iter(target)))
                with self.subTest(object=name, change=change), self.assertRaises(JournalUncertain):
                    self.validate(value)

    def test_proof_mismatches_or_untyped_facts_cannot_reach_retention(self):
        variants = [(None, "outcome", "bound"), (None, "decision_id", "f" * 64),
                    (None, "state_sha", "f" * 40), (None, "frontier_seq", True),
                    ("identity", "task_id", self.session["prompt"]), ("identity", "attempts", True),
                    ("identity", "dispatch_key", "f" * 24), ("identity", "starting_branch", "main"),
                    ("provider_proof", "attempts", True), ("provider_proof", "authenticated", 1),
                    ("provider_proof", "method", "POST"), ("provider_proof", "repository", "foreign/repo"),
                    ("provider_proof", "session_resource", "sessions/foreign"),
                    ("provider_proof", "session_id", "private\ntext"),
                    ("provider_proof", "session_state", "private text"),
                    ("provider_proof", "session_sha256", "f" * 64),
                    ("provider_proof", "observed_at", "2026-99-99T12:00:00Z"),
                    ("native_proof", "artifact_name", "foreign"),
                    ("native_proof", "workflow", OWNER_DISPATCH_OBSERVATION),
                    ("native_report", "reason", "private diagnostic"),
                    ("native_report", "attention", [{"reason": "private diagnostic"}])]
        for name, field, item in variants:
            value = copy.deepcopy(self.value)
            (value if name is None else value[name])[field] = item
            with self.subTest(object=name, field=field), self.assertRaises(JournalUncertain):
                self.validate(value)


class ReservedDispatchOwnerEntryTests(unittest.TestCase):
    def setUp(self):
        from reserved_dispatch_checkpoint_test import ReservedDispatchCheckpointTests
        from dispatch_recovery_test import PRIMARY
        self.fixture = f = ReservedDispatchCheckpointTests()
        self.addCleanup(f.doCleanups)
        f.setUp()
        self.config_path = f.repo / "autonomous-project.json"
        self.config_path.write_text(json.dumps(f.config), encoding="utf-8")
        f.git(f.repo, "add", "autonomous-project.json")
        f.git(f.repo, "commit", "-m", "synthetic checked owner config")
        self.control = f.git(f.repo, "rev-parse", "HEAD")
        f.prepare()
        self.expected = f.pin
        f.git(f.repo, "remote", "set-url", "origin", "https://github.com/" + f.config["repository"])
        native_git = state_store._git
        self.pushes = 0
        self.lose_ack = False

        def state_transport(repo, *args, **kwargs):
            args = tuple(str(f.remote) if arg == "origin" else arg for arg in args)
            result = native_git(repo, *args, **kwargs)
            if "push" in args:
                self.pushes += 1
                if self.lose_ack:
                    raise subprocess.TimeoutExpired("synthetic private acknowledged push", 90)
            return result

        self.start_patch(patch.object(state_store, "_git", side_effect=state_transport))
        for module in (recover_delivery, workflow_admission):
            self.start_patch(patch.object(module, "__file__", str(
                f.repo / "scripts" / "autonomous" / (module.__name__ + ".py"))))
        self.event_path = f.root / "owner-event.json"
        self.result_path = f.root / "owner-result.json"
        self.event = {"repository": {"full_name": f.config["repository"]}, "ref": "refs/heads/main",
                      "sender": {"login": "owner-a"}, "inputs": {
                          "expected_state_sha": self.expected, "decision_id": f.intent["decision_id"]}}
        self.event_path.write_text(json.dumps(self.event), encoding="utf-8")
        self.start_patch(patch.dict(os.environ, {
            **{name: os.environ[name] for name in
               ("PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP") if name in os.environ},
            "GITHUB_RUN_ID": "500", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REPOSITORY": f.config["repository"], "GITHUB_REF": "refs/heads/main",
            "GITHUB_ACTOR": "owner-a", "GITHUB_TRIGGERING_ACTOR": "owner-a",
            "GITHUB_SHA": self.control, "GITHUB_WORKFLOW_SHA": self.control, "CONTROL_SHA": self.control,
            "CONTINUATION_KEY": "", "GITHUB_EVENT_PATH": str(self.event_path),
            "GH_TOKEN": "SYNTHETIC_PRIVATE_GH_TOKEN", "JULES_API_KEY": PRIMARY,
            "JULES_API_KEY_BACKUP": "SYNTHETIC_PRIVATE_BACKUP",
            "JULES_API_BASE": "https://untrusted.invalid/not-canonical",
        }, clear=True))
        stack = f.transport()
        stack.__enter__()
        self.addCleanup(stack.close)
        self.start_patch(patch("jules_dispatch.urllib.request.urlopen", side_effect=self.http_get))
        self.select("dispatch_observation")

    start_patch = OwnerEntryTests.start_patch

    def select(self, operation):
        self.operation = operation
        workflow = recover_delivery.OPERATIONS[operation][0]
        os.environ["GITHUB_WORKFLOW_REF"] = (
            self.fixture.config["repository"] + "/.github/workflows/" + workflow + "@refs/heads/main")

    def http_get(self, request, timeout):
        from jules_dispatch import DEFAULT_API_BASE
        self.assertTrue(request.full_url.startswith(DEFAULT_API_BASE + "/sessions"))
        response = self.fixture.provider(request.get_method(), request.full_url,
                                         {key.lower(): value for key, value in request.header_items()}, request.data)
        self.assertEqual(response.status, 200)
        body = json.dumps(response.payload).encode("utf-8")

        class HttpResponse:
            status = 200
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return body

        return HttpResponse()

    def arguments(self):
        f = self.fixture
        return ["--operation", self.operation, "--repo", str(f.repo), "--config", str(self.config_path),
                "--manifest", str(f.store.manifest_path), "--revision-file", str(f.store.revision_path),
                "--expected-state-sha", self.expected, "--decision-id", f.intent["decision_id"],
                "--out", str(self.result_path)]

    def invoke(self, arguments=None):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            status = recover_delivery.main(self.arguments() if arguments is None else arguments)
        text = output.getvalue()
        result = json.loads(text)
        self.assertEqual(json.loads(self.result_path.read_text(encoding="utf-8")), result)
        self.fixture.assert_private(result)
        for private in ("SYNTHETIC_PRIVATE_GH_TOKEN", "SYNTHETIC_PRIVATE_BACKUP", self.fixture.session["title"]):
            self.assertNotIn(private, text)
        return status, result

    def assert_blocked_unchanged(self, reason):
        before = self.fixture.authoritative()
        pushes = self.pushes
        status, result = self.invoke()
        self.assertEqual((status, result), (1, {"outcome": "blocked", "reason": reason}))
        self.assertEqual(self.fixture.authoritative(), before)
        self.assertEqual(self.pushes, pushes)

    def test_get_only_cli_observation_retains_proof_without_state_push(self):
        before = self.fixture.authoritative()
        status, result = self.invoke()
        self.assertEqual((status, result["outcome"]), (0, "observed"))
        self.assertEqual(set(result), {"outcome", "decision_id", "state_sha", "frontier_seq", "identity",
                                      "provider_proof", "native_proof", "native_report"})
        self.assertEqual(self.fixture.authoritative(), before)
        self.assertEqual(self.pushes, 0)
        self.assertEqual(len(self.fixture.provider.calls), 2)
        self.fixture.assert_get_only()

    def test_binding_calls_one_cas_and_rerun_only_reads_same_receipt(self):
        self.select("dispatch_binding")
        status, result = self.invoke()
        self.assertEqual((status, result["outcome"]), (0, "bound"))
        self.assertEqual(set(result), {"outcome", "decision_id", "receipt_id", "state_sha", "frontier_seq"})
        self.assertEqual(self.pushes, 1)
        after = self.fixture.authoritative()
        calls = len(self.fixture.provider.calls)
        source_calls = list(self.fixture.source.calls)
        os.environ["GITHUB_RUN_ATTEMPT"] = "2"
        status, replay = self.invoke()
        self.assertEqual((status, replay["outcome"], replay["receipt_id"]), (0, "already_bound", result["receipt_id"]))
        self.assertEqual(self.fixture.authoritative(), after)
        self.assertEqual((self.pushes, len(self.fixture.provider.calls), self.fixture.source.calls),
                         (1, calls, source_calls))
        os.environ["GITHUB_RUN_ID"] = "501"
        self.assert_blocked_unchanged("owner_dispatch_binding_conflict")
        self.assertEqual(len(self.fixture.provider.calls), calls)
        os.environ["GITHUB_RUN_ID"] = "500"
        with patch.dict(os.environ, {"GITHUB_ACTOR": "owner-b", "GITHUB_TRIGGERING_ACTOR": "owner-b"}):
            self.event["sender"]["login"] = "owner-b"
            self.event_path.write_text(json.dumps(self.event), encoding="utf-8")
            self.assert_blocked_unchanged("owner_dispatch_binding_conflict")
        self.event["sender"]["login"] = "owner-a"
        self.expected = result["state_sha"]
        self.event["inputs"]["expected_state_sha"] = self.expected
        self.event_path.write_text(json.dumps(self.event), encoding="utf-8")
        self.assert_blocked_unchanged("owner_dispatch_binding_conflict")
        self.assertEqual((len(self.fixture.provider.calls), self.fixture.source.calls), (calls, source_calls))

    def test_lost_binding_acknowledgement_blocks_and_same_owner_rerun_readbacks(self):
        self.select("dispatch_binding")
        self.lose_ack = True
        status, result = self.invoke()
        self.assertEqual((status, result), (1, {"outcome": "blocked",
                                              "reason": "owner_dispatch_binding_acknowledgement_unknown"}))
        self.assertEqual(self.pushes, 1)
        self.lose_ack = False
        after = self.fixture.authoritative()
        calls = len(self.fixture.provider.calls)
        os.environ["GITHUB_RUN_ATTEMPT"] = "2"
        status, result = self.invoke()
        self.assertEqual((status, result["outcome"]), (0, "already_bound"))
        self.assertEqual((self.fixture.authoritative(), self.pushes, len(self.fixture.provider.calls)),
                         (after, 1, calls))

    def test_valid_original_reservation_rejects_context_changes_before_any_external_get(self):
        changes = (("GITHUB_TRIGGERING_ACTOR", "owner-b"), ("GITHUB_SHA", "f" * 40),
                   ("GITHUB_WORKFLOW_SHA", "f" * 40), ("CONTROL_SHA", "f" * 40),
                   ("GITHUB_WORKFLOW_REF", "foreign/repo/.github/workflows/autonomous_observe_dispatch.yml@refs/heads/main"))
        for operation in ("dispatch_observation", "dispatch_binding"):
            self.select(operation)
            for variable, value in changes:
                with self.subTest(operation=operation, variable=variable), patch.dict(os.environ, {variable: value}):
                    self.assert_blocked_unchanged("owner_" + operation + "_context_rejected")
        self.assertEqual(self.fixture.provider.calls, [])
        self.assertEqual(self.fixture.source.calls, [])

    def test_operation_isolation_and_stale_pin_never_retain_a_session(self):
        for operation in ("delivery", "continue_cutover", "next_completion", "report_checkpoint", "dispatch_binding"):
            arguments = self.arguments()
            arguments[arguments.index("--operation") + 1] = operation
            status, result = self.invoke(arguments)
            self.assertEqual((status, result["reason"]), (1, recover_delivery.OPERATIONS[operation][1] + "_context_rejected"))
        self.assertEqual(self.fixture.source.calls, [])
        self.expected = "f" * 40
        self.event["inputs"]["expected_state_sha"] = self.expected
        self.event_path.write_text(json.dumps(self.event), encoding="utf-8")
        self.assert_blocked_unchanged("owner_dispatch_observation_conflict")
        self.assertEqual(self.fixture.provider.calls, [])

    def test_original_provider_identity_mismatch_retains_only_safe_blocked_outcome(self):
        from jules_dispatch import Response
        self.fixture.provider.responses[-1] = Response(200, {**self.fixture.session, "prompt": "SYNTHETIC_PRIVATE_MISMATCH"})
        self.assert_blocked_unchanged("owner_dispatch_observation_acknowledgement_unknown")
        self.assertEqual(len(self.fixture.provider.calls), 2)

    def test_retention_failure_never_reports_observation_success_or_pushes(self):
        before = self.fixture.authoritative()
        with patch.object(recover_delivery, "_atomic_bytes", side_effect=OSError("SYNTHETIC_PRIVATE_IO")):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                status = recover_delivery.main(self.arguments())
        self.assertEqual((status, json.loads(output.getvalue())), (1, {"outcome": "blocked",
                         "reason": "owner_dispatch_observation_result_retention_failed"}))
        self.assertEqual(self.fixture.authoritative(), before)
        self.assertEqual(self.pushes, 0)

    def test_raw_session_added_to_real_observation_is_rejected_before_retention(self):
        original = JournalStore.observe_reserved_dispatch

        def unsafe_acknowledgement(store, **parameters):
            result = original(store, **parameters)
            result["session"] = self.fixture.session
            return result

        with patch.object(JournalStore, "observe_reserved_dispatch", unsafe_acknowledgement):
            self.assert_blocked_unchanged("owner_dispatch_observation_acknowledgement_unknown")
        self.assertEqual(len(self.fixture.provider.calls), 2)
        self.assertEqual(self.pushes, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
