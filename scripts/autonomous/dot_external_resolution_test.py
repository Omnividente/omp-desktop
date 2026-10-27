#!/usr/bin/env python3
"""Synthetic owner acceptance/evidence only; never authority for any real write."""
from copy import deepcopy
from datetime import timedelta
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import zlib

import dispatch_journal as native
import owner_fence_proof as fence_proof
import dot_ops_outcomes as ops
import dot_ops_outcomes_test as old
try:
    import dot_external_resolution as admin
except ImportError:
    admin = None

NOW = old.NOW + timedelta(days=1)
REF = {"ref": "urn:synthetic:primary-observation-not-authority", "sha256": "1" * 64}


def encoded(state):
    return (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode()


def rehash_operation(state):
    op = state["pending_operation"]
    op["request_sha256"] = ops.digest(op["request"])
    op["intent_sha256"] = ops.digest({k: v for k, v in op.items() if k not in {"intent_sha256", "request_sha256"}})
    state["operations"][-1] = deepcopy(op)


def pack(payload):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, value in payload.items():
            bundle.writestr(name, json.dumps(value))
    return output.getvalue()


def native_fence_fixture():
    """Pure actual pinned native constructors, never journal/authority I/O."""
    trigger = {"run_id": "98", "run_attempt": "1", "event_name": "workflow_dispatch",
               "control_sha": admin.FROZEN_RECEIVER, "repository": ops.REPOSITORY, "actor": "Omnividente"}
    with patch.object(native, "_now", return_value=old.NOW.isoformat()):
        init = native._event("Init", control_sha=admin.FROZEN_RECEIVER,
                             basis={"kind":"fenced_bootstrap", "state_sha":old.BASE,
                                    "legacy_senders_fenced":True, "pending_legacy":"none"})
        journal = {"version":1, "events":[init]}
        materialized = native.materialize(journal)
        intent = native.JournalStore._new_intent(
            materialized, native.NEXT, native.normalize_inputs(native.NEXT, {}),
            {"receipt_id":None}, trigger, admin.FROZEN_RECEIVER, "sender")
        send = native._event("SendClaim", decision_id=intent["decision_id"],
                             claim_id=native.digest([intent["decision_id"], "send"]), trigger=trigger)
    journal["events"].extend([intent,send])
    materialized = native.materialize(journal)
    before = {"version":2,"tasks":[],"controller":{"at":"retained synthetic timestamp"},
              "dispatch_journal":journal}
    context = {"repository":ops.REPOSITORY,"workflow":ops.WORKFLOWS[ops.RECOVERY],
               "ref":"refs/heads/main","event_name":"workflow_dispatch","control_sha":admin.CURRENT_MAIN,
               "run_id":"123","run_attempt":"1","actor":"Omnividente",
               "expected_state_sha":old.BASE,"decision_id":intent["decision_id"]}
    before_digest = native.substantive_digest(before)
    receipt = native._owner_fence_receipt_id(intent["decision_id"],context,old.BASE,before_digest)
    with patch.object(native, "_now", return_value=NOW.isoformat()):
        event = native._event("OwnerFence", decision_id=intent["decision_id"],kind="owner_revoked_unclaimed",
                              owner_trigger=context,before_state_sha=old.BASE,before_digest=before_digest,
                              receipt_id=receipt,frontier_seq=materialized["frontier_seq"]+1)
    after = deepcopy(before); after["dispatch_journal"]["events"].append(event)
    native.materialize(after["dispatch_journal"])
    result = {"outcome":"fenced","decision_id":intent["decision_id"],"receipt_id":receipt,
              "state_sha":old.AFTER,"frontier_seq":event["frontier_seq"]}
    def snapshot(value,commit):
        raw=fence_proof.canonical(value)+b"\n"
        return {"commit_sha":commit,"blob_sha":admin.blob_sha(raw),"bytes":len(raw),
                "sha256":hashlib.sha256(raw).hexdigest()}
    proof = {"schema":1,"kind":"owner-fence-full-state-proof","status":"verified","context":context,
             "before":snapshot(before,old.BASE),"after":snapshot(after,old.AFTER),
             "checks":fence_proof.compare_full_states(before,after,result,context),
             "native_outcome":"fenced","allows_sync":True}
    return intent, {"owner-fence-proof.json":proof,"owner-fence-result.json":result}


def fixtures():
    intent, proof = native_fence_fixture()
    state = old.pending()
    state["pending_operation"]["request"]["arguments"]["inputs"]["decision_id"] = intent["decision_id"]
    state["pending_operation"]["expected"]["main_sha"] = admin.ORIGINAL_MAIN
    state["pending_operation"]["expected"]["workflow_blob"] = admin.OPS_GUARDS[".github/workflows/autonomous_recover_delivery.yml"]
    rehash_operation(state)
    state["last_attempt"] = {"stage": "unknown", "platform_refusal": "SYNTHETIC retained original refusal, not no-send proof"}
    state["opaque_extension"] = {"booleans": [True, False], "numbers": [1, 1.0, -0.0], "budget": 97}
    raw = encoded(state)
    archive = pack(proof)
    external, _ = old.execution(state, proof)
    for name in ("run", "artifact"):
        if name == "run":
            external[name]["head_sha"] = admin.CURRENT_MAIN
            external[name]["html_url"] = "https://github.com/" + ops.REPOSITORY + "/actions/runs/123"
        else:
            external[name]["workflow_run"]["head_sha"] = admin.CURRENT_MAIN
            external[name]["digest"] = "sha256:" + hashlib.sha256(archive).hexdigest()
    external["jobs"][0]["head_sha"] = admin.CURRENT_MAIN
    record = {"kind": "external-owner-fence-resolution", "repository": ops.REPOSITORY,
              "original_operation_id": state["pending_operation"]["id"], "original_call_delivery": "unknown",
              "is_original_run": False, "primary_evidence": deepcopy(REF),
              **{k: external[k] for k in ("run", "artifact", "jobs", "git_readback")},
              "original_receiver": {"control_sha": admin.FROZEN_RECEIVER, "decision_id": intent["decision_id"],
                                    "correlation_key": intent["correlation_key"], "run_id": 98, "artifact_id": 97,
                                    "retained_handoff": deepcopy(REF)}}
    current = {"observed_at": NOW.isoformat(), "primary_evidence": deepcopy(REF), "late_path_review": deepcopy(REF),
               "native_ref": "refs/heads/autonomous/state", "main_sha": admin.CURRENT_MAIN,
               "state_sha": "f" * 40, "queue_blob_sha": "e" * 40,
               "code_manifest": deepcopy(admin.CODE_MANIFEST), "late_paths_complete": True,
               "late_ops_revisions": [admin.ORIGINAL_MAIN, admin.CURRENT_MAIN],
               "monotonic_native_policy": "active-no-rewind-no-guard-weakening", "contradictions": [], "ref_rewinds": [],
               "journal_preservation": "historical-full-proof-plus-native-append-only-guards",
               "full_current_journal_read": False,
               "lineage": {"base": old.AFTER, "head": "f" * 40, "merge_base": old.AFTER, "status": "ahead", "ahead_by": 27}}
    evidence = {"record": record, "record_sha256": ops.digest(record), "current": current}
    op = state["pending_operation"]
    binding = {"operation_id": op["id"], "operation_sha256": ops.digest(op), "request_sha256": op["request_sha256"],
               "intent_sha256": op["intent_sha256"], "source_grant_id": state["grant_id"],
               "original_inputs": deepcopy(op["request"]["arguments"]["inputs"]),
               "released_lease_sha256": ops.digest(state["lease"]), "dot_blob_sha": admin.blob_sha(raw),
               "state_sha256": ops.digest(state), "raw_sha256": hashlib.sha256(raw).hexdigest()}
    decision = {"kind": "owner-administrative-external-resolution-decision", "scope": admin.SCOPE,
                "status": "active", "repository": ops.REPOSITORY, "owner": "Omnividente", "version": 1,
                "id": "synthetic-owner-decision-not-live-authority", "decision": deepcopy(REF),
                "accepted_policy_sha256": ops.digest(admin.POLICY), "binding": binding,
                "external_record_sha256": evidence["record_sha256"], "issued_at": NOW.isoformat()}
    authority = {"record": decision, "record_sha256": ops.digest(decision), "accepted_policy": deepcopy(admin.POLICY),
                 "observed_at": NOW.isoformat(), "issue": {"html_url": ops.ISSUE, "state": "open"},
                 "owner_authenticated": True, "decision_unchanged": True, "events_complete": True,
                 "revocations_complete": True, "authority_readback": deepcopy(REF), "issue_events": [], "revoked_ids": []}
    return {"state_bytes": raw, "expected_dot_blob_sha": admin.blob_sha(raw), "owner_authority": authority,
            "external_resolution": evidence, "external_archive_bytes": archive, "now": NOW}


def rebind(f, *, state=False):
    if state:
        s = json.loads(f["state_bytes"])
        b = f["owner_authority"]["record"]["binding"]
        b.update(dot_blob_sha=admin.blob_sha(f["state_bytes"]), state_sha256=ops.digest(s),
                 raw_sha256=hashlib.sha256(f["state_bytes"]).hexdigest())
        f["expected_dot_blob_sha"] = b["dot_blob_sha"]
    e = f["external_resolution"]
    e["record_sha256"] = ops.digest(e["record"])
    a = f["owner_authority"]
    a["record"]["external_record_sha256"] = e["record_sha256"]
    a["record_sha256"] = ops.digest(a["record"])


class ExternalResolutionTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(admin, "before: separate administrative pure API is not implemented")
        self.f = fixtures()

    def deny(self, f):
        saved = deepcopy(f)
        with self.assertRaises(ValueError):
            admin.prepare_external_resolution(**f)
        self.assertEqual(f, saved)

    def test_only_additive_metadata_diff_and_every_original_type_preserved(self):
        original = deepcopy(self.f)
        before = json.loads(self.f["state_bytes"])
        raw = admin.prepare_external_resolution(**self.f)
        after = json.loads(raw)
        self.assertEqual(self.f, original)
        self.assertEqual(after["operations"][:-1], before["operations"])
        for key in before.keys() - {"operations", "lease", "pending_operation"}:
            self.assertEqual(ops.digest(after[key]), ops.digest(before[key]), key)
        row = after["operations"][-1]
        self.assertEqual(row["kind"], admin.KIND)
        self.assertEqual(row["original_pending"], before["pending_operation"])
        self.assertEqual(row["released_lease"], before["lease"])
        self.assertEqual((row["disposition"], row["historical_delivery"]), ("administrative_closed_unknown", "unknown"))
        self.assertNotIn("outcome", row)
        self.assertIsNone(after["pending_operation"]); self.assertIsNone(after["lease"])
        self.assertEqual(row["original_pending"]["send_claim"]["consumed"], True)
        self.assertFalse(row["external_resolution"]["current"]["full_current_journal_read"])

    def test_pure_function_does_not_open_network_process_file_or_clock(self):
        with patch("builtins.open", side_effect=AssertionError("file I/O")), \
             patch.object(subprocess, "run", side_effect=AssertionError("process I/O")), \
             patch.object(socket, "socket", side_effect=AssertionError("network I/O")):
            self.assertIsInstance(admin.prepare_external_resolution(**self.f), bytes)

    def test_missing_source_or_ops_authority_is_not_minted_or_needed_for_admin_scope(self):
        # The separate owner decision is neither the old OPS protocol nor a new source grant.
        self.assertNotIn("source_authority", self.f["owner_authority"])
        self.assertNotIn("base_delegations", self.f["owner_authority"])
        admin.prepare_external_resolution(**self.f)
        for foreign in (old.authority(), {}, None):
            f = deepcopy(self.f); f["owner_authority"] = foreign; self.deny(f)

    def test_wrong_scope_owner_policy_or_revocation_is_rejected(self):
        changes = [lambda a: a["record"].update(scope=ops.SCOPE), lambda a: a["record"].update(owner="foreign"),
                   lambda a: a["record"].update(status="draft"), lambda a: a["record"].update(version=True),
                   lambda a: a["accepted_policy"].update(new_effect_authority=["Sync"]),
                   lambda a: a.update(revoked_ids=[a["record"]["id"]]), lambda a: a.update(revocations_complete=False),
                   lambda a: a.update(owner_authenticated=False), lambda a: a["issue"].update(state="closed"),
                   lambda a: a.update(issue_events=[{"event": "closed", "created_at": NOW.isoformat()}]),
                   lambda a: a["record"]["binding"].update(request_sha256="0"*64),
                   lambda a: a["record"]["binding"].update(dot_blob_sha="0"*40)]
        for change in changes:
            with self.subTest(change=change):
                f = deepcopy(self.f); change(f["owner_authority"]); rebind(f); self.deny(f)

    def test_wrong_blob_pending_history_lease_active_and_budget_bindings_fail_closed(self):
        f = deepcopy(self.f); f["expected_dot_blob_sha"] = "0" * 40; self.deny(f)
        for change in (lambda s: s.update(active_task={"id":"another"}), lambda s: s["lease"].update(scope="source"),
                       lambda s: s["lease"].update(operation_id="another"), lambda s: s["lease"].update(id="another"),
                       lambda s: s["pending_operation"]["request"]["arguments"]["inputs"].update(decision_id="0"*64),
                       lambda s: s["operations"].pop(), lambda s: s["pending_operation"]["send_claim"].update(consumed=False),
                       lambda s: s["opaque_extension"].update(budget=0)):
            with self.subTest(change=change):
                f = deepcopy(self.f); state = json.loads(f["state_bytes"]); change(state)
                f["state_bytes"] = encoded(state); f["expected_dot_blob_sha"] = admin.blob_sha(f["state_bytes"])
                self.deny(f)

    def test_raw_json_duplicate_nonfinite_lossy_and_oversize_are_rejected(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1e999}', b'{"x":1e-999}', b'[]',
                    b'{"x":9007199254740993.0}', b' ' * (admin.MAX_DOT_BYTES+1)):
            f = deepcopy(self.f); f.update(state_bytes=raw, expected_dot_blob_sha=admin.blob_sha(raw)); self.deny(f)

    def test_candidate_size_must_remain_within_replayable_raw_state_bound(self):
        f = deepcopy(self.f); state = json.loads(f["state_bytes"])
        state["synthetic_padding"] = "x" * (admin.MAX_DOT_BYTES - len(encoded(state)) - 1024)
        f["state_bytes"] = encoded(state); rebind(f,state=True)
        self.assertLess(len(f["state_bytes"]),admin.MAX_DOT_BYTES)
        self.deny(f)

    def test_wrong_external_identity_artifact_result_or_receiver_rejected(self):
        changes = [lambda r: r.update(is_original_run=True), lambda r: r.update(original_call_delivery="delivered"),
                   lambda r: r["run"].update(head_sha=admin.ORIGINAL_MAIN), lambda r: r["run"].update(run_attempt=2),
                   lambda r: r["run"]["inputs"].update(expected_state_sha="0"*40),
                   lambda r: r["artifact"].update(expired=True), lambda r: r["artifact"].update(digest="sha256:"+"0"*64),
                   lambda r: r["jobs"][0]["steps"][0].update(conclusion="failure"),
                   lambda r: r["git_readback"].update(after_parents=["0"*40]),
                   lambda r: r["original_receiver"].update(control_sha=admin.CURRENT_MAIN),
                   lambda r: r["original_receiver"].pop("retained_handoff")]
        for change in changes:
            with self.subTest(change=change):
                f = deepcopy(self.f); change(f["external_resolution"]["record"]); rebind(f); self.deny(f)
        for change in (lambda p: p["owner-fence-result.json"].update(outcome="already_fenced"),
                       lambda p: p["owner-fence-result.json"].update(frontier_seq=True),
                       lambda p: p["owner-fence-proof.json"]["checks"].update(added_event_count=2),
                       lambda p: p["owner-fence-proof.json"]["checks"].update(native_frontier_seq=True),
                       lambda p: p["owner-fence-proof.json"]["context"].update(run_id="999")):
            f = deepcopy(self.f)
            with zipfile.ZipFile(io.BytesIO(f["external_archive_bytes"])) as bundle:
                payload = {n: json.loads(bundle.read(n)) for n in bundle.namelist()}
            change(payload); f["external_archive_bytes"] = pack(payload)
            f["external_resolution"]["record"]["artifact"]["digest"] = "sha256:"+hashlib.sha256(f["external_archive_bytes"]).hexdigest()
            rebind(f); self.deny(f)

    def _replace_external_proof(self, f, change):
        with zipfile.ZipFile(io.BytesIO(f["external_archive_bytes"])) as bundle:
            payload = {n: json.loads(bundle.read(n)) for n in bundle.namelist()}
        proof = payload["owner-fence-proof.json"]
        change(proof)
        record = f["external_resolution"]["record"]
        record["git_readback"].update(before=deepcopy(proof["before"]), after=deepcopy(proof["after"]))
        f["external_archive_bytes"] = pack(payload)
        record["artifact"]["digest"] = "sha256:" + hashlib.sha256(f["external_archive_bytes"]).hexdigest()
        rebind(f)

    def test_v2_rejects_unchanged_queue_blob_or_raw_hash_for_added_fence(self):
        for fields in (("blob_sha",), ("sha256",), ("blob_sha", "sha256", "bytes")):
            with self.subTest(fields=fields):
                f = deepcopy(self.f)
                def unchanged_content(proof):
                    for field in fields:
                        proof["after"][field] = proof["before"][field]
                self._replace_external_proof(f, unchanged_content)
                self.deny(f)

    def test_v2_rejects_original_receiver_run_equal_to_external_recovery(self):
        f = deepcopy(self.f); record = f["external_resolution"]["record"]
        record["original_receiver"]["run_id"] = record["run"]["id"]
        rebind(f); self.deny(f)

    def test_v2_rejects_original_handoff_artifact_equal_to_external_artifact(self):
        f = deepcopy(self.f); record = f["external_resolution"]["record"]
        record["original_receiver"]["artifact_id"] = record["artifact"]["id"]
        rebind(f); self.deny(f)

    def test_v2_allows_same_byte_count_with_distinct_content_identities(self):
        f = deepcopy(self.f)
        self._replace_external_proof(f, lambda proof: proof["after"].update(bytes=proof["before"]["bytes"]))
        result = json.loads(admin.prepare_external_resolution(**f))
        self.assertIsNone(result["pending_operation"])
        self.assertEqual(result["operations"][-1]["historical_delivery"], "unknown")

    def test_v3_rejects_rebound_wrong_native_correlation_key(self):
        f = deepcopy(self.f); receiver = f["external_resolution"]["record"]["original_receiver"]
        key = receiver["correlation_key"]
        receiver["correlation_key"] = ("1" if key[0] != "1" else "0") + key[1:]
        rebind(f); self.deny(f)

    def test_v3_positive_fixture_uses_native_derived_identity_and_full_comparator(self):
        intent, payload = native_fence_fixture()
        self.assertEqual(intent["correlation_key"], native.digest([intent["decision_id"],"dispatch"])[:32])
        self.assertEqual(native.digest([intent["decision_id"],"dispatch"]), ops.digest([intent["decision_id"],"dispatch"]))
        native_result = payload["owner-fence-result.json"]
        proof = payload["owner-fence-proof.json"]
        self.assertEqual(native_result["receipt_id"],proof["checks"]["native_receipt_id"])
        self.assertEqual(proof["checks"]["added_event_count"],1)
        self.assertNotEqual(proof["before"]["blob_sha"],proof["after"]["blob_sha"])
        self.assertNotEqual(proof["before"]["sha256"],proof["after"]["sha256"])
        result = json.loads(admin.prepare_external_resolution(**self.f))
        self.assertEqual(result["operations"][-1]["execution_record"],payload)

    def test_fresh_descendant_with_historical_proof_not_ancestry_alone(self):
        changes = [lambda c: c.update(observed_at=(NOW-timedelta(seconds=301)).isoformat()),
                   lambda c: c.update(observed_at=(NOW+timedelta(seconds=1)).isoformat()),
                   lambda c: c.update(main_sha="0"*40), lambda c: c.update(code_manifest={}),
                   lambda c: c["code_manifest"]["frozen_receiver"]["blobs"].update({"scripts/autonomous/dispatch_journal.py":"0"*40}),
                   lambda c: c.update(late_paths_complete=False), lambda c: c.update(late_ops_revisions=[admin.CURRENT_MAIN]),
                   lambda c: c.update(contradictions=["fence event removed"]), lambda c: c.update(ref_rewinds=["rewind"]),
                   lambda c: c.update(monotonic_native_policy="unknown"), lambda c: c["lineage"].update(merge_base="0"*40),
                   lambda c: c["lineage"].update(ahead_by=True), lambda c: c.update(full_current_journal_read=True)]
        for change in changes:
            with self.subTest(change=change):
                f = deepcopy(self.f); change(f["external_resolution"]["current"]); self.deny(f)
        f = deepcopy(self.f); f["owner_authority"]["observed_at"] = (NOW-timedelta(seconds=301)).isoformat(); self.deny(f)

    def test_replay_exact_raw_bytes_never_touches_new_pending_or_lease(self):
        settled = admin.prepare_external_resolution(**self.f)
        f = deepcopy(self.f); f.update(state_bytes=settled, expected_dot_blob_sha=admin.blob_sha(settled))
        self.assertEqual(admin.prepare_external_resolution(**f), settled)
        state = json.loads(settled)
        state.update(pending_operation={"id":"newer pending"}, lease={"id":"newer lease"}, active_task={"id":"newer task"})
        f["state_bytes"] = encoded(state); f["expected_dot_blob_sha"] = admin.blob_sha(f["state_bytes"])
        self.assertEqual(admin.prepare_external_resolution(**f), f["state_bytes"])
        for change in (lambda v: v["owner_authority"]["record"].update(id="different-owner-decision"),
                       lambda v: v["external_resolution"]["record"]["primary_evidence"].update(sha256="0"*64)):
            bad = deepcopy(f); change(bad); rebind(bad); self.deny(bad)
        state["operations"][-1]["disposition"] = "verified"
        f["state_bytes"] = encoded(state); f["expected_dot_blob_sha"] = admin.blob_sha(f["state_bytes"]); self.deny(f)

    def test_replay_rejects_rehashed_embedded_evidence_tampering(self):
        raw = admin.prepare_external_resolution(**self.f)
        for change in (lambda r: r["owner_authority"]["record"].update(owner="foreign"),
                       lambda r: r["external_resolution"]["record"].update(original_call_delivery="delivered"),
                       lambda r: r["execution_record"]["owner-fence-result.json"].update(outcome="already_fenced"),
                       lambda r: r["external_resolution"]["current"].update(contradictions=["removed fence"])):
            state = json.loads(raw); row = state["operations"][-1]; change(row)
            row["record_sha256"] = ops.digest({k:v for k,v in row.items() if k != "record_sha256"})
            f = deepcopy(self.f); f["state_bytes"] = encoded(state)
            f["expected_dot_blob_sha"] = admin.blob_sha(f["state_bytes"]); self.deny(f)

    def test_exact_fence_blob_and_impossible_before_ancestry_cannot_contradict_readback(self):
        f = deepcopy(self.f); current=f["external_resolution"]["current"]
        current.update(state_sha=old.AFTER, queue_blob_sha=f["external_resolution"]["record"]["git_readback"]["after"]["blob_sha"])
        current["lineage"].update(head=old.AFTER,status="identical",ahead_by=0)
        admin.prepare_external_resolution(**f)
        current["queue_blob_sha"]="0"*40; self.deny(f)
        f = deepcopy(self.f); current=f["external_resolution"]["current"]
        current.update(state_sha=old.BASE); current["lineage"]["head"]=old.BASE; self.deny(f)

    def test_original_cannot_replay_as_initial_successor_or_sync_after_admin_close(self):
        state = json.loads(admin.prepare_external_resolution(**self.f))
        for predecessor in (None, "op-1"):
            item = old.candidate(identifier="new-attempt")
            item["request"]["arguments"]["inputs"]["decision_id"] = self.f["external_resolution"]["record"]["run"]["inputs"]["decision_id"]
            preflight = old.preflight(state,item); preflight["decision_id"] = item["request"]["arguments"]["inputs"]["decision_id"]
            with self.assertRaisesRegex(ValueError, "already has an attempt|no-send required"):
                ops.prepare_operation(state, item, preflight, old.authority(), predecessor_id=predecessor, now=old.NOW)
        item = old.candidate(ops.SYNC, "forbidden-sync")
        item["fence_receipt_id"] = state["operations"][-1]["execution_record"]["owner-fence-result.json"]["receipt_id"]
        with self.assertRaisesRegex(ValueError, "completed original fence"):
            ops.prepare_operation(state, item, old.preflight(state,item), old.authority(), now=old.NOW)
        self.assertEqual(len(state["operations"]), 3)

    def test_external_run_cannot_be_original_completion(self):
        state = json.loads(self.f["state_bytes"])
        observation = old.observation(state)
        observation.update(self.f["external_resolution"]["record"])
        with self.assertRaisesRegex(ValueError, "wrong original workflow run"):
            ops.complete_operation(state, observation, self.f["external_archive_bytes"], now=old.NOW)

    def test_general_unknown_rule_is_unchanged(self):
        before = old.pending()
        after = ops.reconcile_operation(before, old.observation(before,"unknown"), now=old.NOW)
        self.assertEqual(after["pending_operation"], before["pending_operation"])
        self.assertEqual(after["lease"], before["lease"])
        self.assertEqual(after["operations"][-1]["outcome"], "unknown")

    def test_shared_zip_parser_preserves_bounds_names_crc_eof_and_json(self):
        name = "owner-fence-result.json"
        with zipfile.ZipFile(io.BytesIO(self.f["external_archive_bytes"])) as bundle:
            valid = [(n,bundle.read(n)) for n in bundle.namelist()]
        malformed = [valid + [("extra.json",b'{}')], [("../"+n,b) for n,b in valid],
                     [(n,b'{}' if n==name else b) for n,b in valid],
                     [(n,b'{"x":1,"x":2}' if n==name else b) for n,b in valid],
                     [(n,b'{"x":NaN}' if n==name else b) for n,b in valid],
                     [(n,b'x'*8193 if n==name else b) for n,b in valid]]
        for members in malformed:
            f = deepcopy(self.f); rec=f["external_resolution"]["record"]
            f["external_archive_bytes"] = old.raw_archive(rec,members); rebind(f); self.deny(f)
        for overrides in ({name:{"crc":0}}, {name:{"directory_name":name+"\0alias"}},
                          {name:{"local_name":"other.json"}}, {name:{"declared":b'{}'}},
                          {name:{"encoded":b'\x03'}}):
            f=deepcopy(self.f); rec=f["external_resolution"]["record"]
            f["external_archive_bytes"]=old.controlled_zip(rec,valid,overrides); rebind(f); self.deny(f)
        f=deepcopy(self.f); f["external_archive_bytes"]+=b'x'*65536
        f["external_resolution"]["record"]["artifact"]["digest"]="sha256:"+hashlib.sha256(f["external_archive_bytes"]).hexdigest()
        rebind(f);self.deny(f)

    def test_real_local_git_two_writer_cas_and_lost_ack_are_readback_only(self):
        candidate = admin.prepare_external_resolution(**self.f)
        with tempfile.TemporaryDirectory() as td:
            repo=Path(td)
            def git(*args, input=None, check=True):
                return subprocess.run(["git","-C",str(repo),"-c","core.hooksPath="+os.devnull,*args],
                                      input=input,capture_output=True,check=check)
            git("init","--bare")
            def blob(raw): return git("hash-object","-w","--stdin",input=raw).stdout.strip().decode()
            before=blob(self.f["state_bytes"]); proposed=blob(candidate); other=blob(b'{"other":"writer"}\n')
            ref="refs/isolated/admin-state"
            git("update-ref",ref,before)
            git("update-ref",ref,other,before)
            self.assertNotEqual(git("update-ref",ref,proposed,before,check=False).returncode,0)
            self.assertEqual(git("rev-parse",ref).stdout.strip().decode(),other)
            git("update-ref",ref,before,other)
            git("update-ref",ref,proposed,before)  # Simulate durable write whose ACK is lost.
            readback=git("cat-file","blob",ref).stdout
            f=deepcopy(self.f);f.update(state_bytes=readback,expected_dot_blob_sha=admin.blob_sha(readback))
            self.assertEqual(admin.prepare_external_resolution(**f),readback)
            self.assertNotEqual(git("update-ref",ref,proposed,before,check=False).returncode,0)
            self.assertEqual(readback,candidate)


