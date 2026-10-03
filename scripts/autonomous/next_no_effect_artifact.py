#!/usr/bin/env python3
"""GET-only proof of original failed native NEXT pause and report checkpoints.

Archives and native reports remain in memory. This is source authentication, not
permission to complete a journal decision or evidence of substantive Git equality.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import re
import stat
import subprocess
import threading
import zipfile
from datetime import datetime

WORKFLOW = "autonomous_next_task.yml"
NATIVE_JOB = "Research and collect proposals without accepting them"
NATIVE_STEP = "Reconcile saved attempts and run one laboratory tick"
UPLOAD_STEP = "Preserve laboratory outcome and redacted report diagnostics"
MAX_ARCHIVE_BYTES = 1024 * 1024
MAX_REPORT_BYTES = 1024 * 1024
MAX_METADATA_ROWS = 1000
PAGE_SIZE = 100
MAX_JSON_DEPTH = 32
MAX_JSON_NODES = 10000
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
DECIMAL = re.compile(r"[1-9][0-9]{0,19}\Z")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}\Z")
ACTOR = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,99}(?:\[bot\])?\Z")


class _Denied(Exception):
    """Only fixed, trusted messages may cross the public error boundary."""


def _require(condition, message):
    if not condition:
        raise _Denied(message)


def _positive_id(value):
    return type(value) is int and 0 < value < 10 ** 20


def _default_json(repository, endpoint):
    # Avoid importing the full health/controller dependency graph in fixtures.
    from health_snapshot import gh_get
    return gh_get(repository, endpoint)


def _default_archive(repository, endpoint):
    # Read at most the bound plus one byte, without writing any archive to disk.
    # Discard stderr rather than retaining arbitrary transport/credential bytes.
    with subprocess.Popen(
        ["gh", "api", "--method", "GET", "/repos/" + repository + "/" + endpoint],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    ) as process:
        timer = threading.Timer(120, process.kill)
        timer.daemon = True
        timer.start()
        try:
            raw = process.stdout.read(MAX_ARCHIVE_BYTES + 1)
            _require(len(raw) <= MAX_ARCHIVE_BYTES, "native archive transport exceeded its bound")
            _require(process.wait() == 0, "native archive transport failed")
            return raw
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()


def _pages(get, endpoint, field):
    rows, identifiers = [], set()
    total = None
    for page in range(1, MAX_METADATA_ROWS // PAGE_SIZE + 1):
        result = get(endpoint + f"?per_page={PAGE_SIZE}&page={page}")
        _require(isinstance(result, dict), "invalid source metadata page")
        count, items = result.get("total_count"), result.get(field)
        _require(type(count) is int and 0 <= count < MAX_METADATA_ROWS,
                 "source metadata is invalid or capped")
        _require(isinstance(items, list), "incomplete source metadata")
        if total is None:
            total = count
        _require(count == total, "source metadata changed during pagination")
        _require(len(items) == min(PAGE_SIZE, total - len(rows)),
                 "incomplete source metadata")
        for item in items:
            _require(isinstance(item, dict) and _positive_id(item.get("id")),
                     "invalid source metadata identity")
            _require(item["id"] not in identifiers, "duplicate source metadata identity")
            identifiers.add(item["id"])
            rows.append(item)
        if len(rows) == total:
            return rows
    raise _Denied("incomplete source metadata")


def _run_identity(run, repository, trigger, key):
    _require(isinstance(run, dict), "missing original source run")
    _require(_positive_id(run.get("id")) and str(run["id"]) == trigger["run_id"]
             and type(run.get("run_attempt")) is int and run["run_attempt"] == 1,
             "original source run or attempt does not match")
    _require(run.get("event") == trigger["event_name"]
             and run.get("head_branch") == "main"
             and run.get("head_sha") == trigger["control_sha"]
             and run.get("path") == ".github/workflows/" + WORKFLOW
             and run.get("display_title") == "Next " + key
             and _positive_id(run.get("workflow_id")), "untrusted original source workflow")
    _require(run.get("status") == "completed" and run.get("conclusion") == "failure",
             "original native source is not a completed failure")
    repositories = []
    for field in ("repository", "head_repository"):
        source = run.get(field)
        _require(isinstance(source, dict) and source.get("full_name") == repository
                 and _positive_id(source.get("id")), "foreign original source repository")
        repositories.append(source["id"])
    _require(repositories[0] == repositories[1], "foreign original source head repository")
    actors = []
    for field in ("actor", "triggering_actor"):
        actor = run.get(field)
        _require(isinstance(actor, dict) and actor.get("login") == trigger["actor"]
                 and _positive_id(actor.get("id")), "original source actor does not match")
        actors.append(actor["id"])
    _require(actors[0] == actors[1], "original source triggering actor does not match")
    return (run["id"], run["run_attempt"], run["head_sha"], run["workflow_id"],
            repositories[0], repositories[1], actors[0])


def _timestamp(value):
    _require(isinstance(value, str) and len(value) <= 40, "missing native execution timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise _Denied("invalid native execution timestamp") from None
    _require(parsed.tzinfo is not None, "invalid native execution timestamp")
    return parsed


def _executed(step, conclusion):
    _require(step.get("status") == "completed" and step.get("conclusion") == conclusion,
             "native execution step did not produce the required outcome")
    start, end = _timestamp(step.get("started_at")), _timestamp(step.get("completed_at"))
    _require(start <= end, "invalid native execution interval")
    return start, end


def _prove_jobs(jobs, identity):
    native = []
    for job in jobs:
        _require(job.get("run_id") == identity[0] and type(job.get("run_id")) is int
                 and job.get("head_sha") == identity[2] and job.get("head_branch") == "main",
                 "foreign source job")
        if "run_attempt" in job:
            _require(type(job["run_attempt"]) is int and job["run_attempt"] == 1,
                     "foreign source job attempt")
        if job.get("name") == NATIVE_JOB:
            native.append(job)
    _require(len(native) == 1, "missing or ambiguous original native job")
    job = native[0]
    _require(job.get("status") == "completed" and job.get("conclusion") == "failure",
             "original native job did not fail")
    steps = job.get("steps")
    _require(isinstance(steps, list) and 0 < len(steps) <= 100, "incomplete native job steps")
    numbered, named = {}, {}
    for step in steps:
        _require(isinstance(step, dict) and _positive_id(step.get("number"))
                 and isinstance(step.get("name"), str), "invalid native step identity")
        _require(step["number"] not in numbered and step["name"] not in named,
                 "ambiguous native step identity")
        numbered[step["number"]] = step
        named[step["name"]] = step
    prerequisites = ("Authenticate the frozen receiver controller",
                     "Check out the authenticated receiver revision",
                     "Verify the laboratory policy")
    expected = (*prerequisites, NATIVE_STEP, UPLOAD_STEP)
    _require(all(name in named for name in expected), "missing original trusted native step")
    _require([named[name]["number"] for name in expected]
             == sorted(named[name]["number"] for name in expected), "invalid native step order")
    previous_end = None
    for name in expected:
        start, end = _executed(named[name], "failure" if name == NATIVE_STEP else "success")
        _require(previous_end is None or previous_end <= start, "invalid native step execution order")
        previous_end = end
    _require(all(step.get("conclusion") != "failure" or step["name"] == NATIVE_STEP
                 for step in steps), "original native job failed outside the native CLI")


def _prove_artifact(artifact, identity, name):
    _require(isinstance(artifact, dict) and _positive_id(artifact.get("id"))
             and artifact.get("name") == name and artifact.get("expired") is False,
             "missing, foreign or expired native artifact")
    _require(type(artifact.get("size_in_bytes")) is int
             and 0 < artifact["size_in_bytes"] <= MAX_ARCHIVE_BYTES,
             "native artifact exceeds the archive bound")
    digest = artifact.get("digest")
    _require(isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest),
             "native artifact has no authenticated SHA256 digest")
    source = artifact.get("workflow_run")
    _require(isinstance(source, dict) and type(source.get("id")) is int
             and source["id"] == identity[0]
             and type(source.get("repository_id")) is int and source["repository_id"] == identity[4]
             and type(source.get("head_repository_id")) is int and source["head_repository_id"] == identity[5]
             and source.get("head_branch") == "main" and source.get("head_sha") == identity[2],
             "native artifact belongs to a foreign source")
    if "run_attempt" in source:
        _require(type(source["run_attempt"]) is int and source["run_attempt"] == 1,
                 "native artifact belongs to a different attempt")
    return digest[7:]


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, "duplicate native JSON member")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise _Denied("invalid native JSON number")


def _native_json(archive, *, allow_diagnostics=False):
    _require(archive.startswith(b"PK\x03\x04") and len(archive) >= 22
             and archive[-22:-18] == b"PK\x05\x06" and archive[-2:] == b"\x00\x00",
             "invalid native ZIP envelope")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        entries = bundle.infolist()
        if allow_diagnostics:
            _require(0 < len(entries) <= MAX_METADATA_ROWS
                     and len({item.filename for item in entries}) == len(entries)
                     and sum(item.file_size for item in entries) <= MAX_ARCHIVE_BYTES,
                     "invalid or oversized native ZIP members")
            for item in entries:
                if item.filename == "lab-result.json":
                    continue
                _require(item.orig_filename == item.filename
                         and item.flag_bits & ~(0x8 | 0x800) == 0
                         and item.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                         "invalid native diagnostic ZIP metadata")
                mode = stat.S_IFMT(item.external_attr >> 16)
                if item.filename == "research-diagnostics/":
                    _require(item.is_dir() and item.file_size == 0 and mode in (0, stat.S_IFDIR),
                             "invalid native diagnostic ZIP directory")
                else:
                    _require(re.fullmatch(r"research-diagnostics/[0-9a-f]{64}-[1-9][0-9]*-[0-9a-f]{64}-[0-9a-f]{64}\.json",
                                          item.filename) is not None
                             and not item.is_dir() and mode in (0, stat.S_IFREG)
                             and not (item.external_attr & 0x10)
                             and 0 < item.file_size <= MAX_REPORT_BYTES,
                             "invalid native diagnostic ZIP member")
        else:
            _require(len(entries) == 1, "native ZIP must contain only lab-result.json")
        reports = [item for item in entries if item.filename == "lab-result.json"]
        _require(len(reports) == 1, "native ZIP must contain exactly one lab-result.json")
        entry = reports[0]
        mode = entry.external_attr >> 16
        _require(entry.filename == "lab-result.json" and entry.orig_filename == "lab-result.json"
                 and not entry.is_dir() and stat.S_IFMT(mode) in (0, stat.S_IFREG)
                 and not (entry.external_attr & 0x10), "invalid native ZIP member path or type")
        _require(entry.flag_bits & ~(0x8 | 0x800) == 0
                 and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                 and 0 < entry.file_size <= MAX_REPORT_BYTES
                 and 0 < entry.compress_size <= MAX_ARCHIVE_BYTES
                 and entry.header_offset == 0, "invalid or oversized native ZIP member")
        raw = bundle.read(entry)
    _require(len(raw) <= MAX_REPORT_BYTES, "native JSON exceeds the report bound")
    report = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                        parse_constant=_invalid_constant)
    pending, nodes = [(report, 0)], 0
    while pending:
        value, depth = pending.pop()
        nodes += 1
        _require(depth <= MAX_JSON_DEPTH and nodes <= MAX_JSON_NODES,
                 "native JSON exceeds the structural bound")
        if isinstance(value, dict):
            pending.extend((item, depth + 1) for item in value.values())
        elif isinstance(value, list):
            pending.extend((item, depth + 1) for item in value)
    return report, hashlib.sha256(raw).hexdigest()


def _report(archive, decision_id):
    report, report_digest = _native_json(archive)
    _require(isinstance(report, dict) and report.get("decision_id") == decision_id
             and isinstance(report.get("state_sha"), str) and SHA.fullmatch(report["state_sha"]),
             "native report decision or state identity does not match")
    _require(report.get("action") == "none" and report.get("reason") == "sync_running"
             and report.get("skipped") is True and report.get("automatic") is True
             and report.get("merge_mode") == "manual" and "effect_receipt_id" not in report,
             "native report is not the original no-effect scheduler pause")
    _require(all(report.get(field) == [] for field in ("observations", "proposals", "waiting_workers")),
             "native report contains substantive observations or work")
    research = report.get("research")
    _require(isinstance(research, dict) and research.get("research_changed", False) is False
             and report.get("research_changed", False) is False, "native report changed research")
    attention = report.get("attention")
    _require(isinstance(attention, list) and len(attention) <= MAX_METADATA_ROWS
             and all(isinstance(item, dict) and isinstance(item.get("reason"), str)
                     for item in attention), "invalid native descriptive attention")
    return report, report_digest


def _failed_report_checkpoint(archive, decision_id):
    # The exception path does not serialize decision_id. Its original decision
    # is bound by the authenticated executor run and correlation-key run title.
    report, report_digest = _native_json(archive, allow_diagnostics=True)
    _require(isinstance(report, dict)
             and set(report) == {"action", "merge_mode", "reason", "attention", "state_sha"},
             "native report is not the original failed report checkpoint")
    _require(report["action"] == "stopped" and report["merge_mode"] == "manual"
             and report["reason"] == "state_write_failed",
             "native report is not the original failed report checkpoint")
    _require(isinstance(report["state_sha"], str) and SHA.fullmatch(report["state_sha"]),
             "native report state identity does not match")
    _require(report["attention"] == [{
        "reason": "state save failed; reload the authoritative queue before continuing",
    }], "invalid native failed checkpoint attention")
    return report, report_digest


def _authenticate(repository, executor_trigger, decision_id, correlation_key, report_reader,
                  *, get_json=None, get_archive=None):
    try:
        _require(isinstance(repository, str) and REPOSITORY.fullmatch(repository),
                 "invalid source repository")
        _require(isinstance(executor_trigger, dict), "invalid original executor identity")
        trigger = copy.deepcopy(executor_trigger)
        _require(all(isinstance(trigger.get(field), str) and DECIMAL.fullmatch(trigger[field])
                     for field in ("run_id", "run_attempt")) and trigger["run_attempt"] == "1"
                 and trigger.get("event_name") == "workflow_dispatch"
                 and trigger.get("repository") == repository
                 and isinstance(trigger.get("control_sha"), str) and SHA.fullmatch(trigger["control_sha"])
                 and isinstance(trigger.get("actor"), str) and ACTOR.fullmatch(trigger["actor"]),
                 "invalid original executor identity")
        _require(trigger.get("workflow", WORKFLOW) == WORKFLOW
                 and trigger.get("ref", "refs/heads/main") == "refs/heads/main",
                 "untrusted original executor workflow")
        _require(isinstance(decision_id, str) and DIGEST.fullmatch(decision_id)
                 and isinstance(correlation_key, str) and re.fullmatch(r"[0-9a-f]{32}", correlation_key),
                 "invalid original decision identity")
        get = get_json if get_json is not None else lambda endpoint: _default_json(repository, endpoint)
        download = (get_archive if get_archive is not None
                    else lambda endpoint: _default_archive(repository, endpoint))
        endpoint = "actions/runs/" + trigger["run_id"]
        identity = _run_identity(get(endpoint), repository, trigger, correlation_key)
        workflow = get("actions/workflows/" + str(identity[3]))
        _require(isinstance(workflow, dict) and type(workflow.get("id")) is int
                 and workflow["id"] == identity[3]
                 and workflow.get("path") == ".github/workflows/" + WORKFLOW,
                 "original source workflow identity changed")
        _require(_run_identity(get(endpoint + "/attempts/1"), repository, trigger, correlation_key)
                 == identity, "original run attempt source changed")
        _prove_jobs(_pages(get, endpoint + "/attempts/1/jobs", "jobs"), identity)
        name = "laboratory-result-" + trigger["run_id"] + "-1"
        artifacts = _pages(get, endpoint + "/artifacts", "artifacts")
        matching = [item for item in artifacts if item.get("name") == name]
        _require(len(matching) == 1, "missing or ambiguous original native artifact")
        artifact = matching[0]
        expected_digest = _prove_artifact(artifact, identity, name)
        artifact_endpoint = "actions/artifacts/" + str(artifact["id"])
        current_artifact = get(artifact_endpoint)
        _require(_prove_artifact(current_artifact, identity, name) == expected_digest
                 and current_artifact["id"] == artifact["id"]
                 and current_artifact["size_in_bytes"] == artifact["size_in_bytes"],
                 "native artifact metadata changed")
        archive = download(artifact_endpoint + "/zip")
        _require(type(archive) is bytes and 0 < len(archive) <= MAX_ARCHIVE_BYTES,
                 "invalid or oversized native artifact download")
        archive_digest = hashlib.sha256(archive).hexdigest()
        _require(archive_digest == expected_digest, "native artifact SHA256 does not match")
        report, report_digest = report_reader(archive, decision_id)
        _require(_run_identity(get(endpoint), repository, trigger, correlation_key) == identity,
                 "original source changed during authentication")
        return {"producer": trigger, "workflow": WORKFLOW, "ref": "refs/heads/main",
                "artifact_id": str(artifact["id"]), "artifact_name": name,
                "artifact_sha256": archive_digest, "report_sha256": report_digest, "report": report}
    except _Denied as exc:
        raise ValueError(str(exc)) from None
    except Exception:
        raise ValueError("original native artifact authentication failed") from None


def authenticated_next_no_effect(repository, executor_trigger, decision_id, correlation_key,
                                 *, get_json=None, get_archive=None) -> dict:
    """Authenticate one original attempt's native pause without retaining bytes.

    Injected GET callbacks accept repository-relative endpoints. Denial exposes
    only fixed messages; transport, ZIP, JSON and native prose never enter errors.
    The caller still must prove this report's state against real journal/Git data.
    """
    return _authenticate(repository, executor_trigger, decision_id, correlation_key, _report,
                         get_json=get_json, get_archive=get_archive)


def authenticated_failed_report_checkpoint(repository, executor_trigger, decision_id, correlation_key,
                                          *, get_json=None, get_archive=None) -> dict:
    """Authenticate the exact native pre-POST report-recovery save failure.

    The failed envelope has no decision_id: the original executor and correlation
    key authenticate its source. The caller must prove the checkpoint body and
    command binding separately. No permission or provider-effect proof is issued.
    Errors and injected GET callbacks follow the pause reader's fixed boundary.
    """
    return _authenticate(repository, executor_trigger, decision_id, correlation_key,
                         _failed_report_checkpoint, get_json=get_json, get_archive=get_archive)
