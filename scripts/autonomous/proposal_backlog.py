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

from select_task import is_unresolved
from state_store import load_state, save_state
from validate_tasks import proposal_mutation_error, validate

ACTIONS = ("list", "approve", "reject", "resolve")


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
    if action not in ACTIONS[1:]:
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
    if reason:
        raise ValueError(reason)
    if action == "approve" and task.get("status") not in ("proposed", "todo"):
        raise ValueError("only a pending proposal can be approved; approval does not reset retry constraints")
    decision = {"action": action, "actor": actor,
                "at": now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "note": note.strip()}
    candidate = copy.deepcopy(task)
    candidate["proposal_decision"] = decision
    candidate["status"] = "todo" if action == "approve" else "done"
    errors = validate({**manifest, "tasks": [candidate if item is task else item for item in manifest["tasks"]]})
    if errors:
        raise ValueError("invalid proposal decision: " + "; ".join(errors))
    task.update(proposal_decision=decision, status=candidate["status"])
    return {"changed": True, "task_id": task_id, "decision": copy.deepcopy(decision)}


def review_state(task: dict) -> str:
    execution = task.get("execution") or {}
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
    tasks, hypotheses = [], []
    counts: dict[str, int] = {}
    for task in manifest.get("tasks", []):
        if task.get("task_type") == "project_discovery":
            result = task.get("research_result") or {}
            if result.get("deferred_findings") or result.get("next_hypotheses"):
                hypotheses.append({"task_id": task["id"], "source": copy.deepcopy(result.get("source")),
                                   "deferred_findings": copy.deepcopy(result.get("deferred_findings", [])),
                                   "next_hypotheses": copy.deepcopy(result.get("next_hypotheses", []))})
            continue
        state = review_state(task)
        counts[state] = counts.get(state, 0) + 1
        tasks.append({**copy.deepcopy(task), "review_state": state})
    return {"counts": counts, "tasks": tasks, "research_hypotheses": hypotheses}


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
                      "<pre>" + html.escape(json.dumps(view["research_hypotheses"], ensure_ascii=False, indent=2)) + "</pre>"])
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
