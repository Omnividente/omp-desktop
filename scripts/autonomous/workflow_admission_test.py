#!/usr/bin/env python3
"""Owner-only workflow provenance and capability boundaries."""
from __future__ import annotations

from argparse import Namespace
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from dispatch_journal import normalize_inputs
from workflow_admission import (CALLBACK_EVENTS, CALLBACK_WORKFLOWS, CONCLUSIONS,
                                OWNER_CONTINUE_CUTOVER, OWNER_RECOVERY,
                                checked_callback_source, checked_control_pin, context, recheck_context)

REPOSITORY = "owner/repo"
CONTROL = "a" * 40
NEXT = "autonomous_next_task.yml"


class OwnerAdmissionTest(unittest.TestCase):
    workflow = OWNER_RECOVERY

    def setUp(self):
        self.config = {"repository": REPOSITORY, "merge_gate": {"owner_approvers": ["owner"]}}
        self.args = Namespace(run_id="71", run_attempt="1", event_name="workflow_dispatch",
                              control_sha=CONTROL, continuation_key="", workflow=self.workflow)
        environment = {"GITHUB_RUN_ID": "71", "GITHUB_RUN_ATTEMPT": "1",
                       "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": REPOSITORY,
                       "GITHUB_ACTOR": "owner", "GITHUB_REF": "refs/heads/main",
                       "GITHUB_WORKFLOW_REF": REPOSITORY + "/.github/workflows/" + self.workflow + "@refs/heads/main",
                       "CONTROL_SHA": CONTROL, "CONTINUATION_KEY": ""}
        self.environment = patch.dict(os.environ, environment, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        revision = patch("workflow_admission.control_revision", return_value=CONTROL)
        revision.start()
        self.addCleanup(revision.stop)

    def test_owner_context_cannot_issue_execution_send_or_checkout_authority(self):
        binding = context(self.args, self.workflow, self.config)
        with self.assertRaises(ValueError):
            binding.admit(object(), {})
        with self.assertRaises(ValueError):
            normalize_inputs(self.workflow, {})
        with self.assertRaises(ValueError):
            checked_control_pin(self.args, self.config, object())

    def test_owner_workflow_cannot_impersonate_next_with_or_without_a_key(self):
        for key in ("", "b" * 32):
            with self.subTest(key=key):
                self.args.continuation_key = key
                os.environ["CONTINUATION_KEY"] = key
                with self.assertRaises(ValueError):
                    context(self.args, NEXT, self.config)

    def test_owner_context_rejects_nonowner_and_keyed_bypass(self):
        for actor, key in (("foreign", ""), ("foreign", "b" * 32), ("owner", "b" * 32)):
            with self.subTest(actor=actor, key=key):
                os.environ.update(GITHUB_ACTOR=actor, CONTINUATION_KEY=key)
                self.args.continuation_key = key
                with self.assertRaises(ValueError):
                    context(self.args, self.workflow, self.config)

    def test_owner_context_requires_main_dispatch_exact_repository_and_workflow(self):
        changes = (("GITHUB_REF", "refs/heads/foreign"), ("GITHUB_REPOSITORY", "foreign/repo"),
                   ("GITHUB_WORKFLOW_REF", ""),
                   ("GITHUB_WORKFLOW_REF", REPOSITORY + "/.github/workflows/" + NEXT + "@refs/heads/main"),
                   ("GITHUB_EVENT_NAME", "schedule"), ("CONTROL_SHA", "b" * 40))
        for variable, value in changes:
            with self.subTest(variable=variable, value=value), patch.dict(os.environ, {variable: value}):
                with self.assertRaises(ValueError):
                    context(self.args, self.workflow, self.config)

    def test_owner_recheck_rejects_changed_or_missing_actor_and_workflow(self):
        binding = context(self.args, self.workflow, self.config)
        for variable, value in (("GITHUB_ACTOR", "foreign"), ("GITHUB_ACTOR", ""),
                                ("GITHUB_WORKFLOW_REF", ""), ("GITHUB_REF", "refs/heads/foreign")):
            with self.subTest(variable=variable, value=value), patch.dict(os.environ, {variable: value}):
                with self.assertRaises(ValueError):
                    recheck_context(binding)
        with patch.dict(os.environ):
            del os.environ["GITHUB_ACTOR"]
            with self.assertRaises(ValueError):
                recheck_context(binding)

    def test_one_owner_workflow_cannot_authorize_the_other_operation(self):
        other = OWNER_CONTINUE_CUTOVER if self.workflow == OWNER_RECOVERY else OWNER_RECOVERY
        with self.assertRaises(ValueError):
            context(self.args, other, self.config)


class ContinueCutoverAdmissionTest(OwnerAdmissionTest):
    workflow = OWNER_CONTINUE_CUTOVER


class CallbackSource:
    """Independent event, exact-attempt and latest-run views of synthetic Actions."""
    def __init__(self, workflow=NEXT, *, event="workflow_dispatch", conclusion="success"):
        names = dict(CALLBACK_WORKFLOWS)
        names["autonomous_evidence_gate.yml"] = "Autonomous Evidence Gate"
        self.workflows = {workflow: names[workflow]}
        self.source = {
            "id": 501, "run_attempt": 1, "workflow_id": 601, "name": names[workflow],
            "path": ".github/workflows/" + workflow, "head_sha": "b" * 40,
            "head_branch": "main", "event": event, "status": "completed", "conclusion": conclusion,
            "repository": {"id": 701, "full_name": REPOSITORY},
            "head_repository": {"id": 701, "full_name": REPOSITORY}, "pull_requests": [],
        }
        self.attempt = copy.deepcopy(self.source)
        self.current = copy.deepcopy(self.source)
        self.workflow = {"id": 601, "name": names[workflow], "path": self.source["path"]}
        self.responses = {
            "actions/runs/501/attempts/1": self.attempt,
            "actions/workflows/601": self.workflow,
            "actions/runs/501": self.current,
        }
        self.reads = []

    def get(self, path):
        self.reads.append(path)
        value = self.responses[path]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)

    def check(self):
        return checked_callback_source(REPOSITORY, self.source, workflows=self.workflows, get=self.get)


