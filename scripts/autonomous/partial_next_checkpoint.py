#!/usr/bin/env python3
"""Observe the pinned historical partial controller failure; never authorize retry.

This is deliberately separate from failed-save/no-effect readers. Frozen readers
that do not know OwnerPartialNextCheckpointCompletion must reject its event; do
not deploy a frozen writer over this receipt or treat it as execution authority.
"""
from __future__ import annotations

from next_no_effect_artifact import PARTIAL_NEXT_PRODUCER as SUPPORTED_PRODUCER

FAILURE_KIND = "partial_controller_failure_observed"
REF_GUARD_REASON = "attempt branch already exists at a different revision"
EXECUTION_DELTA = frozenset(("note", "observed_at", "outcome", "report_error", "report_repair",
                             "session_state", "state"))


NATIVE_DIAGNOSTIC_FIELDS = ("task_id", "session_id", "dispatch_key", "attempts", "collected_at",
                            "session_state", "source", "error_code", "research_parser")


def validate_native_diagnostic(value):
    """Only typed provenance and a fixed native error cross the retention boundary."""
    import re
    from dispatch_journal import _timestamp
    from validate_tasks import _validate_report_source
    if (not isinstance(value, dict) or set(value) != set(NATIVE_DIAGNOSTIC_FIELDS)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", str(value["task_id"]))
            or not re.fullmatch(r"[A-Za-z0-9_-]+", str(value["session_id"]))
            or not re.fullmatch(r"[0-9a-f]{24}", str(value["dispatch_key"]))
            or type(value["attempts"]) is not int or value["attempts"] < 1
            or value["session_state"] != "COMPLETED" or value["error_code"] != "research_invalid"
            or value["research_parser"] != {"status": "research_invalid",
                "detail": "expected exactly one ordered research report block"}
            or not isinstance(value["source"], dict) or set(value["source"]) != {
                "session_id", "dispatch_key", "activity_id", "activity_created_at", "report_sha256"}
            or _validate_report_source(value["source"], "partial_native.source")
            or value["source"]["session_id"] != value["session_id"]
            or value["source"]["dispatch_key"] != value["dispatch_key"]):
        raise ValueError("unsupported partial NEXT native report diagnostic")
    if _timestamp(value["source"]["activity_created_at"]) > _timestamp(value["collected_at"]):
        raise ValueError("partial NEXT native report predates its source activity")


def _scope_fingerprints(repo, config, base_sha):
    """The pinned planner's product-blob algorithm, on an immutable saved tree.

    Fetch names only the exact saved object, with no destination ref. It neither
    checks out a branch nor reads current lab/main as a substitute for that tree.
    """
    import hashlib
    from check_change_scope import evaluate, manual_review_hits
    from dispatch_journal import SHA
    from research_cycle import validate_config
    from state_store import _git
    validate_config(config)
    if not SHA.fullmatch(str(base_sha)):
        raise ValueError("partial NEXT requires its exact historical product base")
    _git(repo, "fetch", "--no-tags", "origin", base_sha)
    tree = _git(repo, "ls-tree", "-rz", "--full-tree", base_sha).stdout
    blobs = []
    for record in tree.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, oid = metadata.split()
        path = raw_path.decode("utf-8", errors="surrogateescape")
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            continue
        if evaluate(config, [path])["allowed"] and not manual_review_hits(config, [path]):
            blobs.append((path, raw_path, oid))
    fingerprints = {}
    for area in config["research"]["areas"]:
        roots = [path.rstrip("/") for path in area["paths"]]
        scoped = [(raw, oid) for path, raw, oid in blobs if any(
            path == root or path.startswith(root + "/") for root in roots)]
        if not scoped:
            raise ValueError("partial NEXT historical research scope has no product blobs")
        fingerprint = hashlib.sha256()
        for raw_path, oid in sorted(scoped):
            fingerprint.update(raw_path + b"\0" + oid + b"\0")
        fingerprints[area["id"]] = fingerprint.hexdigest()
    return fingerprints


