#!/usr/bin/env python3
"""Full snapshot comparison with real disposable Git, never the live queue."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import owner_fence_proof as proof


def context(before_sha):
    return {"repository": proof.REPOSITORY, "workflow": proof.WORKFLOW,
            "ref": "refs/heads/main", "event_name": "workflow_dispatch",
            "control_sha": "a" * 40, "run_id": "10", "run_attempt": "1", "actor": "owner-a",
            "expected_state_sha": before_sha, "decision_id": "d" * 64}


def fence(before, ctx, after_sha="b" * 40):
    """Synthetic envelope for comparator tests; not native authority evidence."""
    after = copy.deepcopy(before)
    event = {"type": "OwnerFence", "at": "2026-10-26T00:00:00Z",
             "decision_id": ctx["decision_id"], "kind": "owner_revoked_unclaimed",
             "owner_trigger": ctx, "before_state_sha": ctx["expected_state_sha"],
             "before_digest": "c" * 64, "frontier_seq": 1}
    event["receipt_id"] = proof.digest([ctx["decision_id"], proof.digest(["workflow_dispatch", ctx["run_id"]]),
        "owner_revoked_unclaimed", {"owner_trigger": ctx, "before_state_sha": ctx["expected_state_sha"],
                                   "before_digest": event["before_digest"]}])
    event["event_id"] = proof.digest(event)
    after["dispatch_journal"]["events"].append(event)
    result = {"outcome": "fenced", "decision_id": ctx["decision_id"], "state_sha": after_sha,
              "frontier_seq": 1, "receipt_id": event["receipt_id"]}
    return after, result


class ProofTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo, self.remote = self.root / "repo", self.root / "remote.git"
        self.cmd(self.root, "init", "--bare", str(self.remote))
        self.cmd(self.root, "init", str(self.repo))
        self.cmd(self.repo, "config", "user.name", "synthetic")
        self.cmd(self.repo, "config", "user.email", "fixture@example.invalid")
        self.cmd(self.repo, "config", "commit.gpgsign", "false")
        self.cmd(self.repo, "remote", "add", "origin", str(self.remote))
        self.before = {"version": 2, "tasks": [{"id": "original", "attempt": 1}],
                       "controller": {"at": "retain this", "owner_decisions": ["original"]},
                       "unknown_future_field": {"nested": [False, 0, "keep"]},
                       "dispatch_journal": {"version": 1, "events": [{"type": "synthetic-prefix"}]}}
        self.sha = self.publish(self.before)
        self.ctx = context(self.sha)

    def cmd(self, repo, *args, data=None):
        return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
                              input=data, capture_output=True, check=True).stdout

    def publish(self, obj, parent=None, raw=None, extra=False):
        raw = proof.canonical(obj) if raw is None else raw
        blob = self.cmd(self.repo, "hash-object", "-w", "--stdin", data=raw).decode().strip()
        tree_input = "100644 blob " + blob + "\tagent_tasks.json\n"
        if extra:
            tree_input += "100644 blob " + blob + "\tunrelated.json\n"
        tree = self.cmd(self.repo, "mktree", data=tree_input.encode()).decode().strip()
        args = ["commit-tree", tree] + (["-p", parent] if parent else [])
        commit = self.cmd(self.repo, *args, data=b"synthetic proof fixture\n").decode().strip()
        self.cmd(self.repo, "push", "--force", "origin", commit + ":" + proof.STATE_REF)
        return commit

    def settled(self):
        baseline = proof.prepare(self.repo, self.sha, self.ctx)
        after, result = fence(self.before, self.ctx)
        result["state_sha"] = self.publish(after, self.sha)
        return baseline, after, result

    def test_full_git_readback_and_bounded_result(self):
        baseline, _, result = self.settled()
        report = proof.verify(self.repo, baseline, result, self.ctx)
        self.assertEqual(report["status"], "verified")
        self.assertTrue(report["allows_sync"])
        self.assertEqual(report["before"]["commit_sha"], self.sha)
        self.assertEqual(report["after"]["commit_sha"], result["state_sha"])
        self.assertEqual(report["checks"]["added_event_count"], 1)
        self.assertLess(len(proof.canonical(report)), proof.MAX_METADATA)
        self.assertNotIn(b"retain this", proof.canonical(report))

    def test_every_body_field_including_timestamps_and_types_is_protected(self):
        after, result = fence(self.before, self.ctx)
        mutations = [lambda a: a["tasks"][0].update(attempt=2),
                     lambda a: a["controller"].update(at="changed"),
                     lambda a: a["controller"]["owner_decisions"].clear(),
                     lambda a: a["unknown_future_field"]["nested"].__setitem__(0, 0),
                     lambda a: a.update(unexpected="new"), lambda a: a.pop("tasks")]
        for change in mutations:
            changed = copy.deepcopy(after); change(changed)
            with self.subTest(change=change), self.assertRaises(ValueError):
                proof.compare_full_states(self.before, changed, result, self.ctx)

    def test_journal_prefix_header_and_exactly_one_event(self):
        after, result = fence(self.before, self.ctx)
        changes = [lambda a: a["dispatch_journal"]["events"][0].update(type="rewritten"),
                   lambda a: a["dispatch_journal"].update(version=2),
                   lambda a: a["dispatch_journal"]["events"].pop(0),
                   lambda a: a["dispatch_journal"]["events"].append({}),
                   lambda a: a["dispatch_journal"]["events"].pop()]
        for change in changes:
            changed = copy.deepcopy(after); change(changed)
            with self.subTest(change=change), self.assertRaises(ValueError):
                proof.compare_full_states(self.before, changed, result, self.ctx)

    def test_wrong_receipt_run_decision_pin_and_foreign_event_fail(self):
        after, result = fence(self.before, self.ctx)
        changes = [lambda e: e.update(type="EffectObservation"),
                   lambda e: e.update(decision_id="e" * 64),
                   lambda e: e.update(before_state_sha="f" * 40),
                   lambda e: e["owner_trigger"].update(run_id="99"),
                   lambda e: e.update(receipt_id="0" * 64),
                   lambda e: e.update(frontier_seq=True),
                   lambda e: e.update(extra="not allowed")]
        for change in changes:
            changed = copy.deepcopy(after); change(changed["dispatch_journal"]["events"][-1])
            with self.subTest(change=change), self.assertRaises(ValueError):
                proof.compare_full_states(self.before, changed, result, self.ctx)

    def test_unknown_ack_blocked_and_replay_cannot_be_success_proof(self):
        baseline, _, result = self.settled()
        for outcome in ("blocked", "unknown", "already_fenced"):
            r = {**result, "outcome": outcome}
            with self.subTest(outcome=outcome), self.assertRaises(ValueError):
                proof.verify(self.repo, baseline, r, self.ctx)
        with self.assertRaises(ValueError):
            proof.compare_full_states(self.before, self.before, {}, self.ctx)

    def test_baseline_metadata_or_run_tampering(self):
        baseline, _, result = self.settled()
        for change in (lambda b: b["before"].update(blob_sha="0" * 40),
                       lambda b: b["before"].update(sha256="0" * 64),
                       lambda b: b["context"].update(run_attempt="2")):
            changed = copy.deepcopy(baseline); change(changed)
            with self.subTest(change=change), self.assertRaises(ValueError):
                proof.verify(self.repo, changed, result, self.ctx)

    def test_moved_state_before_and_after_is_not_rebased(self):
        baseline, after, result = self.settled()
        with self.assertRaises(ValueError): proof.prepare(self.repo, self.sha, self.ctx)
        after["controller"]["at"] = "competing writer"
        self.publish(after, result["state_sha"])
        with self.assertRaises(ValueError): proof.verify(self.repo, baseline, result, self.ctx)

    def test_wrong_parent_is_rejected(self):
        baseline = proof.prepare(self.repo, self.sha, self.ctx)
        after, result = fence(self.before, self.ctx)
        result["state_sha"] = self.publish(after)  # No baseline parent.
        with self.assertRaises(ValueError): proof.verify(self.repo, baseline, result, self.ctx)

    def test_large_snapshot_never_becomes_large_report(self):
        # Comparable to the reported 66,963,389-byte live file, no real data.
        self.before["payload"] = "SYNTHETIC-PRIVATE-DATA-" + "x" * 67_000_000
        self.sha = self.publish(self.before); self.ctx = context(self.sha)
        baseline, _, result = self.settled()
        report = proof.verify(self.repo, baseline, result, self.ctx)
        self.assertGreater(report["before"]["bytes"], 66_963_389)
        self.assertLess(len(proof.canonical(report)), proof.MAX_METADATA)
        self.assertNotIn(b"SYNTHETIC-PRIVATE-DATA", proof.canonical(report))

    def test_duplicate_keys_nonfinite_and_nonobject_rejected(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1e999}', b'[]', b'{"a":{"x":1,"x":1}}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError): proof.strict_json(raw)

    def test_extra_tree_entries_and_noncommit_rejected(self):
        extra = self.publish(self.before, self.sha, extra=True)
        with self.assertRaises(ValueError): proof.snapshot(self.repo, extra)
        tree = self.cmd(self.repo, "rev-parse", extra + "^{tree}").decode().strip()
        with self.assertRaises(ValueError): proof.snapshot(self.repo, tree)

    def test_exclusive_bounded_retention(self):
        path = self.root / "proof.json"
        proof.write_record(path, {"ok": True})
        with self.assertRaises(FileExistsError): proof.write_record(path, {"ok": False})
        self.assertEqual(proof.small_record(path), {"ok": True})
        with self.assertRaises(ValueError): proof.write_record(self.root / "large", {"v": "x" * 9000})

    def test_cli_rejects_non_native_context_without_queue_data_in_output(self):
        run = subprocess.run([sys.executable, str(Path(proof.__file__)), "before",
                              "--repo", str(self.repo), "--expected-state-sha", self.sha,
                              "--decision-id", "d" * 64, "--baseline", str(self.root / "baseline")],
                             env={"PATH": os.environ.get("PATH", "")}, capture_output=True, text=True)
        self.assertEqual(run.returncode, 1)
        self.assertIn('"allows_sync":false', run.stdout)
        self.assertNotIn("retain this", run.stdout + run.stderr)
        self.assertFalse((self.root / "baseline").exists())

    def test_workflow_runs_native_gate_between_before_and_after(self):
        path = Path(__file__).resolve().parents[2] / ".github/workflows/autonomous_recover_delivery.yml"
        text = path.read_text()
        self.assertLess(text.index("owner_fence_proof.py before"), text.index("recover_delivery.py"))
        self.assertLess(text.index("recover_delivery.py"), text.index("owner_fence_proof.py after"))
        self.assertIn("set -euo pipefail", text)
        self.assertIn("owner-fence-proof.json", text)
        self.assertNotIn("continue-on-error:", text)


@unittest.skipUnless(Path(__file__).with_name("dispatch_journal_test.py").exists(),
                     "full repository native fixtures unavailable in local source-only sandbox")
class NativeIntegrationTests(unittest.TestCase):
    def test_real_native_fence_and_git_CAS_then_independent_full_comparison(self):
        # Hosted Control CI has the complete tree. This is the actual native
        # JournalStore, with a disposable bare remote, not mocked CAS/effects.
        from dispatch_journal_test import JournalTests
        fixture = JournalTests("runTest")
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        intent, _ = fixture.reserve()
        sha = fixture.store.current()["state_sha"]
        ctx = fixture.owner_trigger(intent, sha)
        baseline = proof.prepare(fixture.repo, sha, ctx)
        result = fixture.fence(fixture.store, intent, sha, trigger=ctx)
        report = proof.verify(fixture.repo, baseline, result, ctx)
        self.assertTrue(report["allows_sync"])
        self.assertEqual(report["checks"]["native_receipt_id"], result["receipt_id"])
        replay = fixture.fence(fixture.store, intent, sha, trigger=ctx)
        self.assertEqual(replay["outcome"], "already_fenced")
        with self.assertRaises(ValueError): proof.verify(fixture.repo, baseline, replay, ctx)


if __name__ == "__main__":
    unittest.main()
