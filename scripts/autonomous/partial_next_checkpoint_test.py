#!/usr/bin/env python3
"""Synthetic native source proof and disposable Git partial-failure conservation."""
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
from dispatch_journal import (NEXT, OWNER_PARTIAL_NEXT_CHECKPOINT, JournalConflict, JournalUncertain,
                              _body, _event, digest, materialize, normalize_inputs, validate_journal)
from next_no_effect_artifact_test import FailedCheckpointSource, zip_bytes
import owner_report_recovery_test as research_fixture
from partial_next_checkpoint import FAILURE_KIND, REF_GUARD_REASON, SUPPORTED_PRODUCER, receipt_id
from state_store import load_state
from research_cycle import plan_research, scope_fingerprints
from datetime import datetime, timezone
from validate_tasks import validate

PLANNER_CONFIG = {
    "product": {"editable_globs": ["src/**"], "excluded": [], "manual_review_paths": []},
    "research": {"enabled": True, "revisit_after_hours": 24, "max_sessions_per_day": 24,
                 "areas": [{"id": "synthetic", "title": "Synthetic", "paths": ["src/clock.ts"]}],
                 "perspectives": [{"id": "behavior", "title": "Behavior", "focus": ["quality"],
                                   "instruction": "Read-only synthetic investigation."}]},
}
CONFIG = {"repository": "synthetic/c-send", "merge_gate": {"owner_approvers": ["owner-a", "owner-b"]},
          **PLANNER_CONFIG}


def install_product(fixture, config):
    product = fixture.repo / "src" / "clock.ts"
    product.parent.mkdir(exist_ok=True)
    product.write_text("export const syntheticClock = 1;\n", encoding="utf-8")
    if hasattr(fixture, "config_path"):
        fixture.config_path.write_text(json.dumps(config), encoding="utf-8")
    fixture.git(fixture.repo, "add", ".")
    fixture.git(fixture.repo, "commit", "-m", "synthetic product tree")
    fixture.git(fixture.repo, "push", str(fixture.remote), "HEAD:refs/heads/autonomous/lab")
    return fixture.git(fixture.repo, "rev-parse", "HEAD")


def partial_body(data, config, repo):
    """No live payloads: one synthetic worker, one new unreserved planned task."""
    worker = data["tasks"][-1]
    execution = worker["execution"]
    source = {"session_id": execution["session_id"], "dispatch_key": execution["dispatch_key"],
              "activity_id": "sessions/" + execution["session_id"] + "/activities/synthetic-report",
              "activity_created_at": "2026-10-03T11:50:00Z", "report_sha256": "c" * 64}
    worker["status"] = "blocked"
    execution.update(state="awaiting_report", outcome="report_invalid", session_state="COMPLETED",
                     observed_at="2026-10-03T12:00:00Z",
                     note="completed worker report requires inspection: research_invalid",
                     report_error={"code": "research_invalid", "detail": "expected exactly one ordered research report block",
                                   "reported_at": "2026-10-03T12:00:00Z", "source": copy.deepcopy(source)},
                     report_repair={"at": "2026-10-03T12:00:08Z", "result": "sent", "status": "pending",
                                    "source": source})
    data["controller"]["last_poll_at"] = "2026-10-03T12:00:00Z"
    updated, planned = plan_research(data, config, scope_fingerprints(config, repo),
                                     now=datetime(2026, 10, 3, 12, tzinfo=timezone.utc),
                                     focus=[], risk_ceiling="medium")
    if not planned.get("research_changed"):
        raise AssertionError("synthetic native planner must append one task")
    data.clear()
    data.update(updated)
    return data


