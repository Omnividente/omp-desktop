#!/usr/bin/env python3
"""Retain explicit owner report commands without granting runtime authority."""
from __future__ import annotations

import copy
from datetime import datetime, timezone

from dispatch_journal import DIGEST, SHA, NEXT, ExecutionCapability, materialize, normalize_inputs
from research_request import sha256_json
from select_task import is_unresolved
from task_lifecycle import awaiting_report, find_task, iso, parse_iso

FIELD = "owner_recovery_requests"
IDENTITY_FIELDS = ("session_id", "dispatch_key", "attempts", "base_sha")
TRIGGER_FIELDS = ("run_id", "run_attempt", "event_name", "control_sha", "repository", "actor")


def _records(manifest):
    controller = manifest.get("controller")
    return controller.get(FIELD, []) if isinstance(controller, dict) else []


def _identity(task):
    execution = task.get("execution") or {}
    return {field: execution.get(field) for field in IDENTITY_FIELDS}


def _request_id(record):
    basis = {"task_id": record["inputs"]["task_id"], "identity": record["identity"],
             "repair_after": record["inputs"]["repair_after"]}
    if not basis["repair_after"]:
        # Collector-only commands cannot resend a format request. Reruns still
        # share the original run identity, rather than manufacturing new work.
        basis["run_id"] = record["source_trigger"]["run_id"]
    return sha256_json(basis)


def _inputs(inputs):
    result = normalize_inputs(NEXT, inputs)
    if (not result["recover_report"] or not result["task_id"] or result["automatic"]
            or result["recover_feedback"] or result["feedback_after"] or result["focus"]):
        raise ValueError("queued recovery requires one explicit owner report command")
    if result["repair_after"] and parse_iso(result["repair_after"]) is None:
        raise ValueError("queued repair requires an exact UTC receipt timestamp")
    return result


def _failed_checkpoint(manifest, record, state=None):
    execution = record.get("execution")
    if execution is None:
        return None
    state = state if state is not None else materialize(manifest.get("dispatch_journal"))
    receipt = state["completions"].get(execution["decision_id"])
    if receipt is None or receipt.get("type") != "OwnerReportRecoveryCheckpointCompletion":
        return None
    evidence = receipt.get("evidence") or {}
    if (receipt.get("executor_claim_id") != execution["executor_claim_id"]
            or evidence.get("request_id") != record["request_id"]
            or evidence.get("task_id") != record["inputs"]["task_id"]):
        raise ValueError("failed checkpoint does not bind the original report command")
    return receipt


def validate_requests(manifest) -> list[str]:
    """Validate saved command provenance; current eligibility is checked on use."""
    from validate_tasks import _nonblank, _utc_timestamp
    controller = manifest.get("controller")
    if not isinstance(controller, dict) or FIELD not in controller:
        return []
    prefix = "controller." + FIELD
    records = controller[FIELD]
    if not isinstance(records, list):
        return [prefix + " must be a list"]
    errors, identifiers = [], set()
    state = None
    for index, record in enumerate(records):
        location = prefix + "[" + str(index) + "]"
        try:
            if (not isinstance(record, dict) or set(record) - {
                    "request_id", "inputs", "identity", "source_trigger", "requested_at",
                    "execution", "resume_execution"}
                    or not DIGEST.fullmatch(str(record.get("request_id", "")))
                    or record["request_id"] in identifiers or not _utc_timestamp(record.get("requested_at"))):
                raise ValueError("requires a unique command identity and UTC reservation")
            identifiers.add(record["request_id"])
            inputs = _inputs(record.get("inputs", {}))
            if inputs != record.get("inputs"):
                raise ValueError("requires exact normalized report inputs")
            if inputs["repair_after"] and not _utc_timestamp(inputs["repair_after"]):
                raise ValueError("requires an exact UTC failed receipt")
            identity, trigger = record.get("identity"), record.get("source_trigger")
            if (not isinstance(identity, dict) or set(identity) != set(IDENTITY_FIELDS)
                    or not all(_nonblank(identity.get(field)) for field in ("session_id", "dispatch_key"))
                    or type(identity.get("attempts")) is not int or identity["attempts"] < 1
                    or not SHA.fullmatch(str(identity.get("base_sha", "")))):
                raise ValueError("requires the original bound research attempt")
            if (not isinstance(trigger, dict) or set(trigger) != set(TRIGGER_FIELDS)
                    or trigger.get("event_name") != "workflow_dispatch"
                    or not all(str(trigger.get(field, "")).isdigit() and int(trigger[field]) > 0
                               for field in ("run_id", "run_attempt"))
                    or not SHA.fullmatch(str(trigger.get("control_sha", "")))
                    or not all(_nonblank(trigger.get(field)) for field in ("repository", "actor"))
                    or record["request_id"] != _request_id(record)):
                raise ValueError("requires the immutable original owner dispatch")
            for field in ("execution", "resume_execution"):
                if field not in record:
                    continue
                execution = record[field]
                if (not isinstance(execution, dict) or set(execution) != {
                        "decision_id", "executor_claim_id", "run_id", "run_attempt", "actor", "at"}
                        or not _utc_timestamp(execution.get("at"))
                        or parse_iso(execution["at"]) < parse_iso(record["requested_at"])):
                    raise ValueError("requires an acknowledged runtime executor")
                if state is None:
                    state = materialize(manifest.get("dispatch_journal"))
                intent = state["intents"].get(execution["decision_id"])
                claim = state["executor_claims"].get(execution["decision_id"])
                if (intent is None or claim is None or intent["workflow"] != NEXT
                        or intent["normalized_inputs"] != inputs
                        or claim["claim_id"] != execution["executor_claim_id"]
                        or any(claim["trigger"].get(key) != execution[key]
                               for key in ("run_id", "run_attempt", "actor"))):
                    raise ValueError("must retain its exact journal executor claim")
                if field == "resume_execution":
                    receipt = _failed_checkpoint(manifest, record, state)
                    if (receipt is None
                            or execution["decision_id"] == record["execution"]["decision_id"]
                            or parse_iso(execution["at"]) < parse_iso(receipt["at"])
                            or (intent.get("basis", {}).get("health", {}).get("owner_recovery") or {}).get("request_id")
                            != record["request_id"]):
                        raise ValueError("resume requires the exact observed pre-provider failure")
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
            errors.append(location + " " + str(exc))
    return errors


