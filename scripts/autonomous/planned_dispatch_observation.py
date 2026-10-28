#!/usr/bin/env python3
"""Observe an unreserved research identity; never bind, create or retire a ref."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

from build_jules_request import dispatch_key, next_attempt
from jules_dispatch import (DEFAULT_API_BASE, MARKER_RE, TITLE_MARKER_RE, KeyRing,
                            get_session, list_sessions, session_matches, session_resource,
                            urllib_transport)
from research_request import saved_request, sha256_json
from task_lifecycle import iso, utcnow


def _matches_anchor(session, anchor, request):
    execution = anchor["execution"]
    source = session.get("sourceContext") or {}
    context = source.get("githubRepoContext") if isinstance(source, dict) else None
    if not isinstance(source, dict) or not isinstance(context, dict):
        return False
    return (session.get("name") == session_resource(execution["session_id"])
            and session.get("id") == session_resource(execution["session_id"]).split("/", 1)[1]
            and session_matches(session, execution["dispatch_key"])
            and session.get("prompt") == request["prompt"]
            and session.get("title") == request["title"]
            and source.get("source") == request["sourceContext"]["source"]
            and context.get("startingBranch") == execution["starting_branch"])


def observe_planned_dispatch(task, anchor, repository, *, api_keys,
                             transport=urllib_transport, api_base=DEFAULT_API_BASE, now=None):
    """A missing result is meaningful only in each scope listing a known bound worker.

    Direct GetSession success alone does not establish ListSessions visibility.
    Results grant no worker, binding, queue or ref authority, even for absence.
    """
    if (not isinstance(task, dict) or task.get("task_type") != "project_discovery"
            or task.get("status") != "todo" or task.get("execution")
            or not isinstance(task.get("id"), str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", task["id"])
            or not isinstance(repository, str) or not re.fullmatch(r"[^/\s]+/[^/\s]+", repository)):
        raise ValueError("planned observation requires an unreserved research task")
    if (not isinstance(anchor, dict) or anchor.get("task_type") != "project_discovery"
            or not isinstance(anchor.get("execution"), dict)
            or not anchor["execution"].get("session_id") or not anchor["execution"].get("dispatch_key")):
        raise ValueError("planned observation requires a saved bound research anchor")
    request = saved_request(anchor)
    if (not isinstance(request, dict)
            or request["sourceContext"]["source"] != "sources/github/" + repository):
        raise ValueError("planned observation requires the immutable anchor request")
    moment = now if now is not None else utcnow()
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError("planned observation requires an aware timestamp")
    ring = api_keys if isinstance(api_keys, KeyRing) else KeyRing(api_keys)
    key = dispatch_key(repository, task["id"], next_attempt(task))
    branch = "autonomous/attempt-" + key
    scopes = []
    for index, credential in enumerate(dict.fromkeys(ring.keys), 1):
        row = {"credential_slot": index, "visibility_confirmed": False, "matching_sessions": []}

        def read_only(method, url, headers, payload):
            if method != "GET" or payload is not None:
                raise RuntimeError("planned observation permits GET only")
            return transport(method, url, headers, payload)

        try:
            scope = KeyRing([credential])
            sessions = list_sessions(read_only, api_base, scope)
            if any(not isinstance(session, dict) for session in sessions):
                raise ValueError("invalid provider inventory")
            anchors = [session for session in sessions
                       if session.get("name") == session_resource(anchor["execution"]["session_id"])]
            if len(anchors) != 1 or not _matches_anchor(anchors[0], anchor, request):
                row["reason"] = "bound_anchor_not_visible"
                scopes.append(row)
                continue
            current = get_session(read_only, api_base, scope, anchor["execution"]["session_id"])
            if not _matches_anchor(current, anchor, request):
                row["reason"] = "bound_anchor_identity_changed"
                scopes.append(row)
                continue
            row.update(visibility_confirmed=True, pagination_complete=True,
                       sessions_sha256=sha256_json(sessions), anchor_sha256=sha256_json(current))
            seen = set()
            for session in sessions:
                markers = set(MARKER_RE.findall(str(session.get("prompt") or "")))
                markers.update(TITLE_MARKER_RE.findall(str(session.get("title") or "")))
                if key not in markers:
                    continue
                identifier = str(session.get("id") or "")
                source = session.get("sourceContext") or {}
                context = source.get("githubRepoContext") if isinstance(source, dict) else None
                if (not identifier or identifier.startswith("sessions/")
                        or not isinstance(source, dict) or not isinstance(context, dict)
                        or session.get("name") != session_resource(identifier)
                        or not session_matches(session, key)
                        or source.get("source") != "sources/github/" + repository
                        or context.get("startingBranch") != branch
                        or set(re.findall(r"AUTONOMOUS_TASK_ID:[ \t]*([^\s<>`]+)",
                                          str(session.get("prompt") or ""))) != {task["id"]}
                        or identifier in seen
                        or not isinstance(session.get("state"), str)
                        or not re.fullmatch(r"[A-Z][A-Z0-9_]*", session["state"])):
                    raise ValueError("planned identity has a contradictory provider observation")
                seen.add(identifier)
                row["matching_sessions"].append({"session_id": identifier,
                    "session_state": session["state"],
                    "session_sha256": sha256_json(session)})
        except (ValueError, KeyError, TypeError, RuntimeError, OSError):
            row["visibility_confirmed"] = False
            row["reason"] = "provider_observation_unconfirmed"
        scopes.append(row)
    confirmed = bool(scopes) and all(scope["visibility_confirmed"] for scope in scopes)
    matches = sorted({session["session_id"] for scope in scopes for session in scope["matching_sessions"]})
    return {"outcome": "observed" if confirmed else "blocked", "method": "GET",
            "observed_at": iso(moment), "repository": repository, "task_id": task["id"],
            "attempts": next_attempt(task), "dispatch_key": key, "starting_branch": branch,
            "anchor_task_id": anchor["id"], "anchor_session_id": anchor["execution"]["session_id"],
            "presence": ("present" if matches else "absent") if confirmed else "unknown",
            "scopes": scopes, "live_mutations": 0}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--revision-file", required=True, type=Path)
    parser.add_argument("--decision-id", required=True)
    parser.add_argument("--expected-state-sha", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    control = Path(__file__).resolve().parents[2]
    out = args.out.resolve()
    if (out.is_relative_to(control) or out in {args.manifest.resolve(), args.revision_file.resolve()}):
        raise ValueError("planned observation output cannot overwrite sources or the queue")
    from dispatch_journal import _body, digest, materialize
    manifest = json.loads(args.manifest.read_bytes())
    state = materialize(manifest["dispatch_journal"])
    receipt = state["completions"].get(args.decision_id) or {}
    if (receipt.get("type") != "OwnerPartialNextCheckpointCompletion"
            or receipt.get("before_state_sha") != args.expected_state_sha
            or receipt.get("owner_trigger", {}).get("repository") != args.repository):
        raise ValueError("planned observation requires the acknowledged original partial closure")
    if digest(_body(manifest)) != receipt["evidence"]["native_body_sha256"]:
        raise ValueError("planned observation requires the unchanged native partial body")
    revision = json.loads(args.revision_file.read_bytes())
    if not re.fullmatch(r"[0-9a-f]{40}", str(revision.get("state_sha") or "")):
        raise ValueError("planned observation requires the acknowledged state revision")
    evidence = receipt["evidence"]["delta"]
    tasks = {task["id"]: task for task in manifest["tasks"]}
    result = observe_planned_dispatch(tasks[evidence["planned_task_id"]],
        tasks[evidence["polled_task_id"]], args.repository,
        api_keys=[os.environ.get("JULES_API_KEY", ""), os.environ.get("JULES_API_KEY_BACKUP", "")])
    result.update(decision_id=args.decision_id, receipt_id=receipt["receipt_id"],
                  state_sha=revision["state_sha"])
    from state_store import _atomic_bytes
    _atomic_bytes(out, (json.dumps(result, indent=2) + "\n").encode("utf-8"))
    print(json.dumps(result, indent=2))
    return 0 if result["outcome"] == "observed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
