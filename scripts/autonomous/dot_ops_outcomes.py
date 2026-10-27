#!/usr/bin/env python3
"""Pure, owner-activated delivery accounting for two existing Jules operations.

No network, dispatch, credentials, runner, or authority issuance. Every returned
state requires exact-blob CAS and positive readback by the caller. JSON bindings
cannot authenticate their own origin: the caller retains actual native calls and
GitHub observations and verifies the separately issued protocol on accepted main.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import re
import hashlib
import io
import json
import math
import zipfile

from dot_authority import digest, instant

REPOSITORY = "Omnividente/omp-desktop"
ISSUE = "https://github.com/Omnividente/omp-desktop/issues/146"
RECOVERY = "owner_delegated_recovery_dispatch"
SYNC = "owner_delegated_sync_dispatch"
WORKFLOWS = {RECOVERY: "autonomous_recover_delivery.yml", SYNC: "autonomous_sync.yml"}
OUTCOME = "owner_ops_delivery_outcome"
TOOLS = {"mcp__codex_apps__github_actions_actions_run_trigger",
         "Github_Actions.actions_run_trigger", "GitHub_MCP_Full.actions_run_trigger"}
SCOPE = "separate-owner-delegated-operations"
SHA = re.compile(r"[0-9a-f]{40}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")
FRESHNESS = timedelta(minutes=5)
MAX_ARTIFACT_BYTES = 65536
MAX_FENCE_MEMBER_BYTES = 8192  # owner_fence_proof.MAX_METADATA
MAX_SYNC_RESULT_BYTES = 1024 * 1024  # Consumer envelope, not a producer maximum.
CONTRACT_PATHS = {".github/workflows/" + name for name in WORKFLOWS.values()} | {
    "scripts/autonomous/owner_fence_proof.py", "scripts/autonomous/recover_delivery.py",
    "scripts/autonomous/dispatch_journal.py", "docs/autonomous/OWNER_FENCE_PROOF.md"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text(value):
    require(type(value) is str and bool(value.strip()), "missing text binding")
    return value


def hexadecimal(value, pattern=HASH):
    require(type(value) is str and pattern.fullmatch(value), "invalid hash binding")
    return value


def stamp(value, now, *, fresh=False):
    require(isinstance(now, datetime) and now.tzinfo is not None
            and now.utcoffset() == timedelta(0), "now must be UTC")
    moment = instant(text(value))
    require(moment <= now and (not fresh or now - moment <= FRESHNESS), "stale or future observation")
    return moment


def same(left, right):
    # Unlike Python equality this does not identify True with 1.
    return digest(left) == digest(right)


def _state(state):
    require(type(state) is dict and type(state.get("schema")) is int
            and state["schema"] == 2 and type(state.get("operations")) is list,
            "complete schema-2 state required")
    digest(state)
    for field in ("active_task", "lease", "pending_operation", "retired_task_ids", "backlog"):
        require(field in state, "missing state field")
    text(state.get("grant_id"))
    rows = state["operations"]
    require(all(type(row) is dict and type(row.get("id")) is str and row["id"] for row in rows),
            "invalid operation history")
    require(len({row["id"] for row in rows}) == len(rows), "duplicate operation identity")


def _protocol(state, envelope, now):
    """Bind fresh caller-authenticated authority; never treat this as provenance."""
    require(type(envelope) is dict, "separate operational protocol required")
    record = envelope.get("record")
    require(type(record) is dict and record.get("kind") == "owner-ops-outcome-protocol"
            and type(record.get("version")) is int and record["version"] == 1
            and record.get("repository") == REPOSITORY
            and record.get("source_grant_id") == state["grant_id"]
            and record.get("status") == "active"
            and same(record.get("allowed_kinds"), sorted(WORKFLOWS))
            and type(record.get("maximum_successors")) is int and record["maximum_successors"] == 1,
            "inactive or unsupported operational protocol")
    require(digest(record) == hexadecimal(envelope.get("expected_sha256")), "protocol hash changed")
    issued = stamp(record.get("issued_at"), now)
    text(record.get("id")); text(record.get("decision_ref"))
    hexadecimal(record.get("installed_helper_blob"), SHA)
    hexadecimal(record.get("accepted_main_sha"), SHA)
    for field in ("original_ops_sha256", "runner_amendment_sha256"):
        hexadecimal(record.get(field))
    require(type(record.get("workflow_blobs")) is dict
            and set(record["workflow_blobs"]) == set(WORKFLOWS.values()), "workflow allowlist required")
    for blob in record["workflow_blobs"].values():
        hexadecimal(blob, SHA)
    require(type(record.get("contract_blobs")) is dict and set(record["contract_blobs"]) == CONTRACT_PATHS,
            "complete installed runner contract pins required")
    for path, blob in record["contract_blobs"].items():
        hexadecimal(blob, SHA)
        if path.startswith(".github/workflows/"):
            require(record["workflow_blobs"][path.rsplit("/", 1)[1]] == blob, "inconsistent workflow pin")
    issue = envelope.get("issue", {})
    require(issue.get("html_url") == ISSUE and issue.get("state") == "open"
            and envelope.get("source_grant_id") == state["grant_id"]
            and envelope.get("source_authority") == "verified-active"
            and envelope.get("installed_helper_blob") == record["installed_helper_blob"],
            "authority or installed implementation unavailable")
    events = envelope.get("issue_events")
    require(envelope.get("events_complete") is True and type(events) is list
            and envelope.get("revocations_complete") is True
            and type(envelope.get("revoked_ids")) is list, "complete revocation reads required")
    protected = {record["id"], state["grant_id"], text(record.get("original_ops_id")),
                 text(record.get("runner_amendment_id"))}
    require(not protected.intersection(envelope["revoked_ids"]), "authority revoked")
    require(not any(e.get("event") == "closed" and instant(e["created_at"]) >= issued
                    for e in events), "protocol permanently revoked by closure")
    # The original delegation's earlier issue-closure rules also remain mandatory.
    require(envelope.get("base_delegations") == "verified-active-unchanged", "base authority invalid")
    stamp(envelope.get("observed_at"), now, fresh=True)
    return record


def _request(operation):
    kind = operation.get("kind")
    require(kind in WORKFLOWS, "not an allowed operational action")
    request = operation.get("request")
    require(type(request) is dict and set(request) == {"tool", "arguments"}, "exact tool call required")
    require(request["tool"] in TOOLS, "unsupported dispatch tool")
    args = request["arguments"]
    require(type(args) is dict and set(args) == {"method", "owner", "repo", "workflow_id", "ref", "inputs"}
            and args["method"] == "run_workflow" and args["owner"] == "Omnividente"
            and args["repo"] == "omp-desktop" and args["ref"] == "main"
            and args["workflow_id"] == WORKFLOWS[kind], "foreign or unsupported dispatch")
    inputs = args["inputs"]
    require(type(inputs) is dict, "typed workflow inputs required")
    if kind == RECOVERY:
        require(set(inputs) == {"decision_id", "expected_state_sha"}, "unexpected recovery inputs")
        hexadecimal(inputs["decision_id"]); hexadecimal(inputs["expected_state_sha"], SHA)
        target = inputs["decision_id"]
    else:
        require(set(inputs) == {"main_sha", "lab_sha", "continuation_key", "control_sha"}
                and inputs["continuation_key"] == "" and inputs["control_sha"] == "", "keyless checked Sync required")
        hexadecimal(inputs["main_sha"], SHA); hexadecimal(inputs["lab_sha"], SHA)
        target = hexadecimal(operation.get("fence_receipt_id"))
    return digest([REPOSITORY, kind, target])


def _operation(operation):
    require(type(operation) is dict, "operation required")
    text(operation.get("id"))
    key = _request(operation)
    require(operation.get("status") == "pending" and operation.get("not_source_task_admission") is True,
            "not an operational consumed attempt")
    claim = operation.get("send_claim", {})
    require(claim.get("consumed") is True and type(claim.get("maximum_sends")) is int
            and claim["maximum_sends"] == 1, "one consumed send claim required")
    text(claim.get("lease_id"))
    hexadecimal(operation.get("expected", {}).get("dot_state_blob_sha"), SHA)
    require(operation.get("request_sha256") == digest(operation["request"])
            and operation.get("intent_sha256") == digest({k: v for k, v in operation.items()
                     if k not in {"intent_sha256", "request_sha256"}}), "consumed intent changed")
    return key


def _pending(state):
    _state(state)
    operation = state["pending_operation"]
    key = _operation(operation)
    require(sum(same(row, operation) for row in state["operations"]) == 1, "pending/history disagree")
    require(state["active_task"] is None, "source task cannot share operational transitions")
    lease = state["lease"]
    require(type(lease) is dict and lease.get("scope") == SCOPE
            and lease.get("operation_id") == operation["id"]
            and lease.get("id") == operation["send_claim"]["lease_id"], "unrelated or missing operational lease")
    return operation, key


def _binding(state, observation, now):
    require(type(observation) is dict, "observation required")
    hexadecimal(observation.get("expected_state_blob_sha"), SHA)
    require(observation.get("state_sha256") == digest(state), "full state snapshot changed")
    stamp(observation.get("observed_at"), now, fresh=True)
    protocol = _protocol(state, observation.get("authority"), now)
    old = state["pending_operation"].get("authority", {})
    require(old.get("source_grant_id") == state["grant_id"]
            and old.get("original_sha256") == protocol["original_ops_sha256"]
            and old.get("amendment_sha256") == protocol["runner_amendment_sha256"], "changed base delegation")
    return protocol


def _outcomes(state, operation):
    rows = [row for row in state["operations"] if row.get("kind") == OUTCOME
            and row.get("operation_id") == operation["id"]]
    for row in rows:
        require(row.get("id") == "ops-outcome-" + digest({k: v for k, v in row.items() if k != "id"})
                and row.get("original_operation_sha256") == digest(operation)
                and row.get("logical_key") == _request(operation), "outcome history changed")
    return rows


def _no_send(operation, primary):
    require(type(primary) is dict and primary.get("origin") == "native-tool-result"
            and primary.get("dispatch_stage") == "rejected-before-connector-invocation",
            "authenticate actual pre-dispatch stage, not absent runs or an error guess")
    require(primary.get("operation_id") == operation["id"]
            and primary.get("request_sha256") == operation["request_sha256"]
            and same(primary.get("call"), operation["request"]), "refusal is not this exact native call")
    text(primary.get("transcript_ref"))
    result = primary.get("result", {})
    require(set(result) == {"content", "isError"} and result["isError"] is True
            and type(result["content"]) is list and len(result["content"]) == 1,
            "original native result required")
    item = result["content"][0]
    require(type(item) is dict and set(item) == {"type", "text"} and item["type"] == "text",
            "original native text envelope required")
    message = text(item["text"])
    require(message.startswith("This action was rejected due to unacceptable risk.\nReason: ")
            and "Do not bypass this rejection" in message, "HTTP, timeout or arbitrary text is not no-send proof")
    require(primary.get("contradictory_evidence") == [], "contradictory transport evidence")
    # Format validation is NOT authentication. This field must be an actual
    # native-stage observation, never assigned solely by matching the text above.


def _run(operation, run):
    require(type(run) is dict and type(run.get("id")) is int and run["id"] > 0
            and type(run.get("run_attempt")) is int and run["run_attempt"] == 1
            and run.get("event") == "workflow_dispatch" and run.get("head_branch") == "main"
            and run.get("path") == ".github/workflows/" + WORKFLOWS[operation["kind"]]
            and run.get("head_sha") == operation["expected"]["main_sha"]
            and run.get("repository", {}).get("full_name") == REPOSITORY, "wrong original workflow run")
    text(run.get("html_url"))
    created_text = text(run.get("created_at"))
    created, prepared = instant(created_text), instant(operation["prepared_at"])
    # GitHub's whole-second value represents [created, created + 1 second).
    # Only that interval may overlap preparation; no previous second or precise
    # earlier timestamp is accepted. All original event/run bindings still apply.
    whole_second = re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|\+00:00)", created_text)
    require(created >= prepared or (whole_second and prepared - created < timedelta(seconds=1)),
            "historical run predates this attempt")
    actor = run.get("actor", {}).get("login")
    require(type(actor) is str and actor.casefold() == "omnividente"
            and run.get("triggering_actor", {}).get("login") == actor,
            "run must retain its configured original owner actor")
    require(same(run.get("inputs"), operation["request"]["arguments"]["inputs"]),
            "run inputs must come from the original event/log, not its title")


def reconcile_operation(state, observation, *, now):
    """Record delivery outcome; delivered != successful recovery.

    Unknown observations append evidence but retain pending/lease. A proven
    no-send settles the attempt, not its underlying incident, and grants no new
    send. A delivered run remains verification_required under the old runner
    protocol. Full recovery/Sync completion is still reconciled by that protocol.
    """
    operation, key = _pending(state)
    _binding(state, observation, now)
    outcome = observation.get("outcome")
    require(outcome in {"unknown", "not_sent", "delivered"}, "unsupported delivery outcome")
    rows = _outcomes(state, operation)
    require(not any(row["outcome"] in {"not_sent", "verified"} for row in rows), "attempt already settled")
    if outcome == "not_sent":
        require(not rows, "a recorded uncertain or delivered attempt cannot acquire retry rights")
        _no_send(operation, observation.get("primary"))
    elif outcome == "delivered":
        _run(operation, observation.get("run"))
        previous = [row["observation"]["run"] for row in rows if row["outcome"] == "delivered"]
        require(not previous or all(run["id"] == observation["run"]["id"] for run in previous),
                "multiple candidate runs are not a confirmed delivery")
    else:
        text(observation.get("evidence_ref"))
        text(observation.get("reason")); hexadecimal(observation.get("evidence_sha256"))
    # Repeated hourly observation is not new progress or another ledger event.
    if rows and rows[-1]["outcome"] == outcome:
        old = rows[-1]["observation"]
        fields = ("evidence_ref", "evidence_sha256", "reason") if outcome == "unknown" else ("run",)
        if all(same(old.get(field), observation.get(field)) for field in fields):
            return deepcopy(state)
    record = {"kind": OUTCOME, "operation_id": operation["id"], "logical_key": key,
              "original_operation_sha256": digest(operation), "outcome": outcome,
              "recorded_at": now.isoformat(), "observation": deepcopy(observation)}
    if outcome == "not_sent":
        record["released_lease"] = deepcopy(state["lease"])
    record["id"] = "ops-outcome-" + digest(record)
    require(not any(row["id"] == record["id"] for row in state["operations"]), "observation already recorded")
    result = deepcopy(state)
    result["operations"].append(record)
    if outcome == "not_sent":
        result["pending_operation"] = None
        result["lease"] = None
    # No successful-execution claim from dispatch ACK, run status or no-send.
    return result


def _fresh_preflight(state, candidate, preflight, protocol, now):
    require(type(preflight) is dict and preflight.get("state_sha256") == digest(state), "stale state preflight")
    stamp(preflight.get("observed_at"), now, fresh=True)
    expected = candidate["expected"]
    hexadecimal(preflight.get("expected_state_blob_sha"), SHA)
    require(expected["dot_state_blob_sha"] == preflight["expected_state_blob_sha"], "wrong expected blob")
    require(preflight.get("main_sha") == expected.get("main_sha"), "stale main")
    hexadecimal(expected.get("main_sha"), SHA)
    workflow = WORKFLOWS[candidate["kind"]]
    require(expected.get("workflow_blob") == protocol["workflow_blobs"][workflow]
            and preflight.get("workflow_blob") == expected["workflow_blob"]
            and preflight.get("workflow_state") == "active", "unaccepted workflow")
    require(same(preflight.get("installed_blobs"), protocol["contract_blobs"]), "installed native contract changed")
    inputs = candidate["request"]["arguments"]["inputs"]
    if candidate["kind"] == RECOVERY:
        require(expected.get("state_sha") == inputs["expected_state_sha"]
                and preflight.get("state_sha") == inputs["expected_state_sha"]
                and preflight.get("decision_id") == inputs["decision_id"], "stale incident")
    else:
        verified = [row for row in state["operations"] if row.get("kind") == OUTCOME
                    and row.get("outcome") == "verified" and row.get("receipt_id") == candidate["fence_receipt_id"]]
        require(len(verified) == 1, "Sync needs the retained completed original fence")
        original = next((row for row in state["operations"] if row["id"] == verified[0]["operation_id"]), None)
        require(original is not None and original.get("kind") == RECOVERY
                and verified[0] in _outcomes(state, original), "foreign fence receipt")
        require(preflight.get("main_sha") == inputs["main_sha"]
                and preflight.get("lab_sha") == inputs["lab_sha"]
                and preflight.get("fence_receipt_id") == candidate["fence_receipt_id"], "stale Sync/fence")
    # Retain full actual evidence references. This helper cannot replace the
    # caller's primary-source verification or the native runner's eligibility.
    for name in ("authority_evidence", "eligibility_evidence", "ci_evidence"):
        evidence = preflight.get(name)
        require(type(evidence) is dict and evidence.get("status") == "verified", "incomplete preflight")
        text(evidence.get("evidence_ref")); hexadecimal(evidence.get("sha256"))
    require(preflight.get("conflicting_operation") is None, "conflicting operation")


def prepare_operation(state, candidate, preflight, authority, *, predecessor_id=None, now):
    """Prepare one consumed attempt, initial or one linked no-send successor.

    Exact returned bytes MUST be CAS-persisted/read back before one actual call.
    Restart or unknown CAS never revives the process-local permission to send.
    """
    _state(state)
    require(state["pending_operation"] is None and state["lease"] is None
            and state["active_task"] is None, "pending operation or source lease blocks a new attempt")
    protocol = _protocol(state, authority, now)
    key = _request(candidate)
    require(candidate.get("status") == "pending" and candidate.get("not_source_task_admission") is True,
            "operational candidate required")
    text(candidate.get("id"))
    require(not any(row["id"] == candidate["id"] for row in state["operations"]), "operation id already used")
    require(not any(k in candidate for k in ("intent_sha256", "request_sha256", "successor_of", "logical_key")),
            "caller cannot preassign lineage or digests")
    claim = candidate.get("send_claim", {})
    require(claim.get("consumed") is True and type(claim.get("maximum_sends")) is int
            and claim["maximum_sends"] == 1, "one consumed send claim required")
    lease_id = text(claim.get("lease_id"))
    stamp(candidate.get("prepared_at"), now, fresh=True)
    old = candidate.get("authority", {})
    require(old.get("source_grant_id") == state["grant_id"]
            and old.get("original_sha256") == protocol["original_ops_sha256"]
            and old.get("amendment_sha256") == protocol["runner_amendment_sha256"], "changed base delegation")
    _fresh_preflight(state, candidate, preflight, protocol, now)
    attempts = [row for row in state["operations"] if row.get("kind") in WORKFLOWS and _request(row) == key]
    operation = deepcopy(candidate)
    if predecessor_id is None:
        require(not attempts, "logical operation already has an attempt; changing an id or SHA does not reset it")
    else:
        require(len(attempts) == 1 and attempts[0]["id"] == predecessor_id
                and "successor_of" not in attempts[0], "at most one successor, never a retry chain")
        previous = attempts[0]; _operation(previous)
        require(same(previous.get("authority"), operation.get("authority")), "successor cannot rebind authority")
        outcomes = _outcomes(state, previous)
        terminal = [row for row in outcomes if row["outcome"] == "not_sent"]
        require(len(terminal) == 1 and not any(row["outcome"] == "delivered" for row in outcomes),
                "proven, CAS-settled no-send required")
        settled = terminal[0]
        require(settled["original_operation_sha256"] == digest(previous), "original operation changed")
        _no_send(previous, settled["observation"].get("primary"))
        require(same(operation["request"], previous["request"]), "successor cannot change tool, transport or inputs")
        require(preflight["expected_state_blob_sha"] != settled["observation"]["expected_state_blob_sha"],
                "settlement CAS readback required")
        remediation = preflight.get("remediation")
        require(type(remediation) is dict and remediation.get("refusal_sha256") == digest(settled["observation"]["primary"])
                and remediation.get("status") == "conditions-addressed-normal-platform-review-required",
                "actual refusal conditions must be addressed, not overridden")
        text(remediation.get("evidence_ref")); hexadecimal(remediation.get("evidence_sha256"))
        stamp(remediation.get("observed_at"), now, fresh=True)
        require(instant(remediation["observed_at"]) >= instant(settled["recorded_at"]), "old evidence is not remediation")
        operation["successor_of"] = {"operation_id": previous["id"], "outcome_id": settled["id"],
                                     "outcome_sha256": digest(settled)}
    operation["logical_key"] = key
    operation["protocol"] = {"id": protocol["id"], "sha256": digest(protocol)}
    operation["preflight"] = deepcopy(preflight)
    operation["intent_sha256"] = digest(operation)
    operation["request_sha256"] = digest(operation["request"])
    _operation(operation)
    result = deepcopy(state)
    result["operations"].append(deepcopy(operation))
    result["pending_operation"] = operation
    result["lease"] = {"id": lease_id, "scope": SCOPE, "operation_id": operation["id"],
                       "acquired_at": now.isoformat(), "expected_content_sha": preflight["expected_state_blob_sha"]}
    return result


def _bundle(operation, evidence, archive):
    """Check supplied original retained artifact bytes; caller authenticates GETs."""
    run, artifact = evidence.get("run"), evidence.get("artifact", {})
    _run(operation, run)
    require(run.get("status") == "completed" and run.get("conclusion") == "success",
            "native run not successfully completed")
    jobs = evidence.get("jobs")
    expected_steps = ({"Fence exactly one unclaimed delivery by owner-bound state CAS",
                       "Retain acknowledged fence or safe blocked outcome"} if operation["kind"] == RECOVERY else
                      {"Retain a terminal preparation or publish one checked finalization", "Preserve final outcome"})
    require(type(jobs) is list and jobs, "original native/upload job evidence required")
    relevant = []
    for job in jobs:
        require(type(job) is dict and job.get("run_id") == run["id"]
                and job.get("head_sha") == run["head_sha"], "foreign job")
        steps = job.get("steps", [])
        if expected_steps.intersection(step.get("name") for step in steps):
            relevant.append(job)
    require(len(relevant) == 1 and relevant[0].get("status") == "completed"
            and relevant[0].get("conclusion") == "success", "missing original native job")
    for name in expected_steps:
        matches = [step for step in relevant[0]["steps"] if step.get("name") == name]
        require(len(matches) == 1 and matches[0].get("status") == "completed"
                and matches[0].get("conclusion") == "success", "native/proof retention not successful")
    expected_name = ("owner-fence-" + str(run["id"]) + "-1" if operation["kind"] == RECOVERY
                     else "autonomous-sync-result-1")
    require(type(archive) is bytes and 0 < len(archive) <= MAX_ARTIFACT_BYTES
            and artifact.get("name") == expected_name and artifact.get("expired") is False
            and type(artifact.get("id")) is int and artifact["id"] > 0
            and artifact.get("digest") == "sha256:" + hashlib.sha256(archive).hexdigest()
            and artifact.get("workflow_run", {}).get("id") == run["id"]
            and artifact["workflow_run"].get("head_sha") == run["head_sha"], "retained artifact mismatch")
    member_limits = ({"owner-fence-result.json": MAX_FENCE_MEMBER_BYTES,
                      "owner-fence-proof.json": MAX_FENCE_MEMBER_BYTES} if operation["kind"] == RECOVERY
                     else {"sync-result.json": MAX_SYNC_RESULT_BYTES})
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate JSON member")
            result[key] = value
        return result
    def nonfinite(_):
        raise ValueError("nonfinite artifact number")
    def finite_float(value):
        number = float(value)
        require(math.isfinite(number), "nonfinite artifact number")
        return number
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            entries = bundle.infolist()
            require(len(entries) == len(member_limits) and {e.filename for e in entries} == set(member_limits)
                    and all(0 < e.file_size <= member_limits[e.filename] and not e.is_dir()
                            and e.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                            for e in entries), "unexpected artifact members")
            result = {}
            for entry in entries:
                limit = member_limits[entry.filename]
                with bundle.open(entry) as member:
                    raw = member.read(limit + 1)
                require(len(raw) == entry.file_size and len(raw) <= limit, "artifact member size mismatch")
                value = json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite, parse_float=finite_float)
                require(type(value) is dict, "artifact member must be a JSON object")
                result[entry.filename] = value
            return result
    except (zipfile.BadZipFile, UnicodeError, RuntimeError, OSError, RecursionError) as exc:
        raise ValueError("unreadable original artifact") from exc


def complete_operation(state, evidence, archive, *, now):
    """Settle only a verified original execution; never infer success from ACK.

    A committed fence with missing proof stays pending. A late positive result
    can settle an unknown delivery by GET; it never mints another send claim.
    """
    operation, key = _pending(state)
    _binding(state, evidence, now)
    previous = _outcomes(state, operation)
    require(not any(row["outcome"] in {"not_sent", "verified"} for row in previous), "contradictory settled attempt")
    run = evidence.get("run", {})
    require(not any(row["outcome"] == "delivered" and row["observation"]["run"]["id"] != run.get("id")
                    for row in previous), "execution differs from delivered run")
    data = _bundle(operation, evidence, archive)
    inputs = operation["request"]["arguments"]["inputs"]
    if operation["kind"] == RECOVERY:
        proof, native = data["owner-fence-proof.json"], data["owner-fence-result.json"]
        expected_context = {"repository": REPOSITORY, "workflow": WORKFLOWS[RECOVERY],
                            "ref": "refs/heads/main", "event_name": "workflow_dispatch",
                            "control_sha": run["head_sha"], "run_id": str(run["id"]), "run_attempt": "1",
                            "actor": run.get("actor", {}).get("login"), **inputs}
        require(set(proof) == {"schema", "kind", "status", "context", "before", "after", "checks", "native_outcome", "allows_sync"}
                and set(native) == {"outcome", "decision_id", "receipt_id", "state_sha", "frontier_seq"}
                and proof.get("schema") == 1 and type(proof["schema"]) is int
                and proof.get("kind") == "owner-fence-full-state-proof" and proof.get("status") == "verified"
                and proof.get("native_outcome") == "fenced" and proof.get("allows_sync") is True
                and same(proof.get("context"), expected_context), "missing exact runner proof")
        before, after, checks = proof.get("before", {}), proof.get("after", {}), proof.get("checks", {})
        require(before.get("commit_sha") == inputs["expected_state_sha"]
                and native.get("outcome") == "fenced" and native.get("decision_id") == inputs["decision_id"]
                and native.get("state_sha") == after.get("commit_sha")
                and native.get("receipt_id") == checks.get("native_receipt_id")
                and type(native.get("frontier_seq")) is int and native["frontier_seq"] > 0
                and native["frontier_seq"] == checks.get("native_frontier_seq")
                and type(checks.get("added_event_count")) is int and checks["added_event_count"] == 1
                and type(checks.get("prior_event_count")) is int and checks["prior_event_count"] > 0,
                "native fence/proof mismatch")
        for snapshot in (before, after):
            for field in ("commit_sha", "blob_sha"):
                hexadecimal(snapshot.get(field), SHA)
            hexadecimal(snapshot.get("sha256"))
            require(type(snapshot.get("bytes")) is int and snapshot["bytes"] > 0, "missing full snapshot identity")
        for field in ("body_sha256", "prior_journal_sha256", "added_event_id", "native_receipt_id"):
            hexadecimal(checks.get(field))
        require(same(evidence.get("git_readback"), {"before": before, "after": after,
                     "after_parents": [before["commit_sha"]], "current_state_sha": after["commit_sha"]}),
                "actual Git parent/blob/state readback required")
        receipt_id = native["receipt_id"]
    else:
        native = data["sync-result.json"]
        require(native.get("status") == "prepared" and native.get("publication") == "published"
                and native.get("reason") == "verified_fast_forward"
                and native.get("main_sha") == inputs["main_sha"]
                and native.get("lab_sha") == inputs["lab_sha"], "not a completed checked publication")
        for field in ("candidate_sha", "queue_blob"):
            hexadecimal(native.get(field), SHA)
        receipt_id = hexadecimal(native.get("effect_receipt_id"))
        event = evidence.get("publication_event", {})
        body = event.get("evidence", {})
        require(event.get("type") == "EffectObservation" and event.get("kind") == "sync_publication"
                and event.get("receipt_id") == receipt_id
                and event.get("decision_id") == native.get("decision_id")
                and event.get("event_id") == digest({k: v for k, v in event.items() if k != "event_id"})
                and receipt_id == digest([event.get("decision_id"), event.get("executor_claim_id"),
                                          "sync_publication", body]), "durable Sync receipt required")
        executor = evidence.get("executor_claim", {})
        require(executor.get("type") == "ExecutorClaim" and executor.get("decision_id") == event.get("decision_id")
                and executor.get("claim_id") == digest([event["decision_id"], "execute"])
                and event.get("executor_claim_id") == executor["claim_id"]
                and event.get("phase_claim_id") == digest([event["decision_id"], "sync_finalize"])
                and executor.get("event_id") == digest({k: v for k, v in executor.items() if k != "event_id"}),
                "Sync effect must bind its original durable executor and finalize claim")
        trigger = executor.get("trigger", {})
        require(all(trigger.get(k) == v for k, v in {"run_id":str(run["id"]), "run_attempt":"1",
                    "control_sha":run["head_sha"], "repository":REPOSITORY, "event_name":"workflow_dispatch",
                    "actor":run["actor"]["login"]}.items()), "foreign Sync executor")
        require(body.get("quality_gate") == "success"
                and body.get("published_lab_sha") == native["candidate_sha"]
                and all(body.get(k) == native.get(k) for k in ("main_sha", "lab_sha", "candidate_sha", "queue_blob"))
                and body.get("candidate_branch") == "autonomous/sync-" + str(run["id"]) + "-1",
                "publication does not bind the checked original execution")
        require(same(evidence.get("git_readback"), {"current_lab_sha": native["candidate_sha"],
                     "candidate_parents": [inputs["lab_sha"], inputs["main_sha"]],
                     "before_queue_blob": native["queue_blob"], "after_queue_blob": native["queue_blob"]}),
                "actual checked lab/queue readback required")
    text(evidence.get("execution_evidence_ref"))
    record = {"kind": OUTCOME, "operation_id": operation["id"], "logical_key": key,
              "original_operation_sha256": digest(operation), "outcome": "verified",
              "recorded_at": now.isoformat(), "receipt_id": receipt_id,
              "execution_record": deepcopy(data), "observation": deepcopy(evidence), "released_lease": deepcopy(state["lease"])}
    record["id"] = "ops-outcome-" + digest(record)
    result = deepcopy(state)
    result["operations"].append(record)
    result["pending_operation"] = None
    result["lease"] = None
    return result
