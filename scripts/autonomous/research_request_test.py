#!/usr/bin/env python3
"""Attempt immutability, legacy recovery and bounded rationale delivery regressions."""
from __future__ import annotations

import copy
import unittest
from pathlib import Path

from build_jules_request import build, dispatch_key
from import_discovery_tasks import import_tasks
from import_discovery_tasks_test import CONFIG, FINDING, attach_request, historical, post_fixture
from lab_controller import _request
from proposal_backlog_test import close_research, manifest, research_task
from research_cycle import request_context
from research_request import (CONTRACT_VERSION, LEGACY_VERSION, MAX_DECISION_CONTEXT_CHARS,
                              canonical_json, decision_entry, migrate_legacy, snapshot, validate_task_request)
from task_lifecycle import complete, reserve, start
from validate_tasks import validate


def research():
    return {"id": "research", "title": "Inspect resume", "task_type": "project_discovery",
            "status": "todo", "priority": 40, "risk": "low", "focus": ["quality"],
            "target_paths": ["src/clock.ts"], "evidence": {"source": "research_cycle", "detail": "Inspect clock"}}


def intent(task, context=()):
    key = dispatch_key("owner/repo", task["id"], (task.get("execution") or {}).get("attempts", 0) + 1)
    branch = "autonomous/attempt-" + key
    request = build(task, template="{{TASK_JSON}}", repo="owner/repo", branch="autonomous/lab",
                    starting_branch=branch, base_sha="b" * 40, decision_context=list(context))
    return key, branch, snapshot(request, list(context), "c" * 40)


def reserve_research(data, context=()):
    task = data["tasks"][0]
    key, branch, saved = intent(task, context)
    reserve(data, task["id"], key, base_sha="b" * 40, starting_branch=branch, research_request=saved)
    return saved


