#!/usr/bin/env python3
"""Tests for import_discovery_tasks.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_discovery_tasks import extract_block, import_tasks, normalize  # noqa: E402
from validate_tasks import validate  # noqa: E402

NOW = "2026-09-12T12:00:00Z"
FENCE = "```"


def body(payload: str) -> str:
    return "\n".join([
        "Discovery run finished.",
        "",
        "<!-- AUTONOMOUS_TASKS_BEGIN -->",
        FENCE + "json",
        payload,
        FENCE,
        "<!-- AUTONOMOUS_TASKS_END -->",
        "",
        "Thanks!",
    ])


def manifest(*tasks) -> dict:
    return {
        "version": 2,
        "autonomous_loop_policy": {"min_todo_tasks": 3},
        "tasks": list(tasks),
    }


ONE_TASK = (
    '[{"title": "Fix clock drift on resume", "task_type": "bugfix", '
    '"evidence": {"source": "vitest", "detail": "clock.test.ts fails after sleep"}}]'
)


class ExtractTest(unittest.TestCase):
    def test_marked_block_is_parsed(self):
        entries = extract_block(body(ONE_TASK))
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "Fix clock drift on resume")

    def test_prose_without_a_block_yields_nothing(self):
        self.assertEqual(extract_block("I found some issues, trust me."), [])

    def test_malformed_json_is_not_half_imported(self):
        self.assertEqual(extract_block(body('[{"title": broken}]')), [])

    def test_empty_input_is_safe(self):
        self.assertEqual(extract_block(""), [])


class NormalizeTest(unittest.TestCase):
    def test_defaults_are_filled_in(self):
        entry = normalize({"title": "Tidy up", "evidence": {"detail": "eslint"}}, now=NOW)
        self.assertEqual(entry["status"], "todo")
        self.assertEqual(entry["risk"], "low")
        self.assertEqual(entry["task_type"], "product_improvement")
        self.assertTrue(entry["id"].startswith("discovery-"))
        self.assertEqual(entry["created_at"], NOW)

    def test_discovery_cannot_spawn_more_discovery(self):
        entry = normalize(
            {"title": "Look around again", "task_type": "project_discovery",
             "evidence": {"detail": "x"}},
            now=NOW,
        )
        self.assertEqual(entry["task_type"], "product_improvement")

    def test_priority_is_clamped_so_imports_cannot_jump_the_queue(self):
        entry = normalize(
            {"title": "Urgent", "priority": 5000, "evidence": {"detail": "x"}}, now=NOW
        )
        self.assertEqual(entry["priority"], 90)

    def test_nonsense_risk_falls_back_to_low(self):
        entry = normalize(
            {"title": "X", "risk": "apocalyptic", "evidence": {"detail": "x"}}, now=NOW
        )
        self.assertEqual(entry["risk"], "low")


class ImportTest(unittest.TestCase):
    def test_backlog_is_appended_to_the_queue(self):
        data = manifest()
        result = import_tasks(data, body(ONE_TASK), now=NOW)
        self.assertTrue(result["changed"])
        self.assertEqual(len(data["tasks"]), 1)
        self.assertEqual(validate(data), [])

    def test_importing_twice_does_not_duplicate(self):
        data = manifest()
        import_tasks(data, body(ONE_TASK), now=NOW)
        result = import_tasks(data, body(ONE_TASK), now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(len(data["tasks"]), 1)
        self.assertEqual(result["skipped"][0]["reason"], "duplicate_id")

    def test_entry_without_evidence_is_rejected(self):
        data = manifest()
        result = import_tasks(data, body('[{"title": "Vibes"}]'), now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(result["skipped"][0]["reason"], "missing_evidence")

    def test_entry_without_title_is_rejected(self):
        data = manifest()
        result = import_tasks(
            data, body('[{"evidence": {"detail": "something"}}]'), now=NOW
        )
        self.assertFalse(result["changed"])
        self.assertEqual(result["skipped"][0]["reason"], "missing_title")

    def test_max_new_caps_a_flood_of_findings(self):
        entries = ", ".join(
            '{"title": "Issue ' + str(i) + '", "evidence": {"detail": "d' + str(i) + '"}}'
            for i in range(8)
        )
        data = manifest()
        result = import_tasks(data, body("[" + entries + "]"), max_new=3, now=NOW)
        self.assertEqual(len(result["added"]), 3)
        self.assertEqual(len(data["tasks"]), 3)

    def test_existing_title_is_not_re_added_under_a_new_id(self):
        data = manifest({
            "id": "auto-1", "title": "Fix clock drift on resume", "task_type": "bugfix",
            "status": "todo", "priority": 40, "risk": "low", "focus": [],
            "evidence": {"source": "tsc", "detail": "x"},
        })
        result = import_tasks(data, body(ONE_TASK), now=NOW)
        self.assertFalse(result["changed"])
        self.assertEqual(result["skipped"][0]["reason"], "duplicate_title")

    def test_imported_queue_still_validates(self):
        data = manifest()
        import_tasks(data, body(ONE_TASK), now=NOW)
        self.assertEqual(validate(data), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
