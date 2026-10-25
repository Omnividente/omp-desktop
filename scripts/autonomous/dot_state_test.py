#!/usr/bin/env python3
"""Pure state regressions with synthetic records; no live fixtures or clients."""
from __future__ import annotations

import copy
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dot_authority import digest
from dot_state import (REPOSITORY, WORKFLOWS, complete_task, migrate_state, regrant_state,
                       prepare_operation, reconcile_operation)

NOW = datetime(2026, 10, 25, 13, tzinfo=timezone.utc)
TASK_ID = "terminal-worker-observation-20261025"
BRANCH = "dot/jules-" + TASK_ID
HEAD = "41e16f1c096c72006a986bd7f5de877d9e11b104"
ORIGINAL_BASE = "0ea918ce7dfef1c26548772f7a3ec950f1449706"
BASE, TESTED_MERGE, TREE, BLOB, MERGE, MAIN = (char * 40 for char in "bcdef1")
OLD_GRANT = "r2-j-5ced6a1fb5fa4440a69023073c964abf"
NEW_GRANT = "r2-j-v2-" + "2" * 32
PATHS = ["scripts/autonomous/" + name for name in (
    "lab_controller.py", "lab_controller_test.py", "loop_health.py", "loop_health_test.py")]


def legacy_state():
    # Shape and task identity from the contract; all receipts below are synthetic.
    # Historical operation fields are deliberately opaque to the v2 transitions.
    return {"schema": 1, "grant_id": OLD_GRANT,
            "active_task": {"id": TASK_ID, "branch": BRANCH, "base_sha": ORIGINAL_BASE,
                            "head_sha": HEAD, "spent_lines": 79, "ci_revisions": 0,
                            "touched_paths": list(PATHS), "initial_published": True,
                            "unresolved_operation": None, "phase": "awaiting_owner",
                            "pr": {"number": 148, "draft": True,
                                   "url": "urn:synthetic:pr:148"},
                            "batches": [{"id": "initial", "spent_lines": 79,
                                         "receipts": [{"result": "published"}]}],
                            "created_at": "2026-10-25T11:00:00+00:00",
                            "handoff": {"peer": "legacy-author-claim", "ci": "legacy-green"}},
            "lease": None, "pending_operation": None,
            "retired_task_ids": ["synthetic-prior-task"],
            "operations": [{"id": "legacy-publish", "kind": "draft_update",
                            "task_id": TASK_ID, "result": "get-confirm-required",
                            "receipt": {"request": {"expected_head_sha": HEAD}}}],
            "backlog": [{"id": "next-synthetic-task", "notes": ["read-only finding"]}],
            "last_sweep_at": "2026-10-25T12:00:00+00:00",
            "created_at": "2026-10-25T10:00:00+00:00"}


def state():
    result = legacy_state()
    result.update(schema=2, grant_id=NEW_GRANT,
                  lease={"id": "lease-1", "task_id": TASK_ID, "claimed_at": NOW.isoformat()})
    result["active_task"]["phase"] = "review_required"
    return result


def preflight():
    return {"grant_id": NEW_GRANT, "task_id": TASK_ID, "branch": BRANCH,
            "pr_number": 148, "head_sha": HEAD, "base_sha": BASE,
            "pr_node_id": "PR_synthetic_148",
            "tested_merge_sha": TESTED_MERGE, "tested_tree_sha": TREE,
            "policy_sha256": "3" * 64, "preflight_sha256": "4" * 64,
            "expected_state_blob_sha": BLOB}


def prepared(kind="squash_merge"):
    return prepare_operation(state(), kind, preflight(), operation_id="op-1",
                             lease_id="lease-1", now=NOW)


def ready_observation():
    return {"pr": {"repository": REPOSITORY, "number": 148, "branch": BRANCH,
                   "node_id": "PR_synthetic_148",
                   "head_sha": HEAD, "base_sha": BASE,
                   "draft": False, "state": "open", "merged": False}}


def merge_observation():
    observation = ready_observation()
    observation["pr"].update(state="closed", merged=True, merge_commit_sha=MERGE,
                             merged_at=NOW.isoformat())
    observation.update(commit={"sha": MERGE, "parents": [BASE], "tree_sha": TREE},
                       current_main_sha=MAIN, main_contains_merge=True,
                       installed_tree_matches=True, installed_files_match=True,
                       evidence_uri="urn:synthetic:github-merge-observation:1")
    return observation


def merged_state():
    return reconcile_operation(prepared(), merge_observation(), now=NOW)


def post_evidence():
    return {"grant_id": NEW_GRANT, "task_id": TASK_ID, "merge_commit_sha": MERGE,
            "lease_id": "lease-1",
            "actual_main_sha": MAIN, "main_contains_merge": True, "installed_files_match": True,
            "post_ci": {"head_sha": MERGE, "status": "completed", "conclusion": "success",
                        "runs": [{"id": index + 100, "attempt": 1, "head_sha": MERGE,
                                  "event": "push", "conclusion": "success", "path": path}
                                 for index, path in enumerate(WORKFLOWS)]},
            "evidence_uri": "urn:synthetic:post-main-ci:1"}


