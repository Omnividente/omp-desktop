#!/usr/bin/env python3
"""Tests for vitest_proof.py.

The regression is verbatim from a real run: with the fix reverted the suite
printed ``Cannot find module './math'`` and reported ``numTotalTests: 0``, the
runner exited non-zero, and a gate that only looked at exit codes recorded that
crash as proof that a bug had existed. A crash asserts nothing.
"""
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vitest_proof import (  # noqa: E402
    STATUS_BEHAVIOURAL, STATUS_LOAD_ERROR, STATUS_NO_FAILURES, STATUS_UNUSABLE,
    classify, load_errors, main, read_report, verify,
)


def failing_report(**overrides) -> dict:
    base = {
        "numTotalTests": 2,
        "numFailedTests": 1,
        "numPassedTests": 1,
        "testResults": [{
            "name": "/repo/src/clock.test.ts",
            "status": "failed",
            "message": "",
            "assertionResults": [
                {"title": "rounds down", "status": "failed",
                 "failureMessages": ["AssertionError: expected 1 to be 2"]},
                {"title": "keeps zero", "status": "passed", "failureMessages": []},
            ],
        }],
    }
    base.update(overrides)
    return base


def passing_report(collected: int = 2) -> dict:
    return {
        "numTotalTests": collected,
        "numFailedTests": 0,
        "numPassedTests": collected,
        "testResults": [{
            "name": "/repo/src/clock.test.ts",
            "status": "passed",
            "message": "",
            "assertionResults": [
                {"title": "case " + str(index), "status": "passed", "failureMessages": []}
                for index in range(collected)
            ],
        }],
    }


def load_error_report() -> dict:
    """What Vitest actually reported once the new helper module was reverted."""
    return {
        "numTotalTests": 0,
        "numFailedTests": 0,
        "numPassedTests": 0,
        "numTotalTestSuites": 1,
        "testResults": [{
            "name": "/repo/src/clock.test.ts",
            "status": "failed",
            "message": "Error: Cannot find module './math' imported from /repo/src/clock.test.ts",
            "assertionResults": [],
        }],
    }


class ClassifyTest(unittest.TestCase):
    def test_a_real_assertion_failure_is_behavioural(self):
        result = classify(failing_report())
        self.assertEqual(result["status"], STATUS_BEHAVIOURAL)
        self.assertEqual(result["collected"], 2)
        self.assertEqual(result["failed"], 1)

    def test_a_missing_module_is_not_a_failing_test(self):
        result = classify(load_error_report())
        self.assertEqual(result["status"], STATUS_LOAD_ERROR)
        self.assertEqual(result["collected"], 0)
        self.assertTrue(result["load_errors"])
        self.assertIn("Cannot find module", result["load_errors"][0])

    def test_a_load_error_beats_collected_failures(self):
        report = failing_report()
        report["testResults"][0]["assertionResults"][0]["failureMessages"] = [
            "Error: Failed to resolve import \"./math\" from src/clock.test.ts",
        ]
        self.assertEqual(classify(report)["status"], STATUS_LOAD_ERROR)

    def test_a_green_run_has_no_failures(self):
        result = classify(passing_report(3))
        self.assertEqual(result["status"], STATUS_NO_FAILURES)
        self.assertEqual(result["collected"], 3)
        self.assertEqual(result["failed"], 0)

    def test_failures_are_counted_from_assertions_when_the_summary_is_absent(self):
        report = failing_report()
        report.pop("numFailedTests")
        self.assertEqual(classify(report)["failed"], 1)
        self.assertEqual(classify(report)["status"], STATUS_BEHAVIOURAL)

    def test_a_missing_report_is_unusable(self):
        result = classify(None)
        self.assertEqual(result["status"], STATUS_UNUSABLE)
        self.assertEqual(result["collected"], 0)

    def test_an_empty_run_with_no_suites_is_unusable(self):
        result = classify({"numTotalTests": 0, "testResults": []})
        self.assertEqual(result["status"], STATUS_UNUSABLE)

    def test_markers_are_matched_case_insensitively(self):
        report = {
            "numTotalTests": 0,
            "testResults": [{"message": "SyntaxError: Unexpected token", "assertionResults": []}],
        }
        self.assertTrue(load_errors(report))
        self.assertEqual(classify(report)["status"], STATUS_LOAD_ERROR)


