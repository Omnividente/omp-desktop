#!/usr/bin/env python3
"""Observable completion, ownership, pagination, and transactional regressions."""
from __future__ import annotations

import copy
import hashlib
import json
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from unittest.mock import patch
import unittest
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from complete_jules_task import MAX_REPORT_CHARS, harvest, main, redact
from jules_dispatch import Response
from task_lifecycle import start
from validate_tasks import validate

NOW = datetime(2026, 9, 13, 12, tzinfo=timezone.utc)
CONFIG = {"repository": "owner/project", "product": {"editable_globs": ["src/**"], "excluded": ["src/secrets/**"]},
          "risk_ceiling": "medium", "merge_gate": {"owner_approvers": ["Owner"]}}
FINDING = {"id": "fix-clock", "title": "Fix stale clock after resume", "task_type": "bugfix",
           "risk": "low", "target_paths": ["src/clock.ts"],
           "acceptance": ["Resuming the app displays the current clock"],
           "evidence": {"source": "smoke", "detail": "Resume kept the previous clock value",
                        "reproduction": {"steps": ["Launch with a synthetic profile", "Suspend for two minutes and resume"],
                                         "expected": "Clock shows current time", "actual": "Clock shows old time"}}}
SESSION = {"name": "sessions/7", "id": "7", "state": "COMPLETED",
           "title": "[dispatch:first] investigate clock", "outputs": []}


def manifest():
    data = {"version": 2, "autonomous_loop_policy": {"lifecycle": {"max_attempts": 2}}, "tasks": [{
        "id": "research-clock", "title": "Investigate clock", "task_type": "project_discovery",
        "status": "todo", "risk": "low", "priority": 40, "focus": ["quality"],
        "research": {"area_id": "clock", "perspective_id": "behavior", "fingerprint": "a" * 64,
                     "cycle": 1, "previous_reports": []},
        "evidence": {"source": "research_cycle", "detail": "Scheduled clock inspection"},
    }]}
    start(data, "research-clock", session_id="7", dispatch_key="first", now=NOW)
    return data


def report(findings=None, **overrides):
    result = {"summary": "Inspected resume behavior", "observations": [
        {"scenario": "Suspend then resume", "evidence": "Clock observed before and after resume",
         "result": "Clock retained its old value"}], "next_hypotheses": []}
    result.update(overrides)
    return ("AUTONOMOUS_RESEARCH_BEGIN\n" + json.dumps(result) + "\nAUTONOMOUS_RESEARCH_END\n"
            + "AUTONOMOUS_TASKS_BEGIN\n" + json.dumps(findings or []) + "\nAUTONOMOUS_TASKS_END")


def activity(text, minute=1):
    return {"name": "sessions/7/activities/a" + str(minute),
            "createTime": "2026-09-13T11:" + str(minute).zfill(2) + ":00Z",
            "originator": "agent", "agentMessaged": {"agentMessage": text}}


class API:
    def __init__(self, pages=(), session=None, fail_page=None):
        self.pages = list(pages) or [[]]
        self.session = copy.deepcopy(SESSION if session is None else session)
        self.fail_page = fail_page
        self.requests = []

    def __call__(self, method, url, headers, payload):
        self.requests.append((method, url, payload))
        if method != "GET" or payload is not None:
            raise AssertionError("harvesting must only read")
        parts = urlsplit(url)
        if parts.path == "/v1alpha/sessions/7":
            return Response(200, self.session)
        if parts.path != "/v1alpha/sessions/7/activities":
            raise AssertionError("must only read the bound session")
        query = parse_qs(parts.query)
        if query.get("pageSize") != ["100"]:
            raise AssertionError("unexpected page size")
        token = query.get("pageToken", ["0"])[0]
        page = int(token)
        if page == self.fail_page:
            return Response(503, {"message": "upstream unavailable"})
        result = {"activities": self.pages[page]}
        if page + 1 < len(self.pages):
            result["nextPageToken"] = str(page + 1)
        return Response(200, result)


def run(data, api, snapshot=None, **kwargs):
    return harvest(data, CONFIG, "research-clock", SESSION if snapshot is None else snapshot,
                   transport=api, api_base="http://localhost/v1alpha", api_keys=["test-only"],
                   now=NOW, **kwargs)


