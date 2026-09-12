#!/usr/bin/env python3
"""Coverage rotation, throttling and product-blob identity regressions."""
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

from research_cycle import main, plan_research, scope_fingerprints, validate_config  # noqa: E402
from select_task import select  # noqa: E402

NOW = datetime(2026, 9, 13, 12, tzinfo=timezone.utc)


def config(areas=("terminal", "sessions"), perspectives=("behavior",)):
    return {
        "product": {
            "editable_globs": ["src/**"],
            "excluded": ["src/secret.ts"],
            "manual_review_paths": ["src/updater.ts"],
        },
        "research": {
            "enabled": True, "revisit_after_hours": 24, "max_sessions_per_day": 24,
            "areas": [{"id": area, "title": area, "paths": ["src/" + area + ".ts"]} for area in areas],
            "perspectives": [
                {"id": perspective, "title": perspective, "focus": ["perf"] if perspective == "performance" else ["quality"],
                 "instruction": "Exercise a new isolated scenario and record measurements."}
                for perspective in perspectives
            ],
        },
    }


def manifest(*tasks):
    return {"version": 2, "autonomous_loop_policy": {"lifecycle": {"max_attempts": 2}}, "tasks": list(tasks)}


def concrete(identifier="fix", **overrides):
    task = {
        "id": identifier, "title": "Fix a reproducible defect", "task_type": "bugfix",
        "status": "todo", "priority": 40, "risk": "low", "focus": ["quality"],
        "evidence": {"source": "reproduction", "detail": "Synthetic fixture reproduces lost state"},
    }
    task.update(overrides)
    return task


def fingerprints(settings):
    return {area["id"]: "a" * 64 for area in settings["research"]["areas"]}


def plan(data, settings=None, now=NOW, **kwargs):
    settings = settings or config()
    return plan_research(data, settings, fingerprints(settings), now=now, **kwargs)


def finish(data, now=NOW, outcome="no_change"):
    task = data["tasks"][-1]
    task["status"] = "done"
    task["execution"] = {"state": "completed", "outcome": outcome, "finished_at": now.isoformat()}
    task["research_result"] = {
        "summary": "No defect found in the exercised scenario",
        "observations": [{"scenario": "Cancel and reopen", "evidence": "Isolated fixture retained one session", "result": "State survived"}],
        "next_hypotheses": ["Interrupt a concurrent import instead"], "proposed_task_ids": [],
        "completed_at": now.isoformat(),
    }


class RotationTest(unittest.TestCase):
    def test_completed_no_change_moves_to_another_scope_and_preserves_history(self):
        first, _ = plan(manifest())
        finish(first)
        before = copy.deepcopy(first)
        second, result = plan(first, now=NOW + timedelta(minutes=1))
        self.assertTrue(result["research_changed"])
        self.assertEqual(second["tasks"][-1]["research"]["area_id"], "sessions")
        self.assertEqual(second["tasks"][:-1], before["tasks"])
        self.assertEqual(first, before)

    def test_unchanged_pair_waits_and_revisit_carries_prior_observations(self):
        settings = config(areas=("terminal",))
        first, _ = plan(manifest(), settings)
        finish(first, outcome="researched")
        unchanged, result = plan(first, settings, now=NOW + timedelta(hours=23))
        self.assertIs(unchanged, first)
        self.assertFalse(result["research_changed"])
        self.assertEqual(result["research_reason"], "cooldown")
        self.assertEqual(result["research_next_at"], "2026-09-14T12:00:00Z")
        revisit, result = plan(first, settings, now=NOW + timedelta(hours=24))
        self.assertTrue(result["research_changed"])
        metadata = revisit["tasks"][-1]["research"]
        self.assertEqual(metadata["cycle"], 2)
        self.assertEqual(metadata["previous_reports"], [first["tasks"][0]["research_result"]])

    def test_unvisited_pairs_win_then_least_recent_pair(self):
        settings = config(areas=("terminal",), perspectives=("behavior", "performance"))
        data, _ = plan(manifest(), settings)
        finish(data)
        data, _ = plan(data, settings, now=NOW + timedelta(hours=25))
        self.assertEqual(data["tasks"][-1]["research"]["perspective_id"], "performance")
        finish(data, NOW + timedelta(hours=25))
        data, _ = plan(data, settings, now=NOW + timedelta(hours=50))
        self.assertEqual(data["tasks"][-1]["research"]["perspective_id"], "behavior")

    def test_changed_scope_is_eligible_without_waiting_for_success_cooldown(self):
        settings = config(areas=("terminal",))
        data, _ = plan(manifest(), settings)
        finish(data)
        updated, result = plan_research(data, settings, {"terminal": "b" * 64}, now=NOW)
        self.assertTrue(result["research_changed"])
        self.assertEqual(updated["tasks"][-1]["research"]["fingerprint"], "b" * 64)

    def test_exhausted_research_does_not_respawn_even_on_source_change(self):
        settings = config(areas=("terminal",))
        data, _ = plan(manifest(), settings)
        task = data["tasks"][-1]
        task.update(status="blocked", execution={
            "attempts": 2, "state": "exhausted", "outcome": "failed", "finished_at": NOW.isoformat(),
        })
        unchanged, result = plan_research(data, settings, {"terminal": "b" * 64}, now=NOW)
        self.assertIs(unchanged, data)
        self.assertEqual(result["research_reason"], "cooldown")
        retried, result = plan(data, settings, now=NOW + timedelta(days=1))
        self.assertTrue(result["research_changed"])
        self.assertEqual(retried["tasks"][-1]["research"]["cycle"], 2)


