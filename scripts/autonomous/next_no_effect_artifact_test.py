#!/usr/bin/env python3
"""Synthetic in-memory source authentication and native-purpose boundaries."""
from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import stat
import unittest
import zipfile
from unittest.mock import patch

import next_no_effect_artifact as proof

REPOSITORY = "synthetic/native-pause"
CONTROL = "a" * 40
STATE = "b" * 40
DECISION = "c" * 64
KEY = "d" * 32
TRIGGER = {"run_id": "71", "run_attempt": "1", "event_name": "workflow_dispatch",
           "control_sha": CONTROL, "repository": REPOSITORY, "actor": "synthetic-owner"}


def zip_bytes(raw, *, filename="lab-result.json", extra=None, mode=None,
              compression=zipfile.ZIP_DEFLATED):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as archive:
        member = zipfile.ZipInfo(filename, date_time=(2026, 1, 1, 0, 0, 0))
        member.compress_type = compression
        if mode is not None:
            member.create_system = 3
            member.external_attr = mode << 16
        archive.writestr(member, raw)
        if extra is not None:
            second_name, second_raw = extra
            second = second_name if isinstance(second_name, zipfile.ZipInfo) else zipfile.ZipInfo(
                second_name, date_time=(2026, 1, 1, 0, 0, 0))
            archive.writestr(second, second_raw)
    return output.getvalue()