class CompletionTest(unittest.TestCase):
    def test_paginated_out_of_order_findings_import_and_complete_exactly_once(self):
        data = manifest()
        api = API([[activity(report([FINDING]), 3)], [activity(report(), 1)]])
        result = run(data, api)
        self.assertEqual(result["reason"], "researched")
        self.assertEqual(result["imported_count"], 1)
        self.assertEqual(data["tasks"][0]["status"], "done")
        stored = data["tasks"][0]["research_result"]
        self.assertEqual(stored["proposed_task_ids"], ["fix-clock"])
        self.assertEqual(stored["completed_at"], "2026-09-13T12:00:00Z")
        child = data["tasks"][1]
        self.assertEqual(child["target_paths"], FINDING["target_paths"])
        self.assertEqual(child["acceptance"], FINDING["acceptance"])
        self.assertEqual(child["evidence"], {**FINDING["evidence"], "status": "reported"})
        self.assertEqual(child["origin"], {"task_id": "research-clock", "session_id": "7",
                                           "dispatch_key": "first",
                                           "activity_id": "sessions/7/activities/a3",
                                           "activity_created_at": "2026-09-13T11:03:00Z",
                                           "report_sha256": hashlib.sha256(report([FINDING]).encode("utf-8")).hexdigest()})
        self.assertEqual(stored["source"], {key: value for key, value in child["origin"].items() if key != "task_id"})
        before = copy.deepcopy(data)
        requests = len(api.requests)
        self.assertFalse(run(data, api)["changed"])
        self.assertEqual(data, before)
        self.assertEqual(len(api.requests), requests)
        self.assertEqual(validate(data), [])

    def test_latest_malformed_report_parks_same_attempt_without_older_fallback(self):
        data = manifest()
        identity = copy.deepcopy(data["tasks"][0]["execution"])
        bad = activity("AUTONOMOUS_RESEARCH_BEGIN {broken", 4)
        api = API([[bad], [activity(report([FINDING]), 2)]])
        result = run(data, api)
        self.assertEqual(result["reason"], "report_invalid")
        self.assertEqual(data["tasks"][0]["status"], "blocked")
        self.assertEqual(data["tasks"][0]["execution"]["state"], "awaiting_report")
        self.assertEqual(result["imported_count"], 0)
        self.assertNotIn("research_result", data["tasks"][0])
        self.assertEqual(len(data["tasks"]), 1)
        for field in ("attempts", "session_id", "dispatch_key", "started_at", "finished_at"):
            self.assertEqual(data["tasks"][0]["execution"][field], identity[field])
        before = copy.deepcopy(data)
        self.assertFalse(run(data, api)["changed"])
        self.assertFalse(run(data, api, retry_report=True)["changed"])
        self.assertEqual(data, before)
        with self.assertRaises(ValueError):
            start(data, "research-clock", session_id="8", dispatch_key="second", now=NOW)
        self.assertEqual(validate(data), [])

    def test_empty_backlog_requires_real_observations(self):
        data = manifest()
        self.assertEqual(run(data, API([[activity(report())]]))["reason"], "no_change")
        self.assertEqual(data["tasks"][0]["status"], "done")
        self.assertEqual(data["tasks"][0]["research_result"]["proposed_task_ids"], [])
        for text in (report(observations=[]), "AUTONOMOUS_TASKS_BEGIN [] AUTONOMOUS_TASKS_END",
                     report(observations=[{"scenario": "resume", "result": "ok"}])):
            with self.subTest(text=text):
                data = manifest()
                self.assertEqual(run(data, API([[activity(text)]]))["reason"], "report_invalid")
                self.assertNotIn("research_result", data["tasks"][0])

    def test_nullable_optional_outputs_do_not_hide_completed_research(self):
        data = manifest()
        api = API([[activity(report())]], session=dict(SESSION, outputs=None))
        self.assertEqual(run(data, api)["reason"], "no_change")
        self.assertEqual(data["tasks"][0]["status"], "done")
        self.assertEqual(data["tasks"][0]["research_result"]["summary"], "Inspected resume behavior")

    def test_foreign_snapshot_or_live_session_cannot_change_queue(self):
        for override in ({"id": "8", "name": "sessions/8"}, {"title": "[dispatch:other]"}):
            with self.subTest(override=override):
                data = manifest()
                before = copy.deepcopy(data)
                api = API()
                with self.assertRaises(ValueError):
                    run(data, api, snapshot=dict(SESSION, **override))
                self.assertEqual(api.requests, [])
                self.assertEqual(data, before)
                with self.assertRaises(ValueError):
                    run(data, API(session=dict(SESSION, **override)))
                self.assertEqual(data, before)

    def test_exact_get_rejects_wrong_starting_branch_before_importing_reports(self):
        data = manifest()
        data["tasks"][0]["execution"].update(base_sha="a" * 40, starting_branch="autonomous/attempt-first")
        before = copy.deepcopy(data)
        snapshot = dict(SESSION, sourceContext={"source": "sources/github/owner/project",
                                               "githubRepoContext": {"startingBranch": "autonomous/lab"}})
        with self.assertRaises(ValueError):
            run(data, API([[activity(report([FINDING]))]], session=snapshot))
        self.assertEqual(data, before)

    def test_api_failure_after_first_page_retains_all_queue_state(self):
        data = manifest()
        before = copy.deepcopy(data)
        api = API([[activity(report([FINDING]))], []], fail_page=1)
        with self.assertRaises(RuntimeError):
            run(data, api)
        self.assertEqual(data, before)

    def test_prose_completion_is_not_terminal_and_pr_outputs_defer_to_sweep(self):
        for session, reason in (
            (dict(SESSION, state="IN_PROGRESS", description="COMPLETED no changes"), "session_not_completed"),
            (dict(SESSION, outputs=[{"pullRequest": {"url": "https://github.com/owner/project/pull/7"}}]),
             "pull_request_pending_sweep"),
        ):
            with self.subTest(reason=reason):
                data = manifest()
                before = copy.deepcopy(data)
                api = API(session=session)
                self.assertEqual(run(data, api)["reason"], reason)
                self.assertEqual(data, before)
                self.assertEqual(len(api.requests), 1)

    def test_capped_findings_are_failed_transaction_not_successful_empty_result(self):
        data = manifest()
        other = copy.deepcopy(FINDING)
        other.update(id="fix-calendar", title="Fix calendar date after midnight",
                     target_paths=["src/calendar.ts"], acceptance=["Calendar advances at midnight"])
        other["evidence"]["reproduction"].update(
            steps=["Open the calendar with a synthetic clock", "Advance across midnight"],
            expected="Calendar shows the next date", actual="Calendar keeps yesterday's date")
        findings = [FINDING, other]
        result = run(data, API([[activity(report(findings))]]), max_new=1)
        self.assertEqual(result["reason"], "report_invalid")
        self.assertEqual(result["imported_count"], 0)
        self.assertEqual(len(data["tasks"]), 1)
        self.assertIn("max_new_reached", data["tasks"][0]["execution"]["report_error"]["detail"])

    def test_duplicate_findings_record_existing_task_not_false_no_change(self):
        data = manifest()
        data["tasks"].append(dict(FINDING, id="existing-clock", status="todo", priority=50, focus=["quality"]))
        result = run(data, API([[activity(report([FINDING]))]]))
        self.assertEqual(result["reason"], "researched")
        self.assertEqual(result["imported_count"], 0)
        self.assertEqual(len(data["tasks"]), 2)
        self.assertEqual(data["tasks"][0]["research_result"]["proposed_task_ids"], ["existing-clock"])

    def test_missing_acceptance_fails_without_losing_valid_sibling_finding(self):
        data = manifest()
        missing = dict(FINDING, id="missing", title="Missing contract")
        missing.pop("acceptance")
        result = run(data, API([[activity(report([FINDING, missing]))]]))
        self.assertEqual(result["reason"], "report_invalid")
        self.assertEqual(len(data["tasks"]), 1)
        self.assertIn("missing_acceptance", data["tasks"][0]["execution"]["report_error"]["detail"])

    def test_unsafe_findings_cannot_expand_scope_or_spawn_research_children(self):
        data = manifest()
        unsafe = [dict(FINDING, id="bad-scope", title="Edit guardrails", target_paths=[".github/workflows/x.yml"]),
                  dict(FINDING, id="bad-child", title="Research again", task_type="project_discovery")]
        result = run(data, API([[activity(report([FINDING] + unsafe))]]))
        self.assertEqual(result["reason"], "researched")
        self.assertEqual([task["id"] for task in data["tasks"]], ["research-clock", "fix-clock"])
        self.assertIn("unsafe_discovery_child", data["tasks"][0]["execution"]["note"])
        self.assertIn("unsafe_product_scope", data["tasks"][0]["execution"]["note"])


    def test_only_deferred_findings_finish_research_without_executable_work(self):
        data = manifest()
        finding = dict(FINDING, target_paths=["src/secrets/clock.ts"])
        result = run(data, API([[activity(report([finding]))]]))
        self.assertEqual(result["reason"], "researched")
        self.assertEqual(result["imported_count"], 0)
        self.assertEqual([task["status"] for task in data["tasks"]], ["done"])
        stored = data["tasks"][0]["research_result"]
        self.assertEqual(stored["proposed_task_ids"], [])
        self.assertEqual(stored["deferred_findings"][0]["title"], finding["title"])
        self.assertEqual(stored["deferred_findings"][0]["reason"], "unsafe_product_scope")
        self.assertEqual(validate(data), [])

    def test_unverified_research_completes_without_retrying_same_report(self):
        data = manifest()
        finding = dict(FINDING, evidence={"source": "reading", "detail": "Clock may be stale", "status": "verified"})
        api = API([[activity(report([finding]))]])
        result = run(data, api)
        self.assertEqual(result["reason"], "researched")
        self.assertEqual(result["imported_count"], 0)
        self.assertEqual([task["status"] for task in data["tasks"]], ["done"])
        stored = data["tasks"][0]["research_result"]
        self.assertEqual(stored["proposed_task_ids"], [])
        self.assertEqual(stored["deferred_findings"][0]["reason"], "unverified_finding")
        before = copy.deepcopy(data)
        requests = list(api.requests)
        for retry_report in (False, True):
            self.assertFalse(run(data, api, retry_report=retry_report)["changed"])
            self.assertEqual(data, before)
            self.assertEqual(api.requests, requests)
        with self.assertRaises(ValueError):
            start(data, "research-clock", session_id="8", dispatch_key="retry", now=NOW)
        self.assertEqual(validate(data), [])

    def test_reharvest_mixed_findings_retains_deferred_and_imports_once(self):
        data = manifest()
        run(data, API([[activity("AUTONOMOUS_RESEARCH_BEGIN {broken")]]))
        identity = copy.deepcopy(data["tasks"][0]["execution"])
        bare = dict(FINDING, id="suspected", title="Suspected leak",
                    evidence={"source": "reading", "detail": "Might retain clock objects"})
        api = API([[activity(report([bare, FINDING]), 2)]])
        result = run(data, api, retry_report=True)
        self.assertEqual(result["reason"], "researched")
        self.assertEqual(result["imported_count"], 1)
        self.assertEqual([task["id"] for task in data["tasks"]], ["research-clock", "fix-clock"])
        stored = data["tasks"][0]["research_result"]
        self.assertEqual(stored["deferred_findings"][0]["reason"], "unverified_finding")
        self.assertEqual(stored["proposed_task_ids"], ["fix-clock"])
        for field in ("attempts", "session_id", "dispatch_key", "started_at"):
            self.assertEqual(data["tasks"][0]["execution"][field], identity[field])
        before = copy.deepcopy(data)
        requests = list(api.requests)
        self.assertFalse(run(data, api, retry_report=True)["changed"])
        self.assertEqual(data, before)
        self.assertEqual(api.requests, requests)
        self.assertEqual(validate(data), [])

    def test_wrong_finding_shape_parks_attempt_without_partial_import(self):
        data = manifest()
        finding = dict(FINDING, acceptance=42)
        result = run(data, API([[activity(report([finding]))]]))
        self.assertEqual(result["reason"], "report_invalid")
        self.assertEqual(result["imported_count"], 0)
        self.assertEqual(data["tasks"][0]["execution"]["attempts"], 1)
        self.assertFalse(run(data, API())["changed"])

    def test_foreign_activity_page_is_read_failure_not_fake_completion(self):
        data = manifest()
        before = copy.deepcopy(data)
        foreign = dict(activity(report()), name="sessions/8/activities/foreign")
        with self.assertRaises(RuntimeError):
            run(data, API([[foreign]]))
        self.assertEqual(data, before)

    def test_legacy_implementation_no_change_does_not_require_research_report(self):
        data = manifest()
        data["tasks"][0].pop("research")
        data["tasks"][0]["task_type"] = "bugfix"
        api = API()
        self.assertEqual(run(data, api)["reason"], "no_change")
        self.assertEqual(data["tasks"][0]["status"], "done")
        self.assertEqual(len(api.requests), 1)

    def test_absent_findings_require_valid_research_but_present_malformed_is_not_empty(self):
        research = report().split("AUTONOMOUS_TASKS_BEGIN")[0]
        data = manifest()
        self.assertEqual(run(data, API([[activity(research)]]))["reason"], "no_change")
        self.assertEqual(data["tasks"][0]["research_result"]["proposed_task_ids"], [])
        for suffix in ("AUTONOMOUS_TASKS_BEGIN", "AUTONOMOUS_TASKS_END",
                       "AUTONOMOUS_TASKS_BEGIN {} AUTONOMOUS_TASKS_END",
                       "AUTONOMOUS_TASKS_BEGIN [broken] AUTONOMOUS_TASKS_END"):
            with self.subTest(suffix=suffix):
                data = manifest()
                self.assertEqual(run(data, API([[activity(research + suffix)]]))["reason"], "report_invalid")
                self.assertNotIn("research_result", data["tasks"][0])
                self.assertEqual(data["tasks"][0]["execution"]["report_error"]["code"], "tasks_malformed_block")

    def test_unmarked_latest_agent_output_cannot_resurrect_an_older_report(self):
        data = manifest()
        result = run(data, API([[activity(report([FINDING])), activity("Final report: {broken", 2)]]))
        self.assertEqual(result["reason"], "report_invalid")
        self.assertEqual(len(data["tasks"]), 1)

    def test_recovery_rejects_rewritten_or_older_activity_even_when_schema_is_valid(self):
        data = manifest()
        run(data, API([[activity("Final prose without structured report", 3)]]))
        before = copy.deepcopy(data)
        for replacement in (activity(report([FINDING]), 3), activity(report([FINDING]), 2)):
            with self.subTest(activity=replacement["name"]):
                self.assertEqual(run(data, API([[replacement]]), retry_report=True)["reason"], "report_unchanged")
                self.assertEqual(data, before)

    def test_new_report_within_same_second_recovers_without_another_request(self):
        data = manifest()
        first = dict(activity("Unmarked report"), createTime="2026-09-13T12:00:01.100Z")
        run(data, API([[first]]))
        execution = data["tasks"][0]["execution"]
        execution["report_repair"] = {"at": "2026-09-13T12:00:01.200Z",
                                      "result": "sent", "status": "pending"}
        invalid = dict(activity("Still unmarked", 2), createTime="2026-09-13T12:00:01.300Z")
        self.assertEqual(run(data, API([[first, invalid]]), retry_report=True)["reason"], "report_invalid")
        newer = dict(activity(report([FINDING]), 3), createTime="2026-09-13T12:00:01.900Z")
        self.assertEqual(run(data, API([[first, invalid, newer]]), retry_report=True)["reason"], "researched")
        self.assertEqual(data["tasks"][0]["execution"]["report_repair"]["status"], "resolved")
        self.assertEqual(data["tasks"][0]["execution"]["attempts"], 1)

    def test_valid_report_before_subsecond_request_boundary_is_not_recovery(self):
        data = manifest()
        first = dict(activity("Unmarked report"), createTime="2026-09-13T12:00:01.100Z")
        run(data, API([[first]]))
        data["tasks"][0]["execution"]["report_repair"] = {
            "at": "2026-09-13T12:00:01.800Z", "result": "sent", "status": "pending"}
        before = copy.deepcopy(data)
        older = dict(activity(report([FINDING]), 2), createTime="2026-09-13T12:00:01.600Z")
        self.assertEqual(run(data, API([[first, older]]), retry_report=True)["reason"], "report_unchanged")
        self.assertEqual(data, before)

    def test_explicit_reharvest_recovers_without_dispatch_or_history_reset(self):
        data = manifest()
        data["tasks"][0]["execution"]["history"] = [{"session_id": "older", "outcome": "failed"}]
        run(data, API([[activity("AUTONOMOUS_RESEARCH_BEGIN {broken")]]))
        original = copy.deepcopy(data["tasks"][0]["execution"])
        api = API([[activity(report([FINDING]), 2)]])
        self.assertFalse(run(data, api)["changed"])
        self.assertEqual(api.requests, [])
        self.assertEqual(run(data, api, retry_report=True)["reason"], "researched")
        execution = data["tasks"][0]["execution"]
        for field in ("attempts", "session_id", "dispatch_key", "started_at", "history"):
            self.assertEqual(execution[field], original[field])
        self.assertEqual(data["tasks"][0]["status"], "done")
        self.assertNotIn("report_error", execution)
        self.assertEqual(data["tasks"][0]["research_result"]["proposed_task_ids"], ["fix-clock"])
        before = copy.deepcopy(data)
        self.assertFalse(run(data, api, retry_report=True)["changed"])
        self.assertEqual(data, before)
        self.assertEqual(validate(data), [])
    def test_explicit_reparse_accepts_exact_immutable_report_after_parser_upgrade(self):
        for state, status in (("COMPLETED", "invalid"), ("FAILED", "failed")):
            with self.subTest(state=state):
                data = manifest()
                text = report([dict(FINDING, id="research-clock", title="Independent clock claim")])
                source_activity = activity(text, 2)
                source = {"activity_id": source_activity["name"],
                          "report_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                          "activity_created_at": source_activity["createTime"],
                          "session_id": "7", "dispatch_key": "first"}
                task = data["tasks"][0]
                task.update(status="blocked", execution={**task["execution"], "state": "awaiting_report",
                            "outcome": "report_invalid", "session_state": state,
                            "report_error": {"code": "findings_invalid", "detail": "conflicting_id",
                                             "reported_at": NOW.isoformat(), "source": source},
                            "report_repair": {"at": NOW.isoformat(), "result": "sent", "status": status,
                                               "source": source, "detail": "report repair did not resolve format"}})
                snapshot = dict(SESSION, state=state)
                if state == "FAILED":
                    before = copy.deepcopy(data)
                    newer = API([[source_activity, activity(report([FINDING]), 3)]], session=snapshot)
                    result = run(data, newer, snapshot=snapshot, retry_report=True, reparse_report=True)
                    self.assertEqual(result["reason"], "report_source_unavailable")
                    self.assertEqual(data, before)
                api = API([[source_activity]], session=snapshot)
                result = run(data, api, snapshot=snapshot, retry_report=True, reparse_report=True)
                self.assertEqual(result["reason"], "researched")
                self.assertEqual(data["tasks"][0]["execution"]["report_repair"]["status"], "resolved")
                self.assertEqual(data["tasks"][0]["execution"]["attempts"], 1)
                self.assertEqual(data["tasks"][0]["execution"]["session_state"], state)
                self.assertEqual(data["tasks"][-1]["origin"]["report_sha256"], source["report_sha256"])

    def test_explicit_reparse_rejects_changed_text_with_same_activity_identity(self):
        data = manifest()
        original = report([FINDING])
        original_activity = activity(original, 2)
        source = {"activity_id": original_activity["name"],
                  "report_sha256": hashlib.sha256(original.encode("utf-8")).hexdigest(),
                  "activity_created_at": original_activity["createTime"], "session_id": "7",
                  "dispatch_key": "first"}
        task = data["tasks"][0]
        task.update(status="blocked", execution={**task["execution"], "state": "awaiting_report",
                    "outcome": "report_invalid",
                    "report_error": {"code": "research_invalid", "detail": "parser upgrade",
                                     "reported_at": NOW.isoformat(), "source": source},
                    "report_repair": {"at": NOW.isoformat(), "result": "sent", "status": "pending",
                                       "source": source}})
        edited = report([dict(FINDING, title="Edited claim")])
        changed = dict(activity(edited, 2), name=source["activity_id"])
        before = copy.deepcopy(data)
        result = run(data, API([[changed]]), retry_report=True, reparse_report=True)
        self.assertEqual(result["reason"], "report_invalid")
        self.assertEqual(data["tasks"][0]["execution"]["attempts"], before["tasks"][0]["execution"]["attempts"])
        self.assertNotIn("research_result", data["tasks"][0])

    def test_retry_rejects_foreign_or_noncompleted_snapshot_without_reads(self):
        data = manifest()
        run(data, API([[activity("AUTONOMOUS_RESEARCH_BEGIN {broken")]]))
        before = copy.deepcopy(data)
        for snapshot in (dict(SESSION, id="8", name="sessions/8"),
                         dict(SESSION, title="[dispatch:other]"), dict(SESSION, state="IN_PROGRESS")):
            api = API()
            with self.assertRaises(ValueError):
                run(data, api, snapshot=snapshot, retry_report=True)
            self.assertEqual(api.requests, [])
            self.assertEqual(data, before)

    def test_empty_credentials_do_not_expand_or_destroy_error_details(self):
        self.assertEqual(redact("before fixture-value after", ["", "fixture-value"]),
                         "before [REDACTED] after")

    def test_invalid_diagnostics_preserve_parser_reason_and_redact_before_bounding(self):
        secrets = ["test-only", "configured-value/with?punct", "ghp_" + "a" * 36,
                   "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", "password123", "url-secret"]
        text = (report().split("AUTONOMOUS_TASKS_BEGIN")[0]
                + "AUTONOMOUS_TASKS_BEGIN [broken] AUTONOMOUS_TASKS_END\n"
                + "\n".join(secrets[:4]) + "\nAuthorization: Bearer password123\n"
                + "https://user:url-secret@example.com/path?access_token=url-secret#url-secret\n"
                + "x" * MAX_REPORT_CHARS + secrets[1])
        data = manifest()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "diagnostics.json"
            with patch.dict("os.environ", {"CUSTOM_SECRET": secrets[1]}):
                result = run(data, API([[activity(text)]]), diagnostics=path)
            raw = path.read_text(encoding="utf-8")
            diagnostic = json.loads(raw)
        self.assertEqual(result["reason"], "report_invalid")
        for secret in secrets:
            self.assertNotIn(secret, raw)
        self.assertEqual(diagnostic["task_id"], "research-clock")
        self.assertEqual(diagnostic["session_id"], "7")
        self.assertEqual(diagnostic["dispatch_key"], "first")
        self.assertEqual(diagnostic["tasks_parser"]["status"], "malformed_block")
        self.assertIn("line 1 column 2", diagnostic["tasks_parser"]["detail"])
        self.assertEqual(diagnostic["research_parser"]["status"], "ok")
        self.assertTrue(diagnostic["report_truncated"])
        self.assertLessEqual(len(diagnostic["worker_report"]), MAX_REPORT_CHARS)

    def test_retry_transport_failure_preserves_manifest_and_diagnostics_bytes_without_error_body(self):
        data = manifest()
        run(data, API([[activity("AUTONOMOUS_RESEARCH_BEGIN {broken")]]))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            queue, config, snapshot, diagnostics = (root / name for name in
                                                    ("queue.json", "config.json", "session.json", "diagnostics.json"))
            original = json.dumps(data, indent=4).encode() + b"\n\n"
            queue.write_bytes(original)
            config.write_text(json.dumps(CONFIG), encoding="utf-8")
            snapshot.write_text(json.dumps(SESSION), encoding="utf-8")
            diagnostics.write_bytes(b"previous diagnostic\n")
            stdout, stderr = StringIO(), StringIO()
            with patch("complete_jules_task.get_session", side_effect=RuntimeError("PRIVATE_UPSTREAM_BODY")) as get_session, \
                    patch.dict("os.environ", {"JULES_API_KEY": "test-only", "GITHUB_ACTOR": "Owner"}), \
                    redirect_stdout(stdout), redirect_stderr(stderr):
                result = main(["--manifest", str(queue), "--config", str(config), "--task-id", "research-clock",
                               "--session-file", str(snapshot), "--diagnostics", str(diagnostics), "--retry-report",
                               "--actor", "Owner"])
            self.assertEqual(result, 1)
            get_session.assert_called_once()
            self.assertEqual(queue.read_bytes(), original)
            self.assertEqual(diagnostics.read_bytes(), b"previous diagnostic\n")
            self.assertNotIn("PRIVATE_UPSTREAM_BODY", stdout.getvalue() + stderr.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
