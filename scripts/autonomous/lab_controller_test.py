#!/usr/bin/env python3
"""Controller failures, restarts and worker/proposal separation on real Git state."""
from __future__ import annotations

import copy
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit

from jules_dispatch import Response
from jules_provenance import bind_proposal
from lab_controller import GitHub, StateWriteError, _git, tick
from state_store import load_state, save_state
from task_lifecycle import start
from validate_tasks import validate

NOW = datetime(2026, 9, 13, 12, tzinfo=timezone.utc)
REPOSITORY = "Omnividente/omp-desktop"
TEMPLATES = Path(__file__).resolve().parents[2] / "docs" / "autonomous"
CONFIG = {"repository": REPOSITORY, "automation": {"merge_mode": "manual"},
          "parallel_mode": {"integration_branch": "autonomous/lab"},
          "product": {"editable_globs": ["src/**"], "excluded": []},
          "research": {"enabled": False}}


def task(identifier):
    return {"id": identifier, "title": "Fix clock " + identifier, "status": "todo",
            "task_type": "bugfix", "risk": "low", "priority": 90, "focus": ["quality"],
            "target_paths": ["src/clock.ts"], "acceptance": ["Clock updates after resume"],
            "evidence": {"source": "smoke", "detail": "Clock remained stale after resume"}}


def session(identifier, key, state="IN_PROGRESS", pull_request=None):
    return {"id": identifier, "name": "sessions/" + identifier, "state": state,
            "title": "[dispatch:" + key + "] clock", "outputs": [] if pull_request is None else [
                {"pullRequest": {"url": f"https://github.com/{REPOSITORY}/pull/{pull_request}"}}]}


class Sessions:
    def __init__(self):
        self.values = {}
        self.activities = {}
        self.posts = 0
        self.after_create = lambda: None
        self.before_list = lambda: None
        self.create_status = 200

    def __call__(self, method, url, headers, payload):
        path = urlsplit(url).path
        if method == "POST" and path == "/v1alpha/sessions":
            self.posts += 1
            if self.create_status != 200:
                return Response(self.create_status)
            identifier = str(max([int(key) for key in self.values] + [0]) + 1)
            value = dict(copy.deepcopy(payload), id=identifier, name="sessions/" + identifier,
                         state="IN_PROGRESS", outputs=[])
            self.values[identifier] = value
            self.after_create()
            return Response(200, value)
        if method != "GET":
            raise AssertionError("unexpected worker mutation")
        if path == "/v1alpha/sessions":
            self.before_list()
            return Response(200, {"sessions": list(self.values.values())})
        identifier = path.split("/")[3]
        if path.endswith("/activities"):
            return Response(200, {"activities": self.activities.get(identifier, [])})
        return Response(200, self.values[identifier]) if identifier in self.values else Response(404)