def new_grant(accepted=None):
    return {"schema": 2, "version": 2, "kind": "dot-r2-j-grant", "id": NEW_GRANT,
            "repository": REPOSITORY, "policy_sha256": "3" * 64,
            "policy_path": "docs/dot/r2-j-policy-v2.json", "supersedes_grant_id": OLD_GRANT,
            "acceptance": copy.deepcopy(owner_acceptance() if accepted is None else accepted)}


def owner_acceptance(original=None):
    original = legacy_state() if original is None else original
    return {"decision": "accept", "decision_ref": "urn:synthetic:owner-exact-migration:1",
            "supersedes_grant_id": OLD_GRANT, "expected_state_blob_sha": BLOB,
            "state_sha256": digest(original), "adopted_task_id": TASK_ID,
            "adopted_pr": 148, "adopted_head_sha": HEAD}


class StateTest(unittest.TestCase):
    def call(self, function, *args, **kwargs):
        before = copy.deepcopy((args, kwargs))
        result = function(*args, **kwargs)
        self.assertEqual((args, kwargs), before, "pure transitions must not mutate inputs")
        self.assertIsNot(result, args[0])
        return result

    def denied(self, function, *args, **kwargs):
        before = copy.deepcopy((args, kwargs))
        with self.assertRaises(ValueError):
            function(*args, **kwargs)
        self.assertEqual((args, kwargs), before, "denial must preserve the complete input")

    def prepare(self, source, evidence=None, **kwargs):
        return self.call(prepare_operation, source, kwargs.pop("kind", "squash_merge"),
                         preflight() if evidence is None else evidence,
                         operation_id=kwargs.pop("operation_id", "op-1"),
                         lease_id=kwargs.pop("lease_id", "lease-1"), now=NOW, **kwargs)

    def deny_prepare(self, source, evidence=None, **kwargs):
        self.denied(prepare_operation, source, kwargs.pop("kind", "squash_merge"),
                    preflight() if evidence is None else evidence,
                    operation_id=kwargs.pop("operation_id", "op-1"),
                    lease_id=kwargs.pop("lease_id", "lease-1"), now=NOW, **kwargs)

    def test_prepare_records_exact_consumed_request_before_send_and_preserves_original_base(self):
        source = state()
        evidence = preflight()
        result = self.prepare(source, evidence)
        operation = result["pending_operation"]
        intent = operation["intent"]
        self.assertEqual(operation["send_claim"], {"consumed": True, "lease_id": "lease-1"})
        self.assertEqual(operation["status"], "pending")
        self.assertEqual(operation["intent_sha256"], digest(intent))
        self.assertEqual(operation["request_sha256"], digest(intent["request"]))
        self.assertEqual(intent["request"], {
            "method": "PUT", "path": "/repos/" + REPOSITORY + "/pulls/148/merge",
            "body": {"sha": HEAD, "merge_method": "squash"}})
        self.assertEqual(intent["expected"], {
            "repository": REPOSITORY, "number": 148, "branch": BRANCH, "head_sha": HEAD,
            "node_id": "PR_synthetic_148",
            "base_sha": BASE, "tested_merge_sha": TESTED_MERGE, "tested_tree_sha": TREE})
        for key in ("expected_state_blob_sha", "preflight_sha256", "policy_sha256"):
            self.assertEqual(intent[key], evidence[key])
        expected_task = copy.deepcopy(source["active_task"])
        expected_task["phase"] = "merge_pending"
        self.assertEqual(result["active_task"], expected_task)
        self.assertEqual(result["active_task"]["base_sha"], ORIGINAL_BASE)
        self.assertEqual(result["operations"][:-1], source["operations"])
        self.assertEqual(result["lease"], source["lease"])
        self.assertEqual(result["backlog"], source["backlog"])
        self.assertIsNot(operation, result["operations"][-1])
        result["active_task"]["batches"][0]["receipts"].append({"new": True})
        result["operations"][0]["receipt"]["request"]["expected_head_sha"] = "0" * 40
        result["backlog"][0]["notes"].append("isolated")
        intent["request"]["body"]["sha"] = "0" * 40
        self.assertEqual(source, state())
        self.assertEqual(evidence, preflight())
        self.assertEqual(result["operations"][-1]["intent"]["request"]["body"]["sha"], HEAD)


    def test_prepare_requires_actual_matching_lease_and_no_pending_or_retired_task(self):
        for mutate in (
            lambda s: s.update(schema=1),
            lambda s: s.update(lease=None),
            lambda s: s["lease"].update(id="foreign"),
            lambda s: s["lease"].update(task_id="foreign"),
            lambda s: s.update(pending_operation={"result": "unknown"}),
            lambda s: s["active_task"].update(unresolved_operation={"result": "unknown"}),
            lambda s: s["retired_task_ids"].append(TASK_ID),
            lambda s: s["active_task"].update(phase="post_merge"),
            lambda s: s["active_task"].update(spent_lines=-1),
            lambda s: s["active_task"].update(ci_revisions=True),
        ):
            source = state(); mutate(source)
            with self.subTest(source=source):
                self.deny_prepare(source)
        self.deny_prepare(state(), lease_id="other")
        self.deny_prepare(state(), operation_id="")
        self.deny_prepare(state(), operation_id="legacy-publish")

    def test_missing_task_operation_state_and_malformed_identity_fail_closed(self):
        for mutate in (
            lambda s: s["active_task"].pop("unresolved_operation"),
            lambda s: s["active_task"].update(id="not/a/task"),
            lambda s: s["active_task"].update(pr=None),
            lambda s: s["active_task"]["pr"].update(number=True),
        ):
            source = state(); mutate(source)
            self.deny_prepare(source)

    def test_every_preflight_identity_and_digest_is_required_and_exact(self):
        for key in preflight():
            evidence = preflight(); evidence.pop(key)
            with self.subTest(missing=key):
                self.deny_prepare(state(), evidence)
        for key, value in (
            ("grant_id", OLD_GRANT), ("task_id", "other"), ("branch", BRANCH + "-other"),
            ("pr_number", 149), ("pr_number", True), ("head_sha", MAIN),
            ("repository", "foreign/repo"), ("base_sha", "bad"),
            ("tested_merge_sha", "bad"), ("tested_tree_sha", "bad"),
            ("expected_state_blob_sha", "3" * 64), ("policy_sha256", BLOB),
            ("preflight_sha256", "Z" * 64),
        ):
            evidence = preflight(); evidence[key] = value
            with self.subTest(key=key, value=value):
                self.deny_prepare(state(), evidence)

    def test_no_duplicate_task_kind_head_even_with_new_operation_or_lease(self):
        for kind in ("ready_for_review", "squash_merge"):
            source = prepared(kind)
            self.deny_prepare(source, kind=kind, operation_id="new-id")
            # Even an external phase/lease reset cannot erase the consumed tuple.
            source["pending_operation"] = None
            source["active_task"]["phase"] = "review_required"
            source["lease"]["id"] = "lease-2"
            self.deny_prepare(source, kind=kind, operation_id="new-id", lease_id="lease-2")

    def test_unknown_error_rejection_and_lost_ack_never_authorize_replay(self):
        for kind in ("ready_for_review", "squash_merge"):
            observations = [{}, {"result": "unknown"}, {"error": "lost acknowledgement"},
                            {"result": "rejected"}, {"pr": {}}]
            unchanged_pr = ready_observation()
            if kind == "ready_for_review":
                unchanged_pr["pr"]["draft"] = True
            observations.append(unchanged_pr)
            for observation in observations:
                with self.subTest(kind=kind, observation=observation):
                    source = prepared(kind)
                    result = self.call(reconcile_operation, source, observation, now=NOW)
                    self.assertEqual(result, source)
                    self.deny_prepare(result, kind=kind, operation_id="attempt-2")
                    self.denied(complete_task, result, post_evidence(), now=NOW)
                    result["pending_operation"]["intent"]["expected"]["head_sha"] = MAIN
                    result["backlog"][0]["notes"].append("copy-only")
                    self.assertEqual(source, prepared(kind))
            # A later GET, not a resend, settles the original consumed claim.
            source = self.call(reconcile_operation, prepared(kind), {"result": "unknown"}, now=NOW)
            actual = ready_observation() if kind == "ready_for_review" else merge_observation()
            result = self.call(reconcile_operation, source, actual, now=NOW)
            self.assertIsNone(result["pending_operation"])
            self.assertEqual(len(result["operations"]), len(source["operations"]))
            self.assertEqual(result["operations"][-1]["send_claim"], source["operations"][-1]["send_claim"])
            self.deny_prepare(result, kind=kind, operation_id="attempt-2")

    def test_ready_lost_ack_settles_by_get_without_a_transport_correlation_echo(self):
        reserved = prepared("ready_for_review")
        unknown = self.call(reconcile_operation, reserved, {"error": "lost acknowledgement"}, now=NOW)
        self.assertEqual(unknown, reserved)
        self.deny_prepare(unknown, kind="ready_for_review", operation_id="retry-after-timeout")
        confirmed = self.call(reconcile_operation, unknown, ready_observation(), now=NOW)
        self.assertIsNone(confirmed["pending_operation"])
        self.assertEqual(confirmed["active_task"]["phase"], "ready")
        self.assertEqual(confirmed["operations"][-1]["send_claim"], reserved["pending_operation"]["send_claim"])
        self.assertEqual(confirmed["operations"][-1]["request_sha256"], reserved["pending_operation"]["request_sha256"])
        self.assertEqual(len(confirmed["operations"]), len(reserved["operations"]))
        self.assertEqual((confirmed["active_task"]["spent_lines"], confirmed["active_task"]["ci_revisions"]), (79, 0))
        self.deny_prepare(confirmed, kind="ready_for_review", operation_id="retry-after-get")
        self.denied(complete_task, confirmed, post_evidence(), now=NOW)

    def test_ready_ref_race_after_lost_ack_cannot_confirm_or_issue_another_ready(self):
        source = self.call(reconcile_operation, prepared("ready_for_review"),
                           {"result": "unknown"}, now=NOW)
        for key, value in (("head_sha", MAIN), ("base_sha", ORIGINAL_BASE),
                           ("number", 149), ("repository", "foreign/repo")):
            observed = ready_observation(); observed["pr"][key] = value
            with self.subTest(changed=key):
                self.denied(reconcile_operation, source, observed, now=NOW)
                self.deny_prepare(source, kind="ready_for_review", operation_id="another-ready")
                self.deny_prepare(source, kind="squash_merge", operation_id="premature-merge")

    def test_ready_cas_conflict_cannot_adopt_an_unpersisted_candidate(self):
        source = state()
        candidate = self.prepare(source, kind="ready_for_review")
        # A conflicting writer's durable state has no copy of our candidate.
        persisted = copy.deepcopy(source)
        persisted["backlog"].append({"id": "concurrent-read-only-checkpoint"})
        self.denied(reconcile_operation, persisted, ready_observation(), now=NOW)
        self.assertIsNone(persisted["pending_operation"])
        self.assertEqual(persisted["operations"], source["operations"])
        self.assertEqual((persisted["active_task"]["spent_lines"], persisted["active_task"]["ci_revisions"]), (79, 0))
        self.assertEqual(candidate["pending_operation"]["intent"]["expected_state_blob_sha"], BLOB)

    def test_ready_pending_history_disagreement_cannot_adopt_the_observed_pr(self):
        source = prepared("ready_for_review")
        source["operations"][-1]["send_claim"]["lease_id"] = "another-sender"
        self.denied(reconcile_operation, source, ready_observation(), now=NOW)
        self.deny_prepare(source, kind="ready_for_review", operation_id="replacement-ready")

    def test_ready_cannot_relabel_the_plugin_call_even_with_recomputed_digests(self):
        for mutate in (
            lambda request: request["arguments"].update(repository_full_name="foreign/repo"),
            lambda request: request["arguments"].update(pr_number=149),
            lambda request: request["arguments"].update(clientMutationId="not-supported-by-plugin"),
            lambda request: request.update(tool="merge_pull_request"),
        ):
            source = prepared("ready_for_review")
            pending = source["pending_operation"]
            mutate(pending["intent"]["request"])
            pending["request_sha256"] = digest(pending["intent"]["request"])
            pending["intent_sha256"] = digest(pending["intent"])
            source["operations"][-1] = copy.deepcopy(pending)
            self.denied(reconcile_operation, source, ready_observation(), now=NOW)

    def test_ready_only_settles_exact_open_unmerged_nondraft_pr(self):
        source = prepared("ready_for_review")
        result = self.call(reconcile_operation, source, ready_observation(), now=NOW)
        self.assertEqual(result["active_task"]["phase"], "ready")
        self.assertEqual(result["operations"][-1]["status"], "confirmed")
        self.assertEqual(result["active_task"]["spent_lines"], 79)
        self.assertIsNotNone(result["active_task"])
        for key in ("repository", "number", "branch", "head_sha", "base_sha", "draft", "state", "merged"):
            observation = ready_observation(); observation["pr"].pop(key)
            with self.subTest(missing=key):
                self.assertEqual(self.call(reconcile_operation, source, observation, now=NOW), source)
        for changes in ({"merged": True}, {"state": "closed"}):
            observation = ready_observation(); observation["pr"].update(changes)
            self.denied(reconcile_operation, source, observation, now=NOW)

    def test_reconciliation_rejects_every_foreign_pr_ref_identity(self):
        for kind in ("ready_for_review", "squash_merge"):
            for key, value in (("repository", "foreign/repo"), ("number", 149),
                               ("number", True), ("branch", BRANCH + "-foreign"),
                               ("node_id", "PR_foreign_149"),
                               ("head_sha", MAIN), ("base_sha", ORIGINAL_BASE)):
                observation = ready_observation() if kind == "ready_for_review" else merge_observation()
                observation["pr"][key] = value
                with self.subTest(kind=kind, key=key):
                    self.denied(reconcile_operation, prepared(kind), observation, now=NOW)

    def test_error_or_explicit_rejection_cannot_be_reinterpreted_as_a_new_send_claim(self):
        for kind in ("ready_for_review", "squash_merge"):
            for result_kind in ("unknown", "error", "rejected"):
                observation = ready_observation() if kind == "ready_for_review" else merge_observation()
                observation["result"] = result_kind
                source = prepared(kind)
                result = self.call(reconcile_operation, source, observation, now=NOW)
                self.assertEqual(result, source)
                self.deny_prepare(result, kind=kind, operation_id="replacement-id")

    def test_primary_bound_http_rejection_releases_review_but_never_replays_same_head(self):
        for kind in ("ready_for_review", "squash_merge"):
            for status in (405, 409, 422):
                source = prepared(kind)
                rejection = {"operation_id": "op-1",
                             "request_sha256": source["pending_operation"]["request_sha256"],
                             "http_status": status, "evidence_uri": "urn:synthetic:primary-response:1"}
                observation = {"rejection": rejection}
                result = self.call(reconcile_operation, source, observation, now=NOW)
                self.assertIsNone(result["pending_operation"])
                self.assertEqual(result["active_task"]["phase"], "review_required")
                self.assertEqual((result["active_task"]["spent_lines"], result["active_task"]["ci_revisions"]), (79, 0))
                self.assertEqual(len(result["operations"]), len(source["operations"]))
                self.assertEqual(result["operations"][-1]["status"], "rejected")
                self.assertEqual(result["operations"][-1]["send_claim"], source["pending_operation"]["send_claim"])
                self.assertEqual(result["operations"][-1]["intent"], source["pending_operation"]["intent"])
                self.deny_prepare(result, kind=kind, operation_id="new-op")
                base_only = preflight(); base_only["base_sha"] = MAIN
                self.deny_prepare(result, base_only, kind=kind, operation_id="new-op")
                self.denied(complete_task, result, post_evidence(), now=NOW)
                # Reservation and refreshed policy preflight occur in the caller.
                revised = copy.deepcopy(result)
                revised["active_task"].update(head_sha=MAIN, spent_lines=99, ci_revisions=1)
                fresh = preflight(); fresh.update(head_sha=MAIN, expected_state_blob_sha="9" * 40)
                reserved = self.prepare(revised, fresh, kind=kind, operation_id="new-head-op")
                self.assertEqual(len(reserved["operations"]), len(source["operations"]) + 1)
                self.assertEqual(reserved["operations"][-2]["status"], "rejected")
                self.assertEqual((reserved["active_task"]["spent_lines"], reserved["active_task"]["ci_revisions"]), (99, 1))
                result["operations"][-1]["receipt"]["observation"]["rejection"]["evidence_uri"] = "copy-only"
                self.assertEqual(rejection["evidence_uri"], "urn:synthetic:primary-response:1")

    def test_unbound_incomplete_or_ambiguous_http_response_keeps_pending(self):
        source = prepared()
        exact = {"operation_id": "op-1",
                 "request_sha256": source["pending_operation"]["request_sha256"],
                 "http_status": 409, "evidence_uri": "urn:synthetic:primary-response:1"}
        for key in exact:
            rejection = dict(exact); rejection.pop(key)
            result = self.call(reconcile_operation, source, {"rejection": rejection}, now=NOW)
            self.assertEqual(result, source)
        for status in (200, 403, 429, 500, "409", None, True):
            rejection = dict(exact); rejection["http_status"] = status
            result = self.call(reconcile_operation, source, {"rejection": rejection}, now=NOW)
            self.assertEqual(result, source)
        for key, value in (("operation_id", "foreign-op"), ("request_sha256", "0" * 64)):
            rejection = dict(exact); rejection[key] = value
            self.denied(reconcile_operation, source, {"rejection": rejection}, now=NOW)
        contradiction = merge_observation(); contradiction["rejection"] = exact
        self.denied(reconcile_operation, source, contradiction, now=NOW)

    def test_consumed_claim_and_history_cannot_be_relabelled_or_replaced(self):
        for mutate in (
            lambda s: s["pending_operation"]["send_claim"].update(consumed=False),
            lambda s: s["pending_operation"]["send_claim"].update(consumed=1),
            lambda s: s["pending_operation"]["intent"].update(kind="ready_for_review"),
            lambda s: s["pending_operation"]["intent"]["expected"].update(head_sha=MAIN),
            lambda s: s["pending_operation"].update(intent_sha256="0" * 64),
            lambda s: s["pending_operation"].pop("id"),
            lambda s: s["pending_operation"]["intent"].pop("lease_id"),
            lambda s: s["pending_operation"]["intent"].pop("prepared_at"),
            lambda s: s["operations"].pop(),
            lambda s: s["operations"].append(copy.deepcopy(s["operations"][-1])),
            lambda s: s["active_task"].update(head_sha=MAIN),
        ):
            source = prepared(); mutate(source)
            self.denied(reconcile_operation, source, merge_observation(), now=NOW)

    def test_merge_requires_exact_squash_commit_tree_parent_main_and_installed_files(self):
        mutations = (
            lambda o: o["pr"].update(state="open"),
            lambda o: o["pr"].update(merge_commit_sha=HEAD),
            lambda o: o["pr"].update(merged_at=(NOW + timedelta(seconds=1)).isoformat()),
            lambda o: o["pr"].pop("merged_at"),
            lambda o: o["commit"].update(sha=HEAD),
            lambda o: o["commit"].update(tree_sha=MAIN),
            lambda o: o["commit"].update(parents=[ORIGINAL_BASE]),
            lambda o: o["commit"].update(parents=[BASE, HEAD]),
            lambda o: o["commit"].update(parents=[]),
            lambda o: o.update(current_main_sha="bad"),
            lambda o: o.update(main_contains_merge=False),
            lambda o: o.update(main_contains_merge=1),
            lambda o: o.update(installed_tree_matches=False),
            lambda o: o.update(installed_files_match=False),
            lambda o: o.pop("commit"),
            lambda o: o.pop("evidence_uri"),
        )
        for index, mutate in enumerate(mutations):
            observation = merge_observation(); mutate(observation)
            with self.subTest(case=index):
                self.denied(reconcile_operation, prepared(), observation, now=NOW)

    def test_merge_receipt_is_deeply_copied_and_does_not_retire_task_before_post_ci(self):
        source, observation = prepared(), merge_observation()
        observation["evidence_uris"] = ["urn:synthetic:ancestry:1"]
        result = self.call(reconcile_operation, source, observation, now=NOW)
        task = result["active_task"]
        self.assertEqual(task["phase"], "post_merge")
        self.assertEqual(task["merge_receipt"]["merge_commit_sha"], MERGE)
        self.assertEqual(task["base_sha"], ORIGINAL_BASE)
        self.assertEqual(task["head_sha"], HEAD)
        self.assertEqual((task["spent_lines"], task["ci_revisions"]), (79, 0))
        self.assertEqual(result["retired_task_ids"], source["retired_task_ids"])
        self.assertEqual(result["operations"][:-1], source["operations"][:-1])
        self.assertEqual(result["lease"], source["lease"])
        receipt = result["operations"][-1]["receipt"]
        self.assertEqual(receipt, task["merge_receipt"])
        task["merge_receipt"]["observation"]["commit"]["parents"].append(HEAD)
        self.assertEqual(receipt["observation"]["commit"]["parents"], [BASE])
        receipt["observation"]["evidence_uris"].append("urn:synthetic:copy")
        self.assertEqual(observation["evidence_uris"], ["urn:synthetic:ancestry:1"])
        self.assertEqual(source, prepared())

    def test_post_ci_is_mandatory_exact_push_merge_sha_with_distinct_workflows_and_runs(self):
        mutations = (
            lambda p: p.pop("post_ci"),
            lambda p: p.update(grant_id=OLD_GRANT),
            lambda p: p.update(task_id="next-synthetic-task"),
            lambda p: p.update(merge_commit_sha=HEAD),
            lambda p: p.update(actual_main_sha="bad"),
            lambda p: p.update(main_contains_merge=False),
            lambda p: p.update(installed_files_match=False),
            lambda p: p.update(lease_id="another-invocation"),
            lambda p: p.pop("evidence_uri"),
            lambda p: p["post_ci"].update(head_sha=HEAD),
            lambda p: p["post_ci"].update(status="in_progress"),
            lambda p: p["post_ci"].update(conclusion="failure"),
            lambda p: p["post_ci"]["runs"].pop(),
            lambda p: p["post_ci"]["runs"].append(copy.deepcopy(p["post_ci"]["runs"][0])),
            lambda p: p["post_ci"]["runs"][1].update(id=100),
            lambda p: p["post_ci"]["runs"][0].update(id=True),
            lambda p: p["post_ci"]["runs"][0].update(attempt=0),
            lambda p: p["post_ci"]["runs"][0].update(attempt=True),
            lambda p: p["post_ci"]["runs"][0].update(head_sha=MAIN),
            lambda p: p["post_ci"]["runs"][0].update(event="pull_request"),
            lambda p: p["post_ci"]["runs"][0].update(conclusion="failure"),
            lambda p: p["post_ci"]["runs"][0].update(status="in_progress"),
            lambda p: p["post_ci"]["runs"][0].update(path=WORKFLOWS[1]),
            lambda p: p["post_ci"]["runs"][0].update(path=".github/workflows/normal-jules.yml"),
        )
        for index, mutate in enumerate(mutations):
            post = post_evidence(); mutate(post)
            with self.subTest(case=index):
                source = merged_state()
                self.denied(complete_task, source, post, now=NOW)
                self.assertIsNotNone(source["active_task"], "failed proof cannot enable next task")
                self.assertNotIn(TASK_ID, source["retired_task_ids"])

    def test_completion_needs_confirmed_exact_receipt_and_no_pending(self):
        for mutate in (
            lambda s: s.update(pending_operation={"id": "unknown"}),
            lambda s: s["active_task"].update(phase="ready"),
            lambda s: s["active_task"].pop("merge_receipt"),
            lambda s: s["active_task"]["merge_receipt"].update(merge_commit_sha=HEAD),
            lambda s: s["operations"][-1].update(status="pending"),
            lambda s: s["operations"][-1].pop("receipt"),
            lambda s: s["operations"].append(copy.deepcopy(s["operations"][-1])),
        ):
            source = merged_state(); mutate(source)
            self.denied(complete_task, source, post_evidence(), now=NOW)
        source = merged_state()
        # Corrupting both copies of a receipt still cannot bypass its actual proof.
        for receipt in (source["active_task"]["merge_receipt"], source["operations"][-1]["receipt"]):
            receipt["observation"]["commit"]["tree_sha"] = MAIN
        self.denied(complete_task, source, post_evidence(), now=NOW)

    def test_completion_preserves_full_task_evidence_history_and_only_then_enables_next(self):
        source, post = merged_state(), post_evidence()
        source["completed_tasks"] = [{"task": {"id": "synthetic-prior-task", "extra": [1]},
                                      "evidence": {"retained": [2]}, "completed_at": NOW.isoformat()}]
        result = self.call(complete_task, source, post, now=NOW)
        self.assertIsNone(result["active_task"])
        self.assertIsNone(result["lease"])
        self.assertIsNone(result["pending_operation"])
        self.assertEqual(result["retired_task_ids"], source["retired_task_ids"] + [TASK_ID])
        self.assertEqual(result["completed_tasks"][:-1], source["completed_tasks"])
        entry = result["completed_tasks"][-1]
        self.assertEqual(entry["task"], source["active_task"])
        self.assertEqual(entry["evidence"], post)
        for key in ("operations", "backlog", "last_sweep_at", "created_at"):
            self.assertEqual(result[key], source[key])
        self.denied(complete_task, result, post, now=NOW)
        result["completed_tasks"][0]["evidence"]["retained"].append(3)
        entry["task"]["batches"][0]["receipts"].append({"copy": True})
        entry["evidence"]["post_ci"]["runs"][0]["id"] = 999
        self.assertEqual(post, post_evidence())
        self.assertEqual(len(source["active_task"]["batches"][0]["receipts"]), 1)
        self.assertEqual(source["completed_tasks"][0]["evidence"]["retained"], [2])
        # No task-selection API: caller may select backlog only after the clear.
        result["active_task"] = copy.deepcopy(state()["active_task"])
        self.deny_prepare(result, operation_id="resurrect-retired-id")

    def test_migration_is_owner_exact_cas_preparation_preserving_148_and_every_opaque_field(self):
        source, grant = legacy_state(), new_grant()
        acceptance = owner_acceptance(source)
        result = self.call(migrate_state, source, grant, acceptance, expected_blob_sha=BLOB, now=NOW)
        expected = copy.deepcopy(source)
        expected["schema"], expected["grant_id"] = 2, NEW_GRANT
        expected["active_task"]["phase"] = "review_required"
        migration = result.pop("migrations")
        self.assertEqual(result, expected)
        self.assertEqual(len(migration), 1)
        self.assertEqual(migration[0]["old_grant_id"], OLD_GRANT)
        self.assertEqual(migration[0]["new_grant_id"], NEW_GRANT)
        self.assertEqual(migration[0]["expected_state_blob_sha"], BLOB)
        self.assertEqual(migration[0]["state_sha256"], digest(source))
        self.assertEqual(migration[0]["grant_sha256"], digest(grant))
        self.assertEqual(migration[0]["acceptance"], acceptance)
        self.assertEqual(result["operations"][0]["result"], "get-confirm-required")
        self.assertNotIn("merge_receipt", result["active_task"])
        self.denied(complete_task, result, post_evidence(), now=NOW)
        self.deny_prepare(result)  # migration does not fabricate a lease/permission.
        migration[0]["acceptance"]["decision"] = "reject"
        result["operations"][0]["receipt"]["request"]["expected_head_sha"] = MAIN
        result["active_task"]["batches"][0]["receipts"].append({"copy": True})
        self.assertEqual(source, legacy_state())
        self.assertEqual(acceptance, owner_acceptance(source))
        self.assertEqual(grant, new_grant())

    def test_migration_preserves_existing_lineage_and_never_resets_budgets_or_history(self):
        source = legacy_state()
        source["migrations"] = [{"old": {"receipt": [1]}}]
        source["completed_tasks"] = [{"task": {"id": "synthetic-prior-task"}, "evidence": {"x": [2]}}]
        source["active_task"]["spent_lines"] = 999
        source["active_task"]["ci_revisions"] = 3
        acceptance = owner_acceptance(source)
        result = self.call(migrate_state, source, new_grant(acceptance), acceptance, expected_blob_sha=BLOB, now=NOW)
        self.assertEqual((result["active_task"]["spent_lines"], result["active_task"]["ci_revisions"]), (999, 3))
        self.assertEqual(result["migrations"][:-1], source["migrations"])
        self.assertEqual(result["completed_tasks"], source["completed_tasks"])
        result["migrations"][0]["old"]["receipt"].append(3)
        result["completed_tasks"][0]["evidence"]["x"].append(4)
        self.assertEqual(source["migrations"][0]["old"]["receipt"], [1])
        self.assertEqual(source["completed_tasks"][0]["evidence"]["x"], [2])

    def test_migration_denies_live_lease_pending_unknown_and_nonlegacy_state(self):
        for mutate in (
            lambda s: s.update(schema=2),
            lambda s: s.update(lease={"id": "stale-but-not-stealable", "task_id": TASK_ID}),
            lambda s: s.update(pending_operation={"result": "unknown"}),
            lambda s: s["active_task"].update(unresolved_operation={"result": "unknown"}),
            lambda s: s.update(active_task=None),
            lambda s: s["retired_task_ids"].append(TASK_ID),
        ):
            source = legacy_state(); mutate(source)
            self.denied(migrate_state, source, new_grant(), owner_acceptance(source),
                        expected_blob_sha=BLOB, now=NOW)

    def test_migration_requires_owner_acceptance_and_every_exact_snapshot_identity(self):
        for key in owner_acceptance():
            acceptance = owner_acceptance(); acceptance.pop(key)
            with self.subTest(missing=key):
                self.denied(migrate_state, legacy_state(), new_grant(), acceptance,
                            expected_blob_sha=BLOB, now=NOW)
        for key, value in (
            ("decision", "approve"), ("decision_ref", ""), ("supersedes_grant_id", NEW_GRANT),
            ("expected_state_blob_sha", MAIN), ("state_sha256", "0" * 64),
            ("adopted_task_id", "replacement-task"), ("adopted_pr", 149),
            ("adopted_pr", True), ("adopted_head_sha", MAIN),
        ):
            acceptance = owner_acceptance(); acceptance[key] = value
            with self.subTest(key=key):
                self.denied(migrate_state, legacy_state(), new_grant(), acceptance,
                            expected_blob_sha=BLOB, now=NOW)
        # Caller supplying a different fresh CAS cannot reuse an old acceptance.
        self.denied(migrate_state, legacy_state(), new_grant(), owner_acceptance(),
                    expected_blob_sha=MAIN, now=NOW)
        self.denied(migrate_state, legacy_state(), new_grant(), owner_acceptance(),
                    expected_blob_sha="bad", now=NOW)

    def test_migration_canonical_digest_covers_full_state_not_just_pr_counters(self):
        for mutate in (
            lambda s: s["active_task"].update(spent_lines=80),
            lambda s: s["active_task"].update(ci_revisions=1),
            lambda s: s["active_task"].update(base_sha=BASE),
            lambda s: s["active_task"]["touched_paths"].append("scripts/autonomous/extra.py"),
            lambda s: s["active_task"]["batches"][0]["receipts"].append({"changed": True}),
            lambda s: s["operations"][0].update(result="silently-resolved"),
            lambda s: s["backlog"][0]["notes"].append("new observation"),
            lambda s: s.update(last_sweep_at=NOW.isoformat()),
            lambda s: s.update(extra_history={"opaque": [1]}),
        ):
            source = legacy_state(); mutate(source)
            self.denied(migrate_state, source, new_grant(), owner_acceptance(),
                        expected_blob_sha=BLOB, now=NOW)
        original = legacy_state()
        reordered = dict(reversed(list(original.items())))
        result = self.call(migrate_state, reordered, new_grant(), owner_acceptance(original),
                           expected_blob_sha=BLOB, now=NOW)
        self.assertEqual(result["migrations"][-1]["state_sha256"], digest(original))

    def test_migration_rejects_v1_foreign_or_nonsuperseding_grants(self):
        for key, value in (("schema", 1), ("schema", True), ("version", 1),
                           ("kind", "other"), ("id", OLD_GRANT),
                           ("repository", "foreign/repo"), ("supersedes_grant_id", "other"),
                           ("policy_path", "docs/dot/r2-j-policy.json"), ("acceptance", {}),
                           ("policy_sha256", BLOB)):
            grant = new_grant(); grant[key] = value
            with self.subTest(key=key):
                self.denied(migrate_state, legacy_state(), grant, owner_acceptance(),
                            expected_blob_sha=BLOB, now=NOW)

    def test_malformed_inputs_fail_as_value_error_without_mutation(self):
        for malformed in (None, [], "state", 1):
            self.deny_prepare(malformed)
            self.denied(reconcile_operation, malformed, {}, now=NOW)
            self.denied(complete_task, malformed, post_evidence(), now=NOW)
            self.denied(migrate_state, malformed, new_grant(), owner_acceptance(),
                        expected_blob_sha=BLOB, now=NOW)
        for key, malformed in (("operations", {}), ("retired_task_ids", None),
                               ("backlog", None), ("completed_tasks", {}), ("migrations", {})):
            source = state(); source[key] = malformed
            self.deny_prepare(source)
        source = state(); source["active_task"]["spent_lines"] = float("inf")
        # Infinity is equal to itself, so the normal immutable-input assertion applies.
        self.deny_prepare(source)
        for invalid_now in (None, "2026-10-25", NOW.replace(tzinfo=None)):
            self.denied(prepare_operation, state(), "squash_merge", preflight(),
                        operation_id="op", lease_id="lease-1", now=invalid_now)



