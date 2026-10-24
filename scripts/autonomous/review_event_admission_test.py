#!/usr/bin/env python3
"""Review ingress, freshness and persisted-identity boundaries on synthetic data."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from dispatch_integration_test import task
from jules_provenance import bind_proposal
from review_event_admission import admit_review, candidate_prs, main
from task_lifecycle import reserve, start
from workflow_admission_test import CallbackSource, REPOSITORY, CONTROL

EVIDENCE = "autonomous_evidence_gate.yml"
HEAD = "b" * 40
NOW = datetime(2026, 10, 1, tzinfo=timezone.utc)
CONFIG = {"repository": REPOSITORY, "merge_gate": {"owner_approvers": ["owner"]}}
REPO = {"id": 701, "full_name": REPOSITORY, "default_branch": "main"}


class ReviewSource(CallbackSource):
    def __init__(self):
        super().__init__(EVIDENCE, event="pull_request")
        self.pr = {"number": 7, "html_url": "https://github.com/" + REPOSITORY + "/pull/7",
                   "state": "open", "merged": False, "draft": False, "changed_files": 2,
                   "base": {"ref": "autonomous/lab", "sha": "c" * 40, "repo": copy.deepcopy(REPO)},
                   "head": {"ref": "jules/clock", "sha": HEAD, "repo": copy.deepcopy(REPO)}}
        for run in (self.source, self.attempt, self.current):
            run.update(head_branch=self.pr["head"]["ref"], pull_requests=[{"number": 7}])
        self.event = {"action": "completed", "repository": copy.deepcopy(REPO), "workflow_run": self.source}
        self.responses["pulls/7"] = self.pr
        self.responses["pulls?state=open&base=autonomous/lab&per_page=100&page=1"] = [{"number": 7}]

    def review(self, event_name="workflow_run", *, actor="owner", **kwargs):
        return admit_review(event_name, self.event, CONFIG, actor=actor, get=self.get, **kwargs)


def saved_proposal(pr):
    value = task("clock")
    data = {"version": 2, "autonomous_loop_policy": {}, "tasks": [value]}
    key = "a" * 24
    branch = "autonomous/attempt-" + key
    reserve(data, "clock", key, base_sha="c" * 40, starting_branch=branch, now=NOW)
    start(data, "clock", session_id="7", dispatch_key=key, now=NOW)
    session = {"id": "7", "name": "sessions/7", "state": "COMPLETED",
               "title": "[dispatch:" + key + "] Synthetic clock",
               "sourceContext": {"source": "sources/github/" + REPOSITORY,
                                 "githubRepoContext": {"startingBranch": branch}},
               "outputs": [{"pullRequest": {"url": pr["html_url"]}}]}
    bind_proposal(data, "clock", session, pr, repository=REPOSITORY, now=NOW)
    return data


class ReviewAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.source = ReviewSource()
        self.data = saved_proposal(self.source.pr)

    def test_real_evidence_selects_only_its_exact_current_persisted_proposal(self):
        before = copy.deepcopy(self.data)
        first = self.source.review(manifest=self.data)
        self.assertEqual(first["pull_requests"], [{"number": 7, "head_sha": HEAD, "head_ref": "jules/clock"}])
        self.assertTrue(first["admitted"])
        self.assertEqual((first["source_run_id"], first["source_run_attempt"]), (501, 1))
        self.assertEqual(self.source.review(manifest=self.data), first)
        self.assertEqual(self.data, before)
        self.assertFalse(any(path.startswith("pulls?") for path in self.source.reads))

    def test_failed_or_cancelled_evidence_is_a_review_signal_not_a_ready_claim(self):
        for conclusion in ("success", "failure", "cancelled", "skipped"):
            with self.subTest(conclusion=conclusion):
                for run in (self.source.source, self.source.attempt, self.source.current):
                    run["conclusion"] = conclusion
                self.assertTrue(self.source.review(manifest=self.data)["admitted"])
        # Readiness still comes from proposal_review.decide and its exact checks.

    def test_dot_main_quality_and_review_events_never_scan_or_fall_back(self):
        self.source.pr["base"]["ref"] = "main"
        self.source.pr["head"]["ref"] = "dot/synthetic-clock"
        for event_name in ("pull_request", "pull_request_review", "workflow_run"):
            with self.subTest(event_name=event_name):
                self.source.reads.clear()
                self.source.source["name"] = "Quality Gate"
                with self.assertRaises(ValueError):
                    self.source.review(event_name)
                self.assertEqual(self.source.reads, [])

    def test_stale_head_retarget_closed_and_fork_are_refused_without_scan(self):
        cases = (("head", "sha", "d" * 40), ("head", "ref", "jules/replacement"),
                 ("base", "ref", "main"), ("head", "repo", {"id": 999, "full_name": "foreign/fork"}))
        for side, field, value in cases:
            with self.subTest(side=side, field=field):
                source = ReviewSource()
                source.pr[side][field] = value
                with self.assertRaises(ValueError):
                    source.review(manifest=self.data)
                self.assertFalse(any(path.startswith("pulls?") for path in source.reads))
        self.source.pr["state"] = "closed"
        with self.assertRaises(ValueError):
            self.source.review(manifest=self.data)

    def test_missing_duplicate_or_wrong_pr_association_never_scans(self):
        for associations in (None, [], [{"number": 7}, {"number": 8}], [{"number": True}], [{"number": 8}]):
            with self.subTest(associations=associations):
                source = ReviewSource()
                source.attempt["pull_requests"] = associations
                with self.assertRaises((ValueError, KeyError)):
                    source.review(manifest=self.data)
                self.assertFalse(any(path.startswith("pulls?") for path in source.reads))

    def test_spoofed_actor_markers_and_double_persisted_identity_cannot_take_lock(self):
        self.source.pr.update(user={"login": "owner"}, labels=[{"name": "approved-by-owner"}],
                              body="AUTONOMOUS_TASK_ID: clock")
        for data in ({"tasks": []}, {"tasks": [copy.deepcopy(self.data["tasks"][0])] * 2}):
            with self.subTest(tasks=len(data["tasks"])), self.assertRaises(ValueError):
                self.source.review(manifest=data)
        wrong = copy.deepcopy(self.data)
        wrong["tasks"][0]["execution"]["dispatch_key"] = "foreign"
        with self.assertRaises(ValueError):
            self.source.review(manifest=wrong)

    def test_schedule_and_owner_manual_scan_paginated_lab_without_unknown_pr_starvation(self):
        for event_name in ("schedule", "workflow_dispatch"):
            with self.subTest(event_name=event_name):
                source = ReviewSource()
                page = "pulls?state=open&base=autonomous/lab&per_page=100&page="
                source.responses[page + "1"] = [{"number": number} for number in range(1, 101)]
                source.responses[page + "2"] = [{"number": 101}]
                for number in range(1, 102):
                    pr = copy.deepcopy(source.pr)
                    pr.update(number=number, html_url="https://github.com/" + REPOSITORY + "/pull/" + str(number))
                    source.responses["pulls/" + str(number)] = pr
                source.responses["pulls/2"]["head"]["repo"] = {"id": 999, "full_name": "foreign/fork"}
                source.responses["pulls/3"]["base"]["ref"] = "main"
                source.responses["pulls/4"]["state"] = "closed"
                result = source.review(event_name, manifest=self.data)
                self.assertEqual(result["pull_requests"], [{"number": 7, "head_sha": HEAD, "head_ref": "jules/clock"}])
                self.assertIn(page + "2", source.reads)
                self.assertNotIn("actions/runs/501", source.reads)
        with self.assertRaises(ValueError):
            self.source.review("workflow_dispatch", actor="not-owner")
        self.assertEqual(self.source.reads, [])

    def test_deleted_fork_and_missing_repository_do_not_starve_saved_lab_proposal(self):
        for event_name in ("schedule", "workflow_dispatch"):
            for repository in (None, {}, {"full_name": REPOSITORY},
                               {"id": 999, "full_name": REPOSITORY}):
                with self.subTest(event=event_name, repository=repository):
                    source = ReviewSource()
                    foreign = copy.deepcopy(source.pr)
                    foreign.update(number=8, html_url="https://github.com/" + REPOSITORY + "/pull/8")
                    foreign["head"]["repo"] = repository
                    source.responses["pulls/8"] = foreign
                    source.responses["pulls?state=open&base=autonomous/lab&per_page=100&page=1"] = [
                        {"number": 7}, {"number": 8}]
                    result = source.review(event_name, manifest=self.data)
                    self.assertEqual(result["pull_requests"],
                                     [{"number": 7, "head_sha": HEAD, "head_ref": "jules/clock"}])
                    source.pr["head"]["repo"] = repository
                    with self.assertRaises(ValueError):
                        source.review(manifest=self.data)

    def test_pagination_repetition_incomplete_response_and_api_failure_fail_closed(self):
        page = "pulls?state=open&base=autonomous/lab&per_page=100&page="
        for bad in ({}, [{"number": 7}] * 100, [{"number": True}], RuntimeError("403 synthetic")):
            with self.subTest(bad=type(bad).__name__):
                self.source.responses[page + "1"] = bad
                with self.assertRaises((ValueError, RuntimeError)):
                    self.source.review("schedule", manifest=self.data)
        source = ReviewSource()
        source.responses[page + "1"] = [{"number": n} for n in range(1, 101)]
        source.responses[page + "2"] = RuntimeError("page two unavailable")
        with self.assertRaises(RuntimeError):
            source.review("schedule", manifest=self.data)
        self.assertFalse(any(path.startswith("pulls/") for path in source.reads))
        self.source.responses["pulls/7"] = {**self.source.pr, "number": 8}
        with self.assertRaises(ValueError):
            self.source.review()

    def test_wait_revalidation_rejects_head_race_and_cannot_expand_scan(self):
        selected = self.source.review("schedule", manifest=self.data)["pull_requests"]
        self.source.responses["pulls?state=open&base=autonomous/lab&per_page=100&page=1"] = RuntimeError("must not rescan")
        self.source.reads.clear()
        self.assertEqual(self.source.review("schedule", expected=selected, manifest=self.data)["pull_requests"], selected)
        self.assertEqual(self.source.reads, ["pulls/7"])
        self.source.pr["head"]["sha"] = "e" * 40
        with self.assertRaises(ValueError):
            self.source.review("schedule", expected=selected, manifest=self.data)

    def test_wait_revalidation_withdraws_subject_if_saved_provenance_disappears(self):
        selected = self.source.review("schedule", manifest=self.data)["pull_requests"]
        result = self.source.review("schedule", expected=selected, manifest={"tasks": []})
        self.assertFalse(result["admitted"])
        self.assertEqual(result["pull_requests"], [])
        with self.assertRaises(ValueError):
            self.source.review(expected=selected, manifest={"tasks": []})

    def test_head_sha_and_selection_require_json_strings_not_numeric_coercion(self):
        for value in (int("1" * 40), True, None, [], {}):
            with self.subTest(value=value):
                source = ReviewSource()
                source.pr["head"]["sha"] = value
                with self.assertRaises(ValueError):
                    source.review("schedule")
                selected = [{"number": 7, "head_sha": value, "head_ref": "jules/clock"}]
                source.reads.clear()
                with self.assertRaises(ValueError):
                    source.review("schedule", expected=selected)
                self.assertEqual(source.reads, [])

    def test_unknown_and_ambiguous_saved_subjects_do_not_queue_scheduled_report(self):
        for data in ({"tasks": []}, {"tasks": self.data["tasks"] * 2}):
            with self.subTest(tasks=len(data["tasks"])):
                result = self.source.review("schedule", manifest=data)
                self.assertFalse(result["admitted"])
                self.assertEqual(result["pull_requests"], [])

    def test_numeric_repository_identity_and_unknown_data_are_not_name_auth(self):
        for value in (True, "701", 999, None):
            with self.subTest(value=value):
                source = ReviewSource()
                source.pr["head"]["repo"]["id"] = value
                with self.assertRaises(ValueError):
                    source.review()
        self.source.event["repository"]["id"] = 999
        with self.assertRaises(ValueError):
            self.source.review()


class ReviewCLITest(unittest.TestCase):
    def test_cli_has_no_state_reads_on_bad_ingress_and_does_not_leak_partial_admission(self):
        source = ReviewSource()
        with tempfile.TemporaryDirectory(prefix="dot-review-cli-") as temporary:
            root = Path(temporary)
            config, event, out, outputs, manifest = [root / name for name in
                                                    ("config.json", "event.json", "out.json", "outputs", "queue.json")]
            config.write_text(json.dumps(CONFIG), encoding="utf-8")
            event.write_text(json.dumps(source.event), encoding="utf-8")
            manifest.write_text(json.dumps(saved_proposal(source.pr)), encoding="utf-8")
            before = manifest.read_bytes()
            environment = {"GITHUB_EVENT_NAME": "workflow_run", "GITHUB_EVENT_PATH": str(event),
                           "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": CONTROL,
                           "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_ACTOR": "owner",
                           "GITHUB_RUN_ID": "81", "GITHUB_RUN_ATTEMPT": "1",
                           "GITHUB_WORKFLOW_REF": REPOSITORY + "/.github/workflows/autonomous_review.yml@refs/heads/main"}
            args = ["--config", str(config), "--out", str(out), "--manifest", str(manifest),
                    "--github-output", str(outputs)]
            with patch.dict(os.environ, environment, clear=True), \
                    patch("review_event_admission.control_revision", return_value=CONTROL), \
                    patch("review_event_admission.gh_get", side_effect=lambda _, path: source.get(path)):
                self.assertEqual(main(args), 0)
                self.assertTrue(json.loads(out.read_bytes())["admitted"])
                self.assertEqual(manifest.read_bytes(), before)
                source.source["name"] = "Quality Gate"
                event.write_text(json.dumps(source.event), encoding="utf-8")
                with patch("state_store._manifest", side_effect=AssertionError("bad ingress must not read state")):
                    self.assertEqual(main(args), 1)
                self.assertFalse(json.loads(out.read_bytes())["admitted"])
                source.source["name"] = "Autonomous Evidence Gate"
                event.write_text(json.dumps(source.event), encoding="utf-8")
                manifest.write_text("{}", encoding="utf-8")
                self.assertEqual(main(args), 1)
                self.assertFalse(json.loads(out.read_bytes())["admitted"])
                self.assertNotIn("control_sha", json.loads(out.read_bytes()))
                os.environ.update(GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_ACTOR="not-owner")
                source.reads.clear()
                with patch("state_store._manifest", side_effect=AssertionError("nonowner must not read state")):
                    self.assertEqual(main(args), 1)
                self.assertFalse(json.loads(out.read_bytes())["admitted"])
                self.assertEqual(source.reads, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
