#!/usr/bin/env python3
"""Classify a Vitest JSON report so "it failed first" means something.

A non-zero exit code from a test runner is not evidence of a defect. A missing
import, a broken module graph or a syntax error also make Vitest fail while
asserting nothing at all - and that is exactly what an innocent refactor looks
like to the evidence gate: revert the source, the brand-new helper module
disappears, the suite cannot even load, and a naive gate reads the crash as
proof that a bug existed.

So the proof has explicit requirements:

* the "before" run must collect at least one test and fail on a real assertion,
  with no module-loading error anywhere in the report;
* the "after" run must collect at least as many tests and fail none.

Anything else is not a proof, and the gate says so instead of passing.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping

STATUS_BEHAVIOURAL = "behavioural_failure"
STATUS_LOAD_ERROR = "load_error"
STATUS_NO_FAILURES = "no_failures"
STATUS_UNUSABLE = "unusable"

# Substrings that mean "the test never really ran". Matched case-insensitively
# against suite messages and assertion failure messages.
LOAD_ERROR_MARKERS = (
    "cannot find module",
    "cannot find package",
    "failed to resolve import",
    "failed to load url",
    "failed to load config",
    "does not provide an export named",
    "transform failed",
    "syntaxerror",
    "module not found",
    "no test files found",
    "no test suite found",
    "error: could not resolve",
)


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def messages(report: Mapping[str, Any]) -> list:
    """Every failure message in the report, suite level and assertion level."""
    found = []
    for suite in report.get("testResults") or []:
        if not isinstance(suite, dict):
            continue
        text = str(suite.get("message") or "").strip()
        if text:
            found.append(text)
        for assertion in suite.get("assertionResults") or []:
            if not isinstance(assertion, dict):
                continue
            for item in assertion.get("failureMessages") or []:
                text = str(item or "").strip()
                if text:
                    found.append(text)
    return found


def load_errors(report: Mapping[str, Any]) -> list:
    hits = []
    for text in messages(report):
        lowered = text.lower()
        for marker in LOAD_ERROR_MARKERS:
            if marker in lowered:
                hits.append(text.splitlines()[0][:300])
                break
    return hits


def failed_assertions(report: Mapping[str, Any]) -> int:
    total = 0
    for suite in report.get("testResults") or []:
        if not isinstance(suite, dict):
            continue
        for assertion in suite.get("assertionResults") or []:
            if not isinstance(assertion, dict) or assertion.get("status") != "failed":
                continue
            if any(
                "AssertionError" in str(message) or "Error: Snapshot" in str(message)
                for message in assertion.get("failureMessages") or []
            ):
                total += 1
    return total


def classify(report: Any) -> dict:
    if not isinstance(report, dict):
        return {
            "status": STATUS_UNUSABLE, "collected": 0, "failed": 0, "passed": 0,
            "load_errors": [], "detail": "the report is missing or is not a Vitest JSON report",
        }
    collected = _int(report.get("numTotalTests"))
    failed = _int(report.get("numFailedTests")) or failed_assertions(report)
    passed = _int(report.get("numPassedTests"))
    errors = load_errors(report)

    if collected == 0:
        status = STATUS_LOAD_ERROR if errors or report.get("testResults") else STATUS_UNUSABLE
        detail = (
            "no test was collected, so nothing was asserted"
            + ((": " + errors[0]) if errors else "")
        )
    elif errors:
        status = STATUS_LOAD_ERROR
        detail = "the run hit a module-loading error, not a behavioural failure: " + errors[0]
    elif failed == 0:
        status = STATUS_NO_FAILURES
        detail = str(collected) + " test(s) collected, none failed"
    elif not failed_assertions(report):
        status = STATUS_UNUSABLE
        detail = "tests failed without an assertion failure (for example a hook or runtime exception)"
    else:
        status = STATUS_BEHAVIOURAL
        detail = str(failed) + " of " + str(collected) + " collected test(s) failed on an assertion"

    return {
        "status": status, "collected": collected, "failed": failed, "passed": passed,
        "load_errors": errors, "detail": detail,
    }


def verify(report: Any, *, expect: str, min_tests: int = 1) -> dict:
    result = classify(report)
    floor = max(1, _int(min_tests))
    result["expect"] = expect
    result["min_tests"] = floor
    if expect == "fail":
        result["ok"] = (
            result["status"] == STATUS_BEHAVIOURAL and result["collected"] >= floor
        )
        if not result["ok"]:
            if result["status"] == STATUS_NO_FAILURES:
                result["explanation"] = (
                    "The test passes without the fix, so it does not prove that anything "
                    "was broken. Write a test that fails on the base revision."
                )
            elif result["status"] in (STATUS_LOAD_ERROR, STATUS_UNUSABLE):
                result["explanation"] = (
                    "Without the fix the suite could not run at all (" + result["detail"]
                    + "). A crash is not a failing-first test: the proof must be a real "
                    "assertion about behaviour, on code that still loads at the base revision."
                )
            else:
                result["explanation"] = (
                    "Expected at least " + str(floor) + " collected test(s) failing on an "
                    "assertion, got: " + result["detail"]
                )
        else:
            result["explanation"] = "Proven to fail without the fix: " + result["detail"]
    else:
        result["ok"] = (
            result["status"] == STATUS_NO_FAILURES
            and result["passed"] == result["collected"]
            and result["passed"] >= floor
            and report.get("success") is not False
        )
        if not result["ok"]:
            result["explanation"] = (
                "With the fix applied the same tests must all pass and at least "
                + str(floor) + " of them must run; got: " + result["detail"]
            )
        else:
            result["explanation"] = "Passes with the fix: " + result["detail"]
    return result


def read_report(path: Path) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--expect", required=True, choices=["fail", "pass"])
    parser.add_argument("--min-tests", type=int, default=1)
    parser.add_argument("--out", type=Path,
                        help="write the verdict as JSON here; stdout stays human-readable")
    parser.add_argument("--github-output", default="")
    args = parser.parse_args(argv)

    result = verify(read_report(args.report), expect=args.expect, min_tests=args.min_tests)
    if args.out:
        args.out.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            handle.write("proof_status=" + str(result["status"]) + "\n")
            handle.write("proof_collected=" + str(result["collected"]) + "\n")
            handle.write("proof_failed=" + str(result["failed"]) + "\n")
            handle.write("proof_ok=" + ("true" if result["ok"] else "false") + "\n")
    if not result["ok"]:
        print("::error::" + result["explanation"])
        return 1
    print(result["explanation"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
