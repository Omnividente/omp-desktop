#!/usr/bin/env python3
"""Isolated read-only reserved-session recovery regressions; no live API or state."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import unittest
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_jules_request import build, dispatch_key  # noqa: E402
from dispatch_recovery import observe_reserved_dispatch  # noqa: E402
from jules_dispatch import KeyRing, Response  # noqa: E402
from research_request import CONTRACT_VERSION, LEGACY_VERSION, sha256_json, snapshot  # noqa: E402
from task_lifecycle import reserve, start  # noqa: E402

REPOSITORY = "synthetic-owner/synthetic-repo"
API_BASE = "https://provider.invalid/v1alpha"
NOW = datetime(2026, 10, 6, 12, 30, tzinfo=timezone.utc)
PRIMARY = "synthetic-private-primary"
BACKUP = "synthetic-private-backup"


def reserved_task(attempt=1):
    task = {"id": "synthetic-research", "title": "SYNTHETIC_PRIVATE_TITLE",
            "task_type": "project_discovery", "status": "todo", "priority": 40,
            "risk": "low", "focus": ["quality"], "target_paths": ["src/synthetic.ts"],
            "evidence": {"source": "research_cycle", "detail": "SYNTHETIC_PRIVATE_REQUEST"},
            "execution": {"attempts": attempt - 1}}
    key = dispatch_key(REPOSITORY, task["id"], attempt)
    branch = "autonomous/attempt-" + key
    request = build(task, template="{{TASK_JSON}}", repo=REPOSITORY,
                    branch="autonomous/lab", starting_branch=branch, base_sha="b" * 40,
                    attempt=attempt, decision_context=[])
    data = {"version": CONTRACT_VERSION, "tasks": [task],
            "autonomous_loop_policy": {"research_contract": CONTRACT_VERSION,
                                       "integration_branch": "autonomous/lab"}}
    reserve(data, task["id"], key, base_sha="b" * 40, starting_branch=branch,
            research_request=snapshot(request, [], "c" * 40), now=NOW)
    return task


def provider_session(task, state="COMPLETED", identifier="original-7"):
    request = task["execution"]["research_request"]["request"]
    return {"id": identifier, "name": "sessions/" + identifier, "state": state,
            "prompt": request["prompt"], "title": request["title"],
            "sourceContext": copy.deepcopy(request["sourceContext"]),
            "createTime": "2026-10-06T11:00:00Z", "updateTime": "2026-10-06T12:00:00Z",
            "outputs": [{"text": "SYNTHETIC_PRIVATE_WORKER_PROSE"}]}


def page(*sessions, token=""):
    body = {"sessions": list(sessions)}
    if token:
        body["nextPageToken"] = token
    return Response(200, body)


class Transport:
    """Script only provider responses; record real observer requests and auth."""
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, payload):
        self.calls.append({"method": method, "url": url, "headers": dict(headers),
                           "payload": copy.deepcopy(payload)})
        if not self.responses:
            raise AssertionError("unexpected provider request")
        return self.responses.pop(0)


def observe(task, transport, **options):
    return observe_reserved_dispatch(task, REPOSITORY, api_keys=options.pop("api_keys", [PRIMARY]),
                                     transport=transport, api_base=API_BASE, now=NOW, **options)


class ReservedDispatchRecoveryTest(unittest.TestCase):
    def assert_read_only(self, transport):
        self.assertTrue(all(call["method"] == "GET" and call["payload"] is None
                            for call in transport.calls))
        self.assertEqual(sum(call["method"] == "POST" for call in transport.calls), 0)

    def test_terminal_session_is_authenticated_and_observed_without_creation_or_completion(self):
        for state in ("COMPLETED", "FAILED"):
            with self.subTest(state=state):
                task = reserved_task()
                current = provider_session(task, state)
                before = copy.deepcopy(task)
                transport = Transport([page(current), Response(200, copy.deepcopy(current))])
                result = observe(task, transport)
                self.assertEqual(set(result), {"identity", "proof", "session"})
                self.assertEqual(result["session"], current)
                self.assertEqual(task, before)
                self.assertEqual(result["identity"], {
                    "task_id": task["id"], "attempts": 1,
                    "dispatch_key": task["execution"]["dispatch_key"], "base_sha": "b" * 40,
                    "starting_branch": task["execution"]["starting_branch"],
                    "research_request_sha256": sha256_json(task["execution"]["research_request"]),
                })
                proof = result["proof"]
                for field, value in result["identity"].items():
                    self.assertEqual(proof[field], value)
                self.assertEqual(proof["session_state"], state)
                self.assertEqual(proof["session_id"], "original-7")
                self.assertEqual(proof["session_resource"], "sessions/original-7")
                self.assertEqual(proof["session_sha256"], sha256_json(current))
                self.assertEqual(proof["list_session_sha256"], sha256_json(current))
                self.assertEqual(proof["request_sha256"],
                                 task["execution"]["research_request"]["request_sha256"])
                self.assertEqual(proof["observed_at"], "2026-10-06T12:30:00Z")
                self.assertEqual(proof["repository"], REPOSITORY)
                self.assertEqual(proof["method"], "GET")
                self.assertIs(proof["authenticated"], True)
                self.assertNotIn("result", result)
                safe = json.dumps({"identity": result["identity"], "proof": proof})
                for private in (PRIMARY, BACKUP, "SYNTHETIC_PRIVATE_REQUEST",
                                "SYNTHETIC_PRIVATE_TITLE", "SYNTHETIC_PRIVATE_WORKER_PROSE",
                                current["prompt"]):
                    self.assertNotIn(private, safe)
                self.assertEqual(len(transport.calls), 2)
                self.assertEqual(transport.calls[1]["url"], API_BASE + "/sessions/original-7")
                self.assertTrue(all(call["headers"]["X-Goog-Api-Key"] == PRIMARY
                                    for call in transport.calls))
                self.assert_read_only(transport)

    def test_active_session_and_second_reserved_attempt_keep_their_actual_state_and_identity(self):
        for state in ("QUEUED", "IN_PROGRESS", "NEW_PROVIDER_STATE"):
            with self.subTest(state=state):
                task = reserved_task(attempt=2)
                current = provider_session(task, state)
                transport = Transport([page(current), Response(200, current)])
                result = observe(task, transport)
                self.assertEqual(result["proof"]["session_state"], state)
                self.assertEqual(result["identity"]["attempts"], 2)
                self.assertEqual(task["execution"]["attempts"], 2)
                self.assertEqual(task["execution"]["session_id"], "")
                self.assert_read_only(transport)

    def test_observation_can_bind_only_the_existing_attempt_through_native_start(self):
        task = reserved_task()
        current = provider_session(task)
        transport = Transport([page(current), Response(200, current)])
        observed = observe(task, transport)
        saved = copy.deepcopy(task["execution"]["research_request"])
        data = {"tasks": [task]}
        result = start(data, task["id"], session_id=observed["proof"]["session_id"],
                       dispatch_key=observed["identity"]["dispatch_key"], now=NOW)
        self.assertEqual(result["reason"], "dispatched")
        self.assertEqual(task["execution"]["attempts"], 1)
        self.assertEqual(task["execution"]["session_id"], "original-7")
        self.assertEqual(task["execution"]["research_request"], saved)
        self.assertEqual(task["status"], "in_progress")
        self.assertEqual(task["execution"]["outcome"], "")
        self.assert_read_only(transport)

    def test_missing_original_session_fails_closed_after_every_page_with_zero_post(self):
        task = reserved_task()
        before = copy.deepcopy(task)
        unrelated = {"id": "other", "name": "sessions/other", "state": "FAILED",
                     "title": "[dispatch:another-attempt]", "prompt": "unrelated"}
        transport = Transport([page(unrelated, token="second"), page()])
        with self.assertRaisesRegex(RuntimeError, "missing; creation is forbidden"):
            observe(task, transport)
        self.assertEqual(task, before)
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(parse_qs(urlsplit(transport.calls[1]["url"]).query)["pageToken"], ["second"])
        self.assert_read_only(transport)

    def test_unique_original_session_on_later_page_is_freshly_read(self):
        task = reserved_task()
        current = provider_session(task)
        transport = Transport([page(token="second"), page(current), Response(200, current)])
        result = observe(task, transport)
        self.assertEqual(result["session"]["id"], "original-7")
        self.assertEqual(len(transport.calls), 3)
        self.assertEqual(parse_qs(urlsplit(transport.calls[1]["url"]).query)["pageToken"], ["second"])
        self.assertEqual(transport.calls[-1]["url"], API_BASE + "/sessions/original-7")
        self.assert_read_only(transport)

    def test_duplicate_distinct_resources_on_later_page_are_blocked_before_get(self):
        task = reserved_task()
        transport = Transport([page(provider_session(task), token="second"),
                               page(provider_session(task, state="FAILED", identifier="duplicate-8"))])
        with self.assertRaisesRegex(RuntimeError, "multiple Jules sessions"):
            observe(task, transport)
        self.assertEqual(len(transport.calls), 2)
        self.assert_read_only(transport)

    def test_identical_repeated_resource_is_one_session_but_conflicting_repetition_is_blocked(self):
        task = reserved_task()
        current = provider_session(task)
        transport = Transport([page(current, token="second"), page(copy.deepcopy(current)),
                               Response(200, current)])
        self.assertEqual(observe(task, transport)["proof"]["session_id"], "original-7")
        self.assert_read_only(transport)
        conflicting = provider_session(task, state="FAILED")
        transport = Transport([page(current, token="second"), page(conflicting)])
        with self.assertRaisesRegex(RuntimeError, "conflicting original session observations"):
            observe(task, transport)
        self.assertEqual(len(transport.calls), 2)
        self.assert_read_only(transport)

    def test_missing_foreign_or_conflicting_actual_fields_are_blocked_in_list_and_fresh_get(self):
        mutations = {
            "foreign source": lambda s: s["sourceContext"].update(source="sources/github/foreign/repo"),
            "missing source": lambda s: s["sourceContext"].pop("source"),
            "missing sourceContext": lambda s: s.pop("sourceContext"),
            "invalid sourceContext": lambda s: s.update(sourceContext="foreign"),
            "foreign branch": lambda s: s["sourceContext"]["githubRepoContext"].update(startingBranch="autonomous/lab"),
            "missing branch": lambda s: s["sourceContext"]["githubRepoContext"].pop("startingBranch"),
            "missing repository context": lambda s: s["sourceContext"].pop("githubRepoContext"),
            "wrong prompt": lambda s: s.update(prompt=s["prompt"] + " altered intent"),
            "wrong title": lambda s: s.update(title=s["title"] + " altered title"),
            "missing prompt": lambda s: s.pop("prompt"),
            "missing title": lambda s: s.pop("title"),
            "contradictory prompt key": lambda s: s.update(prompt=s["prompt"] + "\nAUTONOMOUS_DISPATCH_KEY: foreign"),
            "contradictory title key": lambda s: s.update(title=s["title"] + " [dispatch:foreign]"),
            "contradictory ID": lambda s: s.update(id="different"),
            "missing ID": lambda s: s.pop("id"),
            "resource instead of ID": lambda s: s.update(id=s["name"]),
            "invalid ID": lambda s: s.update(id="../foreign"),
            "missing resource": lambda s: s.pop("name"),
            "contradictory resource": lambda s: s.update(name="sessions/different"),
            "missing state": lambda s: s.pop("state"),
            "invalid state": lambda s: s.update(state="untrusted prose"),
        }
        for stage in ("list", "get"):
            for label, mutate in mutations.items():
                with self.subTest(stage=stage, fault=label):
                    task = reserved_task()
                    before = copy.deepcopy(task)
                    original = provider_session(task)
                    invalid = copy.deepcopy(original)
                    mutate(invalid)
                    responses = ([page(invalid)] if stage == "list"
                                 else [page(original), Response(200, invalid)])
                    transport = Transport(responses)
                    with self.assertRaises(RuntimeError):
                        observe(task, transport)
                    self.assertEqual(task, before)
                    self.assertEqual(len(transport.calls), 1 if stage == "list" else 2)
                    self.assert_read_only(transport)

    def test_fresh_get_cannot_replace_list_resource_or_change_the_observed_payload(self):
        task = reserved_task()
        original = provider_session(task)
        changed_sessions = [provider_session(task, identifier="different"),
                            provider_session(task, state="FAILED")]
        for field, value in (("updateTime", "2026-10-06T12:01:00Z"),
                             ("outputs", [{"text": "changed private output"}])):
            changed = copy.deepcopy(original)
            changed[field] = value
            changed_sessions.append(changed)
        for changed in changed_sessions:
            with self.subTest(changed_hash=sha256_json(changed)):
                transport = Transport([page(original), Response(200, changed)])
                with self.assertRaisesRegex(RuntimeError, "fresh Jules GetSession"):
                    observe(task, transport)
                self.assertEqual(len(transport.calls), 2)
                self.assert_read_only(transport)

    def test_saved_request_and_attempt_mismatches_are_rejected_before_any_http(self):
        mutations = {
            "changed task ID": lambda t: t.update(id="another-task"),
            "wrong task type": lambda t: t.update(task_type="bugfix"),
            "not in progress": lambda t: t.update(status="todo"),
            "not dispatching": lambda t: t["execution"].update(state="dispatched"),
            "already bound": lambda t: t["execution"].update(session_id="original-7"),
            "missing reserved session field": lambda t: t["execution"].pop("session_id"),
            "zero attempts": lambda t: t["execution"].update(attempts=0),
            "boolean attempts": lambda t: t["execution"].update(attempts=True),
            "changed attempts": lambda t: t["execution"].update(attempts=2),
            "foreign dispatch key": lambda t: t["execution"].update(dispatch_key="foreign"),
            "changed base": lambda t: t["execution"].update(base_sha="a" * 40),
            "mutable branch": lambda t: t["execution"].update(starting_branch="autonomous/lab"),
            "missing saved request": lambda t: t["execution"].pop("research_request"),
            "legacy saved request": lambda t: t["execution"].update(research_request={
                "contract_version": LEGACY_VERSION, "context_provenance": "not_recorded"}),
            "wrong request hash": lambda t: t["execution"]["research_request"].update(request_sha256="f" * 64),
            "wrong context hash": lambda t: t["execution"]["research_request"].update(decision_context_sha256="f" * 64),
            "wrong controller SHA": lambda t: t["execution"]["research_request"].update(controller_sha="main"),
            "changed saved prompt": lambda t: t["execution"]["research_request"]["request"].update(prompt="changed"),
        }
        for label, mutate in mutations.items():
            with self.subTest(fault=label):
                task = reserved_task()
                mutate(task)
                before = copy.deepcopy(task)
                transport = Transport([])
                with self.assertRaises(ValueError):
                    observe(task, transport)
                self.assertEqual(task, before)
                self.assertEqual(transport.calls, [])

    def test_validly_hashed_saved_request_with_contradictory_markers_or_foreign_source_is_blocked(self):
        for field, suffix in (("prompt", "\nAUTONOMOUS_DISPATCH_KEY: foreign"),
                              ("prompt", "\nAUTONOMOUS_TASK_ID: foreign-task"),
                              ("title", " [dispatch:foreign]"),
                              ("source", "sources/github/foreign/repo")):
            with self.subTest(field=field, suffix=suffix):
                task = reserved_task()
                block = task["execution"]["research_request"]
                if field == "source":
                    block["request"]["sourceContext"]["source"] = suffix
                else:
                    block["request"][field] += suffix
                block["request_sha256"] = sha256_json(block["request"])
                transport = Transport([])
                with self.assertRaises(ValueError):
                    observe(task, transport)
                self.assertEqual(transport.calls, [])

    def test_current_queue_details_are_not_used_to_rebuild_original_request(self):
        task = reserved_task()
        original = provider_session(task)
        task["title"] = "new mutable title"
        task["evidence"]["detail"] = "new mutable evidence"
        task["target_paths"] = ["src/other.ts"]
        before = copy.deepcopy(task)
        transport = Transport([page(original), Response(200, original)])
        result = observe(task, transport)
        self.assertEqual(result["session"]["prompt"], original["prompt"])
        self.assertEqual(result["session"]["title"], original["title"])
        self.assertEqual(task, before)
        self.assert_read_only(transport)

    def test_incomplete_or_invalid_pagination_cannot_hide_duplicate_sessions(self):
        task = reserved_task()
        original = provider_session(task)
        for trailing in (Response(403, {"message": "PRIVATE_PROVIDER_ERROR"}),
                         page(token="second"), Response(200, {"sessions": "not a list"})):
            with self.subTest(status=trailing.status, body_hash=sha256_json(trailing.payload)):
                transport = Transport([page(original, token="second"), trailing])
                with self.assertRaises(RuntimeError) as caught:
                    observe(task, transport)
                self.assertNotIn("PRIVATE_PROVIDER_ERROR", str(caught.exception))
                self.assertEqual(len(transport.calls), 2)
                self.assert_read_only(transport)

    def test_fresh_get_failure_never_returns_list_payload_as_a_fallback(self):
        task = reserved_task()
        for response in (Response(404, {"message": "PRIVATE_PROVIDER_ERROR"}),
                         Response(200, None), Response(200, [])):
            with self.subTest(status=response.status):
                transport = Transport([page(provider_session(task)), response])
                with self.assertRaises(RuntimeError) as caught:
                    observe(task, transport)
                self.assertNotIn("PRIVATE_PROVIDER_ERROR", str(caught.exception))
                self.assertEqual(len(transport.calls), 2)
                self.assert_read_only(transport)

    def test_auth_key_ring_rotates_for_fresh_get_and_never_enters_proof(self):
        task = reserved_task()
        current = provider_session(task)
        ring = KeyRing([PRIMARY, BACKUP])
        transport = Transport([page(current), Response(401), Response(200, current)])
        result = observe(task, transport, api_keys=ring)
        self.assertEqual([call["headers"]["X-Goog-Api-Key"] for call in transport.calls],
                         [PRIMARY, PRIMARY, BACKUP])
        self.assertEqual(ring.current, BACKUP)
        safe = json.dumps({"identity": result["identity"], "proof": result["proof"]})
        self.assertNotIn(PRIMARY, safe)
        self.assertNotIn(BACKUP, safe)
        self.assert_read_only(transport)

    def test_missing_authentication_is_blocked_before_any_provider_request(self):
        task = reserved_task()
        transport = Transport([])
        with self.assertRaisesRegex(RuntimeError, "no Jules API key"):
            observe(task, transport, api_keys=[])
        self.assertEqual(transport.calls, [])

    def test_foreign_repository_cannot_observe_the_saved_attempt(self):
        transport = Transport([])
        with self.assertRaises(ValueError):
            observe_reserved_dispatch(reserved_task(), "foreign/repo", api_keys=[PRIMARY],
                                      transport=transport, api_base=API_BASE, now=NOW)
        self.assertEqual(transport.calls, [])


if __name__ == "__main__":
    unittest.main()
