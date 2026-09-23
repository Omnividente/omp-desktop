#!/usr/bin/env python3
"""Validate agent_tasks.json structure, lifecycle bookkeeping and evidence."""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta
import sys
from pathlib import Path
from typing import Any

from jules_dispatch import session_is_active
from select_task import blocks_lane, is_unresolved, pending_rejection, valid_research_detachment
from research_request import CONTRACT_VERSION, sha256_json, validate_task_request

POST_DEFERRED_REASONS = frozenset({"historical_post_context_missing", "historical_post_unexplained",
                                   "historical_post_insufficient_evidence"})

VALID_STATUSES = {"proposed", "todo", "in_progress", "done", "blocked"}
VALID_RISKS = {"low", "medium", "high"}
VALID_TASK_TYPES = {
    "product_improvement", "bugfix", "test_coverage", "refactor",
    "project_discovery", "chore",
}
VALID_OUTCOMES = {
    "", "merged", "no_change", "researched", "review_required", "report_invalid", "closed_unmerged", "failed", "stale",
}
VALID_EXECUTION_STATES = {
    "", "dispatching", "dispatched", "quarantined", "completed", "retry", "exhausted", "awaiting_review", "awaiting_report",
}

MAX_PREVIOUS_REPORTS = 3
MAX_PREVIOUS_REPORT_CHARS = 24000


def _nonblank(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _string_list(value: Any) -> bool:
    return isinstance(value, list) and all(_nonblank(item) for item in value)


def validate_reproduction(block: Any, prefix: str = "evidence.reproduction") -> list:
    """Check an actionable report's shape, never whether its claim is true."""
    if not isinstance(block, dict):
        return [prefix + " must be an object"]
    errors = []
    if not _string_list(block.get("steps")) or not block["steps"]:
        errors.append(prefix + ".steps must be a non-empty list of non-empty strings")
    for field in ("expected", "actual"):
        if not _nonblank(block.get(field)):
            errors.append(prefix + "." + field + " must be a non-empty string")
    return errors


def _utc_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or "T" not in value:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0)
    except ValueError:
        return False


def proposal_mutation_error(task: dict) -> str:
    """A human decision closes backlog work, never an unknown worker or PR."""
    execution = task.get("execution") or {}
    if not isinstance(execution, dict):
        return "invalid execution record"
    if is_unresolved(task) or execution.get("state") in ("dispatching", "dispatched", "quarantined"):
        return "unresolved worker must be reconciled before a proposal decision"
    if execution.get("state") in ("awaiting_review", "awaiting_report"):
        return "pending worker report or PR must be reconciled before a proposal decision"
    if execution.get("pull_request") and execution.get("outcome") not in ("merged", "closed_unmerged"):
        return "pending PR must be settled before a proposal decision"
    if execution.get("session_id") and session_is_active({"state": execution.get("session_state")}):
        return "saved worker has no observed terminal state"
    return ""


def _validate_proposal(task: dict, prefix: str) -> list:
    errors = []
    decision = task.get("proposal_decision")
    if task.get("status") == "proposed":
        if task.get("task_type") == "project_discovery":
            errors.append(prefix + ".proposed is only for nonresearch backlog")
        if "proposal_decision" in task or task.get("execution"):
            errors.append(prefix + ".proposed cannot carry a decision or execution")
    if "proposal_decision" not in task:
        return errors
    if not isinstance(decision, dict):
        return errors + [prefix + ".proposal_decision must be an object"]
    if task.get("task_type") == "project_discovery":
        errors.append(prefix + ".proposal_decision requires a nonresearch task")
    if decision.get("action") not in ("approve", "reject", "resolve"):
        errors.append(prefix + ".proposal_decision.action must be approve, reject or resolve")
    if not _nonblank(decision.get("actor")):
        errors.append(prefix + ".proposal_decision.actor must be a non-empty string")
    if not _nonblank(decision.get("note")) and not (
            decision.get("action") in ("reject", "resolve") and task.get("status") == "done"
            and (decision.get("note") is None or isinstance(decision.get("note"), str))):
        errors.append(prefix + ".proposal_decision.note must be a non-empty string")
    if not _utc_timestamp(decision.get("at")):
        errors.append(prefix + ".proposal_decision.at must be an ISO UTC timestamp")
    execution = task.get("execution") or {}
    if "status" in decision:
        if decision.get("action") != "reject" or decision["status"] not in ("pending", "completed"):
            errors.append(prefix + ".proposal_decision.status requires a staged rejection")
        if not isinstance(execution, dict) or any(
            not decision.get(field) or decision[field] != execution.get(field)
            for field in ("session_id", "dispatch_key")
        ):
            errors.append(prefix + ".proposal_decision must retain its rejected attempt identity")
        if decision["status"] == "completed" and not _utc_timestamp(decision.get("completed_at")):
            errors.append(prefix + ".completed rejection requires a UTC completed_at")
    if pending_rejection(task):
        if (not isinstance(execution, dict) or task.get("status") != "blocked"
                or execution.get("state") != "quarantined" or execution.get("outcome") != "stale"
                or type(execution.get("attempts")) is not int or execution["attempts"] < 1
                or execution.get("pull_request")):
            errors.append(prefix + ".pending rejection requires its unresolved bound worker without a PR")
        if "completed_at" in decision:
            errors.append(prefix + ".pending rejection cannot claim completion")
        return errors
    if decision.get("action") in ("reject", "resolve"):
        if task.get("status") != "done":
            errors.append(prefix + ".closed proposal requires done status")
        reason = proposal_mutation_error(task)
        if reason:
            errors.append(prefix + ".proposal_decision: " + reason)
    return errors