class LaboratoryGitHub(GitHub):
    def __init__(self, case):
        super().__init__(REPOSITORY)
        self.case = case
        self.is_enabled = True
        self.proposals = {}
        self.retargets = 0

    def api(self, path, *, method="GET", body=None, missing=False):
        if path == "actions/variables/JULES_LOOP_ENABLED":
            return {"value": "true" if self.is_enabled else "false"}
        if path.startswith("git/ref/heads/"):
            branch = unquote(path[len("git/ref/heads/"):])
            result = self.case.git(self.case.remote, "rev-parse", "--verify", "refs/heads/" + branch, check=False)
            return {"object": {"sha": result.stdout.decode().strip()}} if result.returncode == 0 else None
        if method == "POST" and path == "git/refs":
            self.case.git(self.case.repo, "push", "origin", body["sha"] + ":" + body["ref"])
            return {}
        if path.startswith("pulls?"):
            query = parse_qs(urlsplit(path).query)
            return [copy.deepcopy(pr) for pr in self.proposals.values() if pr["state"] == "open"
                    and ("base" not in query or pr["base"]["ref"] == query["base"][0])
                    and ("head" not in query or pr["head"]["ref"] == query["head"][0].split(":", 1)[1])]
        if path.startswith("pulls/"):
            pr = self.proposals[int(path.split("/")[1])]
            if method == "PATCH":
                self.retargets += 1
                pr["base"]["ref"] = body["base"]
            return copy.deepcopy(pr)
        raise AssertionError("unexpected GitHub action: " + method + " " + path)

    def add_proposal(self, number, state="open", base="autonomous/lab"):
        self.proposals[number] = {
            "number": number, "html_url": f"https://github.com/{REPOSITORY}/pull/{number}",
            "state": state, "merged": False, "user": {"login": "Omnividente"},
            "base": {"ref": base, "sha": self.case.head, "repo": {"full_name": REPOSITORY}},
            "head": {"ref": "jules/clock-" + str(number), "sha": "b" * 40,
                     "repo": {"full_name": REPOSITORY}},
        }
        return self.proposals[number]


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.remote, self.repo = self.root / "remote.git", self.root / "lab"
        self.git(self.root, "init", "--bare", str(self.remote))
        self.git(self.root, "init", str(self.repo))
        self.git(self.repo, "config", "user.name", "fixture")
        self.git(self.repo, "config", "user.email", "fixture@example.invalid")
        self.git(self.repo, "config", "commit.gpgsign", "false")
        seed = {"version": 2, "autonomous_loop_policy": {"lifecycle": {
            "max_attempts": 2, "stale_in_progress_hours": 6}}, "tasks": [task("first")]}
        (self.repo / "agent_tasks.json").write_text(json.dumps(seed), encoding="utf-8")
        (self.repo / "src").mkdir()
        (self.repo / "src/clock.ts").write_text("export const clock = 0;\n", encoding="utf-8")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "fixture")
        self.git(self.repo, "branch", "-M", "autonomous/lab")
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.git(self.repo, "push", "origin", "HEAD", "HEAD:refs/heads/main")
        self.head = self.git(self.repo, "rev-parse", "HEAD").stdout.decode().strip()
        self.queue, self.revision = self.root / "queue.json", self.root / "revision.json"
        self.data = load_state(self.repo, self.queue, self.revision)
        self.api, self.github = Sessions(), LaboratoryGitHub(self)

    def git(self, repo, *args, check=True):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", *args],
                              check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def persist(self, data):
        errors = validate(data)
        if errors:
            raise ValueError("; ".join(errors))
        self.queue.write_text(json.dumps(data), encoding="utf-8")
        save_state(self.repo, self.queue, self.revision)

    def run_tick(self, persist=None, **options):
        return tick(self.data, CONFIG, repo=self.repo, templates=TEMPLATES, github=self.github,
                    persist=persist or self.persist, api_keys=["fixture-only"], transport=self.api,
                    api_base="http://localhost/v1alpha", now=NOW, **options)

    def reload(self):
        self.data = load_state(self.repo, self.queue, self.revision)
        return self.data["tasks"]

    def test_completed_owner_proposal_releases_worker_without_accepting_it(self):
        self.data["tasks"].append(task("second"))
        start(self.data, "first", session_id="1", dispatch_key="old", now=NOW)
        self.api.values["1"] = session("1", "old", "COMPLETED", 59)
        self.github.add_proposal(59)
        self.run_tick()
        first, second = self.reload()
        self.assertEqual((first["status"], first["execution"]["state"]), ("blocked", "awaiting_review"))
        self.assertEqual(first["execution"]["pull_request"], 59)
        self.assertEqual((second["status"], self.api.posts), ("in_progress", 1))
        self.assertEqual(self.github.proposals[59]["state"], "open")
        self.assertEqual(self.github.head("autonomous/lab"), self.head)
        self.assertEqual(self.github.head("main"), self.head)

    def test_stale_unknown_session_is_quarantined_then_terminal_proof_resolves_it(self):
        self.data["tasks"].append(task("second"))
        start(self.data, "first", session_id="1", dispatch_key="old", now=NOW - timedelta(hours=7))
        self.run_tick()
        first, second = self.reload()
        self.assertEqual((first["status"], first["execution"]["state"]), ("blocked", "quarantined"))
        self.assertEqual((second["status"], self.api.posts), ("todo", 0))
        self.api.values["1"] = session("1", "old", "COMPLETED")
        self.run_tick()
        first, second = self.reload()
        self.assertEqual((first["status"], first["execution"]["outcome"], first["execution"]["attempts"]),
                         ("done", "no_change", 1))
        self.assertEqual((second["status"], self.api.posts), ("in_progress", 1))

    def test_switch_during_session_listing_prevents_the_actual_post(self):
        self.api.before_list = lambda: setattr(self.github, "is_enabled", False)
        self.run_tick()
        saved = self.reload()[0]["execution"]
        self.assertEqual((saved["state"], saved["session_id"], self.api.posts), ("quarantined", "", 0))

    def test_definite_create_rejection_retries_only_within_attempt_budget(self):
        self.api.create_status = 422
        self.assertEqual(self.run_tick()["reason"], "create_rejected")
        first = self.reload()[0]
        self.assertEqual((first["status"], first["execution"]["state"]), ("todo", "retry"))
        self.assertEqual(self.run_tick()["reason"], "create_rejected")
        second = self.reload()[0]
        self.assertEqual((second["status"], second["execution"]["state"], second["execution"]["attempts"]),
                         ("blocked", "exhausted", 2))
        self.run_tick()
        self.assertEqual(self.api.posts, 2)

    def test_failed_reservation_save_never_creates_external_worker(self):
        def fail_reservation(data):
            if data["tasks"][0].get("execution", {}).get("state") == "dispatching":
                raise RuntimeError("unreachable state remote")
            self.persist(data)
        with self.assertRaises(StateWriteError):
            self.run_tick(persist=fail_reservation)
        self.assertEqual(self.api.posts, 0)
        self.assertEqual(self.reload()[0]["status"], "todo")

    def test_lost_binding_save_restarts_through_lookup_without_second_create(self):
        def fail_binding(data):
            if data["tasks"][0].get("execution", {}).get("session_id"):
                raise RuntimeError("lost binding save")
            self.persist(data)
        with self.assertRaises(StateWriteError):
            self.run_tick(persist=fail_binding)
        self.assertEqual(self.api.posts, 1)
        reserved = self.reload()[0]["execution"]
        self.assertEqual((reserved["state"], reserved["session_id"], reserved["attempts"]), ("dispatching", "", 1))
        self.run_tick()
        bound = self.reload()[0]["execution"]
        self.assertEqual((bound["state"], bound["session_id"], bound["attempts"], self.api.posts),
                         ("dispatched", "1", 1, 1))

    def test_switch_during_create_retains_identity_without_replacement_on_resume(self):
        self.api.after_create = lambda: setattr(self.github, "is_enabled", False)
        self.run_tick()
        saved = self.reload()[0]["execution"]
        self.assertEqual((saved["state"], saved["session_id"], saved["attempts"]), ("quarantined", "1", 1))
        self.github.is_enabled = True
        self.run_tick()
        self.assertEqual(self.api.posts, 1)
        self.assertEqual(self.reload()[0]["execution"]["session_id"], "1")

    def test_report_transaction_does_not_drop_later_pr_observation(self):
        research = self.data["tasks"][0]
        research.update(task_type="project_discovery", research={"area_id": "clock", "perspective_id": "behavior",
                        "fingerprint": "a" * 64, "cycle": 1, "previous_reports": []})
        start(self.data, "first", session_id="1", dispatch_key="research", now=NOW)
        research["execution"]["last_error"] = {"at": "2026-09-13T11:00:00Z", "detail": "prior outage"}
        self.api.values["1"] = session("1", "research", "COMPLETED")
        report = {"summary": "Inspected clock", "observations": [{"scenario": "resume", "evidence": "clock advanced",
                  "result": "current time displayed"}], "next_hypotheses": []}
        self.api.activities["1"] = [{"name": "sessions/1/activities/final", "createTime": "2026-09-13T11:59:00Z",
                                    "originator": "agent", "agentMessaged": {"agentMessage":
                                    "AUTONOMOUS_RESEARCH_BEGIN\n" + json.dumps(report) + "\nAUTONOMOUS_RESEARCH_END"}}]
        second = task("second")
        self.data["tasks"].append(second)
        start(self.data, "second", session_id="2", dispatch_key="proposal", now=NOW)
        completed = session("2", "proposal", "COMPLETED", 59)
        bind_proposal(self.data, "second", completed, self.github.add_proposal(59), repository=REPOSITORY, now=NOW)
        self.github.proposals[59]["state"] = "closed"
        self.run_tick()
        first, second = self.reload()
        self.assertEqual((first["execution"]["outcome"], second["execution"]["outcome"]), ("no_change", "closed_unmerged"))
        self.assertNotIn("last_error", first["execution"])
        self.assertEqual((first["status"], second["status"], self.api.posts), ("done", "done", 0))

    def test_disabled_loop_does_not_retarget_a_finished_proposal(self):
        start(self.data, "first", session_id="1", dispatch_key="a" * 24, now=NOW)
        attempt = "autonomous/attempt-" + "a" * 24
        self.data["tasks"][0]["execution"].update(starting_branch=attempt, base_sha=self.head)
        self.api.values["1"] = session("1", "a" * 24, "COMPLETED", 59)
        self.github.add_proposal(59, base=attempt)
        self.github.is_enabled = False
        self.run_tick()
        self.assertEqual((self.github.proposals[59]["base"]["ref"], self.github.retargets), (attempt, 0))
        self.reload()
        self.github.is_enabled = True
        self.run_tick()
        self.assertEqual((self.github.proposals[59]["base"]["ref"], self.github.retargets), ("autonomous/lab", 1))
        self.assertEqual(self.reload()[0]["execution"]["state"], "awaiting_review")

    def test_terminal_attempt_ref_is_released_without_accepting_its_proposal(self):
        self.run_tick()
        execution = self.reload()[0]["execution"]
        branch = execution["starting_branch"]
        self.api.values["1"].update(state="COMPLETED", outputs=[{
            "pullRequest": {"url": f"https://github.com/{REPOSITORY}/pull/59"}}])
        self.github.add_proposal(59, base=branch)
        self.run_tick()
        self.assertEqual(self.github.head(branch), "")
        saved = self.reload()[0]
        self.assertEqual((saved["execution"]["state"], self.github.proposals[59]["state"]), ("awaiting_review", "open"))
        self.assertEqual((self.github.head("main"), self.github.head("autonomous/lab")), (self.head, self.head))
        self.run_tick()
        self.assertEqual(self.api.posts, 1)
        self.assertEqual(self.github.head(branch), "")

    def test_attempt_cleanup_retains_active_referenced_or_modified_refs(self):
        self.run_tick()
        execution = copy.deepcopy(self.reload()[0]["execution"])
        branch = execution["starting_branch"]
        self.assertEqual(self.github.release_attempt(self.repo, execution), "worker_unresolved")
        self.assertEqual(self.github.head(branch), self.head)
        execution["session_state"] = "COMPLETED"
        proposal = self.github.add_proposal(77, base=branch)
        for side in ("base", "head"):
            with self.subTest(side=side):
                proposal["base"]["ref"] = branch if side == "base" else "autonomous/lab"
                proposal["head"]["ref"] = branch if side == "head" else "jules/clock-77"
                self.assertEqual(self.github.release_attempt(self.repo, execution), "open_proposal")
                self.assertEqual(self.github.head(branch), self.head)
        proposal["state"] = "closed"
        self.git(self.repo, "commit", "--allow-empty", "-m", "new ref owner")
        moved = self.git(self.repo, "rev-parse", "HEAD").stdout.decode().strip()
        self.git(self.repo, "push", "origin", moved + ":refs/heads/" + branch)
        self.assertEqual(self.github.release_attempt(self.repo, execution), "ref_moved")
        self.assertEqual(self.github.head(branch), moved)

    def test_attempt_cleanup_lease_preserves_a_concurrent_ref_replacement(self):
        self.run_tick()
        execution = copy.deepcopy(self.reload()[0]["execution"])
        execution["session_state"] = "COMPLETED"
        branch = execution["starting_branch"]
        self.git(self.repo, "commit", "--allow-empty", "-m", "racing ref owner")
        moved = self.git(self.repo, "rev-parse", "HEAD").stdout.decode().strip()

        def racing_git(repo, *args, **kwargs):
            if "push" in args:
                self.git(self.repo, "push", "origin", moved + ":refs/heads/" + branch)
            return _git(repo, *args, **kwargs)

        with patch("lab_controller._git", side_effect=racing_git), self.assertRaises(RuntimeError):
            self.github.release_attempt(self.repo, execution)
        self.assertEqual(self.github.head(branch), moved)


if __name__ == "__main__":
    unittest.main()