class RegrantTest(unittest.TestCase):
    call = StateTest.call
    denied = StateTest.denied
    deny_prepare = StateTest.deny_prepare
    def fixture(self):
        source = state(); source["lease"] = None
        source["active_task"].update(phase="ready", spent_lines=999, ci_revisions=3,
                                    independent_review={"historical": True})
        source["migrations"] = [{"retained": [1]}]
        accepted = owner_acceptance(source)
        accepted["supersedes_grant_id"] = source["grant_id"]
        grant = new_grant(accepted)
        grant.update(version=3, id="r2-j-v2-" + "4" * 32,
                     policy_path="docs/dot/r2-j-policy-v3.json", supersedes_grant_id=source["grant_id"])
        return source, grant, accepted

    def test_v3_regrant_preserves_entire_task_and_history_except_review_phase(self):
        source, grant, accepted = self.fixture()
        result = self.call(regrant_state, source, grant, accepted, expected_blob_sha=BLOB, now=NOW)
        expected = copy.deepcopy(source)
        expected["grant_id"] = grant["id"]
        expected["active_task"]["phase"] = "review_required"
        self.assertEqual(result["migrations"][:-1], expected["migrations"])
        result["migrations"] = result["migrations"][:-1]
        self.assertEqual(result, expected)
        self.deny_prepare(result)  # regrant is not a lease or a permission to send.

    def test_v3_regrant_denies_pending_effect_lease_and_postmerge(self):
        for mutate in (lambda s: s.update(lease={"id": "expired"}),
                       lambda s: s.update(pending_operation={"result": "unknown"}),
                       lambda s: s["active_task"].update(unresolved_operation={"result": "unknown"}),
                       *[lambda s, phase=p: s["active_task"].update(phase=phase)
                         for p in ("ready_pending", "merge_pending", "post_merge")]):
            source, grant, accepted = self.fixture(); mutate(source)
            # Bind new snapshot too: it must still be rejected as unsafe.
            accepted["state_sha256"] = digest(source); grant["acceptance"] = copy.deepcopy(accepted)
            self.denied(regrant_state, source, grant, accepted, expected_blob_sha=BLOB, now=NOW)

    def test_v3_regrant_denies_same_grant_wrong_policy_and_snapshot(self):
        for key, value in (("id", NEW_GRANT), ("version", 2), ("schema", 1),
                           ("policy_path", "docs/dot/r2-j-policy-v2.json")):
            source, grant, accepted = self.fixture(); grant[key] = value
            self.denied(regrant_state, source, grant, accepted, expected_blob_sha=BLOB, now=NOW)
        source, grant, accepted = self.fixture()
        source["backlog"].append({"new": "must not be overwritten"})
        self.denied(regrant_state, source, grant, accepted, expected_blob_sha=BLOB, now=NOW)
        source, grant, accepted = self.fixture()
        self.denied(regrant_state, source, grant, accepted, expected_blob_sha="9" * 40, now=NOW)

if __name__ == "__main__":
    unittest.main()