def _validate_report_source(source: Any, prefix: str) -> list:
    if not isinstance(source, dict):
        return [prefix + " must be an object"]
    errors = []
    session = str(source.get("session_id") or "")
    resource = session if session.startswith("sessions/") else "sessions/" + session
    if not re.fullmatch(r"sessions/[A-Za-z0-9_-]+", resource):
        errors.append(prefix + ".session_id must identify a Jules session")
    if not re.fullmatch(re.escape(resource) + r"/activities/[^/]+", str(source.get("activity_id") or "")):
        errors.append(prefix + ".activity_id must belong to the source session")
    if not _nonblank(source.get("dispatch_key")):
        errors.append(prefix + ".dispatch_key is required")
    if not re.fullmatch(r"[0-9a-f]{64}", str(source.get("report_sha256") or "")):
        errors.append(prefix + ".report_sha256 must be a SHA-256 digest")
    if not _utc_timestamp(source.get("activity_created_at")):
        errors.append(prefix + ".activity_created_at must be an ISO UTC timestamp")
    return errors


def validate_research_result(block: Any, prefix: str = "research_result") -> list:
    if not isinstance(block, dict):
        return [prefix + " must be an object"]
    errors = []
    if not _nonblank(block.get("summary")):
        errors.append(prefix + ".summary must be a non-empty string")
    observations = block.get("observations")
    if not isinstance(observations, list) or not observations:
        errors.append(prefix + ".observations must be a non-empty list")
    else:
        for index, observation in enumerate(observations):
            if not isinstance(observation, dict) or any(
                not _nonblank(observation.get(field))
                for field in ("scenario", "evidence", "result")
            ):
                errors.append(prefix + ".observations[" + str(index)
                              + "] requires non-empty scenario, evidence and result strings")
    for field in ("next_hypotheses", "proposed_task_ids"):
        if not _string_list(block.get(field)):
            errors.append(prefix + "." + field + " must be a list of non-empty strings")
    if not _utc_timestamp(block.get("completed_at")):
        errors.append(prefix + ".completed_at must be an ISO UTC timestamp")
    deferred = block.get("deferred_findings", [])
    if not isinstance(deferred, list):
        errors.append(prefix + ".deferred_findings must be a list")
    else:
        for item in deferred:
            if (not isinstance(item, dict)
                    or any(not _nonblank(item.get(field)) for field in ("title", "reason", "evidence"))
                    or any(not _string_list(item.get(field)) or not item[field]
                           for field in ("target_paths", "acceptance"))):
                errors.append(prefix + ".deferred_findings requires a proposal and its exclusion reason")
    if "source" in block:
        errors.extend(_validate_report_source(block["source"], prefix + ".source"))
    return errors


def _validate_discovery_import(task: dict, task_ids: set, prefix: str) -> list:
    if "discovery_import" not in task:
        return []
    receipt = task["discovery_import"]
    report = task.get("research_result")
    if (task.get("task_type") != "project_discovery" or not isinstance(receipt, dict)
            or not isinstance(report, dict) or not isinstance(report.get("source"), dict)
            or receipt.get("source") != report["source"]):
        return [prefix + ".discovery_import must identify the accepted research report"]
    result = receipt.get("result")
    if not isinstance(result, dict) or result.get("status") != "ok" or result.get("changed") is not True:
        return [prefix + ".discovery_import requires a successful immutable import result"]
    errors = []
    for field in ("added", "duplicates"):
        identifiers = result.get(field)
        if not _string_list(identifiers) or any(identifier not in task_ids for identifier in identifiers):
            errors.append(prefix + ".discovery_import." + field + " must link existing canonical tasks")
    if not isinstance(result.get("skipped"), list) or any(
        not isinstance(item, dict) or not _nonblank(item.get("id")) or not _nonblank(item.get("reason"))
        for item in result.get("skipped", [])
    ):
        errors.append(prefix + ".discovery_import.skipped requires identified decisions")
    if not _nonblank(result.get("detail")) or type(result.get("unverified_count")) is not int:
        errors.append(prefix + ".discovery_import requires detail and unverified_count")
    errors.extend(validate_research_result(dict(report, deferred_findings=result.get("deferred")),
                                           prefix + ".discovery_import"))
    return errors


