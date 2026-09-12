#!/usr/bin/env python3
"""Create (or reconcile) exactly one AI worker session for an autonomous task.

Talks to the Jules API (https://jules.googleapis.com/v1alpha). An idempotency
marker embedded in the request prompt lets repeated scheduler runs recognise
work they already started, so the loop does not pile up duplicate sessions.

Two behaviours matter for not repeating finished work:

* A **finished** session counts. Matching only active sessions means a worker
  that completed without opening a pull request looks like it never ran, and the
  next tick hands it the same task again. Here a terminal session reports
  ``already_completed`` so the caller can close the task out instead.
* The dispatch key must be **stable across runs**. It is derived from repo plus
  task id only - never from the branch head - because a moving base commit would
  change the key and duplicate work that is still in flight.

The API key ring rotates on an authentication failure, not just when the primary
key is absent, so a revoked key actually fails over to the backup. The HTTP
transport is injectable, so all of this is unit-testable offline.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

DEFAULT_API_BASE = "https://jules.googleapis.com/v1alpha"
TRANSIENT_STATUSES = {0, 408, 409, 429, 500, 502, 503, 504}
AUTH_STATUSES = {401, 403}
ACTIVE_STATES = {
    "", "UNKNOWN", "STATE_UNSPECIFIED", "QUEUED", "PLANNING", "IN_PROGRESS",
    "AWAITING_PLAN_APPROVAL", "AWAITING_USER_FEEDBACK",
}
MARKER_RE = re.compile(r"AUTONOMOUS_DISPATCH_KEY:\s*([A-Za-z0-9]+)")

RESULT_CREATED = "created"
RESULT_RECONCILED = "reconciled"
RESULT_ALREADY_COMPLETED = "already_completed"


class Response:
    def __init__(self, status: int, payload: Any = None, text: str = "") -> None:
        self.status = status
        self.payload = payload
        self.text = text


class KeyRing:
    """Holds the API keys in preference order and rotates on auth failure."""

    def __init__(self, keys: Sequence[str]) -> None:
        self.keys = [str(key) for key in keys if str(key or "").strip()]
        self.index = 0

    def __bool__(self) -> bool:
        return bool(self.keys)

    @property
    def current(self) -> str:
        return self.keys[self.index] if self.keys else ""

    def rotate(self) -> bool:
        if self.index + 1 < len(self.keys):
            self.index += 1
            return True
        return False


def extract_key(prompt: str) -> str:
    match = MARKER_RE.search(prompt or "")
    return match.group(1) if match else ""


def session_id(session: Mapping[str, Any]) -> str:
    value = str(session.get("id") or "")
    if value:
        return value
    return str(session.get("name") or "").rsplit("/", 1)[-1]


def session_state(session: Mapping[str, Any]) -> str:
    return str(session.get("state") or "UNKNOWN")


def session_is_active(session: Mapping[str, Any]) -> bool:
    return session_state(session).upper() in ACTIVE_STATES


def session_matches(session: Mapping[str, Any], key: str) -> bool:
    title = str(session.get("title") or "")
    prompt = str(session.get("prompt") or "")
    return ("[dispatch:" + key + "]") in title or ("AUTONOMOUS_DISPATCH_KEY: " + key) in prompt


def urllib_transport(method: str, url: str, headers: Mapping[str, str], payload: Any) -> Response:
    data = None
    request_headers = {"Accept": "application/json"}
    request_headers.update(dict(headers))
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw) if raw.strip() else None
            return Response(int(response.status), parsed, raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw) if raw.strip() else None
        except json.JSONDecodeError:
            parsed = None
        return Response(int(exc.code), parsed, raw)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return Response(0, None, str(exc))


def request_with_keys(transport: Callable, ring: KeyRing, method: str, url: str,
                      payload: Any = None) -> Response:
    while True:
        response = transport(method, url, {"X-Goog-Api-Key": ring.current}, payload)
        if response.status in AUTH_STATUSES and ring.rotate():
            continue
        return response


def list_sessions(transport: Callable, api_base: str, ring: KeyRing) -> list:
    response = request_with_keys(
        transport, ring, "GET", api_base.rstrip("/") + "/sessions?pageSize=100"
    )
    if response.status // 100 != 2:
        raise RuntimeError("Jules ListSessions failed: HTTP " + str(response.status))
    payload = response.payload or {}
    return list(payload.get("sessions") or [])


def find_matches(sessions, key: str) -> tuple:
    """Return (active_match, terminal_match) for the dispatch key."""
    matches = [
        s for s in sessions if isinstance(s, dict) and session_matches(s, key)
    ]
    matches.sort(
        key=lambda s: str(s.get("updateTime") or s.get("createTime") or ""), reverse=True
    )
    active = [s for s in matches if session_is_active(s)]
    terminal = [s for s in matches if not session_is_active(s)]
    return (active[0] if active else None), (terminal[0] if terminal else None)


def find_active_match(sessions, key: str):
    return find_matches(sessions, key)[0]


def _result(kind: str, session: Mapping[str, Any]) -> dict:
    return {
        "result": kind,
        "session_id": session_id(session),
        "session_state": session_state(session),
        "session": session,
    }


def dispatch(
    transport: Callable,
    *,
    api_base: str,
    api_keys: Sequence[str] | KeyRing,
    request_body: Mapping[str, Any],
    max_attempts: int = 3,
    base_delay: float = 3.0,
    sleeper: Callable = time.sleep,
) -> dict:
    ring = api_keys if isinstance(api_keys, KeyRing) else KeyRing(api_keys)
    if not ring:
        raise RuntimeError("no Jules API key is configured")

    key = extract_key(str(request_body.get("prompt") or ""))
    if not key:
        raise RuntimeError("request prompt is missing the AUTONOMOUS_DISPATCH_KEY marker")

    active, terminal = find_matches(list_sessions(transport, api_base, ring), key)
    if active:
        return _result(RESULT_RECONCILED, active)
    if terminal:
        # This exact task was already worked on and the session ended. Creating a
        # second session would re-run finished work; the caller closes the task.
        return _result(RESULT_ALREADY_COMPLETED, terminal)

    last_status = 0
    for attempt in range(1, max_attempts + 1):
        response = request_with_keys(
            transport, ring, "POST", api_base.rstrip("/") + "/sessions", dict(request_body)
        )
        last_status = response.status
        if response.status // 100 == 2 and isinstance(response.payload, dict):
            return _result(RESULT_CREATED, response.payload)
        active, terminal = find_matches(list_sessions(transport, api_base, ring), key)
        if active:
            return _result(RESULT_RECONCILED, active)
        if terminal:
            return _result(RESULT_ALREADY_COMPLETED, terminal)
        if response.status not in TRANSIENT_STATUSES:
            raise RuntimeError("Jules CreateSession failed: HTTP " + str(response.status))
        if attempt < max_attempts:
            sleeper(base_delay * attempt)
    raise RuntimeError(
        "Jules CreateSession did not succeed after " + str(max_attempts)
        + " attempt(s); last HTTP " + str(last_status)
    )


def _write_output(path: str, values: Mapping[str, Any]) -> None:
    if not path:
        return
    with Path(path).open("a", encoding="utf-8") as handle:
        for name, value in values.items():
            handle.write(str(name) + "=" + str(value) + "\n")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-body", required=True, type=Path)
    parser.add_argument("--response", type=Path, default=Path("jules-response.json"))
    parser.add_argument("--api-base", default=os.environ.get("JULES_API_BASE", DEFAULT_API_BASE))
    parser.add_argument("--github-output", default=os.environ.get("GITHUB_OUTPUT", ""))
    args = parser.parse_args(argv)

    ring = KeyRing([
        os.environ.get("JULES_API_KEY", ""),
        os.environ.get("JULES_API_KEY_BACKUP", ""),
    ])
    if not ring:
        print("ERROR: JULES_API_KEY (or JULES_API_KEY_BACKUP) is required", file=sys.stderr)
        return 1

    request_body = json.loads(args.request_body.read_text(encoding="utf-8"))
    try:
        result = dispatch(
            urllib_transport, api_base=args.api_base, api_keys=ring, request_body=request_body
        )
    except RuntimeError as exc:
        print("ERROR: " + str(exc), file=sys.stderr)
        return 1

    args.response.write_text(
        json.dumps(result.get("session") or {}, ensure_ascii=False), encoding="utf-8"
    )
    _write_output(args.github_output, {
        "dispatch_result": result["result"],
        "session_id": result["session_id"],
        "session_state": result["session_state"],
    })
    print(json.dumps(
        {k: result[k] for k in ("result", "session_id", "session_state")}, ensure_ascii=False
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