class VerifyFailingFirstTest(unittest.TestCase):
    def test_a_behavioural_failure_proves_the_defect(self):
        result = verify(failing_report(), expect="fail", min_tests=1)
        self.assertTrue(result["ok"])

    def test_a_crash_is_not_a_failing_first_test(self):
        result = verify(load_error_report(), expect="fail", min_tests=1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], STATUS_LOAD_ERROR)

    def test_a_test_that_already_passes_proves_nothing(self):
        result = verify(passing_report(), expect="fail", min_tests=1)
        self.assertFalse(result["ok"])

    def test_too_few_collected_tests_is_not_a_proof(self):
        result = verify(failing_report(), expect="fail", min_tests=5)
        self.assertFalse(result["ok"])

    def test_a_missing_report_is_not_a_proof(self):
        result = verify(None, expect="fail", min_tests=1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], STATUS_UNUSABLE)
    def test_a_failed_hook_does_not_prove_a_regression(self):
        report = failing_report()
        report["testResults"][0]["assertionResults"][0]["failureMessages"] = [
            "Error: fixture setup failed",
        ]
        self.assertFalse(verify(report, expect="fail")["ok"])



class VerifyPassingAfterTest(unittest.TestCase):
    def test_a_green_run_of_the_same_size_passes(self):
        result = verify(passing_report(2), expect="pass", min_tests=2)
        self.assertTrue(result["ok"])

    def test_fewer_tests_than_before_is_refused(self):
        result = verify(passing_report(1), expect="pass", min_tests=2)
        self.assertFalse(result["ok"])

    def test_a_still_failing_run_is_refused(self):
        result = verify(failing_report(), expect="pass", min_tests=1)
        self.assertFalse(result["ok"])

    def test_a_crash_after_the_fix_is_refused(self):
        result = verify(load_error_report(), expect="pass", min_tests=1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], STATUS_LOAD_ERROR)

    def test_skipping_the_regression_after_the_fix_is_refused(self):
        report = passing_report(2)
        report["numPassedTests"] = 1
        report["numPendingTests"] = 1
        report["testResults"][0]["assertionResults"][1]["status"] = "pending"
        self.assertFalse(verify(report, expect="pass", min_tests=2)["ok"])

    def test_unhandled_errors_cannot_make_the_after_run_green(self):
        report = passing_report(2)
        report["success"] = False
        self.assertFalse(verify(report, expect="pass", min_tests=2)["ok"])

    def test_min_tests_never_drops_below_one(self):
        result = verify(passing_report(1), expect="pass", min_tests=0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["min_tests"], 1)


class ReadReportTest(unittest.TestCase):
    def test_a_missing_file_reads_as_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(read_report(Path(tmp) / "absent.json"))

    def test_broken_json_reads_as_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "report.json"
            path.write_text("{not json", encoding="utf-8")
            self.assertIsNone(read_report(path))


class MainTest(unittest.TestCase):
    def _run(self, report, *args):
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            out_path = Path(tmp) / "proof.json"
            output_path = Path(tmp) / "github_output"
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                code = main([
                    "--report", str(report_path), "--out", str(out_path),
                    "--github-output", str(output_path), *args,
                ])
            return (
                code,
                buffer.getvalue(),
                json.loads(out_path.read_text(encoding="utf-8")),
                output_path.read_text(encoding="utf-8"),
            )

    def test_a_proven_failure_exits_zero(self):
        code, stdout, written, outputs = self._run(failing_report(), "--expect", "fail")
        self.assertEqual(code, 0)
        self.assertTrue(written["ok"])
        self.assertNotIn("::error::", stdout)
        self.assertIn("proof_status=" + STATUS_BEHAVIOURAL, outputs)
        self.assertIn("proof_ok=true", outputs)

    def test_a_crash_exits_non_zero_and_says_why(self):
        code, stdout, written, outputs = self._run(load_error_report(), "--expect", "fail")
        self.assertEqual(code, 1)
        self.assertFalse(written["ok"])
        self.assertEqual(written["status"], STATUS_LOAD_ERROR)
        self.assertIn("::error::", stdout)
        self.assertIn("proof_ok=false", outputs)
        self.assertIn("proof_collected=0", outputs)

    def test_the_after_run_must_keep_every_test(self):
        code, _stdout, written, _outputs = self._run(
            passing_report(1), "--expect", "pass", "--min-tests", "2",
        )
        self.assertEqual(code, 1)
        self.assertFalse(written["ok"])

    def test_a_green_after_run_exits_zero(self):
        code, _stdout, written, _outputs = self._run(
            passing_report(2), "--expect", "pass", "--min-tests", "2",
        )
        self.assertEqual(code, 0)
        self.assertTrue(written["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
