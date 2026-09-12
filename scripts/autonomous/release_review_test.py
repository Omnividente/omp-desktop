#!/usr/bin/env python3
"""Exercise the downloadable report with real commits and real Git failures."""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("release_review.py")


class DownloadedReportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.repo = Path(cls.temporary.name)

        def git(*args):
            return subprocess.check_output(
                ["git", *args], cwd=cls.repo, text=True, stderr=subprocess.STDOUT,
            ).strip()

        def commit(message):
            git("add", "change.txt")
            git("-c", "user.name=Release Review Test", "-c", "user.email=test@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "--no-verify", "-qm", message)
            return git("rev-parse", "HEAD")

        git("-c", "init.templateDir=", "init", "--quiet", "--initial-branch=main")
        (cls.repo / "change.txt").write_text("before\n", encoding="utf-8")
        cls.base = commit("Baseline")
        (cls.repo / "change.txt").write_text("after\n", encoding="utf-8")
        cls.head = commit("Reviewed change")
        git("checkout", "--orphan", "unrelated", "--quiet")
        (cls.repo / "change.txt").write_text("unrelated\n", encoding="utf-8")
        cls.unrelated = commit("Unrelated history")

    def report(self, *extra):
        output = self.repo / "release-review.md"
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--base", "main", "--head", "main",
             "--base-sha", self.base, "--head-sha", self.head,
             "--out", str(output), *extra],
            cwd=self.repo, text=True, capture_output=True, check=False,
        )
        return result, output.read_text(encoding="utf-8")

    def assert_unverified(self, report):
        self.assertIn("NOT VERIFIED", report)
        self.assertNotIn("- [x]", report)

    def test_only_success_on_the_exact_reviewed_commit_checks_verification(self):
        result, report = self.report("--verify-result", "success", "--verified-sha", self.head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("NOT VERIFIED", report)
        self.assertIn("- [x]", report)
        self.assertIn(self.head, report)
        self.assertIn("Reviewed change", report)

    def test_missing_or_other_verified_commit_never_claims_success(self):
        for verified in ("", self.base):
            with self.subTest(verified=verified):
                result, report = self.report(
                    "--verify-result", "success", "--verified-sha", verified,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_unverified(report)

    def test_unsuccessful_verification_stays_blocked_even_with_matching_sha(self):
        for conclusion in ("failure", "skipped", "cancelled", "none"):
            with self.subTest(conclusion=conclusion):
                result, report = self.report(
                    "--verify-result", conclusion, "--verified-sha", self.head,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_unverified(report)

    def test_unresolvable_revisions_replace_a_previous_green_report_and_fail(self):
        for revision in (
            ("--base-sha", "f" * 40),
            ("--head-sha", "f" * 40),
            ("--head-sha", "", "--head", "missing-branch"),
        ):
            with self.subTest(revision=revision):
                self.report("--verify-result", "success", "--verified-sha", self.head)
                result, report = self.report(
                    "--verify-result", "success", "--verified-sha", self.head, *revision,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assert_unverified(report)

    def test_resolved_commits_with_an_unreadable_diff_do_not_produce_a_green_report(self):
        result, report = self.report(
            "--verify-result", "success", "--verified-sha", self.unrelated,
            "--head-sha", self.unrelated,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assert_unverified(report)


if __name__ == "__main__":
    unittest.main(verbosity=2)
