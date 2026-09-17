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

# Preserved wording from two real research reports of one product defect.
THINKING_FINDING = {
    "id": "discovery-21935d2cee4d8a7e",
    "title": "Preserve built-in thinking modifiers when switching models",
    "task_type": "bugfix", "target_paths": ["src/ModelPicker.tsx", "src/ModelPicker.test.ts"],
    "acceptance": ["When switching from a model with an explicit :off or :auto thinking level "
                   "to another model that also supports thinking levels, the :off or :auto "
                   "modifier is preserved in the new selector."],
    "evidence": {
        "source": "autonomous_research",
        "detail": "Frontend observation using synthetic data to trace ModelPicker's selectorForModel mapping.",
        "reproduction": {
            "steps": ["Set up synthetic models that support thinking.",
                      "Invoke `selectorForModel` passing a new model 'openai/gpt-4o' and a current "
                      "selector 'anthropic/claude-sonnet:off'.", "Observe the generated selector string."],
            "expected": "The returned selector is 'openai/gpt-4o:off'.",
            "actual": "The returned selector is 'openai/gpt-4o', silently dropping the explicitly "
                      "selected :off state because 'off' is not part of the model's backend `thinking` array.",
        },
    },
}
THINKING_PARAPHRASE = {
    "id": "discovery-f94f0fd889c52402",
    "title": "Preserve base thinking modifiers (:off, :auto) when switching models",
    "task_type": "bugfix", "target_paths": ["src/ModelPicker.tsx"],
    "acceptance": ["Switching to a model that supports thinking levels preserves `:off` and `:auto` modifiers"],
    "evidence": {
        "source": "product_research",
        "detail": "Observed in `src/ModelPicker.tsx` that `selectorForModel` drops `:off` and `:auto` "
                  "because it strictly checks `model.thinking.includes(thinking)`. Base modifiers are "
                  "not listed in `model.thinking` which causes them to be silently dropped during model switching.",
        "reproduction": {
            "steps": ["Set a model's selector with an `:off` thinking override (e.g., `model:off`).",
                      "Switch the model using the ModelPicker to another model that also supports thinking levels."],
            "expected": "The new model is selected and the `:off` modifier is preserved in the selector "
                        "string (e.g. `new-model:off`).",
            "actual": "The `:off` modifier is stripped out and the selector falls back to the base model "
                      "selector (e.g., `new-model`).",
        },
    },
}


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