def _validate_review_context(context: Any, tasks_by_id: dict, report_time: Any,
                             prefix: str) -> list:
    """Validate importer-owned links to an earlier human decision."""
    if not isinstance(context, dict):
        return [prefix + " must be an object"]
    if context.get("kind") != "historical_decision_overlap":
        return [prefix + ".kind must be historical_decision_overlap"]
    matches = context.get("matches")
    if not isinstance(matches, list) or not matches:
        return [prefix + ".matches must be a non-empty list"]
    if not _utc_timestamp(report_time):
        return [prefix + ".report_time must be an ISO UTC timestamp"]
    report_moment = datetime.fromisoformat(str(report_time).replace("Z", "+00:00"))
    errors = []
    seen = set()
    match_types = ("exact", "possible", "same_title")
    for index, match in enumerate(matches):
        item_prefix = prefix + ".matches[" + str(index) + "]"
        if not isinstance(match, dict):
            errors.append(item_prefix + " must be an object")
            continue
        task_id = match.get("task_id")
        if not _nonblank(task_id):
            errors.append(item_prefix + ".task_id must be a non-empty string")
            continue
        if task_id in seen:
            errors.append(item_prefix + ".task_id must be unique")
        seen.add(task_id)
        previous = tasks_by_id.get(task_id)
        if previous is None:
            errors.append(item_prefix + ".task_id must identify an existing task")
            continue
        if previous.get("task_type") == "project_discovery":
            errors.append(item_prefix + ".task_id must identify a nonresearch task")
        decision = previous.get("proposal_decision")
        if (not isinstance(decision, dict) or decision.get("action") not in ("reject", "resolve")
                or previous.get("status") != "done" or pending_rejection(previous)):
            errors.append(item_prefix + ".task_id must have a settled reject or resolve decision")
            continue
        if match.get("action") != decision.get("action"):
            errors.append(item_prefix + ".action does not match the canonical decision")
        decision_at = match.get("decision_at")
        if not _utc_timestamp(decision_at) or not _utc_timestamp(decision.get("at")):
            errors.append(item_prefix + ".decision_at must be an ISO UTC timestamp")
        elif decision_at != decision.get("at"):
            errors.append(item_prefix + ".decision_at does not match the canonical decision")
        if match.get("match") not in match_types:
            errors.append(item_prefix + ".match must be exact, possible or same_title")
        timing = match.get("timing")
        if timing not in ("pre", "post"):
            errors.append(item_prefix + ".timing must be pre or post")
        elif _utc_timestamp(decision.get("at")):
            decision_moment = datetime.fromisoformat(decision["at"].replace("Z", "+00:00"))
            expected = "pre" if report_moment <= decision_moment else "post"
            if timing != expected:
                errors.append(item_prefix + ".timing contradicts report and decision timestamps")
    return errors


