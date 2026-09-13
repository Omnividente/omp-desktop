#!/usr/bin/env python3
"""Real Git regressions for queue migration, isolation and competing writers."""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import state_store
from state_store import StateConflict, load_state, save_state


class StateStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.remote = self.root / "remote.git"
        self.repo = self.root / "lab"
        self.git(self.root, "init", "--bare", str(self.remote))
        self.git(self.root, "init", str(self.repo))
        self.git(self.repo, "config", "user.name", "fixture")
        self.git(self.repo, "config", "user.email", "fixture@example.invalid")
        self.git(self.repo, "config", "commit.gpgsign", "false")
        self.seed = b'{\r\n  "version": 2, "autonomous_loop_policy": {}, "tasks": [], "history": ["preserve"]\r\n}\r\n'
        (self.repo / "agent_tasks.json").write_bytes(self.seed)
        (self.repo / "product.txt").write_text("product\n", encoding="utf-8")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "fixture")
        self.git(self.repo, "branch", "-M", "autonomous/lab")
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.git(self.repo, "push", "origin", "HEAD")
        self.head = self.git(self.repo, "rev-parse", "HEAD")
        self.queue = self.root / "queue.json"
        self.revision = self.root / "revision.json"

    def git(self, repo, *args):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", *args],
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()

    def load(self, suffix=""):
        queue = self.root / ("queue" + suffix + ".json")
        revision = self.root / ("revision" + suffix + ".json")
        load_state(self.repo, queue, revision)
        return queue, revision

    def update(self, queue, value):
        data = json.loads(queue.read_bytes())
        data["observation"] = value
        queue.write_text(json.dumps(data), encoding="utf-8")

    def test_migration_preserves_legacy_bytes_without_moving_product(self):
        self.load()
        state_sha = save_state(self.repo, self.queue, self.revision)
        self.assertEqual(self.git(self.repo, "show", state_sha + ":agent_tasks.json"), self.seed.strip())
        self.assertEqual((self.repo / "agent_tasks.json").read_bytes(), self.seed)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/lab"), self.head)
        self.assertEqual(self.git(self.remote, "ls-tree", "--name-only", state_sha), b"agent_tasks.json")
        self.assertEqual(save_state(self.repo, self.queue, self.revision), state_sha)

    def test_first_mutation_retains_exact_legacy_blob_in_state_history(self):
        self.load()
        self.update(self.queue, "first observation")
        saved = save_state(self.repo, self.queue, self.revision)
        original = subprocess.run(["git", "-C", str(self.repo), "show", saved + "^:agent_tasks.json"],
                                  check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
        self.assertEqual(original, self.seed)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/lab"), self.head)
        queue, _ = self.load("-reader")
        self.assertEqual(json.loads(queue.read_bytes())["observation"], "first observation")

    def test_existing_state_is_authoritative_not_reseeded_from_product(self):
        self.load()
        self.update(self.queue, "accepted report")
        saved = save_state(self.repo, self.queue, self.revision)
        (self.repo / "agent_tasks.json").write_text('{"tasks": []}', encoding="utf-8")
        queue, revision = self.load("-reader")
        self.assertEqual(json.loads(queue.read_bytes())["observation"], "accepted report")
        self.assertEqual(json.loads(revision.read_bytes())["state_sha"], saved)

    def test_stale_writer_cannot_overwrite_a_newer_report(self):
        self.load()
        save_state(self.repo, self.queue, self.revision)
        other_queue, other_revision = self.load("-other")
        self.update(self.queue, "first")
        first = save_state(self.repo, self.queue, self.revision)
        self.update(other_queue, "second")
        with self.assertRaises(StateConflict):
            save_state(self.repo, other_queue, other_revision)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), first)
        self.assertEqual(json.loads(other_queue.read_bytes())["observation"], "second")

    def test_concurrent_initialization_never_replaces_winner(self):
        self.load()
        other_queue, other_revision = self.load("-other")
        self.update(self.queue, "first migration")
        save_state(self.repo, self.queue, self.revision)
        self.update(other_queue, "late migration")
        with self.assertRaises(StateConflict):
            save_state(self.repo, other_queue, other_revision)

    def test_lost_push_acknowledgement_is_resolved_by_remote_identity(self):
        self.load()
        real_git = state_store._git

        def lost_ack(repo, *args, **kwargs):
            result = real_git(repo, *args, **kwargs)
            if "push" in args and result.returncode == 0:
                raise subprocess.TimeoutExpired("git push", 90)
            return result

        with patch.object(state_store, "_git", side_effect=lost_ack):
            saved = save_state(self.repo, self.queue, self.revision)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), saved)

    def test_unreachable_remote_does_not_fall_back_to_legacy_seed(self):
        self.git(self.repo, "remote", "set-url", "origin", str(self.root / "absent.git"))
        with self.assertRaises(RuntimeError):
            self.load()
        self.assertFalse(self.queue.exists())

    def test_product_refs_and_product_queue_cannot_be_state_targets(self):
        with self.assertRaises(ValueError):
            load_state(self.repo, self.queue, self.revision, branch="main")
        with self.assertRaises(ValueError):
            load_state(self.repo, self.repo / "agent_tasks.json", self.revision)
        self.assertEqual((self.repo / "agent_tasks.json").read_bytes(), self.seed)


if __name__ == "__main__":
    unittest.main()