def partial_body_delta(before, native, config, repo, diagnostic):
    """Prove complete structural conservation, not a digest/count approximation."""
    from dispatch_journal import JournalConflict, _timestamp, digest
    from select_task import select
    from research_cycle import plan_research

    def require(condition):
        if not condition:
            raise JournalConflict("unsupported historical partial NEXT body delta")

    excluded = {"tasks", "controller", "dispatch_journal"}
    require({k: v for k, v in before.items() if k not in excluded}
            == {k: v for k, v in native.items() if k not in excluded})
    old_controller, new_controller = before.get("controller", {}), native.get("controller", {})
    require({k: v for k, v in old_controller.items() if k != "last_poll_at"}
            == {k: v for k, v in new_controller.items() if k != "last_poll_at"})
    require(new_controller.get("last_poll_at") != old_controller.get("last_poll_at"))
    poll_at = _timestamp(new_controller.get("last_poll_at"))
    if old_controller.get("last_poll_at"):
        require(poll_at >= _timestamp(old_controller["last_poll_at"]))

    old_tasks, new_tasks = before["tasks"], native["tasks"]
    require(len(new_tasks) == len(old_tasks) + 1)
    # The historical planner appends exactly one task. No reorder/removal, even
    # for unmodified tasks whose substantive projection would ignore clocks.
    changed = [(old, new) for old, new in zip(old_tasks, new_tasks)
               if old != new]
    require(len(changed) == 1)
    old, new = changed[0]
    require({k: v for k, v in old.items() if k not in {"status", "execution"}}
            == {k: v for k, v in new.items() if k not in {"status", "execution"}})
    require(old.get("task_type") == "project_discovery" and old.get("status") == "in_progress"
            and new.get("status") == "blocked")
    original, observed = old.get("execution", {}), new.get("execution", {})
    require({k: v for k, v in original.items() if k not in EXECUTION_DELTA}
            == {k: v for k, v in observed.items() if k not in EXECUTION_DELTA})
    require({k for k in original.keys() | observed.keys() if original.get(k) != observed.get(k)}
            == EXECUTION_DELTA)
    require(original.get("state") == "dispatched" and original.get("session_state") == "IN_PROGRESS"
            and original.get("outcome") == "" and not any(k in original for k in
                ("report_error", "report_repair")))
    require(observed.get("state") == "awaiting_report" and observed.get("outcome") == "report_invalid"
            and observed.get("session_state") == "COMPLETED")
    error, repair = observed.get("report_error"), observed.get("report_repair")
    # f7cf research_report's missing/duplicate/reversed envelope branch raises
    # this exact fixed InvalidReport. Do not accept arbitrary exception codes or
    # worker-derived detail under a generic report-invalid label.
    require(isinstance(error, dict) and set(error) == {"code", "detail", "reported_at", "source"}
            and error["code"] == "research_invalid"
            and error["detail"] == "expected exactly one ordered research report block"
            and observed.get("note") == "completed worker report requires inspection: research_invalid")
    require(isinstance(repair, dict) and set(repair) == {"at", "result", "status", "source"}
            and repair["status"] == "pending" and repair["result"] == "sent"
            and repair["source"] == error["source"])
    source = error["source"]
    require(isinstance(source, dict) and set(source) == {
        "session_id", "dispatch_key", "activity_id", "activity_created_at", "report_sha256"})
    require(source["session_id"] == original.get("session_id")
            and source["dispatch_key"] == original.get("dispatch_key")
            and isinstance(source["activity_id"], str)
            and source["activity_id"].startswith("sessions/" + source["session_id"] + "/activities/")
            and len(source["activity_id"].split("/")) == 4)
    from dispatch_journal import DIGEST
    require(DIGEST.fullmatch(str(source["report_sha256"])) is not None)
    observed_at, reported_at, repair_at = (_timestamp(observed.get("observed_at")),
                                         _timestamp(error["reported_at"]), _timestamp(repair["at"]))
    require(_timestamp(source["activity_created_at"]) <= reported_at == observed_at
            and observed_at <= poll_at <= repair_at)
    validate_native_diagnostic(diagnostic)
    require(diagnostic["task_id"] == old["id"] and diagnostic["session_id"] == original.get("session_id")
            and diagnostic["dispatch_key"] == original.get("dispatch_key")
            and diagnostic["attempts"] == original.get("attempts") and diagnostic["source"] == source
            and diagnostic["collected_at"] == observed["observed_at"] == error["reported_at"]
            and diagnostic["error_code"] == error["code"]
            and diagnostic["research_parser"]["detail"] == error["detail"])

    added = new_tasks[-1]
    require(added.get("id") not in {task["id"] for task in old_tasks}
            and set(added) == {"id", "title", "task_type", "status", "focus", "risk", "priority",
                               "target_paths", "created_at", "evidence", "research"}
            and added["task_type"] == "project_discovery" and added["status"] == "todo"
            and added["risk"] == "low" and added["priority"] == 10
            and added["evidence"].get("source") == "autonomous_research")
    _timestamp(added["created_at"])
    research = added["research"]
    require(set(research) == {"area_id", "perspective_id", "fingerprint", "cycle", "previous_reports"}
            and type(research["cycle"]) is int and research["cycle"] > 0
            and added["id"] == "research-" + research["area_id"] + "-" + research["perspective_id"]
            + "-" + str(research["cycle"]))
    # Re-run the existing pure planner on the complete pre-add checkpoint. This
    # binds title/focus/paths/evidence/context/cycle and the scheduling choice,
    # not just an attacker-supplied plausible shape or a digest of it.
    fingerprints = _scope_fingerprints(repo, config, original.get("base_sha"))
    require(research["fingerprint"] == fingerprints.get(research["area_id"]))
    pre_add = {**native, "tasks": native["tasks"][:-1]}
    expected, planned = plan_research(pre_add, config, fingerprints, now=observed_at,
                                      focus=[], risk_ceiling="medium")
    require(planned.get("research_changed") is True and expected["tasks"][-1] == added
            and expected == native)
    selection = select(native, focus=[], risk_ceiling="medium", allow_discovery=True)
    require(selection.get("selected") is True and selection.get("task_id") == added["id"]
            and selection.get("attempts") == 0)
    return {"polled_task_id": old["id"], "planned_task_id": added["id"],
            "changed_task_fields": ["execution", "status"],
            "changed_execution_fields": sorted(EXECUTION_DELTA),
            "controller_fields": ["last_poll_at"], "repair_status": "pending", "repair_result": "sent",
            "changed_task_sha256": digest(new), "added_task_sha256": digest(added)}


