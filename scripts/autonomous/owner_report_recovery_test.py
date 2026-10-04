#!/usr/bin/env python3
"""Owner commands cannot replace runtime rights or lose their attempt identity."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from build_jules_request import build, dispatch_key
from dispatch_journal import CONTINUE, NEXT, JournalStore, materialize, normalize_inputs
from lab_controller import main as controller_main
from owner_report_recovery import claim_recovery, pending_recovery, queue_recovery, validate_requests
from research_request import snapshot
from state_store import load_state, save_state
from task_lifecycle import complete, reserve, start


NOW = datetime(2026, 10, 3, 12, tzinfo=timezone.utc)
REPOSITORY = "synthetic/owner-report-recovery"
CONTROL = "a" * 40
BASE = "b" * 40
FAILED_AT = "2026-10-03T11:00:00Z"
CONFIG = {"repository": REPOSITORY,
          "merge_gate": {"owner_approvers": ["owner", "other-owner"]}}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def trigger(run="100", attempt="1", **overrides):
    return {"run_id": run, "run_attempt": attempt, "event_name": "workflow_dispatch",
            "control_sha": CONTROL, "repository": REPOSITORY, "actor": "owner", **overrides}


def recovery_inputs(task_id="first", after=FAILED_AT, **overrides):
    return normalize_inputs(NEXT, {"recover_report": True, "task_id": task_id,
                                   "repair_after": after, **overrides})


def add_attempt(data, task, session_id, *, parked=True, now=NOW - timedelta(hours=2)):
    key = dispatch_key(REPOSITORY, task["id"], (task.get("execution") or {}).get("attempts", 0) + 1)
    branch = "autonomous/attempt-" + key
    request = build(task, template="{{TASK_JSON}}", repo=REPOSITORY,
                    branch="autonomous/lab", starting_branch=branch, base_sha=BASE,
                    decision_context=[])
    reserve(data, task["id"], key, base_sha=BASE, starting_branch=branch,
            research_request=snapshot(request, [], CONTROL), now=now)
    start(data, task["id"], session_id=session_id, dispatch_key=key, now=now)
    execution = task["execution"]
    execution["session_state"] = "COMPLETED" if parked else "IN_PROGRESS"
    if parked:
        source = {"session_id": session_id, "dispatch_key": key,
                  "activity_id": "sessions/" + session_id + "/activities/invalid-report",
                  "activity_created_at": "2026-10-03T10:30:00Z", "report_sha256": "c" * 64}
        task["status"] = "blocked"
        execution.update(state="awaiting_report", outcome="report_invalid",
                         report_error={"code": "research_json", "detail": "Invalid synthetic JSON",
                                       "reported_at": FAILED_AT, "source": copy.deepcopy(source)},
                         report_repair={"at": FAILED_AT, "status": "invalid", "result": "sent",
                                        "source": source, "detail": "Synthetic repair remained invalid"})


def research_manifest():
    tasks = [{"id": identifier, "title": "Inspect clock " + identifier,
              "task_type": "project_discovery", "status": "todo", "priority": 40,
              "risk": "low", "focus": ["quality"], "target_paths": ["src/clock.ts"],
              "evidence": {"source": "research_cycle", "detail": "Inspect resume behavior"}}
             for identifier in ("first", "second", "unrelated")]
    data = {"version": 2, "autonomous_loop_policy": {"lifecycle": {"max_attempts": 3}},
            "tasks": tasks, "history": [{"event": "original synthetic queue"}],
            "controller": {"last_tick_at": "2026-10-03T11:30:00Z", "run_id": "90"}}
    for index, task in enumerate(tasks, 1):
        add_attempt(data, task, str(index), parked=task["id"] != "unrelated")
    return data


class OwnerRecoveryFixture:
    def setUp(self):
        self.data = research_manifest()
        self.config = copy.deepcopy(CONFIG)

    def queue(self, *, task_id="first", after=FAILED_AT, source=None, now=NOW, **inputs):
        return queue_recovery(self.data, self.config,
                              inputs=recovery_inputs(task_id, after, **inputs),
                              trigger=source or trigger(), now=now)

    def records(self):
        return self.data["controller"]["owner_recovery_requests"]

    def assert_atomic_queue_rejection(self, inputs, source=None):
        before = encoded(self.data)
        with self.assertRaises(ValueError):
            queue_recovery(self.data, self.config, inputs=inputs,
                           trigger=source or trigger(), now=NOW)
        self.assertEqual(encoded(self.data), before)


class OwnerRecoveryQueueTests(OwnerRecoveryFixture, unittest.TestCase):
    def test_same_failed_receipt_across_runs_reruns_and_owners_is_one_command(self):
        first = self.queue()
        before = encoded(self.data)
        for source in (trigger("100", "2"), trigger("101"),
                       trigger("102", actor="other-owner")):
            with self.subTest(source=source):
                repeated = self.queue(source=source, now=NOW + timedelta(minutes=1))
                self.assertEqual(repeated, first)
                self.assertEqual(encoded(self.data), before)
        self.assertEqual([item["request_id"] for item in self.records()], [first["request_id"]])
        self.assertEqual(validate_requests(self.data), [])

    def test_collector_only_rerun_dedupes_but_distinct_owner_run_remains_explicit(self):
        first = self.queue(after="")
        before = encoded(self.data)
        repeated = self.queue(after="", source=trigger("100", "2"))
        self.assertEqual(repeated, first)
        self.assertEqual(encoded(self.data), before)
        second = self.queue(after="", source=trigger("101"), now=NOW + timedelta(minutes=1))
        self.assertNotEqual(second["request_id"], first["request_id"])
        self.assertEqual([item["request_id"] for item in self.records()],
                         [first["request_id"], second["request_id"]])
        self.assertEqual(pending_recovery(self.data, self.config), first)

    def test_distinct_targets_are_fifo_and_reading_pending_never_spends_command(self):
        first = self.queue()
        second = self.queue(task_id="second", source=trigger("101"), now=NOW + timedelta(minutes=1))
        self.assertNotEqual(first["request_id"], second["request_id"])
        before = encoded(self.data)
        for _ in range(2):
            self.assertEqual(pending_recovery(self.data, self.config), first)
            self.assertEqual(encoded(self.data), before)
        self.assertEqual([item["inputs"]["task_id"] for item in self.records()], ["first", "second"])
        self.assertEqual(validate_requests(self.data), [])

    def test_occupied_pair_defers_repair_without_spending_or_blocking_other_pairs(self):
        target, independent, blocker = self.data["tasks"]
        target["research"] = {"area_id": "clock", "perspective_id": "behavior"}
        blocker["research"] = copy.deepcopy(target["research"])
        independent["research"] = {"area_id": "clock", "perspective_id": "performance"}
        first = self.queue()
        second = self.queue(task_id="second", source=trigger("101"))
        for state in ("dispatched", "quarantined", "awaiting_report"):
            with self.subTest(state=state):
                blocker["status"] = "in_progress" if state == "dispatched" else "blocked"
                blocker["execution"]["state"] = state
                if state == "awaiting_report":
                    blocker["execution"].update(outcome="report_invalid", report_repair={
                        "at": FAILED_AT, "result": "unknown", "status": "pending"})
                before = encoded(self.data)
                self.assertEqual(pending_recovery(self.data, self.config), second)
                self.assertEqual(encoded(self.data), before)
                self.assertNotIn("execution", self.records()[0])
        blocker["execution"]["report_repair"]["status"] = "invalid"
        self.assertEqual(pending_recovery(self.data, self.config), first)
        self.assertEqual(self.records(), [first, second])

    def test_collector_only_recovery_does_not_reserve_an_occupied_pair(self):
        target, _, blocker = self.data["tasks"]
        target["research"] = {"area_id": "clock", "perspective_id": "behavior"}
        blocker["research"] = copy.deepcopy(target["research"])
        collector = self.queue(after="")
        before = encoded(self.data)
        self.assertEqual(pending_recovery(self.data, self.config), collector)
        self.assertEqual(encoded(self.data), before)

    def test_unauthorized_foreign_or_mixed_commands_are_rejected_atomically(self):
        sources = (trigger(actor="stranger"), trigger(repository="foreign/repository"),
                   trigger(event_name="schedule"))
        mixtures = ({"automatic": True}, {"recover_feedback": True},
                    {"feedback_after": FAILED_AT}, {"focus": "quality"},
                    {"recover_report": False}, {"task_id": ""}, {"task_id": "missing"},
                    {"task_id": "unrelated"}, {"repair_after": "2026-10-03T10:00:00Z"})
        for populated in (False, True):
            if populated:
                self.queue(task_id="second")
            for source in sources:
                with self.subTest(populated=populated, source=source):
                    self.assert_atomic_queue_rejection(recovery_inputs(), source)
            for changes in mixtures:
                with self.subTest(populated=populated, changes=changes):
                    self.assert_atomic_queue_rejection({**recovery_inputs(), **changes})

    def test_pending_attempt_rebind_is_rejected_without_mutating_command_or_task(self):
        original = self.queue()
        queued = copy.deepcopy(self.data)
        for field, replacement in (("session_id", "99"), ("dispatch_key", "foreign-attempt"),
                                   ("attempts", 2), ("base_sha", "d" * 40)):
            with self.subTest(field=field):
                self.data = copy.deepcopy(queued)
                self.data["tasks"][0]["execution"][field] = replacement
                before = encoded(self.data)
                with self.assertRaises(ValueError):
                    pending_recovery(self.data, self.config)
                self.assertEqual(encoded(self.data), before)
                self.assertEqual(self.records(), [original])

    def test_pending_owner_revocation_and_repository_change_are_not_execution_authority(self):
        self.queue()
        before = encoded(self.data)
        for config in ({**self.config, "merge_gate": {"owner_approvers": ["other-owner"]}},
                       {**self.config, "repository": "foreign/repository"}):
            with self.subTest(config=config):
                with self.assertRaises(ValueError):
                    pending_recovery(self.data, config)
                self.assertEqual(encoded(self.data), before)

    def test_validator_rejects_tampered_receipt_or_identity_without_repairing_it(self):
        self.queue()
        original = copy.deepcopy(self.data)
        for field, replacement in (("request_id", "f" * 64), ("inputs", recovery_inputs("second")),
                                   ("identity", {"session_id": "99", "dispatch_key": "foreign",
                                                 "attempts": 1, "base_sha": BASE})):
            with self.subTest(field=field):
                altered = copy.deepcopy(original)
                altered["controller"]["owner_recovery_requests"][0][field] = replacement
                before = encoded(altered)
                self.assertTrue(validate_requests(altered))
                self.assertEqual(encoded(altered), before)


class OwnerRecoveryExecutorTests(OwnerRecoveryFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo, self.remote = self.root / "repo", self.root / "remote.git"
        self.git(self.root, "init", "--bare", str(self.remote))
        self.git(self.root, "init", str(self.repo))
        self.git(self.repo, "config", "user.name", "synthetic")
        self.git(self.repo, "config", "user.email", "fixture@example.invalid")
        self.git(self.repo, "config", "commit.gpgsign", "false")
        (self.repo / "agent_tasks.json").write_text(json.dumps(self.data), encoding="utf-8")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "synthetic owner recovery fixture")
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.store = JournalStore(self.repo, self.root / "queue.json", self.root / "revision.json")
        load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        original = save_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.store.initialize(original, CONTROL, {"kind": "fenced_bootstrap", "state_sha": original,
                                                 "legacy_senders_fenced": True, "pending_legacy": "none"})
        self.reload()

    def git(self, repo, *args):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
                              check=True, capture_output=True, text=True).stdout.strip()

    def reload(self):
        self.data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)

    def persist(self):
        self.store.save_manifest(self.data)

    def reserve_receiver(self, inputs, *, admit=True, consume=True, workflow=NEXT):
        intent, send = self.store.reserve_send(workflow, inputs, basis={},
                                               trigger=trigger("200"), control_sha=CONTROL)
        send.consume()
        execution = send
        if admit:
            intent, execution = self.store.admit(workflow, inputs, key=intent["correlation_key"],
                                                 trigger=trigger("201"), control_sha=CONTROL)
            if consume:
                execution.consume()
        self.reload()
        return intent, execution

    def owner_ingress(self, *, run_id="301"):
        config_path, event_path = self.root / "config.json", self.root / "event.json"
        inputs = recovery_inputs("second")
        config_path.write_text(json.dumps(self.config), encoding="utf-8")
        event_path.write_text(json.dumps({"inputs": inputs}), encoding="utf-8")
        output = self.root / "lab-result.json"
        environment = {"GITHUB_RUN_ID": run_id, "GITHUB_RUN_ATTEMPT": "1",
                       "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_EVENT_PATH": str(event_path),
                       "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_ACTOR": "owner",
                       "GITHUB_REF": "refs/heads/main", "CONTROL_SHA": CONTROL,
                       "CONTINUATION_KEY": "",
                       "GITHUB_WORKFLOW_REF": REPOSITORY + "/.github/workflows/" + NEXT + "@refs/heads/main"}
        environment.update({name: os.environ[name] for name in ("PATH", "SYSTEMROOT", "TEMP", "TMP")
                            if name in os.environ})
        with (patch.dict(os.environ, environment, clear=True),
              patch("workflow_admission.control_revision", return_value=CONTROL),
              patch("health_snapshot.gh_get", side_effect=lambda _repo, _path, paginate=False:
                    [{"total_count": 0, "workflow_runs": []}] if paginate
                    else {"total_count": 0, "workflow_runs": []}),
              patch("lab_controller.tick", side_effect=AssertionError("refused ingress cannot run a worker"))):
            status = controller_main([
                "--repo", str(self.repo), "--config", str(config_path),
                "--manifest", str(self.store.manifest_path),
                "--revision-file", str(self.store.revision_path),
                "--recover-report", "--task-id", "second", "--repair-after", FAILED_AT,
                "--out", str(output),
            ])
        self.reload()
        return status, json.loads(output.read_text(encoding="utf-8"))

    def test_cli_retains_distinct_owner_command_after_recorded_outcome_without_runtime_authority(self):
        _, capability = self.reserve_receiver({"automatic": True})
        before_sha = json.loads(self.store.revision_path.read_bytes())["state_sha"]
        self.data["history"].append({"event": "original completed checkpoint"})
        self.persist()
        self.store.record_effect(capability, "controller_checkpoint", {
            "before_state_sha": before_sha,
            "after_state_sha": json.loads(self.store.revision_path.read_bytes())["state_sha"],
            "poll_observations": [],
        })
        self.reload()
        before = copy.deepcopy(self.data)
        status, result = self.owner_ingress()
        self.assertEqual(status, 0)
        command = pending_recovery(self.data, self.config)
        self.assertIsNotNone(command, result)
        self.assertEqual(command["inputs"], recovery_inputs("second"))
        self.assertEqual(command["source_trigger"], trigger("301"))
        self.assertEqual(result["owner_recovery"], {"request_id": command["request_id"], "state": "pending"})
        self.assertNotIn("execution", command)
        restored = copy.deepcopy(self.data)
        del restored["controller"]["owner_recovery_requests"]
        self.assertEqual(encoded(restored), encoded(before))
        committed = encoded(self.data)
        status, repeated = self.owner_ingress(run_id="302")
        self.assertEqual(status, 0)
        self.assertEqual(repeated["owner_recovery"], result["owner_recovery"])
        self.assertEqual(encoded(self.data), committed)

    def test_cli_does_not_queue_owner_command_when_original_execution_is_unresolved(self):
        self.reserve_receiver({"automatic": True})
        before = encoded(self.data)
        status, result = self.owner_ingress()
        self.assertEqual(status, 1)
        self.assertEqual(result["reason"], "executor_without_outcome")
        self.assertNotIn("owner_recovery", result)
        self.assertEqual(encoded(self.data), before)

    def test_real_cas_save_rejects_removing_or_replacing_owner_history_without_remote_mutation(self):
        first = self.queue()
        self.persist()
        ref = "refs/heads/autonomous/state"
        for claimed in (False, True):
            if claimed:
                intent, capability = self.reserve_receiver(first["inputs"])
                claim_recovery(self.data, self.config, inputs=first["inputs"], intent=intent,
                               trigger=trigger("201"), capability=capability, now=NOW)
                self.persist()
            original = copy.deepcopy(self.data)
            remote_sha = self.git(self.remote, "rev-parse", ref)
            remote_bytes = subprocess.run(
                ["git", "-C", str(self.remote), "show", ref + ":agent_tasks.json"],
                check=True, capture_output=True).stdout
            revision_bytes = self.store.revision_path.read_bytes()
            replacement_data = copy.deepcopy(original)
            replacement_data["controller"]["owner_recovery_requests"] = []
            replacement = queue_recovery(replacement_data, self.config,
                                         inputs=recovery_inputs(after=""), trigger=trigger("301"),
                                         now=NOW + timedelta(minutes=1))
            changes = ("drop_field", "empty_history", "replace_command")
            if claimed:
                changes += ("erase_execution",)
            for change in changes:
                with self.subTest(claimed=claimed, change=change):
                    altered = copy.deepcopy(original)
                    if change == "drop_field":
                        del altered["controller"]["owner_recovery_requests"]
                    elif change == "empty_history":
                        altered["controller"]["owner_recovery_requests"] = []
                    elif change == "erase_execution":
                        del altered["controller"]["owner_recovery_requests"][0]["execution"]
                    else:
                        altered["controller"]["owner_recovery_requests"] = [replacement]
                    # Each candidate is independently well-formed. Rejection
                    # must protect previously published history, not its syntax.
                    self.assertEqual(validate_requests(altered), [])
                    self.store.manifest_path.write_text(json.dumps(altered), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        save_state(self.repo, self.store.manifest_path, self.store.revision_path)
                    self.assertEqual(self.git(self.remote, "rev-parse", ref), remote_sha)
                    self.assertEqual(subprocess.run(
                        ["git", "-C", str(self.remote), "show", ref + ":agent_tasks.json"],
                        check=True, capture_output=True).stdout, remote_bytes)
                    self.assertEqual(self.store.revision_path.read_bytes(), revision_bytes)
            self.reload()
            self.assertEqual(encoded(self.data), encoded(original))

    def test_queue_while_unrelated_receiver_active_preserves_all_runtime_and_worker_history(self):
        active, _ = self.reserve_receiver({"automatic": True})
        before = copy.deepcopy(self.data)
        runtime = materialize(self.data["dispatch_journal"])
        first = self.queue()
        without_new_command = copy.deepcopy(self.data)
        del without_new_command["controller"]["owner_recovery_requests"]
        self.assertEqual(encoded(without_new_command), encoded(before))
        self.assertEqual(encoded(self.data["tasks"]), encoded(before["tasks"]))
        self.assertEqual(materialize(self.data["dispatch_journal"]), runtime)
        self.assertEqual(materialize(self.data["dispatch_journal"])["active_intent"], active)
        self.assertEqual(pending_recovery(self.data, self.config), first)

    def test_real_executor_claim_spends_selected_request_once_then_fifo_selects_next(self):
        first = self.queue()
        second = self.queue(task_id="second", source=trigger("101"), now=NOW + timedelta(minutes=1))
        self.persist()
        intent, capability = self.reserve_receiver(first["inputs"])
        before = copy.deepcopy(self.data)
        claimed = claim_recovery(self.data, self.config, inputs=first["inputs"], intent=intent,
                                  trigger=trigger("201"), capability=capability, now=NOW + timedelta(minutes=2))
        executor = materialize(self.data["dispatch_journal"])["executor_claims"][intent["decision_id"]]
        self.assertEqual(claimed["request_id"], first["request_id"])
        self.assertEqual({key: claimed["execution"][key] for key in
                          ("decision_id", "executor_claim_id", "run_id", "run_attempt", "actor")},
                         {"decision_id": intent["decision_id"], "executor_claim_id": executor["claim_id"],
                          "run_id": "201", "run_attempt": "1", "actor": "owner"})
        self.assertEqual(self.records()[1], second)
        self.assertEqual(pending_recovery(self.data, self.config), second)
        restored = copy.deepcopy(self.data)
        restored["controller"]["owner_recovery_requests"][0] = first
        self.assertEqual(encoded(restored), encoded(before))
        consumed = encoded(self.data)
        repeated = claim_recovery(self.data, self.config, inputs=first["inputs"], intent=intent,
                                   trigger=trigger("201"), capability=capability, now=NOW + timedelta(minutes=3))
        self.assertIsNone(repeated)
        self.assertEqual(encoded(self.data), consumed)
        replay = self.queue(source=trigger("999"), now=NOW + timedelta(minutes=4))
        self.assertEqual(replay, claimed)
        self.assertEqual(encoded(self.data), consumed)
        self.assertEqual(validate_requests(self.data), [])

    def test_stored_owner_command_and_send_receipt_cannot_claim_execution(self):
        first = self.queue()
        self.persist()
        intent, send = self.reserve_receiver(first["inputs"], admit=False)
        before = encoded(self.data)
        for counterfeit in (first, intent, send, None):
            with self.subTest(counterfeit=type(counterfeit).__name__):
                with self.assertRaises((ValueError, RuntimeError)):
                    claim_recovery(self.data, self.config, inputs=first["inputs"], intent=intent,
                                   trigger=trigger("201"), capability=counterfeit, now=NOW)
                self.assertEqual(encoded(self.data), before)
        self.assertEqual(pending_recovery(self.data, self.config), first)

    def test_live_capability_cannot_claim_against_manifest_without_its_executor_receipt(self):
        first = self.queue()
        self.persist()
        intent, _ = self.reserve_receiver(first["inputs"], admit=False)
        stale = copy.deepcopy(self.data)
        _, capability = self.store.admit(NEXT, first["inputs"], key=intent["correlation_key"],
                                          trigger=trigger("201"), control_sha=CONTROL)
        capability.consume()
        before = encoded(stale)
        with self.assertRaises((ValueError, RuntimeError)):
            claim_recovery(stale, self.config, inputs=first["inputs"], intent=intent,
                           trigger=trigger("201"), capability=capability, now=NOW)
        self.assertEqual(encoded(stale), before)
        self.assertEqual(pending_recovery(stale, self.config), first)

    def test_admitted_but_unconsumed_capability_cannot_claim_until_consumed(self):
        first = self.queue()
        self.persist()
        intent, capability = self.reserve_receiver(first["inputs"], consume=False)
        before = encoded(self.data)
        with self.assertRaises((ValueError, RuntimeError)):
            claim_recovery(self.data, self.config, inputs=first["inputs"], intent=intent,
                           trigger=trigger("201"), capability=capability, now=NOW)
        self.assertEqual(encoded(self.data), before)
        self.assertEqual(pending_recovery(self.data, self.config), first)
        capability.consume()
        claimed = claim_recovery(self.data, self.config, inputs=first["inputs"], intent=intent,
                                  trigger=trigger("201"), capability=capability, now=NOW)
        self.assertEqual(claimed["request_id"], first["request_id"])
        self.assertIsNone(pending_recovery(self.data, self.config))

    def test_wrong_executor_rerun_or_inputs_cannot_spend_admitted_request(self):
        first = self.queue()
        self.queue(task_id="second", source=trigger("101"))
        self.persist()
        intent, capability = self.reserve_receiver(first["inputs"])
        before = encoded(self.data)
        for source, inputs in ((trigger("202"), first["inputs"]),
                               (trigger("201", "2"), first["inputs"]),
                               (trigger("201", actor="other-owner"), first["inputs"]),
                               (trigger("201", repository="foreign/repository"), first["inputs"]),
                               (trigger("201"), recovery_inputs("second")),
                               (trigger("201"), recovery_inputs(automatic=True))):
            with self.subTest(source=source, inputs=inputs):
                with self.assertRaises((ValueError, RuntimeError)):
                    claim_recovery(self.data, self.config, inputs=inputs, intent=intent,
                                   trigger=source, capability=capability, now=NOW)
                self.assertEqual(encoded(self.data), before)
        altered_intent = {**intent, "normalized_inputs": recovery_inputs("second")}
        with self.assertRaises((ValueError, RuntimeError)):
            claim_recovery(self.data, self.config, inputs=first["inputs"], intent=altered_intent,
                           trigger=trigger("201"), capability=capability, now=NOW)
        self.assertEqual(encoded(self.data), before)
        self.assertEqual(pending_recovery(self.data, self.config), first)

    def test_other_workflow_executor_cannot_claim_report_recovery(self):
        first = self.queue()
        self.persist()
        intent, capability = self.reserve_receiver({}, workflow=CONTINUE)
        before = encoded(self.data)
        with self.assertRaises((ValueError, RuntimeError)):
            claim_recovery(self.data, self.config, inputs=first["inputs"], intent=intent,
                           trigger=trigger("201"), capability=capability, now=NOW)
        self.assertEqual(encoded(self.data), before)
        self.assertEqual(pending_recovery(self.data, self.config), first)

    def test_validator_requires_real_executor_identity_for_claimed_history(self):
        first = self.queue()
        self.persist()
        intent, capability = self.reserve_receiver(first["inputs"])
        claim_recovery(self.data, self.config, inputs=first["inputs"], intent=intent,
                       trigger=trigger("201"), capability=capability, now=NOW)
        original = copy.deepcopy(self.data)
        for field, replacement in (("executor_claim_id", "f" * 64), ("run_id", "999"),
                                   ("run_attempt", "2"), ("decision_id", "f" * 64)):
            with self.subTest(field=field):
                altered = copy.deepcopy(original)
                altered["controller"]["owner_recovery_requests"][0]["execution"][field] = replacement
                before = encoded(altered)
                self.assertTrue(validate_requests(altered))
                self.assertEqual(encoded(altered), before)

    def test_claimed_history_remains_valid_after_new_task_attempt(self):
        first = self.queue()
        self.persist()
        intent, capability = self.reserve_receiver(first["inputs"])
        claimed = claim_recovery(self.data, self.config, inputs=first["inputs"], intent=intent,
                                  trigger=trigger("201"), capability=capability, now=NOW)
        historical = copy.deepcopy(claimed)
        task = self.data["tasks"][0]
        old_request = copy.deepcopy(task["execution"]["research_request"])
        # A later failed/retried worker attempt must not reinterpret an already
        # executed owner command as authority over the replacement attempt.
        task["status"] = "todo"
        task["execution"].update(state="retry", outcome="failed")
        task["execution"].pop("report_error", None)
        task["execution"].pop("report_repair", None)
        complete(self.data, "unrelated", outcome="failed", now=NOW + timedelta(hours=1))
        add_attempt(self.data, task, "99", now=NOW + timedelta(hours=1))
        self.assertEqual(task["execution"]["attempts"], 2)
        self.assertEqual(task["execution"]["research_request_history"][0]["research_request"], old_request)
        self.assertEqual(self.records(), [historical])
        before = encoded(self.data)
        self.assertIsNone(pending_recovery(self.data, self.config))
        self.assertEqual(validate_requests(self.data), [])
        self.assertEqual(encoded(self.data), before)


class OwnerRecoveryResumeTests(unittest.TestCase):
    def fixture(self, *, complete_checkpoint=True):
        from failed_recovery_checkpoint_test import FailedRecoveryCheckpointTests
        fixture = FailedRecoveryCheckpointTests("runTest")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.prepare()
        if complete_checkpoint:
            fixture.complete()
        data = load_state(fixture.repo, fixture.store.manifest_path, fixture.store.revision_path)
        return fixture, data

    def test_only_observed_failure_allows_one_causal_resume_without_replacing_original_claim(self):
        fixture, data = self.fixture()
        original = copy.deepcopy(data["controller"]["owner_recovery_requests"][0])
        before = encoded(data)
        self.assertEqual(pending_recovery(data, fixture.config), original)
        self.assertEqual(encoded(data), before)
        with self.assertRaises(ValueError):
            claim_recovery(data, fixture.config, inputs=original["inputs"], intent=fixture.intent,
                           trigger=fixture.trigger("71"), capability=fixture.execution)
        intent, send = fixture.store.reserve_send(NEXT, original["inputs"],
            basis={"receipt_id": fixture.store.current()["completions"][fixture.intent["decision_id"]]["receipt_id"],
                   "health": {"owner_recovery": {"request_id": original["request_id"]}}},
            trigger=fixture.trigger("501"), control_sha=CONTROL)
        send.consume()
        _, capability = fixture.store.admit(NEXT, original["inputs"], key=intent["correlation_key"],
                                            trigger=fixture.trigger("502"), control_sha=CONTROL)
        capability.consume()
        data = load_state(fixture.repo, fixture.store.manifest_path, fixture.store.revision_path)
        resumed = claim_recovery(data, fixture.config, inputs=original["inputs"], intent=intent,
                                 trigger=fixture.trigger("502"), capability=capability)
        self.assertEqual(resumed["execution"], original["execution"])
        self.assertEqual({key: value for key, value in resumed.items() if key != "resume_execution"}, original)
        self.assertEqual(resumed["resume_execution"]["decision_id"], intent["decision_id"])
        fixture.store.save_manifest(data)
        self.assertIsNone(pending_recovery(data, fixture.config))
        consumed = encoded(data)
        self.assertIsNone(claim_recovery(data, fixture.config, inputs=original["inputs"], intent=intent,
                                        trigger=fixture.trigger("502"), capability=capability))
        self.assertEqual(encoded(data), consumed)
        for field in ("execution", "resume_execution"):
            altered = copy.deepcopy(data)
            del altered["controller"]["owner_recovery_requests"][0][field]
            with self.assertRaises(ValueError):
                fixture.store.save_manifest(altered)

    def test_unfinished_failed_execution_does_not_itself_authorize_resume(self):
        fixture, data = self.fixture(complete_checkpoint=False)
        self.assertIsNone(pending_recovery(data, fixture.config))
        original = copy.deepcopy(data["controller"]["owner_recovery_requests"][0])
        data["controller"]["owner_recovery_requests"][0]["resume_execution"] = original["execution"]
        self.assertTrue(validate_requests(data))
        with self.assertRaises(ValueError):
            fixture.store.save_manifest(data)


if __name__ == "__main__":
    unittest.main()