class PartialSource(FailedCheckpointSource):
    def set_report(self, report):
        super().set_report(report)
        if hasattr(self, "diagnostic_raw"):
            self.set_archive(zip_bytes(self.raw, extra=(self.diagnostic_name, self.diagnostic_raw)))

    def attach_diagnostic(self, task):
        import hashlib
        execution = task["execution"]
        diagnostic = {
            "task_id": task["id"], "session_id": execution["session_id"],
            "session_resource": "sessions/" + execution["session_id"],
            "dispatch_key": execution["dispatch_key"], "attempts": execution["attempts"],
            "collected_at": execution["observed_at"], "session_state": "COMPLETED",
            "source": copy.deepcopy(execution["report_error"]["source"]),
            "error_code": execution["report_error"]["code"],
            "research_parser": {"status": execution["report_error"]["code"],
                                "detail": execution["report_error"]["detail"]},
            "selection": {"status": "ok", "detail": "latest worker report selected"},
            "outcome": "report_invalid", "worker_report": "Synthetic diagnostic must not be retained",
        }
        self.diagnostic_raw = (json.dumps(diagnostic, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        self.diagnostic_name = ("research-diagnostics/" + hashlib.sha256(task["id"].encode("utf-8")).hexdigest()
                                + "-" + str(execution["attempts"]) + "-" + diagnostic["source"]["report_sha256"]
                                + "-" + hashlib.sha256(self.diagnostic_raw).hexdigest() + ".json")
        self.set_report(self.report)


def native_source(intent, pin, *, task, repository=CONFIG["repository"], actor="owner-a"):
    source = PartialSource()
    for run in (source.run, source.attempt):
        run.update(head_sha=SUPPORTED_PRODUCER, display_title="Next " + intent["correlation_key"])
        for field in ("repository", "head_repository"):
            run[field]["full_name"] = repository
        for field in ("actor", "triggering_actor"):
            run[field]["login"] = actor
    source.jobs[0]["head_sha"] = SUPPORTED_PRODUCER
    source.artifacts[0]["workflow_run"]["head_sha"] = SUPPORTED_PRODUCER
    source.set_report({"action": "stopped", "merge_mode": "manual", "reason": "controller_error",
                       "attention": [{"reason": REF_GUARD_REASON}], "state_sha": pin})
    source.attach_diagnostic(task)
    return source


class PartialCheckpointTests(unittest.TestCase):
    git = journal_fixture.JournalTests.git
    reader = journal_fixture.JournalTests.reader

    def trigger(self, run="10", attempt="1"):
        return {**journal_fixture.JournalTests.trigger(self, run, attempt), "control_sha": SUPPORTED_PRODUCER}

    def setUp(self):
        journal_fixture.JournalTests.setUp(self)
        self.config = copy.deepcopy(CONFIG)
        base = install_product(self, self.config)
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        with patch.object(research_fixture, "BASE", base):
            data.update(research_fixture.research_manifest())
        self.store.save_manifest(data)

    def prepare(self, *, control=SUPPORTED_PRODUCER, attempt="1", inputs=None, partial=True):
        command = normalize_inputs(NEXT, {"automatic": True} if inputs is None else inputs)
        trigger = {**self.trigger(), "control_sha": control}
        self.intent, send = self.store.reserve_send(NEXT, command, basis={}, trigger=trigger, control_sha=control)
        send.consume()
        _, self.execution = self.store.admit(NEXT, command, key=self.intent["correlation_key"],
                                             trigger={**trigger, "run_id": "71", "run_attempt": attempt},
                                             control_sha=control)
        self.execution.consume()
        self.store.observe_delivery(self.intent["decision_id"], {"kind": "synthetic original delivery"})
        data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        if partial:
            partial_body(data, self.config, self.repo)
            self.store.save_manifest(data)
        self.pin = self.store.current()["state_sha"]
        self.data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.owner = {**self.trigger("500"), "control_sha": "b" * 40, "workflow": OWNER_PARTIAL_NEXT_CHECKPOINT,
                      "ref": "refs/heads/main", "decision_id": self.intent["decision_id"],
                      "expected_state_sha": self.pin}
        source_data = (self.data if partial else partial_body(copy.deepcopy(self.data), self.config, self.repo))
        self.source = native_source(self.intent, self.pin, task=source_data["tasks"][-2])

    def complete(self, *, owner=None, pin=None, store=None, config=None, decision=None):
        with ExitStack() as stack:
            stack.enter_context(patch.object(artifact, "_default_json", side_effect=lambda repository, endpoint:
                                             self.source.get_json(endpoint)))
            stack.enter_context(patch.object(artifact, "_default_archive", side_effect=lambda repository, endpoint:
                                             self.source.get_archive(endpoint)))
            return (store or self.store).complete_partial_next_checkpoint(
                decision_id=decision or self.intent["decision_id"], expected_state_sha=self.pin if pin is None else pin,
                owner_trigger=self.owner if owner is None else owner, config=self.config if config is None else config)

    def authoritative_bytes(self):
        return state_store._git(self.remote, "show", "refs/heads/autonomous/state:agent_tasks.json").stdout

    def rejected(self, **kwargs):
        before = self.authoritative_bytes()
        pin = self.git(self.remote, "rev-parse", "refs/heads/autonomous/state")
        with self.assertRaises((JournalConflict, ValueError)):
            self.complete(**kwargs)
        self.assertEqual(self.authoritative_bytes(), before)
        self.assertEqual(self.git(self.remote, "rev-parse", "refs/heads/autonomous/state"), pin)

    def publish(self, data, *, parent=None):
        sha = state_store._commit(self.repo, (json.dumps(data) + "\n").encode(), parent or self.pin)
        self.git(self.repo, "push", "--force-with-lease=refs/heads/autonomous/state:" + self.pin,
                 "origin", sha + ":refs/heads/autonomous/state")
        self.pin = sha
        self.owner["expected_state_sha"] = sha
        self.source.set_report({**self.source.report, "state_sha": sha})
        return sha

    def case(self):
        case = self.__class__("runTest")
        case.setUp()
        self.addCleanup(case.doCleanups)
        return case

    def test_one_cas_retains_every_body_history_original_executor_and_failed_partial_truth(self):
        self.prepare()
        previous = copy.deepcopy(self.data)
        old = materialize(previous["dispatch_journal"])
        with patch.object(self.store, "_write", wraps=self.store._write) as writes:
            result = self.complete()
        self.assertEqual(writes.call_count, 1)
        self.assertEqual((result["outcome"], result["kind"]), ("completed", FAILURE_KIND))
        saved = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        state = materialize(saved["dispatch_journal"])
        self.assertEqual(_body(saved), _body(previous))
        self.assertEqual(saved["dispatch_journal"]["events"][:-1], previous["dispatch_journal"]["events"])
        for field in ("intents", "send_claims", "executor_claims", "effects", "phase_claims", "stages"):
            self.assertEqual(state[field], old[field])
        receipt = state["completions"][self.intent["decision_id"]]
        self.assertEqual(receipt["type"], "OwnerPartialNextCheckpointCompletion")
        self.assertEqual(receipt["native_report"], self.source.report)
        self.assertEqual(receipt["evidence"]["status"], "failed_with_partial_checkpoints")
        self.assertEqual(receipt["evidence"]["external_effects"], "not_presumed_absent")
        self.assertEqual(receipt["evidence"]["delta"]["repair_result"], "sent")
        self.assertEqual(receipt["evidence"]["delta"]["polled_task_id"], previous["tasks"][-2]["id"])
        self.assertEqual(receipt["evidence"]["delta"]["planned_task_id"], previous["tasks"][-1]["id"])
        self.assertIsNone(state["active_intent"])
        self.assertEqual(state["frontier_seq"], old["frontier_seq"] + 1)
        self.assertEqual(validate(saved), [])
        for attempt in ("1", "2"):
            reader = self.reader("late-" + attempt)
            _, capability = reader.admit(NEXT, self.intent["normalized_inputs"], key=self.intent["correlation_key"],
                                         trigger=self.trigger("71", attempt), control_sha=SUPPORTED_PRODUCER)
            self.assertIsNone(capability)
        with self.assertRaises(JournalConflict):
            self.execution.observer_context()

    def test_protected_identity_other_tasks_controller_history_and_unreserved_shape_are_structural(self):
        for change in ("session", "base", "request", "decision", "history", "other_task", "clock", "task_order",
                       "task_removal", "added_execution", "added_approval", "repair", "source", "note", "root"):
            with self.subTest(change=change):
                case = self.case()
                case.prepare()
                changed = copy.deepcopy(case.data)
                worker = changed["tasks"][-2]
                if change == "session":
                    worker["execution"]["session_id"] = "foreign"
                elif change == "base":
                    worker["execution"]["base_sha"] = "f" * 40
                elif change == "request":
                    worker["execution"]["research_request"]["request_sha256"] = "f" * 64
                elif change == "decision":
                    worker["proposal_decision"] = {"action": "approve", "actor": "owner-a"}
                elif change == "history":
                    changed["history"].append({"event": "forbidden edit"})
                elif change == "other_task":
                    changed["tasks"][0]["title"] = "Changed unrelated task"
                elif change == "clock":
                    changed["controller"]["last_tick_at"] = "2026-10-03T12:00:00Z"
                elif change == "task_order":
                    changed["tasks"][:2] = reversed(changed["tasks"][:2])
                elif change == "task_removal":
                    changed["tasks"].pop(0)
                elif change == "added_execution":
                    changed["tasks"][-1]["execution"] = {"attempts": 0}
                elif change == "added_approval":
                    changed["tasks"][-1]["proposal_decision"] = {"action": "approve"}
                elif change == "repair":
                    worker["execution"]["report_repair"]["result"] = "unknown"
                elif change == "source":
                    worker["execution"]["report_repair"]["source"]["activity_id"] = "sessions/foreign/activities/report"
                elif change == "note":
                    worker["execution"]["note"] = "Unrelated rewritten note"
                else:
                    changed["unrelated_policy"] = True
                case.publish(changed)
                case.rejected()

    def test_same_shape_new_task_must_equal_complete_native_planner_record_and_context(self):
        for field in ("title", "focus", "target_paths", "detail", "previous_reports", "fingerprint", "cycle", "created_at"):
            with self.subTest(field=field):
                case = self.case()
                case.prepare()
                changed = copy.deepcopy(case.data)
                added = changed["tasks"][-1]
                if field == "title":
                    added["title"] = "Arbitrary same-shape title"
                elif field == "focus":
                    added["focus"] = ["performance"]
                elif field == "target_paths":
                    added["target_paths"] = ["src/other.ts"]
                elif field == "detail":
                    added["evidence"]["detail"] = "Arbitrary same-shape instruction"
                elif field == "previous_reports":
                    added["research"]["previous_reports"] = [{"summary": "Unrelated synthetic context",
                        "observations": [{"scenario": "Synthetic", "evidence": "Synthetic", "result": "Synthetic"}],
                        "next_hypotheses": [], "proposed_task_ids": [], "completed_at": "2026-10-02T12:00:00Z"}]
                elif field == "fingerprint":
                    added["research"]["fingerprint"] = "e" * 64
                elif field == "cycle":
                    added["research"]["cycle"] += 1
                    added["id"] = "research-synthetic-behavior-" + str(added["research"]["cycle"])
                else:
                    added["created_at"] = "2026-10-03T11:59:59Z"
                case.publish(changed)
                case.rejected()

    def test_native_diagnostic_binds_fixed_error_source_identity_and_unsubstituted_clock(self):
        for field in ("task", "attempt", "code", "detail", "observed_at", "source_at", "source_hash"):
            with self.subTest(field=field):
                case = self.case()
                case.prepare()
                forged = copy.deepcopy(case.data["tasks"][-2])
                execution = forged["execution"]
                if field == "task":
                    forged["id"] = "foreign-worker"
                elif field == "attempt":
                    execution["attempts"] += 1
                elif field == "code":
                    execution["report_error"]["code"] = "research_json"
                elif field == "detail":
                    execution["report_error"]["detail"] = "Arbitrary worker exception"
                elif field == "observed_at":
                    execution["observed_at"] = "2026-10-03T12:00:01Z"
                elif field == "source_at":
                    execution["report_error"]["source"]["activity_created_at"] = "2026-10-03T11:49:59Z"
                else:
                    execution["report_error"]["source"]["report_sha256"] = "e" * 64
                case.source.attach_diagnostic(forged)
                case.rejected()

    def test_exact_original_producer_attempt_inputs_and_current_native_pin_are_required(self):
        for control, attempt, inputs in (("c" * 40, "1", {"automatic": True}),
                                        (SUPPORTED_PRODUCER, "2", {"automatic": True}),
                                        (SUPPORTED_PRODUCER, "1", {"automatic": False}),
                                        (SUPPORTED_PRODUCER, "1", {"automatic": True, "focus": "quality"})):
            case = self.case()
            case.prepare(control=control, attempt=attempt, inputs=inputs)
            case.rejected()
            self.assertEqual(case.source.calls, [])
        self.prepare()
        pin = self.pin
        self.source.set_report({**self.source.report, "state_sha": "f" * 40})
        self.rejected()
        self.source.set_report({**self.source.report, "state_sha": pin})
        self.rejected(pin="e" * 40, owner={**self.owner, "expected_state_sha": "e" * 40})

    def test_full_lineage_prefix_original_executor_and_no_competing_event(self):
        for change in ("lineage", "prefix", "delivery", "effect", "completion", "stage", "phase"):
            with self.subTest(change=change):
                case = self.case()
                case.prepare()
                changed = copy.deepcopy(case.data)
                if change == "lineage":
                    case.publish(changed, parent=case.initial)
                elif change == "prefix":
                    changed["dispatch_journal"]["events"][0]["basis"]["state_sha"] = "e" * 40
                    event = changed["dispatch_journal"]["events"][0]
                    event["event_id"] = digest({k: v for k, v in event.items() if k != "event_id"})
                    case.publish(changed)
                else:
                    kind = {"delivery": "DeliveryObservation", "effect": "EffectObservation",
                            "completion": "ExecutionCompletion", "stage": "ExecutionStage", "phase": "PhaseClaim"}[change]
                    changed["dispatch_journal"]["events"].append(_event(kind, decision_id=case.intent["decision_id"],
                                                                         observation={"kind": "competing"}))
                    case.publish(changed)
                case.rejected()

    def test_noop_or_nonpartial_body_and_old_failed_save_are_not_adopted(self):
        self.prepare(partial=False)
        self.rejected()
        case = self.case()
        case.prepare()
        case.source.set_report({**case.source.report, "reason": "state_write_failed", "attention": [
            {"reason": "state save failed; reload the authoritative queue before continuing"}]})
        case.rejected()
        for reader in (artifact.authenticated_next_no_effect, artifact.authenticated_failed_save_checkpoint):
            with self.assertRaises(ValueError):
                reader(CONFIG["repository"], self.trigger("71"), self.intent["decision_id"], self.intent["correlation_key"],
                       get_json=self.source.get_json, get_archive=self.source.get_archive)

    def test_artifact_run_actor_repository_job_digest_envelope_and_exact_reason_are_authenticated(self):
        for change in ("run", "actor", "repository", "job", "digest", "zip", "member", "missing_diagnostic",
                       "diagnostic_name", "reason", "attention", "extra"):
            with self.subTest(change=change):
                case = self.case()
                case.prepare()
                if change == "run":
                    case.source.artifacts[0]["workflow_run"]["id"] = 72
                elif change == "actor":
                    case.source.attempt["triggering_actor"]["login"] = "foreign"
                elif change == "repository":
                    case.source.run["repository"]["full_name"] = "foreign/repository"
                elif change == "job":
                    case.source.jobs[0]["head_sha"] = "f" * 40
                elif change == "digest":
                    case.source.detail["digest"] = "sha256:" + "f" * 64
                elif change == "zip":
                    case.source.set_archive(b"not a ZIP")
                elif change == "member":
                    case.source.set_archive(zip_bytes(case.source.raw, extra=("unexpected.json", b"{}")))
                elif change == "missing_diagnostic":
                    case.source.set_archive(zip_bytes(case.source.raw))
                elif change == "diagnostic_name":
                    name = case.source.diagnostic_name[:-69] + "e" * 64 + ".json"
                    case.source.set_archive(zip_bytes(case.source.raw, extra=(name, case.source.diagnostic_raw)))
                elif change == "reason":
                    case.source.set_report({**case.source.report, "reason": "other_error"})
                elif change == "attention":
                    case.source.set_report({**case.source.report, "attention": [{"reason": "arbitrary exception"}]})
                else:
                    case.source.set_report({**case.source.report, "effect_receipt_id": "f" * 64})
                case.rejected()

    def test_exact_owner_replay_is_read_only_and_second_distinct_completion_is_rejected(self):
        self.prepare()
        first = self.complete()
        before, reads = self.authoritative_bytes(), len(self.source.calls)
        reader = self.reader("replay")
        with patch.object(reader, "_write", side_effect=AssertionError("replay cannot write")):
            for owner in (self.owner, {**self.owner, "run_attempt": "2"}):
                result = self.complete(owner=owner, store=reader)
                self.assertEqual(result, {**first, "outcome": "already_completed"})
        self.assertEqual((self.authoritative_bytes(), len(self.source.calls)), (before, reads))
        for override in ({"run_id": "501"}, {"actor": "owner-b"}, {"control_sha": "c" * 40},
                         {"workflow": "autonomous_complete_next.yml"}):
            self.rejected(owner={**self.owner, **override})
        self.rejected(pin=first["state_sha"], owner={**self.owner, "expected_state_sha": first["state_sha"]})
        self.assertEqual(sum(event["type"] == "OwnerPartialNextCheckpointCompletion" for event in
                             json.loads(before)["dispatch_journal"]["events"]), 1)

    def test_lost_ack_never_reapplies_and_native_pending_source_grants_nothing(self):
        self.prepare()
        original_git = state_store._git
        pushes = []
        def lose_ack(repo, *args, **kwargs):
            result = original_git(repo, *args, **kwargs)
            if "push" in args:
                pushes.append(1)
                raise subprocess.TimeoutExpired("synthetic lost push ACK", 90)
            return result
        with patch.object(state_store, "_git", side_effect=lose_ack):
            with self.assertRaises(JournalUncertain):
                self.complete()
        self.assertEqual(len(pushes), 1)
        saved = self.authoritative_bytes()
        with patch.object(self.store, "_write", side_effect=AssertionError("lost ACK replay cannot write")):
            result = self.complete(owner={**self.owner, "run_attempt": "2"})
        self.assertEqual(result["outcome"], "already_completed")
        self.assertEqual(self.authoritative_bytes(), saved)
        case = self.case()
        case.prepare()
        case.source.run["status"] = "in_progress"
        case.source.run["conclusion"] = None
        case.rejected()

    def test_cas_race_has_no_retry_and_preserves_competitor(self):
        self.prepare()
        competitor = self.reader("competitor")
        original_write = self.store._write
        def race(data):
            competitor.observe_delivery(self.intent["decision_id"], {"kind": "competitor must survive"})
            return original_write(data)
        with patch.object(self.store, "_write", side_effect=race) as writes:
            with self.assertRaises(JournalConflict):
                self.complete()
        self.assertEqual(writes.call_count, 1)
        saved = json.loads(self.authoritative_bytes())
        self.assertEqual(_body(saved), _body(self.data))
        self.assertEqual(saved["dispatch_journal"]["events"][-1]["observation"],
                         {"kind": "competitor must survive"})
        self.assertNotIn(self.intent["decision_id"], materialize(saved["dispatch_journal"])["completions"])

    def test_rehashed_receipt_cannot_launder_failure_as_no_effect_or_change_native_context(self):
        self.prepare()
        self.complete()
        saved = json.loads(self.authoritative_bytes())
        for change in ("kind", "status", "external_effects", "native", "producer", "frontier", "extra", "delta"):
            with self.subTest(change=change):
                journal = copy.deepcopy(saved["dispatch_journal"])
                event = journal["events"][-1]
                if change == "kind":
                    event["kind"] = "next_no_effect"
                elif change == "status":
                    event["evidence"]["status"] = "no_effect"
                elif change == "external_effects":
                    event["evidence"]["external_effects"] = "absent"
                elif change == "native":
                    event["native_report"]["reason"] = "state_write_failed"
                elif change == "producer":
                    event["proof"]["producer"]["control_sha"] = "f" * 40
                elif change == "frontier":
                    event["frontier_seq"] += 1
                elif change == "extra":
                    event["execute_again"] = True
                else:
                    event["evidence"]["delta"]["repair_result"] = "not_sent"
                event["receipt_id"] = receipt_id(event)
                event["event_id"] = digest({k: v for k, v in event.items() if k != "event_id"})
                self.assertTrue(validate_journal(journal))


if __name__ == "__main__":
    unittest.main()