def receipt_id(event):
    from dispatch_journal import _receipt_id
    return _receipt_id(event["decision_id"], event["executor_claim_id"], FAILURE_KIND, {
        name: event[name] for name in ("owner_trigger", "before_state_sha", "before_digest",
                                      "evidence", "proof", "native_report")})


def validate_event(event, intent, executor, state):
    from dispatch_journal import (DIGEST, NEXT, OWNER_PARTIAL_NEXT_CHECKPOINT, SHA,
                                  _owner_trigger, _source_identity)
    from failed_next_checkpoint import automatic_inputs
    import re
    trigger = _owner_trigger(event.get("owner_trigger"), intent["decision_id"],
                             event.get("before_state_sha"), workflow=OWNER_PARTIAL_NEXT_CHECKPOINT)
    decision = intent["decision_id"]
    proof, report, evidence = event.get("proof"), event.get("native_report"), event.get("evidence")
    if (intent["workflow"] != NEXT or intent["source_kind"] != "sender"
            or not automatic_inputs(intent["normalized_inputs"]) or intent["control_sha"] != SUPPORTED_PRODUCER
            or executor["trigger"].get("run_attempt") != "1"
            or executor["trigger"].get("event_name") != "workflow_dispatch"
            or executor.get("correlation_key") != intent["correlation_key"]
            or decision not in state["send_claims"] or decision in state["effects"]
            or decision in state["completions"] or decision in state["phase_claims"]
            or any(stage["decision_id"] == decision for stage in state["stages"].values())
            or _source_identity(trigger) in state["source_ids"]
            or trigger["repository"] != intent["first_source_trigger"].get("repository")
            or trigger["repository"] != executor["trigger"].get("repository")
            or not isinstance(proof, dict) or set(proof) != {
                "producer", "workflow", "ref", "artifact_id", "artifact_name", "artifact_sha256", "report_sha256"}
            or proof["producer"] != executor["trigger"] or proof["workflow"] != NEXT
            or proof["ref"] != "refs/heads/main"
            or not re.fullmatch(r"[1-9][0-9]*", str(proof["artifact_id"]))
            or proof["artifact_name"] != "laboratory-result-" + executor["trigger"]["run_id"] + "-1"
            or not all(DIGEST.fullmatch(str(proof[k])) for k in ("artifact_sha256", "report_sha256"))):
        raise ValueError("partial NEXT requires its supported original automatic sender executor and native proof")
    if (not isinstance(report, dict) or set(report) != {"action", "merge_mode", "reason", "attention", "state_sha"}
            or report["action"] != "stopped" or report["merge_mode"] != "manual"
            or report["reason"] != "controller_error" or report["attention"] != [{"reason": REF_GUARD_REASON}]
            or report["state_sha"] != event["before_state_sha"]
            or not isinstance(evidence, dict) or set(evidence) != {
                "status", "action", "reason", "external_effects", "before_state_sha", "after_state_sha",
                "before_digest", "after_digest", "before_body_sha256", "native_body_sha256", "delta", "native_diagnostic"}
            or evidence["status"] != "failed_with_partial_checkpoints" or evidence["action"] != "stopped"
            or evidence["reason"] != "controller_error" or evidence["external_effects"] != "not_presumed_absent"
            or evidence["before_state_sha"] != executor["before_state_sha"]
            or evidence["after_state_sha"] != report["state_sha"]
            or not SHA.fullmatch(str(report["state_sha"]))
            or evidence["before_digest"] != executor["before_digest"]
            or evidence["after_digest"] != event.get("before_digest")
            or not all(DIGEST.fullmatch(str(evidence[k])) for k in (
                "before_digest", "after_digest", "before_body_sha256", "native_body_sha256"))
            or evidence["before_body_sha256"] == evidence["native_body_sha256"]
            or event.get("kind") != FAILURE_KIND):
        raise ValueError("partial NEXT observation must retain its failure and unknown external effects")
    delta = evidence["delta"]
    if (not isinstance(delta, dict) or set(delta) != {"polled_task_id", "planned_task_id", "changed_task_fields",
            "changed_execution_fields", "controller_fields", "repair_status", "repair_result",
            "changed_task_sha256", "added_task_sha256"}
            or not all(isinstance(delta[k], str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", delta[k])
                       for k in ("polled_task_id", "planned_task_id"))
            or delta["polled_task_id"] == delta["planned_task_id"]
            or delta["changed_task_fields"] != ["execution", "status"]
            or delta["changed_execution_fields"] != sorted(EXECUTION_DELTA)
            or delta["controller_fields"] != ["last_poll_at"] or delta["repair_status"] != "pending"
            or delta["repair_result"] != "sent"
            or not all(DIGEST.fullmatch(str(delta[k])) for k in ("changed_task_sha256", "added_task_sha256"))):
        raise ValueError("partial NEXT observation requires its exact structural delta evidence")
    validate_native_diagnostic(evidence["native_diagnostic"])
    if evidence["native_diagnostic"]["task_id"] != delta["polled_task_id"]:
        raise ValueError("partial NEXT receipt changed its authenticated native report task")
    return trigger
