#!/usr/bin/env python3
"""One durable dispatch/execution frontier in the existing authoritative queue.

A successful *new* acknowledged claim issues a process-local, one-use capability.
Reading a claim, observing a run or recovering a lost acknowledgement never does.
The journal is not a cadence checkpoint and cannot itself advance the loop.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

NEXT = "autonomous_next_task.yml"
CONTINUE = "autonomous_continue.yml"
SYNC = "autonomous_sync.yml"
WORKFLOWS = frozenset((NEXT, CONTINUE, SYNC))
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
KEY = re.compile(r"[0-9a-f]{32}\Z")
EVENT_NAMES = frozenset(("workflow_dispatch", "workflow_run", "schedule", "push"))
_ISSUER = object()


class JournalConflict(RuntimeError):
    """The current durable frontier does not authorize this operation."""


class JournalUninitialized(JournalConflict):
    """Legacy ingress must be fenced before explicitly initializing the journal."""


class JournalUncertain(JournalConflict):
    """A claim may be durable, but its caller has no right to perform the effect."""


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def _timestamp(value) -> datetime:
    if not isinstance(value, str):
        raise ValueError("journal timestamp must be a UTC string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset().total_seconds() != 0:
        raise ValueError("journal timestamp must be UTC")
    return parsed


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_inputs(workflow: str, inputs: dict) -> dict:
    """Canonical typed semantic inputs, excluding the immutable correlation key."""
    if workflow not in WORKFLOWS or not isinstance(inputs, dict):
        raise ValueError("invalid dispatch workflow or inputs")
    defaults = {
        NEXT: {"task_id": "", "recover_report": False, "repair_after": "",
               "recover_feedback": False, "feedback_after": "", "focus": "",
               "risk_ceiling": "medium", "automatic": False},
        CONTINUE: {}, SYNC: {"main_sha": "", "lab_sha": ""},
    }[workflow]
    if set(inputs) - set(defaults) - {"continuation_key"}:
        raise ValueError("unexpected dispatch inputs")
    result = dict(defaults)
    for name, default in defaults.items():
        value = inputs.get(name, default)
        if isinstance(default, bool):
            if type(value) is bool:
                result[name] = value
            elif value in ("true", "false", ""):
                result[name] = value == "true"
            else:
                raise ValueError("invalid dispatch boolean")
        else:
            if value is None:
                value = default
            if not isinstance(value, str) or len(value) > 2048:
                raise ValueError("invalid dispatch string")
            result[name] = value or default
    if workflow == NEXT and result["risk_ceiling"] not in ("low", "medium", "high"):
        raise ValueError("invalid dispatch risk ceiling")
    if workflow == SYNC and any(result[name] and not SHA.fullmatch(result[name])
                                for name in ("main_sha", "lab_sha")):
        raise ValueError("invalid sync input pin")
    return result


def _trigger(trigger: dict, control_sha: str) -> dict:
    if not isinstance(trigger, dict) or not SHA.fullmatch(str(control_sha)):
        raise ValueError("invalid journal control context")
    result = copy.deepcopy(trigger)
    for field in ("run_id", "run_attempt"):
        value = str(result.get(field, ""))
        if not re.fullmatch(r"[1-9][0-9]*", value):
            raise ValueError("journal requires the actual run and attempt")
        result[field] = value
    if result.get("event_name") not in EVENT_NAMES:
        raise ValueError("invalid journal trigger event")
    if result.get("control_sha", control_sha) != control_sha:
        raise ValueError("journal control SHA does not match trigger")
    result["control_sha"] = control_sha
    if result.get("ref", "refs/heads/main") != "refs/heads/main":
        raise ValueError("journal requires trusted main ingress")
    for name in ("source_run_id", "source_run_attempt"):
        if name in result:
            value = str(result[name])
            if not re.fullmatch(r"[1-9][0-9]*", value):
                raise ValueError("invalid callback source identity")
            result[name] = value
    return result


def _source_identity(trigger: dict) -> str:
    # A workflow rerun and a repeated completion callback are the same source.
    event = trigger["event_name"]
    if event == "workflow_run":
        if not trigger.get("source_run_id") or not trigger.get("source_run_attempt"):
            raise JournalConflict("callback has no verified source identity")
        source = [event, trigger["source_run_id"]]
    elif event == "push":
        source = [event, trigger["control_sha"]]
    else:
        source = [event, trigger["run_id"]]
    return digest(source)


def _intent_source(state: dict, trigger: dict, source_kind: str) -> str:
    if source_kind == "sender" and state["predecessor_decision_id"]:
        return digest(["causal_receipt", state["predecessor_decision_id"]])
    return _source_identity(trigger)


def substantive_digest(manifest: dict) -> str:
    """Ignore journal/cadence and observation-only timestamp changes."""
    volatile = {"updated_at", "observed_at", "last_poll_at", "last_tick_at", "at"}

    def project(value):
        if isinstance(value, dict):
            return {key: project(item) for key, item in value.items() if key not in volatile}
        if isinstance(value, list):
            return [project(item) for item in value]
        return value

    return digest(project({key: value for key, value in manifest.items()
                           if key not in ("dispatch_journal", "controller")}))


def _body(manifest: dict) -> dict:
    return {key: value for key, value in manifest.items() if key != "dispatch_journal"}


def _decision(epoch: str, frontier: int, predecessor: str) -> str:
    return digest([epoch, frontier, predecessor])


def _event(event_type: str, **fields) -> dict:
    result = {"type": event_type, "at": _now(), **copy.deepcopy(fields)}
    result["event_id"] = digest(result)
    return result


def _receipt_id(decision_id: str, claim_id: str, kind: str, evidence: dict) -> str:
    return digest([decision_id, claim_id, kind, evidence])


def _valid_effect(kind: str, evidence: dict, intent: dict, executor: dict,
                  phases: dict, stages: dict) -> None:
    if not isinstance(evidence, dict):
        raise ValueError("effect evidence must be an object")
    if kind == "controller_checkpoint":
        if intent["workflow"] != NEXT:
            raise ValueError("controller checkpoint requires NEXT execution")
        for field in ("before_state_sha", "after_state_sha"):
            if not SHA.fullmatch(str(evidence.get(field, ""))):
                raise ValueError("checkpoint requires actual state revisions")
        for field in ("before_digest", "after_digest"):
            if not DIGEST.fullmatch(str(evidence.get(field, ""))):
                raise ValueError("checkpoint requires substantive state digests")
        if evidence["before_digest"] != executor["before_digest"]:
            raise ValueError("checkpoint does not start from the original executor baseline")
        if evidence["before_digest"] == evidence["after_digest"]:
            observations = evidence.get("poll_observations")
            if not isinstance(observations, list) or not observations:
                raise ValueError("no substantive change or completed bound worker poll")
            for observation in observations:
                if (not isinstance(observation, dict) or not observation.get("task_id")
                        or not observation.get("session_id") or not observation.get("session_state")
                        or observation["session_state"] == "UNKNOWN"):
                    raise ValueError("completed poll requires bound worker observations")
                _timestamp(observation.get("observed_at"))
    elif kind == "sync_publication":
        if intent["workflow"] != SYNC or "sync_finalize" not in phases:
            raise ValueError("publication requires the original finalize stage")
        stage = stages.get(evidence.get("stage_id"))
        if stage is None or stage["decision_id"] != intent["decision_id"]:
            raise ValueError("publication does not bind the prepared stage")
        prepared = stage["evidence"]
        for field in ("main_sha", "lab_sha", "candidate_sha", "queue_blob", "candidate_branch"):
            if evidence.get(field) != prepared.get(field):
                raise ValueError("publication changed its prepared pins")
        if (evidence.get("quality_gate") != "success"
                or evidence.get("published_lab_sha") != prepared["candidate_sha"]
                or prepared["candidate_sha"] == prepared["lab_sha"]):
            raise ValueError("publication has no checked changed head")
    elif kind == "continue_handoff":
        if intent["workflow"] != CONTINUE:
            raise ValueError("bounded continuation requires CONTINUE execution")
        for field in ("run_id", "run_attempt", "event_name", "control_sha"):
            if str(evidence.get(field, "")) != str(executor["trigger"].get(field, "")):
                raise ValueError("continuation evidence belongs to another executor")
        if (evidence.get("decision_id") != intent["decision_id"]
                or evidence.get("stage") != "bounded_observe_wait"
                or evidence.get("switch_enabled") is not True):
            raise ValueError("continuation stage is not completed")
        started = _timestamp(evidence.get("stage_started_at"))
        completed = _timestamp(evidence.get("stage_completed_at"))
        waited = evidence.get("waited_seconds")
        if (completed < started or type(waited) not in (int, float) or waited < 0
                or waited > (completed - started).total_seconds() + 1):
            raise ValueError("invalid continuation wait evidence")
        observation = evidence.get("observation")
        if (not isinstance(observation, dict) or observation.get("health") not in ("ok", "attention", "stalled")
                or observation.get("action") not in ("next_task", "sync", "none")
                or not isinstance(observation.get("reason"), str)):
            raise ValueError("continuation requires a successful health observation")
        for field in ("main_sha", "lab_sha", "state_sha"):
            if not SHA.fullmatch(str(observation.get(field, ""))):
                raise ValueError("continuation observation requires actual revisions")
        if observation.get("due_at") is not None:
            _timestamp(observation["due_at"])
    else:
        raise ValueError("unsupported causal effect")


def _sender_basis(state, basis):
    if not isinstance(basis, dict):
        raise JournalConflict("sender basis must identify the current causal receipt")
    predecessor = state["predecessor_decision_id"]
    receipt = state["effects"].get(predecessor) or state["completions"].get(predecessor)
    expected = receipt["receipt_id"] if receipt else None
    if basis.get("receipt_id") != expected:
        raise JournalConflict("sender basis is not the current predecessor receipt")


def _valid_completion(evidence, intent, executor, state):
    if (intent["workflow"] != SYNC or not isinstance(evidence, dict)
            or evidence.get("status") not in {"up_to_date", "busy", "conflict", "disabled"}
            or not isinstance(evidence.get("reason"), str) or not evidence["reason"]
            or intent["decision_id"] in state["effects"]
            or intent["decision_id"] in state["phase_claims"]
            or any(stage["decision_id"] == intent["decision_id"] for stage in state["stages"].values())):
        raise ValueError("no-effect completion requires an unprepared SYNC execution")
    for field in ("main_sha", "lab_sha"):
        if evidence.get(field) != intent["normalized_inputs"][field]:
            raise ValueError("no-effect completion changed its execution pins")
    branch = "autonomous/sync-" + executor["trigger"]["run_id"] + "-" + executor["trigger"]["run_attempt"]
    if (evidence.get("candidate_branch") != branch or evidence.get("candidate_sha") != ""
            or (evidence.get("queue_blob") and not SHA.fullmatch(str(evidence["queue_blob"])))
            or (evidence["status"] == "up_to_date" and
                (evidence["reason"] != "main_already_integrated" or not evidence.get("queue_blob")))):
        raise ValueError("no-effect completion cannot claim a candidate publication")


def materialize(journal: dict) -> dict:
    """Validate the complete append-only event state machine, then project it."""
    if (not isinstance(journal, dict) or set(journal) != {"version", "events"}
            or journal["version"] != 1 or not isinstance(journal["events"], list)
            or not journal["events"]):
        raise ValueError("dispatch_journal requires version 1 and nonempty events")
    state = {"frontier_seq": 0, "predecessor_decision_id": "", "active_intent": None,
             "intents": {}, "send_claims": {}, "executor_claims": {}, "stages": {},
             "phase_claims": {}, "effects": {}, "completions": {}, "completed_receipts": set(),
             "advanced_receipts": set(), "source_ids": set()}
    event_ids = set()
    for index, event in enumerate(journal["events"]):
        if not isinstance(event, dict):
            raise ValueError("journal event must be an object")
        expected_id = digest({key: value for key, value in event.items() if key != "event_id"})
        if event.get("event_id") != expected_id or expected_id in event_ids:
            raise ValueError("invalid or repeated journal event identity")
        event_ids.add(expected_id)
        _timestamp(event.get("at"))
        kind = event.get("type")
        if index == 0:
            basis = event.get("basis")
            if (kind != "Init" or not SHA.fullmatch(str(event.get("control_sha", "")))
                    or not isinstance(basis, dict) or basis.get("kind") != "fenced_bootstrap"
                    or basis.get("legacy_senders_fenced") is not True
                    or basis.get("pending_legacy") != "none"
                    or (basis.get("state_sha") and not SHA.fullmatch(str(basis["state_sha"])))):
                raise ValueError("journal initialization requires fenced legacy ingress")
            state["init"] = event
            state["epoch"] = event["event_id"]
            continue
        decision_id = event.get("decision_id")
        intent = state["intents"].get(decision_id)
        if kind == "Intent":
            if state["active_intent"] is not None:
                raise ValueError("journal permits only one unfinished intent")
            expected = _decision(state["epoch"], state["frontier_seq"], state["predecessor_decision_id"])
            if (decision_id != expected or event.get("frontier_seq") != state["frontier_seq"]
                    or event.get("predecessor_decision_id") != state["predecessor_decision_id"]
                    or event.get("correlation_key") != digest([decision_id, "dispatch"])[:32]
                    or event.get("source_kind") not in ("sender", "external")):
                raise ValueError("intent does not bind the current logical frontier")
            normalized = normalize_inputs(event.get("workflow"), event.get("normalized_inputs"))
            if normalized != event["normalized_inputs"] or event.get("input_hash") != digest(normalized):
                raise ValueError("intent inputs are not canonical")
            trigger = _trigger(event.get("first_source_trigger"), event.get("control_sha"))
            if event.get("source_identity") != _intent_source(state, trigger, event["source_kind"]):
                raise ValueError("intent source identity changed")
            if event["source_kind"] == "sender":
                _sender_basis(state, event.get("basis"))
            if event["source_identity"] in state["source_ids"]:
                raise ValueError("a repeated source cannot create another intent")
            state["source_ids"].add(event["source_identity"])
            state["intents"][decision_id] = event
            state["active_intent"] = event
            continue
        if intent is None:
            raise ValueError("journal event does not identify an intent")
        executor = state["executor_claims"].get(decision_id)
        if kind == "DeliveryObservation":
            if not isinstance(event.get("observation"), dict):
                raise ValueError("delivery observation must be metadata")
            continue
        if state["active_intent"] is not intent:
            raise ValueError("completed frontier cannot acquire new rights")
        if kind in ("SendClaim", "ExecutorClaim"):
            trigger = _trigger(event.get("trigger"), intent["control_sha"])
            if kind == "SendClaim":
                if (decision_id in state["send_claims"] or executor is not None
                        or intent["source_kind"] != "sender"
                        or event.get("claim_id") != digest([decision_id, "send"])):
                    raise ValueError("dispatch right has already been consumed")
                state["send_claims"][decision_id] = event
            else:
                if (executor is not None or event.get("claim_id") != digest([decision_id, "execute"])
                        or (intent["source_kind"] == "sender" and decision_id not in state["send_claims"])
                        or (intent["source_kind"] == "sender" and
                            (event.get("correlation_key") != intent["correlation_key"]
                             or trigger["event_name"] != "workflow_dispatch"))
                        or not SHA.fullmatch(str(event.get("before_state_sha", "")))
                        or not DIGEST.fullmatch(str(event.get("before_digest", "")))):
                    raise ValueError("execution right has already been consumed or is unbound")
                state["executor_claims"][decision_id] = event
                state["source_ids"].add(_source_identity(trigger))
            continue
        if executor is None or event.get("executor_claim_id") != executor["claim_id"]:
            raise ValueError("effect or stage lacks the original executor")
        if kind == "ExecutionStage":
            evidence = event.get("evidence")
            if (intent["workflow"] != SYNC or event.get("phase") != "sync_prepared"
                    or event.get("stage_id") in state["stages"] or not isinstance(evidence, dict)
                    or evidence.get("status") != "prepared" or evidence.get("candidate_owned") is not True
                    or event.get("evidence_hash") != digest(evidence)):
                raise ValueError("invalid prepared execution checkpoint")
            for field in ("main_sha", "lab_sha", "candidate_sha", "queue_blob"):
                if not SHA.fullmatch(str(evidence.get(field, ""))):
                    raise ValueError("prepared checkpoint requires exact pins")
            if not re.fullmatch(r"autonomous/sync-[1-9][0-9]*-[1-9][0-9]*", str(evidence.get("candidate_branch", ""))):
                raise ValueError("prepared checkpoint requires its owned candidate branch")
            if any(stage["decision_id"] == decision_id for stage in state["stages"].values()):
                raise ValueError("prepared execution stage already recorded")
            state["stages"][event["stage_id"]] = event
        elif kind == "PhaseClaim":
            phases = state["phase_claims"].setdefault(decision_id, {})
            stage = state["stages"].get(event.get("stage_id"))
            if (event.get("phase") != "sync_finalize" or event["phase"] in phases
                    or stage is None or stage["decision_id"] != decision_id
                    or event.get("trigger") != executor["trigger"]
                    or event.get("claim_id") != digest([decision_id, "sync_finalize"])):
                raise ValueError("finalize right is not a new stage of the original executor")
            phases[event["phase"]] = event
        elif kind == "EffectObservation":
            if decision_id in state["effects"]:
                raise ValueError("executor already recorded its causal effect")
            effect_kind, evidence = event.get("kind"), event.get("evidence")
            _valid_effect(effect_kind, evidence, intent, executor,
                          state["phase_claims"].get(decision_id, {}), state["stages"])
            if event.get("receipt_id") != _receipt_id(decision_id, executor["claim_id"], effect_kind, evidence):
                raise ValueError("effect receipt identity changed")
            if effect_kind == "sync_publication":
                phase = state["phase_claims"][decision_id]["sync_finalize"]
                if event.get("phase_claim_id") != phase["claim_id"]:
                    raise ValueError("publication does not bind the finalize claim")
            state["effects"][decision_id] = event
        elif kind == "ExecutionCompletion":
            evidence = event.get("evidence")
            _valid_completion(evidence, intent, executor, state)
            if (event.get("kind") != "sync_no_effect"
                    or event.get("receipt_id") != _receipt_id(decision_id, executor["claim_id"], "sync_no_effect", evidence)
                    or event.get("frontier_seq") != state["frontier_seq"] + 1):
                raise ValueError("invalid no-effect completion identity or frontier")
            state["completions"][decision_id] = event
            state["completed_receipts"].add(event["receipt_id"])
            state["frontier_seq"] += 1
            state["predecessor_decision_id"] = decision_id
            state["active_intent"] = None
        elif kind == "Advance":
            effect = state["effects"].get(decision_id)
            receipt_id = event.get("receipt_id")
            if (effect is None or receipt_id != effect["receipt_id"]
                    or receipt_id in state["advanced_receipts"]
                    or event.get("frontier_seq") != state["frontier_seq"] + 1):
                raise ValueError("advance requires one unconsumed causal receipt")
            state["advanced_receipts"].add(receipt_id)
            state["frontier_seq"] += 1
            state["predecessor_decision_id"] = decision_id
            state["active_intent"] = None
        else:
            raise ValueError("unknown journal event type")
    return state


def validate_journal(journal) -> list[str]:
    try:
        materialize(journal)
        return []
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, JournalConflict) as exc:
        return ["dispatch_journal: " + str(exc)]


def preserve_journal(previous: dict, current: dict) -> None:
    old = previous.get("dispatch_journal")
    new = current.get("dispatch_journal")
    if old is None:
        if new is not None:
            materialize(new)
        return
    if new is None or new.get("version") != old["version"]:
        raise ValueError("dispatch journal cannot be removed or replaced")
    prefix = old["events"]
    if new.get("events", [])[:len(prefix)] != prefix:
        raise ValueError("dispatch journal history is append-only")
    materialize(new)


class _Capability:
    def __init__(self, decision_id, claim_id, trigger, control_sha, *, state_sha="",
                 phase="execute", executor_claim_id="", issuer=None):
        if issuer is not _ISSUER:
            raise JournalConflict("capability can only be issued by a fresh acknowledged claim")
        self.decision_id = decision_id
        self.claim_id = claim_id
        self.executor_claim_id = executor_claim_id or claim_id
        self.trigger = copy.deepcopy(trigger)
        self.control_sha = control_sha
        self.state_sha = state_sha
        self.phase = phase
        self._pid = os.getpid()
        self._used = False
        self._finished = False

    def _check(self):
        if self._pid != os.getpid():
            raise JournalConflict("capability cannot move to another process")

    def consume(self) -> None:
        self._check()
        if self._used:
            raise JournalConflict("capability is one-use")
        self._used = True

    def observer_context(self) -> dict:
        """Describe an owned consumed claim for reads; this is not a capability."""
        self._check()
        if not self._used or self._finished or self.phase != "execute":
            raise JournalConflict("observation requires a consumed unfinished claim")
        return {"kind": "send" if isinstance(self, SendCapability) else "execute",
                "decision_id": self.decision_id, "claim_id": self.claim_id,
                "trigger": copy.deepcopy(self.trigger), "control_sha": self.control_sha}

    def _finish(self) -> None:
        self._check()
        if not self._used or self._finished:
            raise JournalConflict("effect requires a consumed unfinished execution capability")
        self._finished = True


class SendCapability(_Capability):
    pass


class ExecutionCapability(_Capability):
    pass


class JournalStore:
    def __init__(self, repo: Path, manifest_path: Path, revision_path: Path):
        self.repo = Path(repo)
        self.manifest_path = Path(manifest_path)
        self.revision_path = Path(revision_path)
        self._writer_base = None

    def _load(self):
        from state_store import load_state
        data = load_state(self.repo, self.manifest_path, self.revision_path)
        metadata = json.loads(self.revision_path.read_text(encoding="utf-8"))
        return data, metadata["state_sha"]

    def _write(self, data):
        from state_store import StateUncertain, save_state, _atomic_bytes
        _atomic_bytes(self.manifest_path, (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        try:
            return save_state(self.repo, self.manifest_path, self.revision_path, require_ack=True)
        except StateUncertain as exc:
            raise JournalUncertain("journal claim acknowledgement was lost; reconcile only") from exc

    def _mutate(self, operation):
        from state_store import StateConflict
        for attempt in range(3):
            data, state_sha = self._load()
            journal = data.get("dispatch_journal")
            if journal is None:
                raise JournalUninitialized("dispatch journal is not initialized")
            state = materialize(journal)
            value, additions = operation(data, state_sha, state)
            if not additions:
                self._writer_base = copy.deepcopy(_body(data))
                return value, state_sha, False
            previous_body = copy.deepcopy(_body(data))
            journal["events"].extend(additions)
            if _body(data) != previous_body:
                raise ValueError("journal transaction must not mutate substantive state")
            try:
                saved = self._write(data)
            except StateConflict:
                if attempt == 2:
                    raise JournalConflict("journal CAS remained conflicted") from None
                continue
            self._writer_base = previous_body
            return value, saved, True
        raise JournalConflict("journal CAS remained conflicted")

    def initialize(self, expected_sha: str, control_sha: str, basis: dict) -> str:
        data, state_sha = self._load()
        if state_sha != expected_sha:
            raise JournalConflict("bootstrap state pin moved")
        if "dispatch_journal" in data:
            raise JournalConflict("journal already initialized; bootstrap is not a reset")
        if basis.get("state_sha") != expected_sha:
            raise ValueError("bootstrap basis must identify the exact state revision")
        data["dispatch_journal"] = {"version": 1, "events": [_event("Init", control_sha=control_sha, basis=basis)]}
        materialize(data["dispatch_journal"])
        saved = self._write(data)
        self._writer_base = copy.deepcopy(_body(data))
        return saved

    def current(self) -> dict:
        data, state_sha = self._load()
        if "dispatch_journal" not in data:
            raise JournalUninitialized("dispatch journal is not initialized")
        state = materialize(data["dispatch_journal"])
        state["state_sha"] = state_sha
        self._writer_base = copy.deepcopy(_body(data))
        return state

    @staticmethod
    def _new_intent(state, workflow, inputs, basis, trigger, control_sha, source_kind):
        decision_id = _decision(state["epoch"], state["frontier_seq"], state["predecessor_decision_id"])
        source_identity = _intent_source(state, trigger, source_kind)
        if source_identity in state["source_ids"]:
            raise JournalConflict("source already bound to an earlier decision")
        return _event("Intent", decision_id=decision_id, frontier_seq=state["frontier_seq"],
                      predecessor_decision_id=state["predecessor_decision_id"], workflow=workflow,
                      normalized_inputs=inputs, input_hash=digest(inputs), basis=basis,
                      first_source_trigger=trigger, source_identity=source_identity,
                      control_sha=control_sha, correlation_key=digest([decision_id, "dispatch"])[:32],
                      source_kind=source_kind)

    @staticmethod
    def _match(intent, workflow, inputs, control_sha, key=None):
        if (intent["workflow"] != workflow or intent["normalized_inputs"] != inputs
                or intent["control_sha"] != control_sha
                or (key is not None and intent["correlation_key"] != key)):
            raise JournalConflict("active intent has different workflow, inputs or pinned control context")

    def reserve_send(self, workflow, inputs, *, basis, trigger, control_sha):
        inputs = normalize_inputs(workflow, inputs)
        trigger = _trigger(trigger, control_sha)

        def reserve(data, state_sha, state):
            _sender_basis(state, basis)
            intent, additions = state["active_intent"], []
            if intent is None:
                intent = self._new_intent(state, workflow, inputs, basis, trigger, control_sha, "sender")
                additions.append(intent)
            self._match(intent, workflow, inputs, control_sha)
            decision_id = intent["decision_id"]
            if (decision_id in state["send_claims"] or decision_id in state["executor_claims"]
                    or intent["source_kind"] == "external"):
                return (intent, None), additions
            claim = _event("SendClaim", decision_id=decision_id, claim_id=digest([decision_id, "send"]), trigger=trigger)
            return (intent, claim), [*additions, claim]

        (intent, claim), state_sha, changed = self._mutate(reserve)
        capability = (SendCapability(intent["decision_id"], claim["claim_id"], trigger, control_sha,
                                     state_sha=state_sha, issuer=_ISSUER) if changed and claim else None)
        return copy.deepcopy(intent), capability

    def observe_delivery(self, decision_id: str, observation: dict) -> None:
        def observe(data, state_sha, state):
            if decision_id not in state["intents"]:
                raise JournalConflict("delivery observation has no durable intent")
            return None, [_event("DeliveryObservation", decision_id=decision_id, observation=observation)]
        self._mutate(observe)

    def admit(self, workflow, inputs, *, key, trigger, control_sha):
        inputs = normalize_inputs(workflow, inputs)
        trigger = _trigger(trigger, control_sha)
        if key and not KEY.fullmatch(str(key)):
            raise JournalConflict("invalid durable correlation key")
        if key and trigger["event_name"] != "workflow_dispatch":
            raise JournalConflict("internal executor requires its original workflow dispatch")

        def admit(data, state_sha, state):
            intent, additions = state["active_intent"], []
            if key:
                bound = next((value for value in state["intents"].values()
                              if value["correlation_key"] == key), None)
                if bound is None:
                    raise JournalConflict("correlation key has no durable intent")
                self._match(bound, workflow, inputs, control_sha, key)
                if bound is not intent:
                    return (bound, None), []
            elif intent is not None and intent["source_kind"] == "sender":
                # Cron/manual/callback ingress only reconciles a pending send;
                # it cannot stand in for the receiver carrying the saved key.
                return (intent, None), []
            elif intent is None:
                source_identity = _source_identity(trigger)
                if source_identity in state["source_ids"]:
                    return (None, None), []
                intent = self._new_intent(state, workflow, inputs,
                                          {"kind": "external_ingress", "state_sha": state_sha},
                                          trigger, control_sha, "external")
                additions.append(intent)
            self._match(intent, workflow, inputs, control_sha, key if key else None)
            decision_id = intent["decision_id"]
            if decision_id in state["executor_claims"]:
                return (intent, None), additions
            if not SHA.fullmatch(state_sha):
                raise JournalConflict("execution requires initialized authoritative state")
            claim = _event("ExecutorClaim", decision_id=decision_id, claim_id=digest([decision_id, "execute"]),
                           trigger=trigger, correlation_key=key, before_state_sha=state_sha,
                           before_digest=substantive_digest(data))
            return (intent, claim), [*additions, claim]

        (intent, claim), state_sha, changed = self._mutate(admit)
        capability = (ExecutionCapability(intent["decision_id"], claim["claim_id"], trigger, control_sha,
                                          state_sha=state_sha, issuer=_ISSUER) if changed and claim else None)
        return copy.deepcopy(intent), capability

    def save_manifest(self, data: dict) -> str:
        """Rebase only the journal; never retry a stale substantive mutation."""
        from state_store import StateConflict
        if self._writer_base is None:
            raise JournalConflict("writer has no admitted authoritative baseline")
        baseline = copy.deepcopy(self._writer_base)
        for attempt in range(3):
            fresh, state_sha = self._load()
            if _body(fresh) != baseline:
                raise JournalConflict("substantive state moved; recompute the operation, do not overwrite")
            candidate = copy.deepcopy(data)
            candidate["dispatch_journal"] = copy.deepcopy(fresh["dispatch_journal"])
            try:
                saved = self._write(candidate)
            except StateConflict:
                if attempt == 2:
                    raise JournalConflict("manifest CAS remained conflicted") from None
                continue
            data["dispatch_journal"] = copy.deepcopy(candidate["dispatch_journal"])
            self._writer_base = copy.deepcopy(_body(candidate))
            return saved
        raise JournalConflict("manifest CAS remained conflicted")

    def _checkpoint_state(self, sha: str) -> dict:
        from state_store import _git
        if not SHA.fullmatch(str(sha)):
            raise JournalConflict("invalid checkpoint revision")
        return json.loads(_git(self.repo, "show", sha + ":agent_tasks.json").stdout)

    def record_checkpoint(self, capability, phase: str, evidence: dict) -> dict:
        if type(capability) is not ExecutionCapability or phase != "sync_prepared" or capability.phase != "execute":
            raise JournalConflict("prepared stage requires its original execution capability")
        capability._finish()
        stage_id = digest([capability.decision_id, phase, evidence])
        event = _event("ExecutionStage", decision_id=capability.decision_id,
                       executor_claim_id=capability.executor_claim_id, phase=phase,
                       stage_id=stage_id, evidence=evidence, evidence_hash=digest(evidence))

        def checkpoint(data, state_sha, state):
            self._capability_context(capability, state)
            return event, [event]
        result, _, _ = self._mutate(checkpoint)
        return {key: result[key] for key in ("stage_id", "decision_id", "executor_claim_id", "phase", "evidence_hash")}

    def checkpoint(self, stage_id: str) -> dict:
        state = self.current()
        stage = state["stages"].get(stage_id)
        if stage is None:
            raise JournalConflict("prepared checkpoint is not durable")
        return copy.deepcopy(stage)

    def claim_phase(self, decision_id, phase, trigger, control_sha, evidence):
        trigger = _trigger(trigger, control_sha)
        if phase != "sync_finalize" or not isinstance(evidence, dict):
            raise JournalConflict("invalid finalize phase")

        def claim(data, state_sha, state):
            intent = state["intents"].get(decision_id)
            executor = state["executor_claims"].get(decision_id)
            stage = state["stages"].get(evidence.get("stage_id"))
            if (intent is None or intent["workflow"] != SYNC or intent["control_sha"] != control_sha
                    or executor is None or executor["trigger"] != trigger
                    or stage is None or stage["decision_id"] != decision_id
                    or evidence.get("evidence_hash", stage["evidence_hash"]) != stage["evidence_hash"]
                    or ("evidence" in evidence and evidence["evidence"] != stage["evidence"])):
                raise JournalConflict("finalize does not bind the original prepared execution")
            if intent is not state["active_intent"] or phase in state["phase_claims"].get(decision_id, {}):
                return None, []
            event = _event("PhaseClaim", decision_id=decision_id, executor_claim_id=executor["claim_id"],
                           phase=phase, claim_id=digest([decision_id, phase]), trigger=trigger, stage_id=stage["stage_id"])
            return event, [event]
        event, state_sha, changed = self._mutate(claim)
        if not event or not changed:
            return None
        return ExecutionCapability(decision_id, event["claim_id"], trigger, control_sha, state_sha=state_sha,
                                   phase=phase, executor_claim_id=event["executor_claim_id"], issuer=_ISSUER)

    @staticmethod
    def _capability_context(capability, state):
        capability._check()
        intent = state["intents"].get(capability.decision_id)
        executor = state["executor_claims"].get(capability.decision_id)
        if (intent is None or intent is not state["active_intent"]
                or intent["control_sha"] != capability.control_sha or executor is None
                or executor["claim_id"] != capability.executor_claim_id
                or executor["trigger"] != capability.trigger):
            raise JournalConflict("execution capability no longer binds the current executor")
        if capability.phase != "execute":
            phase = state["phase_claims"].get(capability.decision_id, {}).get(capability.phase)
            if phase is None or phase["claim_id"] != capability.claim_id:
                raise JournalConflict("execution capability lacks its durable phase claim")
        return intent, executor

    def record_effect(self, capability, kind, evidence):
        if type(capability) is not ExecutionCapability:
            raise JournalConflict("effect requires an execution capability, not a send claim")
        capability._finish()
        evidence = copy.deepcopy(evidence)

        def record(data, state_sha, state):
            intent, executor = self._capability_context(capability, state)
            if kind == "controller_checkpoint":
                before = self._checkpoint_state(evidence.get("before_state_sha", ""))
                after = self._checkpoint_state(evidence.get("after_state_sha", ""))
                evidence["before_digest"] = substantive_digest(before)
                evidence["after_digest"] = substantive_digest(after)
                if evidence["after_digest"] != substantive_digest(data):
                    raise JournalConflict("controller effect checkpoint is no longer authoritative")
                for observation in evidence.get("poll_observations", []):
                    task = next((item for item in after["tasks"] if item["id"] == observation.get("task_id")), None)
                    execution = (task or {}).get("execution") or {}
                    if (str(execution.get("session_id", "")).removeprefix("sessions/") != observation.get("session_id")
                            or execution.get("session_state") != observation.get("session_state")):
                        raise JournalConflict("poll observation is not bound to the saved worker")
                    poll_at = (after.get("controller") or {}).get("last_poll_at")
                    if poll_at is None or _timestamp(poll_at) < _timestamp(observation.get("observed_at")):
                        raise JournalConflict("poll did not complete a saved controller checkpoint")
            elif kind == "continue_handoff":
                observation = evidence.get("observation") or {}
                observed = self._checkpoint_state(observation.get("state_sha", ""))
                if substantive_digest(observed) != substantive_digest(data):
                    raise JournalConflict("continuation observation is stale")
            elif kind == "sync_publication":
                from state_store import _git
                candidate, old, main = (evidence.get(name, "") for name in ("candidate_sha", "lab_sha", "main_sha"))
                if any(not SHA.fullmatch(str(sha)) for sha in (candidate, old, main)):
                    raise JournalConflict("invalid publication checkpoint")
                remote = _git(self.repo, "ls-remote", "--exit-code", "origin", "refs/heads/autonomous/lab").stdout.decode().split()
                if len(remote) != 2 or remote[0] != candidate:
                    raise JournalConflict("publication head has not been observed")
                _git(self.repo, "merge-base", "--is-ancestor", old, candidate)
                _git(self.repo, "merge-base", "--is-ancestor", main, candidate)
                for sha in (old, candidate):
                    blob = _git(self.repo, "rev-parse", sha + ":agent_tasks.json").stdout.decode().strip()
                    if blob != evidence.get("queue_blob"):
                        raise JournalConflict("publication changed the immutable legacy queue")
                if capability.phase != "sync_finalize":
                    raise JournalConflict("publication requires finalize capability")
            _valid_effect(kind, evidence, intent, executor,
                          state["phase_claims"].get(capability.decision_id, {}), state["stages"])
            event = _event("EffectObservation", decision_id=capability.decision_id,
                           executor_claim_id=executor["claim_id"], kind=kind, evidence=evidence,
                           receipt_id=_receipt_id(capability.decision_id, executor["claim_id"], kind, evidence))
            if capability.phase != "execute":
                event = _event("EffectObservation", decision_id=capability.decision_id,
                               executor_claim_id=executor["claim_id"], phase_claim_id=capability.claim_id,
                               kind=kind, evidence=evidence,
                               receipt_id=_receipt_id(capability.decision_id, executor["claim_id"], kind, evidence))
            return event, [event]
        result, _, _ = self._mutate(record)
        return copy.deepcopy(result)

    def record_completion(self, capability, evidence):
        """Close proven no-effect preparation without minting a useful effect."""
        if type(capability) is not ExecutionCapability or capability.phase != "execute":
            raise JournalConflict("no-effect completion requires the original preparation capability")
        capability._finish()
        evidence = copy.deepcopy(evidence)

        def complete(data, state_sha, state):
            from state_store import _git
            intent, executor = self._capability_context(capability, state)
            _valid_completion(evidence, intent, executor, state)
            if substantive_digest(data) != executor["before_digest"]:
                raise JournalConflict("no-effect preparation changed substantive state")
            for branch, pin in (("main", evidence["main_sha"]), ("autonomous/lab", evidence["lab_sha"])):
                remote = _git(self.repo, "ls-remote", "--exit-code", "origin", "refs/heads/" + branch).stdout.decode().split()
                if len(remote) != 2 or remote[0] != pin:
                    raise JournalConflict("no-effect completion heads changed")
            if _git(self.repo, "ls-remote", "--heads", "origin", "refs/heads/" + evidence["candidate_branch"]).stdout:
                raise JournalConflict("no-effect completion has a published candidate")
            if evidence["status"] == "up_to_date":
                _git(self.repo, "merge-base", "--is-ancestor", evidence["main_sha"], evidence["lab_sha"])
            if evidence.get("queue_blob"):
                blob = _git(self.repo, "rev-parse", evidence["lab_sha"] + ":agent_tasks.json").stdout.decode().strip()
                if blob != evidence["queue_blob"]:
                    raise JournalConflict("no-effect completion changed the legacy queue pin")
            event = _event("ExecutionCompletion", decision_id=capability.decision_id,
                           executor_claim_id=executor["claim_id"], kind="sync_no_effect", evidence=evidence,
                           receipt_id=_receipt_id(capability.decision_id, executor["claim_id"], "sync_no_effect", evidence),
                           frontier_seq=state["frontier_seq"] + 1)
            return event, [event]
        result, _, _ = self._mutate(complete)
        return copy.deepcopy(result)

    def outcome_for_trigger(self, trigger: dict, receipt_id: str = ""):
        state = self.current()
        run_id = str(trigger.get("source_run_id", trigger.get("run_id", "")))
        attempt = str(trigger.get("source_run_attempt", trigger.get("run_attempt", "")))
        if not re.fullmatch(r"[1-9][0-9]*", run_id) or not re.fullmatch(r"[1-9][0-9]*", attempt):
            raise JournalConflict("handoff requires the original producer run and attempt")
        matches = []
        for decision_id, executor in state["executor_claims"].items():
            original = executor["trigger"]
            effect = state["effects"].get(decision_id) or state["completions"].get(decision_id)
            if (effect is not None and original["run_id"] == run_id and original["run_attempt"] == attempt
                    and (not receipt_id or effect["receipt_id"] == receipt_id)):
                if "repository" in trigger and original.get("repository") != trigger["repository"]:
                    raise JournalConflict("handoff receipt belongs to another repository")
                matches.append(effect)
        if len(matches) > 1:
            raise JournalConflict("ambiguous producer effect")
        return copy.deepcopy(matches[0]) if matches else None

    def advance(self, receipt_id: str) -> bool:
        """Consume an effect once; replay reports whether its cause is still current."""
        def advance(data, state_sha, state):
            outcome = next((value for value in (*state["effects"].values(), *state["completions"].values())
                            if value["receipt_id"] == receipt_id), None)
            if outcome is None:
                raise JournalConflict("advance requires a verified execution outcome")
            if receipt_id in state["advanced_receipts"] or receipt_id in state["completed_receipts"]:
                return outcome["decision_id"] == state["predecessor_decision_id"], []
            if state["active_intent"] is not state["intents"][outcome["decision_id"]]:
                raise JournalConflict("advance requires the current verified causal effect")
            return True, [_event("Advance", decision_id=outcome["decision_id"],
                                 executor_claim_id=outcome["executor_claim_id"], receipt_id=receipt_id,
                                 frontier_seq=state["frontier_seq"] + 1)]
        current, _, _ = self._mutate(advance)
        return current


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--revision-file", type=Path, required=True)
    parser.add_argument("--expected-state-sha", required=True)
    parser.add_argument("--control-sha", required=True)
    parser.add_argument("--basis", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        sha = JournalStore(args.repo, args.manifest, args.revision_file).initialize(
            args.expected_state_sha, args.control_sha, json.loads(args.basis.read_text(encoding="utf-8")))
        print(json.dumps({"initialized": True, "state_sha": sha}))
        return 0
    except (ValueError, RuntimeError, OSError):
        print(json.dumps({"initialized": False, "reason": "bootstrap_not_authorized"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
