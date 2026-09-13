#!/usr/bin/env python3
"""Real Git histories prove candidate isolation and queue-preserving integration."""
from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sync_main import main, prepare_sync  # noqa: E402
from refresh_proposals import refresh
from task_lifecycle import reserve

CONFIG = {"automation": {"blocking_labels": ["hold", "human-review", "wip", "do-not-merge"]}}
QUEUE = b'{\r\n  "version": 2, "tasks": [], "history": ["lab-owned"]\r\n}\r\n'


class SyncMainTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "core.autocrlf", "false")
        self.git("config", "commit.gpgsign", "false")
        self.commit({"agent_tasks.json": QUEUE, "product.txt": b"first\nbase\nlast\n"})
        self.base = self.sha()
        self.git("branch", "autonomous/lab")
        self.git("update-ref", "refs/remotes/origin/main", self.base)
        self.manifest = self.root / "queue.json"
        self.state_revision = self.root / "revision.json"
        self.manifest.write_text(json.dumps({"version": 2, "autonomous_loop_policy": {}, "tasks": []}), encoding="utf-8")
        self.state_revision.write_text(json.dumps({"state_sha": "e" * 40}), encoding="utf-8")

    def git(self, *args, check=True):
        return subprocess.run(
            ["git", "-C", str(self.repo), *args], check=check,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ).stdout

    def sha(self):
        return self.git("rev-parse", "HEAD").decode().strip()

    def commit(self, files):
        for name, content in files.items():
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        self.git("add", "--all")
        self.git("commit", "-m", "Fixture change")
        return self.sha()

    def advance_main(self, files=None):
        self.git("checkout", "main")
        sha = self.commit(files or {"accepted.txt": b"accepted main product change\n"})
        self.git("update-ref", "refs/remotes/origin/main", sha)
        self.git("checkout", "autonomous/lab")
        return sha

    def snapshot(self):
        return {
            "head": self.sha(),
            "branch": self.git("symbolic-ref", "HEAD"),
            "index": self.git("ls-files", "--stage", "-z"),
            "status": self.git("status", "--porcelain", "--untracked-files=all"),
            "refs": self.git("show-ref"),
            "worktrees": self.git("worktree", "list", "--porcelain"),
            "files": {
                name: (self.repo / name).read_bytes()
                for name in self.git("ls-files", "-z").decode().split("\0") if name
            },
        }

    def prepare(self, main_sha, *, prs=None, lab_sha=""):
        before = self.snapshot()
        result = prepare_sync(
            self.repo, main_sha, self.manifest,
            prs or [], CONFIG, lab_sha=lab_sha,
        )
        self.assertEqual(self.snapshot(), before, "Preparing must not move or dirty the lab")
        return result

    def assert_candidate(self, result, main_sha, lab_sha):
        self.assertEqual(result["status"], "prepared")
        candidate = result["candidate_sha"]
        self.assertEqual(result["main_sha"], main_sha)
        self.assertEqual(result["lab_sha"], lab_sha)
        self.git("merge-base", "--is-ancestor", main_sha, candidate)
        self.git("merge-base", "--is-ancestor", lab_sha, candidate)
        self.assertEqual(
            self.git("show", candidate + ":agent_tasks.json"),
            self.git("show", lab_sha + ":agent_tasks.json"),
        )
        return candidate

    def test_fast_forward_history_is_prepared_not_published(self):
        accepted = self.advance_main()
        original = self.sha()
        candidate = self.assert_candidate(self.prepare(accepted), accepted, original)
        self.assertEqual(self.git("show", candidate + ":accepted.txt"), b"accepted main product change\n")
        self.assertEqual(self.git("rev-parse", "autonomous/lab").decode().strip(), original)
        # The exact object can be fast-forwarded only by a later trusted publisher.
        self.git("merge", "--ff-only", candidate)
        self.assertEqual(self.sha(), candidate)
        self.assertEqual(self.prepare(accepted)["status"], "up_to_date")

    def test_divergent_merge_preserves_both_product_histories(self):
        accepted = self.advance_main({"product.txt": b"main\nbase\nlast\n"})
        original = self.commit({"lab-only.txt": b"accumulated lab work\n"})
        candidate = self.assert_candidate(self.prepare(accepted), accepted, original)
        self.assertEqual(self.git("show", candidate + ":product.txt"), b"main\nbase\nlast\n")
        self.assertEqual(self.git("show", candidate + ":lab-only.txt"), b"accumulated lab work\n")
        self.assertEqual(
            self.git("show", "-s", "--format=%P", candidate).decode().split(), [original, accepted],
        )

    def test_main_queue_change_is_discarded_even_without_a_conflict(self):
        accepted = self.advance_main({
            "agent_tasks.json": b'{"version":2,"tasks":[],"history":["main"]}\n',
            "accepted.txt": b"new product\n",
        })
        candidate = self.assert_candidate(self.prepare(accepted), accepted, self.sha())
        self.assertEqual(self.git("show", candidate + ":agent_tasks.json"), QUEUE)
        self.assertEqual(self.git("show", candidate + ":accepted.txt"), b"new product\n")

    def test_queue_only_conflict_preserves_exact_lab_bytes_and_history(self):
        accepted = self.advance_main({"agent_tasks.json": b'{"tasks":[],"main":true}\n'})
        lab_queue = b'{\r\n "tasks": [], "attempts": [2], "history": ["do not lose me"]\r\n}\r\n'
        original = self.commit({"agent_tasks.json": lab_queue})
        candidate = self.assert_candidate(self.prepare(accepted), accepted, original)
        self.assertEqual(self.git("show", candidate + ":agent_tasks.json"), lab_queue)

    def test_main_queue_deletion_preserves_lab_blob(self):
        self.git("rm", "agent_tasks.json")
        self.git("commit", "-m", "Main deletes its seed")
        accepted = self.sha()
        self.git("update-ref", "refs/remotes/origin/main", accepted)
        self.git("checkout", "autonomous/lab")
        candidate = self.assert_candidate(self.prepare(accepted), accepted, self.sha())
        self.assertEqual(self.git("show", candidate + ":agent_tasks.json"), QUEUE)

    def test_true_conflict_aborts_without_leaving_merge_or_candidate(self):
        accepted = self.advance_main({
            "product.txt": b"main conflicts\n", "agent_tasks.json": b'{"tasks":[],"main":1}\n',
        })
        self.commit({"product.txt": b"lab conflicts\n", "agent_tasks.json": b'{"tasks":[],"lab":1}\n'})
        result = self.prepare(accepted)
        self.assertEqual(result["status"], "conflict")
        self.assertEqual(result["reason"], "merge_conflict")
        self.assertEqual(result["conflicts"], ["product.txt"])
        self.assertEqual(result["candidate_sha"], "")
        self.assertFalse((self.repo / ".git" / "MERGE_HEAD").exists())

    def test_immutable_worker_allows_sync_without_mutating_bound_attempt(self):
        accepted = self.advance_main()
        task = {"id": "fix", "title": "Fix", "task_type": "bugfix", "status": "todo",
                "risk": "low", "priority": 40, "focus": ["quality"],
                "evidence": {"source": "reproduction", "detail": "Observed lost state"}}
        data = {"version": 2, "autonomous_loop_policy": {}, "tasks": [task]}
        reserve(data, "fix", "attempt-one", base_sha=self.base, starting_branch="autonomous/attempt-attempt-one")
        self.manifest.write_text(json.dumps(data), encoding="utf-8")
        before = self.manifest.read_bytes()
        self.assert_candidate(self.prepare(accepted), accepted, self.sha())
        self.assertEqual(self.manifest.read_bytes(), before)
        data["tasks"][0]["execution"].pop("starting_branch")
        data["tasks"][0]["execution"].pop("base_sha")
        data["tasks"][0]["execution"].update(state="dispatched", session_id="legacy-session")
        self.manifest.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(self.prepare(accepted)["status"], "busy")
        data["tasks"][0]["status"] = "blocked"
        data["tasks"][0]["execution"].update(state="quarantined", outcome="stale")
        self.manifest.write_text(json.dumps(data), encoding="utf-8")
        before_head = self.sha()
        self.assertEqual((self.prepare(accepted)["status"], self.sha()), ("busy", before_head))

    def test_open_human_and_foreign_prs_never_block_sync(self):
        accepted = self.advance_main()
        prs = [{"state": "open", "draft": False, "labels": []},
               {"state": "open", "labels": [{"name": "human-review"}]},
               {"state": "open", "labels": ["hold"]}]
        self.assert_candidate(self.prepare(accepted, prs=prs), accepted, self.sha())

    def test_external_state_is_authoritative_not_legacy_product_queue(self):
        accepted = self.advance_main()
        self.commit({"agent_tasks.json": b"immutable legacy content\n"})
        before = self.manifest.read_bytes()
        self.assert_candidate(self.prepare(accepted), accepted, self.sha())
        self.assertEqual(self.manifest.read_bytes(), before)
        self.manifest.write_text('{"tasks": []}', encoding="utf-8")
        self.assertEqual(self.prepare(accepted)["status"], "conflict")

    def test_stale_main_pin_refuses_merge(self):
        self.advance_main()
        result = self.prepare(self.base)
        self.assertEqual((result["status"], result["reason"]), ("conflict", "stale_main"))
        self.assertEqual(result["candidate_sha"], "")

    def test_stale_lab_pin_refuses_merge(self):
        accepted = self.advance_main()
        self.commit({"lab-only.txt": b"newer lab head\n"})
        result = self.prepare(accepted, lab_sha=self.base)
        self.assertEqual((result["status"], result["reason"]), ("conflict", "stale_lab"))
        self.assertEqual(result["candidate_sha"], "")

    def test_main_ancestor_is_noop_even_if_lab_has_more_commits(self):
        self.git("checkout", "autonomous/lab")
        self.commit({"lab-only.txt": b"lab work\n"})
        result = self.prepare(self.base)
        self.assertEqual((result["status"], result["reason"]), ("up_to_date", "main_already_integrated"))
        self.assertEqual(result["candidate_sha"], "")

    def test_dirty_worktree_is_refused_not_cleaned(self):
        accepted = self.advance_main()
        (self.repo / "product.txt").write_bytes(b"uncommitted user change\n")
        result = self.prepare(accepted)
        self.assertEqual(result["reason"], "dirty_worktree")
        self.assertEqual((self.repo / "product.txt").read_bytes(), b"uncommitted user change\n")

    def test_cli_conflict_is_nonzero_and_writes_machine_readable_result(self):
        accepted = self.advance_main({"product.txt": b"main conflict\n"})
        self.commit({"product.txt": b"lab conflict\n"})
        config = self.root / "config.json"
        pulls = self.root / "pulls.json"
        output = self.root / "result.json"
        config.write_text(json.dumps(CONFIG), encoding="utf-8")
        pulls.write_text("[]", encoding="utf-8")
        before = self.snapshot()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main([
                "--repo", str(self.repo), "--main-sha", accepted,
                "--manifest", str(self.manifest), "--state-revision", str(self.state_revision),
                "--pull-requests", str(pulls), "--config", str(config), "--out", str(output),
            ])
        self.assertEqual(code, 1)
        result = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(json.loads(stdout.getvalue()), result)
        self.assertEqual((result["status"], result["conflicts"]), ("conflict", ["product.txt"]))
        self.assertEqual(self.snapshot(), before)


