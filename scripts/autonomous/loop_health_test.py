#!/usr/bin/env python3
"""Controller decisions from queue, Git ancestry and actual Actions activity."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from loop_health import assess_health, main, workflow_runs
from research_cycle import plan_research

NOW = datetime(2026, 9, 13, 12, tzinfo=timezone.utc)
MAIN = "a" * 40
LAB = "b" * 40


def settings():
    return {
        "default_branch": "main", "risk_ceiling": "medium",
        "automation": {"blocking_labels": ["human-review", "hold"]},
        "product": {"editable_globs": ["src/**"], "excluded": [], "manual_review_paths": []},
        "research": {
            "enabled": True, "revisit_after_hours": 24, "max_sessions_per_day": 24,
            "areas": [{"id": "terminal", "title": "Terminal", "paths": ["src/terminal.ts"]}],
            "perspectives": [{"id": "behavior", "title": "Behavior", "focus": ["quality"],
                              "instruction": "Observe one isolated scenario."}],
        },
    }


def queue(*tasks):
    return {"version": 2, "autonomous_loop_policy": {"lifecycle": {"max_attempts": 2}}, "tasks": list(tasks)}


def task(**overrides):
    result = {"id": "fix", "title": "Fix observed behavior", "task_type": "bugfix", "status": "todo",
              "risk": "low", "priority": 40, "focus": ["quality"],
              "evidence": {"source": "reproduction", "detail": "Isolated fixture loses a session"}}
    result.update(overrides)
    return result


def run(at=NOW, **overrides):
    value = {"id": 1, "head_branch": "main", "event": "workflow_dispatch", "status": "completed",
             "conclusion": "success", "updated_at": at.isoformat(), "head_sha": MAIN}
    value.update(overrides)
    return value


def health(data=None, config=None, **overrides):
    arguments = dict(main_sha=MAIN, lab_sha=LAB, main_is_ancestor=True,
                     fingerprints={"terminal": "c" * 64}, runs=[run()], sync_runs=[],
                     pull_requests=[], enabled=True, now=NOW)
    arguments.update(overrides)
    return assess_health(data if data is not None else queue(), config or settings(), **arguments)


class DecisionTest(unittest.TestCase):
    def test_disabled_never_wakes_even_with_due_work_and_stale_base(self):
        result = health(queue(task()), enabled=False, main_is_ancestor=False, runs=[])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("disabled", "none", "loop_disabled"))

    def test_due_work_uses_actual_tick_not_queue_creation_or_other_branch_run(self):
        old = run(NOW - timedelta(minutes=91), id=7)
        result = health(queue(task(created_at=NOW.isoformat())), runs=[old, run(id=8, head_branch="feature/untrusted")])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("stalled", "next_task", "work_due"))
        self.assertEqual(result["last_next_task"]["id"], 7)
        self.assertEqual(result["next_task_age_seconds"], 91 * 60)
        boundary = health(queue(task()), runs=[run(NOW - timedelta(minutes=90))])
        self.assertEqual(boundary["health"], "ok")
        self.assertEqual(health(queue(task()), runs=[])["health"], "stalled")
        stuck = health(queue(task()), runs=[run(NOW - timedelta(hours=2), status="queued", conclusion=None)])
        self.assertEqual((stuck["health"], stuck["action"]), ("stalled", "none"))

    def test_empty_queue_is_due_only_when_real_research_planner_allows_it(self):
        result = health(runs=[])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("stalled", "next_task", "research_due"))
        config = settings()
        data, _ = plan_research(queue(), config, {"terminal": "c" * 64}, now=NOW)
        data["tasks"][0].update(status="done", execution={"state": "completed", "outcome": "no_change", "finished_at": NOW.isoformat()})
        data["tasks"][0]["research_result"] = {
            "summary": "No defect observed", "completed_at": NOW.isoformat(),
            "observations": [{"scenario": "Reopen", "evidence": "Synthetic fixture", "result": "State preserved"}],
            "next_hypotheses": ["Try concurrent cancellation"], "proposed_task_ids": [],
        }
        before = copy.deepcopy(data)
        result = health(data, config, runs=[])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("ok", "none", "cooldown"))
        self.assertEqual(result["research_next_at"], "2026-09-14T12:00:00Z")
        self.assertEqual(data, before)
        config["research"]["max_sessions_per_day"] = 1
        self.assertEqual(health(data, config)["reason"], "daily_cap")

    def test_open_pr_idles_while_parked_pr_does_not_block_sync(self):
        pr = {"number": 9, "state": "open", "labels": [], "draft": False}
        result = health(queue(task()), pull_requests=[pr], main_is_ancestor=False, runs=[])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("ok", "none", "open_pull_request"))
        pr["labels"] = [{"name": "human-review"}]
        result = health(queue(task()), pull_requests=[pr], main_is_ancestor=False)
        self.assertEqual((result["action"], result["reason"]), ("sync", "sync_required"))

    def test_active_bound_worker_polls_old_base_without_dispatching_new_attempt(self):
        data = queue(task(status="in_progress", execution={"state": "dispatched", "session_id": "123", "dispatch_key": "attempt-one", "attempts": 1, "started_at": NOW.isoformat()}))
        before = copy.deepcopy(data)
        failed = run(conclusion="failure", display_title="Sync main " + MAIN)
        result = health(data, main_is_ancestor=False, sync_runs=[failed])
        self.assertEqual((result["health"], result["action"], result["reason"], result["delay_seconds"]),
                         ("attention", "next_task", "active_polling", 90))
        self.assertEqual(data, before)
        data["tasks"][0]["execution"].pop("session_id")
        self.assertEqual(health(data)["action"], "none")
        self.assertEqual(health(data)["reason"], "active_session_unbound")

    def test_live_controller_runs_make_wakeups_idempotent(self):
        for status in ("queued", "in_progress", "pending", "waiting", "requested"):
            with self.subTest(status=status):
                self.assertEqual(health(queue(task()), runs=[run(status=status, conclusion=None)])["action"], "none")
                result = health(main_is_ancestor=False, sync_runs=[run(status=status, conclusion=None)])
                self.assertEqual((result["action"], result["reason"]), ("none", "sync_running"))

    def test_same_main_failed_sync_stops_automatic_retries_but_new_revision_can_sync(self):
        failed = run(conclusion="failure", display_title="Sync main " + MAIN, head_sha="d" * 40)
        result = health(main_is_ancestor=False, sync_runs=[failed])
        self.assertEqual((result["health"], result["action"], result["reason"]), ("attention", "none", "sync_failed"))
        self.assertEqual(result["attention"][0]["run"]["conclusion"], "failure")
        result = health(main_is_ancestor=False, main_sha="e" * 40, sync_runs=[failed])
        self.assertEqual((result["action"], result["reason"]), ("sync", "sync_required"))
        result = health(main_is_ancestor=True, sync_runs=[failed])
        self.assertEqual((result["health"], result["action"]), ("ok", "next_task"))

    def test_successful_manual_sync_supersedes_failure_for_same_revision(self):
        failed = run(NOW - timedelta(hours=1), conclusion="failure", display_title="Sync main " + MAIN)
        fixed = run(id=2, display_title="Sync main " + MAIN)
        result = health(main_is_ancestor=False, sync_runs=[fixed, failed])
        self.assertEqual((result["health"], result["action"]), ("ok", "sync"))

    def test_parked_malformed_report_is_visible_but_unrelated_work_can_run(self):
        data, _ = plan_research(queue(), settings(), {"terminal": "c" * 64}, now=NOW)
        data["tasks"][0].update(status="blocked", execution={
            "state": "awaiting_report", "outcome": "report_invalid", "attempts": 1,
            "session_id": "123", "dispatch_key": "attempt-one", "started_at": NOW.isoformat(),
            "report_error": {"code": "research_invalid", "detail": "PRIVATE_WORKER_PROSE secret=never-print", "reported_at": NOW.isoformat()},
        })
        data["tasks"].append(task())
        result = health(data)
        self.assertEqual((result["health"], result["action"], result["reason"]), ("attention", "next_task", "work_due"))
        self.assertEqual(result["attention"], [{"reason": "report_invalid", "task_id": data["tasks"][0]["id"], "observed_at": "2026-09-13T12:00:00Z"}])
        self.assertNotIn("PRIVATE_WORKER_PROSE", json.dumps(result))
        self.assertNotIn("attempt-one", json.dumps(result))
        self.assertNotIn("never-print", json.dumps(result))

    def test_completed_pr_requires_reconciliation_without_mutating_queue(self):
        data = queue(task(status="in_progress", execution={"state": "dispatched", "attempts": 1, "session_id": "123", "pull_request": 9}))
        before = copy.deepcopy(data)
        result = health(data, main_is_ancestor=False, pull_requests=[{"number": 9, "state": "closed", "merged_at": NOW.isoformat()}])
        self.assertEqual((result["action"], result["reason"]), ("next_task", "reconciliation_due"))
        self.assertEqual(data, before)

    def test_workflow_runs_accepts_rest_envelope_and_array(self):
        self.assertEqual(health(runs=workflow_runs({"workflow_runs": [run()]}))["action"], "next_task")
        self.assertEqual(health(runs=workflow_runs([run()]))["action"], "next_task")
        with self.assertRaises(ValueError):
            workflow_runs({"unrelated": []})


class GitReadinessTest(unittest.TestCase):
    def test_cli_observes_real_ancestry_and_preserves_queue_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "lab"
            repo.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-C", str(repo), *args], text=True, stderr=subprocess.DEVNULL).strip()
            git("init", "-b", "main")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            (repo / "product.txt").write_text("base", encoding="utf-8")
            git("add", ".")
            git("commit", "-m", "base")
            initial = git("rev-parse", "HEAD")
            git("branch", "lab")
            (repo / "product.txt").write_text("accepted", encoding="utf-8")
            git("commit", "-am", "accepted main")
            accepted = git("rev-parse", "HEAD")
            git("update-ref", "refs/remotes/origin/main", accepted)
            git("checkout", "lab")
            data = queue(task())
            config = settings()
            config["research"]["enabled"] = False
            paths = {name: root / (name + ".json") for name in ("manifest", "config", "runs", "sync-runs", "pull-requests")}
            for name, value in (("manifest", data), ("config", config), ("runs", [run()]), ("sync-runs", []), ("pull-requests", [])):
                paths[name].write_text(json.dumps(value) + "\n", encoding="utf-8")
            before = paths["manifest"].read_bytes()
            arguments = [value for name, path in paths.items() for value in ("--" + name, str(path))]
            arguments += ["--repo", str(repo), "--enabled", "true", "--now", NOW.isoformat()]
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(arguments), 0)
            result = json.loads(output.getvalue())
            self.assertEqual((result["action"], result["main_sha"], result["lab_sha"]), ("sync", accepted, initial))
            git("merge", "--ff-only", accepted)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(arguments), 0)
            self.assertEqual(json.loads(output.getvalue())["action"], "next_task")
            self.assertEqual(paths["manifest"].read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