class QueueAndThrottleTest(unittest.TestCase):
    def test_changing_focus_does_not_fill_a_research_backlog(self):
        settings = config(perspectives=("behavior", "performance"))
        data, _ = plan(manifest(), settings, focus=["quality"])
        unchanged, result = plan(data, settings, focus=["perf"])
        self.assertIs(unchanged, data)
        self.assertEqual(result["research_reason"], "research_pending")
        data["tasks"].append(concrete(focus=["perf"]))
        self.assertEqual(select(data, focus=["perf"])["task_id"], "fix")

    def test_concrete_discovery_and_active_work_prevent_minting(self):
        for task in (
            concrete(), concrete(task_type="project_discovery"),
            concrete(status="in_progress", focus=["perf"], risk="high"),
        ):
            with self.subTest(task=task):
                data = manifest(task)
                updated, result = plan(data, focus=["quality"], risk_ceiling="low")
                self.assertIs(updated, data)
                self.assertFalse(result["research_changed"])

    def test_explicit_selection_never_creates_a_phantom_task(self):
        data = manifest()
        updated, result = plan(data, task_id="missing")
        self.assertIs(updated, data)
        self.assertEqual(result["research_reason"], "explicit_task_selection")

    def test_focus_filters_perspectives_and_ineligible_concrete_work(self):
        settings = config(perspectives=("behavior", "performance"))
        data, _ = plan(manifest(concrete(risk="high")), settings, focus=["perf"], risk_ceiling="low")
        self.assertEqual(data["tasks"][-1]["research"]["perspective_id"], "performance")
        self.assertEqual(select(data, focus=["perf"], risk_ceiling="low")["task_id"], data["tasks"][-1]["id"])
        unchanged, result = plan(manifest(), settings, focus=["unknown"])
        self.assertEqual(unchanged["tasks"], [])
        self.assertEqual(result["research_reason"], "focus_mismatch")

    def test_daily_cap_defers_research_but_never_real_work(self):
        settings = config()
        settings["research"]["max_sessions_per_day"] = 1
        data, _ = plan(manifest(), settings)
        finish(data)
        unchanged, result = plan(data, settings, now=NOW + timedelta(hours=1))
        self.assertIs(unchanged, data)
        self.assertEqual(result["research_reason"], "daily_cap")
        self.assertEqual(result["research_next_at"], "2026-09-14T12:00:00Z")
        data["tasks"].append(concrete())
        self.assertEqual(plan(data, settings)[1]["research_reason"], "eligible_work_exists")
        self.assertEqual(select(data)["task_id"], "fix")
        data["tasks"].pop()
        self.assertTrue(plan(data, settings, now=NOW + timedelta(days=1))[1]["research_changed"])

    def test_deferred_manual_review_is_not_an_active_worker(self):
        data, result = plan(manifest(concrete(status="blocked", execution={
            "state": "awaiting_review", "outcome": "review_required", "pull_request": 42,
        })))
        self.assertTrue(result["research_changed"])
        self.assertEqual(len(data["tasks"]), 2)

    def test_oversized_prior_report_keeps_bounded_observation_context(self):
        settings = config(areas=("terminal",))
        data, _ = plan(manifest(), settings)
        finish(data)
        data["tasks"][0]["research_result"]["observations"][0]["evidence"] = "measurement " * 5000
        revisit, _ = plan(data, settings, now=NOW + timedelta(days=1))
        reports = revisit["tasks"][-1]["research"]["previous_reports"]
        self.assertEqual(reports[0]["observations"][0]["scenario"], "Cancel and reopen")
        self.assertEqual(reports[0]["next_hypotheses"], ["Interrupt a concurrent import instead"])
        self.assertLessEqual(len(json.dumps(reports, ensure_ascii=False)), 24000)


class BlobIdentityTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.git("init", "-q")
        (self.repo / "src").mkdir()
        for name in ("terminal", "secret", "updater"):
            (self.repo / "src" / (name + ".ts")).write_text("const value = 1;\n", encoding="utf-8")
        (self.repo / "agent_tasks.json").write_text("{}\n", encoding="utf-8")
        self.commit()
        self.settings = config(areas=("terminal",))
        self.settings["research"]["areas"][0]["paths"] = ["src"]

    def git(self, *args):
        return subprocess.run([
            "git", "-C", str(self.repo), "-c", "user.name=Research Test", "-c", "user.email=research@example.invalid",
            "-c", "commit.gpgsign=false", *args,
        ], check=True, capture_output=True)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def test_queue_and_excluded_commits_do_not_reset_product_coverage(self):
        original = scope_fingerprints(self.settings, self.repo)
        (self.repo / "agent_tasks.json").write_text('{"tasks": []}\n', encoding="utf-8")
        for name in ("secret", "updater"):
            (self.repo / "src" / (name + ".ts")).write_text("const value = 2;\n", encoding="utf-8")
        self.commit()
        self.assertEqual(scope_fingerprints(self.settings, self.repo), original)
        (self.repo / "src" / "terminal.ts").write_text("const value = 2;\n", encoding="utf-8")
        self.commit()
        self.assertNotEqual(scope_fingerprints(self.settings, self.repo), original)

    def test_untracked_files_are_not_product_coverage(self):
        original = scope_fingerprints(self.settings, self.repo)
        (self.repo / "src" / "scratch.ts").write_text("scratch\n", encoding="utf-8")
        self.assertEqual(scope_fingerprints(self.settings, self.repo), original)

    def test_dry_run_and_real_cli_agree_without_preview_mutation(self):
        queue = self.repo / "agent_tasks.json"
        queue.write_text(json.dumps(manifest()), encoding="utf-8")
        trusted = self.repo / "trusted.json"
        trusted.write_text(json.dumps(self.settings), encoding="utf-8")
        arguments = ["--manifest", str(queue), "--config", str(trusted), "--repo", str(self.repo), "--github-output", ""]
        before = queue.read_bytes()
        preview = io.StringIO()
        with contextlib.redirect_stdout(preview):
            self.assertEqual(main([*arguments, "--dry-run"]), 0)
        self.assertEqual(queue.read_bytes(), before)
        expected = json.loads(preview.getvalue())
        self.assertTrue(expected.pop("dry_run"))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(arguments), 0)
        self.assertEqual(json.loads(output.getvalue()), expected)
        self.assertEqual(json.loads(queue.read_text(encoding="utf-8"))["tasks"][0]["id"], expected["research_task_id"])

    def test_empty_or_nonliteral_scope_fails_without_minting(self):
        for path in ("../src", "/src", "src/*.ts", "C:/src"):
            self.settings["research"]["areas"][0]["paths"] = [path]
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate_config(self.settings)
        self.settings["research"]["areas"][0]["paths"] = ["src/secret.ts"]
        with self.assertRaisesRegex(ValueError, "no allowed tracked product blobs"):
            scope_fingerprints(self.settings, self.repo)


if __name__ == "__main__":
    unittest.main(verbosity=2)
