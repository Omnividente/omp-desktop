#!/usr/bin/env python3
"""Review the authoritative proposal backlog without dispatching a worker.

Approval records intent only. Use Next Task with an explicit task_id to delegate
implementation, or implement outside Jules and resolve with a descriptive note.
"""
from __future__ import annotations

import argparse
import copy
import html
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from select_task import is_unresolved, pending_rejection
from research_disposition import acknowledged_disposition, research_incident, validate_research_disposition, _settled
from state_store import load_state, save_state
from task_lifecycle import quarantine, parse_iso, limits
from validate_tasks import POST_DEFERRED_REASONS, proposal_mutation_error, validate, validate_reproduction
from import_discovery_tasks import finding_error, _finding_profile, _finding_match, _closed_finding
from research_request import sha256_json

ACTIONS = ("list", "approve", "reject", "resolve", "close_research_unaccepted", "materialize_deferred")


def authorize(config: dict, actor: str) -> str:
    actor = actor.strip()
    gate = config.get("merge_gate") or {}
    owners = gate.get("owner_approvers", []) if isinstance(gate, dict) else []
    if (not actor or not isinstance(owners, list)
            or actor.casefold() not in {owner.casefold() for owner in owners if isinstance(owner, str) and owner.strip()}):
        raise ValueError("proposal decisions require a configured owner approver")
    return actor


def decide(manifest: dict, config: dict, *, action: str, task_id: str,
           actor: str, note: str, now: str | None = None) -> dict:
    """Apply one audited human decision, leaving all worker history untouched."""
    actor = authorize(config, actor)
    if action not in ("approve", "reject", "resolve"):
        raise ValueError("a decision must be approve, reject or resolve")
    if not note.strip():
        raise ValueError("a decision requires a nonblank note")
    errors = validate(manifest)
    if errors:
        raise ValueError("invalid queue: " + "; ".join(errors))
    task = next((item for item in manifest["tasks"] if item["id"] == task_id), None)
    if task is None:
        raise ValueError("unknown task_id")
    if task.get("task_type") == "project_discovery":
        raise ValueError("research sessions are not implementation proposals")
    prior = task.get("proposal_decision") or {}
    if prior.get("action") == action:
        if prior.get("actor", "").casefold() == actor.casefold() and prior.get("note") == note.strip():
            return {"changed": False, "task_id": task_id, "decision": copy.deepcopy(prior)}
        raise ValueError("the recorded action already exists; its audit record is immutable")
    if prior.get("action") in ("reject", "resolve") or task.get("status") == "done":
        raise ValueError("a closed proposal cannot be reopened or reclassified")
    reason = proposal_mutation_error(task)
    execution = task.get("execution") or {}
    stop_worker = (action == "reject" and reason and is_unresolved(task)
                   and execution.get("session_id") and execution.get("dispatch_key")
                   and execution.get("attempts", 0) > 0 and not execution.get("pull_request")
                   and execution.get("state") in ("dispatched", "quarantined"))
    if reason and not stop_worker:
        raise ValueError(reason)
    if action == "approve" and task.get("status") not in ("proposed", "todo"):
        raise ValueError("only a pending proposal can be approved; approval does not reset retry constraints")
    decision = {"action": action, "actor": actor,
                "at": now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "note": note.strip()}
    candidate = copy.deepcopy(task)
    candidate["proposal_decision"] = decision
    candidate["status"] = "todo" if action == "approve" else "done"
    if stop_worker:
        decision.update(status="pending", session_id=execution["session_id"],
                        dispatch_key=execution["dispatch_key"])
        candidate["status"] = task["status"]
        quarantine({"tasks": [candidate]}, task_id, reason="owner rejection awaiting worker termination",
                   now=parse_iso(decision["at"]))
    errors = validate({**manifest, "tasks": [candidate if item is task else item for item in manifest["tasks"]]})
    if errors:
        raise ValueError("invalid proposal decision: " + "; ".join(errors))
    task.update(candidate)
    return {"changed": True, "task_id": task_id, "decision": copy.deepcopy(decision)}