class SyntheticSource:
    def __init__(self):
        self.calls = []
        self.downloads = []
        self.run_reads = 0
        self.final_run = None
        self.page_override = {}
        self.report = {
            "observed_at": "2026-01-01T00:00:00Z", "action": "none", "reason": "sync_running",
            "attention": [{"task_id": f"synthetic-task-{index}", "reason": "report_invalid",
                           "detail": "Synthetic descriptive attention."} for index in range(6)],
            "proposals": [], "observations": [], "waiting_workers": [], "research": {},
            "merge_mode": "manual", "automatic": True, "skipped": True,
            "scheduler": {"next_due_at": "2026-01-01T00:10:00Z"},
            "decision_id": DECISION, "state_sha": STATE,
        }
        self.run = {
            "id": 71, "run_attempt": 1, "event": "workflow_dispatch", "head_branch": "main",
            "head_sha": CONTROL, "path": ".github/workflows/autonomous_next_task.yml",
            "display_title": "Next " + KEY, "workflow_id": 91,
            "status": "completed", "conclusion": "failure",
            "repository": {"id": 81, "full_name": REPOSITORY},
            "head_repository": {"id": 81, "full_name": REPOSITORY},
            "actor": {"id": 101, "login": TRIGGER["actor"]},
            "triggering_actor": {"id": 101, "login": TRIGGER["actor"]},
        }
        self.attempt = copy.deepcopy(self.run)
        names = ["Authenticate the frozen receiver controller",
                 "Check out the authenticated receiver revision", "Verify the laboratory policy",
                 proof.NATIVE_STEP, proof.UPLOAD_STEP]
        self.jobs = [{
            "id": 201, "run_id": 71, "head_sha": CONTROL, "head_branch": "main",
            "name": proof.NATIVE_JOB,
            "status": "completed", "conclusion": "failure",
            "steps": [{"name": name, "number": number, "status": "completed",
                       "conclusion": "failure" if name == proof.NATIVE_STEP else "success",
                       "started_at": f"2026-01-01T00:00:{number * 2:02}Z",
                       "completed_at": f"2026-01-01T00:00:{number * 2 + 1:02}Z"}
                      for number, name in enumerate(names, 1)],
        }]
        self.artifacts = [{
            "id": 301, "name": "laboratory-result-71-1", "expired": False,
            "workflow_run": {"id": 71, "repository_id": 81, "head_repository_id": 81,
                             "head_branch": "main", "head_sha": CONTROL},
        }]
        self.set_report(self.report)

    def set_report(self, report):
        self.report = copy.deepcopy(report)
        self.raw = json.dumps(self.report, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.set_archive(zip_bytes(self.raw))

    def set_archive(self, archive):
        self.archive = archive
        self.artifacts[0].update(size_in_bytes=len(archive),
                                 digest="sha256:" + hashlib.sha256(archive).hexdigest())
        self.detail = copy.deepcopy(self.artifacts[0])

    def get_json(self, endpoint):
        self.calls.append(endpoint)
        if endpoint in self.page_override:
            result = self.page_override[endpoint]
            if isinstance(result, Exception):
                raise result
            return copy.deepcopy(result)
        if endpoint == "actions/runs/71":
            self.run_reads += 1
            result = self.final_run if self.run_reads > 1 and self.final_run is not None else self.run
        elif endpoint == "actions/runs/71/attempts/1":
            result = self.attempt
        elif endpoint == "actions/workflows/91":
            result = {"id": 91, "path": ".github/workflows/autonomous_next_task.yml"}
        elif endpoint == "actions/artifacts/301":
            result = self.detail
        elif endpoint.startswith("actions/runs/71/attempts/1/jobs?per_page=100&page="):
            page = int(endpoint.rsplit("=", 1)[1])
            result = {"total_count": len(self.jobs), "jobs": self.jobs[(page - 1) * 100:page * 100]}
        elif endpoint.startswith("actions/runs/71/artifacts?per_page=100&page="):
            page = int(endpoint.rsplit("=", 1)[1])
            result = {"total_count": len(self.artifacts),
                      "artifacts": self.artifacts[(page - 1) * 100:page * 100]}
        else:
            raise AssertionError("unexpected synthetic GET endpoint")
        return copy.deepcopy(result)

    def get_archive(self, endpoint):
        self.downloads.append(endpoint)
        if endpoint != "actions/artifacts/301/zip":
            raise AssertionError("unexpected synthetic archive GET")
        return self.archive

    def active_polling(self):
        self.jobs[0]["conclusion"] = "success"
        for step in self.jobs[0]["steps"]:
            step["conclusion"] = "success"
        names = ("Check out the trusted continuation controller",
                 "Hand off outside the queue writer lock", "Retain observed handoff")
        self.jobs.append({
            "id": 202, "run_id": self.run["id"], "head_sha": self.run["head_sha"], "head_branch": "main",
            "name": "handoff", "status": "completed", "conclusion": "failure",
            "steps": [{"name": name, "number": number, "status": "completed",
                       "conclusion": "failure" if number == 2 else "success",
                       "started_at": f"2026-01-01T00:00:{20 + number * 2:02}Z",
                       "completed_at": f"2026-01-01T00:00:{21 + number * 2:02}Z"}
                      for number, name in enumerate(names, 1)],
        })
        self.set_report(dict(self.report, reason="active_polling", attention=[]))

    def authenticate(self, *, trigger=None, decision_id=DECISION, key=KEY):
        return proof.authenticated_next_no_effect(
            REPOSITORY, TRIGGER if trigger is None else trigger, decision_id, key,
            get_json=self.get_json, get_archive=self.get_archive,
        )


class FailedCheckpointSource(SyntheticSource):
    def __init__(self):
        super().__init__()
        self.set_report({
            "action": "stopped", "merge_mode": "manual", "reason": "state_write_failed",
            "attention": [{
                "reason": "state save failed; reload the authoritative queue before continuing",
            }], "state_sha": STATE,
        })

    def authenticate(self, *, trigger=None, decision_id=DECISION, key=KEY):
        return proof.authenticated_failed_save_checkpoint(
            REPOSITORY, TRIGGER if trigger is None else trigger, decision_id, key,
            get_json=self.get_json, get_archive=self.get_archive,
        )


class ArtifactProofAssertions(unittest.TestCase):
    def assert_denied(self, source, *, forbidden=None, **arguments):
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            with contextlib.redirect_stderr(io.StringIO()) as stderr:
                with self.assertRaises(ValueError) as caught:
                    source.authenticate(**arguments)
        self.assertEqual((stdout.getvalue(), stderr.getvalue()), ("", ""))
        if forbidden is not None:
            self.assertNotIn(forbidden, str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)
        return str(caught.exception)


class ArtifactProofTests(ArtifactProofAssertions):

    def test_authenticated_original_report_and_exact_byte_hashes_remain_in_memory(self):
        source = SyntheticSource()
        original = copy.deepcopy(TRIGGER)
        result = source.authenticate()
        self.assertEqual(result, {
            "producer": original, "workflow": "autonomous_next_task.yml", "ref": "refs/heads/main",
            "artifact_id": "301", "artifact_name": "laboratory-result-71-1",
            "artifact_sha256": hashlib.sha256(source.archive).hexdigest(),
            "report_sha256": hashlib.sha256(source.raw).hexdigest(), "report": source.report,
        })
        self.assertIsNot(result["producer"], TRIGGER)
        self.assertEqual(result["report"]["attention"], source.report["attention"])
        self.assertEqual(TRIGGER, original)
        self.assertEqual(source.downloads, ["actions/artifacts/301/zip"])
        self.assertNotIn("archive", result)

    def test_active_polling_successful_cli_with_original_failed_handoff_is_authenticated(self):
        for retained in (True, False):
            with self.subTest(retained=retained):
                source = SyntheticSource()
                source.active_polling()
                if not retained:
                    source.jobs[1]["steps"][2].update(conclusion="skipped", started_at=None, completed_at=None)
                result = source.authenticate()
                self.assertEqual(result["report"]["reason"], "active_polling")
                self.assertEqual(result["artifact_sha256"], hashlib.sha256(source.archive).hexdigest())
                self.assertEqual(result["report_sha256"], hashlib.sha256(source.raw).hexdigest())
                self.assertEqual(result["producer"], TRIGGER)

    def test_active_polling_requires_successful_native_cli_and_only_original_failed_handoff(self):
        mutations = [
            lambda source: source.jobs.pop(),
            lambda source: source.jobs.append(copy.deepcopy(source.jobs[1])),
            lambda source: source.jobs[1].update(name="foreign handoff"),
            lambda source: source.jobs[1].update(run_id=72),
            lambda source: source.jobs[1].update(head_sha="e" * 40),
            lambda source: source.jobs[1].update(conclusion="success"),
            lambda source: source.jobs[1]["steps"][1].update(conclusion="success"),
            lambda source: source.jobs[1]["steps"][0].update(conclusion="failure"),
            lambda source: source.jobs[1]["steps"][2].update(conclusion="failure"),
            lambda source: source.jobs[1]["steps"][0].update(started_at="2026-01-01T00:00:01Z"),
            lambda source: source.jobs[0]["steps"][3].update(conclusion="failure"),
            lambda source: source.jobs.append(dict(source.jobs[1], id=203, name="unrelated failed job")),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(boundary=index):
                source = SyntheticSource()
                source.active_polling()
                mutate(source)
                self.assert_denied(source)
                self.assertEqual(source.downloads, [])

    def test_native_result_reason_cannot_replace_the_original_cli_outcome(self):
        source = SyntheticSource()
        source.set_report(dict(source.report, reason="active_polling"))
        self.assert_denied(source)
        for reason in ("sync_running", "next_task_running"):
            with self.subTest(reason=reason):
                source = SyntheticSource()
                source.active_polling()
                source.set_report(dict(source.report, reason=reason))
                self.assert_denied(source)

    def test_coherent_foreign_event_head_cannot_replace_frozen_original_control(self):
        source = SyntheticSource()
        changed = "e" * 40
        source.run["head_sha"] = changed
        source.attempt["head_sha"] = changed
        source.jobs[0]["head_sha"] = changed
        source.artifacts[0]["workflow_run"]["head_sha"] = changed
        source.detail["workflow_run"]["head_sha"] = changed
        self.assert_denied(source)
        self.assertEqual(source.downloads, [])

    def test_workflow_id_must_resolve_to_the_original_source_path(self):
        for metadata in (None, {"id": 92, "path": ".github/workflows/autonomous_next_task.yml"},
                         {"id": 91, "path": ".github/workflows/foreign.yml"}):
            with self.subTest(metadata=metadata):
                source = SyntheticSource()
                source.page_override["actions/workflows/91"] = metadata
                self.assert_denied(source)
                self.assertEqual(source.downloads, [])

    def test_stale_foreign_rerun_and_nonterminal_source_are_denied_before_download(self):
        changes = [
            {"id": 72}, {"run_attempt": 2}, {"run_attempt": None}, {"event": "push"},
            {"head_branch": "foreign"}, {"head_sha": "not-a-sha"},
            {"path": ".github/workflows/foreign.yml"},
            {"display_title": "Next " + "e" * 32}, {"workflow_id": None},
            {"status": "in_progress"}, {"conclusion": "success"}, {"conclusion": "cancelled"},
            {"repository": {"id": 81, "full_name": "foreign/repo"}},
            {"head_repository": {"id": 82, "full_name": REPOSITORY}},
            {"actor": {"id": 101, "login": "foreign-actor"}},
            {"triggering_actor": {"id": 102, "login": TRIGGER["actor"]}},
            {"triggering_actor": {}},
        ]
        for change in changes:
            with self.subTest(change=change):
                source = SyntheticSource()
                source.run.update(change)
                self.assert_denied(source)
                self.assertEqual(source.downloads, [])

    def test_attempt_endpoint_and_final_current_run_cannot_hide_rerun(self):
        source = SyntheticSource()
        source.attempt["run_attempt"] = 2
        self.assert_denied(source)
        source = SyntheticSource()
        source.attempt["head_sha"] = "e" * 40
        self.assert_denied(source)
        source = SyntheticSource()
        source.final_run = dict(source.run, run_attempt=2)
        self.assert_denied(source)

    def test_executor_identity_is_not_normalized_or_fabricated(self):
        changes = [{"run_id": 71}, {"run_attempt": "2"}, {"actor": ""},
                   {"repository": "foreign/repo"}, {"control_sha": "invalid"},
                   {"event_name": "schedule"}, {"workflow": "foreign.yml"},
                   {"ref": "refs/heads/foreign"}]
        for change in changes:
            with self.subTest(change=change):
                self.assert_denied(SyntheticSource(), trigger=dict(TRIGGER, **change))
        for field in TRIGGER:
            trigger = dict(TRIGGER)
            del trigger[field]
            with self.subTest(missing=field):
                self.assert_denied(SyntheticSource(), trigger=trigger)
        self.assert_denied(SyntheticSource(), decision_id="wrong-decision")
        self.assert_denied(SyntheticSource(), key="wrong-key")

    def test_native_cli_must_execute_fail_and_upload_success_in_trusted_order(self):
        mutations = [
            lambda job: job.update(name="foreign job"),
            lambda job: job.update(status="in_progress"),
            lambda job: job.update(conclusion="success"),
            lambda job: job.update(run_id=72),
            lambda job: job.update(run_attempt=2),
            lambda job: job.update(head_sha="e" * 40),
            lambda job: job["steps"][3].update(name="different CLI"),
            lambda job: job["steps"][3].update(conclusion="skipped"),
            lambda job: job["steps"][3].update(status="queued"),
            lambda job: job["steps"][3].update(started_at=None),
            lambda job: job["steps"][3].update(completed_at="2025-01-01T00:00:00Z"),
            lambda job: job["steps"][4].update(conclusion="failure"),
            lambda job: job["steps"][4].update(number=1),
            lambda job: job["steps"][4].update(started_at="2026-01-01T00:00:00Z"),
            lambda job: job["steps"][0].update(conclusion="failure"),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(boundary=index):
                source = SyntheticSource()
                mutate(source.jobs[0])
                self.assert_denied(source)
                self.assertEqual(source.downloads, [])
        source = SyntheticSource()
        duplicate = copy.deepcopy(source.jobs[0])
        duplicate["id"] = 202
        source.jobs.append(duplicate)
        self.assert_denied(source)
        source = SyntheticSource()
        source.jobs[0]["steps"].append(dict(source.jobs[0]["steps"][3], number=6))
        self.assert_denied(source)

    def test_all_job_and_artifact_pages_are_read_not_just_first_match(self):
        source = SyntheticSource()
        for index in range(100):
            job = copy.deepcopy(source.jobs[0])
            job.update(id=400 + index, name=f"synthetic-other-job-{index}", conclusion="success")
            source.jobs.append(job)
            artifact = copy.deepcopy(source.artifacts[0])
            artifact.update(id=600 + index, name=f"synthetic-other-artifact-{index}")
            source.artifacts.append(artifact)
        source.authenticate()
        self.assertIn("actions/runs/71/attempts/1/jobs?per_page=100&page=2", source.calls)
        self.assertIn("actions/runs/71/artifacts?per_page=100&page=2", source.calls)
        source.run_reads = 0
        source.artifacts[-1]["name"] = source.artifacts[0]["name"]
        self.assert_denied(source)

    def test_incomplete_capped_duplicate_and_changing_pages_are_denied(self):
        for endpoint, field, row in [
            ("actions/runs/71/attempts/1/jobs", "jobs", "jobs"),
            ("actions/runs/71/artifacts", "artifacts", "artifacts"),
        ]:
            for count, count_items in [(2, 1), (0, 1), (1000, 1), (True, 1), (-1, 1), (2, 2)]:
                with self.subTest(endpoint=endpoint, count=count, rows=count_items):
                    source = SyntheticSource()
                    source.page_override[endpoint + "?per_page=100&page=1"] = {
                        "total_count": count, field: [copy.deepcopy(getattr(source, row)[0])
                                                     for _ in range(count_items)]}
                    self.assert_denied(source)
            source = SyntheticSource()
            items = []
            for index in range(100):
                item = copy.deepcopy(getattr(source, row)[0])
                item["id"] = 1000 + index
                items.append(item)
            source.page_override[endpoint + "?per_page=100&page=1"] = {
                "total_count": 101, field: items}
            source.page_override[endpoint + "?per_page=100&page=2"] = {
                "total_count": 100, field: []}
            self.assert_denied(source)

    def test_missing_expired_duplicate_and_foreign_artifact_metadata_are_denied(self):
        changes = [
            {"name": "laboratory-result-71-2"}, {"expired": True}, {"expired": None},
            {"id": 0}, {"digest": None}, {"digest": ""}, {"digest": "sha1:" + "f" * 40},
            {"digest": "sha256:" + "F" * 64}, {"size_in_bytes": proof.MAX_ARCHIVE_BYTES + 1},
            {"size_in_bytes": 0}, {"size_in_bytes": True},
        ]
        for change in changes:
            with self.subTest(change=change):
                source = SyntheticSource()
                source.artifacts[0].update(change)
                self.assert_denied(source)
        for field, value in [("id", 72), ("repository_id", 82), ("head_repository_id", 82),
                             ("head_branch", "foreign"), ("head_sha", "e" * 40), ("run_attempt", 2)]:
            with self.subTest(source_field=field):
                source = SyntheticSource()
                source.artifacts[0]["workflow_run"][field] = value
                self.assert_denied(source)
        source = SyntheticSource()
        duplicate = copy.deepcopy(source.artifacts[0])
        duplicate.update(id=302, expired=True)
        source.artifacts.append(duplicate)
        self.assert_denied(source)
        source = SyntheticSource()
        source.artifacts = []
        self.assert_denied(source)
        source = SyntheticSource()
        source.detail["expired"] = True
        self.assert_denied(source)
        source = SyntheticSource()
        source.detail["digest"] = "sha256:" + "e" * 64
        self.assert_denied(source)

    def test_download_digest_and_binary_bounds_are_enforced(self):
        for download in (b"foreign bytes", "not binary", b"x" * (proof.MAX_ARCHIVE_BYTES + 1)):
            with self.subTest(binary_type=type(download).__name__, size=len(download)):
                source = SyntheticSource()
                source.archive = download
                self.assert_denied(source)

    def test_zip_paths_regular_file_uniqueness_and_envelope_are_enforced(self):
        variants = [
            lambda raw: zip_bytes(raw, filename="../lab-result.json"),
            lambda raw: zip_bytes(raw, filename="/lab-result.json"),
            lambda raw: zip_bytes(raw, filename="folder/lab-result.json"),
            lambda raw: zip_bytes(raw, filename="lab-result.json/"),
            lambda raw: zip_bytes(raw, mode=stat.S_IFLNK | 0o777),
            lambda raw: zip_bytes(raw, extra=("foreign.json", b"{}")),
            lambda raw: zip_bytes(raw, extra=("lab-result.json", raw)),
            lambda raw: zip_bytes(raw, compression=zipfile.ZIP_BZIP2),
            lambda raw: b"prefix" + zip_bytes(raw),
            lambda raw: zip_bytes(raw) + b"trailing",
            lambda raw: zip_bytes(raw)[:-10],
        ]
        for index, make in enumerate(variants):
            with self.subTest(boundary=index):
                source = SyntheticSource()
                with patch("warnings.warn"):
                    source.set_archive(make(source.raw))
                self.assert_denied(source)
        source = SyntheticSource()
        damaged = bytearray(zip_bytes(source.raw, compression=zipfile.ZIP_STORED))
        damaged[30 + len("lab-result.json")] ^= 1
        source.set_archive(bytes(damaged))
        self.assert_denied(source)
        source = SyntheticSource()
        source.set_archive(zip_bytes(b" " * (proof.MAX_REPORT_BYTES + 1)))
        self.assert_denied(source)

    def test_malformed_duplicate_unbounded_and_nonobject_json_are_denied_safely(self):
        invalid = [b"not JSON private report content", b"\xff", b"{}", b"[]", b"null",
                   b'{"private":NaN}', b'{"private":Infinity}', b'{"decision_id":"x","decision_id":"y"}',
                   b"[" * 100 + b"0" + b"]" * 100,
                   json.dumps([0] * (proof.MAX_JSON_NODES + 1)).encode("utf-8")]
        for raw in invalid:
            with self.subTest(size=len(raw)):
                source = SyntheticSource()
                source.set_archive(zip_bytes(raw))
                self.assert_denied(source, forbidden="private report content")

    def test_effectful_or_foreign_native_reports_are_not_reinterpreted(self):
        changes = [
            {"decision_id": "e" * 64}, {"state_sha": ""}, {"state_sha": "state-alias"},
            {"action": "started"}, {"reason": "sync_required"}, {"skipped": False},
            {"skipped": 1}, {"automatic": False}, {"automatic": 1}, {"merge_mode": "auto"},
            {"effect_receipt_id": "e" * 64}, {"effect_receipt_id": ""},
            {"observations": [{"task_id": "synthetic-task"}]}, {"proposals": [{}]},
            {"waiting_workers": [{}]}, {"observations": None}, {"proposals": {}},
            {"research": {"research_changed": True}}, {"research_changed": True},
            {"research": None}, {"research": {"research_changed": 0}}, {"attention": None},
        ]
        for change in changes:
            with self.subTest(change=change):
                source = SyntheticSource()
                source.set_report(dict(source.report, **change))
                self.assert_denied(source)
        for field in ("decision_id", "state_sha", "action", "reason", "skipped", "automatic",
                      "observations", "proposals", "waiting_workers", "research", "attention"):
            source = SyntheticSource()
            report = dict(source.report)
            del report[field]
            with self.subTest(missing=field):
                source.set_report(report)
                self.assert_denied(source)

    def test_arbitrary_transport_exception_content_cannot_escape(self):
        source = SyntheticSource()
        source.page_override["actions/runs/71"] = RuntimeError("synthetic-private-token-response")
        self.assert_denied(source, forbidden="synthetic-private-token-response")
        source = SyntheticSource()
        def failing_archive(_endpoint):
            raise RuntimeError("synthetic-private-archive-response")
        source.get_archive = failing_archive
        self.assert_denied(source, forbidden="synthetic-private-archive-response")


class FailedCheckpointProofTests(ArtifactProofAssertions):
    def test_original_failed_native_checkpoint_has_same_safe_proof_without_decision_field(self):
        source = FailedCheckpointSource()
        result = source.authenticate()
        self.assertEqual(result, {
            "producer": TRIGGER, "workflow": proof.WORKFLOW, "ref": "refs/heads/main",
            "artifact_id": "301", "artifact_name": "laboratory-result-71-1",
            "artifact_sha256": hashlib.sha256(source.archive).hexdigest(),
            "report_sha256": hashlib.sha256(source.raw).hexdigest(), "report": source.report,
        })
        self.assertNotIn("decision_id", result["report"])
        self.assertIsNot(result["producer"], TRIGGER)
        self.assertEqual(source.run_reads, 2)
        self.assertEqual(source.downloads, ["actions/artifacts/301/zip"])

    def test_failed_native_diagnostics_are_bound_by_archive_hash_but_never_retained(self):
        filename = "research-diagnostics/" + "a" * 64 + "-1-" + "b" * 64 + "-" + "c" * 64 + ".json"
        source = FailedCheckpointSource()
        source.set_archive(zip_bytes(source.raw, extra=(filename, b"private diagnostic output")))
        result = source.authenticate()
        self.assertEqual(result["report"], source.report)
        self.assertEqual(result["artifact_sha256"], hashlib.sha256(source.archive).hexdigest())
        self.assertNotIn("private diagnostic output", json.dumps(result))
        paused = SyntheticSource()
        paused.set_archive(zip_bytes(paused.raw, extra=(filename, b"private diagnostic output")))
        self.assert_denied(paused)

    def test_failed_diagnostic_paths_types_and_total_bounds_remain_strict(self):
        filename = "research-diagnostics/" + "a" * 64 + "-1-" + "b" * 64 + "-" + "c" * 64 + ".json"
        symlink = zipfile.ZipInfo(filename)
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        for extra in (("research-diagnostics/../" + filename, b"{}"),
                      ("research-diagnostics/worker.json", b"{}"),
                      (filename, b""), (symlink, b"target"),
                      (filename, b"x" * proof.MAX_ARCHIVE_BYTES)):
            with self.subTest(extra_type=type(extra[0]).__name__):
                source = FailedCheckpointSource()
                source.set_archive(zip_bytes(source.raw, extra=extra))
                self.assert_denied(source)

    def test_failed_checkpoint_rejects_foreign_original_identity_and_rerun(self):
        changes = [
            {"id": 72}, {"run_attempt": 2}, {"event": "push"}, {"head_branch": "foreign"},
            {"head_sha": "e" * 40}, {"path": ".github/workflows/foreign.yml"},
            {"display_title": "Next " + "e" * 32}, {"conclusion": "success"},
            {"status": "in_progress"}, {"repository": {"id": 81, "full_name": "foreign/repo"}},
            {"head_repository": {"id": 82, "full_name": REPOSITORY}},
            {"actor": {"id": 101, "login": "foreign-owner"}},
            {"triggering_actor": {"id": 102, "login": TRIGGER["actor"]}},
        ]
        for change in changes:
            with self.subTest(change=change):
                source = FailedCheckpointSource()
                source.run.update(change)
                self.assert_denied(source)
                self.assertEqual(source.downloads, [])
        for field, value in [("run_attempt", 2), ("id", 72), ("head_sha", "e" * 40)]:
            with self.subTest(attempt_field=field):
                source = FailedCheckpointSource()
                source.attempt[field] = value
                self.assert_denied(source)
        for metadata in ({"id": 92, "path": ".github/workflows/" + proof.WORKFLOW},
                         {"id": 91, "path": ".github/workflows/foreign.yml"}):
            with self.subTest(workflow=metadata):
                source = FailedCheckpointSource()
                source.page_override["actions/workflows/91"] = metadata
                self.assert_denied(source)
        source = FailedCheckpointSource()
        source.final_run = dict(source.run, run_attempt=2)
        self.assert_denied(source)

    def test_original_executor_and_correlation_binding_cannot_be_replaced(self):
        for change in ({"run_attempt": "2"}, {"actor": "foreign-owner"},
                       {"control_sha": "e" * 40}, {"event_name": "push"},
                       {"workflow": "foreign.yml"}, {"ref": "refs/heads/foreign"},
                       {"repository": "foreign/repo"}):
            with self.subTest(trigger=change):
                self.assert_denied(FailedCheckpointSource(), trigger=dict(TRIGGER, **change))
        self.assert_denied(FailedCheckpointSource(), key="e" * 32)
        self.assertEqual(self.assert_denied(FailedCheckpointSource(), decision_id="not-a-decision"),
                         "invalid original decision identity")

    def test_failure_must_be_native_with_successful_prerequisites_and_upload(self):
        mutations = [
            lambda job: job.update(name="foreign CLI"),
            lambda job: job.update(conclusion="success"),
            lambda job: job.update(run_id=72),
            lambda job: job.update(run_attempt=2),
            lambda job: job["steps"][3].update(conclusion="success"),
            lambda job: job["steps"][3].update(conclusion="skipped"),
            lambda job: job["steps"][3].update(started_at=None),
            lambda job: job["steps"][0].update(conclusion="failure"),
            lambda job: job["steps"][1].update(conclusion="skipped"),
            lambda job: job["steps"][2].update(conclusion="failure"),
            lambda job: job["steps"][4].update(conclusion="failure"),
            lambda job: job["steps"][4].update(started_at="2026-01-01T00:00:00Z"),
            lambda job: job["steps"].append(dict(job["steps"][3], number=6)),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(boundary=index):
                source = FailedCheckpointSource()
                mutate(source.jobs[0])
                self.assert_denied(source)
                self.assertEqual(source.downloads, [])

    def test_artifact_source_identity_metadata_and_download_digest_are_mandatory(self):
        for field, value in [("id", 72), ("repository_id", 82), ("head_repository_id", 82),
                             ("head_sha", "e" * 40), ("head_branch", "foreign"), ("run_attempt", 2)]:
            with self.subTest(source_field=field):
                source = FailedCheckpointSource()
                source.artifacts[0]["workflow_run"][field] = value
                self.assert_denied(source)
        for field, value in [("name", "laboratory-result-71-2"), ("expired", True),
                             ("digest", None), ("digest", "sha256:" + "e" * 64),
                             ("size_in_bytes", proof.MAX_ARCHIVE_BYTES + 1)]:
            with self.subTest(artifact_field=field):
                source = FailedCheckpointSource()
                source.artifacts[0][field] = value
                self.assert_denied(source)
        for field, value in [("id", 302), ("expired", True), ("digest", "sha256:" + "e" * 64),
                             ("size_in_bytes", 1)]:
            with self.subTest(detail_field=field):
                source = FailedCheckpointSource()
                source.detail[field] = value
                self.assert_denied(source)
        source = FailedCheckpointSource()
        source.archive = zip_bytes(b"private replacement report")
        self.assertEqual(self.assert_denied(source), "native artifact SHA256 does not match")

    def test_all_pages_must_remain_complete_and_unambiguous_for_failed_purpose(self):
        source = FailedCheckpointSource()
        for index in range(100):
            source.jobs.append(dict(source.jobs[0], id=400 + index, name=f"other-{index}"))
            source.artifacts.append(dict(source.artifacts[0], id=600 + index, name=f"other-{index}"))
        self.assertEqual(source.authenticate()["report"], source.report)
        source.artifacts[-1]["name"] = source.artifacts[0]["name"]
        self.assertEqual(self.assert_denied(source), "missing or ambiguous original native artifact")
        source = FailedCheckpointSource()
        source.page_override["actions/runs/71/attempts/1/jobs?per_page=100&page=1"] = {
            "total_count": 2, "jobs": source.jobs,
        }
        self.assertEqual(self.assert_denied(source), "incomplete source metadata")

    def test_pause_and_failed_checkpoint_are_not_interchangeable(self):
        paused = SyntheticSource()
        failed = FailedCheckpointSource()
        paused.set_report(failed.report)
        self.assert_denied(paused)
        failed.set_report(SyntheticSource().report)
        self.assert_denied(failed)

    def test_failed_envelope_has_only_exact_native_fields_and_fixed_attention(self):
        changes = [
            {"action": "none"}, {"reason": "controller_error"}, {"merge_mode": "auto"},
            {"state_sha": ""}, {"state_sha": "B" * 40}, {"state_sha": None},
            {"decision_id": DECISION}, {"effect_receipt_id": "e" * 64},
            {"observations": []}, {"proposals": []}, {"waiting_workers": []},
            {"research": {}}, {"research_changed": False}, {"skipped": True}, {"automatic": False},
            {"output": "private worker output"}, {"attention": []}, {"attention": None},
            {"attention": [{"reason": "private arbitrary exception"}]},
            {"attention": [{"reason": "state save failed; reload the authoritative queue before continuing",
                            "detail": "private worker output"}]},
        ]
        for change in changes:
            with self.subTest(change=change):
                source = FailedCheckpointSource()
                source.set_report(dict(source.report, **change))
                self.assert_denied(source, forbidden="private")
        source = FailedCheckpointSource()
        source.set_report(dict(source.report, attention=source.report["attention"] * 2))
        self.assert_denied(source)
        for field in FailedCheckpointSource().report:
            with self.subTest(missing=field):
                source = FailedCheckpointSource()
                report = dict(source.report)
                del report[field]
                source.set_report(report)
                self.assert_denied(source)

    def test_failed_parser_rejects_unsafe_zip_and_ambiguous_or_unbounded_json(self):
        variants = [
            lambda raw: zip_bytes(raw, filename="../lab-result.json"),
            lambda raw: zip_bytes(raw, mode=stat.S_IFLNK | 0o777),
            lambda raw: zip_bytes(raw, extra=("lab-result.json", raw)),
            lambda raw: zip_bytes(raw, extra=("worker.txt", b"private output")),
            lambda raw: b"prefix" + zip_bytes(raw),
            lambda raw: zip_bytes(raw) + b"trailing",
            lambda raw: zip_bytes(raw, compression=zipfile.ZIP_BZIP2),
        ]
        for index, make in enumerate(variants):
            with self.subTest(archive_boundary=index):
                source = FailedCheckpointSource()
                with patch("warnings.warn"):
                    source.set_archive(make(source.raw))
                self.assert_denied(source)
        invalid = [b"private malformed JSON", b"\xff", b"null", b"[]",
                   b'{"reason":"state_write_failed","reason":"private"}',
                   b'{"private":NaN}', b'{"private":Infinity}',
                   b"[" * 100 + b"0" + b"]" * 100,
                   json.dumps([0] * (proof.MAX_JSON_NODES + 1)).encode("utf-8"),
                   b" " * (proof.MAX_REPORT_BYTES + 1)]
        for raw in invalid:
            with self.subTest(json_size=len(raw)):
                source = FailedCheckpointSource()
                source.set_archive(zip_bytes(raw))
                self.assert_denied(source, forbidden="private")

    def test_failed_authentication_uses_fixed_redacted_errors_for_untrusted_exceptions(self):
        source = FailedCheckpointSource()
        source.page_override["actions/runs/71"] = RuntimeError("private transport secret")
        self.assertEqual(self.assert_denied(source, forbidden="private transport secret"),
                         "original native artifact authentication failed")
        source = FailedCheckpointSource()
        def failing_archive(_endpoint):
            raise RuntimeError("private archive secret")
        source.get_archive = failing_archive
        self.assertEqual(self.assert_denied(source, forbidden="private archive secret"),
                         "original native artifact authentication failed")
        source = FailedCheckpointSource()
        source.set_archive(zip_bytes(b"private malformed JSON"))
        self.assertEqual(self.assert_denied(source, forbidden="private malformed JSON"),
                         "original native artifact authentication failed")


if __name__ == "__main__":
    unittest.main()
