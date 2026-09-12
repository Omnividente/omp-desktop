#!/usr/bin/env python3
"""Tests for jules_dispatch.py using an injected fake transport."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jules_dispatch import (  # noqa: E402
    RESULT_ALREADY_COMPLETED, RESULT_CREATED, RESULT_RECONCILED, KeyRing, Response,
    dispatch, extract_key, find_matches, session_is_active,
)

KEY = "deadbeefcafe0001"
REQUEST = {
    "prompt": "AUTONOMOUS_DISPATCH_KEY: " + KEY + "\nAUTONOMOUS_TASK_ID: auto-1\n\nwork",
    "title": "[dispatch:" + KEY + "] fix clock",
}


def session(state: str, **overrides) -> dict:
    base = {
        "name": "sessions/555",
        "state": state,
        "title": "[dispatch:" + KEY + "] fix clock",
        "prompt": REQUEST["prompt"],
        "updateTime": "2026-09-12T10:00:00Z",
    }
    base.update(overrides)
    return base


class FakeTransport:
    """Replays scripted responses and records the keys actually used."""

    def __init__(self, list_responses, create_responses=None):
        self.list_responses = list(list_responses)
        self.create_responses = list(create_responses or [])
        self.calls = []
        self.keys_used = []

    def __call__(self, method, url, headers, payload):
        self.calls.append((method, url))
        self.keys_used.append(headers.get("X-Goog-Api-Key"))
        if method == "GET":
            return self.list_responses.pop(0) if self.list_responses else Response(200, {})
        return self.create_responses.pop(0) if self.create_responses else Response(500, None)


def sessions_response(*items) -> Response:
    return Response(200, {"sessions": list(items)})


def run(transport, keys=("primary",), **kwargs):
    return dispatch(
        transport, api_base="https://example.test/v1alpha", api_keys=keys,
        request_body=REQUEST, sleeper=lambda _seconds: None, **kwargs
    )


class CreateTest(unittest.TestCase):
    def test_new_task_creates_one_session(self):
        transport = FakeTransport(
            [sessions_response()], [Response(200, session("QUEUED"))]
        )
        result = run(transport)
        self.assertEqual(result["result"], RESULT_CREATED)
        self.assertEqual(result["session_id"], "555")

    def test_transient_failure_is_retried(self):
        transport = FakeTransport(
            [sessions_response(), sessions_response()],
            [Response(429, None), Response(200, session("QUEUED"))],
        )
        self.assertEqual(run(transport)["result"], RESULT_CREATED)

    def test_permanent_failure_raises(self):
        transport = FakeTransport([sessions_response()], [Response(400, None)])
        with self.assertRaises(RuntimeError):
            run(transport)

    def test_exhausted_retries_raise(self):
        transport = FakeTransport(
            [sessions_response()] * 6, [Response(503, None)] * 3
        )
        with self.assertRaises(RuntimeError):
            run(transport)


class ReconcileTest(unittest.TestCase):
    def test_active_session_is_reused_instead_of_duplicated(self):
        transport = FakeTransport([sessions_response(session("IN_PROGRESS"))])
        result = run(transport)
        self.assertEqual(result["result"], RESULT_RECONCILED)
        self.assertEqual(result["session_id"], "555")
        self.assertNotIn("POST", [method for method, _url in transport.calls])

    def test_completed_session_is_not_run_again(self):
        """Reported defect: a finished session was ignored and a new one created."""
        transport = FakeTransport([sessions_response(session("COMPLETED"))])
        result = run(transport)
        self.assertEqual(result["result"], RESULT_ALREADY_COMPLETED)
        self.assertEqual(result["session_state"], "COMPLETED")
        self.assertNotIn("POST", [method for method, _url in transport.calls])

    def test_failed_session_also_counts_as_finished(self):
        transport = FakeTransport([sessions_response(session("FAILED"))])
        self.assertEqual(run(transport)["result"], RESULT_ALREADY_COMPLETED)

    def test_active_session_wins_over_an_older_finished_one(self):
        transport = FakeTransport([sessions_response(
            session("COMPLETED", name="sessions/1", updateTime="2026-09-11T10:00:00Z"),
            session("IN_PROGRESS", name="sessions/2", updateTime="2026-09-12T10:00:00Z"),
        )])
        result = run(transport)
        self.assertEqual(result["result"], RESULT_RECONCILED)
        self.assertEqual(result["session_id"], "2")

    def test_unrelated_sessions_are_ignored(self):
        other = session("IN_PROGRESS", title="[dispatch:other] thing", prompt="nope")
        transport = FakeTransport(
            [sessions_response(other)], [Response(200, session("QUEUED"))]
        )
        self.assertEqual(run(transport)["result"], RESULT_CREATED)

    def test_race_creating_a_duplicate_is_reconciled(self):
        transport = FakeTransport(
            [sessions_response(), sessions_response(session("IN_PROGRESS"))],
            [Response(409, None)],
        )
        self.assertEqual(run(transport)["result"], RESULT_RECONCILED)


class KeyRingTest(unittest.TestCase):
    """Reported limitation: the backup key was used only if the primary was absent."""

    def test_revoked_primary_key_fails_over_to_the_backup(self):
        transport = FakeTransport(
            [Response(401, None), sessions_response()],
            [Response(200, session("QUEUED"))],
        )
        result = run(transport, keys=("primary", "backup"))
        self.assertEqual(result["result"], RESULT_CREATED)
        self.assertIn("backup", transport.keys_used)

    def test_forbidden_also_triggers_failover(self):
        transport = FakeTransport(
            [Response(403, None), sessions_response()],
            [Response(200, session("QUEUED"))],
        )
        self.assertEqual(run(transport, keys=("primary", "backup"))["result"], RESULT_CREATED)

    def test_a_single_key_does_not_loop_forever(self):
        transport = FakeTransport([Response(401, None)])
        with self.assertRaises(RuntimeError):
            run(transport, keys=("only",))

    def test_ring_rotation_stops_at_the_last_key(self):
        ring = KeyRing(["a", "b"])
        self.assertEqual(ring.current, "a")
        self.assertTrue(ring.rotate())
        self.assertEqual(ring.current, "b")
        self.assertFalse(ring.rotate())

    def test_blank_keys_are_dropped(self):
        self.assertEqual(KeyRing(["", "  ", "real"]).keys, ["real"])

    def test_no_key_at_all_is_an_error(self):
        with self.assertRaises(RuntimeError):
            dispatch(
                FakeTransport([]), api_base="https://example.test", api_keys=[],
                request_body=REQUEST,
            )


class MarkerTest(unittest.TestCase):
    def test_key_is_read_from_the_prompt(self):
        self.assertEqual(extract_key(REQUEST["prompt"]), KEY)

    def test_request_without_a_marker_is_refused(self):
        with self.assertRaises(RuntimeError):
            dispatch(
                FakeTransport([sessions_response()]), api_base="https://example.test",
                api_keys=["k"], request_body={"prompt": "no marker here"},
            )

    def test_unknown_state_is_treated_as_active(self):
        self.assertTrue(session_is_active({"state": "UNKNOWN"}))
        self.assertTrue(session_is_active({}))
        self.assertFalse(session_is_active({"state": "COMPLETED"}))

    def test_find_matches_separates_active_from_finished(self):
        active, terminal = find_matches(
            [session("IN_PROGRESS", name="sessions/1"), session("COMPLETED", name="sessions/2")],
            KEY,
        )
        self.assertIsNotNone(active)
        self.assertIsNotNone(terminal)


if __name__ == "__main__":
    unittest.main(verbosity=2)
