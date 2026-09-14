#!/usr/bin/env python3
"""Tests for jules_dispatch.py using an injected fake transport."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jules_dispatch import (  # noqa: E402
    RESULT_ALREADY_COMPLETED, RESULT_ALREADY_FAILED, RESULT_CREATED, RESULT_RECONCILED,
    CreateRejected, Response, dispatch,
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

    def test_ambiguous_create_is_reconciled_read_only_even_when_replayed(self):
        transport = FakeTransport([sessions_response()] * 3,
                                  [Response(0), Response(200, session("QUEUED"))])
        self.assertEqual(run(transport)["result"], "deferred")
        self.assertEqual(run(transport, allow_create=False)["result"], "deferred")
        self.assertEqual([method for method, _ in transport.calls].count("POST"), 1)

    def test_definite_create_rejection_exposes_status_without_upstream_secrets(self):
        for status in (400, 401, 403, 422):
            with self.subTest(status=status):
                transport = FakeTransport([sessions_response()],
                                          [Response(status, {"message": "PRIVATE_BODY"}, text="PRIVATE_BODY")])
                with self.assertRaises(CreateRejected) as caught:
                    run(transport)
                self.assertEqual(caught.exception.status, status)
                self.assertNotIn("PRIVATE_BODY", str(caught.exception))
                self.assertEqual([method for method, _ in transport.calls], ["GET", "POST"])

    def test_uncertain_create_failure_does_not_spend_another_post(self):
        for status in (0, 200, 408, 409, 429, 500, 501, 503):
            with self.subTest(status=status):
                transport = FakeTransport([sessions_response()] * 2, [Response(status)])
                self.assertEqual(run(transport)["result"], "deferred")
                self.assertEqual([method for method, _ in transport.calls].count("POST"), 1)


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

    def test_a_failed_session_is_reported_as_failed_not_completed(self):
        """Reported defect: a dead session was reported as 'already_completed',
        so the queue recorded a success and closed the task as done."""
        transport = FakeTransport([sessions_response(session("FAILED"))])
        result = run(transport)
        self.assertEqual(result["result"], RESULT_ALREADY_FAILED)
        self.assertEqual(result["session_state"], "FAILED")
        self.assertNotEqual(result["result"], RESULT_ALREADY_COMPLETED)

    def test_multiple_matching_sessions_require_attention_not_list_order(self):
        transport = FakeTransport([sessions_response(
            session("COMPLETED", name="sessions/1"), session("IN_PROGRESS", name="sessions/2"))])
        with self.assertRaises(RuntimeError):
            run(transport)
        self.assertNotIn("POST", [method for method, _ in transport.calls])

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

    def test_stored_completed_session_is_read_without_creating_a_replacement(self):
        transport = FakeTransport([Response(200, session("COMPLETED"))])
        result = run(transport, stored_session="555")
        self.assertEqual(result["result"], RESULT_ALREADY_COMPLETED)
        self.assertEqual(result["session_id"], "555")
        self.assertNotIn("POST", [method for method, _url in transport.calls])

    def test_missing_stored_session_does_not_restart_research(self):
        transport = FakeTransport([Response(404)], [Response(200, session("QUEUED"))])
        with self.assertRaises(RuntimeError):
            run(transport, stored_session="555")
        self.assertNotIn("POST", [method for method, _url in transport.calls])

    def test_stored_session_with_wrong_identity_or_dispatch_is_rejected(self):
        for current in (session("COMPLETED", name="sessions/other"),
                        session("COMPLETED", title="[dispatch:other]", prompt="")):
            with self.subTest(current=current):
                transport = FakeTransport([Response(200, current)])
                with self.assertRaises(RuntimeError):
                    run(transport, stored_session="555")
                self.assertNotIn("POST", [method for method, _url in transport.calls])

    def test_known_session_transient_exhaustion_never_creates_replacement(self):
        transport = FakeTransport([Response(503)] * 3)
        with self.assertRaises(RuntimeError):
            run(transport, stored_session="555")
        self.assertEqual([method for method, _ in transport.calls], ["GET"] * 3)
        self.assertTrue(all(url.endswith("/sessions/555") for _, url in transport.calls))

    def test_retry_after_and_auth_rotation_recover_exact_session(self):
        transport = FakeTransport([Response(429, headers={"Retry-After": "7"}),
                                   Response(401), Response(200, session("COMPLETED"))])
        delays = []
        result = dispatch(transport, api_base="https://example.test", api_keys=["primary", "backup"],
                          request_body=REQUEST, stored_session="555", sleeper=delays.append)
        self.assertEqual(result["result"], RESULT_ALREADY_COMPLETED)
        self.assertEqual(delays, [7.0])
        self.assertEqual(transport.keys_used, ["primary", "primary", "backup"])


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

    def test_no_key_at_all_is_an_error(self):
        with self.assertRaises(RuntimeError):
            dispatch(
                FakeTransport([]), api_base="https://example.test", api_keys=[],
                request_body=REQUEST,
            )


class MarkerTest(unittest.TestCase):
    def test_request_without_a_marker_is_refused(self):
        with self.assertRaises(RuntimeError):
            dispatch(
                FakeTransport([sessions_response()]), api_base="https://example.test",
                api_keys=["k"], request_body={"prompt": "no marker here"},
            )

    def test_new_api_state_is_not_reported_as_a_success(self):
        transport = FakeTransport([sessions_response(session("PAUSED"))])
        self.assertEqual(run(transport)["result"], RESULT_RECONCILED)
        self.assertNotIn("POST", [method for method, _url in transport.calls])

    def test_prompt_marker_prefix_does_not_reconcile_another_attempt(self):
        other = session("COMPLETED", title="fix", prompt="AUTONOMOUS_DISPATCH_KEY: " + KEY + "longer")
        transport = FakeTransport([sessions_response(other)], [Response(200, session("QUEUED"))])
        self.assertEqual(run(transport)["result"], RESULT_CREATED)

    def test_conflicting_session_markers_do_not_reconcile_another_task(self):
        other = session("COMPLETED", title="[dispatch:other]")
        transport = FakeTransport([sessions_response(other)], [Response(200, session("QUEUED"))])
        self.assertEqual(run(transport)["result"], RESULT_CREATED)

    def test_conflicting_request_markers_fail_before_creating_work(self):
        transport = FakeTransport([])
        with self.assertRaises(RuntimeError):
            dispatch(transport, api_base="https://example.test", api_keys=["k"],
                     request_body={**REQUEST, "title": "[dispatch:other]"})
        self.assertEqual(transport.calls, [])


class PaginationTest(unittest.TestCase):
    def test_matching_session_beyond_first_page_prevents_duplicate_dispatch(self):
        transport = FakeTransport([
            Response(200, {"sessions": [], "nextPageToken": "next+/="}),
            sessions_response(session("COMPLETED")),
        ])
        self.assertEqual(run(transport)["result"], RESULT_ALREADY_COMPLETED)
        self.assertNotIn("POST", [method for method, _url in transport.calls])
        self.assertIn("pageToken=next%2B%2F%3D", transport.calls[1][1])

    def test_repeated_page_token_aborts_without_creating_duplicate_work(self):
        page = Response(200, {"sessions": [], "nextPageToken": "same"})
        transport = FakeTransport([page, page])
        with self.assertRaises(RuntimeError):
            run(transport)
        self.assertNotIn("POST", [method for method, _url in transport.calls])

    def test_failed_later_page_does_not_mean_no_matching_session(self):
        transport = FakeTransport([
            Response(200, {"sessions": [], "nextPageToken": "next"}), *([Response(503, None)] * 3),
        ])
        with self.assertRaises(RuntimeError):
            run(transport)
        self.assertNotIn("POST", [method for method, _url in transport.calls])

    def test_malformed_session_list_is_not_treated_as_empty(self):
        transport = FakeTransport([Response(200, {"sessions": {}})])
        with self.assertRaises(RuntimeError):
            run(transport)
        self.assertNotIn("POST", [method for method, _url in transport.calls])


if __name__ == "__main__":
    unittest.main(verbosity=2)