class ProposalRefreshTest(unittest.TestCase):
    def setUp(self):
        self.head = "d" * 40
        self.base = "b" * 40
        self.pr = {"number": 9, "html_url": "https://github.com/owner/repo/pull/9", "state": "open",
                   "base": {"ref": "autonomous/lab", "sha": "c" * 40, "repo": {"full_name": "owner/repo"}},
                   "head": {"ref": "fix-proposal", "sha": self.head, "repo": {"full_name": "owner/repo"}}}
        execution = {"state": "awaiting_review", "outcome": "review_required", "attempts": 1,
                     "session_id": "123", "dispatch_key": "attempt-one", "pull_request": 9,
                     "started_at": "2026-09-13T12:00:00Z"}
        execution["provenance"] = {"session_id": "123", "dispatch_key": "attempt-one", "pull_request": 9,
                                   "url": self.pr["html_url"], "repository": "owner/repo", "base_branch": "autonomous/lab",
                                   "head_repository": "owner/repo", "head_ref": "fix-proposal", "head_sha": self.head,
                                   "verified_at": "2026-09-13T12:00:00Z"}
        self.data = {"version": 2, "autonomous_loop_policy": {}, "tasks": [{
            "id": "fix", "title": "Fix", "task_type": "bugfix", "status": "blocked", "risk": "low",
            "priority": 40, "focus": ["quality"], "evidence": {"source": "reproduction", "detail": "Observed lost state"},
            "execution": execution}]}

    def test_stale_proposal_updates_only_expected_head_and_requires_new_checks(self):
        request = Mock(side_effect=[(200, self.pr), (200, {"status": "diverged"}), (202, {})])
        result = refresh(self.data, "owner/repo", self.base, request=request)
        self.assertEqual(request.call_args_list[1].args, ("GET", f"/repos/owner/repo/compare/{self.base}...{self.head}"))
        self.assertEqual(result["proposals"][0]["outcome"], "refresh_requested")
        self.assertEqual(request.call_args.args, ("PUT", "/repos/owner/repo/pulls/9/update-branch", {"expected_head_sha": self.head}))
        self.assertEqual(result["proposals"][0]["checks"], "new_head_required")

    def test_current_proposal_with_historical_rest_base_needs_no_update(self):
        for status in ("ahead", "identical"):
            with self.subTest(status=status):
                request = Mock(side_effect=[(200, self.pr), (200, {"status": status})])
                result = refresh(self.data, "owner/repo", self.base, request=request)
                self.assertEqual(result["proposals"][0]["outcome"], "current")
                self.assertEqual([call.args for call in request.call_args_list], [
                    ("GET", "/repos/owner/repo/pulls/9"),
                    ("GET", f"/repos/owner/repo/compare/{self.base}...{self.head}"),
                ])

    def test_foreign_head_and_failed_read_never_request_branch_write(self):
        self.pr["head"]["repo"]["full_name"] = "foreign/repo"
        request = Mock(return_value=(200, self.pr))
        result = refresh(self.data, "owner/repo", self.base, request=request)
        self.assertEqual(result["proposals"][0]["outcome"], "untrusted_skipped")
        self.assertEqual([call.args[0] for call in request.call_args_list], ["GET"])
        request = Mock(return_value=(503, {}))
        result = refresh(self.data, "owner/repo", self.base, request=request)
        self.assertEqual(result["outcome"], "attention")
        self.assertEqual([call.args[0] for call in request.call_args_list], ["GET"])

    def test_head_race_is_attention_not_overwrite_or_retry(self):
        request = Mock(side_effect=[(200, self.pr), (200, {"status": "behind"}), (422, {})])
        result = refresh(self.data, "owner/repo", self.base, request=request)
        self.assertEqual(result["outcome"], "attention")
        self.assertEqual(result["proposals"][0]["outcome"], "refresh_conflict")
        self.assertEqual(request.call_count, 3)


if __name__ == "__main__":
    unittest.main()