class CallbackAuthenticationTest(unittest.TestCase):
    def test_four_main_sources_accept_only_their_real_events_and_terminal_signals(self):
        for workflow in CALLBACK_WORKFLOWS:
            for event in CALLBACK_EVENTS[workflow]:
                for conclusion in CONCLUSIONS:
                    with self.subTest(workflow=workflow, event=event, conclusion=conclusion):
                        source = CallbackSource(workflow, event=event, conclusion=conclusion)
                        self.assertEqual(source.check(), source.attempt)
                        self.assertEqual(source.reads, ["actions/runs/501/attempts/1",
                                                       "actions/workflows/601", "actions/runs/501"])

    def test_evidence_accepts_pr_branch_without_requiring_current_main_sha(self):
        source = CallbackSource("autonomous_evidence_gate.yml", event="pull_request")
        for run in (source.source, source.attempt, source.current):
            run.update(head_branch="autonomous/attempt-synthetic", pull_requests=[{"number": 31}])
        checked = source.check()
        self.assertEqual(checked["pull_requests"], [{"number": 31}])
        self.assertEqual(checked["repository"], source.attempt["repository"])
        self.assertNotEqual(checked["head_sha"], CONTROL)

    def test_payload_may_omit_own_repository_and_path_but_rest_may_not(self):
        source = CallbackSource()
        del source.source["repository"]
        del source.source["path"]
        self.assertEqual(source.check(), source.attempt)
        for endpoint in ("actions/runs/501/attempts/1", "actions/runs/501"):
            for field in ("repository", "path"):
                with self.subTest(endpoint=endpoint, field=field):
                    source = CallbackSource()
                    del source.responses[endpoint][field]
                    with self.assertRaises(ValueError):
                        source.check()

    def test_unknown_review_and_fake_named_workflow_never_authenticate(self):
        for name, path in (("Autonomous Proposal Review", "autonomous_proposal_review.yml"),
                           ("Quality Gate", "pr.yml"), ("Unknown", "unknown.yml"),
                           ("Autonomous Next Task", "fake.yml")):
            with self.subTest(name=name):
                source = CallbackSource()
                source.source.update(name=name, path=".github/workflows/" + path)
                source.workflows = CALLBACK_WORKFLOWS
                with self.assertRaises(ValueError):
                    source.check()
                self.assertEqual(source.reads, [])

    def test_source_event_is_not_authorized_by_workflow_name_alone(self):
        for workflow in (*CALLBACK_WORKFLOWS, "autonomous_evidence_gate.yml"):
            for event in {"workflow_dispatch", "push", "schedule", "pull_request", "workflow_run",
                          "pull_request_target", "repository_dispatch"} - CALLBACK_EVENTS[workflow]:
                with self.subTest(workflow=workflow, event=event):
                    with self.assertRaises(ValueError):
                        CallbackSource(workflow, event=event).check()

    def test_exact_numeric_json_run_attempt_and_workflow_ids_are_required(self):
        for endpoint in ("event", "actions/runs/501/attempts/1", "actions/runs/501", "actions/workflows/601"):
            fields = ("id",) if endpoint == "actions/workflows/601" else ("id", "run_attempt", "workflow_id")
            for field in fields:
                for value in (None, True, False, 0, -1, "1", 1.0):
                    with self.subTest(endpoint=endpoint, field=field, value=value):
                        source = CallbackSource()
                        target = source.source if endpoint == "event" else source.responses[endpoint]
                        target[field] = value
                        with self.assertRaises(ValueError):
                            source.check()

    def test_foreign_missing_or_inconsistent_repository_identity_fails_closed(self):
        for endpoint in ("event", "actions/runs/501/attempts/1", "actions/runs/501"):
            for field in ("repository", "head_repository"):
                for value in (None, {}, {"full_name": REPOSITORY}, {"id": True, "full_name": REPOSITORY},
                              {"id": "701", "full_name": REPOSITORY},
                              {"id": 702, "full_name": REPOSITORY},
                              {"id": 701, "full_name": "foreign/repo"}):
                    with self.subTest(endpoint=endpoint, field=field, value=value):
                        source = CallbackSource()
                        target = source.source if endpoint == "event" else source.responses[endpoint]
                        target[field] = value
                        with self.assertRaises(ValueError):
                            source.check()

    def test_malformed_payload_and_rest_response_shapes_are_rejected(self):
        for value in (None, [], "run", 1, True):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    checked_callback_source(REPOSITORY, value, workflows=CALLBACK_WORKFLOWS)
                for endpoint in ("actions/runs/501/attempts/1", "actions/workflows/601", "actions/runs/501"):
                    source = CallbackSource()
                    source.responses[endpoint] = value
                    with self.assertRaises(ValueError):
                        source.check()

    def test_event_and_rest_execution_identity_must_match_exactly(self):
        mutations = {"id": 502, "run_attempt": 2, "workflow_id": 602,
                     "head_sha": "c" * 40, "head_branch": "foreign", "name": "Other",
                     "path": ".github/workflows/other.yml", "status": "in_progress",
                     "event": "push", "conclusion": "failure"}
        for endpoint in ("actions/runs/501/attempts/1", "actions/runs/501"):
            for field, value in mutations.items():
                with self.subTest(endpoint=endpoint, field=field):
                    source = CallbackSource()
                    source.responses[endpoint][field] = value
                    with self.assertRaises(ValueError):
                        source.check()

    def test_invalid_sha_state_and_typed_execution_fields_fail_closed(self):
        mutations = {"head_sha": (None, "", "a" * 39, "a" * 41, "G" * 40, []),
                     "status": (None, "queued", "in_progress"), "head_branch": (None, "", []),
                     "event": (None, [], {}), "conclusion": (None, "unknown", [], {})}
        for field, values in mutations.items():
            for value in values:
                for endpoint in ("event", "actions/runs/501/attempts/1", "actions/runs/501"):
                    with self.subTest(endpoint=endpoint, field=field, value=value):
                        source = CallbackSource()
                        target = source.source if endpoint == "event" else source.responses[endpoint]
                        target[field] = value
                        with self.assertRaises(ValueError):
                            source.check()

    def test_exact_workflow_api_id_name_and_path_are_required(self):
        for field, value in (("id", 602), ("name", "Forged"), ("name", None),
                             ("path", ".github/workflows/fake.yml"), ("path", None)):
            with self.subTest(field=field, value=value):
                source = CallbackSource()
                source.workflow[field] = value
                with self.assertRaises(ValueError):
                    source.check()

    def test_pinned_attempt_is_not_substituted_with_latest_or_another_attempt(self):
        source = CallbackSource()
        source.current.update(run_attempt=2)
        with self.assertRaises(ValueError):
            source.check()
        source = CallbackSource()
        source.source["run_attempt"] = 2
        source.current["run_attempt"] = 2
        source.responses["actions/runs/501/attempts/2"] = copy.deepcopy(source.attempt)
        with self.assertRaises(ValueError):
            source.check()
        source.responses["actions/runs/501/attempts/2"]["run_attempt"] = 2
        self.assertEqual(source.check()["run_attempt"], 2)

    def test_api_failure_at_every_read_propagates_without_fallback(self):
        for endpoint in ("actions/runs/501/attempts/1", "actions/workflows/601", "actions/runs/501"):
            for error in (RuntimeError("synthetic unavailable"), json.JSONDecodeError("bad", "", 0),
                          subprocess.CalledProcessError(1, ["gh", "api"])):
                with self.subTest(endpoint=endpoint, error=type(error).__name__):
                    source = CallbackSource()
                    source.responses[endpoint] = error
                    with self.assertRaises(type(error)):
                        source.check()
                    self.assertEqual(source.reads[-1], endpoint)

    def test_production_transport_issues_only_three_repo_scoped_gets(self):
        source = CallbackSource()
        def invoke(command, **kwargs):
            self.assertEqual(command[:4], ["gh", "api", "--method", "GET"])
            self.assertEqual(len(command), 5)
            prefix = "/repos/" + REPOSITORY + "/"
            self.assertTrue(command[4].startswith(prefix))
            self.assertTrue(kwargs["check"])
            return subprocess.CompletedProcess(command, 0, json.dumps(source.get(command[4][len(prefix):])))
        with patch("workflow_admission.subprocess.run", side_effect=invoke) as transport:
            checked = checked_callback_source(REPOSITORY, source.source, workflows=source.workflows)
        self.assertEqual(checked, source.attempt)
        self.assertEqual(transport.call_count, 3)


class ContinueCallbackContextTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="callback-admission-")
        self.addCleanup(temporary.cleanup)
        self.event_path = Path(temporary.name) / "event.json"
        self.config = {"repository": REPOSITORY}
        self.args = Namespace(run_id="71", run_attempt="1", event_name="workflow_run",
                              control_sha=CONTROL, continuation_key="")
        environment = {"GITHUB_RUN_ID": "71", "GITHUB_RUN_ATTEMPT": "1",
                       "GITHUB_EVENT_NAME": "workflow_run", "GITHUB_REPOSITORY": REPOSITORY,
                       "GITHUB_ACTOR": "synthetic", "GITHUB_REF": "refs/heads/main",
                       "GITHUB_WORKFLOW_REF": REPOSITORY + "/.github/workflows/autonomous_continue.yml@refs/heads/main",
                       "GITHUB_EVENT_PATH": str(self.event_path), "CONTROL_SHA": CONTROL,
                       "CONTINUATION_KEY": ""}
        environment_patch = patch.dict(os.environ, environment, clear=True)
        environment_patch.start()
        self.addCleanup(environment_patch.stop)
        revision = patch("workflow_admission.control_revision", return_value=CONTROL)
        revision.start()
        self.addCleanup(revision.stop)

    def admit(self, source, *, root=None):
        payload = {"repository": root if root is not None else {"id": 701, "full_name": REPOSITORY},
                   "workflow_run": source.source}
        self.event_path.write_text(json.dumps(payload), encoding="utf-8")
        self.store = Mock()
        with patch("workflow_admission._callback_get", side_effect=lambda repository, path: source.get(path)):
            binding = context(self.args, "autonomous_continue.yml", self.config)
            binding.admit(self.store, {})
        return binding

    def test_four_main_callbacks_keep_frozen_source_and_non_success_signals(self):
        for workflow in CALLBACK_WORKFLOWS:
            for event in CALLBACK_EVENTS[workflow]:
                for conclusion in ("success", "failure", "cancelled", "timed_out", "skipped"):
                    with self.subTest(workflow=workflow, event=event, conclusion=conclusion):
                        source = CallbackSource(workflow, event=event, conclusion=conclusion)
                        binding = self.admit(source)
                        self.assertEqual(binding.control_sha, CONTROL)
                        self.assertNotEqual(source.source["head_sha"], binding.control_sha)
                        self.assertEqual(binding.trigger["source_run_id"], "501")
                        self.assertEqual(binding.trigger["source_run_attempt"], "1")
                        self.assertEqual(binding.trigger["source_workflow"], source.source["name"])
                        self.assertEqual(set(binding.trigger), {"run_id", "run_attempt", "event_name",
                                         "control_sha", "repository", "actor", "source_run_id",
                                         "source_run_attempt", "source_workflow"})
                        self.store.admit.assert_called_once_with("autonomous_continue.yml", {}, key="",
                                                                trigger=binding.trigger, control_sha=CONTROL)

    def test_review_every_conclusion_evidence_and_unknown_callbacks_reject_before_journal(self):
        for name in ("Autonomous Proposal Review", "Autonomous Evidence Gate", "Quality Gate", "Unknown"):
            for conclusion in CONCLUSIONS:
                with self.subTest(name=name, conclusion=conclusion):
                    source = CallbackSource(conclusion=conclusion)
                    source.source["name"] = name
                    with self.assertRaises(ValueError):
                        self.admit(source)
                    self.store.admit.assert_not_called()
                    self.assertEqual(source.reads, [])

    def test_foreign_missing_numeric_root_repository_cannot_admit(self):
        for root in ({}, {"full_name": REPOSITORY}, {"full_name": "foreign/repo", "id": 701},
                     {"full_name": REPOSITORY, "id": True}, {"full_name": REPOSITORY, "id": "701"},
                     {"full_name": REPOSITORY, "id": 702}):
            with self.subTest(root=root):
                with self.assertRaises(ValueError):
                    self.admit(CallbackSource(), root=root)
                self.store.admit.assert_not_called()

    def test_authenticated_non_main_source_branch_is_not_continue_authority(self):
        source = CallbackSource()
        for run in (source.source, source.attempt, source.current):
            run["head_branch"] = "dot/synthetic"
        with self.assertRaises(ValueError):
            self.admit(source)
        self.store.admit.assert_not_called()

    def test_api_failure_attempt_change_and_fake_source_do_not_touch_journal(self):
        for failure in ("api", "attempt", "workflow"):
            with self.subTest(failure=failure):
                source = CallbackSource()
                if failure == "api":
                    source.responses["actions/runs/501/attempts/1"] = RuntimeError("synthetic unavailable")
                elif failure == "attempt":
                    source.current["run_attempt"] = 2
                else:
                    source.workflow["path"] = ".github/workflows/fake.yml"
                with self.assertRaises((RuntimeError, ValueError)):
                    self.admit(source)
                self.store.admit.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
