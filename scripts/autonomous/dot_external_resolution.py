#!/usr/bin/env python3
"""Pure, separately owner-directed retirement of one unknown OPS metadata lock.

LOCAL CANDIDATE: no caller, CLI, grant activation, source admission or write path.
The caller must authenticate immutable owner acceptance and primary observations;
JSON/hash checks cannot prove provenance. Output is only candidate bytes, never a
send, Sync, successor, retry, CAS, or source-maintenance capability.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import hashlib
import json

from dot_authority import digest
from dot_ops_outcomes import (RECOVERY, REPOSITORY, ISSUE, WORKFLOWS, OUTCOME, SHA,
                              require, text, hexadecimal, stamp, same, _state,
                              _operation, _pending, _outcomes, _retained_artifact)
from owner_fence_proof import strict_json

KIND = "owner-ops-external-resolution"
SCOPE = "separate-owner-directed-administrative-external-resolution"
CONTRACT = "ce0f8036a0d17081941b6c35f075f9b5267eb19d4937b5dca146ae0b3530d0e9"
ORIGINAL_MAIN = "21dbb4faf1717fc9e5cdc7f799d47bc50f8b8fc2"
CURRENT_MAIN = "c05e015b584e7b16f0483bc2fb9fa19318faacd9"  # Historical producer/review baseline, never live main.
FROZEN_RECEIVER = "398c6310e7938d51f713bbf1eeea75fb8e2066eb"
IMPLEMENTATION_PATHS = {
    "docs/dot/ADMIN_EXTERNAL_RESOLUTION.md",
    "scripts/autonomous/dot_external_resolution.py",
    "scripts/autonomous/dot_external_resolution_test.py",
    "scripts/autonomous/dot_ops_outcomes.py",
}
MAX_DOT_BYTES = 16 * 1024 * 1024
COMMON = {
    "scripts/autonomous/dispatch_journal.py": "51824d28aff7e75d5972aef5dcca336b56df193f",
    "scripts/autonomous/workflow_admission.py": "ae1c513ccd07cd5487c8ec5941a48dd2405f3ebd",
    "scripts/autonomous/state_store.py": "89eccfea3cc2050b68c690edac6669d7d2b6189a",
}
OPS_GUARDS = {**COMMON,
    ".github/workflows/autonomous_recover_delivery.yml": "959e455d8eb5167b0083bdae0006df2ea9257702",
    "scripts/autonomous/owner_fence_proof.py": "7cb7b3024da6b3ecfd71ad4f50037fc52b72c87e",
    "scripts/autonomous/recover_delivery.py": "0c091cfca44dd1a3d3b894e219f395c98e438d19",
}
CODE_MANIFEST = {
    "original_ops": {"control_sha": ORIGINAL_MAIN, "blobs": OPS_GUARDS},
    "current_ops": {"control_sha": CURRENT_MAIN, "blobs": OPS_GUARDS},
    "frozen_receiver": {"control_sha": FROZEN_RECEIVER, "blobs": {**COMMON,
        ".github/workflows/autonomous_next_task.yml": "b5e975696984c51b0f7dafda723705ba93648792"}},
}
POLICY = {
    "kind": "owner-administrative-external-resolution-policy", "version": 2,
    "repository": REPOSITORY, "scope": SCOPE, "contract_sha256": CONTRACT,
    "disposition": "administrative_closed_unknown", "historical_delivery": "unknown",
    "allowed_diff": ["append_one_separate_administrative_record", "clear_matching_pending", "clear_matching_ops_lease"],
    "new_effect_authority": [], "source_grant_changes": False, "unknown_rule_changes": False,
    "monotonic_native_guards_required": True, "current_full_journal_required": False,
    "code_manifest": CODE_MANIFEST,
    "installed_revision_binding": "exact-owner-delegated-reviewed-implementation",
}


def blob_sha(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()


def _reference(value):
    require(type(value) is dict and set(value) == {"ref", "sha256"}, "immutable evidence reference required")
    text(value["ref"]); hexadecimal(value["sha256"])


def _implementation(value):
    require(type(value) is dict and set(value) == {"main_sha", "tree_sha", "source_blobs", "reviews"},
            "exact reviewed installed implementation required")
    main = hexadecimal(value["main_sha"], SHA)
    require(main not in {ORIGINAL_MAIN, CURRENT_MAIN, FROZEN_RECEIVER}, "administrative implementation is not installed")
    hexadecimal(value["tree_sha"], SHA)
    blobs = value["source_blobs"]
    require(type(blobs) is dict and set(blobs) == IMPLEMENTATION_PATHS, "complete administrative source manifest required")
    for sha in blobs.values():
        hexadecimal(sha, SHA)
    reviews = value["reviews"]
    require(type(reviews) is dict and set(reviews) == {"code", "safety"}, "two reviewed implementation references required")
    for ref in reviews.values():
        _reference(ref)
    require(reviews["code"]["ref"] != reviews["safety"]["ref"], "distinct review references required")
    return value


def _authority(envelope, original, before, lease, external_hash, now):
    require(type(envelope) is dict, "separate administrative owner decision required")
    record = envelope.get("record")
    require(type(record) is dict and record.get("kind") == "owner-administrative-external-resolution-decision"
            and record.get("scope") == SCOPE and record.get("status") == "active"
            and record.get("repository") == REPOSITORY and record.get("owner") == "Omnividente"
            and type(record.get("version")) is int and record["version"] == 2,
            "not an owner-directed administrative decision")
    text(record.get("id")); _reference(record.get("decision"))
    require(record.get("recorded_by") == "dot-owner-delegate"
            and record.get("owner_personally_reviewed_revision") is False,
            "truthful delegated implementation provenance required")
    _implementation(record.get("accepted_implementation"))
    require(digest(record) == hexadecimal(envelope.get("record_sha256")), "owner decision hash changed")
    require(same(envelope.get("accepted_policy"), POLICY)
            and record.get("accepted_policy_sha256") == digest(POLICY), "unaccepted administrative policy")
    binding = {"operation_id": original["id"], "operation_sha256": digest(original),
               "request_sha256": original["request_sha256"], "intent_sha256": original["intent_sha256"],
               "source_grant_id": original["authority"]["source_grant_id"],
               "original_inputs": original["request"]["arguments"]["inputs"],
               "released_lease_sha256": digest(lease), **before}
    require(same(record.get("binding"), binding) and record.get("external_record_sha256") == external_hash,
            "owner decision does not bind this exact retirement")
    issued = stamp(record.get("issued_at"), now)
    stamp(envelope.get("observed_at"), now, fresh=True)
    require(envelope.get("issue") == {"html_url": ISSUE, "state": "open"}
            and envelope.get("owner_authenticated") is True and envelope.get("decision_unchanged") is True
            and envelope.get("events_complete") is True and envelope.get("revocations_complete") is True,
            "fresh owner/issue/revocation authentication required")
    _reference(envelope.get("authority_readback"))
    events, revoked = envelope.get("issue_events"), envelope.get("revoked_ids")
    require(type(events) is list and type(revoked) is list and all(type(i) is str for i in revoked),
            "complete administrative revocation history required")
    for event in events:
        require(type(event) is dict, "malformed issue event")
        if event.get("event") == "closed":
            require(stamp(event.get("created_at"), now) < issued, "administrative decision revoked by closure")
    require(not {record["id"], digest(POLICY)}.intersection(revoked), "administrative decision revoked")
    # The old source/OPS grant is preserved, not used to authorize this new scope.
    # Its validity is NOT asserted and no source/OPS authority is activated here.
    return record


def _external(original, envelope, archive, now):
    require(type(envelope) is dict and type(envelope.get("record")) is dict, "external provenance required")
    record = envelope["record"]
    require(record.get("kind") == "external-owner-fence-resolution"
            and record.get("repository") == REPOSITORY and record.get("original_operation_id") == original["id"]
            and record.get("original_call_delivery") == "unknown" and record.get("is_original_run") is False,
            "external run must remain separate from original delivery")
    require(envelope.get("record_sha256") == digest(record), "external provenance hash changed")
    _reference(record.get("primary_evidence"))
    run = record.get("run", {})
    inputs = original["request"]["arguments"]["inputs"]
    require(type(run.get("id")) is int and run["id"] > 0 and type(run.get("run_attempt")) is int
            and run["run_attempt"] == 1 and run.get("event") == "workflow_dispatch"
            and run.get("head_branch") == "main" and run.get("head_sha") == CURRENT_MAIN
            and run.get("repository", {}).get("full_name") == REPOSITORY
            and run.get("path") == ".github/workflows/" + WORKFLOWS[RECOVERY]
            and run.get("actor", {}).get("login") == "Omnividente"
            and run.get("triggering_actor", {}).get("login") == "Omnividente"
            and same(run.get("inputs"), inputs), "foreign external recovery context")
    require(run.get("html_url") == "https://github.com/" + REPOSITORY + "/actions/runs/" + str(run["id"]),
            "external run URL mismatch")
    require(stamp(run.get("created_at"), now) >= stamp(original["prepared_at"], now), "external run predates incident")
    data = _retained_artifact(RECOVERY, record, archive)
    proof, native = data["owner-fence-proof.json"], data["owner-fence-result.json"]
    context = {"repository": REPOSITORY, "workflow": WORKFLOWS[RECOVERY], "ref": "refs/heads/main",
               "event_name": "workflow_dispatch", "control_sha": run["head_sha"], "run_id": str(run["id"]),
               "run_attempt": "1", "actor": "Omnividente", **inputs}
    require(set(proof) == {"schema", "kind", "status", "context", "before", "after", "checks", "native_outcome", "allows_sync"}
            and set(native) == {"outcome", "decision_id", "receipt_id", "state_sha", "frontier_seq"}
            and type(proof.get("schema")) is int and proof["schema"] == 1
            and proof.get("kind") == "owner-fence-full-state-proof" and proof.get("status") == "verified"
            and proof.get("native_outcome") == "fenced" and proof.get("allows_sync") is True
            and same(proof.get("context"), context), "exact external full historical fence proof required")
    before, after, checks = proof.get("before", {}), proof.get("after", {}), proof.get("checks", {})
    for snapshot in (before, after):
        require(type(snapshot) is dict and set(snapshot) == {"commit_sha", "blob_sha", "bytes", "sha256"},
                "exact historical snapshot identity required")
        for field in ("commit_sha", "blob_sha"):
            hexadecimal(snapshot.get(field), SHA)
        hexadecimal(snapshot.get("sha256"))
        require(type(snapshot.get("bytes")) is int and snapshot["bytes"] > 0, "historical full snapshot missing")
    for field in ("body_sha256", "prior_journal_sha256", "added_event_id", "native_receipt_id"):
        hexadecimal(checks.get(field))
    require(before["commit_sha"] == inputs["expected_state_sha"] and after["commit_sha"] != before["commit_sha"]
            and after["blob_sha"] != before["blob_sha"] and after["sha256"] != before["sha256"]
            and native.get("outcome") == "fenced" and native.get("decision_id") == inputs["decision_id"]
            and native.get("state_sha") == after["commit_sha"]
            and native.get("receipt_id") == checks["native_receipt_id"]
            and type(native.get("frontier_seq")) is int and native["frontier_seq"] > 0
            and type(checks.get("native_frontier_seq")) is int and native["frontier_seq"] == checks["native_frontier_seq"]
            and type(checks.get("added_event_count")) is int and checks["added_event_count"] == 1
            and type(checks.get("prior_event_count")) is int and checks["prior_event_count"] > 0,
            "external native fence/result disagreement")
    require(same(record.get("git_readback"), {"before": before, "after": after,
                 "after_parents": [before["commit_sha"]], "current_state_sha": after["commit_sha"]}),
            "full historical Git parent/blob/readback binding required")
    receiver = record.get("original_receiver", {})
    require(receiver.get("control_sha") == FROZEN_RECEIVER and receiver.get("decision_id") == inputs["decision_id"]
            and receiver.get("correlation_key") == digest([inputs["decision_id"], "dispatch"])[:32],
            "unproven frozen receiver identity")
    _reference(receiver.get("retained_handoff"))
    for name in ("run_id", "artifact_id"):
        require(type(receiver.get(name)) is int and receiver[name] > 0, "original handoff identity missing")
    require(receiver["run_id"] != run["id"] and receiver["artifact_id"] != record["artifact"]["id"],
            "original handoff and external recovery identities must be distinct")
    return record, data


def _current(current, proof, now, implementation):
    require(type(current) is dict, "fresh native observation required")
    stamp(current.get("observed_at"), now, fresh=True)
    _reference(current.get("primary_evidence")); _reference(current.get("late_path_review"))
    _reference(current.get("implementation_readback"))
    installed = _implementation(implementation)
    installed_main = installed["main_sha"]
    require(same(current.get("installed_implementation"), installed), "installed revision differs from accepted implementation")
    expected_manifest = {**CODE_MANIFEST,
                         "installed_ops": {"control_sha": installed_main, "blobs": OPS_GUARDS}}
    ancestry = current.get("main_lineage", {})
    require(ancestry.get("base") == CURRENT_MAIN and ancestry.get("head") == installed_main
            and ancestry.get("merge_base") == CURRENT_MAIN and ancestry.get("status") == "ahead"
            and type(ancestry.get("ahead_by")) is int and ancestry["ahead_by"] == 1
            and current.get("installed_main_parents") == [CURRENT_MAIN],
            "accepted implementation is not a proved direct baseline child")
    require(current.get("native_ref") == "refs/heads/autonomous/state"
            and current.get("main_sha") == installed_main and same(current.get("code_manifest"), expected_manifest)
            and current.get("late_paths_complete") is True
            and same(current.get("late_ops_revisions"), [ORIGINAL_MAIN, CURRENT_MAIN, installed_main])
            and current.get("monotonic_native_policy") == "active-no-rewind-no-guard-weakening"
            and current.get("contradictions") == [] and current.get("ref_rewinds") == []
            and current.get("journal_preservation") == "historical-full-proof-plus-native-append-only-guards"
            and current.get("full_current_journal_read") is False,
            "native guards, late paths or monotonic trust model unavailable")
    head = hexadecimal(current.get("state_sha"), SHA)
    hexadecimal(current.get("queue_blob_sha"), SHA)
    fence = proof["after"]["commit_sha"]
    require(head != proof["before"]["commit_sha"]
            and (head != fence or current["queue_blob_sha"] == proof["after"]["blob_sha"]),
            "current ref/blob contradicts authenticated historical fence")
    lineage = current.get("lineage", {})
    require(lineage.get("base") == fence and lineage.get("head") == head and lineage.get("merge_base") == fence
            and type(lineage.get("ahead_by")) is int and lineage["ahead_by"] >= 0
            and lineage.get("status") == ("identical" if head == fence else "ahead")
            and ((head == fence and lineage["ahead_by"] == 0) or (head != fence and lineage["ahead_by"] > 0)),
            "current native ref is not a proved fence descendant")
    # Ancestry is not represented as a fresh full-prefix read. Preservation is
    # conditional on the explicitly accepted native append-only/no-rewind model.


def prepare_external_resolution(state_bytes, *, expected_dot_blob_sha, owner_authority,
                                external_resolution, external_archive_bytes, now):
    """Return only an additive accounting candidate, or the exact replay bytes.

    Caller must independently reauthenticate immediately before any separately
    authorized exact-blob CAS; lost ACK/conflict permits only GET/readback. This
    module neither implements nor authorizes that CAS. Freshness is observations,
    never lease expiry. Unknown source/control drift requires a new reviewed policy.
    """
    require(type(state_bytes) is bytes and 0 < len(state_bytes) <= MAX_DOT_BYTES, "bounded full Dot bytes required")
    require(blob_sha(state_bytes) == hexadecimal(expected_dot_blob_sha, SHA), "Dot raw blob changed")
    try:
        state = strict_json(state_bytes)
        _state(state)
        digest(owner_authority); digest(external_resolution)
    except (TypeError, UnicodeError, RecursionError) as exc:
        raise ValueError("invalid JSON input") from exc
    require(type(owner_authority) is dict and type(owner_authority.get("record")) is dict,
            "separate owner decision required")
    operation_id = owner_authority["record"].get("binding", {}).get("operation_id")
    originals = [row for row in state["operations"] if row["id"] == operation_id]
    require(len(originals) == 1, "original history absent")
    original = originals[0]; key = _operation(original)
    require(original["kind"] == RECOVERY and original.get("expected", {}).get("main_sha") == ORIGINAL_MAIN
            and original.get("authority", {}).get("source_grant_id") == state["grant_id"], "unsupported original incident")
    rows = _outcomes(state, original)
    require(all(row.get("outcome") == "unknown" for row in rows), "contradictory original delivery/settlement")
    external, records = _external(original, external_resolution, external_archive_bytes, now)
    historical = [row for row in state["operations"] if row.get("kind") == KIND and row.get("operation_id") == operation_id]
    require(len(historical) <= 1, "duplicate administrative settlement")
    if historical:
        retained = historical[0]
        lease, before = retained.get("released_lease"), retained.get("before")
        require(type(lease) is dict and type(before) is dict, "administrative archive corrupted")
    else:
        pending, _ = _pending(state)
        require(same(pending, original), "not the matching pending operation")
        lease = state["lease"]
        before = {"dot_blob_sha": expected_dot_blob_sha, "state_sha256": digest(state),
                  "raw_sha256": hashlib.sha256(state_bytes).hexdigest()}
    decision = _authority(owner_authority, original, before, lease, digest(external), now)
    identifier = "ops-external-resolution-" + digest([KIND, digest(original), digest(POLICY), records["owner-fence-result.json"]["receipt_id"]])
    binding = {"owner_decision_sha256": digest(decision), "external_record_sha256": digest(external)}
    if historical:
        require(retained.get("id") == identifier and retained.get("binding") == binding
                and same(retained.get("owner_authority", {}).get("record"), decision)
                and same(retained.get("owner_authority", {}).get("accepted_policy"), POLICY)
                and same(retained.get("external_resolution"), external_resolution)
                and same(retained.get("execution_record"), records)
                and same(retained.get("original_pending"), original) and retained.get("logical_key") == key
                and retained.get("disposition") == "administrative_closed_unknown"
                and retained.get("historical_delivery") == "unknown"
                and retained.get("record_sha256") == digest({k: v for k, v in retained.items() if k != "record_sha256"}),
                "administrative replay identity/evidence mismatch")
        # Do not validate/clear a newer pending or lease. No new write is needed.
        return state_bytes
    _current(external_resolution.get("current"), records["owner-fence-proof.json"], now, decision["accepted_implementation"])
    require(not any(row["id"] == identifier for row in state["operations"]), "administrative id collision")
    row = {"id": identifier, "kind": KIND, "operation_id": operation_id, "logical_key": key,
           "disposition": "administrative_closed_unknown", "historical_delivery": "unknown",
           "original_pending": deepcopy(original), "released_lease": deepcopy(lease), "before": before,
           "binding": binding, "owner_authority": deepcopy(owner_authority),
           "external_resolution": deepcopy(external_resolution), "execution_record": records,
           "recorded_at": now.isoformat()}
    row["record_sha256"] = digest(row)
    result = deepcopy(state)
    result["operations"].append(row)
    result["pending_operation"] = None
    result["lease"] = None
    candidate = (json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    require(len(candidate) <= MAX_DOT_BYTES, "candidate exceeds replayable Dot byte bound")
    return candidate