def _bound_request(manifest, config, record):
    from proposal_backlog import authorize
    authorize(config, record["source_trigger"]["actor"])
    if record["source_trigger"]["repository"] != config.get("repository"):
        raise ValueError("queued report recovery has a foreign repository")
    task = find_task(manifest, record["inputs"]["task_id"])
    if (task is None or task.get("task_type") != "project_discovery"
            or _identity(task) != record["identity"]):
        raise ValueError("queued report recovery cannot rebind the original attempt")
    return task


def pending_recovery(manifest, config) -> dict | None:
    errors = validate_requests(manifest)
    if errors:
        raise ValueError("invalid owner report recovery queue")
    state = None
    for record in _records(manifest):
        if "execution" in record and "resume_execution" not in record and state is None:
            state = materialize(manifest.get("dispatch_journal"))
        if ("execution" not in record or "resume_execution" not in record
                and _failed_checkpoint(manifest, record, state) is not None):
            task = _bound_request(manifest, config, record)
            scope = task.get("research") or {}
            if (record["inputs"]["repair_after"] and scope.get("area_id")
                    and scope.get("perspective_id") and any(
                        other.get("id") != task["id"]
                        and other.get("task_type") == "project_discovery"
                        and is_unresolved(other)
                        and (other.get("research") or {}).get("area_id") == scope["area_id"]
                        and (other.get("research") or {}).get("perspective_id") == scope["perspective_id"]
                        for other in manifest["tasks"]
                    )):
                continue  # Poll the existing attempt before selecting another format repair.
            return copy.deepcopy(record)
    return None


