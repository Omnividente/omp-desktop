#!/usr/bin/env python3
"""Tests for import_discovery_tasks.py."""
from __future__ import annotations

import copy
import json
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_discovery_tasks import (  # noqa: E402
    STATUS_ABSENT, STATUS_MALFORMED, extract_block, import_tasks, main, normalize,
)
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
    def test_absent_backlog_does_not_materialize_or_change_the_queue(self):
        data = {}
        result = import_tasks(data, "No findings to import", now=NOW)
        self.assertEqual(result["status"], STATUS_ABSENT)
        self.assertEqual(data, {})

    def test_malformed_blocks_are_distinct_from_absent_and_never_partly_imported(self):
        malformed = (
            "AUTONOMOUS_TASKS_BEGIN\n" + ONE_TASK,
            ONE_TASK + "\nAUTONOMOUS_TASKS_END",
            "AUTONOMOUS_TASKS_END\n" + ONE_TASK + "\nAUTONOMOUS_TASKS_BEGIN",
            body(ONE_TASK) + body("[]"),
            body('{"tasks": ' + ONE_TASK + '}'),
            body(ONE_TASK + " trailing garbage"),
            body(ONE_TASK[:-1] + ', 7]'),
            body(ONE_TASK[:-1] + ', {"title": "Bad", "acceptance": 7}]'),
        )
        for text in malformed:
            with self.subTest(text=text):
                data = manifest()
                before = copy.deepcopy(data)
                result = import_tasks(data, text, now=NOW)
                self.assertEqual(result["status"], STATUS_MALFORMED)
                self.assertFalse(result["changed"])
                self.assertEqual(data, before)

    def test_cli_malformed_input_reports_error_without_rewriting_any_output(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.json"
            target = Path(directory) / "out.json"
            outputs = Path(directory) / "outputs.txt"
            original = json.dumps(manifest()).encode("utf-8")
            queue.write_bytes(original)
            target.write_bytes(b"previous output")
            errors = StringIO()
            with redirect_stdout(StringIO()), redirect_stderr(errors):
                result = main(["--manifest", str(queue), "--out", str(target),
                               "--github-output", str(outputs), "--body",
                               "AUTONOMOUS_TASKS_BEGIN\n" + ONE_TASK])
            self.assertEqual(result, 2)
            self.assertIn("::error::", errors.getvalue())
            self.assertIn("imported_status=malformed_block", outputs.read_text(encoding="utf-8"))
            self.assertEqual(queue.read_bytes(), original)
            self.assertEqual(target.read_bytes(), b"previous output")

    def test_cli_absent_block_succeeds_without_rewriting_the_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.json"
            original = json.dumps(manifest()).encode("utf-8")
            queue.write_bytes(original)
            with redirect_stdout(StringIO()):
                self.assertEqual(main(["--manifest", str(queue), "--body", "Nothing found"]), 0)
            self.assertEqual(queue.read_bytes(), original)


if __name__ == "__main__":
    unittest.main(verbosity=2)