def config_args(directory):
    path = Path(directory) / "config.json"
    path.write_text(json.dumps(CONFIG), encoding="utf-8")
    return ["--config", str(path)]


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
        result = import_tasks(data, body(ONE_TASK), now=NOW, origin=origin, config=CONFIG)
        self.assertTrue(result["changed"])
        self.assertEqual(len(data["tasks"]), 2)
        self.assertEqual(validate(data), [])

    def test_importing_twice_does_not_duplicate(self):
        data = manifest()
        origin = accept_report(data, body(ONE_TASK))
        import_tasks(data, body(ONE_TASK), now=NOW, origin=origin, config=CONFIG)
        result = import_tasks(data, body(ONE_TASK), now=NOW, origin=origin, config=CONFIG)
        self.assertFalse(result["changed"])
        self.assertEqual(len(data["tasks"]), 2)
        self.assertEqual(result["skipped"][0]["reason"], "duplicate_id")

    def test_entry_without_evidence_is_rejected(self):
        data = manifest()
        text = body('[{"title": "Vibes"}]')
        origin = accept_report(data, text)
        result = import_tasks(data, text, now=NOW, origin=origin, config=CONFIG)
        self.assertFalse(result["changed"])
        self.assertEqual(result["skipped"][0]["reason"], "missing_evidence")

    def test_entry_without_title_is_rejected(self):
        data = manifest()
        text = body('[{"evidence": {"detail": "something"}}]')
        origin = accept_report(data, text)
        result = import_tasks(data, text, now=NOW, origin=origin, config=CONFIG)
        self.assertFalse(result["changed"])
        self.assertEqual(result["skipped"][0]["reason"], "missing_title")

    def test_max_new_caps_a_flood_of_findings(self):
        entries = ", ".join(
            json.dumps(dict(FINDING, title="Issue " + str(i), target_paths=["src/clock" + str(i) + ".ts"]))
            for i in range(8)
        )
        data = manifest()
        text = body("[" + entries + "]")
        origin = accept_report(data, text)
        before = copy.deepcopy(data)
        result = import_tasks(data, text, max_new=3, now=NOW, origin=origin, config=CONFIG)
        self.assertEqual(result["status"], STATUS_MALFORMED)
        self.assertEqual(result["added"], [])
        self.assertEqual(data, before)

    def test_title_without_a_behavioral_contract_is_only_a_review_lead(self):
        data = manifest({
            "id": "auto-1", "title": "Fix clock drift on resume", "task_type": "bugfix",
            "status": "todo", "priority": 40, "risk": "low", "focus": [],
            "evidence": {"source": "tsc", "detail": "x"},
        })
        origin = accept_report(data, body(ONE_TASK))
        result = import_tasks(data, body(ONE_TASK), now=NOW, origin=origin, config=CONFIG)
        self.assertTrue(result["changed"])
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(result["deferred"][0]["reason"], "possible_duplicate")
        self.assertIn("auto-1", result["deferred"][0]["evidence"])
        self.assertIn(REPRODUCTION["actual"], result["deferred"][0]["evidence"])

    def test_absent_backlog_does_not_materialize_or_change_the_queue(self):
        data = manifest()
        origin = accept_report(data, "No findings to import")
        before = copy.deepcopy(data)
        result = import_tasks(data, "No findings to import", now=NOW, origin=origin, config=CONFIG)
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
                result = import_tasks(data, text, now=NOW, origin=origin, config=CONFIG)
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
                               "--body", text] + config_args(directory))
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
                                       "--source-task-id", "research-clock"] + config_args(directory)), 0)
            self.assertEqual(queue.read_bytes(), original)

    def test_import_requires_saved_source_not_caller_supplied_hash(self):
        data = manifest()
        text = body(ONE_TASK)
        origin = accept_report(data, text)
        del data["tasks"][0]["research_result"]["source"]
        before = copy.deepcopy(data)
        for claimed in (None, origin):
            with self.subTest(origin=claimed), self.assertRaises(ValueError):
                import_tasks(data, text, origin=claimed, config=CONFIG)
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
                    import_tasks(data, payload, origin={**origin, **override}, config=CONFIG)
                self.assertEqual(data, before)

    def test_activity_must_belong_to_exact_session_even_if_saved_source_is_corrupt(self):
        data = manifest()
        text = body(ONE_TASK)
        origin = accept_report(data, text)
        origin["activity_id"] = "sessions/8/activities/report"
        data["tasks"][0]["research_result"]["source"]["activity_id"] = origin["activity_id"]
        before = copy.deepcopy(data)
        with self.assertRaises(ValueError):
            import_tasks(data, text, origin=origin, config=CONFIG)
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
                                   "--source-task-id", "research-clock", "--body", spoofed] + config_args(directory))
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
            argv = ["--manifest", str(queue), "--body", text, "--source-task-id", "research-clock"] + config_args(directory)
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
                self.assertEqual(data["tasks"][0]["research_result"], before["tasks"][0]["research_result"])
                self.assertEqual(json.loads(result["deferred"][0]["evidence"]), finding["evidence"])
                persisted = copy.deepcopy(data)
                self.assertFalse(import_tasks(data, text, config=CONFIG, origin=origin)["changed"])
                self.assertEqual(data, persisted)

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
                self.assertEqual(data["tasks"][0]["research_result"], before["tasks"][0]["research_result"])
                self.assertEqual(json.loads(result["deferred"][0]["evidence"]), FINDING["evidence"])

    def test_reversed_expected_and_actual_are_not_silently_deduplicated(self):
        finding = copy.deepcopy(THINKING_PARAPHRASE)
        original = THINKING_FINDING["evidence"]["reproduction"]
        finding["evidence"]["reproduction"].update(expected=original["actual"], actual=original["expected"])
        data = manifest(normalize(THINKING_FINDING, now=NOW))
        text = body(json.dumps([finding]))
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(result["deferred"][0]["reason"], "possible_duplicate")
        self.assertIn(original["expected"], result["deferred"][0]["evidence"])

    def test_live_paraphrase_links_existing_identity_without_mutating_history(self):
        existing = normalize(THINKING_FINDING, now=NOW)
        data = manifest(existing)
        text = body(json.dumps([THINKING_PARAPHRASE]))
        origin = accept_report(data, text)
        before = copy.deepcopy(data)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["added"], [])
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(result["deferred"][0]["reason"], "possible_duplicate")
        self.assertEqual(result["skipped"][0]["existing_task_id"], existing["id"])
        self.assertEqual(data["tasks"][0], before["tasks"][0])
        self.assertEqual(data["tasks"][1]["research_result"], before["tasks"][1]["research_result"])

    def test_paraphrases_in_one_report_use_first_canonical_finding(self):
        data = manifest()
        text = body(json.dumps([THINKING_FINDING, THINKING_PARAPHRASE, THINKING_PARAPHRASE]))
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["added"], [THINKING_FINDING["id"]])
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(result["deferred"][0]["reason"], "possible_duplicate")
        self.assertEqual(len(data["tasks"]), 2)

    def test_independent_focus_and_thinking_contracts_in_same_picker_are_kept(self):
        focus = {
            "title": "Restore keyboard focus after dismissing the model picker", "task_type": "bugfix",
            "target_paths": ["src/ModelPicker.tsx"],
            "acceptance": ["Escape returns keyboard focus to the trigger button"],
            "evidence": {"source": "synthetic", "detail": "Escape removes the popup but loses keyboard focus",
                         "reproduction": {"steps": ["Open picker with keyboard", "Press Escape"],
                                          "expected": "Trigger button receives focus",
                                          "actual": "Document body receives focus"}},
        }
        data = manifest()
        text = body(json.dumps([THINKING_FINDING, focus]))
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(len(result["added"]), 2)
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(result["deferred"], [])

    def test_shared_technical_path_and_generic_contract_are_not_a_match(self):
        first = dict(FINDING, title="Fix red indicator", target_paths=["src/shared.ts"],
                     acceptance=["The component should return the expected value"],
                     evidence={"source": "inspection", "detail": "src/shared.ts component issue",
                               "reproduction": {"steps": ["Use the component"],
                                                "expected": "The component works",
                                                "actual": "The component fails"}})
        second = dict(first, title="Fix blue indicator")
        data = manifest()
        text = body(json.dumps([first, second]))
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(len(result["added"]), 2)
        self.assertEqual(result["deferred"], [])

    def test_uncertain_overlap_retains_full_evidence_with_canonical_review_link(self):
        uncertain = json.loads(json.dumps(THINKING_PARAPHRASE).replace(":auto", "automatic")
                               .replace("selectorForModel", "mapping"))
        data = manifest(normalize(THINKING_FINDING, now=NOW))
        text = body(json.dumps([uncertain]))
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["added"], [])
        self.assertEqual(result["duplicates"], [])
        deferred = result["deferred"][0]
        self.assertEqual(deferred["reason"], "possible_duplicate")
        self.assertIn(THINKING_FINDING["id"], deferred["evidence"])
        self.assertIn(uncertain["evidence"]["reproduction"]["actual"], deferred["evidence"])
        self.assertEqual(deferred["acceptance"], uncertain["acceptance"])

    def test_closed_and_rejected_titles_allow_replayed_regression_with_new_identity(self):
        for decision in (None, "reject"):
            with self.subTest(decision=decision):
                existing = normalize(THINKING_FINDING, now=NOW)
                existing["status"] = "done"
                if decision:
                    existing["proposal_decision"] = {"action": decision, "actor": "owner",
                                                     "at": NOW, "note": "Not reproduced previously"}
                before = copy.deepcopy(existing)
                data = manifest(existing)
                text = body(json.dumps([THINKING_FINDING]))
                origin = accept_report(data, text)
                result = import_tasks(data, text, config=CONFIG, origin=origin)
                self.assertEqual(len(result["added"]), 1)
                self.assertNotEqual(result["added"], [existing["id"]])
                self.assertEqual(data["tasks"][0], before)
                self.assertEqual(data["tasks"][-1]["status"], "proposed")
                replay = import_tasks(data, text, config=CONFIG, origin=origin)
                self.assertEqual(replay["added"], [])
                self.assertEqual(replay["duplicates"], result["added"])
                data["tasks"][-1]["status"] = "done"
                closed_replay = import_tasks(data, text, config=CONFIG, origin=origin)
                self.assertEqual(closed_replay["added"], [])
                self.assertEqual(closed_replay["duplicates"], result["added"])

    def test_invalid_sibling_rolls_back_new_proposals_without_mutating_manifest(self):
        data = manifest()
        text = body(json.dumps([THINKING_FINDING, THINKING_PARAPHRASE,
                                dict(FINDING, title="Missing acceptance", acceptance=[])]))
        origin = accept_report(data, text)
        before = copy.deepcopy(data)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["status"], STATUS_MALFORMED)
        self.assertEqual(result["added"], [])
        self.assertEqual(data, before)
        self.assertEqual(result["deferred"][0]["reason"], "possible_duplicate")

    def test_negated_or_differently_triggered_contract_is_not_discarded(self):
        for case in ("negation", "trigger", "list_boundary"):
            with self.subTest(case=case):
                first = copy.deepcopy(FINDING)
                first["id"] = "original"
                second = copy.deepcopy(first)
                second["id"] = "different"
                reproduction = second["evidence"]["reproduction"]
                if case == "negation":
                    reproduction["expected"] = "Never " + reproduction["expected"]
                    reproduction["actual"] = "Never " + reproduction["actual"]
                elif case == "trigger":
                    reproduction["steps"] = ["Resize the terminal instead of resuming"]
                else:
                    reproduction["steps"] = [" ".join(reproduction["steps"])]
                data = manifest(normalize(first, now=NOW))
                text = body(json.dumps([second]))
                origin = accept_report(data, text)
                result = import_tasks(data, text, config=CONFIG, origin=origin)
                self.assertEqual(result["duplicates"], [])
                self.assertIn(json.dumps(second["evidence"], ensure_ascii=False, sort_keys=True),
                              result["deferred"][0]["evidence"])

    def test_root_level_paths_are_not_lost_from_exact_comparison(self):
        first = dict(FINDING, id="first", target_paths=["clock.ts"])
        second = dict(FINDING, id="second", target_paths=["timer.ts"])
        data = manifest(normalize(first, now=NOW))
        text = body(json.dumps([second]))
        origin = accept_report(data, text)
        result = import_tasks(data, text, config={"product": {"editable_globs": ["*.ts"]}}, origin=origin)
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(result["deferred"][0]["target_paths"], ["timer.ts"])

    def test_legacy_glob_path_cannot_disappear_from_exact_contract(self):
        existing = normalize(dict(FINDING, id="legacy", target_paths=["src/clock.ts", "src/timer*.ts"]), now=NOW)
        data = manifest(existing)
        text = body(json.dumps([dict(FINDING, id="literal-only")]))
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(result["deferred"][0]["reason"], "possible_duplicate")

    def test_collision_with_research_identity_rolls_back_entire_import(self):
        data = manifest({"id": "occupied", "title": "Inspect clock", "task_type": "project_discovery",
                         "status": "todo", "priority": 40, "risk": "low", "focus": [],
                         "evidence": {"source": "controller", "detail": "Existing research"}})
        text = body(json.dumps([FINDING, dict(FINDING, id="occupied", title="Inspect clock")]))
        origin = accept_report(data, text)
        before = copy.deepcopy(data)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["status"], STATUS_MALFORMED)
        self.assertEqual(data, before)

    def test_duplicate_receipt_survives_canonical_closure_and_process_restart(self):
        existing = normalize(dict(FINDING, id="canonical"), now=NOW)
        data = manifest(existing)
        text = body(json.dumps([dict(FINDING, id="renamed")]))
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["duplicates"], ["canonical"])
        existing["status"] = "done"
        restored = json.loads(json.dumps(data))
        before = copy.deepcopy(restored)
        replay = import_tasks(restored, text, config=CONFIG, origin=origin)
        self.assertEqual(replay["duplicates"], ["canonical"])
        self.assertEqual(replay["added"], [])
        self.assertEqual(restored, before)

    def test_corrupt_receipt_cannot_erase_or_reimport_a_report(self):
        data = manifest()
        origin = accept_report(data, body(ONE_TASK))
        import_tasks(data, body(ONE_TASK), config=CONFIG, origin=origin)
        data["tasks"][0]["discovery_import"]["result"]["added"] = ["missing-canonical-task"]
        before = copy.deepcopy(data)
        with self.assertRaises(ValueError):
            import_tasks(data, body(ONE_TASK), config=CONFIG, origin=origin)
        self.assertEqual(data, before)

    def test_missing_trusted_configuration_never_partly_imports_findings(self):
        data = manifest()
        origin = accept_report(data, body(ONE_TASK))
        before = copy.deepcopy(data)
        with self.assertRaises(ValueError):
            import_tasks(data, body(ONE_TASK), config=None, origin=origin)
        self.assertEqual(data, before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
