#!/usr/bin/env python3
"""Regression boundaries for provenance-bound human proposal reports."""
from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from proposal_review import decide, main, render_report

ROOT = Path(__file__).resolve().parents[2]
SHA = "a" * 40
NEXT_SHA = "b" * 40
LAB_SHA = "d" * 40
REPOSITORY = "Omnividente/omp-desktop"


def fixture():
    config = json.loads((ROOT / "autonomous-project.json").read_text(encoding="utf-8"))
    pr = {"number": 59, "html_url": "https://github.com/" + REPOSITORY + "/pull/59",
          "state": "open", "draft": False, "merged": False, "changed_files": 2,
          "labels": [], "user": {"login": "Omnividente"},
          "base": {"ref": "autonomous/lab", "sha": "c" * 40, "repo": {"full_name": REPOSITORY}},
          "head": {"ref": "jules/clock-fix", "sha": SHA, "repo": {"full_name": REPOSITORY}}}
    receipt = {"session_id": "sessions/123", "dispatch_key": "clock-attempt-1",
               "pull_request": 59, "url": pr["html_url"], "repository": REPOSITORY,
               "base_branch": "autonomous/lab", "head_repository": REPOSITORY,
               "head_ref": "jules/clock-fix", "head_sha": SHA,
               "verified_at": "2026-09-13T00:00:00Z"}
    task = {"id": "clock-fix", "status": "blocked", "execution": {
        "session_id": receipt["session_id"], "dispatch_key": receipt["dispatch_key"],
        "pull_request": 59, "provenance": receipt}}
    checks = [{"id": index, "name": name, "head_sha": SHA, "app": {"id": 15368},
               "status": "completed", "conclusion": "success",
               "html_url": "https://github.com/" + REPOSITORY + "/actions/runs/" + str(index)}
              for index, name in enumerate(config["merge_gate"]["required_check_names"]
                                           + [config["merge_gate"]["evidence_check_name"]], 1)]
    return {"pull_request": pr, "config": config, "manifest": {"version": 2, "tasks": [task]},
            "ci_sha": SHA, "files_sha": SHA, "expected_file_count": 2,
            "lab_sha": LAB_SHA, "comparison": {"base_commit": {"sha": LAB_SHA}, "status": "ahead"},
            "file_entries": [{"filename": "src/clock.ts"}, {"filename": "src/clock.test.ts"}],
            "checks": checks, "approvals": []}


def approval(sha=SHA, state="APPROVED", login="Omnividente", identifier=1):
    return {"id": identifier, "user": {"login": login}, "commit_id": sha, "state": state}


