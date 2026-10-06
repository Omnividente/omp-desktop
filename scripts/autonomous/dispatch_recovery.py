#!/usr/bin/env python3
"""Authenticate an existing reserved research session without creation or mutation.

Only identity/proof are safe to retain. The returned session is internal provider
material; the owner must bind it through task_lifecycle.start and its native CAS.
"""
from __future__ import annotations

import re

from build_jules_request import dispatch_key
from jules_dispatch import (DEFAULT_API_BASE, MARKER_RE, TITLE_MARKER_RE, KeyRing,
                            extract_key, get_session, list_sessions, session_matches,
                            session_resource, urllib_transport)
from research_request import CONTRACT_VERSION, saved_request, sha256_json
from task_lifecycle import iso, utcnow


def _session_identity(session: dict, request: dict, key: str) -> str:
    """Require actual provider fields, not the dispatcher's legacy fallbacks."""
    identifier = session.get("id")
    if not isinstance(identifier, str) or not identifier or identifier.startswith("sessions/"):
        raise RuntimeError("reserved Jules session is missing an exact ID")
    try:
        resource = session_resource(identifier)
    except ValueError:
        raise RuntimeError("reserved Jules session has an invalid ID") from None
    if session.get("name") != resource:
        raise RuntimeError("reserved Jules session ID and resource disagree")
    if (not session_matches(session, key)
            or session.get("prompt") != request["prompt"]
            or session.get("title") != request["title"]):
        raise RuntimeError("reserved Jules session does not match the saved prompt/title/markers")
    source = session.get("sourceContext")
    expected = request["sourceContext"]
    if not isinstance(source, dict) or source.get("source") != expected["source"]:
        raise RuntimeError("reserved Jules session has a missing or foreign source")
    context = source.get("githubRepoContext")
    if (not isinstance(context, dict)
            or context.get("startingBranch") != expected["githubRepoContext"]["startingBranch"]):
        raise RuntimeError("reserved Jules session has a missing or foreign starting branch")
    state = session.get("state")
    if not isinstance(state, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]*", state):
        raise RuntimeError("reserved Jules session is missing an actual provider state")
    return resource


def _session_hash(session: dict) -> str:
    try:
        return sha256_json(session)
    except (TypeError, ValueError):
        raise RuntimeError("reserved Jules session is not canonical JSON") from None


def observe_reserved_dispatch(task: dict, repository: str, *, api_keys,
                              transport=urllib_transport, api_base=DEFAULT_API_BASE,
                              now=None) -> dict:
    """Fail closed unless one original session survives authenticated list + get.

    No create authority is available. List/Get payloads must agree exactly, so a
    concurrent provider change requires another read-only observation, not a
    guessed binding. COMPLETED and FAILED remain the actual provider states;
    observing either does not complete the task or spend another attempt.
    """
    if (not isinstance(task, dict) or task.get("task_type") != "project_discovery"
            or task.get("status") != "in_progress"
            or not isinstance(task.get("id"), str) or not task["id"]
            or not isinstance(repository, str)
            or not re.fullmatch(r"[^/\s]+/[^/\s]+", repository)):
        raise ValueError("reserved dispatch requires an in-progress research task and repository")
    execution = task.get("execution")
    if (not isinstance(execution, dict) or execution.get("state") != "dispatching"
            or type(execution.get("attempts")) is not int or execution["attempts"] < 1
            or execution.get("session_id") != ""):
        raise ValueError("reserved dispatch requires an unbound original dispatching attempt")
    key = execution.get("dispatch_key")
    if key != dispatch_key(repository, task["id"], execution["attempts"]):
        raise ValueError("reserved dispatch key does not identify the original task/attempt")
    block = execution.get("research_request")
    if not isinstance(block, dict) or block.get("contract_version") != CONTRACT_VERSION:
        raise ValueError("reserved dispatch requires a versioned reproducible saved request")
    try:
        request = saved_request(task)
        request_hash = sha256_json(request)
        snapshot_hash = sha256_json(block)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise ValueError("reserved dispatch requires a valid saved research request") from None
    if (not isinstance(request, dict) or extract_key(request["prompt"]) != key
            or not session_matches(request, key)
            or request["sourceContext"]["source"] != "sources/github/" + repository
            or set(re.findall(r"AUTONOMOUS_TASK_ID:[ \t]*([^\s<>`]+)", request["prompt"])) != {task["id"]}):
        raise ValueError("saved request markers/source conflict with the original attempt")

    moment = now if now is not None else utcnow()
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError("reserved dispatch observation requires an aware timestamp")
    ring = api_keys if isinstance(api_keys, KeyRing) else KeyRing(api_keys)
    if not ring:
        raise RuntimeError("no Jules API key is configured")

    def read_only(method, url, headers, payload):
        if method != "GET" or payload is not None:
            raise RuntimeError("reserved dispatch observation permits GET only")
        try:
            return transport(method, url, headers, payload)
        except Exception:
            raise RuntimeError("reserved dispatch provider GET failed") from None

    matches = {}
    for session in list_sessions(read_only, api_base, ring):
        if not isinstance(session, dict):
            raise RuntimeError("Jules ListSessions contains an invalid session")
        # A contradictory marker containing our key is evidence to reject,
        # not permission to ignore the original session and create a new one.
        markers = set(MARKER_RE.findall(str(session.get("prompt") or "")))
        markers.update(TITLE_MARKER_RE.findall(str(session.get("title") or "")))
        if key not in markers:
            continue
        resource = _session_identity(session, request, key)
        digest = _session_hash(session)
        if resource in matches and matches[resource] != digest:
            raise RuntimeError("Jules ListSessions contains conflicting original session observations")
        matches[resource] = digest
    if not matches:
        raise RuntimeError("original reserved Jules session is missing; creation is forbidden")
    if len(matches) != 1:
        raise RuntimeError("multiple Jules sessions match the original reserved attempt")
    resource, listed_hash = next(iter(matches.items()))
    current = get_session(read_only, api_base, ring, resource)
    if _session_identity(current, request, key) != resource:
        raise RuntimeError("fresh Jules GetSession returned a different original resource")
    current_hash = _session_hash(current)
    if current_hash != listed_hash:
        raise RuntimeError("fresh Jules GetSession conflicts with the list observation")

    identity = {"task_id": task["id"], "attempts": execution["attempts"],
                "dispatch_key": key, "base_sha": execution["base_sha"],
                "starting_branch": execution["starting_branch"],
                "research_request_sha256": snapshot_hash}
    proof = {**identity, "kind": "reserved_dispatch_observation", "repository": repository,
             "provider": "jules", "method": "GET", "authenticated": True,
             "session_id": current["id"], "session_state": current["state"],
             "session_resource": resource, "request_sha256": request_hash,
             "session_sha256": current_hash, "list_session_sha256": listed_hash,
             "observed_at": iso(moment)}
    return {"identity": identity, "proof": proof, "session": current}