class LateNativeFenceTest(unittest.TestCase):
    """Real disposable Git transport; reviewed pinned controller, not SHA mismatch."""
    def setUp(self):
        self.assertIsNotNone(admin, "before: separate administrative pure API is not implemented")
        import dispatch_journal_test as native
        self.native = native
        control = patch.object(native, "CONTROL", admin.FROZEN_RECEIVER)
        control.start(); self.addCleanup(control.stop)
        native.JournalTests.setUp(self)

    def git(self, *args): return self.native.JournalTests.git(self, *args)
    def reader(self, *args): return self.native.JournalTests.reader(self, *args)
    def trigger(self, *args): return self.native.JournalTests.trigger(self, *args)
    def owner_trigger(self, *args): return self.native.JournalTests.owner_trigger(self, *args)
    def fence(self, *args): return self.native.JournalTests.fence(self, *args)
    def reserve(self, *args, **kwargs): return self.native.JournalTests.reserve(self, *args, **kwargs)

    def test_same_frozen_receiver_binding_is_closed_by_fence_not_sha_mismatch(self):
        from dispatch_journal import NEXT
        intent, send = self.reserve(); send.consume()
        self.assertEqual(intent["control_sha"], admin.FROZEN_RECEIVER)
        before = self.store.current()
        self.assertEqual(before["active_intent"], intent)
        result = self.fence(self.store,intent,before["state_sha"])
        after = self.store.current()
        bound, capability = self.reader("late-frozen-native").admit(
            NEXT, {}, key=intent["correlation_key"], trigger=self.trigger("20"), control_sha=admin.FROZEN_RECEIVER)
        self.assertEqual(bound,intent); self.assertIsNone(capability)
        self.assertEqual(self.store.current(),after)
        self.assertEqual(result["outcome"],"fenced")
        self.assertNotEqual(admin.FROZEN_RECEIVER,admin.CURRENT_MAIN)
        # Correct same frozen pin passed _match; closure is bound != active, not main mismatch.
        self.assertIsNone(after["active_intent"])
        self.assertNotIn(intent["decision_id"],after["executor_claims"])

    def test_late_old_recovery_after_fence_is_readonly_and_never_implicit_sync(self):
        intent, _ = self.reserve(); before = self.store.current()
        first = self.fence(self.store,intent,before["state_sha"])
        after = self.store.current()
        late = self.reader("late-old-native")
        with patch.object(late,"_write",side_effect=AssertionError("late native write")):
            result=self.fence(late,intent,before["state_sha"])
        self.assertEqual((result["outcome"],result["receipt_id"]),("already_fenced",first["receipt_id"]))
        self.assertEqual(self.store.current(),after)
        self.assertEqual(after["send_claims"],before["send_claims"])
        self.assertEqual(after["effects"],before["effects"])

    def test_late_old_recovery_between_baseline_and_cas_loses_exact_parent(self):
        from dispatch_journal import JournalConflict
        intent, _ = self.reserve(); before = self.store.current()
        old = self.reader("old-native-recovery"); writer = old._write
        external = self.reader("external-native-recovery"); won=[]
        def race(data):
            won.append(self.fence(external,intent,before["state_sha"]))
            return writer(data)
        with patch.object(old,"_write",side_effect=race), self.assertRaises(JournalConflict):
            self.fence(old,intent,before["state_sha"])
        after=self.store.current()
        self.assertEqual(len(won),1)
        self.assertEqual(after["owner_fences"][intent["decision_id"]]["receipt_id"],won[0]["receipt_id"])
        self.assertEqual(after["state_sha"],won[0]["state_sha"])
        self.assertEqual(after["send_claims"],before["send_claims"])
        self.assertEqual(after["effects"],before["effects"])


if __name__ == "__main__":
    unittest.main()
