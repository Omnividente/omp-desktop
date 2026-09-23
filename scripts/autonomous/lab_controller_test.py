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

from complete_jules_task import latest_report
from jules_dispatch import Response
from jules_provenance import bind_proposal
from lab_controller import GitHub, StateWriteError, _git, tick
from loop_health import assess_health
from state_store import load_state, save_state
from proposal_backlog import close_research_unaccepted, decide
from task_lifecycle import start
from validate_tasks import validate

NOW = datetime(2026, 9, 13, 12, tzinfo=timezone.utc)
REPOSITORY = "Omnividente/omp-desktop"
TEMPLATES = Path(__file__).resolve().parents[2] / "docs" / "autonomous"
CONFIG = {"repository": REPOSITORY, "automation": {"merge_mode": "manual"},
          "parallel_mode": {"integration_branch": "autonomous/lab"},
          "merge_gate": {"owner_approvers": ["Omnividente"]},
          "product": {"editable_globs": ["src/**"], "excluded": []},
          "research": {"enabled": False}}


def task(identifier):
    return {"id": identifier, "title": "Fix clock " + identifier, "status": "todo",
            "task_type": "bugfix", "risk": "low", "priority": 90, "focus": ["quality"],
            "target_paths": ["src/clock.ts"], "acceptance": ["Clock updates after resume"],
            "proposal_decision": {"action": "approve", "actor": "Omnividente",
                                  "at": "2026-09-13T11:00:00Z", "note": "Investigate this finding"},
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
        self.gets = 0
        self.before_list = lambda: None
        self.create_status = 200
        self.messages = []
        self.message_status = 200

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
        if method == "POST" and path.endswith(":sendMessage"):
            self.messages.append((path, payload))
            return Response(self.message_status)
        if method != "GET":
            raise AssertionError("unexpected worker mutation")
        self.gets += 1
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
        return tick(self.data, options.pop("config", CONFIG), repo=self.repo, templates=TEMPLATES, github=self.github,
                    persist=persist or self.persist, api_keys=["fixture-only"], transport=self.api,
                    api_base="http://localhost/v1alpha", now=options.pop("now", NOW),
                    task_id=options.pop("task_id", "first"), **options)

    def reload(self):
        self.data = load_state(self.repo, self.queue, self.revision)
        return self.data["tasks"]

    def research_config(self):
        config = copy.deepcopy(CONFIG)
        config["research"] = {
            "enabled": True, "revisit_after_hours": 24, "max_sessions_per_day": 24,
            "areas": [{"id": name, "title": name, "paths": ["src/clock.ts"]}
                      for name in ("clock", "continuity")],
            "perspectives": [{"id": "behavior", "title": "behavior", "focus": ["quality"],
                              "instruction": "Inspect a synthetic boundary and report observations."}],
        }
        return config

    def snapshot_api(self, repository, path, *, paginate=False):
        if path.startswith("actions/workflows/"):
            wanted = parse_qs(urlsplit(path).query)["status"][0]
            runs = getattr(self, "workflow_runs", []) if "autonomous_next_task.yml" in path else []
            runs = [run for run in runs if run["status"] == wanted]
            page = {"total_count": len(runs), "workflow_runs": runs}
            return [page] if paginate else page
        return self.github.api(path)

    def test_early_automatic_signal_preserves_deadline_queue_and_external_worker(self):
        config = self.research_config()
        self.run_tick(task_id="", config=config)
        self.reload()
        before, revision, reads = copy.deepcopy(self.data), self.github.head("autonomous/state"), self.api.gets
        with patch("health_snapshot.gh_get", side_effect=self.snapshot_api):
            result = self.run_tick(task_id="", config=config, automatic=True, run_id="10",
                                   now=NOW + timedelta(minutes=1))
        self.assertTrue(result["skipped"])
        self.assertEqual((self.api.posts, self.api.gets), (1, reads))
        self.reload()
        self.assertEqual(self.data, before)
        self.assertEqual(self.github.head("autonomous/state"), revision)

    def test_due_automatic_tick_ignores_old_handoff_then_duplicate_does_not_poll(self):
        config = self.research_config()
        self.run_tick(task_id="", config=config)
        self.reload()
        self.workflow_runs = [{"id": identifier, "head_branch": "main", "event": "workflow_dispatch",
                               "head_repository": {"full_name": REPOSITORY}, "status": "in_progress"}
                              for identifier in (9, 10)]
        with patch("health_snapshot.gh_get", side_effect=self.snapshot_api):
            first = self.run_tick(task_id="", config=config, automatic=True, run_id="10",
                                  now=NOW + timedelta(minutes=5))
            self.assertFalse(first.get("skipped", False))
            self.reload()
            before, reads = copy.deepcopy(self.data), self.api.gets
            second = self.run_tick(task_id="", config=config, automatic=True, run_id="11",
                                   now=NOW + timedelta(minutes=5, seconds=10))
        self.assertTrue(second["skipped"])
        self.assertEqual((self.api.posts, self.api.gets), (1, reads))
        self.reload()
        self.assertEqual(self.data, before)

    def test_automatic_path_rejects_an_explicit_approved_implementation(self):
        before = copy.deepcopy(self.data)
        with self.assertRaises(ValueError):
            self.run_tick(automatic=True)
        self.assertEqual((self.api.posts, self.api.gets), (0, 0))
        self.assertEqual(self.data, before)

    def test_disable_after_readiness_stops_without_quarantining_saved_attempts(self):
        config = self.research_config()
        self.run_tick(task_id="", config=config)
        self.reload()
        before, reads = copy.deepcopy(self.data), self.api.gets
        with patch("health_snapshot.gh_get", side_effect=self.snapshot_api), \
                patch.object(self.github, "enabled", side_effect=[True, False]):
            result = self.run_tick(task_id="", config=config, automatic=True, run_id="10",
                                   now=NOW + timedelta(minutes=5))
        self.assertEqual(result["reason"], "loop_disabled")
        self.assertEqual((self.api.posts, self.api.gets), (1, reads))
        self.reload()
        self.assertEqual(self.data, before)

    def test_partial_poll_success_does_not_reset_the_failed_tick_clock(self):
        config = self.research_config()
        self.run_tick()
        self.run_tick(task_id="", config=config)
        self.reload()
        previous_success = self.data["controller"]["last_tick_at"]
        del self.api.values["2"]
        result = self.run_tick(task_id="", config=config, now=NOW + timedelta(minutes=5))
        self.assertEqual(result["attention"][0]["task_id"], self.data["tasks"][-1]["id"])
        self.reload()
        self.assertEqual(self.data["controller"]["last_tick_at"], previous_success)
        self.assertEqual(self.data["controller"]["last_poll_at"], "2026-09-13T12:05:00Z")
        self.assertEqual(self.api.posts, 2)

    def test_completed_owner_proposal_releases_worker_without_accepting_it(self):
        self.data["tasks"].append(task("second"))
        start(self.data, "first", session_id="1", dispatch_key="old", now=NOW)
        self.api.values["1"] = session("1", "old", "COMPLETED", 59)
        self.github.add_proposal(59)
        self.run_tick(task_id="second")
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
        self.run_tick(task_id="second")
        first, second = self.reload()
        self.assertEqual((first["status"], first["execution"]["state"]), ("blocked", "quarantined"))
        self.assertEqual((second["status"], self.api.posts), ("todo", 0))
        self.api.values["1"] = session("1", "old", "COMPLETED")
        self.run_tick(task_id="second")
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

    def test_research_lost_binding_uses_saved_payload_after_control_inputs_change(self):
        source = self.data["tasks"][0]
        source["task_type"] = "project_discovery"
        source.pop("proposal_decision")

        def lose_binding(data):
            if data["tasks"][0].get("execution", {}).get("session_id"):
                raise RuntimeError("lost research binding save")
            self.persist(data)

        with self.assertRaises(StateWriteError):
            self.run_tick(persist=lose_binding, config=self.research_config())
        source = self.reload()[0]
        saved = copy.deepcopy(source["execution"]["research_request"])
        sent = self.api.values["1"]
        self.assertEqual({key: sent[key] for key in saved["request"]}, saved["request"])
        source["title"] = "Changed after the first dispatch"
        source["evidence"]["detail"] = "New evidence not in the original request"
        self.persist(self.data)
        self.run_tick(focus="changed", risk="high", config=self.research_config())
        bound = self.reload()[0]["execution"]
        self.assertEqual((bound["session_id"], bound["attempts"], self.api.posts), ("1", 1, 1))
        self.assertEqual(bound["research_request"], saved)

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
        research.pop("proposal_decision", None)
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

    def test_unchanged_poll_advances_cadence_without_changing_worker_identity(self):
        self.run_tick()
        before = copy.deepcopy(self.reload())
        result = self.run_tick(now=NOW + timedelta(minutes=5))
        self.assertEqual(self.reload(), before)
        self.assertEqual(self.data["controller"]["last_poll_at"], "2026-09-13T12:05:00Z")
        self.assertEqual((result["observations"][0]["session_id"], result["observations"][0]["observed_at"]),
                         ("1", "2026-09-13T12:05:00Z"))
        self.assertEqual(self.api.posts, 1)

    def test_waiting_and_resumed_observations_keep_the_same_attempt(self):
        self.run_tick()
        self.reload()
        self.api.values["1"]["state"] = "AWAITING_USER_FEEDBACK"
        waiting = self.run_tick(now=NOW + timedelta(minutes=5))
        self.assertEqual(waiting["waiting_workers"][0]["session_url"], "https://jules.google.com/session/1")
        before = copy.deepcopy(self.reload())
        self.run_tick(now=NOW + timedelta(hours=7))
        self.assertEqual(self.reload(), before)
        self.api.values["1"]["state"] = "IN_PROGRESS"
        self.run_tick(now=NOW + timedelta(hours=7, minutes=30))
        saved = self.reload()[0]
        self.assertEqual((saved["status"], saved["execution"]["session_state"], saved["execution"]["observed_at"]),
                         ("in_progress", "IN_PROGRESS", "2026-09-13T19:30:00Z"))
        before = copy.deepcopy(self.reload())
        self.run_tick(now=NOW + timedelta(hours=8))
        self.assertEqual(self.reload(), before)
        self.assertEqual((self.reload()[0]["execution"]["session_id"], self.api.posts), ("1", 1))

    def test_quarantined_approved_worker_gets_one_safe_same_session_instruction(self):
        self.run_tick()
        identity = copy.deepcopy(self.reload()[0]["execution"])
        self.github.is_enabled = False
        self.run_tick(now=NOW + timedelta(minutes=1))
        self.assertEqual(self.reload()[0]["execution"]["state"], "quarantined")
        self.github.is_enabled = True
        self.api.values["1"]["state"] = "AWAITING_USER_FEEDBACK"
        self.api.message_status = 0  # Lost acknowledgement cannot authorize a second send.
        self.run_tick(now=NOW + timedelta(minutes=5))
        worker = self.reload()[0]
        self.assertEqual(worker["execution"]["feedback_nudge"]["result"], "unknown")
        self.assertEqual(self.api.messages[0][0], "/v1alpha/sessions/1:sendMessage")
        self.assertIn("no_change", self.api.messages[0][1]["prompt"])
        self.assertIn("pull request", self.api.messages[0][1]["prompt"])
        self.assertEqual(len(self.api.messages), 1)
        self.assertEqual(worker["proposal_decision"], task("first")["proposal_decision"])
        self.assertEqual(validate(self.data), [])
        self.run_tick(now=NOW + timedelta(minutes=10))
        self.api.values["1"]["state"] = "IN_PROGRESS"
        self.run_tick(now=NOW + timedelta(minutes=15))
        current = self.reload()[0]["execution"]
        self.assertEqual(len(self.api.messages), 1)
        self.assertEqual(self.api.posts, 1)
        for field in ("session_id", "dispatch_key", "attempts", "base_sha", "starting_branch"):
            self.assertEqual(current[field], identity[field])
        self.api.values["1"]["state"] = "COMPLETED"
        self.run_tick(now=NOW + timedelta(minutes=20))
        finished = self.reload()[0]
        self.assertEqual((finished["status"], finished["execution"]["state"], finished["execution"]["outcome"]),
                         ("done", "completed", "no_change"))
        self.assertEqual(len(self.api.messages), 1)

    def test_implementation_feedback_needs_durable_intent_and_skips_existing_pr(self):
        self.run_tick()
        self.reload()
        self.api.values["1"]["state"] = "AWAITING_USER_FEEDBACK"

        def fail_intent(data):
            if data["tasks"][0].get("execution", {}).get("feedback_nudge"):
                raise RuntimeError("state unavailable")
            self.persist(data)

        with self.assertRaises(StateWriteError):
            self.run_tick(persist=fail_intent)
        self.assertEqual(self.api.messages, [])
        self.reload()
        self.github.add_proposal(59)
        self.api.values["1"]["outputs"] = [{"pullRequest": {"url": f"https://github.com/{REPOSITORY}/pull/59"}}]
        self.run_tick(now=NOW + timedelta(minutes=5))
        self.assertEqual(self.api.messages, [])
        self.assertEqual(self.reload()[0]["execution"]["pull_request"], 59)

    def test_implementation_without_recorded_approval_never_receives_feedback(self):
        self.run_tick()
        self.reload()
        self.data["tasks"][0].pop("proposal_decision")
        self.persist(self.data)
        self.api.values["1"]["state"] = "AWAITING_USER_FEEDBACK"
        self.run_tick(now=NOW + timedelta(minutes=5))
        self.assertEqual(self.api.messages, [])
        self.assertNotIn("feedback_nudge", self.reload()[0]["execution"])

    def test_same_poll_error_preserves_error_timestamp_and_queue_revision(self):
        self.run_tick()
        self.reload()
        del self.api.values["1"]
        self.run_tick(now=NOW + timedelta(minutes=5))
        error = copy.deepcopy(self.reload()[0]["execution"]["last_error"])
        revision = self.github.head("autonomous/state")
        result = self.run_tick(now=NOW + timedelta(minutes=10))
        self.assertEqual(self.github.head("autonomous/state"), revision)
        self.assertEqual(self.reload()[0]["execution"]["last_error"], error)
        self.assertEqual(result["attention"][0]["observed_at"], "2026-09-13T12:10:00Z")
        self.assertEqual(self.api.posts, 1)

    def test_unchanged_active_proposal_does_not_rewrite_provenance_timestamp(self):
        self.run_tick()
        self.reload()
        self.github.add_proposal(59)
        self.api.values["1"]["outputs"] = [{"pullRequest": {"url": f"https://github.com/{REPOSITORY}/pull/59"}}]
        self.run_tick(now=NOW + timedelta(minutes=5))
        before = copy.deepcopy(self.reload())
        self.run_tick(now=NOW + timedelta(minutes=10))
        self.assertEqual(self.reload(), before)
        self.assertEqual((self.reload()[0]["status"], self.api.posts), ("in_progress", 1))

    def test_unchanged_tick_checks_cas_before_external_observation(self):
        self.run_tick()
        self.reload()
        other_queue, other_revision = self.root / "other-queue.json", self.root / "other-revision.json"
        concurrent = load_state(self.repo, other_queue, other_revision)
        concurrent["tasks"].append(task("other"))
        other_queue.write_text(json.dumps(concurrent), encoding="utf-8")
        save_state(self.repo, other_queue, other_revision)
        revision = self.github.head("autonomous/state")
        with patch("lab_controller.get_session", side_effect=AssertionError("API before CAS")):
            with self.assertRaises(StateWriteError):
                self.run_tick(now=NOW + timedelta(minutes=5))
        self.assertEqual(self.github.head("autonomous/state"), revision)
        self.assertEqual(self.api.posts, 1)

    def test_scheduled_research_runs_beside_waiting_implementation_and_backlog(self):
        self.run_tick()
        self.reload()
        self.api.values["1"]["state"] = "AWAITING_USER_FEEDBACK"
        self.run_tick()
        first = copy.deepcopy(self.reload()[0])
        for number in range(40):
            proposal = task("pending-" + str(number))
            proposal.pop("proposal_decision")
            proposal["status"] = "proposed"
            self.data["tasks"].append(proposal)
        self.data["tasks"].append(task("approved-but-not-selected"))
        config = self.research_config()
        result = self.run_tick(task_id="", config=config)
        tasks = self.reload()
        self.assertEqual(result["action"], "dispatched")
        self.assertEqual(tasks[0], first)
        self.assertEqual(tasks[-1]["task_type"], "project_discovery")
        self.assertEqual(tasks[-1]["status"], "in_progress")
        self.assertEqual(tasks[-2]["status"], "todo")
        self.assertEqual(sum(t["status"] == "proposed" for t in tasks), 40)
        self.assertNotIn("automationMode", self.api.values["2"])
        self.assertEqual(len(self.api.messages), 1)
        self.run_tick(task_id="", config=config, now=NOW + timedelta(minutes=5))
        self.assertEqual((self.api.posts, self.reload()[0]), (2, first))

    def test_detached_research_nudge_lost_ack_and_resume_never_duplicate_scope(self):
        config = self.research_config()
        self.run_tick(task_id="", config=config)
        self.reload()
        research = self.data["tasks"][-1]
        identity = copy.deepcopy(research["execution"])
        self.api.values["1"]["state"] = "AWAITING_USER_FEEDBACK"
        self.api.message_status = 0
        self.run_tick(task_id="", config=config, now=NOW + timedelta(minutes=5))
        tasks = self.reload()
        older, newer = tasks[-2:]
        self.assertNotEqual(older["research"]["area_id"], newer["research"]["area_id"])
        self.assertEqual((older["execution"]["feedback_nudge"]["result"], len(self.api.messages)), ("unknown", 1))
        for field in ("session_id", "dispatch_key", "attempts", "base_sha", "starting_branch"):
            self.assertEqual(older["execution"][field], identity[field])
        self.api.values["1"]["state"] = "IN_PROGRESS"
        self.run_tick(task_id="", config=config, now=NOW + timedelta(minutes=10))
        self.assertEqual((self.api.posts, len(self.api.messages)), (2, 1))
        self.assertEqual(self.reload()[-2]["execution"]["session_state"], "IN_PROGRESS")
        self.assertEqual(validate(self.data), [])
        self.api.values["1"]["state"] = "COMPLETED"
        report = {"summary": "Clock boundary checked", "observations": [
            {"scenario": "synthetic resume", "evidence": "time advanced", "result": "expected time"}],
            "next_hypotheses": []}
        self.api.activities["1"] = [{"name": "sessions/1/activities/final", "originator": "agent",
            "createTime": "2026-09-13T12:11:00Z", "agentMessaged": {"agentMessage":
            "AUTONOMOUS_RESEARCH_BEGIN\n" + json.dumps(report) + "\nAUTONOMOUS_RESEARCH_END"}}]
        self.run_tick(task_id="", config=config, now=NOW + timedelta(minutes=15))
        older, newer = self.reload()[-2:]
        self.assertEqual((older["status"], newer["status"]), ("done", "in_progress"))
        self.assertEqual(older["execution"]["session_id"], identity["session_id"])
        self.assertEqual(self.api.posts, 2)

    def test_nudge_requires_durable_intent_and_does_not_repeat_after_restart(self):
        config = self.research_config()
        self.run_tick(task_id="", config=config)
        self.reload()
        self.api.values["1"]["state"] = "AWAITING_USER_FEEDBACK"
        def fail_nudge_intent(data):
            if data["tasks"][-1].get("execution", {}).get("feedback_nudge"):
                raise RuntimeError("state unavailable")
            self.persist(data)
        with self.assertRaises(StateWriteError):
            self.run_tick(task_id="", config=config, persist=fail_nudge_intent)
        self.assertEqual(self.api.messages, [])
        self.reload()
        def lose_nudge_ack(data):
            receipt = data["tasks"][-1].get("execution", {}).get("feedback_nudge") or {}
            if receipt.get("result") == "sent":
                raise RuntimeError("ack state unavailable")
            self.persist(data)
        with self.assertRaises(StateWriteError):
            self.run_tick(task_id="", config=config, persist=lose_nudge_ack)
        self.assertEqual(len(self.api.messages), 1)
        self.assertEqual(self.reload()[-1]["execution"]["feedback_nudge"]["result"], "pending")
        self.run_tick(task_id="", config=config)
        self.assertEqual((self.api.posts, len(self.api.messages)), (2, 1))

    def rejecting_worker(self):
        start(self.data, "first", session_id="7", dispatch_key="reject", now=NOW)
        entry = self.data["tasks"][0]
        entry["execution"].update(base_sha=self.head, starting_branch="autonomous/attempt-reject")
        self.api.values["7"] = session("7", "reject", "AWAITING_USER_FEEDBACK")
        decide(self.data, CONFIG, action="reject", task_id="first", actor="Omnividente",
               note="Do not implement this proposal", now=NOW.isoformat())
        self.persist(self.data)
        return copy.deepcopy(entry["execution"])

    def test_rejection_preserves_worker_until_terminal_and_never_retries(self):
        identity = self.rejecting_worker()
        self.api.message_status = 0
        self.run_tick()
        pending = self.reload()[0]
        self.assertEqual((pending["status"], pending["proposal_decision"]["status"]), ("blocked", "pending"))
        self.run_tick(now=NOW + timedelta(minutes=5))
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 1))
        self.api.values["7"]["state"] = "FAILED"
        self.run_tick(now=NOW + timedelta(minutes=10))
        saved = self.reload()[0]
        self.assertEqual((saved["status"], saved["proposal_decision"]["status"]), ("done", "completed"))
        self.assertEqual(saved["execution"]["session_state"], "FAILED")
        for field in ("attempts", "session_id", "dispatch_key", "started_at", "base_sha", "starting_branch"):
            self.assertEqual(saved["execution"][field], identity[field])
        self.run_tick(now=NOW + timedelta(minutes=15))
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 1))

    def test_rejection_send_requires_cas_and_survives_lost_ack(self):
        self.rejecting_worker()
        def fail_intent(data):
            if data["tasks"][0]["execution"].get("rejection_stop"):
                raise RuntimeError("intent write failed")
            self.persist(data)
        with self.assertRaises(StateWriteError):
            self.run_tick(persist=fail_intent)
        self.assertEqual(self.api.messages, [])
        self.reload()
        def lose_ack(data):
            if (data["tasks"][0]["execution"].get("rejection_stop") or {}).get("result") == "sent":
                raise RuntimeError("ack write failed")
            self.persist(data)
        with self.assertRaises(StateWriteError):
            self.run_tick(persist=lose_ack)
        self.reload()
        self.run_tick(now=NOW + timedelta(minutes=5))
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 1))

    def test_rejection_never_sends_while_disabled_or_accepts_a_racing_pr(self):
        self.rejecting_worker()
        self.github.is_enabled = False
        self.run_tick()
        self.assertEqual(self.api.messages, [])
        self.github.is_enabled = True
        self.github.add_proposal(42)
        self.api.values["7"] = session("7", "reject", "COMPLETED", pull_request=42)
        self.run_tick()
        saved = self.reload()[0]
        self.assertEqual((saved["status"], saved["proposal_decision"]["status"]), ("blocked", "pending"))
        self.assertEqual((self.api.posts, len(self.api.messages), self.github.retargets), (0, 0, 0))
        self.github.proposals[42].update(state="closed", merged=False)
        self.run_tick(now=NOW + timedelta(minutes=5))
        saved = self.reload()[0]
        self.assertEqual((saved["status"], saved["proposal_decision"]["status"]), ("done", "completed"))
        self.assertEqual((saved["execution"]["outcome"], saved["execution"]["pull_request"]), ("closed_unmerged", 42))
        self.assertEqual((self.api.posts, len(self.api.messages), self.github.retargets), (0, 0, 0))

    def broken_research(self):
        entry = self.data["tasks"][0]
        entry.update(task_type="project_discovery")
        entry.pop("proposal_decision")
        start(self.data, "first", session_id="7", dispatch_key="repair", now=NOW)
        entry["execution"].update(base_sha=self.head, starting_branch="autonomous/attempt-repair")
        self.api.values["7"] = session("7", "repair", "COMPLETED")
        self.repair_activity("Final prose without structured report", "old", NOW - timedelta(minutes=1))
        self.persist(self.data)
        return copy.deepcopy(entry["execution"])

    def repair_activity(self, text, identifier, at):
        self.api.activities.setdefault("7", []).append({
            "name": "sessions/7/activities/" + identifier, "createTime": at.isoformat(),
            "originator": "agent", "agentMessaged": {"agentMessage": text},
        })

    def test_unknown_repair_survives_restart_and_automatic_poll_accepts_new_activity(self):
        identity = self.broken_research()
        self.api.message_status = 0
        self.run_tick()
        parked = self.reload()[0]
        error = copy.deepcopy(parked["execution"]["report_error"])
        self.assertEqual(parked["execution"]["report_repair"]["result"], "unknown")
        self.run_tick(now=NOW + timedelta(minutes=5))
        self.assertEqual(self.reload()[0]["execution"]["report_error"], error)
        self.assertNotIn("research_result", self.data["tasks"][0])
        valid = {"summary": "Observed clock", "observations": [
            {"scenario": "resume", "evidence": "synthetic transcript", "result": "clock advanced"}],
            "next_hypotheses": []}
        self.repair_activity("AUTONOMOUS_RESEARCH_BEGIN\n" + json.dumps(valid)
                             + "\nAUTONOMOUS_RESEARCH_END\nAUTONOMOUS_TASKS_BEGIN [] AUTONOMOUS_TASKS_END", "fixed", NOW + timedelta(minutes=6))
        with patch("health_snapshot.gh_get", side_effect=self.snapshot_api):
            self.run_tick(task_id="", automatic=True, now=NOW + timedelta(minutes=10))
        completed = self.reload()[0]
        self.assertEqual(completed["status"], "done")
        self.assertEqual(completed["execution"]["report_repair"]["status"], "resolved")
        self.assertEqual(completed["research_result"]["source"]["activity_id"], "sessions/7/activities/fixed")
        self.assertNotIn("report_error", completed["execution"])
        for field in ("session_id", "dispatch_key", "attempts", "base_sha", "starting_branch"):
            self.assertEqual(completed["execution"][field], identity[field])
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 1))
        self.assertEqual(self.api.messages[0][0], "/v1alpha/sessions/7:sendMessage")

    def test_repair_intent_is_durable_before_effect_and_lost_ack_never_resends(self):
        self.broken_research()
        def fail_intent(data):
            if data["tasks"][0]["execution"].get("report_repair"):
                raise RuntimeError("intent write failed")
            self.persist(data)
        with self.assertRaises(StateWriteError):
            self.run_tick(persist=fail_intent)
        self.assertEqual(self.api.messages, [])
        self.reload()
        def lose_ack(data):
            if (data["tasks"][0]["execution"].get("report_repair") or {}).get("result") == "sent":
                raise RuntimeError("ack write failed")
            self.persist(data)
        with self.assertRaises(StateWriteError):
            self.run_tick(persist=lose_ack)
        self.assertEqual(self.reload()[0]["execution"]["report_repair"]["result"], "pending")
        self.run_tick(now=NOW + timedelta(minutes=5))
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 1))

    def test_second_invalid_report_parks_without_erasing_original_error_or_retrying(self):
        self.broken_research()
        self.run_tick()
        error = copy.deepcopy(self.reload()[0]["execution"]["report_error"])
        self.repair_activity("Still prose", "second-invalid", NOW + timedelta(minutes=1))
        self.run_tick(now=NOW + timedelta(minutes=5))
        saved = self.reload()[0]
        self.assertEqual(saved["execution"]["report_repair"]["status"], "invalid")
        self.assertEqual(saved["execution"]["report_error"], error)
        gets = self.api.gets
        self.run_tick(now=NOW + timedelta(minutes=10))
        self.assertEqual(self.api.gets, gets)
        self.assertEqual((saved["status"], self.api.posts, len(self.api.messages)), ("blocked", 0, 1))
        self.assertNotIn("research_result", saved)

    def test_owner_repeat_repair_retains_receipts_and_never_resends_after_lost_ack(self):
        identity = self.broken_research()
        self.run_tick()
        self.repair_activity("Still prose", "second-invalid", NOW + timedelta(minutes=1))
        self.run_tick(now=NOW + timedelta(minutes=5))
        previous = copy.deepcopy(self.reload()[0]["execution"]["report_repair"])
        before = copy.deepcopy(self.data)
        reads = self.api.gets
        for actor, after in (("stranger", previous["at"]), ("Omnividente", "2026-09-13T10:00:00Z")):
            with self.assertRaises(ValueError):
                self.run_tick(recover_report=True, repair_after=after, actor=actor, now=NOW + timedelta(minutes=10))
            self.assertEqual((self.api.gets, len(self.api.messages)), (reads, 1))
            self.assertEqual(self.data, before)
        def lose_ack(data):
            repair = data["tasks"][0]["execution"]["report_repair"]
            if repair.get("after") == previous["at"] and repair["result"] == "sent":
                raise RuntimeError("repeat acknowledgement lost")
            self.persist(data)
        with self.assertRaises(StateWriteError):
            self.run_tick(persist=lose_ack, recover_report=True, repair_after=previous["at"],
                          actor="Omnividente", now=NOW + timedelta(minutes=10))
        self.reload()
        self.run_tick(recover_report=True, repair_after=previous["at"], actor="Omnividente",
                      now=NOW + timedelta(minutes=11))
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 2))
        valid = {"summary": "Observed clock", "observations": [
            {"scenario": "resume", "evidence": "synthetic transcript", "result": "clock advanced"}],
            "next_hypotheses": []}
        self.repair_activity("AUTONOMOUS_RESEARCH_BEGIN\n" + json.dumps(valid)
                             + "\nAUTONOMOUS_RESEARCH_END\nAUTONOMOUS_TASKS_BEGIN [] AUTONOMOUS_TASKS_END",
                             "fixed", NOW + timedelta(minutes=12))
        self.run_tick(now=NOW + timedelta(minutes=15))
        completed = self.reload()[0]
        self.assertEqual(completed["status"], "done")
        self.assertEqual(completed["execution"]["report_repair_history"], [previous])
        self.assertEqual(completed["research_result"]["source"]["activity_id"], "sessions/7/activities/fixed")
        for field in ("session_id", "dispatch_key", "attempts", "base_sha", "starting_branch"):
            self.assertEqual(completed["execution"][field], identity[field])
        self.run_tick(recover_report=True, repair_after=previous["at"], actor="Omnividente",
                      now=NOW + timedelta(minutes=16))
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 2))

    def test_recovery_does_not_quarantine_unrelated_worker_or_repair_rewritten_activity(self):
        self.broken_research()
        self.run_tick()
        self.repair_activity("Still prose", "second-invalid", NOW + timedelta(minutes=1))
        self.run_tick(now=NOW + timedelta(minutes=5))
        previous = copy.deepcopy(self.reload()[0]["execution"]["report_repair"])
        self.data["tasks"].append(task("unrelated"))
        start(self.data, "unrelated", session_id="8", dispatch_key="other", now=NOW - timedelta(days=1))
        untouched = copy.deepcopy(self.data["tasks"][1])
        self.persist(self.data)
        self.api.activities["7"][-1]["agentMessaged"]["agentMessage"] = "Rewritten same activity"
        self.run_tick(recover_report=True, repair_after=previous["at"], actor="Omnividente",
                      now=NOW + timedelta(minutes=10))
        self.assertEqual(self.reload()[1], untouched)
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 1))
        self.github.is_enabled = False
        self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=11))
        self.assertEqual(self.reload()[1], untouched)

    def test_report_recovery_preserves_unrelated_active_and_rejecting_worker_deadlines(self):
        self.broken_research()
        self.api.message_status = 403
        self.run_tick()
        self.reload()
        self.data["controller"].update(last_tick_at=NOW.isoformat(), run_id="10")
        parked = copy.deepcopy(self.data)
        valid = {"summary": "Observed clock", "observations": [
            {"scenario": "resume", "evidence": "synthetic transcript", "result": "clock advanced"}],
            "next_hypotheses": []}
        self.repair_activity("AUTONOMOUS_RESEARCH_BEGIN\n" + json.dumps(valid)
                             + "\nAUTONOMOUS_RESEARCH_END", "fixed", NOW + timedelta(minutes=1))
        due = NOW + timedelta(minutes=30)

        def health(at):
            return assess_health(self.data, CONFIG, main_sha=self.head, lab_sha=self.head,
                                 main_is_ancestor=True, fingerprints={}, runs=[], sync_runs=[],
                                 pull_requests=[], enabled=True, now=at)

        for rejecting in (False, True):
            with self.subTest(rejecting=rejecting):
                self.data = copy.deepcopy(parked)
                self.data["tasks"].append(task("unrelated"))
                start(self.data, "unrelated", session_id="8", dispatch_key="other", now=NOW)
                worker = self.data["tasks"][1]
                worker["execution"].update(session_state="IN_PROGRESS", observed_at=NOW.isoformat())
                self.api.values["8"] = session("8", "other")
                if rejecting:
                    decide(self.data, CONFIG, action="reject", task_id="unrelated", actor="Omnividente",
                           note="Stop this implementation", now=NOW.isoformat())
                untouched = copy.deepcopy(worker)
                clocks = copy.deepcopy(self.data["controller"])
                self.persist(self.data)
                before = health(due)
                self.assertEqual((before["action"], before["due_at"]),
                                 ("next_task", "2026-09-13T12:30:00Z"))

                result = self.run_tick(recover_report=True, actor="Omnividente", now=due, run_id="11")
                recovered, unrelated = self.reload()
                self.assertEqual(result["attention"], [])
                self.assertEqual(recovered["status"], "done")
                self.assertEqual(recovered["research_result"]["source"]["activity_id"],
                                 "sessions/7/activities/fixed")
                self.assertEqual(unrelated, untouched)
                after = health(due)
                self.assertEqual((after["action"], after["due_at"], after["delay_seconds"]),
                                 ("next_task", before["due_at"], 0))
                self.assertEqual(self.data["controller"], clocks)

                self.run_tick(recover_report=True, actor="Omnividente", now=due + timedelta(minutes=1), run_id="12")
                self.reload()
                repeated = health(due + timedelta(minutes=1))
                self.assertEqual((repeated["action"], repeated["due_at"], repeated["scheduler"]["overdue_seconds"]),
                                 ("next_task", before["due_at"], 60))

    def test_rejected_completed_session_repair_is_parked_without_backup_key_retry(self):
        self.broken_research()
        self.api.message_status = 403
        tick(self.data, CONFIG, repo=self.repo, templates=TEMPLATES, github=self.github,
             persist=self.persist, api_keys=["fixture-primary", "fixture-backup"], transport=self.api,
             api_base="http://localhost/v1alpha", now=NOW, task_id="first")
        saved = self.reload()[0]
        self.assertEqual(saved["execution"]["report_repair"]["status"], "rejected")
        gets = self.api.gets
        self.run_tick(now=NOW + timedelta(minutes=5))
        self.assertEqual(self.api.gets, gets)
        self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=10))
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 1))
        self.assertNotIn("research_result", self.reload()[0])

    def test_disposed_failed_worker_keeps_failed_session_and_exact_report_identity(self):
        original = self.disposed_research()
        self.api.values["7"]["state"] = "FAILED"
        self.repair_activity(self.valid_report().replace("Observed clock", "Later activity"),
                             "later", NOW + timedelta(minutes=2))
        self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=3))
        saved = self.reload()[0]
        self.assertEqual((saved["status"], saved["execution"]["session_state"]), ("done", "FAILED"))
        self.assertEqual(saved["research_result"]["source"], original["execution"]["report_repair"]["source"])
        self.assertEqual(saved["execution"]["attempts"], original["execution"]["attempts"])
        self.assertEqual((self.api.posts, self.api.messages), (0, []))

    def valid_report(self):
        report = {"summary": "Observed clock", "observations": [
            {"scenario": "resume", "evidence": "synthetic transcript", "result": "clock stayed stale"}],
            "next_hypotheses": []}
        finding = {"id": "clock-finding", "title": "Clock remains stale after resume", "task_type": "bugfix",
                   "risk": "low", "target_paths": ["src/clock.ts"], "acceptance": ["Clock advances on resume"],
                   "evidence": {"source": "smoke", "detail": "Clock stayed at the previous time",
                                "reproduction": {"steps": ["Suspend then resume"], "expected": "Current time",
                                                 "actual": "Previous time"}}}
        return ("AUTONOMOUS_RESEARCH_BEGIN\n" + json.dumps(report) + "\nAUTONOMOUS_RESEARCH_END\n"
                + "AUTONOMOUS_TASKS_BEGIN\n" + json.dumps([finding]) + "\nAUTONOMOUS_TASKS_END")

    def disposed_research(self, text=None):
        self.broken_research()
        self.api.activities["7"][0]["agentMessaged"]["agentMessage"] = text or self.valid_report()
        _, source = latest_report(self.api.activities["7"])
        source.update(session_id="7", dispatch_key="repair")
        entry = self.data["tasks"][0]
        entry["status"] = "blocked"
        entry["execution"].update(state="awaiting_report", outcome="report_invalid", session_state="COMPLETED",
            report_error={"code": "findings_invalid", "detail": "prior parser rejected the report",
                          "reported_at": NOW.isoformat(), "source": source},
            report_repair={"at": NOW.isoformat(), "status": "invalid", "result": "sent",
                           "source": source, "detail": "prior parser rejected the repaired report"})
        close_research_unaccepted(self.data, CONFIG, task_id="first", actor="Omnividente",
                                 note="Inspected but not accepted", now=(NOW + timedelta(minutes=1)).isoformat())
        self.persist(self.data)
        return copy.deepcopy(entry)

    def test_recovery_requires_owner_before_any_read_or_persistence(self):
        self.broken_research()
        before = copy.deepcopy(self.data)
        for options in ({"actor": ""}, {"actor": "stranger"}, {"actor": "Omnividente", "automatic": True},
                        {"actor": "Omnividente", "task_id": ""}):
            with self.subTest(options=options), patch.object(self.github, "enabled") as enabled, \
                    patch.object(self, "persist") as persist:
                with self.assertRaises(ValueError):
                    self.run_tick(recover_report=True, **options)
                self.assertEqual(self.data, before)
                self.assertEqual((self.api.gets, self.api.posts, self.api.messages), (0, 0, []))
                enabled.assert_not_called()
                persist.assert_not_called()

    def test_disposed_recovery_selects_saved_older_source_and_retains_history(self):
        original = self.disposed_research()
        self.data["tasks"].append(task("unrelated"))
        self.persist(self.data)
        unrelated = copy.deepcopy(self.data["tasks"][1])
        self.repair_activity(self.valid_report().replace("Observed clock", "Unrequested newer report"),
                             "newer", NOW + timedelta(minutes=2))
        result = self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=3))
        saved = self.reload()[0]
        self.assertEqual(result["attention"], [])
        self.assertEqual((saved["status"], saved["execution"]["outcome"]), ("done", "researched"))
        self.assertEqual(saved["research_result"]["source"], original["execution"]["report_repair"]["source"])
        self.assertEqual(saved["research_result"]["summary"], "Observed clock")
        self.assertEqual(self.data["tasks"][-1]["status"], "proposed")
        self.assertEqual(self.data["tasks"][1], unrelated)
        events = saved["research_disposition"]["events"]
        self.assertEqual([e["action"] for e in events], ["close_unaccepted", "recover_authorized", "report_accepted"])
        self.assertEqual(events[0], original["research_disposition"]["events"][0])
        self.assertEqual(events[-1]["source"], saved["research_result"]["source"])
        for field in ("session_id", "dispatch_key", "attempts", "base_sha", "starting_branch"):
            self.assertEqual(saved["execution"][field], original["execution"][field])
        self.assertEqual((self.api.posts, self.api.messages), (0, []))
        repeated = copy.deepcopy(self.data)
        self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=4))
        self.assertEqual(self.reload(), repeated["tasks"])

    def test_disposed_reparse_failure_never_sends_without_explicit_repair_after(self):
        original = self.disposed_research("Final prose without structured report")
        self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=3))
        saved = self.reload()[0]
        self.assertEqual(saved["research_disposition"]["events"][-1]["action"], "recovery_failed")
        self.assertEqual(saved["execution"], original["execution"])
        self.assertEqual((self.api.posts, self.api.messages), (0, []))
        after = original["execution"]["report_repair"]["at"]
        self.run_tick(recover_report=True, repair_after=after, actor="Omnividente", now=NOW + timedelta(minutes=4))
        pending = self.reload()[0]
        self.assertEqual(pending["research_disposition"]["events"][-1]["mode"], "repair")
        self.assertEqual(pending["execution"]["report_repair"]["after"], after)
        self.assertEqual(len(self.api.messages), 1)
        self.run_tick(recover_report=True, repair_after=after, actor="Omnividente", now=NOW + timedelta(minutes=5))
        self.assertEqual(len(self.api.messages), 1)
        self.repair_activity(self.valid_report(), "fixed", NOW + timedelta(minutes=6))
        self.run_tick(now=NOW + timedelta(minutes=7))
        saved = self.reload()[0]
        self.assertEqual(saved["research_disposition"]["events"][-1]["action"], "report_accepted")
        self.assertEqual(saved["research_disposition"]["events"][0], original["research_disposition"]["events"][0])
        self.assertEqual(saved["execution"]["report_repair_history"], [original["execution"]["report_repair"]])
        self.assertEqual(saved["research_result"]["source"]["activity_id"], "sessions/7/activities/fixed")
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 1))

    def test_disposed_recovery_preserves_anomalies_and_never_repairs_or_retargets(self):
        original = self.disposed_research()
        baseline = copy.deepcopy(self.data)
        activities = copy.deepcopy(self.api.activities)
        for anomaly in ("missing", "rewritten", "empty", "active", "pr", "get_failed"):
            with self.subTest(anomaly=anomaly):
                self.data = copy.deepcopy(baseline)
                self.api.activities = copy.deepcopy(activities)
                self.api.values["7"] = session("7", "repair", "COMPLETED")
                self.persist(self.data)
                if anomaly == "missing":
                    self.api.activities["7"] = []
                elif anomaly == "rewritten":
                    self.api.activities["7"][0]["agentMessaged"]["agentMessage"] += "changed"
                elif anomaly == "empty":
                    self.api.activities["7"][0]["agentMessaged"]["agentMessage"] = ""
                elif anomaly == "active":
                    self.api.values["7"]["state"] = "IN_PROGRESS"
                elif anomaly == "pr":
                    self.api.values["7"] = session("7", "repair", "COMPLETED", pull_request=59)
                if anomaly == "get_failed":
                    with patch("lab_controller.get_session", side_effect=RuntimeError("upstream unavailable")):
                        self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=3))
                else:
                    self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=3),
                                  repair_after=original["execution"]["report_repair"]["at"] if anomaly == "empty" else "")
                saved = self.reload()[0]
                self.assertEqual(saved["research_disposition"]["events"][-1]["action"], "recovery_failed")
                self.assertEqual(saved["execution"]["report_error"], original["execution"]["report_error"])
                self.assertNotIn("research_result", saved)
                self.assertEqual((self.api.posts, self.api.messages, self.github.retargets), (0, [], 0))
                health = assess_health(self.data, CONFIG, main_sha=self.head, lab_sha=self.head,
                    main_is_ancestor=True, fingerprints={}, runs=[], sync_runs=[], pull_requests=[],
                    enabled=True, now=NOW + timedelta(minutes=4))
                self.assertEqual(health["acknowledged"], [])
                self.assertTrue(any(item.get("task_id") == "first" for item in health["attention"]))

    def test_disposed_recovery_authorization_survives_crash_but_not_automatic_resume(self):
        self.disposed_research()
        with patch("lab_controller.get_session", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=3))
        saved = self.reload()[0]
        self.assertEqual(saved["research_disposition"]["events"][-1]["action"], "recover_authorized")
        before = copy.deepcopy(saved)
        self.run_tick(now=NOW + timedelta(minutes=4))
        self.assertEqual(self.reload()[0], before)
        self.assertEqual(self.api.gets, 0)
        self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=5))
        self.assertEqual([event["action"] for event in self.reload()[0]["research_disposition"]["events"]],
                         ["close_unaccepted", "recover_authorized", "report_accepted"])

    def test_disposed_recovery_cas_refuses_stale_authorization_and_acceptance(self):
        self.disposed_research()
        def concurrent_change():
            queue, revision = self.root / "other.json", self.root / "other-revision.json"
            other = load_state(self.repo, queue, revision)
            other["tasks"][0]["title"] += " reviewed"
            queue.write_text(json.dumps(other), encoding="utf-8")
            save_state(self.repo, queue, revision)
        concurrent_change()
        with self.assertRaises(StateWriteError):
            self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=3))
        self.assertEqual(self.api.gets, 0)
        self.assertEqual(self.reload()[0]["research_disposition"]["events"][-1]["action"], "close_unaccepted")
        transport = self.api
        raced = False
        def race_on_report(method, url, headers, payload):
            nonlocal raced
            if urlsplit(url).path.endswith("/activities") and not raced:
                raced = True
                concurrent_change()
            return transport(method, url, headers, payload)
        with self.assertRaises(StateWriteError):
            tick(self.data, CONFIG, repo=self.repo, templates=TEMPLATES, github=self.github,
                 persist=self.persist, api_keys=["fixture-only"], transport=race_on_report,
                 api_base="http://localhost/v1alpha", task_id="first", recover_report=True,
                 actor="Omnividente", now=NOW + timedelta(minutes=4))
        pending = self.reload()[0]
        self.assertNotIn("research_result", pending)
        self.assertEqual(pending["research_disposition"]["events"][-1]["action"], "recover_authorized")
        title = pending["title"]
        self.run_tick(recover_report=True, actor="Omnividente", now=NOW + timedelta(minutes=5))
        saved = self.reload()[0]
        self.assertEqual(saved["title"], title)
        self.assertEqual(saved["status"], "done")
        self.assertEqual([event["action"] for event in saved["research_disposition"]["events"]],
                         ["close_unaccepted", "recover_authorized", "report_accepted"])
        self.assertEqual((self.api.posts, self.api.messages), (0, []))

    def test_historical_report_requires_explicit_enabled_recovery(self):
        self.broken_research()
        self.github.is_enabled = False
        self.run_tick()
        self.reload()
        self.run_tick(recover_report=True, actor="Omnividente")
        self.assertEqual(self.api.messages, [])
        self.github.is_enabled = True
        self.run_tick()
        self.assertEqual(self.api.messages, [])
        self.run_tick(recover_report=True, actor="Omnividente")
        self.assertEqual((self.api.posts, len(self.api.messages)), (0, 1))

    def test_switch_after_repair_intent_prevents_post(self):
        self.broken_research()
        def switch_off(data):
            self.persist(data)
            if data["tasks"][0]["execution"].get("report_repair"):
                self.github.is_enabled = False
        self.run_tick(persist=switch_off)
        self.assertEqual(self.api.messages, [])
        self.assertEqual(self.reload()[0]["execution"]["report_repair"]["status"], "rejected")
        self.github.is_enabled = True
        self.run_tick(recover_report=True, actor="Omnividente")
        self.assertEqual(self.api.messages, [])

    def test_unknown_repair_expires_without_new_attempt_or_resend(self):
        self.broken_research()
        self.api.message_status = 0
        self.run_tick()
        self.reload()
        self.run_tick(now=NOW + timedelta(hours=6))
        saved = self.reload()[0]
        self.assertEqual(saved["execution"]["report_repair"]["status"], "expired")
        gets = self.api.gets
        self.run_tick(now=NOW + timedelta(hours=7))
        self.assertEqual(self.api.gets, gets)
        self.assertEqual((saved["status"], self.api.posts, len(self.api.messages)), ("blocked", 0, 1))

    def test_repair_pull_request_conflict_is_not_accepted_or_retargeted(self):
        self.broken_research()
        self.run_tick()
        self.reload()
        self.github.add_proposal(59, base="main")
        self.api.values["7"]["outputs"] = [{"pullRequest": {"url": f"https://github.com/{REPOSITORY}/pull/59"}}]
        result = self.run_tick(now=NOW + timedelta(minutes=5))
        saved = self.reload()[0]
        self.assertEqual(saved["execution"]["report_repair"]["status"], "conflict")
        self.assertEqual(saved["status"], "blocked")
        self.assertNotIn("research_result", saved)
        self.assertEqual((self.github.retargets, self.api.posts, len(self.api.messages)), (0, 0, 1))
        self.assertIn("pull request", result["attention"][0]["reason"])

    def test_explicit_unapproved_or_foreign_approval_never_creates_worker(self):
        for decision in (None, {"action": "approve", "actor": "foreign",
                               "at": "2026-09-13T11:00:00Z", "note": "Spoofed approval"}):
            with self.subTest(decision=decision):
                if decision is None:
                    self.data["tasks"][0].pop("proposal_decision", None)
                else:
                    self.data["tasks"][0]["proposal_decision"] = decision
                self.run_tick()
                self.assertEqual(self.api.posts, 0)
                self.assertEqual(self.reload()[0]["status"], "todo")


if __name__ == "__main__":
    unittest.main()
