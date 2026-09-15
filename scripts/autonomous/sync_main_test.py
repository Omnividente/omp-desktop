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

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sync_main import main, prepare_sync  # noqa: E402

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
            self.repo, main_sha, self.repo / "agent_tasks.json",
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

    def test_active_worker_blocks_sync_without_mutating_bound_attempt(self):
        accepted = self.advance_main()
        bound = {"tasks": [{"status": "in_progress", "execution": {
            "attempts": 2, "session_id": "bound-session", "dispatch_key": "same-attempt",
        }}]}
        self.commit({"agent_tasks.json": json.dumps(bound).encode()})
        result = self.prepare(accepted)
        self.assertEqual((result["status"], result["reason"]), ("busy", "active_task"))
        self.assertEqual(result["candidate_sha"], "")

    def test_active_pr_blocks_but_parked_prs_do_not(self):
        accepted = self.advance_main()
        result = self.prepare(accepted, prs=[{"state": "open", "draft": False, "labels": []}])
        self.assertEqual((result["status"], result["reason"]), ("busy", "active_pull_request"))
        parked = [
            {"state": "open", "draft": True},
            {"state": "open", "labels": [{"name": "human-review"}]},
            {"state": "open", "labels": ["hold"]},
            {"state": "closed", "labels": []},
        ]
        self.assert_candidate(self.prepare(accepted, prs=parked), accepted, self.sha())

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
                "--manifest", str(self.repo / "agent_tasks.json"),
                "--pull-requests", str(pulls), "--config", str(config), "--out", str(output),
            ])
        self.assertEqual(code, 1)
        result = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(json.loads(stdout.getvalue()), result)
        self.assertEqual((result["status"], result["conflicts"]), ("conflict", ["product.txt"]))
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