def _validate_deferred_links(tasks_by_id: dict) -> list:
    """Validate both ends of new receipts without rewriting legacy report schemas."""
    from import_discovery_tasks import stable_candidate, normalize
    errors = []
    linked_proposals = set()
    for source_id, source in tasks_by_id.items():
        prefix = "task " + source_id
        receipt = source.get("discovery_import")
        report = source.get("research_result")
        events = source.get("deferred_materializations", [])
        if not isinstance(events, list):
            errors.append(prefix + ".deferred_materializations must be a list")
            continue
        receipt_result = receipt.get("result") if isinstance(receipt, dict) else None
        deferred = receipt_result.get("deferred", []) if isinstance(receipt_result, dict) else []
        if not isinstance(deferred, list):
            continue
        origin = {"task_id": source_id, **report["source"]} if isinstance(report, dict) and isinstance(report.get("source"), dict) else None
        full = {}
        for item in deferred:
            if not isinstance(item, dict) or not ("deferred_id" in item or str(item.get("reason")) in POST_DEFERRED_REASONS):
                continue
            identifier, candidate = item.get("deferred_id"), item.get("candidate")
            if (not isinstance(identifier, str) or not isinstance(candidate, dict)
                    or str(item.get("reason")) not in POST_DEFERRED_REASONS or not origin
                    or item.get("source") != origin
                    or identifier != sha256_json({"source": origin, "candidate": candidate})):
                errors.append(prefix + ".deferred identity must bind the accepted source and candidate")
                continue
            if identifier in full:
                errors.append(prefix + ".deferred_id must be unique")
            full[identifier] = item
            if candidate != stable_candidate(candidate) or candidate != stable_candidate(normalize(candidate, now="")):
                errors.append(prefix + ".deferred candidate must be normalized stable proposal data")
            if (str(candidate.get("task_type")) not in VALID_TASK_TYPES or candidate.get("task_type") == "project_discovery"
                    or str(candidate.get("risk")) not in VALID_RISKS or type(candidate.get("priority")) is not int
                    or not _nonblank(candidate.get("title")) or not _string_list(candidate.get("focus"))
                    or any(not _string_list(candidate.get(field)) or not candidate[field]
                           for field in ("target_paths", "acceptance"))):
                errors.append(prefix + ".deferred candidate requires current proposal shape")
            evidence = candidate.get("evidence")
            if not isinstance(evidence, dict):
                errors.append(prefix + ".deferred candidate requires evidence")
            else:
                errors.extend(validate_reproduction(evidence.get("reproduction"), prefix + ".deferred reproduction"))
            if any(item.get(field) != candidate.get(field) for field in ("title", "target_paths", "acceptance")):
                errors.append(prefix + ".deferred flattened proposal must match candidate")
            if item.get("evidence") != json.dumps(candidate.get("evidence"), ensure_ascii=False, sort_keys=True):
                errors.append(prefix + ".deferred flattened evidence must match candidate")
            errors.extend(_validate_review_context(item.get("review_context"), tasks_by_id,
                                                   origin.get("activity_created_at"), prefix + ".deferred review_context"))
            context = item.get("review_context")
            if (not isinstance(context, dict) or context.get("post_gate") != item["reason"]
                    or not isinstance(context.get("matches"), list)
                    or not any(isinstance(match, dict) and match.get("timing") == "post"
                               and match.get("match") in ("exact", "possible")
                               for match in context["matches"])):
                errors.append(prefix + ".deferred must preserve a strong POST admission exclusion")
            report_deferred = report.get("deferred_findings", [])
            if not isinstance(report_deferred, list) or sum(saved == item for saved in report_deferred) != 1:
                errors.append(prefix + ".deferred receipt must match the accepted report")
        if isinstance(report, dict):
            for item in report.get("deferred_findings", []) if isinstance(report.get("deferred_findings"), list) else []:
                if (isinstance(item, dict) and ("deferred_id" in item or str(item.get("reason")) in POST_DEFERRED_REASONS)
                        and item not in full.values()):
                    errors.append(prefix + ".report deferred must link its immutable import receipt")
        request = (source.get("execution") or {}).get("research_request") if isinstance(source.get("execution"), dict) else None
        if full and (not isinstance(request, dict) or request.get("contract_version") != CONTRACT_VERSION):
            errors.append(prefix + ".POST deferred requires its versioned controller request")
        if isinstance(request, dict) and request.get("contract_version") == CONTRACT_VERSION and isinstance(receipt_result, dict):
            for task_id in receipt_result.get("added", []) if isinstance(receipt_result.get("added"), list) else []:
                proposal = tasks_by_id.get(task_id) if isinstance(task_id, str) else None
                if not proposal or proposal.get("origin") != origin:
                    errors.append(prefix + ".added proposal must retain its accepted source identity")
        seen = set()
        for event in events:
            if not isinstance(event, dict):
                errors.append(prefix + ".materialization event must be an object")
                continue
            identifier = event.get("deferred_id")
            if not isinstance(identifier, str) or identifier not in full or identifier in seen:
                errors.append(prefix + ".materialization must identify one unique accepted deferred finding")
                continue
            seen.add(identifier)
            item = full[identifier]
            proposal_id = "discovery-" + sha256_json({"source": origin, "deferred_id": identifier})
            proposal = tasks_by_id.get(proposal_id)
            if (event.get("proposal_id") != proposal_id or not _utc_timestamp(event.get("at"))
                    or not _nonblank(event.get("actor")) or not _nonblank(event.get("note"))):
                errors.append(prefix + ".materialization requires deterministic identity and owner audit")
            expected = {"source_task_id": source_id, **{key: event.get(key) for key in ("deferred_id", "actor", "at", "note")}}
            if (proposal is None or proposal.get("materialized_from") != expected
                    or proposal.get("origin") != origin or stable_candidate(proposal) != item["candidate"]
                    or proposal.get("review_context") != item["review_context"]
                    or proposal.get("created_at") != event.get("at")):
                errors.append(prefix + ".materialization must match its canonical proposal in both directions")
            linked_proposals.add(proposal_id)
    for task_id, task in tasks_by_id.items():
        if "materialized_from" in task and task_id not in linked_proposals:
            errors.append("task " + task_id + ".materialized_from must link an accepted source event")
        origin = task.get("origin")
        if isinstance(origin, dict) and isinstance(origin.get("task_id"), str):
            source = tasks_by_id.get(origin["task_id"], {})
            request = (source.get("execution") or {}).get("research_request", {}) if isinstance(source.get("execution"), dict) else {}
            if isinstance(request, dict) and request.get("contract_version") == CONTRACT_VERSION:
                receipt = source.get("discovery_import") or {}
                added = (receipt.get("result") or {}).get("added", [])
                if origin != {"task_id": source["id"], **((source.get("research_result") or {}).get("source") or {})} or (
                        task_id not in added and task_id not in linked_proposals):
                    errors.append("task " + task_id + ".origin must link its canonical receipt or materialization")
    return errors



