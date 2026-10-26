#!/usr/bin/env python3
"""Synthetic protocol boundaries, not evidence of a real no-send or runner."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dot_authority import digest
from dot_ops_outcomes import (RECOVERY, SYNC, WORKFLOWS, OUTCOME, SCOPE, CONTRACT_PATHS,
                              REPOSITORY, ISSUE, prepare_operation, reconcile_operation, complete_operation)
from dot_state import reconcile_operation as source_reconcile

NOW = datetime(2026, 10, 26, 20, tzinfo=timezone.utc)
SHA, BASE, BLOB, AFTER, QUEUE = (c * 40 for c in "abcde")
HASH, DECISION, RECEIPT = (c * 64 for c in "123")
GRANT = "r2-j-v2-" + "1" * 32
TOOL = "mcp__codex_apps__github_actions_actions_run_trigger"


def authority():
    record = {"kind": "owner-ops-outcome-protocol", "version": 1, "id": "synthetic-protocol",
              "repository": REPOSITORY, "source_grant_id": GRANT, "status": "active",
              "allowed_kinds": sorted(WORKFLOWS), "maximum_successors": 1,
              "decision_ref": "urn:synthetic:owner-decision", "issued_at": (NOW-timedelta(days=1)).isoformat(),
              "installed_helper_blob": SHA, "accepted_main_sha": SHA,
              "original_ops_id": "synthetic-original", "original_ops_sha256": HASH,
              "runner_amendment_id": "synthetic-runner", "runner_amendment_sha256": HASH,
              "workflow_blobs": {name: SHA for name in WORKFLOWS.values()},
              "contract_blobs": {path: SHA for path in CONTRACT_PATHS}}
    return {"record": record, "expected_sha256": digest(record), "issue": {"html_url": ISSUE, "state": "open"},
            "source_grant_id": GRANT, "source_authority": "verified-active", "installed_helper_blob": SHA,
            "issue_events": [], "events_complete": True, "revocations_complete": True, "revoked_ids": [],
            "base_delegations": "verified-active-unchanged", "observed_at": NOW.isoformat()}


def empty():
    return {"schema": 2, "grant_id": GRANT, "active_task": None, "lease": None, "pending_operation": None,
            "operations": [{"id": "old-opaque", "kind": "legacy", "retained": [1, {"opaque": "history"}]}],
            "backlog": [{"id": "research-kept"}], "retired_task_ids": ["original-task"],
            "completed_tasks": [{"task": {"id": "original-task", "spent_lines": 79, "ci_revisions": 2}}]}


def candidate(kind=RECOVERY, identifier="op-1"):
    inputs = ({"expected_state_sha": BASE, "decision_id": DECISION} if kind == RECOVERY else
              {"main_sha": SHA, "lab_sha": BASE, "continuation_key": "", "control_sha": ""})
    value = {"id": identifier, "kind": kind, "status": "pending", "prepared_at": NOW.isoformat(),
             "authority": {"source_grant_id": GRANT, "original_sha256": HASH, "amendment_sha256": HASH},
             "expected": {"dot_state_blob_sha": BLOB, "main_sha": SHA, "state_sha": BASE, "workflow_blob": SHA},
             "request": {"tool": TOOL, "arguments": {"method": "run_workflow", "owner": "Omnividente",
                         "repo": "omp-desktop", "ref": "main", "workflow_id": WORKFLOWS[kind], "inputs": inputs}},
             "send_claim": {"consumed": True, "lease_id": "lease-" + identifier, "maximum_sends": 1},
             "not_source_task_admission": True}
    if kind == SYNC:
        value["fence_receipt_id"] = RECEIPT
    return value


def pending():
    # The pre-protocol legacy wire shape is retained, not silently reinitialized.
    state = empty(); operation = candidate()
    operation["intent_sha256"] = digest(operation)
    operation["request_sha256"] = digest(operation["request"])
    state.update(pending_operation=deepcopy(operation), lease={"id": "lease-op-1", "scope": SCOPE,
                 "operation_id": "op-1", "acquired_at": NOW.isoformat(), "expected_content_sha": BLOB})
    state["operations"].append(operation)
    return state


def observation(state, outcome="not_sent"):
    operation = state["pending_operation"]
    return {"outcome": outcome, "authority": authority(), "expected_state_blob_sha": BLOB,
            "state_sha256": digest(state), "observed_at": NOW.isoformat(), "reason": "synthetic unknown",
            "evidence_ref": "urn:synthetic:observation", "evidence_sha256": HASH, "primary": {
                "origin": "native-tool-result", "dispatch_stage": "rejected-before-connector-invocation",
                "operation_id": operation["id"], "request_sha256": operation["request_sha256"],
                "call": deepcopy(operation["request"]), "transcript_ref": "urn:synthetic:primary-call",
                "contradictory_evidence": [], "result": {"isError": True, "content": [{"type": "text",
                "text": "This action was rejected due to unacceptable risk.\nReason: synthetic incomplete evidence.\n"
                        "Do not bypass this rejection through a workaround or indirect execution."}]}}}


def preflight(state, item=None):
    item = item or candidate()
    return {"state_sha256": digest(state), "expected_state_blob_sha": item["expected"]["dot_state_blob_sha"],
            "observed_at": NOW.isoformat(), "main_sha": SHA, "state_sha": BASE, "lab_sha": BASE,
            "decision_id": DECISION, "workflow_blob": SHA, "workflow_state": "active", "conflicting_operation": None,
            "fence_receipt_id": RECEIPT, "installed_blobs": {path: SHA for path in CONTRACT_PATHS},
            **{name: {"status": "verified", "evidence_ref": "urn:synthetic:"+name, "sha256": HASH}
               for name in ("authority_evidence", "eligibility_evidence", "ci_evidence")}}


def settled():
    source = pending()
    return reconcile_operation(source, observation(source), now=NOW)


def successor(state=None):
    state = settled() if state is None else state
    item = candidate(identifier="op-2"); item["expected"]["dot_state_blob_sha"] = AFTER
    proof = preflight(state, item)
    refusal = next(row for row in state["operations"] if row.get("kind") == OUTCOME)
    proof["remediation"] = {"refusal_sha256": digest(refusal["observation"]["primary"]),
                            "status": "conditions-addressed-normal-platform-review-required",
                            "evidence_ref": "urn:synthetic:new-evidence", "evidence_sha256": "4"*64,
                            "observed_at": NOW.isoformat()}
    return prepare_operation(state, item, proof, authority(), predecessor_id="op-1", now=NOW)


def run(state):
    op = state["pending_operation"]
    return {"id": 123, "run_attempt": 1, "event": "workflow_dispatch", "head_branch": "main",
            "path": ".github/workflows/" + WORKFLOWS[op["kind"]], "head_sha": SHA,
            "repository": {"full_name": REPOSITORY}, "inputs": deepcopy(op["request"]["arguments"]["inputs"]),
            "created_at": NOW.isoformat(), "html_url": "urn:synthetic:run", "status": "completed", "conclusion": "success",
            "actor": {"login": "Omnividente"}, "triggering_actor": {"login": "Omnividente"}}


def archive_payload(state):
    context = {"repository": REPOSITORY, "workflow": WORKFLOWS[RECOVERY], "ref": "refs/heads/main",
               "event_name": "workflow_dispatch", "control_sha": SHA, "run_id": "123", "run_attempt": "1",
               "actor": "Omnividente", "expected_state_sha": BASE, "decision_id": DECISION}
    before = {"commit_sha": BASE, "blob_sha": BLOB, "bytes": 100, "sha256": HASH}
    after = {"commit_sha": AFTER, "blob_sha": QUEUE, "bytes": 200, "sha256": HASH}
    checks = {"body_sha256": HASH, "prior_journal_sha256": HASH, "prior_event_count": 4,
              "added_event_id": HASH, "added_event_count": 1, "native_receipt_id": RECEIPT, "native_frontier_seq": 2}
    return {"owner-fence-result.json": {"outcome": "fenced", "decision_id": DECISION, "receipt_id": RECEIPT,
                                        "state_sha": AFTER, "frontier_seq": 2},
            "owner-fence-proof.json": {"schema": 1, "kind": "owner-fence-full-state-proof", "status": "verified",
                    "context": context, "before": before, "after": after, "checks": checks,
                    "native_outcome": "fenced", "allows_sync": True}}


def execution(state, payload=None):
    payload = archive_payload(state) if payload is None else payload
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as output:
        for name, data in payload.items():
            output.writestr(name, json.dumps(data))
    raw = buffer.getvalue()
    proof = payload.get("owner-fence-proof.json", {})
    evidence = observation(state)
    evidence.update(run=run(state), execution_evidence_ref="urn:synthetic:native-steps",
                    jobs=[{"run_id": 123, "head_sha": SHA, "status": "completed", "conclusion": "success",
                           "steps": [{"name": name, "status": "completed", "conclusion": "success"} for name in
                                     ("Fence exactly one unclaimed delivery by owner-bound state CAS",
                                      "Retain acknowledged fence or safe blocked outcome")]}],
                    artifact={"id": 55, "name": "owner-fence-123-1", "expired": False,
                              "digest": "sha256:"+hashlib.sha256(raw).hexdigest(),
                              "workflow_run": {"id": 123, "head_sha": SHA}},
                    git_readback={"before": proof.get("before"), "after": proof.get("after"),
                                  "after_parents": [BASE], "current_state_sha": AFTER})
    return evidence, raw


class OutcomesTest(unittest.TestCase):
    def deny(self, function, *args, **kwargs):
        snapshot = deepcopy((args, kwargs))
        with self.assertRaises(ValueError):
            function(*args, **kwargs)
        self.assertEqual((args, kwargs), snapshot)

    def test_dedicated_ops_entrypoint_handles_legacy_state_without_reinterpreting_source(self):
        original = pending(); before = deepcopy(original)
        # The old source-only entrypoint intentionally remains source-only.
        with self.assertRaisesRegex(ValueError, "active_task must be an object"):
            source_reconcile(original, observation(original), now=NOW)
        result = reconcile_operation(original, observation(original), now=NOW)
        self.assertIsNone(result["pending_operation"])
        self.assertIsNone(result["lease"])
        self.assertEqual(original, before)
        self.assertEqual(result["operations"][:-1], original["operations"])
        for field in ("active_task", "grant_id", "backlog", "retired_task_ids", "completed_tasks"):
            self.assertEqual(result[field], original[field])
        self.assertEqual(result["operations"][-1]["outcome"], "not_sent")

    def test_initial_is_reserved_before_send(self):
        state = empty(); item = candidate()
        result = prepare_operation(state, item, preflight(state), authority(), now=NOW)
        self.assertTrue(result["pending_operation"]["send_claim"]["consumed"])
        self.assertEqual(state, empty())
        self.assertEqual(result["operations"][:-1], state["operations"])

    def test_unknown_is_not_success_or_permission_to_resend(self):
        state = pending()
        result = reconcile_operation(state, observation(state, "unknown"), now=NOW)
        self.assertEqual(result["pending_operation"], state["pending_operation"])
        self.assertEqual(result["lease"], state["lease"])
        self.deny(prepare_operation, result, candidate(identifier="retry"), preflight(result), authority(), now=NOW)
        self.deny(reconcile_operation, result, observation(result, "not_sent"), now=NOW)

    def test_one_successor_keeps_full_history_and_same_request(self):
        state = settled(); before = deepcopy(state)
        result = successor(state)
        self.assertEqual(state, before)
        self.assertEqual(result["operations"][:-1], state["operations"])
        self.assertEqual(result["pending_operation"]["request"], pending()["pending_operation"]["request"])
        self.assertEqual(result["pending_operation"]["successor_of"]["operation_id"], "op-1")
        self.deny(prepare_operation, result, candidate(identifier="retry"), preflight(result), authority(), now=NOW)

    def test_second_refusal_can_settle_but_cannot_start_third_attempt(self):
        state = successor()
        result = reconcile_operation(state, observation(state), now=NOW)
        self.assertIsNone(result["lease"])
        for predecessor in (None, "op-1", "op-2"):
            self.deny(prepare_operation, result, candidate(identifier="op-3"), preflight(result), authority(),
                      predecessor_id=predecessor, now=NOW)

    def test_refusal_text_alone_timeout_http_and_absence_are_not_proof(self):
        changes = [lambda o: o["primary"].pop("dispatch_stage"),
                   lambda o: o["primary"].update(origin="author-summary"),
                   lambda o: o["primary"].update(dispatch_stage="unknown"),
                   lambda o: o["primary"].update(contradictory_evidence=["HTTP received"]),
                   lambda o: o["primary"].pop("transcript_ref"),
                   lambda o: o["primary"].update(operation_id="foreign"),
                   lambda o: o["primary"]["call"].update(tool="different-tool"),
                   lambda o: o["primary"].update(result={"http_status": 403}),
                   lambda o: o["primary"]["result"]["content"][0].update(text="timeout"),
                   lambda o: o["primary"].update(result={"runs": []})]
        for change in changes:
            state = pending(); obs = observation(state); change(obs)
            self.deny(reconcile_operation, state, obs, now=NOW)

    def test_history_claim_and_foreign_lease_are_protected(self):
        for change in (lambda s: s["lease"].update(id="other"), lambda s: s["lease"].update(scope="source"),
                       lambda s: s.update(active_task={"id": "active-source"}),
                       lambda s: s["pending_operation"]["send_claim"].update(consumed=False),
                       lambda s: s["operations"].pop(), lambda s: s["operations"].append(deepcopy(s["operations"][-1]))):
            state = pending(); change(state)
            self.deny(reconcile_operation, state, observation(state), now=NOW)

    def test_revocation_stale_reads_and_full_snapshot_binding(self):
        for change in (lambda o: o["authority"]["issue"].update(state="closed"),
                       lambda o: o["authority"].update(events_complete=False),
                       lambda o: o["authority"].update(revocations_complete=False),
                       lambda o: o["authority"]["revoked_ids"].append("synthetic-protocol"),
                       lambda o: o["authority"]["revoked_ids"].append("synthetic-original"),
                       lambda o: o["authority"]["issue_events"].append({"event": "closed", "created_at": NOW.isoformat()}),
                       lambda o: o.update(state_sha256="0"*64),
                       lambda o: o.update(observed_at=(NOW-timedelta(minutes=6)).isoformat()),
                       lambda o: o["authority"]["record"].update(maximum_successors=2)):
            state = pending(); obs = observation(state); change(state if False else obs)
            self.deny(reconcile_operation, state, obs, now=NOW)

    def test_successor_needs_remediation_same_tool_and_settlement_readback(self):
        state = settled()
        item = candidate(identifier="op-2"); item["expected"]["dot_state_blob_sha"] = AFTER
        pf = preflight(state, item)
        self.deny(prepare_operation, state, item, pf, authority(), predecessor_id="op-1", now=NOW)
        full = successor()["pending_operation"]["preflight"]
        for change in (lambda c,p: c["request"].update(tool="GitHub_MCP_Full.actions_run_trigger"),
                       lambda c,p: p.update(expected_state_blob_sha=BLOB),
                       lambda c,p: p["remediation"].update(evidence_ref=""),
                       lambda c,p: p["remediation"].update(refusal_sha256="0"*64),
                       lambda c,p: p.update(workflow_blob=BASE),
                       lambda c,p: p["installed_blobs"].update({"scripts/autonomous/dispatch_journal.py": BASE}),
                       lambda c,p: p.update(state_sha=AFTER),
                       lambda c,p: p.update(conflicting_operation="another-run")):
            c,p = deepcopy(item),deepcopy(full); change(c,p)
            self.deny(prepare_operation,state,c,p,authority(),predecessor_id="op-1",now=NOW)

    def test_completed_run_is_delivery_not_execution_proof(self):
        state = pending(); obs = observation(state,"delivered"); obs["run"] = run(state)
        result = reconcile_operation(state,obs,now=NOW)
        self.assertEqual(result["pending_operation"],state["pending_operation"])
        self.deny(reconcile_operation,result,observation(result),now=NOW)
        obs = observation(result,"delivered"); obs["run"] = run(result); obs["run"]["id"] = 456
        self.deny(reconcile_operation,result,obs,now=NOW)

    def test_late_verified_fence_can_settle_unknown_without_another_send(self):
        state = pending(); state = reconcile_operation(state,observation(state,"unknown"),now=NOW)
        proof,raw = execution(state)
        result = complete_operation(state,proof,raw,now=NOW)
        self.assertIsNone(result["pending_operation"])
        self.assertIsNone(result["lease"])
        self.assertEqual(result["operations"][:-1],state["operations"])
        self.assertEqual(result["operations"][-1]["receipt_id"],RECEIPT)
        self.deny(prepare_operation,result,candidate(identifier="again"),preflight(result),authority(),now=NOW)

    def test_missing_replayed_wrong_or_unretained_proof_cannot_settle_fence(self):
        state = pending()
        for change in (lambda d: d.pop("owner-fence-proof.json"),
                       lambda d: d["owner-fence-proof.json"].update(allows_sync=False),
                       lambda d: d["owner-fence-result.json"].update(outcome="already_fenced"),
                       lambda d: d["owner-fence-proof.json"]["context"].update(run_id="999"),
                       lambda d: d["owner-fence-proof.json"]["checks"].update(added_event_count=True)):
            data = archive_payload(state); change(data); proof,raw = execution(state,data)
            self.deny(complete_operation,state,proof,raw,now=NOW)
        for change in (lambda p: p["artifact"].update(expired=True),
                       lambda p: p["artifact"].update(digest="sha256:"+"0"*64),
                       lambda p: p["run"].update(run_attempt=2),
                       lambda p: p["git_readback"].update(current_state_sha=BASE),
                       lambda p: p["git_readback"].update(after_parents=[BASE,SHA])):
            proof,raw = execution(state); change(proof)
            self.deny(complete_operation,state,proof,raw,now=NOW)

    def test_source_and_unapproved_workflows_cannot_use_operational_protocol(self):
        state = empty()
        for change in (lambda c: c.update(kind="squash_merge"),
                       lambda c: c["request"]["arguments"].update(workflow_id="autonomous_next_task.yml"),
                       lambda c: c["request"]["arguments"].update(method="rerun_workflow"),
                       lambda c: c["request"].update(tool="arbitrary-api")):
            item = candidate(); change(item)
            self.deny(prepare_operation,state,item,preflight(state),authority(),now=NOW)

    def test_sync_requires_full_completed_fence_not_an_ack(self):
        state = empty(); item = candidate(SYNC, "sync-1")
        self.deny(prepare_operation,state,item,preflight(state,item),authority(),now=NOW)
        source = pending(); proof,raw = execution(source)
        state = complete_operation(source,proof,raw,now=NOW)
        result = prepare_operation(state,item,preflight(state,item),authority(),now=NOW)
        self.assertEqual(result["pending_operation"]["kind"],SYNC)

    def test_repeated_hourly_unknown_observation_does_not_grow_history(self):
        state = pending()
        first = reconcile_operation(state,observation(state,"unknown"),now=NOW)
        second = reconcile_operation(first,observation(first,"unknown"),now=NOW)
        self.assertEqual(first,second)

    def test_native_and_retention_steps_must_really_have_succeeded(self):
        state = pending()
        for change in (lambda p: p.pop("jobs"),
                       lambda p: p["jobs"][0]["steps"][0].update(conclusion="skipped"),
                       lambda p: p["jobs"][0]["steps"][1].update(conclusion="failure"),
                       lambda p: p["jobs"][0].update(run_id=999),
                       lambda p: p["run"]["triggering_actor"].update(login="other")):
            proof,raw = execution(state); change(proof)
            self.deny(complete_operation,state,proof,raw,now=NOW)

    def test_sync_actual_publication_receipt_and_lab_readback(self):
        original = pending(); proof,raw = execution(original)
        quiet = complete_operation(original,proof,raw,now=NOW)
        item = candidate(SYNC,"sync-1")
        state = prepare_operation(quiet,item,preflight(quiet,item),authority(),now=NOW)
        detail = {"main_sha": SHA,"lab_sha": BASE,"candidate_sha": AFTER,"queue_blob": QUEUE,
                  "quality_gate":"success","published_lab_sha":AFTER,"candidate_branch":"autonomous/sync-123-1"}
        event = {"type":"EffectObservation","kind":"sync_publication","decision_id":DECISION,
                 "executor_claim_id":digest([DECISION,"execute"]),"phase_claim_id":digest([DECISION,"sync_finalize"]),"evidence":detail}
        event["receipt_id"] = digest([DECISION,event["executor_claim_id"],"sync_publication",detail])
        event["event_id"] = digest(event)
        result = {"status":"prepared","publication":"published","reason":"verified_fast_forward",
                  "main_sha":SHA,"lab_sha":BASE,"candidate_sha":AFTER,"queue_blob":QUEUE,
                  "decision_id":DECISION,"effect_receipt_id":event["receipt_id"]}
        proof,raw = execution(state,{"sync-result.json":result})
        proof["artifact"]["name"] = "autonomous-sync-result-1"
        proof["publication_event"] = event
        executor = {"type":"ExecutorClaim","decision_id":DECISION,"claim_id":event["executor_claim_id"],
                    "trigger":{"run_id":"123","run_attempt":"1","control_sha":SHA,"repository":REPOSITORY,
                               "event_name":"workflow_dispatch","actor":"Omnividente"}}
        executor["event_id"] = digest(executor)
        proof["executor_claim"] = executor
        proof["git_readback"] = {"current_lab_sha":AFTER,"candidate_parents":[BASE,SHA],
                                  "before_queue_blob":QUEUE,"after_queue_blob":QUEUE}
        proof["jobs"][0]["steps"] = [{"name":name,"status":"completed","conclusion":"success"} for name in
            ("Retain a terminal preparation or publish one checked finalization","Preserve final outcome")]
        completed = complete_operation(state,proof,raw,now=NOW)
        self.assertIsNone(completed["pending_operation"])
        for change in (lambda p:p["publication_event"]["evidence"].update(quality_gate="failure"),
                       lambda p:p["git_readback"].update(current_lab_sha=BASE),
                       lambda p:p["git_readback"].update(after_queue_blob=BASE)):
            changed=deepcopy(proof);change(changed)
            self.deny(complete_operation,state,changed,raw,now=NOW)

    def test_real_disposable_git_cas_two_writers_and_lost_ack_no_resend(self):
        with tempfile.TemporaryDirectory() as folder:
            def git(*args, data=None, check=True):
                return subprocess.run(["git","-C",folder,*args],input=data,stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE,check=check).stdout.strip().decode()
            git("init","--bare","-q")
            git("config","user.name","Synthetic"); git("config","user.email","test@example.invalid")
            def commit(state,parent=None):
                blob = git("hash-object","-w","--stdin",data=json.dumps(state).encode())
                tree = git("mktree",data=("100644 blob "+blob+"\tdot-state.json\n").encode())
                return git("commit-tree",tree,*( ["-p",parent] if parent else []),data=b"synthetic\n")
            initial = pending(); old = commit(initial); ref = "refs/heads/dot/r2-j-state"
            git("update-ref",ref,old,"0"*40)
            next_state = reconcile_operation(initial,observation(initial),now=NOW)
            first,second = commit(next_state,old),commit({**initial,"other_writer":True},old)
            git("update-ref",ref,first,old)
            stale = subprocess.run(["git","-C",folder,"update-ref",ref,second,old],capture_output=True)
            self.assertNotEqual(stale.returncode,0)
            self.assertEqual(git("rev-parse",ref),first)
            sent = successor(next_state)
            send_commit = commit(sent,first); git("update-ref",ref,send_commit,first)
            # Simulate lost response to persisted claim: readback alone does not
            # authorize a restarted invocation to resend or prepare a new attempt.
            loaded = json.loads(git("show",ref+":dot-state.json"))
            self.assertEqual(loaded,sent)
            self.deny(prepare_operation,loaded,candidate(identifier="restart"),preflight(loaded),authority(),now=NOW)


if __name__ == "__main__":
    unittest.main()
