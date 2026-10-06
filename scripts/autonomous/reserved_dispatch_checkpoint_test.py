#!/usr/bin/env python3
"""Original reserved NEXT recovery against isolated Git state and GET-only providers."""
from __future__ import annotations

import copy
import json
import subprocess
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import dispatch_journal as journal
import dispatch_journal_test as journal_fixture
import dispatch_recovery
import next_no_effect_artifact as artifact
import state_store
from build_jules_request import build, dispatch_key
from dispatch_journal import (CONTINUE, NEXT, JournalConflict, JournalUncertain, _body,
                              _reserved_dispatch_receipt, digest, materialize, substantive_digest, validate_journal)
from dispatch_recovery_test import API_BASE, NOW, PRIMARY, Transport, page, provider_session
from jules_dispatch import Response
from next_no_effect_artifact_test import FailedCheckpointSource
from research_request import CONTRACT_VERSION, sha256_json, snapshot
from state_store import load_state
from task_lifecycle import reserve
from validate_tasks import validate

CONTROL = journal_fixture.CONTROL
CONFIG = {"repository": "synthetic/c-send",
          "merge_gate": {"owner_approvers": ["owner-a", "owner-b"]}}
TARGET = "synthetic-research"
STATE_REF = "refs/heads/autonomous/state"
PRIVATE_SENTINELS = (PRIMARY, "SYNTHETIC_PRIVATE_TITLE", "SYNTHETIC_PRIVATE_REQUEST",
                     "SYNTHETIC_PRIVATE_WORKER_PROSE")


class GetTransport(Transport):
    """Only synthetic responses are injected; the real observer authenticates them."""
    def __init__(self, responses, after_get=None):
        super().__init__(responses)
        self.after_get = after_get

    def __call__(self, method, url, headers, payload):
        if method != "GET" or payload is not None:
            raise AssertionError("reserved recovery must never create or message a session")
        response = super().__call__(method, url, headers, payload)
        if {key.lower(): value for key, value in headers.items()}.get("x-goog-api-key") != PRIMARY:
            raise AssertionError("provider observation must use the real key ring")
        if self.after_get is not None and "/sessions/" in url:
            callback, self.after_get = self.after_get, None
            callback()
        if isinstance(response, Exception):
            raise response
        return response


