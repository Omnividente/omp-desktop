#!/usr/bin/env python3
"""Provider visibility must be established before interpreting a missing worker."""
from __future__ import annotations

import copy
import json
import unittest
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

from build_jules_request import build, dispatch_key
from jules_dispatch import Response
from planned_dispatch_observation import observe_planned_dispatch
from research_request import CONTRACT_VERSION, snapshot
from task_lifecycle import reserve, start

REPOSITORY = "synthetic-owner/synthetic-repo"
NOW = datetime(2026, 10, 28, 12, tzinfo=timezone.utc)
PRIMARY = "synthetic-private-primary"
BACKUP = "synthetic-private-backup"


def tasks():
    anchor = {"id": "research-anchor", "title": "Synthetic anchor", "task_type": "project_discovery",
              "status": "todo", "risk": "low", "priority": 40, "focus": ["quality"],
              "target_paths": ["src/synthetic.ts"],
              "evidence": {"source": "synthetic", "detail": "SYNTHETIC_PRIVATE_WORKER_PROSE"}}
    key = dispatch_key(REPOSITORY, anchor["id"], 1)
    branch = "autonomous/attempt-" + key
    request = build(anchor, template="{{TASK_JSON}}", repo=REPOSITORY,
                    branch="autonomous/lab", starting_branch=branch, base_sha="b" * 40,
                    decision_context=[])
    manifest = {"version": CONTRACT_VERSION, "tasks": [anchor],
                "autonomous_loop_policy": {"research_contract": CONTRACT_VERSION,
                                           "integration_branch": "autonomous/lab"}}
    reserve(manifest, anchor["id"], key, base_sha="b" * 40, starting_branch=branch,
            research_request=snapshot(request, [], "c" * 40), now=NOW)
    start(manifest, anchor["id"], session_id="original-7", dispatch_key=key, now=NOW)
    planned = {"id": "research-planned", "title": "Synthetic planned", "task_type": "project_discovery",
               "status": "todo", "risk": "low", "focus": ["quality"], "target_paths": ["src/synthetic.ts"]}
    original = {**copy.deepcopy(request), "id": "original-7", "name": "sessions/original-7",
                "state": "COMPLETED", "outputs": [{"text": "SYNTHETIC_PRIVATE_WORKER_PROSE"}]}
    candidate_key = dispatch_key(REPOSITORY, planned["id"], 1)
    candidate = {"id": "candidate-8", "name": "sessions/candidate-8", "state": "COMPLETED",
                 "title": "[dispatch:" + candidate_key + "] synthetic",
                 "prompt": "AUTONOMOUS_DISPATCH_KEY: " + candidate_key
                           + "\nAUTONOMOUS_TASK_ID: " + planned["id"],
                 "sourceContext": {"source": "sources/github/" + REPOSITORY,
                                   "githubRepoContext": {"startingBranch": "autonomous/attempt-" + candidate_key}}}
    return planned, anchor, original, candidate


class Provider:
    def __init__(self, views, current):
        self.views = views
        self.current = current
        self.calls = []

    def __call__(self, method, url, headers, payload):
        if method != "GET" or payload is not None:
            raise AssertionError("observation attempted a provider mutation")
        key = headers["X-Goog-Api-Key"]
        self.calls.append((key, url))
        parsed = urlsplit(url)
        if parsed.path == "/v1alpha/sessions":
            token = parse_qs(parsed.query).get("pageToken", ["0"])[0]
            index = int(token)
            pages = self.views[key]
            result = {"sessions": copy.deepcopy(pages[index])}
            if index + 1 < len(pages):
                result["nextPageToken"] = str(index + 1)
            return Response(200, result)
        if parsed.path == "/v1alpha/sessions/original-7":
            return Response(200, copy.deepcopy(self.current[key]))
        raise AssertionError("unexpected provider resource")