def _validate_repair_receipt(repair: Any, execution: dict, prefix: str) -> list:
    if not isinstance(repair, dict):
        return [prefix + " must be an object"]
    errors = []
    if not _utc_timestamp(repair.get("at")) or repair.get("result") not in ("pending", "sent", "unknown", "rejected"):
        errors.append(prefix + " requires UTC at and a durable send result")
    status = repair.get("status")
    if status not in ("pending", "resolved", "invalid", "rejected", "expired", "failed", "conflict"):
        errors.append(prefix + " has invalid status")
    if repair.get("result") == "rejected" and status not in ("rejected", "resolved"):
        errors.append(prefix + " rejected send cannot be pending")
    if status not in ("pending", "resolved") and not _nonblank(repair.get("detail")):
        errors.append(prefix + " terminal status requires a diagnostic detail")
    if "after" in repair and (not _utc_timestamp(repair["after"]) or not _nonblank(repair.get("actor"))):
        errors.append(prefix + " repeated repair requires its previous timestamp and owner actor")
    if "source" in repair:
        errors.extend(_validate_report_source(repair["source"], prefix + ".source"))
        if isinstance(repair["source"], dict) and any(
            repair["source"].get(field) != execution.get(field) for field in ("session_id", "dispatch_key")
        ):
            errors.append(prefix + ".source must belong to the stored attempt")
    return errors


def _validate_research(task: dict, prefix: str) -> list:
    errors = []
    research = task.get("research")
    if "research" in task:
        if not isinstance(research, dict):
            return [prefix + ".research must be an object"]
        if task.get("task_type") != "project_discovery":
            errors.append(prefix + ".research requires project_discovery task_type")
        for field in ("area_id", "perspective_id"):
            if not _nonblank(research.get(field)):
                errors.append(prefix + ".research." + field + " must be a non-empty string")
        if not isinstance(research.get("fingerprint"), str) or not re.fullmatch(
            r"[0-9a-f]{64}", research.get("fingerprint", "")
        ):
            errors.append(prefix + ".research.fingerprint must be a SHA-256 hex digest")
        cycle = research.get("cycle")
        if type(cycle) is not int or cycle < 1:
            errors.append(prefix + ".research.cycle must be a positive integer")
        reports = research.get("previous_reports")
        if not isinstance(reports, list) or len(reports) > MAX_PREVIOUS_REPORTS:
            errors.append(prefix + ".research.previous_reports must be a bounded list")
        else:
            if len(json.dumps(reports, ensure_ascii=False)) > MAX_PREVIOUS_REPORT_CHARS:
                errors.append(prefix + ".research.previous_reports exceeds context bound")
            for index, report in enumerate(reports):
                errors.extend(validate_research_result(
                    report, prefix + ".research.previous_reports[" + str(index) + "]",
                ))
    if "research_result" in task:
        errors.extend(validate_research_result(task["research_result"], prefix + ".research_result"))
    if research and task.get("status") == "done" and "research_result" not in task:
        errors.append(prefix + ".completed research requires research_result")
    execution = task.get("execution")
    if isinstance(execution, dict):
        outcome, state = execution.get("outcome"), execution.get("state")
        if outcome == "researched" and (
            task.get("status") != "done" or state != "completed"
            or "research_result" not in task
        ):
            errors.append(prefix + ".researched requires done/completed and research_result")
        if state == "awaiting_review" or outcome == "review_required":
            if (task.get("status"), state, outcome) != ("blocked", "awaiting_review", "review_required"):
                errors.append(prefix + ".manual review requires blocked/awaiting_review/review_required")
        if state == "awaiting_report" or outcome == "report_invalid" or "report_error" in execution:
            if (task.get("status"), state, outcome) != ("blocked", "awaiting_report", "report_invalid"):
                errors.append(prefix + ".report recovery requires blocked/awaiting_report/report_invalid")
            if (task.get("task_type") != "project_discovery"
                    or not _nonblank(execution.get("session_id"))
                    or not _nonblank(execution.get("dispatch_key"))
                    or type(execution.get("attempts")) is not int or execution["attempts"] < 1
                    or execution.get("pull_request")):
                errors.append(prefix + ".report recovery requires a bound research attempt without a PR")
            issue = execution.get("report_error")
            if (not isinstance(issue, dict)
                    or not _nonblank(issue.get("code")) or not _nonblank(issue.get("detail"))
                    or not _utc_timestamp(issue.get("reported_at"))):
                errors.append(prefix + ".report_error requires code, detail and an ISO UTC reported_at")
            if isinstance(issue, dict) and "source" in issue:
                errors.extend(_validate_report_source(issue["source"], prefix + ".report_error.source"))
                if isinstance(issue["source"], dict) and any(
                    issue["source"].get(field) != execution.get(field) for field in ("session_id", "dispatch_key")
                ):
                    errors.append(prefix + ".report_error.source must belong to the stored attempt")
        if "report_repair" in execution:
            repair = execution["report_repair"]
            errors.extend(_validate_repair_receipt(repair, execution, prefix + ".report_repair"))
            if isinstance(repair, dict):
                if (task.get("task_type") != "project_discovery"
                        or not _nonblank(execution.get("session_id"))
                        or not _nonblank(execution.get("dispatch_key"))
                        or type(execution.get("attempts")) is not int or execution["attempts"] < 1
                        or execution.get("pull_request")):
                    errors.append(prefix + ".report_repair requires the bound research attempt without a PR")
                status = repair.get("status")
                expected = ("done", "completed") if status == "resolved" else ("blocked", "awaiting_report")
                if (task.get("status"), state) != expected:
                    errors.append(prefix + ".report_repair status contradicts lifecycle")
                if status == "resolved" and (outcome not in ("no_change", "researched") or "research_result" not in task):
                    errors.append(prefix + ".resolved report_repair requires an accepted research report")
        history = execution.get("report_repair_history", [])
        if not isinstance(history, list):
            errors.append(prefix + ".report_repair_history must be a list")
        else:
            previous_at = None
            for index, item in enumerate(history):
                errors.extend(_validate_repair_receipt(item, execution, prefix + ".report_repair_history[" + str(index) + "]"))
                if not isinstance(item, dict):
                    continue
                if item.get("status") not in ("invalid", "rejected", "expired", "failed"):
                    errors.append(prefix + ".report_repair_history cannot authorize another pending or resolved send")
                if index and item.get("after") != previous_at:
                    errors.append(prefix + ".report_repair_history must retain its authorization chain")
                previous_at = item.get("at")
            current = execution.get("report_repair")
            if history or (isinstance(current, dict) and "after" in current):
                if (not history or not isinstance(current, dict) or current.get("after") != previous_at
                        or not _nonblank(current.get("actor"))):
                    errors.append(prefix + ".repeated repair must retain its previous receipt and actor")
                chain = [*history, current]
                for previous, following in zip(chain, chain[1:]):
                    if (isinstance(previous, dict) and isinstance(following, dict)
                            and _utc_timestamp(previous.get("at")) and _utc_timestamp(following.get("at"))
                            and datetime.fromisoformat(previous["at"].replace("Z", "+00:00"))
                            >= datetime.fromisoformat(following["at"].replace("Z", "+00:00"))):
                        errors.append(prefix + ".report repair timestamps must advance")
    from research_disposition import validate_research_disposition
    errors.extend(validate_research_disposition(task, prefix))
    return errors

