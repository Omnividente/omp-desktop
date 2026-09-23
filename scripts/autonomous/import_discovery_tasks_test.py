#!/usr/bin/env python3
"""Tests for import_discovery_tasks.py."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from io import StringIO
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_discovery_tasks import (  # noqa: E402
    STATUS_ABSENT, STATUS_MALFORMED, extract_block, import_tasks, main, normalize,
)
from validate_tasks import validate  # noqa: E402
from proposal_backlog import decide  # noqa: E402
from state_store import StateConflict, load_state, save_state  # noqa: E402
from task_lifecycle import start  # noqa: E402
from research_request import (CONTRACT_VERSION, CONTEXT_BEGIN, CONTEXT_END, canonical_json,
                              decision_entry, snapshot, sha256_json)

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


def historical(finding, *, task_id="previous", action="reject", at=NOW):
    task = normalize(dict(finding, id=task_id), now=NOW)
    task.update(status="done", proposal_decision={"action": action, "actor": "owner",
                                                "at": at, "note": "Reviewed the previous claim"})
    return task


def attach_request(source, entries):
    execution = source["execution"]
    execution.update(starting_branch="autonomous/attempt-" + execution["dispatch_key"], base_sha="b" * 40)
    request = {"prompt": "AUTONOMOUS_DISPATCH_KEY: " + execution["dispatch_key"]
               + "\nAUTONOMOUS_TASK_ID: " + source["id"] + "\n\nResearch only on exact pinned base "
               + execution["base_sha"] + ".\n" + CONTEXT_BEGIN + canonical_json(entries) + CONTEXT_END,
               "title": "[dispatch:" + execution["dispatch_key"] + "] Research",
               "requirePlanApproval": False,
               "sourceContext": {"source": "sources/github/owner/repo",
                                 "githubRepoContext": {"startingBranch": execution["starting_branch"]}}}
    execution["research_request"] = snapshot(request, entries, "c" * 40)


def post_fixture(*, deliver=True, revisit=True, mode="real_runtime", history=None, finding=None):
    history = history if history is not None else [historical(FINDING, at="2026-09-11T12:00:00Z")]
    candidate = copy.deepcopy(finding or FINDING)
    entries = [decision_entry(task) for task in history if (task["proposal_decision"].get("note") or "").strip()]
    if revisit:
        candidate["evidence"]["revisit"] = {
            "contract_version": CONTRACT_VERSION, "change_kind": "new_evidence", "difference": "Observed again",
            "evidence_mode": mode, "observation_refs": [0], "primary_decision_task_id": history[0]["id"],
            "responses": [{"decision_task_id": item["task_id"], "decision_context_id": item["context_id"],
                           "why_previous_reason_no_longer_explains": "The current observation differs"} for item in entries]}
    text = body(json.dumps([candidate]))
    data = manifest(*copy.deepcopy(history))
    origin = accept_report(data, text)
    attach_request(data["tasks"][-1], entries if deliver else [])
    return data, text, origin


class PostAdmissionTests(unittest.TestCase):
    def test_each_complete_post_rationale_is_required_even_if_primary_was_delivered(self):
        history = [historical(FINDING, task_id="a", at="2026-09-11T12:00:00Z"),
                   historical(FINDING, task_id="b", action="resolve", at="2026-09-10T12:00:00Z")]
        data, text, origin = post_fixture(history=history)
        source = data["tasks"][-1]
        attach_request(source, [decision_entry(history[0])])
        before = copy.deepcopy(data["tasks"][:2])
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["added"], [])
        self.assertEqual(result["deferred"][0]["reason"], "historical_post_context_missing")
        self.assertEqual(data["tasks"][:2], before)
        self.assertEqual(source["research_result"]["deferred_findings"], result["deferred"])

    def test_partial_or_canonically_different_delivery_is_not_a_complete_owner_note(self):
        for delivered in ("Reviewed", "Reviewed the previous claim "):
            data, text, origin = post_fixture()
            previous, source = data["tasks"]
            attach_request(source, [decision_entry(previous, delivered)])
            result = import_tasks(data, text, config=CONFIG, origin=origin)
            self.assertEqual(result["deferred"][0]["reason"], "historical_post_context_missing")

    def test_static_and_mock_explanations_remain_reported_while_hypotheses_defer(self):
        for mode in ("real_runtime", "static_analysis", "mock_or_model", "hypothesis", "unavailable"):
            with self.subTest(mode=mode):
                data, text, origin = post_fixture(mode=mode)
                result = import_tasks(data, text, config=CONFIG, origin=origin)
                if mode in ("hypothesis", "unavailable"):
                    self.assertEqual(result["added"], [])
                    self.assertEqual(result["deferred"][0]["reason"], "historical_post_insufficient_evidence")
                else:
                    proposal = data["tasks"][-1]
                    self.assertEqual(result["added"], [proposal["id"]])
                    self.assertEqual(proposal["status"], "proposed")
                    self.assertEqual(proposal["evidence"]["status"], "reported")
                    self.assertNotIn("proposal_decision", proposal)
                self.assertEqual(validate(data), [])

    def test_malformed_revisit_is_deferred_not_a_rejected_research_report(self):
        changes = [{"observation_refs": [True]}, {"observation_refs": [-1]}, {"observation_refs": [1]},
                   {"observation_refs": [0, 0]}, {"responses": []}, {"responses": [{}]},
                   {"primary_decision_task_id": "foreign"}, {"difference": "x" * 4001},
                   {"contract_version": "foreign"}, {"change_kind": "trust_me"}]
        for changeset in changes:
            with self.subTest(changes=changeset):
                data, _, _ = post_fixture()
                finding = copy.deepcopy(FINDING)
                entry = decision_entry(data["tasks"][0])
                finding["evidence"]["revisit"] = {"change_kind": "new_evidence", "difference": "Changed",
                    "evidence_mode": "static_analysis", "observation_refs": [0], "primary_decision_task_id": "previous",
                    "responses": [{"decision_task_id": "previous", "decision_context_id": entry["context_id"],
                                   "why_previous_reason_no_longer_explains": "Different"}], **changeset}
                text = body(json.dumps([finding]))
                data = manifest(data["tasks"][0])
                origin = accept_report(data, text)
                attach_request(data["tasks"][-1], [entry])
                result = import_tasks(data, text, config=CONFIG, origin=origin)
                self.assertEqual(result["status"], "ok")
                self.assertEqual(result["deferred"][0]["reason"], "historical_post_unexplained")
                self.assertEqual(validate(data), [])

    def test_note_free_fallback_only_applies_when_all_strong_post_notes_are_absent(self):
        absent = historical(FINDING, task_id="absent", at="2026-09-11T12:00:00Z")
        absent["proposal_decision"].pop("note")
        for include_note in (False, True):
            history = [absent]
            if include_note:
                history.append(historical(FINDING, task_id="with-note", at="2026-09-10T12:00:00Z"))
            data, text, origin = post_fixture(history=history, deliver=False, revisit=False)
            result = import_tasks(data, text, config=CONFIG, origin=origin)
            if include_note:
                self.assertEqual(result["deferred"][0]["reason"], "historical_post_context_missing")
            else:
                self.assertEqual(data["tasks"][-1]["review_context"]["post_gate"], "not_applicable_no_rationale")
                self.assertEqual(result["added"], [data["tasks"][-1]["id"]])

    def test_deferred_identity_ignores_worker_id_and_import_clock_and_replay_is_immutable(self):
        first = copy.deepcopy(FINDING)
        second = dict(copy.deepcopy(FINDING), id="worker-second", status="todo", execution={"state": "completed"})
        text = body(json.dumps([first, second]))
        data = manifest(historical(FINDING, at="2026-09-11T12:00:00Z"))
        origin = accept_report(data, text)
        attach_request(data["tasks"][-1], [])
        later = copy.deepcopy(data)
        result = import_tasks(data, text, config=CONFIG, origin=origin, now=NOW)
        again = import_tasks(later, text, config=CONFIG, origin=origin, now="2026-09-20T12:00:00Z")
        self.assertEqual(len(result["deferred"]), 1)
        self.assertEqual(result["deferred"], again["deferred"])
        saved = json.loads(json.dumps(data))
        before = copy.deepcopy(saved)
        replay = import_tasks(saved, text, config=CONFIG, origin=origin)
        self.assertFalse(replay["changed"])
        self.assertEqual(saved, before)

    def test_pre_boundary_and_open_overlap_precede_structural_post_gate(self):
        for history, expected in (([historical(FINDING)], "historical_predecision_overlap"),
                                  ([normalize(FINDING, now=NOW)], "duplicate_contract")):
            data = manifest(*history)
            text = body(ONE_TASK)
            origin = accept_report(data, text)
            attach_request(data["tasks"][-1], [])
            result = import_tasks(data, text, config=CONFIG, origin=origin)
            self.assertEqual(result["skipped"][0]["reason"], expected)




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
                          review_context={"kind": "historical_decision_overlap", "matches": [
                              {"task_id": "forged", "action": "resolve", "decision_at": NOW,
                               "match": "exact", "timing": "post"}]},
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
        self.assertNotIn("review_context", queued)
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
                                                     "at": "2026-09-11T12:00:00Z", "note": "Not reproduced previously"}
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

    def test_collision_with_research_identity_preserves_both_findings_and_replays(self):
        data = manifest({"id": "occupied", "title": "Inspect clock", "task_type": "project_discovery",
                         "status": "todo", "priority": 40, "risk": "low", "focus": [],
                         "evidence": {"source": "controller", "detail": "Existing research"}})
        other = dict(FINDING, id="occupied", title="Inspect navigation", target_paths=["src/navigation.ts"])
        text = body(json.dumps([FINDING, other]))
        origin = accept_report(data, text)
        before = copy.deepcopy(data)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["added"]), 2)
        self.assertNotIn("occupied", result["added"])
        self.assertEqual(data["tasks"][0], before["tasks"][0])
        self.assertEqual(data["tasks"][-1]["origin"], origin)
        restored = json.loads(json.dumps(data))
        persisted = copy.deepcopy(restored)
        replay = import_tasks(restored, text, config=CONFIG, origin=origin)
        self.assertEqual(replay["added"], [])
        self.assertEqual(replay["duplicates"], result["added"])
        self.assertEqual(restored, persisted)
        # A different import time cannot change the derived claim identity.
        repeated = import_tasks(before, text, config=CONFIG, origin=origin, now="2026-09-19T12:00:00Z")
        self.assertEqual(repeated["added"], result["added"])

    def test_same_id_and_title_do_not_prove_different_contract_is_duplicate(self):
        existing = normalize(dict(FINDING, id="occupied"), now=NOW)
        data = manifest(existing)
        different = copy.deepcopy(FINDING)
        different["id"] = "occupied"
        different["evidence"]["reproduction"]["steps"] = ["Resize window without suspending"]
        text = body(json.dumps([different]))
        origin = accept_report(data, text)
        original = copy.deepcopy(existing)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(result["deferred"][0]["reason"], "possible_duplicate")
        self.assertIn("Resize window without suspending", result["deferred"][0]["evidence"])
        self.assertEqual(existing, original)

    def test_worker_id_collision_keeps_independent_claims_and_old_decisions(self):
        existing = normalize(dict(FINDING, id="occupied"), now=NOW)
        existing["status"] = "done"
        existing["proposal_decision"] = {"action": "reject", "actor": "owner", "at": NOW,
                                         "note": "Rejected the previous claim"}
        data = manifest(existing)
        text = body(json.dumps([dict(FINDING, id="occupied", target_paths=["src/first.ts"]),
                                dict(FINDING, id="occupied", title="Inspect another clock",
                                     target_paths=["src/second.ts"])]))
        origin = accept_report(data, text)
        original = copy.deepcopy(existing)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(set(result["added"])), 2)
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(data["tasks"][0], original)
        self.assertEqual([task["origin"] for task in data["tasks"][-2:]], [origin, origin])

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

    def test_historical_predecision_exact_and_possible_overlap_defers_at_equal_boundary(self):
        for finding, match in ((THINKING_FINDING, "exact"), (THINKING_PARAPHRASE, "possible")):
            for decision_at in (NOW, "2026-09-12T12:00:00.000000+00:00", "2026-09-13T12:00:00Z"):
                with self.subTest(match=match, decision_at=decision_at):
                    existing = historical(THINKING_FINDING, at=decision_at)
                    data = manifest(existing)
                    text = body(json.dumps([finding]))
                    origin = accept_report(data, text)
                    before = copy.deepcopy(data)
                    result = import_tasks(data, text, config=CONFIG, origin=origin,
                                          now="2026-09-20T12:00:00Z")
                    self.assertEqual(result["added"], [])
                    self.assertEqual(result["duplicates"], [])
                    self.assertEqual(result["skipped"], [{"id": finding["id"],
                                     "reason": "historical_predecision_overlap", "existing_task_id": "previous"}])
                    deferred = result["deferred"][0]
                    self.assertEqual(deferred["reason"], "historical_predecision_overlap")
                    self.assertEqual(json.loads(deferred["evidence"]), finding["evidence"])
                    self.assertEqual(deferred["review_context"], {"kind": "historical_decision_overlap", "matches": [
                        {"task_id": "previous", "action": "reject", "decision_at": decision_at,
                         "match": match, "timing": "pre"}]})
                    self.assertEqual(data["tasks"][0], before["tasks"][0])
                    self.assertEqual(data["tasks"][1]["research_result"], before["tasks"][1]["research_result"])
                    restored = json.loads(json.dumps(data))
                    persisted = copy.deepcopy(restored)
                    replay = import_tasks(restored, text, config=CONFIG, origin=origin)
                    self.assertFalse(replay["changed"])
                    self.assertEqual(replay["deferred"], result["deferred"])
                    self.assertEqual(restored, persisted)

    def test_historical_postdecision_reject_and_resolve_materialize_proposals(self):
        decision_at = "2026-09-12T11:59:59.999999Z"
        for action in ("reject", "resolve"):
            with self.subTest(action=action):
                existing = historical(FINDING, action=action, at=decision_at)
                data = manifest(existing)
                text = body(ONE_TASK)
                origin = accept_report(data, text)
                before = copy.deepcopy(existing)
                result = import_tasks(data, text, config=CONFIG, origin=origin)
                queued = data["tasks"][-1]
                self.assertEqual(result["added"], [queued["id"]])
                self.assertEqual(result["deferred"], [])
                self.assertEqual(queued["status"], "proposed")
                self.assertEqual(queued["origin"], origin)
                self.assertNotIn("proposal_decision", queued)
                self.assertEqual(queued["review_context"], {"kind": "historical_decision_overlap", "matches": [
                    {"task_id": "previous", "action": action, "decision_at": decision_at,
                     "match": "exact", "timing": "post"}]})
                self.assertEqual(existing, before)

    def test_historical_same_title_different_contract_never_suppresses(self):
        existing = historical(dict(FINDING, title="  FIX CLOCK DRIFT ON RESUME  ",
                                   target_paths=["src/unrelated.ts"]))
        data = manifest(existing)
        text = body(ONE_TASK)
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        queued = data["tasks"][-1]
        self.assertEqual(result["added"], [queued["id"]])
        self.assertEqual(result["deferred"], [])
        self.assertEqual(queued["status"], "proposed")
        self.assertEqual(queued["review_context"]["matches"], [
            {"task_id": "previous", "action": "reject", "decision_at": NOW,
             "match": "same_title", "timing": "pre"}])

    def test_mixed_historical_links_keep_all_matches_in_deterministic_order(self):
        earlier = "2026-09-11T12:00:00Z"
        later = "2026-09-13T12:00:00Z"
        for possible_at in (earlier, later):
            with self.subTest(possible_at=possible_at):
                history = [
                    historical(dict(FINDING, title=THINKING_FINDING["title"]), task_id="weak", at=earlier),
                    historical(THINKING_FINDING, task_id="exact-b"),
                    historical(THINKING_PARAPHRASE, task_id="possible", action="resolve", at=possible_at),
                    historical(THINKING_FINDING, task_id="exact-later", at=later),
                    historical(THINKING_FINDING, task_id="exact-a"),
                ]
                data = manifest(*history)
                before = copy.deepcopy(history)
                text = body(json.dumps([THINKING_FINDING]))
                origin = accept_report(data, text)
                result = import_tasks(data, text, config=CONFIG, origin=origin)
                if possible_at == earlier:
                    self.assertEqual(result["added"], [THINKING_FINDING["id"]])
                    self.assertEqual(result["deferred"], [])
                    context = data["tasks"][-1]["review_context"]
                else:
                    self.assertEqual(result["added"], [])
                    self.assertEqual(result["skipped"][0]["existing_task_id"], "exact-later")
                    context = result["deferred"][0]["review_context"]
                self.assertEqual(context, {"kind": "historical_decision_overlap", "matches": [
                    {"task_id": "exact-later", "action": "reject", "decision_at": later,
                     "match": "exact", "timing": "pre"},
                    {"task_id": "exact-a", "action": "reject", "decision_at": NOW,
                     "match": "exact", "timing": "pre"},
                    {"task_id": "exact-b", "action": "reject", "decision_at": NOW,
                     "match": "exact", "timing": "pre"},
                    {"task_id": "possible", "action": "resolve", "decision_at": possible_at,
                     "match": "possible", "timing": "post" if possible_at == earlier else "pre"},
                    {"task_id": "weak", "action": "reject", "decision_at": earlier,
                     "match": "same_title", "timing": "post"},
                ]})
                self.assertEqual(data["tasks"][:len(history)], before)
                reordered = manifest(*copy.deepcopy(list(reversed(before))))
                reordered_origin = accept_report(reordered, text)
                reordered_result = import_tasks(reordered, text, config=CONFIG, origin=reordered_origin)
                self.assertEqual(reordered_result, result)
                if result["added"]:
                    self.assertEqual(reordered["tasks"][-1]["review_context"], context)

    def test_forged_worker_review_context_cannot_override_predecision_admission(self):
        finding = dict(FINDING, review_context={"kind": "historical_decision_overlap", "matches": [
            {"task_id": "previous", "action": "resolve", "decision_at": "2026-09-01T00:00:00Z",
             "match": "same_title", "timing": "post"}]},
            origin={"activity_created_at": "2026-09-20T12:00:00Z"}, status="todo", reviewed=True)
        data = manifest(historical(FINDING))
        text = body(json.dumps([finding]))
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["added"], [])
        self.assertEqual(result["deferred"][0]["review_context"]["matches"], [
            {"task_id": "previous", "action": "reject", "decision_at": NOW,
             "match": "exact", "timing": "pre"}])

    def test_missing_or_malformed_trusted_timestamp_never_mutates_queue(self):
        for timestamp in (None, "", 42, {}, "yesterday", "2026-09-31T12:00:00Z",
                          "2026-09-12T12:00:00", "2026-09-12T12:00:00+01:00"):
            for text in (body(ONE_TASK), "No findings to import", "AUTONOMOUS_TASKS_BEGIN\n["):
                with self.subTest(timestamp=timestamp, text=text):
                    data = manifest(historical(FINDING))
                    origin = accept_report(data, text)
                    saved = data["tasks"][-1]["research_result"]["source"]
                    if timestamp is None:
                        del origin["activity_created_at"]
                        del saved["activity_created_at"]
                    else:
                        origin["activity_created_at"] = saved["activity_created_at"] = timestamp
                    before = copy.deepcopy(data)
                    with self.assertRaises(ValueError):
                        import_tasks(data, text, config=CONFIG, origin=origin)
                    self.assertEqual(data, before)

    def test_untrusted_timestamp_cannot_reclassify_an_accepted_report(self):
        data = manifest(historical(FINDING))
        text = body(ONE_TASK)
        origin = accept_report(data, text)
        before = copy.deepcopy(data)
        with self.assertRaises(ValueError):
            import_tasks(data, text, config=CONFIG,
                         origin={**origin, "activity_created_at": "2026-09-20T12:00:00Z"})
        self.assertEqual(data, before)

    def test_pending_rejection_is_not_a_historical_decision(self):
        existing = normalize(dict(FINDING, id="pending-worker"), now=NOW)
        existing["status"] = "todo"
        data = manifest(existing)
        start(data, existing["id"], session_id="worker", dispatch_key="attempt",
              now=datetime(2026, 9, 12, 12, tzinfo=timezone.utc))
        decide(data, {"merge_gate": {"owner_approvers": ["owner"]}}, action="reject",
               task_id=existing["id"], actor="owner", note="Stop unresolved worker", now=NOW)
        self.assertEqual(existing["proposal_decision"]["status"], "pending")
        self.assertEqual(existing["status"], "blocked")
        before = copy.deepcopy(existing)
        text = body(ONE_TASK)
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        self.assertEqual(result["added"], [data["tasks"][-1]["id"]])
        self.assertEqual(result["deferred"], [])
        self.assertEqual(result["duplicates"], [])
        self.assertNotIn("review_context", data["tasks"][-1])
        self.assertEqual(existing, before)

    def test_receipt_replay_after_owner_reject_never_recomputes_historical_admission(self):
        data = manifest()
        text = body(ONE_TASK)
        origin = accept_report(data, text)
        result = import_tasks(data, text, config=CONFIG, origin=origin)
        decide(data, {"merge_gate": {"owner_approvers": ["owner"]}}, action="reject",
               task_id=result["added"][0], actor="owner", note="Rejected after import", now=NOW)
        restored = json.loads(json.dumps(data))
        before = copy.deepcopy(restored)
        replay = import_tasks(restored, text, config=CONFIG, origin=origin)
        self.assertFalse(replay["changed"])
        self.assertEqual(replay["added"], [])
        self.assertEqual(replay["duplicates"], result["added"])
        self.assertEqual(replay["deferred"], [])
        self.assertEqual(restored, before)


class HistoricalAdmissionStoreTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "lab"
        self.remote = self.root / "remote.git"
        self.git(self.root, "init", "--bare", str(self.remote))
        self.git(self.root, "init", str(self.repo))
        for repo in (self.repo, self.remote):
            self.git(repo, "config", "gc.autoDetach", "false")
            self.git(repo, "config", "maintenance.autoDetach", "false")
        self.git(self.repo, "config", "user.name", "fixture")
        self.git(self.repo, "config", "user.email", "fixture@example.invalid")
        self.git(self.repo, "config", "commit.gpgsign", "false")
        self.text = body(ONE_TASK)
        self.config = {**CONFIG, "merge_gate": {"owner_approvers": ["owner"]}}

    def git(self, repo, *args):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()

    def seed(self, data):
        self.origin = accept_report(data, self.text)
        (self.repo / "agent_tasks.json").write_text(json.dumps(data), encoding="utf-8")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "fixture")
        self.git(self.repo, "branch", "-M", "autonomous/lab")
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.git(self.repo, "push", "origin", "HEAD")

    def load(self, name):
        queue = self.root / (name + ".json")
        revision = self.root / (name + "-revision.json")
        return load_state(self.repo, queue, revision), queue, revision

    def save(self, data, queue, revision):
        queue.write_text(json.dumps(data), encoding="utf-8")
        return save_state(self.repo, queue, revision)

    def test_stale_import_receipt_loses_cas_and_reload_applies_new_predecision_policy(self):
        self.seed(manifest(normalize(dict(FINDING, id="canonical"), now=NOW)))
        stale, stale_queue, stale_revision = self.load("importer")
        owner, owner_queue, owner_revision = self.load("owner")
        decide(owner, self.config, action="reject", task_id="canonical", actor="owner",
               note="Reviewed after report was written", now="2026-09-13T12:00:00Z")
        decision_sha = self.save(owner, owner_queue, owner_revision)
        staged = import_tasks(stale, self.text, config=self.config, origin=self.origin, now=NOW)
        self.assertTrue(staged["changed"])
        self.assertEqual(staged["duplicates"], ["canonical"])
        self.assertEqual(staged["deferred"], [])
        with self.assertRaises(StateConflict):
            self.save(stale, stale_queue, stale_revision)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), decision_sha)
        fresh, fresh_queue, fresh_revision = self.load("reloaded-importer")
        self.assertEqual(fresh, owner)
        self.assertNotIn("discovery_import", fresh["tasks"][1])
        result = import_tasks(fresh, self.text, config=self.config, origin=self.origin, now=NOW)
        self.assertEqual(result["added"], [])
        self.assertEqual(result["duplicates"], [])
        self.assertEqual(result["skipped"], [{"id": normalize(FINDING, now=NOW)["id"],
                         "reason": "historical_predecision_overlap", "existing_task_id": "canonical"}])
        self.assertEqual(result["deferred"][0]["review_context"], {
            "kind": "historical_decision_overlap", "matches": [
                {"task_id": "canonical", "action": "reject", "decision_at": "2026-09-13T12:00:00Z",
                 "match": "exact", "timing": "pre"}]})
        self.assertEqual(json.loads(result["deferred"][0]["evidence"]), FINDING["evidence"])
        self.assertEqual(fresh["tasks"][0], owner["tasks"][0])
        self.save(fresh, fresh_queue, fresh_revision)
        persisted, _, _ = self.load("receipt-reader")
        self.assertEqual(persisted, fresh)
        before = copy.deepcopy(persisted)
        replay = import_tasks(persisted, self.text, config=self.config, origin=self.origin)
        self.assertFalse(replay["changed"])
        self.assertEqual(replay["deferred"], result["deferred"])
        self.assertEqual(persisted, before)

    def test_materialized_receipt_survives_later_owner_decision_and_git_reload(self):
        self.seed(manifest())
        importer, queue, revision = self.load("importer")
        imported = import_tasks(importer, self.text, config=self.config, origin=self.origin, now=NOW)
        self.assertEqual(imported["added"], [importer["tasks"][-1]["id"]])
        self.assertEqual(imported["deferred"], [])
        receipt = copy.deepcopy(importer["tasks"][0]["discovery_import"])
        self.save(importer, queue, revision)
        owner, owner_queue, owner_revision = self.load("owner")
        decide(owner, self.config, action="reject", task_id=imported["added"][0], actor="owner",
               note="Rejected already materialized finding", now="2026-09-13T12:00:00Z")
        decision_sha = self.save(owner, owner_queue, owner_revision)
        restored, replay_queue, replay_revision = self.load("restart")
        before = copy.deepcopy(restored)
        replay = import_tasks(restored, self.text, config=self.config, origin=self.origin)
        self.assertFalse(replay["changed"])
        self.assertEqual(replay["added"], [])
        self.assertEqual(replay["duplicates"], imported["added"])
        self.assertEqual(replay["deferred"], [])
        self.assertEqual(restored["tasks"][0]["discovery_import"], receipt)
        self.assertNotIn("review_context", restored["tasks"][-1])
        self.assertEqual(restored, before)
        self.assertEqual(save_state(self.repo, replay_queue, replay_revision), decision_sha)


if __name__ == "__main__":
    unittest.main(verbosity=2)