def close_research_unaccepted(manifest: dict, config: dict, *, task_id: str,
                              actor: str, note: str, now: str | None = None) -> dict:
    """Acknowledge one settled incident without rewriting machine outcomes or evidence."""
    actor = authorize(config, actor)
    if not note.strip():
        raise ValueError("a research disposition requires a nonblank note")
    errors = validate(manifest)
    if errors:
        raise ValueError("invalid queue: " + "; ".join(errors))
    task = next((item for item in manifest["tasks"] if item["id"] == task_id), None)
    if task is None:
        raise ValueError("unknown task_id")
    if not _settled(task):
        raise ValueError("only a settled bound unaccepted research incident can be closed")
    execution = task["execution"]
    if execution["state"] == "exhausted" and execution["attempts"] < limits(manifest)[0]:
        raise ValueError("research retry attempts are not exhausted")
    if "research_disposition" in task:
        prior = acknowledged_disposition(task)
        if (prior is not None and prior["actor"].casefold() == actor.casefold()
                and prior["note"] == note.strip()):
            return {"changed": False, "task_id": task_id, "disposition": prior}
        raise ValueError("the research disposition is immutable; the current incident requires attention")
    event = {"action": "close_unaccepted", "actor": actor,
             "at": now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "note": note.strip(), **research_incident(task)}
    candidate = copy.deepcopy(task)
    candidate["research_disposition"] = {"events": [event]}
    errors = validate_research_disposition(candidate, "task")
    errors.extend(validate({**manifest, "tasks": [candidate if item is task else item for item in manifest["tasks"]]}))
    if errors:
        raise ValueError("invalid research disposition: " + "; ".join(errors))
    task.update(candidate)
    return {"changed": True, "task_id": task_id, "disposition": copy.deepcopy(event)}


def materialize_deferred(manifest: dict, config: dict, *, source_task_id: str,
                         deferred_id: str, actor: str, note: str, now: str | None = None) -> dict:
    """Authorize one preserved claim as proposed only, without accepting its truth."""
    actor = authorize(config, actor)
    if not isinstance(note, str) or not note.strip():
        raise ValueError("materialization requires a nonblank owner note")
    note = note.strip()
    errors = validate(manifest)
    if errors:
        raise ValueError("invalid queue: " + "; ".join(errors))
    source = next((task for task in manifest["tasks"] if task["id"] == source_task_id), None)
    if source is None or source.get("task_type") != "project_discovery":
        raise ValueError("unknown accepted research source_task_id")
    report, receipt = source.get("research_result"), source.get("discovery_import")
    if (source.get("status") != "done" or (source.get("execution") or {}).get("state") != "completed"
            or not isinstance(report, dict) or not isinstance(receipt, dict)
            or receipt.get("source") != report.get("source")):
        raise ValueError("materialization requires an accepted report and immutable import receipt")
    item = next((item for item in receipt["result"]["deferred"]
                 if item.get("deferred_id") == deferred_id), None)
    if item is None or item.get("reason") not in POST_DEFERRED_REASONS:
        raise ValueError("deferred_id must identify a POST exclusion from this exact source")
    prior = next((event for event in source.get("deferred_materializations", [])
                  if event["deferred_id"] == deferred_id), None)
    if prior:
        if prior["actor"].casefold() == actor.casefold() and prior["note"] == note:
            return {"changed": False, "task_id": prior["proposal_id"], "materialization": copy.deepcopy(prior)}
        raise ValueError("the materialization authorization is immutable")
    candidate = copy.deepcopy(item["candidate"])
    reason = finding_error(candidate, config)
    if reason or validate_reproduction(candidate["evidence"].get("reproduction")):
        raise ValueError("deferred candidate is no longer admissible: " + (reason or "invalid reproduction"))
    profile = _finding_profile(candidate)
    for task in manifest["tasks"]:
        if task.get("task_type") == "project_discovery" or _closed_finding(task):
            continue
        if (_finding_match(profile, _finding_profile(task))
                or task["title"].strip().lower() == candidate["title"].strip().lower()):
            raise ValueError("deferred candidate overlaps open canonical task " + task["id"])
    proposal_id = "discovery-" + sha256_json({"source": item["source"], "deferred_id": deferred_id})
    if any(task["id"] == proposal_id for task in manifest["tasks"]):
        raise ValueError("deterministic proposal id already exists without its authorization")
    event = {"deferred_id": deferred_id, "proposal_id": proposal_id, "actor": actor,
             "at": now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "note": note}
    candidate.update(id=proposal_id, status="proposed", created_at=event["at"],
                     origin=copy.deepcopy(item["source"]), review_context=copy.deepcopy(item["review_context"]),
                     materialized_from={"source_task_id": source_task_id,
                                        **{key: event[key] for key in ("deferred_id", "actor", "at", "note")}})
    staged_source = {**source, "deferred_materializations": [*source.get("deferred_materializations", []), event]}
    staged = {**manifest, "tasks": [staged_source if task is source else task for task in manifest["tasks"]] + [candidate]}
    errors = validate(staged)
    if errors:
        raise ValueError("invalid materialization: " + "; ".join(errors))
    source["deferred_materializations"] = staged_source["deferred_materializations"]
    manifest["tasks"].append(candidate)
    return {"changed": True, "task_id": proposal_id, "materialization": copy.deepcopy(event)}