class ReservedDispatchCheckpointTests(unittest.TestCase):
    # Reuse the isolated repo/remote setup, not JournalTests' inherited test suite.
    git = journal_fixture.JournalTests.git
    reader = journal_fixture.JournalTests.reader
    trigger = journal_fixture.JournalTests.trigger

    def setUp(self):
        clock = patch.object(journal, "_now", return_value=NOW.isoformat().replace("+00:00", "Z"))
        clock.start()
        self.addCleanup(clock.stop)
        journal_fixture.JournalTests.setUp(self)
        self.config = copy.deepcopy(CONFIG)
        self.data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.data.update(version=CONTRACT_VERSION,
                         autonomous_loop_policy={"research_contract": CONTRACT_VERSION,
                                                 "integration_branch": "autonomous/lab"},
                         controller={"last_tick_at": "2026-10-06T10:00:00Z",
                                     "last_poll_at": "2026-10-06T10:01:00Z", "run_id": "70"})
        self.store.save_manifest(self.data)

    def new_task(self, task_id=TARGET):
        return {"id": task_id, "title": "SYNTHETIC_PRIVATE_TITLE", "task_type": "project_discovery",
                "status": "todo", "priority": 40, "risk": "low", "focus": ["quality"],
                "target_paths": ["src/synthetic.ts"],
                "evidence": {"source": "research_cycle", "detail": "SYNTHETIC_PRIVATE_REQUEST"},
                "execution": {"attempts": 0, "history": [], "research_request_history": []}}

    def reserve_task(self, data, task):
        key = dispatch_key(CONFIG["repository"], task["id"], 1)
        branch = "autonomous/attempt-" + key
        base = self.git(self.repo, "rev-parse", "HEAD")
        request = build(task, template="{{TASK_JSON}}", repo=CONFIG["repository"],
                        branch="autonomous/lab", starting_branch=branch, base_sha=base,
                        attempt=1, decision_context=[])
        reserve(data, task["id"], key, base_sha=base, starting_branch=branch,
                research_request=snapshot(request, [], CONTROL), now=NOW)

    def prepare(self, *, before_target="absent", inputs=None, preexisting=False):
        if before_target == "todo":
            self.data["tasks"].append(self.new_task())
        elif before_target != "absent":
            raise AssertionError("unknown fixture baseline")
        if preexisting:
            old = self.new_task("synthetic-old")
            self.data["tasks"].append(old)
            self.reserve_task(self.data, old)
        self.store.save_manifest(self.data)
        self.intent, self.send = self.store.reserve_send(
            NEXT, {"automatic": True} if inputs is None else inputs, basis={},
            trigger=self.trigger("10"), control_sha=CONTROL)
        self.send.consume()
        _, self.execution = self.store.admit(
            NEXT, self.intent["normalized_inputs"], key=self.intent["correlation_key"],
            trigger=self.trigger("71"), control_sha=CONTROL)
        self.execution.consume()
        self.data = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        self.before_state = self.store.current()
        self.executor = self.before_state["executor_claims"][self.intent["decision_id"]]
        self.before = self.checkpoint(self.executor["before_state_sha"])
        if not preexisting:
            if before_target == "absent":
                self.data["tasks"].append(self.new_task())
            self.reserve_task(self.data, self.target(self.data))
        self.pin = self.store.save_manifest(self.data)
        self.native_sha = self.pin
        self.native = copy.deepcopy(self.data)
        self.owner = self.owner_trigger(journal.OWNER_DISPATCH_BINDING)
        self.source = FailedCheckpointSource()
        for run in (self.source.run, self.source.attempt):
            run["display_title"] = "Next " + self.intent["correlation_key"]
            run["repository"]["full_name"] = CONFIG["repository"]
            run["head_repository"]["full_name"] = CONFIG["repository"]
            run["actor"]["login"] = "owner-a"
            run["triggering_actor"]["login"] = "owner-a"
        self.set_report_pin(self.native_sha)
        self.session = provider_session(self.target(self.native, "synthetic-old" if preexisting else TARGET))
        self.provider = self.provider_transport()

    def target(self, data, task_id=TARGET):
        return next(task for task in data["tasks"] if task["id"] == task_id)

    def checkpoint(self, sha):
        return json.loads(state_store._git(self.repo, "show", sha + ":agent_tasks.json").stdout)

    def owner_trigger(self, workflow):
        return {**self.trigger("500"), "control_sha": "b" * 40, "workflow": workflow,
                "ref": "refs/heads/main", "decision_id": self.intent["decision_id"],
                "expected_state_sha": self.pin}

    def set_report_pin(self, pin):
        self.source.set_report({"action": "stopped", "merge_mode": "manual", "reason": "state_write_failed",
                                "attention": [{"reason": "state save failed; reload the authoritative queue before continuing"}],
                                "state_sha": pin})

    def provider_transport(self, responses=None, after_get=None):
        if responses is None:
            responses = [page(copy.deepcopy(self.session)), Response(200, copy.deepcopy(self.session))]
        return GetTransport(responses, after_get=after_get)

    def transport(self):
        # Replace only external GET transport. Keep artifact authentication and Git reads real.
        stack = ExitStack()
        stack.enter_context(patch.object(artifact, "_default_json", side_effect=self.source_json))
        stack.enter_context(patch.object(artifact, "_default_archive", side_effect=self.source_archive))
        stack.enter_context(patch.object(dispatch_recovery, "utcnow", return_value=NOW))
        return stack

    def source_json(self, repository, endpoint):
        self.assertEqual(repository, CONFIG["repository"])
        return self.source.get_json(endpoint)

    def source_archive(self, repository, endpoint):
        self.assertEqual(repository, CONFIG["repository"])
        return self.source.get_archive(endpoint)

    def owner_command(self, *, observe=False, owner=None, pin=None, store=None,
                      config=None, decision_id=None, provider=None):
        workflow = journal.OWNER_DISPATCH_OBSERVATION if observe else journal.OWNER_DISPATCH_BINDING
        trigger = {**self.owner, "workflow": workflow} if owner is None else owner
        with self.transport():
            method = ((store or self.store).observe_reserved_dispatch if observe
                      else (store or self.store).bind_reserved_dispatch)
            return method(decision_id=self.intent["decision_id"] if decision_id is None else decision_id,
                          expected_state_sha=self.pin if pin is None else pin, owner_trigger=trigger,
                          config=self.config if config is None else config, api_keys=[PRIMARY],
                          transport=self.provider if provider is None else provider, api_base=API_BASE)

    def authoritative(self):
        sha = self.git(self.remote, "rev-parse", STATE_REF)
        raw = state_store._git(self.remote, "show", STATE_REF + ":agent_tasks.json").stdout
        return sha, raw

    def raw_commit(self, data, *, parent=None, publish=False):
        # Negative ancestry/body fixtures are genuine objects; no checkpoint getter is mocked.
        parent = self.pin if parent is None else parent
        sha = state_store._commit(self.repo, (json.dumps(data, sort_keys=True) + "\n").encode(), parent)
        if publish:
            self.git(self.repo, "push", "--force-with-lease=" + STATE_REF + ":" + self.pin,
                     "origin", sha + ":" + STATE_REF)
            self.pin = sha
            self.owner["expected_state_sha"] = sha
        return sha

    def reset_native(self, *, parent=None):
        self.raw_commit(self.native, parent=parent, publish=True)
        self.set_report_pin(self.native_sha)
        self.provider = self.provider_transport()

    def assert_get_only(self, provider=None):
        provider = self.provider if provider is None else provider
        self.assertTrue(all(call["method"] == "GET" and call["payload"] is None for call in provider.calls))
        self.assertFalse(any(call["method"] == "POST" for call in provider.calls))

    def assert_private(self, value):
        rendered = json.dumps(value, sort_keys=True)
        for sentinel in PRIVATE_SENTINELS:
            self.assertNotIn(sentinel, rendered)
        self.assertNotIn(self.session["prompt"], rendered)

    def assert_rejected_unchanged(self, **arguments):
        before = self.authoritative()
        with patch.object(self.store, "_write", wraps=self.store._write) as write:
            with self.assertRaises((JournalConflict, ValueError, RuntimeError)) as caught:
                self.owner_command(**arguments)
        self.assertEqual(write.call_count, 0)
        self.assertEqual(self.authoritative(), before)
        for sentinel in PRIVATE_SENTINELS:
            self.assertNotIn(sentinel, str(caught.exception))
        self.assert_get_only(arguments.get("provider"))

    def assert_original_lineage(self):
        self.assertEqual(self.executor["before_digest"], substantive_digest(self.before))
        for old, new in ((self.executor["before_state_sha"], self.native_sha), (self.native_sha, self.pin)):
            self.assertEqual(state_store._git(self.repo, "merge-base", "--is-ancestor", old, new,
                                             check=False).returncode, 0)
        self.assertEqual(self.native["dispatch_journal"]["events"][:len(self.before["dispatch_journal"]["events"])],
                         self.before["dispatch_journal"]["events"])
        native_state = materialize(self.native["dispatch_journal"])
        self.assertEqual(native_state["active_intent"], self.intent)
        self.assertEqual(native_state["executor_claims"][self.intent["decision_id"]], self.executor)
        self.assertEqual(native_state["frontier_seq"], 0)
        self.assertEqual(native_state["completions"], {})
        self.assertEqual(native_state["effects"], {})
        self.assertEqual(self.source.report["state_sha"], self.native_sha)
        self.assertEqual(_body(self.checkpoint(self.native_sha)), _body(self.native))
        self.assertEqual(self.native["dispatch_journal"], self.checkpoint(self.native_sha)["dispatch_journal"])
        self.assertEqual(_body(self.checkpoint(self.pin)), _body(self.native))
        execution = self.target(self.native)["execution"]
        self.assertEqual((execution["state"], execution["session_id"], execution["attempts"]),
                         ("dispatching", "", 1))
        self.assertEqual(execution["research_request"]["controller_sha"], CONTROL)
        self.assertEqual(validate(self.before), [])
        self.assertEqual(validate(self.native), [])

    def test_get_observation_preserves_entire_body_journal_history_and_remote(self):
        self.prepare()
        self.assert_original_lineage()
        before = self.authoritative()
        original_git = state_store._git
        pushes = []
        def record_git(repo, *args, **kwargs):
            if "push" in args:
                pushes.append(args)
            return original_git(repo, *args, **kwargs)
        with patch.object(state_store, "_git", side_effect=record_git), \
                patch.object(self.store, "_write", wraps=self.store._write) as write:
            observed = self.owner_command(observe=True)
        self.assertEqual(write.call_count, 0)
        self.assertEqual(pushes, [])
        self.assertEqual(self.authoritative(), before)
        self.assertEqual(set(observed), {"outcome", "decision_id", "state_sha", "frontier_seq", "identity",
                                         "provider_proof", "native_proof", "native_report"})
        self.assertEqual((observed["outcome"], observed["state_sha"], observed["frontier_seq"]),
                         ("observed", self.pin, 0))
        self.assertEqual(observed["native_report"], self.source.report)
        self.assertEqual(observed["native_proof"]["producer"], self.executor["trigger"])
        self.assertEqual(observed["identity"]["research_request_sha256"],
                         sha256_json(self.target(self.native)["execution"]["research_request"]))
        self.assertEqual(observed["provider_proof"]["session_sha256"], sha256_json(self.session))
        self.assertEqual(observed["provider_proof"]["list_session_sha256"], sha256_json(self.session))
        self.assertEqual(len(self.provider.calls), 2)
        self.assertTrue(self.source.calls)
        self.assertEqual(self.source.downloads, ["actions/artifacts/301/zip"])
        self.assert_get_only()
        self.assert_private(observed)

    def test_bind_changes_only_original_execution_identity_and_one_typed_frontier_event(self):
        self.prepare()
        self.assert_original_lineage()
        before = copy.deepcopy(self.native)
        old = self.store.current()
        original_git = state_store._git
        pushes = []
        def record_git(repo, *args, **kwargs):
            if "push" in args:
                pushes.append(args)
            return original_git(repo, *args, **kwargs)
        with patch.object(state_store, "_git", side_effect=record_git), \
                patch.object(self.store, "_write", wraps=self.store._write) as write:
            result = self.owner_command()
        self.assertEqual(write.call_count, 1)
        self.assertEqual(len(pushes), 1)
        self.assertEqual(result["outcome"], "bound")
        after = load_state(self.repo, self.store.manifest_path, self.store.revision_path)
        expected = copy.deepcopy(_body(before))
        self.target(expected)["execution"].update(state="dispatched", session_id=self.session["id"])
        self.assertEqual(_body(after), expected,
                         "binding must preserve clocks/status/attempts/results/requests/history exactly")
        self.assertEqual(after["dispatch_journal"]["events"][:-1], before["dispatch_journal"]["events"])
        event = after["dispatch_journal"]["events"][-1]
        self.assertEqual((event["type"], event["kind"]), ("OwnerDispatchRecovery", "reserved_dispatch_bound"))
        self.assertEqual(event["before_state_sha"], self.pin)
        self.assertEqual(event["before_digest"], substantive_digest(before))
        self.assertEqual(event["after_digest"], substantive_digest(after))
        self.assertEqual(event["evidence"]["checkpoint_digest"], substantive_digest(before))
        self.assertEqual(event["native_report"], self.source.report)
        self.assertEqual(event["proof"]["producer"], self.executor["trigger"])
        self.assertEqual(event["executor_claim_id"], self.executor["claim_id"])
        self.assertEqual(event["evidence"]["status"], "bound_existing_session")
        self.assertEqual(event["evidence"]["reason"], "state_write_failed")
        self.assertEqual(event["evidence"]["before_state_sha"], self.executor["before_state_sha"])
        self.assertEqual(event["evidence"]["after_state_sha"], self.native_sha)
        self.assertEqual(event["evidence"]["before_digest"], substantive_digest(self.before))
        self.assertEqual(event["evidence"]["after_digest"], substantive_digest(after))
        current = self.store.current()
        self.assertEqual(current["completions"][self.intent["decision_id"]], event)
        self.assertIsNone(current["active_intent"])
        self.assertEqual(current["frontier_seq"], old["frontier_seq"] + 1)
        self.assertEqual(current["predecessor_decision_id"], self.intent["decision_id"])
        for field in ("intents", "send_claims", "executor_claims", "effects", "phase_claims", "stages"):
            self.assertEqual(current[field], old[field])
        self.assertEqual(result["receipt_id"], event["receipt_id"])
        self.assertEqual(result["state_sha"], current["state_sha"])
        self.assertEqual(validate(after), [])
        self.assertEqual(len(self.provider.calls), 2)
        self.assert_get_only()
        self.assert_private(result)
        self.assert_private(event)

    def test_failed_original_provider_session_is_bound_without_reporting_success_or_spending_attempt(self):
        self.prepare()
        self.session["state"] = "FAILED"
        self.provider = self.provider_transport()
        result = self.owner_command()
        after = self.checkpoint(result["state_sha"])
        expected = copy.deepcopy(_body(self.native))
        self.target(expected)["execution"].update(state="dispatched", session_id=self.session["id"])
        self.assertEqual(_body(after), expected)
        event = after["dispatch_journal"]["events"][-1]
        self.assertEqual(event["provider_proof"]["session_state"], "FAILED")
        self.assertEqual(self.target(after)["status"], "in_progress")
        self.assertEqual(self.target(after)["execution"]["outcome"], "")
        self.assertEqual(self.target(after)["execution"]["attempts"], 1)
        self.assertEqual(len(self.provider.calls), 2)
        self.assert_get_only()

    def test_todo_attempt_zero_baseline_is_an_original_new_reservation(self):
        self.prepare(before_target="todo")
        self.assert_original_lineage()
        baseline = self.target(self.before)
        self.assertEqual((baseline["status"], baseline["execution"]["attempts"]), ("todo", 0))
        self.assertEqual(self.owner_command()["outcome"], "bound")
        after = self.checkpoint(self.store.current()["state_sha"])
        expected = copy.deepcopy(_body(self.native))
        self.target(expected)["execution"].update(state="dispatched", session_id=self.session["id"])
        self.assertEqual(_body(after), expected)

    def test_same_owner_rerun_is_already_bound_without_provider_artifact_or_state_write(self):
        self.prepare()
        result = self.owner_command()
        before = self.authoritative()
        reads = (list(self.source.calls), list(self.source.downloads), list(self.provider.calls))
        for attempt in ("1", "2"):
            with self.subTest(attempt=attempt):
                reader = self.reader("same-owner-" + attempt)
                with patch.object(reader, "_write", wraps=reader._write) as write:
                    replay = self.owner_command(store=reader, owner={**self.owner, "run_attempt": attempt})
                self.assertEqual(write.call_count, 0)
                self.assertEqual(replay["outcome"], "already_bound")
                self.assertEqual(replay["receipt_id"], result["receipt_id"])
                self.assertEqual(replay["state_sha"], result["state_sha"])
        self.assertEqual((self.source.calls, self.source.downloads, self.provider.calls), reads)
        self.assertEqual(self.authoritative(), before)
        self.assertEqual(self.store.current()["frontier_seq"], 1)

    def test_different_owner_run_event_control_or_original_pin_cannot_replay_binding(self):
        self.prepare()
        self.owner_command()
        for overrides in ({"actor": "owner-b"}, {"run_id": "501"}, {"event_name": "schedule"},
                          {"control_sha": "c" * 40}, {"repository": "foreign/repository"},
                          {"ref": "refs/heads/topic"}, {"workflow": journal.OWNER_DISPATCH_OBSERVATION}):
            with self.subTest(overrides=overrides):
                self.assert_rejected_unchanged(owner={**self.owner, **overrides})
        new_pin = self.store.current()["state_sha"]
        self.assert_rejected_unchanged(pin=new_pin, owner={**self.owner, "expected_state_sha": new_pin})

    def test_owner_authentication_and_exact_command_inputs_are_required_for_both_apis(self):
        self.prepare()
        for observe in (False, True):
            workflow = journal.OWNER_DISPATCH_OBSERVATION if observe else journal.OWNER_DISPATCH_BINDING
            owner = {**self.owner, "workflow": workflow}
            for overrides in ({"actor": "stranger"}, {"ref": "refs/heads/topic"},
                              {"repository": "foreign/repository"}, {"event_name": "workflow_run"},
                              {"workflow": NEXT}, {"task_id": TARGET}, {"retry": True}):
                with self.subTest(observe=observe, overrides=overrides):
                    self.assert_rejected_unchanged(observe=observe, owner={**owner, **overrides})
            moved = "f" * 40
            self.assert_rejected_unchanged(observe=observe, pin=moved,
                                           owner={**owner, "expected_state_sha": moved})
            self.assert_rejected_unchanged(observe=observe, decision_id="f" * 64)
            denied = copy.deepcopy(self.config)
            denied["merge_gate"]["owner_approvers"] = ["owner-b"]
            self.assert_rejected_unchanged(observe=observe, config=denied)
        self.assertEqual(self.source.calls, [])
        self.assertEqual(self.provider.calls, [])

    def test_original_receiver_api_is_stuck_before_recovery_and_bound_after_without_replacement(self):
        self.prepare()
        before = self.authoritative()
        _, cap = self.reader("stuck-original").admit(
            NEXT, self.intent["normalized_inputs"], key=self.intent["correlation_key"],
            trigger=self.trigger("71", "2"), control_sha=CONTROL)
        self.assertIsNone(cap, "the original consumed receiver cannot repair by rerunning")
        refused = self.store.nonexecution_outcome(self.intent, key=self.intent["correlation_key"],
                                                 trigger=self.trigger("71", "2"), control_sha=CONTROL)
        self.assertEqual((refused["outcome"], refused["reason"]), ("blocked", "executor_without_outcome"))
        self.assertEqual(self.authoritative(), before)
        self.assertEqual(self.target(self.native)["execution"]["session_id"], "")
        original_request = copy.deepcopy(self.target(self.native)["execution"]["research_request"])
        self.owner_command()
        after = self.checkpoint(self.store.current()["state_sha"])
        execution = self.target(after)["execution"]
        self.assertEqual(execution["session_id"], self.session["id"])
        self.assertEqual(execution["research_request"], original_request)
        self.assertEqual(execution["attempts"], 1)
        for run in ("71", "72"):
            _, cap = self.reader("late-original-" + run).admit(
                NEXT, self.intent["normalized_inputs"], key=self.intent["correlation_key"],
                trigger=self.trigger(run, "2"), control_sha=CONTROL)
            self.assertIsNone(cap)
        for capability in (self.send, self.execution):
            with self.assertRaises(JournalConflict):
                capability.consume()
            with self.assertRaises(JournalConflict):
                capability.observer_context()
        with self.assertRaises(JournalConflict):
            self.store.record_effect(self.execution, "controller_checkpoint", {})
        self.assert_get_only()
        self.assertEqual(len(self.provider.calls), 2)

    def test_fresh_ordinary_sender_consumes_authentic_receipt_never_original_right(self):
        self.prepare()
        bound = self.owner_command()
        receipt = bound["receipt_id"]
        stable_body = _body(self.checkpoint(bound["state_sha"]))
        with self.assertRaises(JournalConflict):
            self.store.reserve_send(CONTINUE, {}, basis={"receipt_id": "f" * 64},
                                    trigger=self.trigger("600"), control_sha=CONTROL)
        intent, send = self.store.reserve_send(CONTINUE, {}, basis={"receipt_id": receipt},
                                               trigger=self.trigger("600"), control_sha=CONTROL)
        self.assertNotEqual(intent["decision_id"], self.intent["decision_id"])
        self.assertEqual(intent["predecessor_decision_id"], self.intent["decision_id"])
        send.consume()
        _, replay = self.reader("fresh-sender-replay").reserve_send(
            CONTINUE, {}, basis={"receipt_id": receipt}, trigger=self.trigger("600", "2"), control_sha=CONTROL)
        self.assertIsNone(replay)
        _, original = self.store.admit(NEXT, self.intent["normalized_inputs"],
                                      key=self.intent["correlation_key"], trigger=self.trigger("71", "2"),
                                      control_sha=CONTROL)
        self.assertIsNone(original)
        with self.assertRaises(JournalConflict):
            self.execution.observer_context()
        self.assertEqual(_body(self.checkpoint(self.store.current()["state_sha"])), stable_body)
        self.assertEqual(self.store.current()["frontier_seq"], 1)

    def test_current_full_body_drift_is_rejected_even_when_substantive_digest_ignores_clock(self):
        self.prepare()
        for change in ("clock", "protected_history", "request", "unrelated_task"):
            with self.subTest(change=change):
                changed = copy.deepcopy(self.native)
                if change == "clock":
                    changed["controller"]["last_tick_at"] = "2026-10-06T10:02:00Z"
                    self.assertEqual(substantive_digest(changed), substantive_digest(self.native))
                elif change == "protected_history":
                    changed["protected"]["history"].append({"result": "foreign result"})
                elif change == "request":
                    block = self.target(changed)["execution"]["research_request"]
                    block["controller_sha"] = "c" * 40
                else:
                    changed["tasks"].append(self.new_task("unrelated"))
                self.raw_commit(changed, publish=True)
                self.provider = self.provider_transport()
                self.assert_rejected_unchanged()
                self.assert_rejected_unchanged(observe=True)
                self.reset_native()
        self.assertEqual(self.owner_command()["outcome"], "bound")

    def test_native_checkpoint_must_change_only_one_genuinely_new_original_reservation(self):
        self.prepare()
        for change in ("clock", "protected_history", "task_title", "foreign_controller", "foreign_request",
                       "foreign_base", "foreign_key", "foreign_branch", "attempt", "status", "state", "session",
                       "outcome", "task_type", "duplicate", "missing"):
            with self.subTest(change=change):
                changed = copy.deepcopy(self.native)
                task = self.target(changed)
                execution = task["execution"]
                block = execution["research_request"]
                if change == "clock":
                    changed["controller"]["last_tick_at"] = "2026-10-06T10:02:00Z"
                elif change == "protected_history":
                    changed["protected"]["history"].append({"result": "foreign result"})
                elif change == "task_title":
                    task["title"] = ""
                elif change == "foreign_controller":
                    block["controller_sha"] = "c" * 40
                elif change == "foreign_request":
                    block["request"]["prompt"] += " SYNTHETIC_PRIVATE_REQUEST_CHANGED"
                    block["request_sha256"] = sha256_json(block["request"])
                elif change == "foreign_base":
                    execution["base_sha"] = "c" * 40
                elif change == "foreign_key":
                    execution["dispatch_key"] = "f" * 32
                elif change == "foreign_branch":
                    execution["starting_branch"] = "autonomous/attempt-" + "f" * 32
                elif change == "attempt":
                    execution["attempts"] = 2
                elif change == "status":
                    task["status"] = "todo"
                elif change == "state":
                    execution["state"] = "quarantined"
                elif change == "session":
                    execution["session_id"] = "unrelated-session"
                elif change == "outcome":
                    execution["outcome"] = "failed"
                elif change == "task_type":
                    task["task_type"] = "chore"
                elif change == "duplicate":
                    changed["tasks"].append(copy.deepcopy(task))
                else:
                    changed["tasks"].remove(task)
                native = self.raw_commit(changed, publish=True)
                self.set_report_pin(native)
                self.provider = self.provider_transport()
                self.assert_rejected_unchanged()
                self.reset_native()
        self.assertEqual(self.owner_command()["outcome"], "bound")

    def test_preexisting_unrelated_unbound_attempt_is_not_a_new_native_reservation(self):
        self.prepare(preexisting=True)
        self.assertEqual(_body(self.before), _body(self.native))
        self.assertEqual(self.native["tasks"][0]["id"], "synthetic-old")
        self.assert_rejected_unchanged()
        self.assertEqual(self.provider.calls, [])

    def test_nonautomatic_original_intent_cannot_be_recovered_as_reserved_dispatch(self):
        self.prepare(inputs={"automatic": False})
        self.assert_rejected_unchanged()
        self.assertEqual(self.provider.calls, [])

    def test_repair_original_intent_is_not_a_reserved_automatic_dispatch_escape_hatch(self):
        self.prepare(inputs={"automatic": True, "recover_report": True, "task_id": TARGET,
                             "repair_after": "2026-10-06T10:00:00Z"})
        self.assert_rejected_unchanged()
        self.assertEqual(self.provider.calls, [])

    def test_multiple_new_unbound_research_candidates_are_not_selected_arbitrarily(self):
        self.prepare()
        changed = copy.deepcopy(self.native)
        other = self.new_task("second-research")
        isolated = {**copy.deepcopy(self.native), "tasks": [other]}
        self.reserve_task(isolated, other)
        changed["tasks"].append(other)
        native = self.raw_commit(changed, publish=True)
        self.set_report_pin(native)
        self.assert_rejected_unchanged()
        self.assertEqual(self.provider.calls, [])

    def test_owner_command_cannot_reuse_original_executor_source_identity(self):
        self.prepare()
        self.assert_rejected_unchanged(owner={**self.owner, "run_id": "71"})
        self.assertEqual(self.provider.calls, [])

    def test_native_body_and_journal_must_be_actual_ancestors_not_matching_detached_snapshots(self):
        self.prepare()
        detached = self.raw_commit(self.native, parent="")
        self.assertNotEqual(detached, self.native_sha)
        self.assertEqual(_body(self.checkpoint(detached)), _body(self.native))
        self.set_report_pin(detached)
        self.assert_rejected_unchanged()
        self.set_report_pin(self.native_sha)
        # A sibling has identical full JSON and claims but is not the native descendant.
        self.raw_commit(self.native, parent=self.executor["before_state_sha"], publish=True)
        self.assert_rejected_unchanged()
        self.reset_native(parent=self.native_sha)
        self.assertEqual(self.owner_command()["outcome"], "bound")

    def test_native_and_current_journal_claims_cannot_be_replaced_or_reordered(self):
        self.prepare()
        for change in ("executor", "sender", "intent", "prefix"):
            with self.subTest(change=change):
                changed = copy.deepcopy(self.native)
                events = changed["dispatch_journal"]["events"]
                if change == "prefix":
                    events[-2:] = reversed(events[-2:])
                else:
                    event_type = {"executor": "ExecutorClaim", "sender": "SendClaim", "intent": "Intent"}[change]
                    event = next(event for event in events if event["type"] == event_type)
                    field = "first_source_trigger" if change == "intent" else "trigger"
                    event[field]["actor"] = "owner-b"
                    event["event_id"] = digest({key: value for key, value in event.items() if key != "event_id"})
                pin = self.raw_commit(changed, publish=True)
                self.set_report_pin(pin)
                self.provider = self.provider_transport()
                self.assert_rejected_unchanged()
                self.reset_native()

    def test_wrong_original_run_native_outcome_or_artifact_is_not_authenticated(self):
        self.prepare()
        original = copy.deepcopy(self.source)
        for change in ("run", "attempt", "controller", "title", "outcome", "artifact", "expired", "hash",
                       "report_reason", "report_pin"):
            with self.subTest(change=change):
                self.source = copy.deepcopy(original)
                if change == "run":
                    self.source.run["id"] = 72
                elif change == "attempt":
                    self.source.attempt["run_attempt"] = 2
                elif change == "controller":
                    self.source.run["head_sha"] = "c" * 40
                elif change == "title":
                    self.source.run["display_title"] = "Next " + "f" * 32
                elif change == "outcome":
                    self.source.jobs[0]["steps"][3]["conclusion"] = "success"
                elif change == "artifact":
                    self.source.artifacts[0]["name"] = "laboratory-result-72-1"
                elif change == "expired":
                    self.source.artifacts[0]["expired"] = True
                elif change == "hash":
                    self.source.archive += b"synthetic-tamper"
                elif change == "report_reason":
                    self.source.set_report({**self.source.report, "reason": "no_change"})
                else:
                    self.set_report_pin(self.executor["before_state_sha"])
                self.provider = self.provider_transport()
                self.assert_rejected_unchanged()
                self.assertEqual(self.provider.calls, [])
        self.source = original
        self.assertEqual(self.owner_command()["outcome"], "bound")

    def test_missing_ambiguous_foreign_or_changing_provider_session_never_creates_replacement(self):
        self.prepare()
        foreign = copy.deepcopy(self.session)
        foreign["sourceContext"]["source"] = "sources/github/foreign/repository"
        prompt = copy.deepcopy(self.session)
        prompt["prompt"] += " changed private provider prompt"
        changed = copy.deepcopy(self.session)
        changed["outputs"].append({"text": "changed private output"})
        second = copy.deepcopy(self.session)
        second.update(id="replacement-8", name="sessions/replacement-8")
        responses = ([page()], [page(self.session, second)], [page(foreign)], [page(prompt)],
                     [page(self.session), Response(200, changed)],
                     [Response(403, {"error": "SYNTHETIC_PRIVATE_WORKER_PROSE"})],
                     [page(self.session), Response(404, {"error": "SYNTHETIC_PRIVATE_WORKER_PROSE"})],
                     [RuntimeError("SYNTHETIC_PRIVATE_WORKER_PROSE transport failed")])
        for index, scripted in enumerate(responses):
            with self.subTest(case=index):
                self.provider = self.provider_transport(copy.deepcopy(scripted))
                self.assert_rejected_unchanged()
                self.assertLessEqual(len(self.provider.calls), 2)
        self.provider = self.provider_transport()
        self.assertEqual(self.owner_command()["outcome"], "bound")

    def test_provider_full_pagination_is_observed_and_missing_later_page_fails_closed(self):
        self.prepare()
        self.provider = self.provider_transport([page(self.session, token="next-page"),
                                                  Response(403, {"error": "private page failed"})])
        self.assert_rejected_unchanged()
        self.assertEqual(len(self.provider.calls), 2)
        self.provider = self.provider_transport([page(token="next-page"), page(self.session),
                                                  Response(200, copy.deepcopy(self.session))])
        self.assertEqual(self.owner_command()["outcome"], "bound")
        self.assertEqual(len(self.provider.calls), 3)
        self.assert_get_only()

    def test_state_pin_changed_during_get_observation_never_returns_stale_proof_or_binds(self):
        self.prepare()
        competitor = self.reader("get-race")
        def race():
            competitor.observe_delivery(self.intent["decision_id"], {"kind": "racing read observation"})
        self.provider = self.provider_transport(after_get=race)
        with patch.object(self.store, "_write", wraps=self.store._write) as write:
            with self.assertRaises((JournalConflict, ValueError)):
                self.owner_command(observe=True)
        self.assertEqual(write.call_count, 0)
        self.assertEqual(len(self.provider.calls), 2)
        state = self.store.current()
        self.assertNotIn(self.intent["decision_id"], state["completions"])
        self.assertEqual(state["frontier_seq"], 0)
        self.assertEqual(_body(self.checkpoint(state["state_sha"])), _body(self.native))
        self.assert_get_only()

    def test_state_pin_changed_during_binding_get_is_not_reobserved_or_written(self):
        self.prepare()
        competitor = self.reader("binding-get-race")
        raced = []
        def race():
            competitor.observe_delivery(self.intent["decision_id"], {"kind": "racing binding observation"})
            raced.append(self.authoritative())
        self.provider = self.provider_transport(after_get=race)
        with patch.object(self.store, "_write", wraps=self.store._write) as write:
            with self.assertRaises((JournalConflict, ValueError)):
                self.owner_command()
        self.assertEqual(write.call_count, 0)
        self.assertEqual(len(self.provider.calls), 2)
        self.assertEqual(self.authoritative(), raced[0])
        state = self.store.current()
        self.assertEqual(state["frontier_seq"], 0)
        self.assertNotIn(self.intent["decision_id"], state["completions"])
        self.assert_get_only()

    def test_real_stale_pin_is_denied_before_any_source_or_provider_observation(self):
        self.prepare()
        self.reader("stale-pin-writer").observe_delivery(self.intent["decision_id"],
                                                       {"kind": "new original delivery metadata"})
        self.assert_rejected_unchanged()
        self.assert_rejected_unchanged(observe=True)
        self.assertEqual(self.source.calls, [])
        self.assertEqual(self.source.downloads, [])
        self.assertEqual(self.provider.calls, [])

    def test_single_cas_conflict_never_repeats_observation_write_or_provider_creation(self):
        self.prepare()
        before = self.authoritative()
        with patch.object(self.store, "_write", side_effect=state_store.StateConflict("synthetic lease conflict")) as write:
            with self.assertRaises((JournalConflict, state_store.StateConflict)):
                self.owner_command()
        self.assertEqual(write.call_count, 1)
        self.assertEqual(len(self.provider.calls), 2)
        self.assertEqual(self.authoritative(), before)
        self.assertEqual(self.store.current()["frontier_seq"], 0)
        self.assert_get_only()

    def test_real_competing_git_cas_preserves_competitor_and_does_not_retry_bind(self):
        self.prepare()
        competitor = self.reader("cas-race")
        original_write = self.store._write
        published = []
        def racing_write(data):
            competitor.observe_delivery(self.intent["decision_id"], {"kind": "concurrent native observation"})
            published.append(self.authoritative())
            return original_write(data)
        with patch.object(self.store, "_write", side_effect=racing_write) as write:
            with self.assertRaises((JournalConflict, state_store.StateConflict)):
                self.owner_command()
        self.assertEqual(write.call_count, 1)
        self.assertEqual(len(self.provider.calls), 2)
        self.assertEqual(self.authoritative(), published[0])
        state = self.store.current()
        self.assertEqual(state["frontier_seq"], 0)
        self.assertNotIn(self.intent["decision_id"], state["completions"])
        self.assertEqual(_body(self.checkpoint(state["state_sha"])), _body(self.native))
        self.assert_get_only()

    def test_lost_push_ack_is_bound_durably_but_only_exact_replay_reconciles_without_get(self):
        self.prepare()
        original_git = state_store._git
        pushes = []
        def lose_ack(repo, *args, **kwargs):
            result = original_git(repo, *args, **kwargs)
            if "push" in args:
                pushes.append(args)
                raise subprocess.TimeoutExpired("synthetic isolated push ack loss", 90)
            return result
        with patch.object(state_store, "_git", side_effect=lose_ack), \
                patch.object(self.store, "_write", wraps=self.store._write) as write:
            with self.assertRaises(JournalUncertain):
                self.owner_command()
        self.assertEqual(write.call_count, 1)
        self.assertEqual(len(pushes), 1)
        self.assertEqual(len(self.provider.calls), 2)
        state = self.store.current()
        self.assertEqual(state["frontier_seq"], 1)
        self.assertIsNone(state["active_intent"])
        receipt = state["completions"][self.intent["decision_id"]]
        after = self.authoritative()
        reads = (list(self.source.calls), list(self.source.downloads), list(self.provider.calls))
        result = self.owner_command(store=self.reader("lost-ack-reconciliation"),
                                    owner={**self.owner, "run_attempt": "2"})
        self.assertEqual(result["outcome"], "already_bound")
        self.assertEqual(result["receipt_id"], receipt["receipt_id"])
        self.assertEqual(self.authoritative(), after)
        self.assertEqual((self.source.calls, self.source.downloads, self.provider.calls), reads)
        self.assert_rejected_unchanged(owner={**self.owner, "actor": "owner-b"})
        with self.assertRaises(JournalConflict):
            self.execution.observer_context()
        self.assert_get_only()

    def test_fold_rejects_receipt_proof_identity_report_and_digest_tampering(self):
        self.prepare()
        self.owner_command()
        saved = self.checkpoint(self.store.current()["state_sha"])
        changes = ("receipt", "provider_auth", "provider_method", "provider_session", "provider_list_hash",
                   "provider_request_hash", "identity", "producer", "native_report", "before_digest",
                   "after_digest", "checkpoint_digest", "event_before_digest", "event_after_digest",
                   "before_pin", "after_pin", "frontier", "kind")
        for change in changes:
            with self.subTest(change=change):
                changed = copy.deepcopy(saved["dispatch_journal"])
                event = changed["events"][-1]
                if change == "receipt":
                    event["receipt_id"] = "f" * 64
                elif change == "provider_auth":
                    event["provider_proof"]["authenticated"] = False
                elif change == "provider_method":
                    event["provider_proof"]["method"] = "POST"
                elif change == "provider_session":
                    event["provider_proof"]["session_resource"] = "sessions/replacement"
                elif change == "provider_list_hash":
                    event["provider_proof"]["list_session_sha256"] = "f" * 64
                elif change == "provider_request_hash":
                    event["provider_proof"]["request_sha256"] = "not-a-digest"
                elif change == "identity":
                    event["identity"]["attempts"] += 1
                elif change == "producer":
                    event["proof"]["producer"]["run_attempt"] = "2"
                elif change == "native_report":
                    event["native_report"]["reason"] = "no_change"
                elif change in ("before_digest", "after_digest"):
                    event["evidence"][change] = "f" * 64
                elif change == "checkpoint_digest":
                    event["evidence"]["checkpoint_digest"] = "f" * 64
                elif change == "event_before_digest":
                    event["before_digest"] = "f" * 64
                elif change == "event_after_digest":
                    event["after_digest"] = "f" * 64
                elif change == "before_pin":
                    event["evidence"]["before_state_sha"] = "f" * 40
                elif change == "after_pin":
                    event["evidence"]["after_state_sha"] = "f" * 40
                elif change == "frontier":
                    event["frontier_seq"] += 1
                else:
                    event["kind"] = "next_no_effect_observed"
                if change != "receipt":
                    event["receipt_id"] = _reserved_dispatch_receipt(event)
                event["event_id"] = digest({key: value for key, value in event.items() if key != "event_id"})
                self.assertTrue(validate_journal(changed), "fold must reject " + change)


if __name__ == "__main__":
    unittest.main()
