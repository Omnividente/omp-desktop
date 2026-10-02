#!/usr/bin/env python3
"""Owner-only workflow provenance and capability boundaries."""
from __future__ import annotations

from argparse import Namespace
import os
import unittest
from unittest.mock import patch

from dispatch_journal import normalize_inputs
from workflow_admission import OWNER_RECOVERY, checked_control_pin, context, recheck_context

REPOSITORY = "owner/repo"
CONTROL = "a" * 40
NEXT = "autonomous_next_task.yml"


class OwnerAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.config = {"repository": REPOSITORY, "merge_gate": {"owner_approvers": ["owner"]}}
        self.args = Namespace(run_id="71", run_attempt="1", event_name="workflow_dispatch",
                              control_sha=CONTROL, continuation_key="", workflow=OWNER_RECOVERY)
        environment = {"GITHUB_RUN_ID": "71", "GITHUB_RUN_ATTEMPT": "1",
                       "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": REPOSITORY,
                       "GITHUB_ACTOR": "owner", "GITHUB_REF": "refs/heads/main",
                       "GITHUB_WORKFLOW_REF": REPOSITORY + "/.github/workflows/" + OWNER_RECOVERY + "@refs/heads/main",
                       "CONTROL_SHA": CONTROL, "CONTINUATION_KEY": ""}
        self.environment = patch.dict(os.environ, environment, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        revision = patch("workflow_admission.control_revision", return_value=CONTROL)
        revision.start()
        self.addCleanup(revision.stop)

    def test_owner_context_cannot_issue_execution_send_or_checkout_authority(self):
        binding = context(self.args, OWNER_RECOVERY, self.config)
        with self.assertRaises(ValueError):
            binding.admit(object(), {})
        with self.assertRaises(ValueError):
            normalize_inputs(OWNER_RECOVERY, {})
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
                    context(self.args, OWNER_RECOVERY, self.config)

    def test_owner_context_requires_main_dispatch_exact_repository_and_workflow(self):
        changes = (("GITHUB_REF", "refs/heads/foreign"), ("GITHUB_REPOSITORY", "foreign/repo"),
                   ("GITHUB_WORKFLOW_REF", ""),
                   ("GITHUB_WORKFLOW_REF", REPOSITORY + "/.github/workflows/" + NEXT + "@refs/heads/main"),
                   ("GITHUB_EVENT_NAME", "schedule"), ("CONTROL_SHA", "b" * 40))
        for variable, value in changes:
            with self.subTest(variable=variable, value=value), patch.dict(os.environ, {variable: value}):
                with self.assertRaises(ValueError):
                    context(self.args, OWNER_RECOVERY, self.config)

    def test_owner_recheck_rejects_changed_or_missing_actor_and_workflow(self):
        binding = context(self.args, OWNER_RECOVERY, self.config)
        for variable, value in (("GITHUB_ACTOR", "foreign"), ("GITHUB_ACTOR", ""),
                                ("GITHUB_WORKFLOW_REF", ""), ("GITHUB_REF", "refs/heads/foreign")):
            with self.subTest(variable=variable, value=value), patch.dict(os.environ, {variable: value}):
                with self.assertRaises(ValueError):
                    recheck_context(binding)
        with patch.dict(os.environ):
            del os.environ["GITHUB_ACTOR"]
            with self.assertRaises(ValueError):
                recheck_context(binding)


if __name__ == "__main__":
    unittest.main(verbosity=2)
