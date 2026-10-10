#!/usr/bin/env python3
"""Real Git regressions for queue migration, isolation and competing writers."""
from __future__ import annotations

import copy
import hashlib

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

    def reader(self, name):
        repo = self.root / name
        self.git(self.root, "clone", "--no-local", "--single-branch", "--branch", "autonomous/lab",
                 str(self.remote), str(repo))
        return repo

    def test_slow_state_fetch_loads_exact_bytes_and_preserves_checkpoint_ancestry(self):
        self.load()
        original = save_state(self.repo, self.queue, self.revision)
        self.update(self.queue, "accepted report")
        expected = self.queue.read_bytes()
        saved = save_state(self.repo, self.queue, self.revision)
        reader = self.reader("slow-reader")
        native_run = subprocess.run

        def slow_fetch(command, **kwargs):
            if "fetch" in command and kwargs.get("timeout", 90) <= 90:
                raise subprocess.TimeoutExpired(command, kwargs["timeout"])
            return native_run(command, **kwargs)

        with patch.object(state_store.subprocess, "run", side_effect=slow_fetch), patch.object(state_store.time, "sleep"):
            data = load_state(reader, self.queue, self.revision)
        self.assertEqual(data["observation"], "accepted report")
        self.assertEqual(self.queue.read_bytes(), expected)
        metadata = json.loads(self.revision.read_bytes())
        self.assertEqual(metadata["state_sha"], saved)
        self.assertEqual(metadata["digest"], hashlib.sha256(expected).hexdigest())
        self.assertEqual(self.git(reader, "show", original + ":agent_tasks.json"), self.seed.strip())
        self.git(reader, "merge-base", "--is-ancestor", original, saved)
        self.assertEqual(self.git(reader, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), saved)

    def test_fetch_retry_retains_original_pin_and_rejects_subsequent_stale_save(self):
        self.load()
        self.update(self.queue, "original accepted report")
        expected = self.queue.read_bytes()
        saved = save_state(self.repo, self.queue, self.revision)
        reader = self.reader("retry-reader")
        native_git = state_store._git
        newer = []

        def interrupted_fetch(repo, *args, **kwargs):
            if repo == reader and "fetch" in args and not newer:
                self.update(self.queue, "newer accepted report")
                newer.append(save_state(self.repo, self.queue, self.revision))
                raise subprocess.TimeoutExpired("git fetch", kwargs.get("timeout", 90))
            return native_git(repo, *args, **kwargs)

        queue, revision = self.root / "retry-queue.json", self.root / "retry-revision.json"
        with patch.object(state_store, "_git", side_effect=interrupted_fetch), patch.object(state_store.time, "sleep"):
            load_state(reader, queue, revision)
        self.assertEqual(queue.read_bytes(), expected)
        self.assertEqual(json.loads(revision.read_bytes())["state_sha"], saved)
        self.update(queue, "stale mutation")
        with self.assertRaises(StateConflict):
            save_state(reader, queue, revision)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), newer[0])
        self.assertEqual(json.loads(self.git(self.remote, "show", newer[0] + ":agent_tasks.json"))["observation"],
                         "newer accepted report")

    def test_exhausted_fetch_leaves_outputs_and_authoritative_state_untouched(self):
        self.load()
        saved = save_state(self.repo, self.queue, self.revision)
        queue_before, revision_before = self.queue.read_bytes(), self.revision.read_bytes()
        native_git = state_store._git
        for failure in (subprocess.TimeoutExpired("git fetch", 180), RuntimeError("state git operation failed: fetch")):
            with self.subTest(failure=type(failure).__name__):
                reader = self.reader("failed-reader-" + type(failure).__name__)
                fetches = []

                def unavailable_fetch(repo, *args, **kwargs):
                    if repo == reader and "fetch" in args:
                        fetches.append(args)
                        raise failure
                    return native_git(repo, *args, **kwargs)

                with patch.object(state_store, "_git", side_effect=unavailable_fetch), patch.object(state_store.time, "sleep"):
                    with self.assertRaises(type(failure)):
                        load_state(reader, self.queue, self.revision)
                self.assertEqual(len(fetches), 2)
                self.assertEqual(self.queue.read_bytes(), queue_before)
                self.assertEqual(self.revision.read_bytes(), revision_before)
                self.assertEqual((reader / "agent_tasks.json").read_bytes(), self.seed)
                self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), saved)

    def test_cached_revision_avoids_fetch_but_never_replaces_fresh_remote_identity(self):
        self.load()
        saved = save_state(self.repo, self.queue, self.revision)
        native_git = state_store._git

        def unavailable_fetch(repo, *args, **kwargs):
            if repo == self.repo and "fetch" in args:
                raise RuntimeError("state git operation failed: fetch")
            return native_git(repo, *args, **kwargs)

        with patch.object(state_store, "_git", side_effect=unavailable_fetch), patch.object(state_store.time, "sleep"):
            queue, revision = self.load("-cached")
            self.assertEqual(queue.read_bytes(), self.seed)
            self.assertEqual(json.loads(revision.read_bytes())["state_sha"], saved)
            writer = self.reader("independent-writer")
            data = load_state(writer, self.queue, self.revision)
            data["observation"] = "new authoritative report"
            self.queue.write_text(json.dumps(data), encoding="utf-8")
            newer = save_state(writer, self.queue, self.revision)
            with self.assertRaises(RuntimeError):
                self.load("-cached")
            self.assertEqual(queue.read_bytes(), self.seed)
            self.assertEqual(json.loads(revision.read_bytes())["state_sha"], saved)
        self.load("-cached")
        self.assertEqual(json.loads(queue.read_bytes())["observation"], "new authoritative report")
        self.assertEqual(json.loads(revision.read_bytes())["state_sha"], newer)

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

    def test_migrated_schema_rejects_stale_save_and_fresh_downgrade(self):
        from research_request import migrate_legacy
        self.load()
        save_state(self.repo, self.queue, self.revision)
        stale_queue, stale_revision = self.load("-old")
        migrated, _ = migrate_legacy(json.loads(self.queue.read_bytes()))
        self.queue.write_text(json.dumps(migrated), encoding="utf-8")
        saved = save_state(self.repo, self.queue, self.revision)
        self.update(stale_queue, "old writer")
        with self.assertRaises(StateConflict):
            save_state(self.repo, stale_queue, stale_revision)
        current, revision = self.load("-fresh")
        downgraded = json.loads(current.read_bytes())
        downgraded["version"] = 2
        downgraded["autonomous_loop_policy"].pop("research_contract")
        current.write_text(json.dumps(downgraded), encoding="utf-8")
        with self.assertRaises(ValueError):
            save_state(self.repo, current, revision)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), saved)

    def test_rehashed_request_rewrite_cannot_pass_cas_but_real_retry_preserves_history(self):
        from research_request import sha256_json
        from research_request_test import research, reserve_research
        from task_lifecycle import complete
        self.load()
        data = json.loads(self.queue.read_bytes())
        data["tasks"] = [research()]
        original = reserve_research(data)
        self.queue.write_text(json.dumps(data), encoding="utf-8")
        saved = save_state(self.repo, self.queue, self.revision)
        forged = copy.deepcopy(data)
        request = forged["tasks"][0]["execution"]["research_request"]
        request["request"]["title"] += " rewritten"
        request["request_sha256"] = sha256_json(request["request"])
        self.queue.write_text(json.dumps(forged), encoding="utf-8")
        with self.assertRaises(ValueError):
            save_state(self.repo, self.queue, self.revision)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), saved)
        complete(data, "research", outcome="failed")
        self.queue.write_text(json.dumps(data), encoding="utf-8")
        save_state(self.repo, self.queue, self.revision)
        reserve_research(data)
        self.queue.write_text(json.dumps(data), encoding="utf-8")
        save_state(self.repo, self.queue, self.revision)
        queue, _ = self.load("-reader")
        execution = json.loads(queue.read_bytes())["tasks"][0]["execution"]
        self.assertEqual(execution["attempts"], 2)
        self.assertEqual(execution["research_request_history"][0]["research_request"], original)

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

    def test_required_ack_diagnostics_identify_saved_commit_without_authorizing_success(self):
        from checkpoint_diagnostics import diagnostic_for_failure, validate_diagnostics
        self.load()
        expected = save_state(self.repo, self.queue, self.revision)
        self.update(self.queue, "durable synthetic observation")
        native_run = state_store.subprocess.run
        pushes = []

        def saved_without_ack(command, **kwargs):
            result = native_run(command, **kwargs)
            if "push" in command:
                pushes.append(command)
                raise subprocess.TimeoutExpired(["SENTINEL_SECRET_URL"], 90,
                                                output=b"SENTINEL_STDOUT", stderr=b"SENTINEL_STDERR")
            return result

        with patch.object(state_store.subprocess, "run", side_effect=saved_without_ack):
            with self.assertRaises(state_store.StateUncertain) as caught:
                save_state(self.repo, self.queue, self.revision, require_ack=True)
        saved = self.git(self.remote, "rev-parse", "autonomous/state").decode()
        value = diagnostic_for_failure("research_planner", caught.exception)
        self.assertTrue(validate_diagnostics(value))
        self.assertEqual(len(pushes), 1)
        self.assertNotEqual(saved, expected)
        self.assertEqual(value["expected_state_sha"], expected)
        self.assertEqual(value["observed_state_sha"], saved)
        self.assertEqual(value["exception_category"], "state_uncertain")
        self.assertEqual(value["git_operation"], "push")
        self.assertIsNone(value["git_returncode"])
        self.assertIs(value["git_timeout"], True)
        self.assertIs(value["acknowledgement_uncertain"], True)
        self.assertNotIn("SENTINEL", json.dumps(value))
        self.assertEqual(json.loads(self.revision.read_bytes())["state_sha"], saved)

    def test_conflict_diagnostics_retain_both_known_revisions_without_publication(self):
        from checkpoint_diagnostics import diagnostic_for_failure
        self.load()
        expected = save_state(self.repo, self.queue, self.revision)
        stale_queue, stale_revision = self.load("-diagnostic-stale")
        self.update(self.queue, "winner")
        observed = save_state(self.repo, self.queue, self.revision)
        self.update(stale_queue, "loser")
        with self.assertRaises(StateConflict) as caught:
            save_state(self.repo, stale_queue, stale_revision, require_ack=True)
        value = diagnostic_for_failure("dispatch_reservation", caught.exception)
        self.assertEqual(value["exception_category"], "state_conflict")
        self.assertEqual(value["expected_state_sha"], expected)
        self.assertEqual(value["observed_state_sha"], observed)
        self.assertIs(value["acknowledgement_uncertain"], False)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), observed)

    def test_failed_publication_without_remote_observation_stays_unknown(self):
        from checkpoint_diagnostics import diagnostic_for_failure
        self.load()
        expected = save_state(self.repo, self.queue, self.revision)
        self.update(self.queue, "unpublished")
        native_run = state_store.subprocess.run
        pushed = []

        def unavailable(command, **kwargs):
            if "push" in command:
                pushed.append(command)
                return subprocess.CompletedProcess(command, 1, b"SENTINEL_OUT", b"SENTINEL_PUSH")
            if pushed and "ls-remote" in command:
                return subprocess.CompletedProcess(command, 128, b"", b"SENTINEL_REMOTE")
            return native_run(command, **kwargs)

        with patch.object(state_store.subprocess, "run", side_effect=unavailable):
            with self.assertRaises(RuntimeError) as caught:
                save_state(self.repo, self.queue, self.revision, require_ack=True)
        value = diagnostic_for_failure("research_planner", caught.exception)
        self.assertEqual(value["git_operation"], "ls-remote")
        self.assertEqual(value["git_returncode"], 128)
        self.assertEqual(value["expected_state_sha"], expected)
        self.assertIsNone(value["observed_state_sha"])
        self.assertIs(value["acknowledgement_uncertain"], True)
        self.assertNotIn("SENTINEL", json.dumps(value))
        self.assertEqual(len(pushed), 1)
        self.assertEqual(self.git(self.remote, "rev-parse", "autonomous/state").decode(), expected)

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