def _validate_execution(block: Any, prefix: str) -> list:
    errors: list = []
    if block is None:
        return errors
    if not isinstance(block, dict):
        return [prefix + ".execution must be an object"]
    if type(block.get("attempts", 0)) is not int or block.get("attempts", 0) < 0:
        errors.append(prefix + ".execution.attempts must be a non-negative integer")
    if str(block.get("outcome", "")) not in VALID_OUTCOMES:
        errors.append(
            prefix + ".execution.outcome must be one of " + str(sorted(VALID_OUTCOMES))
        )
    if str(block.get("state", "")) not in VALID_EXECUTION_STATES:
        errors.append(
            prefix + ".execution.state must be one of " + str(sorted(VALID_EXECUTION_STATES))
        )
    if type(block.get("pull_request", 0)) is not int or block.get("pull_request", 0) < 0:
        errors.append(prefix + ".execution.pull_request must be a non-negative integer")
    if block.get("session_id") and not re.fullmatch(r"(?:sessions/)?[A-Za-z0-9_-]+", str(block["session_id"])):
        errors.append(prefix + ".execution.session_id must identify a Jules session")
    if "base_sha" in block or "starting_branch" in block or block.get("state") == "dispatching":
        if not re.fullmatch(r"[0-9a-fA-F]{40}", str(block.get("base_sha") or "")):
            errors.append(prefix + ".execution.base_sha must be an immutable commit SHA")
        key = block.get("dispatch_key")
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", key) or block.get("starting_branch") != "autonomous/attempt-" + key:
            errors.append(prefix + ".execution.starting_branch must identify the reserved attempt")
    receipt = block.get("provenance")
    if receipt is not None:
        if not isinstance(receipt, dict):
            errors.append(prefix + ".execution.provenance must be an object")
        else:
            if any(not block.get(field) or receipt.get(field) != block.get(field) for field in ("session_id", "dispatch_key", "pull_request")):
                errors.append(prefix + ".execution.provenance must belong to the current attempt")
            repository = receipt.get("repository")
            if not isinstance(repository, str) or not re.fullmatch(r"[^/\s]+/[^/\s]+", repository):
                errors.append(prefix + ".execution.provenance.repository is invalid")
            elif receipt.get("url") != "https://github.com/" + repository + "/pull/" + str(block.get("pull_request")):
                errors.append(prefix + ".execution.provenance.url must identify the recorded PR")
            if receipt.get("head_repository") != repository or any(not _nonblank(receipt.get(field)) for field in ("base_branch", "head_ref")):
                errors.append(prefix + ".execution.provenance requires same-repository branch identity")
            if not re.fullmatch(r"[0-9a-fA-F]{40}", str(receipt.get("head_sha") or "")) or not _utc_timestamp(receipt.get("verified_at")):
                errors.append(prefix + ".execution.provenance requires verified head SHA and timestamp")
    return errors