class PlannedObservationTests(unittest.TestCase):
    def setUp(self):
        self.planned, self.anchor, self.original, self.candidate = tasks()

    def observe(self, provider, keys=(PRIMARY,)):
        return observe_planned_dispatch(self.planned, self.anchor, REPOSITORY, api_keys=keys,
            transport=provider, api_base="https://provider.invalid/v1alpha", now=NOW)

    def test_known_session_get_readability_does_not_prove_list_visibility_or_absence(self):
        provider = Provider({PRIMARY: [[]]}, {PRIMARY: self.original})
        result = self.observe(provider)
        self.assertEqual((result["outcome"], result["presence"]), ("blocked", "unknown"))
        self.assertEqual(result["scopes"][0]["reason"], "bound_anchor_not_visible")

    def test_each_configured_credential_must_have_the_bound_anchor_in_its_scope(self):
        provider = Provider({PRIMARY: [[self.original]], BACKUP: [[]]},
                            {PRIMARY: self.original, BACKUP: self.original})
        result = self.observe(provider, keys=(PRIMARY, BACKUP))
        self.assertEqual((result["outcome"], result["presence"]), ("blocked", "unknown"))
        self.assertEqual([scope["visibility_confirmed"] for scope in result["scopes"]], [True, False])

    def test_complete_paginated_observation_can_report_scoped_absence_without_private_material(self):
        provider = Provider({PRIMARY: [[], [self.original]]}, {PRIMARY: self.original})
        result = self.observe(provider)
        self.assertEqual((result["outcome"], result["presence"]), ("observed", "absent"))
        self.assertEqual(result["scopes"][0]["matching_sessions"], [])
        encoded = json.dumps(result)
        for private in (PRIMARY, "SYNTHETIC_PRIVATE_WORKER_PROSE", self.original["prompt"]):
            self.assertNotIn(private, encoded)

    def test_completed_candidate_still_prevents_an_absence_observation(self):
        provider = Provider({PRIMARY: [[self.original, self.candidate]]}, {PRIMARY: self.original})
        result = self.observe(provider)
        self.assertEqual((result["outcome"], result["presence"]), ("observed", "present"))
        self.assertEqual([(row["session_id"], row["session_state"])
                          for row in result["scopes"][0]["matching_sessions"]], [("candidate-8", "COMPLETED")])

    def test_contradictory_candidate_is_unknown_not_discarded_as_absent(self):
        for mutation in ("marker", "source", "branch", "state", "shape"):
            with self.subTest(mutation=mutation):
                candidate = copy.deepcopy(self.candidate)
                if mutation == "marker":
                    candidate["prompt"] += "\nAUTONOMOUS_DISPATCH_KEY: foreign-key"
                elif mutation == "source":
                    candidate["sourceContext"]["source"] = "sources/github/foreign/repo"
                elif mutation == "branch":
                    candidate["sourceContext"]["githubRepoContext"]["startingBranch"] = "main"
                elif mutation == "state":
                    candidate.pop("state")
                else:
                    candidate["sourceContext"] = ["invalid"]
                provider = Provider({PRIMARY: [[self.original, candidate]]}, {PRIMARY: self.original})
                result = self.observe(provider)
                self.assertEqual((result["outcome"], result["presence"]), ("blocked", "unknown"))

    def test_current_anchor_identity_must_still_match_the_saved_request(self):
        changed = dict(self.original, prompt=self.original["prompt"] + "\nchanged context")
        provider = Provider({PRIMARY: [[self.original]]}, {PRIMARY: changed})
        result = self.observe(provider)
        self.assertEqual((result["outcome"], result["presence"]), ("blocked", "unknown"))
        self.assertEqual(result["scopes"][0]["reason"], "bound_anchor_identity_changed")

    def test_reserved_task_cannot_be_misclassified_as_new_unreserved_work(self):
        self.planned["execution"] = {"attempts": 1, "session_id": ""}
        provider = Provider({PRIMARY: [[self.original]]}, {PRIMARY: self.original})
        with self.assertRaisesRegex(ValueError, "unreserved research task"):
            self.observe(provider)
        self.assertEqual(provider.calls, [])


if __name__ == "__main__":
    unittest.main()
