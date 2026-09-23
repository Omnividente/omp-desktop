#!/usr/bin/env python3
"""Human authorization, immutable worker history and real local CAS regressions."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from research_disposition import append_recovery_event, validate_research_disposition
from proposal_backlog import backlog, close_research_unaccepted, decide, main, materialize_deferred, render_summary
from state_store import StateConflict, load_state, save_state
from task_lifecycle import complete, start
from validate_tasks import validate
from import_discovery_tasks import import_tasks, normalize
from import_discovery_tasks_test import post_fixture, CONFIG as PRODUCT_CONFIG, FINDING

NOW = "2026-09-14T12:00:00Z"
CONFIG = {"merge_gate": {"owner_approvers": ["Owner"]}}


def proposal(task_id="finding", **overrides):
    return {"id": task_id, "title": "Fix observable clock drift", "task_type": "bugfix",
            "status": "proposed", "priority": 40, "risk": "low", "focus": ["quality"],
            "target_paths": ["src/clock.ts"], "acceptance": ["Resume refreshes the clock"],
            "evidence": {"source": "tsc", "detail": "TS2345 at src/clock.ts:42"},
            "origin": {"task_id": "research-clock", "session_id": "7", "dispatch_key": "first",
                       "activity_id": "sessions/7/activities/report", "activity_created_at": NOW,
                       "report_sha256": "a" * 64}, **overrides}


def manifest(*tasks):
    return {"version": 2, "autonomous_loop_policy": {}, "tasks": list(tasks),
            "history": [{"event": "original queue"}]}


def decision(data, action="approve", **kwargs):
    return decide(data, CONFIG, action=action, task_id="finding", actor="Owner",
                  note="Inspected the reported behavior", now=NOW, **kwargs)


def research_task(*, exhausted=False):
    source = {"session_id": "s1", "dispatch_key": "d1",
              "activity_id": "sessions/s1/activities/report", "report_sha256": "a" * 64,
              "activity_created_at": NOW}
    execution = {"state": "awaiting_report", "outcome": "report_invalid", "session_state": "FAILED",
                 "session_id": "s1", "dispatch_key": "d1", "attempts": 1, "finished_at": NOW,
                 "report_error": {"code": "research_json", "detail": "invalid JSON",
                                   "reported_at": NOW, "source": source}}
    if exhausted:
        execution.update(state="exhausted", outcome="failed", attempts=2)
        del execution["report_error"]
    return proposal("research", task_type="project_discovery", status="blocked", execution=execution)


def close_research(data, **overrides):
    arguments = {"task_id": "research", "actor": "Owner", "note": "Inspected invalid report", "now": NOW}
    arguments.update(overrides)
    return close_research_unaccepted(data, CONFIG, **arguments)


def deferred_queue():
    data, text, origin = post_fixture(deliver=False)
    result = import_tasks(data, text, config=PRODUCT_CONFIG, origin=origin)
    return data, origin["task_id"], result["deferred"][0]["deferred_id"]


def materialize(data, source_id, deferred_id, **overrides):
    args = {"source_task_id": source_id, "deferred_id": deferred_id, "actor": "Owner",
            "note": "Owner requests reconsideration", "now": NOW, **overrides}
    return materialize_deferred(data, {**PRODUCT_CONFIG, **CONFIG}, **args)


class DeferredMaterializationTests(unittest.TestCase):
    def test_materialization_is_proposed_only_and_preserves_receipt_and_owner_history(self):
        data, source_id, deferred_id = deferred_queue()
        before = copy.deepcopy(data)
        result = materialize(data, source_id, deferred_id)
        proposal = data["tasks"][-1]
        self.assertEqual(proposal["id"], result["task_id"])
        self.assertEqual(proposal["status"], "proposed")
        self.assertNotIn("execution", proposal)
        self.assertNotIn("proposal_decision", proposal)
        self.assertEqual(proposal["evidence"]["status"], "reported")
        self.assertEqual(data["tasks"][0], before["tasks"][0])
        source = data["tasks"][1]
        restored_source = copy.deepcopy(source)
        restored_source.pop("deferred_materializations")
        self.assertEqual(restored_source, before["tasks"][1])
        self.assertEqual(validate(data), [])
        saved = copy.deepcopy(data)
        replay = materialize(data, source_id, deferred_id, actor="owner", note=" Owner requests reconsideration ")
        self.assertFalse(replay["changed"])
        self.assertEqual(data, saved)
        with self.assertRaises(ValueError):
            materialize(data, source_id, deferred_id, note="Different authorization")
        self.assertEqual(data, saved)
        view = backlog(data)
        self.assertEqual(view["research_hypotheses"][0]["deferred_materializations"], source["deferred_materializations"])
        self.assertIn(deferred_id, render_summary(view))

    def test_unauthorized_wrong_source_unsafe_and_open_overlap_never_partly_mutate(self):
        cases = ("actor", "note", "source", "deferred", "unsafe", "exact", "possible")
        for case in cases:
            with self.subTest(case=case):
                data, source_id, deferred_id = deferred_queue()
                args = {"source_task_id": source_id, "deferred_id": deferred_id, "actor": "Owner", "note": "Reviewed"}
                config = {**PRODUCT_CONFIG, **CONFIG}
                if case == "actor":
                    args["actor"] = "stranger"
                elif case == "note":
                    args["note"] = " "
                elif case == "source":
                    args["source_task_id"] = "previous"
                elif case == "deferred":
                    args["deferred_id"] = "f" * 64
                elif case == "unsafe":
                    config = {**config, "product": {"editable_globs": ["other/**"]}}
                else:
                    finding = copy.deepcopy(FINDING)
                    if case == "possible":
                        finding["evidence"]["reproduction"]["steps"].append("Repeat with a different duration")
                    data["tasks"].append(normalize({**finding, "id": "open-canonical"}, now=NOW))
                before = copy.deepcopy(data)
                with self.assertRaises(ValueError):
                    materialize_deferred(data, config, **args)
                self.assertEqual(data, before)

    def test_proposal_authorization_can_advance_without_rewriting_materialization(self):
        data, source_id, deferred_id = deferred_queue()
        result = materialize(data, source_id, deferred_id)
        receipt = copy.deepcopy(data["tasks"][1]["discovery_import"])
        decide(data, CONFIG, action="approve", task_id=result["task_id"], actor="Owner", note="Implement", now=NOW)
        self.assertEqual(data["tasks"][-1]["status"], "todo")
        self.assertFalse(materialize(data, source_id, deferred_id)["changed"])
        self.assertEqual(data["tasks"][1]["discovery_import"], receipt)
        self.assertEqual(validate(data), [])




class DecisionTests(unittest.TestCase):
    def test_approval_never_dispatches_and_external_resolution_preserves_evidence(self):
        data = manifest(proposal())
        original = copy.deepcopy(data)
        decision(data)
        approved = copy.deepcopy(data)
        self.assertEqual(data["tasks"][0]["status"], "todo")
        self.assertNotIn("execution", data["tasks"][0])
        self.assertEqual(data["tasks"][0]["origin"], original["tasks"][0]["origin"])
        self.assertFalse(decision(data)["changed"])
        self.assertEqual(data, approved)
        decision(data, "resolve")
        self.assertEqual(backlog(data)["tasks"][0]["review_state"], "resolved")
        self.assertEqual(data["tasks"][0]["evidence"], original["tasks"][0]["evidence"])
        self.assertEqual(data["history"], original["history"])
        self.assertNotIn("execution", data["tasks"][0])
        self.assertEqual(validate(data), [])

    def test_unknown_actor_blank_note_and_invalid_date_cannot_mutate_queue(self):
        for changes in ({"actor": "stranger"}, {"actor": ""}, {"note": " "},
                        {"now": "2026-09-14T12:00:00+03:00"}):
            data = manifest(proposal())
            before = copy.deepcopy(data)
            args = {"action": "approve", "task_id": "finding", "actor": "Owner", "note": "Reviewed", "now": NOW}
            args.update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                decide(data, CONFIG, **args)
            self.assertEqual(data, before)

    def test_repeated_decision_keeps_original_actor_timestamp_and_note(self):
        data = manifest(proposal())
        decision(data)
        before = copy.deepcopy(data)
        result = decide(data, CONFIG, action="approve", task_id="finding", actor="owner",
                        note="Inspected the reported behavior", now="2026-09-15T12:00:00Z")
        self.assertFalse(result["changed"])
        self.assertEqual(data, before)
        with self.assertRaises(ValueError):
            decide(data, CONFIG, action="approve", task_id="finding", actor="Owner", note="Rewritten audit")
        self.assertEqual(data, before)

    def test_failed_settled_attempt_can_be_rejected_without_fabricating_cancellation(self):
        execution = {"state": "exhausted", "outcome": "failed", "attempts": 2,
                     "session_id": "saved-session", "session_state": "FAILED", "dispatch_key": "original",
                     "observed_at": NOW, "starting_branch": "autonomous/attempt-original", "base_sha": "b" * 40}
        data = manifest(proposal(status="blocked", execution=copy.deepcopy(execution)))
        origin = copy.deepcopy(data["tasks"][0]["origin"])
        decision(data, "reject")
        self.assertEqual(data["tasks"][0]["execution"], execution)
        self.assertEqual(data["tasks"][0]["origin"], origin)
        self.assertEqual(backlog(data)["tasks"][0]["review_state"], "rejected")
        self.assertEqual(validate(data), [])
        before = copy.deepcopy(data)
        self.assertFalse(decision(data, "reject")["changed"])
        for action in ("approve", "resolve"):
            with self.assertRaises(ValueError):
                decision(data, action)
        self.assertEqual(data, before)

    def test_active_quarantined_unknown_and_pending_pr_work_cannot_be_dismissed(self):
        cases = [
            ("in_progress", {"state": "dispatched", "session_id": "saved", "session_state": "AWAITING_USER_FEEDBACK"}),
            ("blocked", {"state": "quarantined", "outcome": "stale", "session_id": "saved", "session_state": "COMPLETED"}),
            ("todo", {"state": "retry", "outcome": "failed", "session_id": "saved", "session_state": "UNKNOWN"}),
            ("todo", {"state": "retry", "outcome": "failed", "session_id": "saved"}),
            ("blocked", {"state": "awaiting_review", "outcome": "review_required", "pull_request": 53,
                         "session_id": "saved", "session_state": "COMPLETED"}),
        ]
        for status, execution in cases:
            for action in ("approve", "reject", "resolve"):
                data = manifest(proposal(status=status, execution={**execution, "attempts": 1}))
                before = copy.deepcopy(data)
                with self.subTest(status=status, action=action), self.assertRaises(ValueError):
                    decision(data, action)
                self.assertEqual(data, before)

    def test_reject_stages_bound_worker_without_fabricating_terminal_state(self):
        data = manifest(proposal(status="todo"))
        start(data, "finding", session_id="saved-session", dispatch_key="attempt",
              now=datetime(2026, 9, 14, 12, tzinfo=timezone.utc))
        execution = data["tasks"][0]["execution"]
        execution.update(base_sha="b" * 40, starting_branch="autonomous/attempt-attempt")
        identity = {field: execution[field] for field in ("session_id", "dispatch_key", "attempts", "base_sha", "starting_branch")}
        result = decision(data, "reject")
        saved = data["tasks"][0]
        self.assertTrue(result["changed"])
        self.assertEqual((saved["status"], saved["execution"]["state"]), ("blocked", "quarantined"))
        self.assertEqual(saved["proposal_decision"]["status"], "pending")
        self.assertEqual(backlog(data)["tasks"][0]["review_state"], "rejecting")
        self.assertEqual({field: saved["execution"][field] for field in identity}, identity)
        self.assertEqual(data["history"], [{"event": "original queue"}])
        before = copy.deepcopy(data)
        self.assertFalse(decision(data, "reject")["changed"])
        self.assertEqual(data, before)
        self.assertEqual(validate(data), [])
        for changes in ({"status": "completed", "completed_at": NOW}, {"session_id": "foreign"}):
            invalid = copy.deepcopy(data)
            invalid["tasks"][0]["proposal_decision"].update(changes)
            self.assertTrue(validate(invalid))

    def test_dozens_of_historical_and_new_proposals_are_listed_without_mutation_or_markup(self):
        tasks = [proposal("finding-" + str(index), status="todo" if index % 2 else "proposed") for index in range(80)]
        tasks[0]["title"] = '</summary><script>alert("x")</script> [click](https://invalid)'
        tasks[0]["evidence"]["detail"] = "```\n<img src=x onerror=alert(1)>"
        data = manifest(*tasks)
        before = copy.deepcopy(data)
        view = backlog(data)
        self.assertEqual([item["id"] for item in view["tasks"]], [item["id"] for item in tasks])
        self.assertEqual(view["counts"], {"pending": 80})
        rendered = render_summary(view)
        self.assertIn("finding-79", rendered)
        self.assertNotIn("<script>", rendered)
        self.assertNotIn("<img", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertEqual(data, before)


class ResearchDispositionTests(unittest.TestCase):
    def test_owner_closes_invalid_and_exhausted_without_reclassifying_any_machine_evidence(self):
        for exhausted in (False, True):
            with self.subTest(exhausted=exhausted):
                data = manifest(research_task(exhausted=exhausted), proposal())
                before = copy.deepcopy(data)
                with patch("urllib.request.urlopen", side_effect=AssertionError("unexpected external request")):
                    result = close_research(data)
                self.assertTrue(result["changed"])
                saved = copy.deepcopy(data)
                del saved["tasks"][0]["research_disposition"]
                self.assertEqual(saved, before)
                self.assertEqual(validate(data), [])
                view = backlog(data)
                self.assertTrue(view["research_dispositions"][0]["acknowledged"])
                self.assertEqual(view["tasks"][0]["id"], "finding")
                self.assertNotIn("research_result", data["tasks"][0])

    def test_exact_repeated_close_is_immutable_but_new_note_or_incident_is_not_acknowledged(self):
        data = manifest(research_task())
        close_research(data)
        saved = copy.deepcopy(data)
        self.assertFalse(close_research(data, actor="owner", now="2026-09-15T12:00:00Z")["changed"])
        self.assertEqual(data, saved)
        with self.assertRaises(ValueError):
            close_research(data, note="Replace audit")
        self.assertEqual(data, saved)
        data["tasks"][0]["execution"]["report_error"]["detail"] = "New parser failure"
        changed = copy.deepcopy(data)
        with self.assertRaises(ValueError):
            close_research(data)
        self.assertEqual(data, changed)
        self.assertFalse(backlog(data)["research_dispositions"][0]["acknowledged"])

    def test_unsafe_or_unidentified_research_cannot_be_closed(self):
        cases = [
            {"session_state": "IN_PROGRESS"}, {"session_state": "UNKNOWN"},
            {"pull_request": 42}, {"session_id": ""}, {"dispatch_key": ""}, {"attempts": 0},
            {"report_repair": {"at": NOW, "result": "sent", "status": "pending"}},
            {"report_repair": {"at": NOW, "result": "sent", "status": "conflict", "detail": "Changed source"}},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                data = manifest(research_task())
                data["tasks"][0]["execution"].update(changes)
                before = copy.deepcopy(data)
                with self.assertRaises(ValueError):
                    close_research(data)
                self.assertEqual(data, before)
        for task, overrides in (
            (research_task(exhausted=True), {}), (research_task(), {"actor": "stranger"}),
            (research_task(), {"note": " "}), (research_task(), {"task_id": "missing"}),
            (proposal("research"), {}), (research_task(), {"now": "2026-09-13T12:00:00Z"}),
        ):
            data = manifest(task)
            data["autonomous_loop_policy"] = {"lifecycle": {"max_attempts": 3}}
            before = copy.deepcopy(data)
            with self.subTest(task=task, overrides=overrides), self.assertRaises(ValueError):
                close_research(data, **overrides)
            self.assertEqual(data, before)

    def test_historical_repair_chain_survives_real_completion_and_serialization(self):
        data = manifest(research_task(), proposal())
        task = data["tasks"][0]
        execution = task["execution"]
        source = copy.deepcopy(execution["report_error"]["source"])
        first = {"at": "2026-09-14T10:00:00Z", "result": "sent", "status": "invalid",
                 "detail": "Missing report markers", "source": source}
        execution["report_repair_history"] = [first]
        execution["report_repair"] = {**first, "at": "2026-09-14T11:00:00Z",
                                      "after": first["at"], "actor": "Owner", "detail": "Malformed JSON"}
        execution["last_error"] = "Report remained invalid"
        close_research(data)
        initial = copy.deepcopy(task["research_disposition"]["events"][0])
        append_recovery_event(task, "recover_authorized", now=NOW, actor="Owner", source=source)
        task["research_result"] = {"summary": "Recovered observations", "completed_at": NOW,
            "observations": [{"scenario": "Resume", "evidence": "Clock trace", "result": "Advanced"}],
            "next_hypotheses": ["Observe cancellation"], "proposed_task_ids": [], "source": source}
        self.assertTrue(complete(data, "research", outcome="no_change", retry_report=True,
                                 now=datetime.fromisoformat(NOW.replace("Z", "+00:00")))["changed"])
        append_recovery_event(task, "report_accepted", now=NOW, source=source)
        restored = json.loads(json.dumps(data))
        self.assertEqual(validate(restored), [])
        self.assertEqual(restored["tasks"][0]["research_disposition"]["events"][0], initial)
        self.assertNotIn("report_error", task["execution"])
        self.assertNotIn("last_error", task["execution"])
        self.assertEqual(task["execution"]["report_repair"]["status"], "resolved")
        self.assertEqual(task["execution"]["report_repair_history"], [first])
        self.assertEqual(task["execution"]["attempts"], 1)
        view = backlog(restored)
        self.assertFalse(view["research_dispositions"][0]["acknowledged"])
        self.assertEqual(view["research_hypotheses"][0]["next_hypotheses"], ["Observe cancellation"])

    def test_malformed_json_audit_types_are_rejected_without_mutation_or_exceptions(self):
        data = manifest(research_task())
        close_research(data)
        original = data["tasks"][0]
        cases = [
            (("research_disposition",), []), (("research_disposition", "events"), {}),
            (("research_disposition", "events", 0), []),
            (("research_disposition", "events", 0, "attempt"), "invalid"),
            (("research_disposition", "events", 0, "attempt", "attempts"), True),
            (("research_disposition", "events", 0, "basis", "report_error"), ["invalid"]),
            (("research_disposition", "events", 0, "basis", "report_repair"), {"status": []}),
            (("research_disposition", "events", 0, "basis", "report_repair_history"), {}),
            (("research_disposition", "events", 0, "basis", "state"), {}),
            (("research_disposition", "events", 0, "basis", "source"), []),
            (("research_disposition", "events", 0, "action"), []),
        ]
        for path, value in cases:
            with self.subTest(path=path):
                invalid = copy.deepcopy(original)
                target = invalid
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                before = copy.deepcopy(invalid)
                self.assertTrue(validate_research_disposition(invalid, "task"))
                self.assertEqual(invalid, before)

    def test_invalid_recovery_event_does_not_change_audit(self):
        data = manifest(research_task())
        close_research(data)
        task = data["tasks"][0]
        before = copy.deepcopy(task)
        for changes in ({"actor": ""}, {"source": []}, {"mode": []},
                        {"now": "2026-09-13T12:00:00Z"}, {"mode": "repair"}):
            args = {"now": NOW, "actor": "Owner", "source": task["execution"]["report_error"]["source"]}
            args.update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                append_recovery_event(task, "recover_authorized", **args)
            self.assertEqual(task, before)

    def test_accepted_event_requires_an_object_report_not_a_malformed_json_value(self):
        data = manifest(research_task())
        close_research(data)
        task = data["tasks"][0]
        source = task["execution"]["report_error"]["source"]
        append_recovery_event(task, "recover_authorized", now=NOW, actor="Owner", source=source)
        for report in (None, [], ["invalid"], "invalid", True):
            invalid = copy.deepcopy(task)
            invalid["research_result"] = report
            before = copy.deepcopy(invalid)
            with self.subTest(report=report), self.assertRaises(ValueError):
                append_recovery_event(invalid, "report_accepted", now=NOW, source=source)
            self.assertEqual(invalid, before)

    def test_existing_result_and_invalid_unrelated_queue_cannot_be_closed(self):
        for accepted in (True, False):
            data = manifest(research_task(), proposal())
            if accepted:
                data["tasks"][0]["research_result"] = {
                    "summary": "Existing observations", "completed_at": NOW,
                    "observations": [{"scenario": "Resume", "evidence": "Clock trace", "result": "Advanced"}],
                    "next_hypotheses": [], "proposed_task_ids": [],
                }
            else:
                data["tasks"][1]["title"] = ""
            before = copy.deepcopy(data)
            with self.subTest(accepted=accepted), self.assertRaises(ValueError):
                close_research(data)
            self.assertEqual(data, before)


class BacklogStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "lab"
        self.remote = self.root / "remote.git"
        self.git(self.root, "init", "--bare", str(self.remote))
        self.git(self.root, "init", str(self.repo))
        # Housekeeping must finish before cleanup removes these disposable repos.
        for repo in (self.repo, self.remote):
            self.git(repo, "config", "gc.autoDetach", "false")
            self.git(repo, "config", "maintenance.autoDetach", "false")
        self.git(self.repo, "config", "user.name", "fixture")
        self.git(self.repo, "config", "user.email", "fixture@example.invalid")
        self.git(self.repo, "config", "commit.gpgsign", "false")
        self.seed = (json.dumps(manifest(proposal())) + "\n").encode()
        (self.repo / "agent_tasks.json").write_bytes(self.seed)
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "fixture")
        self.git(self.repo, "branch", "-M", "autonomous/lab")
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.git(self.repo, "push", "origin", "HEAD")
        self.head = self.git(self.repo, "rev-parse", "HEAD")
        self.config = self.root / "control-config.json"
        self.config.write_text(json.dumps(CONFIG), encoding="utf-8")
        self.queue = self.root / "queue.json"
        self.revision = self.root / "revision.json"
        self.view = self.root / "backlog.json"
        self.summary = self.root / "summary.txt"
        self.argv = ["--repo", str(self.repo), "--config", str(self.config), "--manifest", str(self.queue),
                     "--revision-file", str(self.revision), "--actor", "Owner", "--task-id", "finding",
                     "--note", "Reviewed report", "--json-out", str(self.view), "--summary-out", str(self.summary)]

    def git(self, repo, *args):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()

    def call(self, action):
        with patch.dict(os.environ, {"GITHUB_ACTOR": "Owner"}), redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            return main([*self.argv, "--action", action])

    def test_cli_persists_authoritative_idempotent_decision_and_retains_state_history(self):
        self.assertEqual(self.call("list"), 0)
        self.assertEqual(self.queue.read_bytes(), self.seed)
        self.assertEqual(self.call("approve"), 0)
        approved_sha = self.git(self.remote, "rev-parse", "autonomous/state").decode()
        self.assertEqual(json.loads(self.git(self.repo, "show", approved_sha + "^:agent_tasks.json")), json.loads(self.seed))
        approved = json.loads(self.queue.read_bytes())
        self.assertEqual(approved["tasks"][0]["proposal_decision"]["actor"], "Owner")
        (self.repo / "agent_tasks.json").write_text('{"tasks": []}', encoding="utf-8")
        self.assertEqual(self.call("approve"), 0)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), approved_sha)
        self.assertEqual(self.call("resolve"), 0)
        resolved_sha = self.git(self.remote, "rev-parse", "autonomous/state").decode()
        self.assertEqual(json.loads(self.git(self.repo, "show", resolved_sha + "^:agent_tasks.json")), approved)
        self.assertEqual(json.loads(self.view.read_bytes())["tasks"][0]["review_state"], "resolved")
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/lab"), self.head)

    def test_cli_materializes_exact_deferred_once_via_authoritative_store(self):
        data, source_id, deferred_id = deferred_queue()
        load_state(self.repo, self.queue, self.revision)
        self.queue.write_text(json.dumps(data), encoding="utf-8")
        save_state(self.repo, self.queue, self.revision)
        self.config.write_text(json.dumps({**PRODUCT_CONFIG, **CONFIG}), encoding="utf-8")
        self.argv.extend(["--source-task-id", source_id, "--deferred-id", deferred_id])
        with patch("urllib.request.urlopen", side_effect=AssertionError("unexpected external request")):
            self.assertEqual(self.call("materialize_deferred"), 0)
            materialized_sha = self.git(self.remote, "rev-parse", "autonomous/state")
            self.assertEqual(self.call("materialize_deferred"), 0)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state"), materialized_sha)
        stored = json.loads(self.queue.read_bytes())
        self.assertEqual(stored["tasks"][-1]["status"], "proposed")
        self.assertNotIn("execution", stored["tasks"][-1])
        self.assertEqual(stored["tasks"][1]["discovery_import"], data["tasks"][1]["discovery_import"])
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/lab"), self.head)

    def test_stale_human_decision_cannot_overwrite_newer_state(self):
        stale_queue, stale_revision = self.root / "stale.json", self.root / "stale-revision.json"
        stale = load_state(self.repo, stale_queue, stale_revision)
        self.assertEqual(self.call("approve"), 0)
        approved_sha = self.git(self.remote, "rev-parse", "autonomous/state")
        decision(stale, "reject")
        stale_queue.write_text(json.dumps(stale), encoding="utf-8")
        with self.assertRaises(StateConflict):
            save_state(self.repo, stale_queue, stale_revision)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state"), approved_sha)
        self.assertEqual(self.call("list"), 0)
        self.assertEqual(json.loads(self.view.read_bytes())["tasks"][0]["review_state"], "approved")

    def test_github_actor_cannot_be_overridden_to_impersonate_owner(self):
        with patch.dict(os.environ, {"GITHUB_ACTOR": "stranger"}), redirect_stderr(StringIO()):
            self.assertEqual(main([*self.argv, "--action", "reject"]), 1)
        self.assertFalse(self.queue.exists())
        self.assertEqual((self.repo / "agent_tasks.json").read_bytes(), self.seed)

    def seed_research(self):
        data = load_state(self.repo, self.queue, self.revision)
        data["tasks"].insert(0, research_task())
        self.queue.write_text(json.dumps(data), encoding="utf-8")
        save_state(self.repo, self.queue, self.revision)
        self.argv[self.argv.index("--task-id") + 1] = "research"
        return data

    def test_cli_closes_research_once_without_code_or_unrelated_queue_mutation(self):
        original = self.seed_research()
        with patch("urllib.request.urlopen", side_effect=AssertionError("unexpected external request")):
            self.assertEqual(self.call("close_research_unaccepted"), 0)
            closed_sha = self.git(self.remote, "rev-parse", "autonomous/state")
            self.assertEqual(self.call("close_research_unaccepted"), 0)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state"), closed_sha)
        stored = json.loads(self.queue.read_bytes())
        event = stored["tasks"][0].pop("research_disposition")["events"][0]
        self.assertEqual(event["actor"], "Owner")
        self.assertEqual(stored, original)
        self.assertTrue(json.loads(self.view.read_bytes())["research_dispositions"][0]["acknowledged"])
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/lab"), self.head)

    def test_stale_cli_closure_cannot_acknowledge_a_concurrent_new_incident(self):
        original = self.seed_research()
        newer_sha = []

        def concurrent_save(repo, manifest_path, revision_path):
            fresh_queue = self.root / "fresh.json"
            fresh_revision = self.root / "fresh-revision.json"
            fresh = load_state(repo, fresh_queue, fresh_revision)
            fresh["tasks"][0]["execution"]["report_error"]["detail"] = "New incident after owner loaded queue"
            fresh_queue.write_text(json.dumps(fresh), encoding="utf-8")
            newer_sha.append(save_state(repo, fresh_queue, fresh_revision))
            return save_state(repo, manifest_path, revision_path)

        with patch("proposal_backlog.save_state", side_effect=concurrent_save):
            self.assertEqual(self.call("close_research_unaccepted"), 1)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), newer_sha[0])
        restored = load_state(self.repo, self.queue, self.revision)
        self.assertNotIn("research_disposition", restored["tasks"][0])
        self.assertEqual(restored["tasks"][0]["execution"]["report_error"]["detail"],
                         "New incident after owner loaded queue")
        self.assertEqual(restored["tasks"][1:], original["tasks"][1:])
        self.assertEqual(restored["history"], original["history"])
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/lab"), self.head)

    def test_nonowner_research_command_is_rejected_before_loading_state(self):
        self.argv[self.argv.index("--actor") + 1] = "stranger"
        with patch("proposal_backlog.load_state", side_effect=AssertionError("unauthorized state access")):
            self.assertEqual(self.call("close_research_unaccepted"), 1)
        self.assertFalse(self.queue.exists())


if __name__ == "__main__":
    unittest.main()
