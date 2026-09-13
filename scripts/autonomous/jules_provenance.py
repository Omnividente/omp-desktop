#!/usr/bin/env python3
"""Controller receipts bind proposals to exact stored Jules attempts, not PR text."""
from __future__ import annotations

import re
from typing import Mapping

from jules_dispatch import session_id, session_is_active, session_matches, session_resource, session_state


def session_pull_request(session: Mapping, execution: Mapping, repository: str) -> int | None:
    stored = session_resource(str(execution.get("session_id") or ""))
    actual = session_resource(session_id(session))
    if actual != stored or session.get("name", actual) != actual:
        raise ValueError("session does not match the stored identity")
    if not session_matches(session, str(execution.get("dispatch_key") or "")):
        raise ValueError("session does not match the stored dispatch key")
    source = session.get("sourceContext") or {}
    if not isinstance(source, Mapping):
        raise ValueError("invalid session source context")
    if source.get("source") and source["source"] != "sources/github/" + repository:
        raise ValueError("session belongs to a foreign repository")
    context = source.get("githubRepoContext") or {}
    if not isinstance(context, Mapping):
        raise ValueError("invalid session repository context")
    actual_branch = context.get("startingBranch")
    expected_branch = execution.get("starting_branch")
    if actual_branch and expected_branch and actual_branch != expected_branch:
        raise ValueError("session belongs to a different starting branch")
    outputs = session.get("outputs") or []
    if not isinstance(outputs, list):
        raise ValueError("invalid session outputs")
    numbers = []
    for output in outputs:
        if not isinstance(output, Mapping):
            raise ValueError("invalid session output")
        if "pullRequest" not in output:
            continue
        proposal = output["pullRequest"]
        if not isinstance(proposal, Mapping):
            raise ValueError("invalid session pull request output")
        match = re.fullmatch(r"https://github\.com/" + re.escape(repository) + r"/pull/([1-9][0-9]*)", str(proposal.get("url") or ""))
        if not match:
            raise ValueError("session pull request URL is invalid or foreign")
        numbers.append(int(match.group(1)))
    if len(numbers) > 1:
        raise ValueError("ambiguous session pull request outputs")
    return numbers[0] if numbers else None


def _pull_request(pr: Mapping, repository: str, integration_branch: str) -> dict:
    number = pr.get("number")
    if type(number) is not int or number <= 0:
        raise ValueError("invalid pull request number")
    url = "https://github.com/" + repository + "/pull/" + str(number)
    base, head = pr.get("base"), pr.get("head")
    if not isinstance(base, Mapping) or not isinstance(head, Mapping):
        raise ValueError("pull request requires REST base and head identity")
    base_repo, head_repo = base.get("repo"), head.get("repo")
    if (pr.get("html_url") != url or not isinstance(base_repo, Mapping)
            or base_repo.get("full_name") != repository or base.get("ref") != integration_branch
            or not isinstance(head_repo, Mapping) or head_repo.get("full_name") != repository):
        raise ValueError("pull request belongs to a foreign repository or target")
    ref, sha = head.get("ref"), head.get("sha")
    if not isinstance(ref, str) or not ref.strip() or not re.fullmatch(r"[0-9a-fA-F]{40}", str(sha or "")):
        raise ValueError("invalid pull request head identity")
    return {"pull_request": number, "url": url, "repository": repository,
            "base_branch": integration_branch, "head_repository": repository,
            "head_ref": ref, "head_sha": sha}


def trusted_pull_request(task: Mapping, pr: Mapping, repository: str,
                         integration_branch: str = "autonomous/lab") -> bool:
    execution = task.get("execution") or {}
    receipt = execution.get("provenance")
    if not isinstance(receipt, Mapping) or not execution.get("session_id") or not execution.get("dispatch_key"):
        return False
    if any(receipt.get(field) != execution.get(field) for field in ("session_id", "dispatch_key", "pull_request")):
        return False
    try:
        current = _pull_request(pr, repository, integration_branch)
    except (ValueError, TypeError, AttributeError):
        return False
    return all(receipt.get(field) == value for field, value in current.items() if field != "head_sha")


def bind_proposal(manifest: dict, task_id: str, session: Mapping, pr: Mapping, *,
                  repository: str, integration_branch: str = "autonomous/lab", now=None) -> dict:
    from task_lifecycle import defer_review, find_task, iso, utcnow

    task = find_task(manifest, task_id)
    if task is None:
        raise ValueError("task not found")
    execution = task.get("execution") or {}
    number = session_pull_request(session, execution, repository)
    receipt = _pull_request(pr, repository, integration_branch)
    if number != receipt["pull_request"]:
        raise ValueError("pull request is not the exact session output")
    if execution.get("pull_request") not in (None, 0, number):
        raise ValueError("attempt already belongs to another pull request")
    if execution.get("provenance") and not trusted_pull_request(task, pr, repository, integration_branch):
        raise ValueError("pull request conflicts with the persisted provenance")
    if task.get("status") == "done":
        return {"changed": False, "reason": "task_already_closed", "task_id": task_id}
    receipt.update(session_id=execution["session_id"], dispatch_key=execution["dispatch_key"],
                   verified_at=iso(now or utcnow()))
    execution["provenance"] = receipt
    execution["pull_request"] = number
    execution["session_state"] = session_state(session)
    if not session_is_active(session):
        return defer_review(task, number)
    return {"changed": True, "reason": "proposal_bound", "task_id": task_id,
            "pull_request": number, "status": task.get("status")}
