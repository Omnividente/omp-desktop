#!/usr/bin/env python3
"""Create (or reconcile) exactly one Jules session for an autonomous task.

Talks to the Jules API (https://jules.googleapis.com/v1alpha). An idempotency
marker embedded in the request prompt lets repeated scheduler runs reconcile an
already-running session instead of creating duplicates. The HTTP transport is
injectable so the logic is unit-testable offline.
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
from typing import Any, Callable, Mapping

DEFAULT_API_BASE = "https://jules.googleapis.com/v1alpha"
TRANSIENT_STATUSES = {0, 408, 409, 429, 500, 502, 503, 504}
ACTIVE_STATES = {
    "", "UNKNOWN", "STATE_UNSPECIFIED", "QUEUED", "PLANNING", "IN_PROGRESS",
    "AWAITING_PLAN_APPROVAL", "AWAITING_USER_FEEDBACK",
}
MARKER_RE = re.compile(r"AUTONOMOUS_DISPATCH_KEY:\s*([A-Za-z0-9]+)")


class Response:
    def __init__(self, status: int, payload: Any = None, text: str = "") -> None:
        self.status = status
        self.payload = payload
        self.text = text


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


def list_sessions(transport: Callable, api_base: str, api_key: str) -> list:
    response = transport(
        "GET", api_base.rstrip("/") + "/sessions?pageSize=100",
        {"X-Goog-Api-Key": api_key}, None,
    )
    if response.status // 100 != 2:
        raise RuntimeError("Jules ListSessions failed: HTTP " + str(response.status))
    payload = response.payload or {}
    return list(payload.get("sessions") or [])


def find_active_match(sessions, key: str):
    matches = [
        s for s in sessions
        if isinstance(s, dict) and session_matches(s, key) and session_is_active(s)
    ]
    matches.sort(key=lambda s: str(s.get("updateTime") or s.get("createTime") or ""), reverse=True)
    return matches[0] if matches else None


def dispatch(
    transport: Callable,
    *,
    api_base: str,
    api_key: str,
    request_body: Mapping[str, Any],
    max_attempts: int = 3,
    base_delay: float = 3.0,
    sleeper: Callable = time.sleep,
) -> dict:
    key = extract_key(str(request_body.get("prompt") or ""))
    if not key:
        raise RuntimeError("request prompt is missing the AUTONOMOUS_DISPATCH_KEY marker")

    existing = find_active_match(list_sessions(transport, api_base, api_key), key)
    if existing:
        return {
            "result": "reconciled", "session_id": session_id(existing),
            "session_state": session_state(existing), "session": existing,
        }

    last_status = 0
    for attempt in range(1, max_attempts + 1):
        response = transport(
            "POST", api_base.rstrip("/") + "/sessions",
            {"X-Goog-Api-Key": api_key}, dict(request_body),
        )
        last_status = response.status
        if response.status // 100 == 2 and isinstance(response.payload, dict):
            session = response.payload
            return {
                "result": "created", "session_id": session_id(session),
                "session_state": session_state(session), "session": session,
            }
        match = find_active_match(list_sessions(transport, api_base, api_key), key)
        if match:
            return {
                "result": "reconciled", "session_id": session_id(match),
                "session_state": session_state(match), "session": match,
            }
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

    api_key = os.environ.get("JULES_API_KEY", "") or os.environ.get("JULES_API_KEY_BACKUP", "")
    if not api_key:
        print("ERROR: JULES_API_KEY (or JULES_API_KEY_BACKUP) is required", file=sys.stderr)
        return 1

    request_body = json.loads(args.request_body.read_text(encoding="utf-8"))
    try:
        result = dispatch(
            urllib_transport, api_base=args.api_base, api_key=api_key, request_body=request_body
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