class ResearchRequestTests(unittest.TestCase):
    def test_invalid_reservation_never_consumes_attempt_or_partly_attaches_intent(self):
        data = manifest(research())
        key, branch, saved = intent(data["tasks"][0])
        saved["request"]["prompt"] += "tampered"
        before = copy.deepcopy(data)
        with self.assertRaises(ValueError):
            reserve(data, "research", key, base_sha="b" * 40, starting_branch=branch, research_request=saved)
        self.assertEqual(data, before)
        with self.assertRaises(ValueError):
            reserve(data, "research", key, base_sha="b" * 40, starting_branch=branch)
        self.assertEqual(data, before)

    def test_request_survives_binding_queue_and_template_changes_and_archives_on_retry(self):
        data = manifest(research())
        saved = reserve_research(data)
        task = data["tasks"][0]
        key = task["execution"]["dispatch_key"]
        start(data, "research", dispatch_key=key, session_id="7")
        task["title"] = "Owner changed the title after dispatch"
        task["evidence"]["detail"] = "New details not delivered to the existing worker"
        replay = _request(task, "foreign/repo", Path("missing-templates"), focus="new focus", risk="high")
        self.assertEqual(replay, saved["request"])
        replay["prompt"] += "caller mutation"
        self.assertEqual(task["execution"]["research_request"], saved)
        original = copy.deepcopy(task["execution"])
        complete(data, "research", outcome="failed")
        replacement = reserve_research(data)
        archive = task["execution"]["research_request_history"]
        self.assertEqual([(entry["session_id"], entry["dispatch_key"], entry["research_request"])
                          for entry in archive], [("7", key, original["research_request"])])
        self.assertNotEqual(replacement["request_sha256"], saved["request_sha256"])
        self.assertNotIn("research_request", replacement["request"]["prompt"])
        self.assertEqual(validate(data), [])
        task["execution"]["research_request_history"][0]["attempts"] = 2
        self.assertTrue(validate_task_request(task))

    def test_context_cannot_be_replaced_by_a_hash_or_detached_from_sent_payload(self):
        previous = historical(FINDING, at="2026-09-11T12:00:00Z")
        data = manifest(research())
        reserve_research(data, [decision_entry(previous)])
        source = data["tasks"][0]
        for field, value in (("decision_context", []), ("decision_context_sha256", "f" * 64),
                             ("request_sha256", "f" * 64), ("controller_sha", "main")):
            altered = copy.deepcopy(source)
            altered["execution"]["research_request"][field] = value
            with self.subTest(field=field):
                self.assertTrue(validate_task_request(altered))
        altered = copy.deepcopy(source)
        altered["execution"]["starting_branch"] = "autonomous/lab"
        self.assertTrue(validate_task_request(altered))

    def test_migration_tags_recoverable_disposition_but_does_not_rewrite_sealed_or_accepted_history(self):
        disposed = manifest(research_task())
        close_research(disposed)
        accepted, _, _ = post_fixture()
        accepted_source = accepted["tasks"][-1]
        del accepted_source["execution"]["research_request"]
        data = manifest(disposed["tasks"][0], accepted_source, {**research(), "id": "pending"})
        before = copy.deepcopy(data)
        migrated, tagged = migrate_legacy(data)
        self.assertEqual(tagged, ["research"])
        self.assertEqual(data, before)
        self.assertEqual(migrated["tasks"][0]["research_disposition"], before["tasks"][0]["research_disposition"])
        self.assertEqual(migrated["tasks"][1:], before["tasks"][1:])
        self.assertEqual(migrated["tasks"][0]["execution"]["research_request"],
                         {"contract_version": LEGACY_VERSION, "context_provenance": "not_recorded"})
        self.assertEqual(validate(migrated), [])
        repeated, tagged_again = migrate_legacy(migrated)
        self.assertEqual((repeated, tagged_again), (migrated, []))
        self.assertEqual(migrated["version"], CONTRACT_VERSION)

    def test_missing_context_priority_rotates_only_after_full_bound_delivery(self):
        history = [historical(FINDING, task_id=f"old-{index:02}", at="2026-09-10T12:00:00Z") for index in range(11)]
        data, text, origin = post_fixture(history=history, deliver=False, revisit=False)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["deferred"][0]["reason"], "historical_post_context_missing")
        paths = history[0]["target_paths"]
        first, _ = request_context(data["tasks"], paths)
        self.assertEqual([entry["task_id"] for entry in first], [task["id"] for task in history[:10]])
        reserved = {**research(), "id": "delivery", "execution": {"dispatch_key": "delivery", "attempts": 1}}
        attach_request(reserved, first)
        data["tasks"].append(reserved)
        self.assertEqual(request_context(data["tasks"], paths)[0], first)
        reserved["execution"]["session_id"] = "8"
        second, _ = request_context(data["tasks"], paths)
        self.assertEqual(second[0]["task_id"], "old-10")
        # A failed bound attempt still delivered its context before the next attempt.
        reserved["execution"]["research_request_history"] = [copy.deepcopy(reserved["execution"])]
        reserved["execution"].pop("session_id")
        self.assertEqual(request_context(data["tasks"], paths)[0][0]["task_id"], "old-10")
        source = data["tasks"][len(history)]
        source["deferred_materializations"] = [{"deferred_id": result["deferred"][0]["deferred_id"]}]
        newest = historical(FINDING, task_id="newest", at="2026-09-11T12:00:00Z")
        data["tasks"].append(newest)
        self.assertEqual(request_context(data["tasks"], paths)[0][0]["task_id"], "newest")

    def test_oversized_escaped_owner_note_remains_explicitly_incomplete(self):
        previous = historical(FINDING, at="2026-09-11T12:00:00Z")
        previous["proposal_decision"]["note"] = '\\"\nПричина ' * 5000
        context, _ = request_context([previous], previous["target_paths"])
        self.assertLessEqual(len(canonical_json(context)), MAX_DECISION_CONTEXT_CHARS)
        self.assertEqual(len(context), 1)
        self.assertFalse(context[0]["complete"])
        self.assertTrue(context[0]["truncated"])
        data = manifest(research())
        reserve_research(data, context)
        self.assertEqual(validate(data), [])


if __name__ == "__main__":
    unittest.main()
