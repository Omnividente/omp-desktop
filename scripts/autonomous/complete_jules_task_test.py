#!/usr/bin/env python3
"""Observable completion, ownership, pagination, and transactional regressions."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from complete_jules_task import harvest
from jules_dispatch import Response
from task_lifecycle import start
from validate_tasks import validate

NOW = datetime(2026, 9, 13, 12, tzinfo=timezone.utc)
CONFIG = {"product": {"editable_globs": ["src/**"], "excluded": ["src/secrets/**"]},
          "risk_ceiling": "medium"}
FINDING = {"id": "fix-clock", "title": "Fix stale clock after resume", "task_type": "bugfix",
           "risk": "low", "target_paths": ["src/clock.ts"],
           "acceptance": ["Resuming the app displays the current clock"],
           "evidence": {"source": "smoke", "detail": "Resume kept the previous clock value"}}
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
        self.assertEqual(child["evidence"], FINDING["evidence"])
        self.assertEqual(child["origin"], {"task_id": "research-clock", "session_id": "7",
                                           "dispatch_key": "first"})
        before = copy.deepcopy(data)
        requests = len(api.requests)
        self.assertFalse(run(data, api)["changed"])
        self.assertEqual(data, before)
        self.assertEqual(len(api.requests), requests)
        self.assertEqual(validate(data), [])

    def test_latest_malformed_report_never_falls_back_and_failure_is_bounded(self):
        data = manifest()
        bad = activity("AUTONOMOUS_RESEARCH_BEGIN {broken", 4)
        api = API([[bad], [activity(report([FINDING]), 2)]])
        result = run(data, api)
        self.assertEqual(result["reason"], "failed")
        self.assertEqual(data["tasks"][0]["status"], "todo")
        self.assertEqual(result["imported_count"], 0)
        self.assertNotIn("research_result", data["tasks"][0])
        self.assertEqual(len(data["tasks"]), 1)
        self.assertFalse(run(data, api)["changed"])
        start(data, "research-clock", session_id="8", dispatch_key="second", now=NOW)
        # A real retry has a different session and dispatch marker.
        second = dict(SESSION, id="8", name="sessions/8", title="[dispatch:second]")
        def retry_transport(method, url, headers, payload):
            if "/activities?" not in url:
                return Response(200, second)
            return Response(200, {"activities": []})
        outcome = harvest(data, CONFIG, "research-clock", second, transport=retry_transport,
                          api_keys=["test-only"], now=NOW)
        self.assertEqual(outcome["reason"], "failed")
        self.assertEqual(data["tasks"][0]["status"], "blocked")
        self.assertEqual(data["tasks"][0]["execution"]["attempts"], 2)

    def test_empty_backlog_requires_real_observations(self):
        data = manifest()
        self.assertEqual(run(data, API([[activity(report())]]))["reason"], "no_change")
        self.assertEqual(data["tasks"][0]["status"], "done")
        self.assertEqual(data["tasks"][0]["research_result"]["proposed_task_ids"], [])
        for text in (report(observations=[]), "AUTONOMOUS_TASKS_BEGIN [] AUTONOMOUS_TASKS_END",
                     report(observations=[{"scenario": "resume", "result": "ok"}])):
            with self.subTest(text=text):
                data = manifest()
                self.assertEqual(run(data, API([[activity(text)]]))["reason"], "failed")
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
            (dict(SESSION, outputs=[{"pullRequest": {"url": "https://github.com/o/r/pull/7"}}]),
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
        findings = [FINDING, dict(FINDING, id="fix-other", title="Fix another clock")]
        result = run(data, API([[activity(report(findings))]]), max_new=1)
        self.assertEqual(result["reason"], "failed")
        self.assertEqual(result["imported_count"], 0)
        self.assertEqual(len(data["tasks"]), 1)
        self.assertIn("max_new_reached", data["tasks"][0]["execution"]["note"])

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
        self.assertEqual(result["reason"], "failed")
        self.assertEqual(len(data["tasks"]), 1)
        self.assertIn("missing_acceptance", data["tasks"][0]["execution"]["note"])

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

    def test_wrong_finding_shape_spends_attempt_without_partial_import(self):
        data = manifest()
        finding = dict(FINDING, acceptance=42)
        result = run(data, API([[activity(report([finding]))]]))
        self.assertEqual(result["reason"], "failed")
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
