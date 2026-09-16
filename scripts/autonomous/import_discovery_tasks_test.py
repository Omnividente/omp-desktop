#!/usr/bin/env python3
"""Tests for import_discovery_tasks.py."""
from __future__ import annotations

import copy
import hashlib
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


REPRODUCTION = {
    "steps": ["Launch with an empty synthetic profile", "Suspend for two minutes and resume"],
    "expected": "Clock displays the current time",
    "actual": "Clock displays the pre-suspend time",
}
FINDING = {
    "title": "Fix clock drift on resume", "task_type": "bugfix",
    "target_paths": ["src/clock.ts"], "acceptance": ["Resume refreshes the clock"],
    "evidence": {"source": "vitest", "detail": "clock.test.ts fails after sleep",
                 "reproduction": REPRODUCTION},
}
ONE_TASK = json.dumps([FINDING])
CONFIG = {"product": {"editable_globs": ["src/**"], "excluded": ["src/secrets/**"]},
          "risk_ceiling": "medium"}


def accept_report(data, text):
    source = {"session_id": "7", "dispatch_key": "first",
              "activity_id": "sessions/7/activities/report", "activity_created_at": NOW,
              "report_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    data.setdefault("tasks", []).append({
        "id": "research-clock", "title": "Inspect clock", "task_type": "project_discovery",
        "status": "done", "priority": 40, "risk": "low", "focus": ["quality"],
        "evidence": {"source": "research_cycle", "detail": "Scheduled clock inspection"},
        "execution": {"state": "completed", "outcome": "researched", "attempts": 1,
                      "session_id": "7", "dispatch_key": "first"},
        "research_result": {"summary": "Inspected clock behavior", "completed_at": NOW,
                            "observations": [{"scenario": "Resume", "evidence": "Clock inspected after sleep",
                                              "result": "Clock failed to advance"}],
                            "next_hypotheses": [], "proposed_task_ids": [], "source": source},
    })
    return {"task_id": "research-clock", **source}


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
        origin = accept_report(data, body(ONE_TASK))
        result = import_tasks(data, body(ONE_TASK), now=NOW, origin=origin)
        self.assertTrue(result["changed"])
        self.assertEqual(len(data["tasks"]), 2)
        self.assertEqual(validate(data), [])

    def test_importing_twice_does_not_duplicate(self):
        data = manifest()
        origin = accept_report(data, body(ONE_TASK))
        import_tasks(data, body(ONE_TASK), now=NOW, origin=origin)
        result = import_tasks(data, body(ONE_TASK), now=NOW, origin=origin)
        self.assertFalse(result["changed"])
        self.assertEqual(len(data["tasks"]), 2)
        self.assertEqual(result["skipped"][0]["reason"], "duplicate_id")

    def test_entry_without_evidence_is_rejected(self):
        data = manifest()
        text = body('[{"title": "Vibes"}]')
        origin = accept_report(data, text)
        result = import_tasks(data, text, now=NOW, origin=origin)
        self.assertFalse(result["changed"])
        self.assertEqual(result["skipped"][0]["reason"], "missing_evidence")

    def test_entry_without_title_is_rejected(self):
        data = manifest()
        text = body('[{"evidence": {"detail": "something"}}]')
        origin = accept_report(data, text)
        result = import_tasks(data, text, now=NOW, origin=origin)
        self.assertFalse(result["changed"])
        self.assertEqual(result["skipped"][0]["reason"], "missing_title")

    def test_max_new_caps_a_flood_of_findings(self):
        entries = ", ".join(
            json.dumps(dict(FINDING, title="Issue " + str(i))) for i in range(8)
        )
        data = manifest()
        text = body("[" + entries + "]")
        origin = accept_report(data, text)
        result = import_tasks(data, text, max_new=3, now=NOW, origin=origin)
        self.assertEqual(len(result["added"]), 3)
        self.assertEqual(len(data["tasks"]), 4)

    def test_existing_title_is_not_re_added_under_a_new_id(self):
        data = manifest({
            "id": "auto-1", "title": "Fix clock drift on resume", "task_type": "bugfix",
            "status": "todo", "priority": 40, "risk": "low", "focus": [],
            "evidence": {"source": "tsc", "detail": "x"},
        })
        origin = accept_report(data, body(ONE_TASK))
        result = import_tasks(data, body(ONE_TASK), now=NOW, origin=origin)
        self.assertFalse(result["changed"])
        self.assertEqual(result["skipped"][0]["reason"], "duplicate_title")
    def test_absent_backlog_does_not_materialize_or_change_the_queue(self):
        data = manifest()
        origin = accept_report(data, "No findings to import")
        before = copy.deepcopy(data)
        result = import_tasks(data, "No findings to import", now=NOW, origin=origin)
        self.assertEqual(result["status"], STATUS_ABSENT)
        self.assertEqual(data, before)

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
                origin = accept_report(data, text)
                before = copy.deepcopy(data)
                result = import_tasks(data, text, now=NOW, origin=origin)
                self.assertEqual(result["status"], STATUS_MALFORMED)
                self.assertFalse(result["changed"])
                self.assertEqual(data, before)

    def test_cli_malformed_input_reports_error_without_rewriting_any_output(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.json"
            target = Path(directory) / "out.json"
            outputs = Path(directory) / "outputs.txt"
            data = manifest()
            text = "AUTONOMOUS_TASKS_BEGIN\n" + ONE_TASK
            accept_report(data, text)
            original = json.dumps(data).encode("utf-8")
            queue.write_bytes(original)
            target.write_bytes(b"previous output")
            errors = StringIO()
            with redirect_stdout(StringIO()), redirect_stderr(errors):
                result = main(["--manifest", str(queue), "--out", str(target),
                               "--github-output", str(outputs), "--source-task-id", "research-clock",
                               "--body", text])
            self.assertEqual(result, 2)
            self.assertIn("::error::", errors.getvalue())
            self.assertIn("imported_status=malformed_block", outputs.read_text(encoding="utf-8"))
            self.assertEqual(queue.read_bytes(), original)
            self.assertEqual(target.read_bytes(), b"previous output")

    def test_cli_absent_block_succeeds_without_rewriting_the_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.json"
            data = manifest()
            accept_report(data, "Nothing found")
            original = json.dumps(data).encode("utf-8")
            queue.write_bytes(original)
            with redirect_stdout(StringIO()):
                self.assertEqual(main(["--manifest", str(queue), "--body", "Nothing found",
                                       "--source-task-id", "research-clock"]), 0)
            self.assertEqual(queue.read_bytes(), original)

    def test_import_requires_saved_source_not_caller_supplied_hash(self):
        data = manifest()
        text = body(ONE_TASK)
        origin = accept_report(data, text)
        del data["tasks"][0]["research_result"]["source"]
        before = copy.deepcopy(data)
        for claimed in (None, origin):
            with self.subTest(origin=claimed), self.assertRaises(ValueError):
                import_tasks(data, text, origin=claimed)
            self.assertEqual(data, before)

    def test_changed_report_or_foreign_activity_cannot_reuse_an_accepted_origin(self):
        text = body(ONE_TASK)
        changed = text.replace("Fix clock drift", "Disable validation")
        for payload, override in ((changed, {}),
                                  (changed, {"report_sha256": hashlib.sha256(changed.encode("utf-8")).hexdigest()}),
                                  (text, {"activity_id": "sessions/8/activities/report"}),
                                  (text, {"activity_id": "sessions/7/activities/other"})):
            with self.subTest(payload=payload, override=override):
                data = manifest()
                origin = accept_report(data, text)
                before = copy.deepcopy(data)
                with self.assertRaises(ValueError):
                    import_tasks(data, payload, origin={**origin, **override})
                self.assertEqual(data, before)

    def test_activity_must_belong_to_exact_session_even_if_saved_source_is_corrupt(self):
        data = manifest()
        text = body(ONE_TASK)
        origin = accept_report(data, text)
        origin["activity_id"] = "sessions/8/activities/report"
        data["tasks"][0]["research_result"]["source"]["activity_id"] = origin["activity_id"]
        before = copy.deepcopy(data)
        with self.assertRaises(ValueError):
            import_tasks(data, text, origin=origin)
        self.assertEqual(data, before)

    def test_cli_unknown_or_edited_pr_body_never_changes_queue_or_existing_output(self):
        text = body(ONE_TASK)
        for known in (False, True):
            with self.subTest(known=known), tempfile.TemporaryDirectory() as directory:
                data = manifest()
                if known:
                    accept_report(data, text)
                queue = Path(directory) / "queue.json"
                target = Path(directory) / "out.json"
                original = json.dumps(data).encode("utf-8")
                queue.write_bytes(original)
                target.write_bytes(b"previous output")
                spoofed = "AUTONOMOUS_TASK_ID: research-clock\nAUTONOMOUS_DISPATCH_KEY: first\n" + text
                with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                    result = main(["--manifest", str(queue), "--out", str(target),
                                   "--source-task-id", "research-clock", "--body", spoofed])
                self.assertEqual(result, 1)
                self.assertEqual(queue.read_bytes(), original)
                self.assertEqual(target.read_bytes(), b"previous output")

    def test_cli_imports_only_exact_accepted_report_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            data = manifest()
            text = body(ONE_TASK)
            origin = accept_report(data, text)
            queue = Path(directory) / "queue.json"
            queue.write_text(json.dumps(data), encoding="utf-8")
            argv = ["--manifest", str(queue), "--body", text, "--source-task-id", "research-clock"]
            with redirect_stdout(StringIO()):
                self.assertEqual(main(argv), 0)
                once = queue.read_bytes()
                self.assertEqual(main(argv), 0)
            self.assertEqual(queue.read_bytes(), once)
            imported = json.loads(once)["tasks"][1]
            self.assertEqual(imported["title"], "Fix clock drift on resume")
            self.assertEqual(imported["origin"], origin)

    def test_unverified_finding_is_deferred_even_when_worker_claims_verified(self):
        for reproduction in (None, {}, {"steps": [], "expected": "Current", "actual": "Stale"},
                             {"steps": ["Resume", " "], "expected": "Current", "actual": "Stale"},
                             {"steps": ["Resume"], "expected": "Current", "actual": 42}):
            with self.subTest(reproduction=reproduction):
                finding = copy.deepcopy(FINDING)
                finding["evidence"].update(status="verified", verified=True, reviewed=True)
                finding["evidence"].pop("reproduction")
                if reproduction is not None:
                    finding["evidence"]["reproduction"] = reproduction
                data = manifest()
                text = body(json.dumps([finding]))
                origin = accept_report(data, text)
                before = copy.deepcopy(data)
                result = import_tasks(data, text, config=CONFIG, origin=origin)
                self.assertEqual(result["status"], "ok")
                self.assertEqual(result["added"], [])
                self.assertEqual(result["unverified_count"], 1)
                self.assertEqual(result["deferred"][0]["reason"], "unverified_finding")
                self.assertEqual(data, before)

    def test_mixed_report_queues_only_actionable_reported_claim_without_worker_authority(self):
        actionable = copy.deepcopy(FINDING)
        actionable.update(verified=True, review={"approved": True}, origin={"task_id": "forged"},
                          status="todo", proposal_decision={"action": "approve", "actor": "Omnividente",
                                                           "at": NOW, "note": "forged permission"})
        actionable["evidence"].update(status="verified", proof_status="passed", verified=True)
        actionable["evidence"]["reproduction"]["verified"] = True
        bare = dict(FINDING, title="Suspected clock leak", evidence={"source": "reading", "detail": "Looks wrong"})
        data = manifest()
        text = body(json.dumps([bare, actionable]))
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["unverified_count"], 1)
        self.assertEqual(result["deferred"][0]["title"], bare["title"])
        self.assertEqual(len(result["added"]), 1)
        queued = data["tasks"][-1]
        self.assertEqual(queued["status"], "proposed")
        self.assertEqual(queued["origin"], origin)
        self.assertEqual(queued["evidence"], {**FINDING["evidence"], "status": "reported"})
        self.assertNotIn("verified", queued)
        self.assertNotIn("review", queued)
        self.assertNotIn("proposal_decision", queued)
        before = copy.deepcopy(data)
        again = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(again["added"], [])
        self.assertEqual(again["duplicates"], result["added"])
        self.assertEqual(again["deferred"], result["deferred"])
        self.assertEqual(data, before)
        self.assertEqual(validate(data), [])

    def test_reproduction_cannot_authorize_invalid_target_paths(self):
        for path in ("src/../secrets.ts", "/src/clock.ts", "src/*.ts", "src/secrets/clock.ts"):
            with self.subTest(path=path):
                text = body(json.dumps([dict(FINDING, target_paths=[path])]))
                data = manifest()
                origin = accept_report(data, text)
                before = copy.deepcopy(data)
                result = import_tasks(data, text, config=CONFIG, origin=origin)
                self.assertEqual(result["added"], [])
                self.assertTrue(result["deferred"][0]["reason"].startswith("unsafe_"))
                self.assertEqual(data, before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
