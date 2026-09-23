#!/usr/bin/env python3
"""Tests for validate_tasks.py, including the shipped queue."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_tasks import validate  # noqa: E402
from import_discovery_tasks import import_tasks
from import_discovery_tasks_test import post_fixture, CONFIG as PRODUCT_CONFIG
from proposal_backlog import materialize_deferred
from research_request import CONTRACT_VERSION

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPO_ROOT / "agent_tasks.json"


def task(task_id: str = "auto-1", **overrides) -> dict:
    base = {
        "id": task_id,
        "title": "Fix something specific",
        "task_type": "bugfix",
        "status": "todo",
        "priority": 40,
        "risk": "low",
        "focus": ["quality"],
        "evidence": {"source": "tsc", "detail": "TS2345 at src/clock.ts:42"},
    }
    base.update(overrides)
    return base


def manifest(*tasks, **policy) -> dict:
    loop_policy = {"integration_branch": "autonomous/lab"}
    loop_policy.update(policy)
    return {"version": 2, "autonomous_loop_policy": loop_policy, "tasks": list(tasks)}


class DeferredIdentityTests(unittest.TestCase):
    def queue(self, *, materialized=False):
        data, text, origin = post_fixture(deliver=False)
        result = import_tasks(data, text, config=PRODUCT_CONFIG, origin=origin)
        if materialized:
            materialize_deferred(data, {**PRODUCT_CONFIG, "merge_gate": {"owner_approvers": ["owner"]}},
                                 source_task_id=origin["task_id"], deferred_id=result["deferred"][0]["deferred_id"],
                                 actor="owner", note="Reconsider", now="2026-09-20T12:00:00Z")
        self.assertEqual(validate(data), [])
        return data

    def test_receipt_report_and_stable_candidate_cross_links_cannot_be_corrupted(self):
        original = self.queue()
        cases = [
            (("tasks", 1, "discovery_import", "source", "report_sha256"), "f" * 64),
            (("tasks", 1, "discovery_import", "result", "deferred", 0, "source", "task_id"), "previous"),
            (("tasks", 1, "discovery_import", "result", "deferred", 0, "candidate", "title"), "Rewritten"),
            (("tasks", 1, "discovery_import", "result", "deferred", 0, "deferred_id"), "f" * 64),
            (("tasks", 1, "research_result", "deferred_findings"), []),
            (("tasks", 1, "discovery_import", "result", "deferred"), []),
            (("tasks", 1, "research_result", "deferred_findings", 0, "review_context", "matches", 0, "action"), "resolve"),
        ]
        for path, value in cases:
            with self.subTest(path=path):
                data = copy.deepcopy(original)
                target = data
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                before = copy.deepcopy(data)
                self.assertTrue(validate(data))
                self.assertEqual(data, before)

    def test_materialization_event_and_proposal_are_validated_in_both_directions(self):
        original = self.queue(materialized=True)
        cases = [
            (("tasks", 1, "deferred_materializations"), []),
            (("tasks", 1, "deferred_materializations", 0, "proposal_id"), "previous"),
            (("tasks", 1, "deferred_materializations", 0, "deferred_id"), "f" * 64),
            (("tasks", 2, "materialized_from", "source_task_id"), "previous"),
            (("tasks", 2, "materialized_from", "actor"), "foreign"),
            (("tasks", 2, "origin", "report_sha256"), "f" * 64),
            (("tasks", 2, "evidence", "detail"), "Different evidence"),
            (("tasks", 2, "review_context", "matches", 0, "decision_at"), "2026-09-01T12:00:00Z"),
        ]
        for path, value in cases:
            with self.subTest(path=path):
                data = copy.deepcopy(original)
                target = data
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                self.assertTrue(validate(data))
        without_proposal = copy.deepcopy(original)
        without_proposal["tasks"].pop()
        self.assertTrue(validate(without_proposal))
        duplicate_event = copy.deepcopy(original)
        duplicate_event["tasks"][1]["deferred_materializations"] *= 2
        self.assertTrue(validate(duplicate_event))

    def test_versioned_request_is_validated_without_policy_but_missing_active_request_uses_policy(self):
        data, _, _ = post_fixture()
        data["tasks"][1]["execution"]["research_request"]["request_sha256"] = "f" * 64
        self.assertTrue(validate(data))
        active = manifest(task("research", task_type="project_discovery", status="in_progress",
                               execution={"state": "dispatched", "attempts": 1,
                                          "session_id": "7", "dispatch_key": "first"}))
        self.assertEqual(validate(active), [])
        active["autonomous_loop_policy"]["research_contract"] = CONTRACT_VERSION
        self.assertTrue(validate(active))




class ShippedManifestTest(unittest.TestCase):
    def test_the_shipped_queue_is_valid(self):
        data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        self.assertEqual(validate(data), [])



class StructureTest(unittest.TestCase):
    def test_minimal_valid_manifest(self):
        self.assertEqual(validate(manifest(task())), [])

    def test_non_object_manifest_is_rejected(self):
        self.assertTrue(validate([]))

    def test_missing_version_is_rejected(self):
        data = manifest(task())
        data.pop("version")
        self.assertTrue(any("version" in e for e in validate(data)))

    def test_missing_policy_is_rejected(self):
        data = manifest(task())
        data.pop("autonomous_loop_policy")
        self.assertTrue(any("autonomous_loop_policy" in e for e in validate(data)))

    def test_tasks_must_be_a_list(self):
        data = manifest(task())
        data["tasks"] = {}
        self.assertTrue(any("tasks must be a list" in e for e in validate(data)))

    def test_duplicate_ids_are_rejected(self):
        self.assertTrue(any("duplicated" in e for e in validate(manifest(task(), task()))))

    def test_blank_title_is_rejected(self):
        self.assertTrue(any(".title" in e for e in validate(manifest(task(title="  ")))))

    def test_unknown_status_is_rejected(self):
        self.assertTrue(any(".status" in e for e in validate(manifest(task(status="maybe")))))

    def test_unknown_task_type_is_rejected(self):
        self.assertTrue(
            any(".task_type" in e for e in validate(manifest(task(task_type="vibes"))))
        )

    def test_unknown_risk_is_rejected(self):
        self.assertTrue(any(".risk" in e for e in validate(manifest(task(risk="spicy")))))

    def test_non_integer_priority_is_rejected(self):
        self.assertTrue(any(".priority" in e for e in validate(manifest(task(priority="40")))))


class EvidenceTest(unittest.TestCase):
    def test_evidence_is_mandatory(self):
        data = manifest(task())
        data["tasks"][0].pop("evidence")
        self.assertTrue(any(".evidence" in e for e in validate(data)))

    def test_evidence_source_is_mandatory(self):
        data = manifest(task(evidence={"detail": "something"}))
        self.assertTrue(any("evidence.source" in e for e in validate(data)))

    def test_evidence_detail_is_mandatory(self):
        data = manifest(task(evidence={"source": "tsc", "detail": "   "}))
        self.assertTrue(any("evidence.detail" in e for e in validate(data)))

    def test_reported_reproduction_is_valid_but_does_not_permit_verified_status(self):
        evidence = {"source": "research", "detail": "Observed stale clock", "status": "reported",
                    "reproduction": {"steps": ["Resume a synthetic profile"],
                                     "expected": "Current time", "actual": "Stale time"}}
        self.assertEqual(validate(manifest(task(evidence=evidence))), [])
        for status in ("verified", "approved", "", None):
            with self.subTest(status=status):
                self.assertTrue(any(".evidence.status" in error for error in
                                    validate(manifest(task(evidence={**evidence, "status": status})))))

    def test_present_reproduction_requires_actionable_steps_and_results(self):
        valid = {"steps": ["Resume"], "expected": "Current time", "actual": "Stale time"}
        invalid = (None, [], {}, {**valid, "steps": []}, {**valid, "steps": "Resume"},
                   {**valid, "steps": ["Resume", " "]}, {**valid, "expected": " "},
                   {**valid, "actual": 42})
        for reproduction in invalid:
            with self.subTest(reproduction=reproduction):
                evidence = {"source": "research", "detail": "Clock finding", "reproduction": reproduction}
                self.assertTrue(any(".evidence.reproduction" in error for error in
                                    validate(manifest(task(evidence=evidence)))))

    def test_historical_active_and_terminal_evidence_remains_readable_without_promotion(self):
        data = manifest(
            task("active", status="in_progress", execution={
                "state": "dispatched", "attempts": 1, "session_id": "7", "dispatch_key": "first"}),
            task("finished", status="done", execution={
                "state": "completed", "outcome": "no_change", "attempts": 1,
                "session_id": "6", "dispatch_key": "old"}),
        )
        before = copy.deepcopy(data)
        self.assertEqual(validate(data), [])
        self.assertEqual(data, before)


class LifecycleTest(unittest.TestCase):
    def test_valid_execution_block_is_accepted(self):
        data = manifest(task(status="in_progress", execution={
            "attempts": 1, "state": "dispatched", "session_id": "sessions/1",
            "dispatch_key": "abc", "outcome": "", "pull_request": 0,
        }))
        self.assertEqual(validate(data), [])

    def test_unknown_outcome_is_rejected(self):
        data = manifest(task(execution={"outcome": "probably-fine"}))
        self.assertTrue(any("execution.outcome" in e for e in validate(data)))

    def test_unknown_execution_state_is_rejected(self):
        data = manifest(task(execution={"state": "thinking"}))
        self.assertTrue(any("execution.state" in e for e in validate(data)))

    def test_non_integer_attempts_is_rejected(self):
        data = manifest(task(execution={"attempts": "two"}))
        self.assertTrue(any("execution.attempts" in e for e in validate(data)))

    def test_non_integer_pull_request_is_rejected(self):
        data = manifest(task(execution={"pull_request": "53"}))
        self.assertTrue(any("execution.pull_request" in e for e in validate(data)))

    def test_execution_must_be_an_object(self):
        data = manifest(task(execution=[]))
        self.assertTrue(any("execution must be an object" in e for e in validate(data)))

    def test_two_tasks_in_progress_means_a_lost_transition(self):
        data = manifest(
            task("auto-1", status="in_progress"), task("auto-2", status="in_progress")
        )
        self.assertTrue(any("implementation lane" in e for e in validate(data)))

    def test_one_task_in_progress_is_fine(self):
        data = manifest(task("auto-1", status="in_progress"), task("auto-2"))
        self.assertEqual(validate(data), [])

    def test_negative_max_attempts_is_rejected(self):
        data = manifest(task(), lifecycle={"max_attempts": 0})
        self.assertTrue(any("max_attempts" in e for e in validate(data)))

    def test_non_integer_stale_window_is_rejected(self):
        data = manifest(task(), lifecycle={"stale_in_progress_hours": "six"})
        self.assertTrue(any("stale_in_progress_hours" in e for e in validate(data)))

    def test_lifecycle_must_be_an_object(self):
        data = manifest(task(), lifecycle=[])
        self.assertTrue(any("lifecycle must be an object" in e for e in validate(data)))


class ResearchSchemaTest(unittest.TestCase):
    def test_report_recovery_requires_bound_research_and_truthful_parked_state(self):
        execution = {"state": "awaiting_report", "outcome": "report_invalid", "attempts": 1,
                     "session_id": "7", "dispatch_key": "first", "pull_request": 0,
                     "report_error": {"code": "research_json", "detail": "invalid JSON",
                                      "reported_at": "2026-09-13T12:00:00Z"}}
        entry = task(task_type="project_discovery", status="blocked", execution=execution)
        self.assertEqual(validate(manifest(entry)), [])
        for field, value in (("session_id", ""), ("dispatch_key", ""), ("attempts", 0),
                             ("pull_request", 53), ("state", "retry"), ("outcome", "failed"),
                             ("report_error", {"code": "research_json"})):
            with self.subTest(field=field):
                invalid = copy.deepcopy(entry)
                invalid["execution"][field] = value
                self.assertTrue(validate(manifest(invalid)))
        for field, value in (("status", "todo"), ("task_type", "bugfix")):
            invalid = copy.deepcopy(entry)
            invalid[field] = value
            self.assertTrue(validate(manifest(invalid)))

    def test_repair_receipt_cannot_forge_resolution_or_cross_session_provenance(self):
        entry = task(task_type="project_discovery", status="blocked", execution={
            "state": "awaiting_report", "outcome": "report_invalid", "attempts": 1,
            "session_id": "7", "dispatch_key": "first", "pull_request": 0,
            "report_error": {"code": "research_invalid", "detail": "missing report block",
                             "reported_at": "2026-09-13T12:00:00Z"},
            "report_repair": {"at": "2026-09-13T12:00:00Z", "result": "unknown", "status": "pending"},
        })
        self.assertEqual(validate(manifest(entry)), [])
        for changes in ({"at": "yesterday"}, {"result": "retry"}, {"status": "resolved"},
                        {"result": "rejected"}, {"status": "expired"},
                        {"source": {"session_id": "8", "dispatch_key": "other",
                                    "activity_id": "sessions/8/activities/old", "report_sha256": "a" * 64,
                                    "activity_created_at": "2026-09-13T11:59:00Z"}}):
            with self.subTest(changes=changes):
                invalid = copy.deepcopy(entry)
                invalid["execution"]["report_repair"].update(changes)
                self.assertTrue(validate(manifest(invalid)))
        for malformed in (None, "pending", []):
            invalid = copy.deepcopy(entry)
            invalid["execution"]["report_repair"] = malformed
            self.assertTrue(validate(manifest(invalid)))

    def test_repeated_repair_requires_a_settled_monotonic_authorization_chain(self):
        prior = {"at": "2026-09-13T12:00:00Z", "result": "sent", "status": "invalid", "detail": "malformed report"}
        entry = task(task_type="project_discovery", status="blocked", execution={
            "state": "awaiting_report", "outcome": "report_invalid", "attempts": 1,
            "session_id": "7", "dispatch_key": "first", "pull_request": 0,
            "report_error": {"code": "research_invalid", "detail": "missing report block", "reported_at": prior["at"]},
            "report_repair_history": [prior],
            "report_repair": {"at": "2026-09-13T12:10:00Z", "after": prior["at"],
                              "actor": "Owner", "result": "pending", "status": "pending"},
        })
        self.assertEqual(validate(manifest(entry)), [])
        for changes in ({"at": prior["at"]}, {"after": "2026-09-13T11:00:00Z"}, {"actor": ""}):
            invalid = copy.deepcopy(entry)
            invalid["execution"]["report_repair"].update(changes)
            self.assertTrue(validate(manifest(invalid)))
        for history in ([], None, [dict(prior, status="pending")], [prior, prior]):
            invalid = copy.deepcopy(entry)
            invalid["execution"]["report_repair_history"] = history
            self.assertTrue(validate(manifest(invalid)))

    def research_task(self):
        return task(
            task_type="project_discovery", status="done",
            research={
                "area_id": "terminal-input", "perspective_id": "behavior",
                "fingerprint": "a" * 64, "cycle": 1, "previous_reports": [],
            },
            research_result={
                "summary": "Cancellation preserves state",
                "observations": [{"scenario": "Cancel input", "evidence": "Synthetic session transcript", "result": "No input lost"}],
                "next_hypotheses": ["Exercise concurrent cancellation"],
                "proposed_task_ids": [], "completed_at": "2026-09-13T12:00:00Z",
            },
            execution={"state": "completed", "outcome": "researched", "attempts": 1},
        )

    def test_completed_research_and_legacy_done_tasks_coexist(self):
        data = manifest(self.research_task(), task("legacy", status="done", execution={
            "state": "completed", "outcome": "no_change", "attempts": 1,
        }))
        self.assertEqual(validate(data), [])
        data["tasks"][0]["execution"]["outcome"] = "no_change"
        self.assertEqual(validate(data), [])

    def test_malformed_new_results_are_rejected(self):
        invalid = {
            "summary": " ", "observations": [{"scenario": "x", "evidence": 4, "result": "x"}],
            "next_hypotheses": "repeat", "proposed_task_ids": [3],
            "completed_at": "2026-09-13T12:00:00",
        }
        for field, value in invalid.items():
            entry = self.research_task()
            entry["research_result"][field] = value
            with self.subTest(field=field):
                self.assertTrue(any(field in error for error in validate(manifest(entry))))

    def test_completed_scheduled_research_cannot_omit_report(self):
        entry = self.research_task()
        del entry["research_result"]
        self.assertTrue(any("research_result" in error for error in validate(manifest(entry))))
        entry["execution"]["outcome"] = "no_change"
        self.assertTrue(any("research_result" in error for error in validate(manifest(entry))))

    def test_cycle_fingerprint_and_prior_context_are_validated(self):
        for field, value in (("cycle", True), ("cycle", 0), ("fingerprint", "commit-tip"),
                             ("previous_reports", [{}]), ("area_id", "")):
            entry = self.research_task()
            entry["research"][field] = value
            with self.subTest(field=field, value=value):
                self.assertTrue(any(field in error for error in validate(manifest(entry))))
        entry = self.research_task()
        report = copy.deepcopy(entry["research_result"])
        entry["research"]["previous_reports"] = [report]
        self.assertEqual(validate(manifest(entry)), [])
        entry["research"]["previous_reports"] = [report] * 4
        self.assertTrue(any("bounded" in error for error in validate(manifest(entry))))

    def test_deferred_review_requires_complete_truthful_state(self):
        entry = task(status="blocked", execution={
            "state": "awaiting_review", "outcome": "review_required", "pull_request": 53,
        })
        self.assertEqual(validate(manifest(entry)), [])
        entry["status"] = "in_progress"
        self.assertTrue(any("manual review" in error for error in validate(manifest(entry))))


class ProposalAndLaneTest(unittest.TestCase):
    def decision(self, action="approve"):
        return {"action": action, "actor": "Owner", "at": "2026-09-14T12:00:00Z", "note": "Reviewed"}

    def research(self, task_id="research", *, detached=False):
        execution = {"state": "dispatched", "attempts": 1, "session_id": task_id,
                     "dispatch_key": task_id, "starting_branch": "autonomous/attempt-" + task_id,
                     "base_sha": "a" * 40, "session_state": "AWAITING_USER_FEEDBACK"}
        if detached:
            execution["research_detached"] = {"at": "2026-09-14T12:00:00Z", "reason": "AWAITING_USER_FEEDBACK"}
        return task(task_id, task_type="project_discovery", status="in_progress", execution=execution,
                    research={"area_id": task_id, "perspective_id": "behavior", "fingerprint": "a" * 64,
                              "cycle": 1, "previous_reports": []})

    def test_pending_and_historical_records_are_valid_without_migration(self):
        data = manifest(task("new", status="proposed"), task("legacy"),
                        task("approved", proposal_decision=self.decision()))
        before = copy.deepcopy(data)
        self.assertEqual(validate(data), [])
        self.assertEqual(data, before)

    def test_decision_requires_human_audit_and_consistent_lifecycle(self):
        for field, value in (("actor", " "), ("note", None), ("at", "2026-09-14T12:00:00"),
                             ("at", "2026-09-14T12:00:00+01:00"), ("action", "implement")):
            with self.subTest(field=field, value=value):
                decision = self.decision()
                decision[field] = value
                self.assertTrue(validate(manifest(task(proposal_decision=decision))))
        for entry in (task(status="proposed", proposal_decision=self.decision()),
                      task(task_type="project_discovery", proposal_decision=self.decision()),
                      task(status="proposed", execution={"attempts": 1}),
                      task(proposal_decision=self.decision("reject"))):
            self.assertTrue(validate(manifest(entry)))

    def test_human_closure_preserves_failed_worker_without_faking_completion(self):
        entry = task(status="done", proposal_decision=self.decision("reject"), execution={
            "state": "exhausted", "outcome": "failed", "attempts": 2, "session_id": "old",
            "session_state": "FAILED", "dispatch_key": "original"})
        self.assertEqual(validate(manifest(entry)), [])
        for changes in ({"session_state": "UNKNOWN"}, {"state": "quarantined", "outcome": "stale"},
                        {"pull_request": 53}, {"state": "awaiting_review", "outcome": "review_required"}):
            with self.subTest(changes=changes):
                invalid = copy.deepcopy(entry)
                invalid["execution"].update(changes)
                self.assertTrue(validate(manifest(invalid)))

    def test_pending_repair_blocks_its_scope_but_neither_foreground_lane(self):
        repairing = self.research("repairing")
        repairing["status"] = "blocked"
        repairing["execution"].update(
            state="awaiting_report", outcome="report_invalid",
            report_error={"code": "research_invalid", "detail": "missing block", "reported_at": "2026-09-14T12:00:00Z"},
            report_repair={"at": "2026-09-14T12:00:00Z", "result": "sent", "status": "pending"},
        )
        foreground = self.research("foreground")
        data = manifest(task("implementation", status="in_progress"), repairing, foreground)
        self.assertEqual(validate(data), [])
        foreground["research"].update(repairing["research"])
        self.assertTrue(any("pair" in error for error in validate(data)))

    def test_lanes_allow_foreground_research_and_implementation_plus_detached_research(self):
        data = manifest(task("implementation", status="in_progress"), self.research("foreground"),
                        self.research("detached", detached=True))
        self.assertEqual(validate(data), [])
        data["tasks"][2]["execution"]["session_state"] = "IN_PROGRESS"
        self.assertEqual(validate(data), [])
        data["tasks"].append(self.research("second"))
        self.assertTrue(any("research lane" in error for error in validate(data)))

    def test_quarantine_also_occupies_its_lane(self):
        quarantined = task("lost", status="blocked", execution={"state": "quarantined", "outcome": "stale"})
        self.assertTrue(any("implementation lane" in error for error in
                            validate(manifest(quarantined, task(status="in_progress")))))
        self.assertEqual(validate(manifest(quarantined, self.research())), [])

    def test_detachment_cannot_hide_duplicate_pair_or_unpinned_attempt(self):
        detached = self.research("detached", detached=True)
        other = self.research("other")
        other["research"].update(detached["research"], fingerprint="b" * 64)
        self.assertTrue(any("pair" in error for error in validate(manifest(detached, other))))
        for changes in ({"session_id": ""}, {"attempts": 0}, {"base_sha": "moving-main"},
                        {"starting_branch": "autonomous/lab"},
                        {"research_detached": {"at": "2026-09-14", "reason": "PAUSED"}},
                        {"research_detached": {"at": "2026-09-14T12:00:00Z", "reason": "UNKNOWN"}}):
            with self.subTest(changes=changes):
                invalid = copy.deepcopy(detached)
                invalid["execution"].update(changes)
                self.assertTrue(validate(manifest(invalid)))
        detached["task_type"] = "bugfix"
        detached.pop("research")
        self.assertTrue(validate(manifest(detached)))

    def test_nudge_receipt_belongs_only_to_saved_research_session(self):
        entry = self.research()
        for result in ("pending", "sent", "unknown", "rejected"):
            entry["execution"]["feedback_nudge"] = {"at": "2026-09-14T12:00:00Z", "result": result}
            self.assertEqual(validate(manifest(entry)), [])
        for value in (None, {}, {"at": "2026-09-14", "result": "sent"},
                      {"at": "2026-09-14T12:00:00Z", "result": "retry"}):
            invalid = copy.deepcopy(entry)
            invalid["execution"]["feedback_nudge"] = value
            self.assertTrue(validate(manifest(invalid)))
        entry["task_type"] = "bugfix"
        entry.pop("research")
        self.assertTrue(validate(manifest(entry)))


class HistoricalReviewContextTest(unittest.TestCase):
    def linked_queue(self):
        stamp = "2026-09-14T12:00:00Z"
        source = {"session_id": "s1", "dispatch_key": "d1", "activity_id": "sessions/s1/activities/a1",
                  "report_sha256": "a" * 64, "activity_created_at": stamp}
        previous = task("previous", status="done", proposal_decision={
            "action": "reject", "actor": "Owner", "at": stamp, "note": "Inspected"})
        context = {"kind": "historical_decision_overlap", "matches": [
            {"task_id": "previous", "action": "reject", "decision_at": stamp, "match": "exact", "timing": "pre"}]}
        candidate = task("candidate", status="proposed", origin={"task_id": "research", **source},
                         review_context=copy.deepcopy(context))
        deferred = {"title": "Prior clock claim", "reason": "historical_predecision_overlap",
                    "evidence": "Observed old clock", "target_paths": ["src/clock.ts"],
                    "acceptance": ["Clock advances"], "review_context": copy.deepcopy(context)}
        research = task("research", task_type="project_discovery", status="done", research_result={
            "summary": "Observed clock", "observations": [
                {"scenario": "resume", "evidence": "clock reading", "result": "stale"}],
            "next_hypotheses": [], "proposed_task_ids": ["candidate"], "completed_at": stamp,
            "source": source, "deferred_findings": [deferred]}, discovery_import={
                "source": source, "result": {"status": "ok", "changed": True, "added": ["candidate"],
                    "duplicates": [], "skipped": [], "deferred": [copy.deepcopy(deferred)],
                    "detail": "Imported findings", "unverified_count": 0}})
        return manifest(previous, candidate, research)

    def test_candidate_and_both_deferred_copies_validate_canonical_decision_and_time(self):
        original = self.linked_queue()
        self.assertEqual(validate(original), [])
        def contexts(data):
            return [data["tasks"][1]["review_context"],
                    data["tasks"][2]["research_result"]["deferred_findings"][0]["review_context"],
                    data["tasks"][2]["discovery_import"]["result"]["deferred"][0]["review_context"]]
        for index in range(3):
            for changes in ({"task_id": "missing"}, {"task_id": "research"}, {"action": "resolve"},
                            {"decision_at": "2026-09-14T11:59:59Z"}, {"timing": "post"}, {"match": []}):
                with self.subTest(location=index, changes=changes):
                    data = copy.deepcopy(original)
                    contexts(data)[index]["matches"][0].update(changes)
                    self.assertTrue(validate(data))
            data = copy.deepcopy(original)
            context = contexts(data)[index]
            context["matches"].append(copy.deepcopy(context["matches"][0]))
            self.assertTrue(validate(data))
        data = copy.deepcopy(original)
        data["tasks"][0].pop("proposal_decision")
        self.assertTrue(validate(data))
        data = copy.deepcopy(original)
        data["tasks"][1]["origin"].pop("activity_id")
        self.assertTrue(validate(data))
        self.assertEqual(validate(original), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