def validate(manifest: Any) -> list:
    errors: list = []
    if not isinstance(manifest, dict):
        return ["manifest must be a JSON object"]
    if type(manifest.get("version")) is not int and manifest.get("version") != CONTRACT_VERSION:
        errors.append("version must be a legacy integer or " + CONTRACT_VERSION)
    controller = manifest.get("controller")
    if controller is not None:
        if not isinstance(controller, dict):
            errors.append("controller must be an object")
        else:
            for field in ("last_tick_at", "last_poll_at"):
                if field in controller and not _utc_timestamp(controller[field]):
                    errors.append("controller." + field + " must be a UTC timestamp")
            if "run_id" in controller and not re.fullmatch(r"[1-9][0-9]*", str(controller["run_id"])):
                errors.append("controller.run_id must identify a workflow run")
    policy = manifest.get("autonomous_loop_policy")
    if not isinstance(policy, dict):
        errors.append("autonomous_loop_policy must be an object")
    else:
        if policy.get("research_contract") not in (None, CONTRACT_VERSION):
            errors.append("unsupported research contract")
        if (manifest.get("version") == CONTRACT_VERSION) != (policy.get("research_contract") == CONTRACT_VERSION):
            errors.append("version and required research contract must migrate together")
        lifecycle = policy.get("lifecycle")
        if lifecycle is not None:
            if not isinstance(lifecycle, dict):
                errors.append("autonomous_loop_policy.lifecycle must be an object")
            else:
                for field in ("max_attempts", "stale_in_progress_hours"):
                    value = lifecycle.get(field)
                    if value is not None and (not isinstance(value, int) or value < 1):
                        errors.append(
                            "autonomous_loop_policy.lifecycle." + field
                            + " must be a positive integer"
                        )
    tasks = manifest.get("tasks")
    if not isinstance(tasks, list):
        return errors + ["tasks must be a list"]

    task_ids = {task["id"] for task in tasks if isinstance(task, dict) and isinstance(task.get("id"), str)}
    tasks_by_id = {task["id"]: task for task in tasks
                   if isinstance(task, dict) and isinstance(task.get("id"), str)}
    seen_ids: set = set()
    lane_counts = {False: 0, True: 0}
    research_pairs = set()
    for index, task in enumerate(tasks):
        prefix = "tasks[" + str(index) + "]"
        if not isinstance(task, dict):
            errors.append(prefix + " must be an object")
            continue
        task_id = task.get("id")
        if not isinstance(task_id, str) or not task_id.strip():
            errors.append(prefix + ".id must be a non-empty string")
        elif not re.fullmatch(r"[^\s<>`]+", task_id):
            errors.append(prefix + ".id must round-trip through task markers without whitespace or delimiters")
        else:
            if task_id in seen_ids:
                errors.append(prefix + ".id " + repr(task_id) + " is duplicated")
            seen_ids.add(task_id)
        if not isinstance(task.get("title"), str) or not str(task.get("title")).strip():
            errors.append(prefix + ".title must be a non-empty string")
        status = str(task.get("status"))
        if status not in VALID_STATUSES:
            errors.append(prefix + ".status must be one of " + str(sorted(VALID_STATUSES)))
        # Invalid execution shapes are reported below, not passed to lane helpers.
        if task.get("execution") is None or isinstance(task.get("execution"), dict):
            for discovery in lane_counts:
                lane_counts[discovery] += int(blocks_lane(task, discovery=discovery))
            if is_unresolved(task) and task.get("task_type") == "project_discovery":
                research = task.get("research")
                if isinstance(research, dict) and all(_nonblank(research.get(field)) for field in ("area_id", "perspective_id")):
                    pair = (research["area_id"], research["perspective_id"])
                    if pair in research_pairs:
                        errors.append(prefix + ".research pair already has an unresolved attempt")
                    research_pairs.add(pair)
        if str(task.get("task_type")) not in VALID_TASK_TYPES:
            errors.append(prefix + ".task_type must be one of " + str(sorted(VALID_TASK_TYPES)))
        if str(task.get("risk")) not in VALID_RISKS:
            errors.append(prefix + ".risk must be one of " + str(sorted(VALID_RISKS)))
        if not isinstance(task.get("priority"), int):
            errors.append(prefix + ".priority must be an integer")
        if not isinstance(task.get("focus"), list):
            errors.append(prefix + ".focus must be a list")
        evidence = task.get("evidence")
        if not isinstance(evidence, dict):
            errors.append(prefix + ".evidence must be an object")
        else:
            if not str(evidence.get("source") or "").strip():
                errors.append(prefix + ".evidence.source is required")
            if not str(evidence.get("detail") or "").strip():
                errors.append(prefix + ".evidence.detail is required")
            # Missing fields belong to historical, still-unverified records.
            if "status" in evidence and evidence["status"] != "reported":
                errors.append(prefix + ".evidence.status must be reported; worker metadata is not proof")
            if "reproduction" in evidence:
                errors.extend(validate_reproduction(evidence["reproduction"], prefix + ".evidence.reproduction"))
        errors.extend(_validate_execution(task.get("execution"), prefix))
        execution = task.get("execution")
        if isinstance(execution, dict):
            if "research_detached" in execution and not valid_research_detachment(task):
                errors.append(prefix + ".execution.research_detached requires a pinned research attempt and UTC wait record")
            if "feedback_nudge" in execution:
                nudge = execution["feedback_nudge"]
                if (task.get("task_type") != "project_discovery"
                        or not _nonblank(execution.get("session_id"))
                        or not isinstance(nudge, dict)
                        or nudge.get("result") not in ("pending", "sent", "unknown", "rejected")
                        or not _utc_timestamp(nudge.get("at"))):
                    errors.append(prefix + ".execution.feedback_nudge requires a research session, UTC at and a durable result")
            if "rejection_stop" in execution:
                stop = execution["rejection_stop"]
                decision = task.get("proposal_decision") or {}
                if (decision.get("action") != "reject" or decision.get("status") not in ("pending", "completed")
                        or not isinstance(stop, dict) or not _utc_timestamp(stop.get("at"))
                        or stop.get("result") not in ("pending", "sent", "unknown", "rejected")):
                    errors.append(prefix + ".execution.rejection_stop requires a staged rejection and durable send receipt")
            state, outcome = execution.get("state"), execution.get("outcome", "")
            expected = {"dispatching": "in_progress", "dispatched": "in_progress",
                        "quarantined": "blocked", "completed": "done", "retry": "todo", "exhausted": "blocked"}
            decision = task.get("proposal_decision")
            human_closed = (isinstance(decision, dict) and decision.get("action") in ("reject", "resolve")
                            and not pending_rejection(task))
            if state in expected and status != expected[state] and not human_closed:
                errors.append(prefix + ".execution.state contradicts task status")
            if state in ("dispatching", "dispatched") and outcome:
                errors.append(prefix + ".active execution cannot have an outcome")
            if state == "dispatching" and (execution.get("session_id") or type(execution.get("attempts")) is not int or execution["attempts"] < 1):
                errors.append(prefix + ".dispatching requires one reserved unbound attempt")
            if state == "quarantined" and outcome != "stale":
                errors.append(prefix + ".quarantined execution requires stale outcome")
            source = (task.get("research_result") or {}).get("source") if isinstance(task.get("research_result"), dict) else None
            if isinstance(source, dict) and any(source.get(field) != execution.get(field) for field in ("session_id", "dispatch_key")):
                errors.append(prefix + ".research_result.source must belong to the stored attempt")
        origin = task.get("origin")
        if "review_context" in task or isinstance(origin, dict) and ("activity_id" in origin or "report_sha256" in origin):
            errors.extend(_validate_report_source(origin, prefix + ".origin"))
        if "review_context" in task:
            errors.extend(_validate_review_context(
                task["review_context"], tasks_by_id,
                origin.get("activity_created_at") if isinstance(origin, dict) else None,
                prefix + ".review_context"))
        errors.extend(_validate_research(task, prefix))
        errors.extend(validate_task_request(task, required=isinstance(policy, dict)
                                           and policy.get("research_contract") == CONTRACT_VERSION, prefix=prefix))
        errors.extend(_validate_discovery_import(task, task_ids, prefix))
        report = task.get("research_result")
        if isinstance(report, dict):
            report_source = report.get("source")
            report_time = report_source.get("activity_created_at") if isinstance(report_source, dict) else None
            receipt = task.get("discovery_import")
            import_result = receipt.get("result") if isinstance(receipt, dict) else None
            deferred_groups = [(".research_result", report.get("deferred_findings"))]
            if isinstance(import_result, dict):
                deferred_groups.append((".discovery_import", import_result.get("deferred")))
            for suffix, deferred in deferred_groups:
                if not isinstance(deferred, list):
                    continue
                for item_index, item in enumerate(deferred):
                    if isinstance(item, dict) and "review_context" in item:
                        errors.extend(_validate_review_context(
                            item["review_context"], tasks_by_id, report_time,
                            prefix + suffix + ".deferred[" + str(item_index) + "].review_context"))
        errors.extend(_validate_proposal(task, prefix))
    errors.extend(_validate_deferred_links(tasks_by_id))

    for discovery, count in lane_counts.items():
        if count > 1:
            lane = "research" if discovery else "implementation"
            errors.append("only one unresolved task may occupy the " + lane + " lane, found " + str(count))
    return errors


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print("ERROR: cannot read manifest: " + str(exc), file=sys.stderr)
        return 1
    errors = validate(manifest)
    if errors:
        for err in errors:
            print("ERROR: " + err, file=sys.stderr)
        return 1
    print("agent_tasks.json is valid (" + str(len(manifest.get("tasks", []))) + " task(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