class ReviewTest(unittest.TestCase):
    def setUp(self):
        self.args = fixture()

    def review(self):
        return decide(**self.args)

    def test_green_proposal_is_only_ready_for_human_acceptance(self):
        result = self.review()
        self.assertEqual(result["decision"], "ready_for_review")
        self.assertEqual(result["acceptance"], "manual")
        self.assertTrue(result["proof_established"])
        self.assertEqual(result["links"]["revision"], "https://github.com/" + REPOSITORY + "/commit/" + SHA)


    def test_missing_or_unbound_lab_ancestry_blocks_even_with_owner_approval(self):
        for lab_sha, comparison in (
                ("", {"base_commit": {"sha": LAB_SHA}, "status": "ahead"}),
                (LAB_SHA, None),
                (LAB_SHA, {}),
                (LAB_SHA, {"base_commit": {"sha": SHA}, "status": "ahead"}),
                (LAB_SHA, {"base_commit": {"sha": LAB_SHA}, "status": "unknown"})):
            with self.subTest(lab_sha=lab_sha, comparison=comparison):
                self.args = fixture()
                self.args.update(lab_sha=lab_sha, comparison=comparison, approvals=[approval()])
                self.assertEqual(self.review()["decision"], "blocked")

    def test_new_lab_commit_invalidates_readiness_without_a_proposal_push(self):
        self.assertEqual(self.review()["decision"], "ready_for_review")
        self.args["lab_sha"] = NEXT_SHA
        self.assertEqual(self.review()["decision"], "blocked")
        for status in ("behind", "diverged"):
            with self.subTest(status=status):
                self.args["comparison"] = {"base_commit": {"sha": NEXT_SHA}, "status": status}
                self.args["approvals"] = [approval()]
                self.assertEqual(self.review()["decision"], "blocked")

    def test_identical_lab_ancestry_is_current_despite_historical_rest_base(self):
        self.args["lab_sha"] = SHA
        self.args["comparison"] = {"base_commit": {"sha": SHA}, "status": "identical"}
        result = self.review()
        self.assertEqual(result["decision"], "ready_for_review")
        self.assertEqual(result["lab_sha"], SHA)
    def test_owner_author_and_task_marker_do_not_establish_provenance(self):
        self.args["manifest"]["tasks"][0]["execution"].pop("provenance")
        self.args["pull_request"]["body"] = "AUTONOMOUS_TASK_ID: clock-fix"
        result = self.review()
        self.assertEqual(result["decision"], "blocked")
        self.assertFalse(result["provenance_verified"])

    def test_foreign_session_or_ambiguous_receipt_is_blocked(self):
        for field in ("session_id", "dispatch_key", "pull_request"):
            with self.subTest(field=field):
                self.args = fixture()
                self.args["manifest"]["tasks"][0]["execution"][field] = "foreign"
                self.assertEqual(self.review()["decision"], "blocked")
        self.args = fixture()
        self.args["manifest"]["tasks"].append(copy.deepcopy(self.args["manifest"]["tasks"][0]))
        self.assertEqual(self.review()["decision"], "blocked")

    def test_fork_wrong_base_and_changed_head_ref_are_not_trusted(self):
        for part, key, value in (("base", "ref", "main"), ("head", "ref", "unrelated"),
                                 ("head", "repo", {"full_name": "other/fork"})):
            with self.subTest(part=part, key=key):
                self.args = fixture()
                self.args["pull_request"][part][key] = value
                self.assertEqual(self.review()["decision"], "blocked")

    def test_current_head_can_advance_but_all_inputs_must_follow_it(self):
        self.args["pull_request"]["head"]["sha"] = NEXT_SHA
        self.assertEqual(self.review()["decision"], "blocked")
        self.args.update(ci_sha=NEXT_SHA, files_sha=NEXT_SHA)
        for check in self.args["checks"]:
            check["head_sha"] = NEXT_SHA
        self.assertEqual(self.review()["decision"], "ready_for_review")

    def test_files_from_another_revision_are_never_approved_away(self):
        self.args["files_sha"] = NEXT_SHA
        self.args["approvals"] = [approval()]
        self.assertEqual(self.review()["decision"], "blocked")

    def test_truncated_duplicate_and_malformed_rename_lists_are_blocked(self):
        bad_lists = [[{"filename": "src/clock.ts"}],
                     [{"filename": "src/clock.ts"}, {"filename": "src/clock.ts"}],
                     [{"filename": "src/clock.ts"}, {"filename": "src/new.ts", "status": "renamed"}]]
        for entries in bad_lists:
            with self.subTest(entries=entries):
                self.args = fixture()
                self.args["file_entries"] = entries
                self.args["approvals"] = [approval()]
                result = self.review()
                self.assertEqual(result["decision"], "blocked")
                self.assertFalse(result["changed_files_complete"])

    def test_unknown_or_disagreeing_file_total_is_blocked(self):
        for count in (None, 0, 1, 3):
            with self.subTest(count=count):
                self.args["expected_file_count"] = count
                self.assertEqual(self.review()["decision"], "blocked")

    def test_renamed_guardrail_remains_a_hard_boundary(self):
        self.args["file_entries"][0].update(status="renamed", previous_filename="scripts/autonomous/proposal_review.py")
        self.args["approvals"] = [approval()]
        result = self.review()
        self.assertEqual(result["decision"], "blocked")
        self.assertIn("scripts/autonomous/proposal_review.py", [v["path"] for v in result["violations"]])

    def test_large_complete_diff_needs_current_owner_review(self):
        self.args["config"]["merge_gate"]["max_changed_files"] = 1
        self.assertEqual(self.review()["decision"], "manual_review")
        self.args["approvals"] = [approval()]
        result = self.review()
        self.assertEqual(result["decision"], "ready_for_review")
        self.assertTrue(result["review_reasons"])

    def test_missing_foreign_or_old_sha_checks_block_even_with_owner_approval(self):
        for target in (0, -1):
            for alteration in ("missing", "foreign", "old_sha", "pending"):
                with self.subTest(target=target, alteration=alteration):
                    self.args = fixture()
                    self.args["approvals"] = [approval()]
                    if alteration == "missing":
                        self.args["checks"].pop(target)
                    elif alteration == "foreign":
                        self.args["checks"][target]["app"]["id"] = 999
                    elif alteration == "old_sha":
                        self.args["checks"][target]["head_sha"] = NEXT_SHA
                    else:
                        self.args["checks"][target]["status"] = "in_progress"
                    self.assertEqual(self.review()["decision"], "blocked")

    def test_foreign_same_name_run_cannot_mask_or_borrow_trusted_success(self):
        forged = copy.deepcopy(self.args["checks"][0])
        forged.update(id=100, app={"id": 999})
        self.args["checks"].append(forged)
        self.assertEqual(self.review()["decision"], "blocked")

    def test_latest_rerun_wins_over_old_green_result(self):
        rerun = copy.deepcopy(self.args["checks"][0])
        rerun.update(id=100, status="in_progress", conclusion=None)
        self.args["checks"].insert(0, rerun)
        self.assertEqual(self.review()["decision"], "blocked")
        rerun.update(status="completed", conclusion="success")
        self.assertEqual(self.review()["decision"], "ready_for_review")

    def test_quality_failure_cannot_be_waived_by_owner(self):
        self.args["checks"][0]["conclusion"] = "failure"
        self.args["approvals"] = [approval()]
        self.assertEqual(self.review()["decision"], "blocked")

    def test_unproven_evidence_is_a_retained_manual_risk(self):
        self.args["checks"][-1]["conclusion"] = "failure"
        self.assertEqual(self.review()["decision"], "manual_review")
        self.args["approvals"] = [approval()]
        result = self.review()
        self.assertEqual(result["decision"], "ready_for_review")
        self.assertFalse(result["proof_established"])
        self.assertTrue(result["review_reasons"])

    def test_test_only_is_manual_even_if_evidence_check_claims_success(self):
        self.args["file_entries"] = [{"filename": "src/clock.test.ts"}]
        self.args["expected_file_count"] = self.args["pull_request"]["changed_files"] = 1
        result = self.review()
        self.assertEqual(result["decision"], "manual_review")
        self.assertFalse(result["proof_established"])
        self.args["approvals"] = [approval()]
        self.assertEqual(self.review()["decision"], "ready_for_review")

    def test_new_updater_name_and_old_name_both_require_owner(self):
        for previous, filename in (("src-tauri/src/update.rs", "src/clock.ts"),
                                   ("src/clock.ts", "src-tauri/src/update.rs")):
            with self.subTest(previous=previous):
                self.args = fixture()
                self.args["file_entries"][0].update(filename=filename, status="renamed", previous_filename=previous)
                self.assertEqual(self.review()["decision"], "manual_review")

    def test_label_stale_approval_nonowner_and_dismissal_do_not_clear_risk(self):
        self.args["checks"][-1]["conclusion"] = "failure"
        self.args["pull_request"]["labels"] = [{"name": "approved-by-owner"}]
        for reviews in ([], [approval(NEXT_SHA)], [approval(login="outsider")],
                        [approval(), approval(state="DISMISSED", identifier=2)],
                        [approval(), approval(state="CHANGES_REQUESTED", identifier=2)]):
            with self.subTest(reviews=reviews):
                self.args["approvals"] = reviews
                self.assertNotEqual(self.review()["decision"], "ready_for_review")

    def test_closed_draft_or_held_proposal_is_not_ready(self):
        for change in ({"state": "closed"}, {"draft": True}, {"labels": [{"name": "hold"}]}):
            with self.subTest(change=change):
                self.args = fixture()
                self.args["pull_request"].update(change)
                self.assertEqual(self.review()["decision"], "blocked")

    def test_report_is_idempotent_and_retains_revision_and_check_links(self):
        before = copy.deepcopy(self.args)
        report = render_report(self.review())
        self.assertEqual(report, render_report(self.review()))
        self.assertEqual(self.args, before)
        self.assertIn("<!-- autonomous-proposal-review:" + SHA + " -->", report)
        self.assertIn(self.args["checks"][0]["html_url"], report)
        self.assertIn(LAB_SHA, report)

    def test_cli_persists_actionable_report_for_blocked_inputs(self):
        self.args["checks"] = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            argv = []
            for flag, key in (("pr-json", "pull_request"), ("config", "config"),
                              ("manifest", "manifest"), ("pr-files", "file_entries"),
                              ("checks", "checks"), ("approvals", "approvals"),
                              ("comparison-json", "comparison")):
                path = root / (flag + ".json")
                path.write_text(json.dumps(self.args[key]), encoding="utf-8")
                argv.extend(["--" + flag, str(path)])
            decision, report = root / "decision.json", root / "report.txt"
            argv.extend(["--ci-sha", SHA, "--files-sha", SHA, "--lab-sha", LAB_SHA, "--expected-file-count", "2",
                         "--decision-out", str(decision), "--report-out", str(report)])
            self.assertEqual(main(argv), 0)
            self.assertEqual(json.loads(decision.read_text())["decision"], "blocked")
            self.assertIn(SHA, report.read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
