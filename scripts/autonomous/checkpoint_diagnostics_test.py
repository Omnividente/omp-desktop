#!/usr/bin/env python3
"""Safe causal metadata boundaries and unchanged controller failure envelopes."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import lab_controller
import state_store
from checkpoint_diagnostics import (
    MAX_CAUSAL_DEPTH, MAX_DIAGNOSTIC_BYTES, StateWriteError,
    diagnostic_for_failure, validate_diagnostics,
)
from dispatch_journal import JournalUncertain


class CheckpointDiagnosticsTests(unittest.TestCase):
    def test_owner_quarantine_label_preserves_the_original_exception_and_cause(self):
        cause = OSError("SENTINEL_CAUSE")
        failure = RuntimeError("SENTINEL_ERROR")
        failure.__cause__ = cause

        def unavailable(data):
            raise failure

        with self.assertRaises(RuntimeError) as caught:
            lab_controller._persist_checkpoint({}, unavailable, "owner_quarantine", None)
        self.assertIs(caught.exception, failure)
        self.assertIs(caught.exception.__cause__, cause)
        value = diagnostic_for_failure(caught.exception.checkpoint_stage, caught.exception)
        self.assertEqual(value["checkpoint_stage"], "owner_quarantine")
        self.assertEqual(value["causal_chain"], ["runtime", "os_error"])
        self.assertNotIn("SENTINEL", json.dumps(value))

    def test_known_exception_chain_never_serializes_commands_stderr_or_messages(self):
        failure = subprocess.TimeoutExpired(
            ["git", "push", "https://SENTINEL_USER:SENTINEL_PASSWORD@example.invalid"],
            90, output=b"SENTINEL_STDOUT", stderr=b"SENTINEL_STDERR")
        with patch.object(state_store.subprocess, "run", side_effect=failure):
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                state_store._git(Path("SENTINEL_REPO"), "-c", "SENTINEL_OPTION", "push",
                                 "SENTINEL_ARGV")
        uncertain = state_store.StateUncertain("SENTINEL_STATE_MESSAGE")
        uncertain.__cause__ = caught.exception
        journal = JournalUncertain("SENTINEL_JOURNAL_MESSAGE")
        journal.__cause__ = uncertain
        outer = StateWriteError("SENTINEL_WRAPPER_MESSAGE", stage="research_planner")
        outer.__cause__ = journal
        value = diagnostic_for_failure(outer.checkpoint_stage, outer)
        self.assertTrue(validate_diagnostics(value))
        self.assertEqual(value["causal_chain"], ["state_write", "journal_uncertain", "state_uncertain", "timeout"])
        self.assertEqual(value["git_operation"], "push")
        self.assertIs(value["git_timeout"], True)
        self.assertIsNone(value["git_returncode"])
        encoded = json.dumps(value)
        self.assertNotIn("SENTINEL", encoded)
        self.assertLessEqual(len(encoded.encode("utf-8")), MAX_DIAGNOSTIC_BYTES)
        self.assertIs(outer.__cause__, journal)
        self.assertIs(journal.__cause__, uncertain)
        self.assertIs(uncertain.__cause__, failure)

    def test_unknown_cause_and_untrusted_metadata_do_not_invent_facts(self):
        class SecretException(Exception):
            pass

        failure = SecretException("SENTINEL_MESSAGE")
        failure.checkpoint_metadata = {
            "git_operation": "SENTINEL_OPERATION", "git_returncode": 100000,
            "git_timeout": "SENTINEL_TIMEOUT", "expected_state_sha": "SENTINEL_SHA",
            "observed_state_sha": False, "acknowledgement_uncertain": "SENTINEL_ACK",
            "stderr": "SENTINEL_STDERR",
        }
        value = diagnostic_for_failure("SENTINEL_STAGE", failure)
        self.assertTrue(validate_diagnostics(value))
        self.assertEqual(value["checkpoint_stage"], "unknown")
        self.assertEqual(value["exception_category"], "unknown")
        self.assertEqual(value["causal_chain"], ["unknown"])
        self.assertEqual(value["git_operation"], "unknown")
        for field in ("git_returncode", "git_timeout", "expected_state_sha", "observed_state_sha",
                      "acknowledgement_uncertain"):
            self.assertIsNone(value[field])
        self.assertNotIn("SENTINEL", json.dumps(value))

    def test_validator_rejects_unbounded_or_prose_metadata(self):
        valid = diagnostic_for_failure("research_planner", RuntimeError("not retained"))
        mutations = [
            ("version", True), ("checkpoint_stage", "private task title"),
            ("exception_category", "private exception name"), ("git_operation", ["push"]),
            ("git_returncode", True), ("git_returncode", 256), ("git_returncode", -256),
            ("git_returncode", float("nan")), ("git_timeout", 90),
            ("expected_state_sha", "A" * 40), ("observed_state_sha", "a" * 41),
            ("acknowledgement_uncertain", "maybe"), ("causal_chain", []),
            ("causal_chain", ["runtime"] * (MAX_CAUSAL_DEPTH + 1)),
            ("causal_chain", ["validation"]), ("causal_chain", ["runtime", "private cause"]),
        ]
        for field, value in mutations:
            with self.subTest(field=field, value=value):
                modified = copy.deepcopy(valid)
                modified[field] = value
                self.assertFalse(validate_diagnostics(modified))
        extra = dict(valid, stderr="private credential")
        self.assertFalse(validate_diagnostics(extra))
        for field in valid:
            missing = dict(valid)
            missing.pop(field)
            self.assertFalse(validate_diagnostics(missing))

    def test_causal_depth_and_cycles_are_bounded_without_destroying_the_original_chain(self):
        causes = [RuntimeError("SENTINEL_" + str(index)) for index in range(20)]
        for first, second in zip(causes, causes[1:]):
            first.__cause__ = second
        causes[-1].__cause__ = causes[0]
        value = diagnostic_for_failure("reconcile", causes[0])
        self.assertEqual(value["causal_chain"], ["runtime"] * MAX_CAUSAL_DEPTH)
        self.assertTrue(validate_diagnostics(value))
        self.assertIs(causes[-1].__cause__, causes[0])
        self.assertNotIn("SENTINEL", json.dumps(value))
        failure = RuntimeError("SENTINEL_SELF_CYCLE")
        failure.__cause__ = failure
        self.assertEqual(diagnostic_for_failure("reconcile", failure)["causal_chain"], ["runtime"])

    def test_git_nonzero_code_is_normalized_without_changing_exception_semantics(self):
        for code, expected in ((128, 128), (-9, -9), (100000, None)):
            with self.subTest(code=code):
                completed = subprocess.CompletedProcess(["SENTINEL_CMD"], code,
                                                        b"SENTINEL_OUT", b"SENTINEL_ERR")
                with patch.object(state_store.subprocess, "run", return_value=completed):
                    with self.assertRaises(RuntimeError) as caught:
                        state_store._git(Path("."), "fetch", "SENTINEL_URL")
                value = diagnostic_for_failure("reconcile", caught.exception)
                self.assertEqual(type(caught.exception), RuntimeError)
                self.assertEqual(value["git_operation"], "fetch")
                self.assertEqual(value["git_returncode"], expected)
                self.assertIs(value["git_timeout"], False)
                self.assertNotIn("SENTINEL", json.dumps(value))

    def test_optional_retention_failure_preserves_original_five_key_result(self):
        for retention_fails in (False, True):
            with self.subTest(retention_fails=retention_fails), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                config = root / "config.json"
                config.write_text(json.dumps({"repository": "fixture/project"}), encoding="utf-8")
                revision = root / "revision.json"
                revision.write_text(json.dumps({"state_sha": "a" * 40}), encoding="utf-8")
                output = root / "lab-result.json"
                binding = Mock()
                binding.admit.return_value = ({"decision_id": "synthetic"}, Mock())
                failure = StateWriteError(
                    "state save failed; reload the authoritative queue before continuing",
                    stage="research_planner")
                failure.__cause__ = RuntimeError("SENTINEL_SECRET")
                native_write = lab_controller.atomic_write

                def retain(path, content):
                    if path.name == "checkpoint-diagnostics.json" and retention_fails:
                        raise OSError("SENTINEL_RETENTION_FAILURE")
                    native_write(path, content)

                with patch.dict(os.environ, {}, clear=True), \
                        patch.object(lab_controller, "JournalStore"), \
                        patch.object(lab_controller, "context", return_value=binding), \
                        patch.object(lab_controller, "recheck_context"), \
                        patch.object(lab_controller, "load_state", return_value={"tasks": []}), \
                        patch.object(lab_controller, "GitHub") as github, \
                        patch.object(lab_controller, "tick", side_effect=failure), \
                        patch.object(lab_controller, "atomic_write", side_effect=retain), \
                        patch("builtins.print"):
                    github.return_value.enabled.return_value = True
                    status = lab_controller.main([
                        "--repo", str(root), "--config", str(config), "--manifest", str(root / "queue.json"),
                        "--revision-file", str(revision), "--out", str(output),
                    ])
                result = json.loads(output.read_bytes())
                self.assertEqual(status, 1)
                self.assertEqual(result, {
                    "action": "stopped", "merge_mode": "manual", "reason": "state_write_failed",
                    "attention": [{"reason": str(failure)}], "state_sha": "a" * 40,
                })
                sidecar = root / "checkpoint-diagnostics.json"
                self.assertEqual(sidecar.exists(), not retention_fails)
                if sidecar.exists():
                    value = json.loads(sidecar.read_bytes())
                    self.assertTrue(validate_diagnostics(value))
                    self.assertEqual(value["checkpoint_stage"], "research_planner")
                    self.assertEqual(value["causal_chain"], ["state_write", "runtime"])
                    self.assertNotIn("SENTINEL", sidecar.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