def review_state(task: dict) -> str:
    execution = task.get("execution") or {}
    if pending_rejection(task):
        return "rejecting"
    if is_unresolved(task):
        return "active"
    if execution.get("state") in ("awaiting_review", "awaiting_report"):
        return "awaiting_review"
    action = (task.get("proposal_decision") or {}).get("action")
    if action in ("reject", "resolve"):
        return {"reject": "rejected", "resolve": "resolved"}[action]
    if task.get("status") == "done":
        return "completed"
    if action == "approve":
        return "approved"
    if task.get("status") in ("proposed", "todo"):
        return "pending"
    return "blocked"


def backlog(manifest: dict) -> dict:
    """List every proposal and preserved research hypothesis, without a cap."""
    tasks, hypotheses, dispositions = [], [], []
    counts: dict[str, int] = {}
    for task in manifest.get("tasks", []):
        if task.get("task_type") == "project_discovery":
            if "research_disposition" in task:
                dispositions.append({"task_id": task["id"],
                                     "research_disposition": copy.deepcopy(task["research_disposition"]),
                                     "acknowledged": acknowledged_disposition(task) is not None})
            result = task.get("research_result") or {}
            if result.get("deferred_findings") or result.get("next_hypotheses"):
                hypotheses.append({"task_id": task["id"], "source": copy.deepcopy(result.get("source")),
                                   "deferred_findings": copy.deepcopy(result.get("deferred_findings", [])),
                                   "deferred_materializations": copy.deepcopy(task.get("deferred_materializations", [])),
                                   "next_hypotheses": copy.deepcopy(result.get("next_hypotheses", []))})
            continue
        state = review_state(task)
        counts[state] = counts.get(state, 0) + 1
        tasks.append({**copy.deepcopy(task), "review_state": state})
    return {"counts": counts, "tasks": tasks, "research_hypotheses": hypotheses,
            "research_dispositions": dispositions}


def render_summary(view: dict) -> str:
    """Escape worker-owned text, including HTML, fences and Markdown links."""
    lines = ["## Proposal backlog", "",
             "Approval only records a decision; it does not dispatch Jules. Choose an explicit task_id in Next Task, "
             "or implement externally and resolve with a note.", "",
             "<p>" + html.escape(", ".join(state + ": " + str(count) for state, count in sorted(view["counts"].items())) or "No proposals") + "</p>"]
    for task in view["tasks"]:
        label = task["review_state"] + " | " + task["id"] + " | " + task["title"]
        lines.extend(["", "<details><summary>" + html.escape(label) + "</summary>", "",
                      "<pre>" + html.escape(json.dumps(task, ensure_ascii=False, indent=2)) + "</pre>",
                      "</details>"])
    if view["research_hypotheses"]:
        lines.extend(["", "### Deferred findings and research hypotheses", "",
                      "These are preserved observations, not approved implementation tasks.", "",
                      "For a POST exclusion choose materialize_deferred with its exact task_id as source_task_id, "
                      "deferred_id and an owner note. This creates a proposed task only.", "",
                      "<pre>" + html.escape(json.dumps(view["research_hypotheses"], ensure_ascii=False, indent=2)) + "</pre>"])
    if view["research_dispositions"]:
        lines.extend(["", "### Research dispositions", "",
                      "Owner acknowledgements preserve failed or invalid machine outcomes; they do not accept reports.", "",
                      "<pre>" + html.escape(json.dumps(view["research_dispositions"], ensure_ascii=False, indent=2)) + "</pre>"])
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=ACTIONS, default="list")
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--revision-file", required=True, type=Path)
    parser.add_argument("--actor", required=True)
    parser.add_argument("--task-id", default="")
    parser.add_argument("--source-task-id", default="")
    parser.add_argument("--deferred-id", default="")
    parser.add_argument("--note", default="")
    parser.add_argument("--json-out", required=True, type=Path)
    parser.add_argument("--summary-out", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        actor = authorize(config, args.actor)
        if "GITHUB_ACTOR" in os.environ and actor.casefold() != os.environ["GITHUB_ACTOR"].casefold():
            raise ValueError("--actor must match GITHUB_ACTOR")
        data = load_state(args.repo, args.manifest, args.revision_file)
        result = {"changed": False, "action": args.action}
        if args.action != "list":
            if args.action == "materialize_deferred":
                result.update(materialize_deferred(data, config, source_task_id=args.source_task_id,
                                                  deferred_id=args.deferred_id, actor=actor, note=args.note))
            elif args.action == "close_research_unaccepted":
                result.update(close_research_unaccepted(data, config, task_id=args.task_id,
                                                       actor=actor, note=args.note))
            else:
                result.update(decide(data, config, action=args.action, task_id=args.task_id,
                                     actor=actor, note=args.note))
            if result["changed"]:
                args.manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                result["state_sha"] = save_state(args.repo, args.manifest, args.revision_file)
        view = backlog(data)
        view["operation"] = result
        view["state_revision"] = json.loads(args.revision_file.read_text(encoding="utf-8"))
        args.json_out.write_text(json.dumps(view, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        args.summary_out.write_text(render_summary(view), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        print("Backlog review failed: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