def queue_recovery(manifest, config, *, inputs, trigger, now=None) -> dict:
    """Append owner intent only; a future admitted NEXT owns every external effect."""
    from proposal_backlog import authorize
    if (not isinstance(inputs, dict) or inputs.get("continuation_key")
            or not isinstance(trigger, dict) or trigger.get("ref", "refs/heads/main") != "refs/heads/main"
            or trigger.get("workflow", NEXT) != NEXT):
        raise ValueError("report commands require external trusted NEXT ingress")
    inputs = _inputs(inputs)
    actor = authorize(config, str(trigger.get("actor", "")))
    if (trigger.get("event_name") != "workflow_dispatch"
            or trigger.get("repository") != config.get("repository")):
        raise ValueError("report commands require their original owner dispatch")
    task = find_task(manifest, inputs["task_id"])
    if task is None or task.get("task_type") != "project_discovery":
        raise ValueError("report commands require an existing research attempt")
    at = now or datetime.now(timezone.utc)
    record = {"inputs": inputs, "identity": _identity(task),
              "source_trigger": {field: trigger.get(field) for field in TRIGGER_FIELDS},
              "requested_at": iso(at)}
    record["source_trigger"]["actor"] = actor
    record["request_id"] = _request_id(record)
    errors = validate_requests(manifest)
    if errors:
        raise ValueError("invalid owner report recovery queue")
    for saved in _records(manifest):
        if saved["request_id"] == record["request_id"]:
            return copy.deepcopy(saved)
    if not awaiting_report(task) or (task.get("execution") or {}).get("pull_request"):
        raise ValueError("report commands require the same parked research attempt")
    if inputs["repair_after"]:
        execution = task["execution"]
        prior = execution.get("report_repair") or {}
        consumed = any(item.get("at") == inputs["repair_after"]
                       for item in execution.get("report_repair_history", []))
        if not consumed and (prior.get("at") != inputs["repair_after"]
                             or prior.get("status") not in ("invalid", "rejected", "expired", "failed")
                             or at <= parse_iso(inputs["repair_after"])):
            raise ValueError("queued repair must retain its exact settled receipt")
    candidate = {**manifest, "controller": {**(manifest.get("controller") or {}),
                                            FIELD: [*_records(manifest), record]}}
    if validate_requests(candidate):
        raise ValueError("invalid queued report command")
    manifest["controller"] = candidate["controller"]
    return copy.deepcopy(record)


def claim_recovery(manifest, config, *, inputs, intent, trigger, capability, now=None) -> dict | None:
    """Bind a queued command to a real consumed, unfinished execution capability."""
    inputs = normalize_inputs(NEXT, inputs)
    if not inputs["recover_report"]:
        return None
    if validate_requests(manifest):
        raise ValueError("invalid owner report recovery queue")
    if not isinstance(intent, dict):
        raise ValueError("queued report recovery requires its admitted intent")
    if intent.get("workflow") != NEXT or intent.get("normalized_inputs") != inputs:
        raise ValueError("queued report inputs differ from the admitted intent")
    selected = (intent.get("basis", {}).get("health", {}).get("owner_recovery") or {}).get("request_id")
    record = next((saved for saved in _records(manifest)
                   if (saved["request_id"] == selected if selected else saved["inputs"] == inputs)), None)
    if record is None:
        if selected:
            raise ValueError("queued report authorization is unavailable")
        return None
    field = "execution"
    if "execution" in record:
        if "resume_execution" in record or _failed_checkpoint(manifest, record) is None:
            return None
        if not selected:
            raise ValueError("report resume requires the original command's causal selection")
        field = "resume_execution"
    _bound_request(manifest, config, record)
    if not isinstance(capability, ExecutionCapability):
        raise ValueError("queued report recovery requires an execution capability")
    observer = capability.observer_context()
    from proposal_backlog import authorize
    authorize(config, str(trigger.get("actor", "")))
    state = materialize(manifest.get("dispatch_journal"))
    claim = state["executor_claims"].get(intent.get("decision_id"))
    if (state["intents"].get(intent.get("decision_id")) != intent
            or intent.get("workflow") != NEXT or intent.get("normalized_inputs") != inputs
            or record["inputs"] != inputs or observer["kind"] != "execute"
            or observer["decision_id"] != intent.get("decision_id") or claim is None
            or observer["claim_id"] != claim["claim_id"] or observer["trigger"] != trigger
            or claim["trigger"] != trigger):
        raise ValueError("queued report recovery does not bind the admitted executor")
    execution = {"decision_id": intent["decision_id"], "executor_claim_id": claim["claim_id"],
                 "run_id": trigger["run_id"], "run_attempt": trigger["run_attempt"],
                 "actor": trigger["actor"], "at": iso(now or datetime.now(timezone.utc))}
    staged = [{**saved, field: execution} if saved is record else saved
              for saved in _records(manifest)]
    candidate = {**manifest, "controller": {**manifest["controller"], FIELD: staged}}
    if validate_requests(candidate):
        raise ValueError("invalid queued report execution")
    record[field] = execution
    return copy.deepcopy(record)


def preserve_requests(previous, current) -> None:
    """Keep the owner command, original executor and single proven resume append-only."""
    before, after = _records(previous), _records(current)
    if not isinstance(before, list) or not isinstance(after, list) or len(after) < len(before):
        raise ValueError("owner report recovery history is immutable")
    for old, new in zip(before, after):
        if ({key: value for key, value in old.items() if key not in {"execution", "resume_execution"}}
                != {key: value for key, value in new.items() if key not in {"execution", "resume_execution"}}
                or any(field in old and old[field] != new.get(field)
                       for field in ("execution", "resume_execution"))):
            raise ValueError("owner report recovery commands cannot be rewritten or renewed")
