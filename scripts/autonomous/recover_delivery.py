#!/usr/bin/env python3
"""Observe or apply one explicitly selected owner operation.

Delivery fencing revokes only unclaimed sends. CONTINUE cutover closes only a
selected idle CONTINUE. NEXT completion observes an authentic terminal native
no-op or failed queued report checkpoint against its immutable baseline. Reserved
dispatch observation is GET-only; original-session binding may change only the
selected task's execution.state and execution.session_id by one native state CAS,
appending only its typed owner recovery receipt to the journal.
None creates a provider session, switches the loop, issues execution rights, or
changes task attempts, requests, history, receipts, outcomes, or clocks.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from datetime import datetime

from build_jules_request import dispatch_key
from dispatch_journal import (DIGEST, SHA, JournalConflict, JournalStore, JournalUncertain)
from jules_dispatch import KeyRing
from proposal_backlog import authorize
from state_store import StateConflict, StateUncertain, _atomic_bytes
from workflow_admission import (OWNER_CONTINUE_CUTOVER, OWNER_DISPATCH_BINDING,
                                OWNER_DISPATCH_OBSERVATION, OWNER_NEXT_COMPLETION,
                                OWNER_REPORT_CHECKPOINT, OWNER_RECOVERY,
                                add_arguments, context, recheck_context)

OPERATIONS = {
    "delivery": (OWNER_RECOVERY, "owner_fence", frozenset(("fenced", "already_fenced"))),
    "continue_cutover": (OWNER_CONTINUE_CUTOVER, "owner_continue_cutover",
                         frozenset(("cut_over", "already_cut_over"))),
    "next_completion": (OWNER_NEXT_COMPLETION, "owner_next_completion",
                        frozenset(("completed", "already_completed"))),
    "report_checkpoint": (OWNER_REPORT_CHECKPOINT, "owner_report_checkpoint",
                          frozenset(("completed", "already_completed"))),
    "dispatch_observation": (OWNER_DISPATCH_OBSERVATION, "owner_dispatch_observation",
                             frozenset(("observed",))),
    "dispatch_binding": (OWNER_DISPATCH_BINDING, "owner_dispatch_binding",
                         frozenset(("bound", "already_bound"))),
}


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # Do not print untrusted arguments or transport details into retained logs.
        raise ValueError("invalid owner recovery arguments")


def _git(repo, *arguments):
    return subprocess.run(
        ["git", "-C", str(repo), *arguments], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
    ).stdout


def _output_path(args):
    if args.out is None:
        return None
    path = args.out.resolve()
    control = Path(__file__).resolve().parents[2]
    if (path.is_relative_to(control)
            or (args.config is not None and path == args.config.resolve())
            or (args.manifest is not None and path == args.manifest.resolve())
            or (args.revision_file is not None and path == args.revision_file.resolve())
            or (args.repo is not None and path == (args.repo / "agent_tasks.json").resolve())):
        raise ValueError("result retention cannot overwrite checked sources or the product queue")
    return path


def _checked_config(args):
    control = Path(__file__).resolve().parents[2]
    revision = os.environ.get("GITHUB_SHA", "")
    if not SHA.fullmatch(revision):
        raise ValueError("missing event revision")
    raw = args.config.read_bytes()
    if raw != _git(control, "show", revision + ":autonomous-project.json"):
        raise ValueError("owner configuration is not the checked event configuration")
    config = json.loads(raw)
    if not isinstance(config, dict):
        raise ValueError("invalid owner configuration")
    repository = config["repository"]
    origin = _git(args.repo, "remote", "get-url", "--all", "origin").decode("utf-8").strip()
    push_origin = _git(args.repo, "remote", "get-url", "--push", "--all", "origin").decode("utf-8").strip()
    allowed_origins = {
        "https://github.com/" + repository, "https://github.com/" + repository + ".git",
        "git@github.com:" + repository, "git@github.com:" + repository + ".git",
        "ssh://git@github.com/" + repository, "ssh://git@github.com/" + repository + ".git",
    }
    if origin not in allowed_origins or push_origin not in allowed_origins:
        raise ValueError("state repository does not match the checked configuration")
    paths = [args.manifest.resolve(), args.revision_file.resolve(), args.out.resolve()]
    if len(set(paths)) != len(paths):
        raise ValueError("owner recovery outputs must be distinct")
    if any(path.is_relative_to(control) or path == args.config.resolve()
           or path == (args.repo / "agent_tasks.json").resolve() for path in paths):
        raise ValueError("owner recovery outputs cannot overwrite checked sources or the product queue")
    return config


def _owner_binding(args, config):
    workflow = OPERATIONS[args.operation][0]
    binding = context(args, workflow, config)
    if binding.key or args.continuation_key:
        raise ValueError("owner recovery cannot use a continuation key")
    if (os.environ.get("GITHUB_SHA") != binding.control_sha
            or os.environ.get("GITHUB_WORKFLOW_SHA") != binding.control_sha
            or os.environ.get("CONTROL_SHA") != binding.control_sha):
        raise ValueError("owner recovery must run checked event-main code")
    expected_ref = config["repository"] + "/.github/workflows/" + workflow + "@refs/heads/main"
    if os.environ.get("GITHUB_WORKFLOW_REF") != expected_ref:
        raise ValueError("owner recovery requires its exact main workflow")
    actor = binding.trigger["actor"]
    authorize(config, actor)
    if os.environ.get("GITHUB_TRIGGERING_ACTOR") != actor:
        raise ValueError("owner recovery rerun actor differs from the original owner")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    if (not isinstance(event, dict)
            or not isinstance(event.get("repository"), dict)
            or event["repository"].get("full_name") != config["repository"]
            or event.get("ref") not in {"main", "refs/heads/main"}
            or not isinstance(event.get("sender"), dict)
            or event["sender"].get("login") != actor):
        raise ValueError("owner event identity differs from the trusted workflow context")
    original = event.get("inputs")
    requested = {"expected_state_sha": args.expected_state_sha, "decision_id": args.decision_id}
    if (not isinstance(original, dict) or original != requested
            or not SHA.fullmatch(args.expected_state_sha)
            or not DIGEST.fullmatch(args.decision_id)):
        raise ValueError("owner recovery requires exact original inputs")
    binding.trigger.update(workflow=workflow, ref="refs/heads/main", **requested)
    return binding


def _acknowledged_result(value, decision_id, operation):
    if (not isinstance(value, dict)
            or value.get("outcome") not in OPERATIONS[operation][2]
            or value.get("decision_id") != decision_id
            or not isinstance(value.get("receipt_id"), str)
            or not DIGEST.fullmatch(value["receipt_id"])
            or not isinstance(value.get("state_sha"), str)
            or not SHA.fullmatch(value["state_sha"])
            or type(value.get("frontier_seq")) is not int or value["frontier_seq"] < 0):
        raise JournalUncertain("owner operation acknowledgement is not usable")
    # Retain only the public contract, never raw transport/config/event data.
    return {name: value[name] for name in
            ("outcome", "decision_id", "receipt_id", "state_sha", "frontier_seq")}


def _observed_result(value, decision_id, expected_state_sha, config):
    """Retain only typed proof facts; reject arbitrary provider/native text."""
    def require(condition):
        if not condition:
            raise JournalUncertain("owner observation acknowledgement is not usable")

    def shape(item, fields):
        require(type(item) is dict and set(item) == set(fields))

    def token(item, pattern):
        require(type(item) is str and re.fullmatch(pattern, item) is not None)

    shape(value, ("outcome", "decision_id", "state_sha", "frontier_seq", "identity",
                  "provider_proof", "native_proof", "native_report"))
    require(value["outcome"] == "observed" and value["decision_id"] == decision_id
            and value["state_sha"] == expected_state_sha)
    token(value["decision_id"], DIGEST.pattern)
    token(value["state_sha"], SHA.pattern)
    require(type(value["frontier_seq"]) is int and value["frontier_seq"] >= 0)
    identity, provider = value["identity"], value["provider_proof"]
    identity_fields = ("task_id", "attempts", "dispatch_key", "base_sha",
                       "starting_branch", "research_request_sha256")
    shape(identity, identity_fields)
    token(identity["task_id"], r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}")
    require(type(identity["attempts"]) is int and identity["attempts"] > 0)
    token(identity["base_sha"], SHA.pattern)
    token(identity["research_request_sha256"], DIGEST.pattern)
    require(identity["dispatch_key"] == dispatch_key(config["repository"], identity["task_id"],
                                                    identity["attempts"])
            and identity["starting_branch"] == "autonomous/attempt-" + identity["dispatch_key"])
    shape(provider, (*identity_fields, "kind", "repository", "provider", "method", "authenticated",
                     "session_id", "session_state", "session_resource", "request_sha256",
                     "session_sha256", "list_session_sha256", "observed_at"))
    require(all(type(provider[name]) is type(identity[name]) and provider[name] == identity[name]
                for name in identity_fields))
    require(provider["kind"] == "reserved_dispatch_observation"
            and provider["repository"] == config["repository"] and provider["provider"] == "jules"
            and provider["method"] == "GET" and provider["authenticated"] is True)
    token(provider["session_id"], r"[A-Za-z0-9_-]+")
    token(provider["session_state"], r"[A-Z][A-Z0-9_]*")
    require(provider["session_resource"] == "sessions/" + provider["session_id"])
    for name in ("request_sha256", "session_sha256", "list_session_sha256"):
        token(provider[name], DIGEST.pattern)
    require(provider["session_sha256"] == provider["list_session_sha256"])
    token(provider["observed_at"], r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z")
    try:
        datetime.fromisoformat(provider["observed_at"].replace("Z", "+00:00"))
    except ValueError:
        require(False)
    native = value["native_proof"]
    shape(native, ("producer", "workflow", "ref", "artifact_id", "artifact_name",
                   "artifact_sha256", "report_sha256"))
    producer = native["producer"]
    shape(producer, ("run_id", "run_attempt", "event_name", "control_sha", "repository", "actor"))
    for name in ("run_id", "run_attempt"):
        token(producer[name], r"[1-9][0-9]*")
    token(producer["control_sha"], SHA.pattern)
    token(producer["actor"], r"[A-Za-z0-9][A-Za-z0-9_-]*(?:\[bot\])?")
    require(producer["repository"] == config["repository"]
            and producer["event_name"] == "workflow_dispatch"
            and native["workflow"] == "autonomous_next_task.yml" and native["ref"] == "refs/heads/main")
    token(native["artifact_id"], r"[1-9][0-9]*")
    require(native["artifact_name"] == "laboratory-result-" + producer["run_id"] + "-" + producer["run_attempt"])
    for name in ("artifact_sha256", "report_sha256"):
        token(native[name], DIGEST.pattern)
    report = value["native_report"]
    shape(report, ("action", "merge_mode", "reason", "attention", "state_sha"))
    require(report["action"] == "stopped" and report["merge_mode"] == "manual"
            and report["reason"] == "state_write_failed"
            and report["attention"] == [{"reason": "state save failed; reload the authoritative queue before continuing"}])
    token(report["state_sha"], SHA.pattern)
    # Rebuild the whitelist so no unvalidated object reaches retention.
    return {"outcome": "observed", "decision_id": decision_id,
            "state_sha": expected_state_sha, "frontier_seq": value["frontier_seq"],
            "identity": {name: identity[name] for name in identity_fields},
            "provider_proof": dict(provider),
            "native_proof": {**native, "producer": dict(producer)},
            "native_report": {**report, "attention": [{"reason": report["attention"][0]["reason"]}]}}


def main(argv=None):
    parser = _Parser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--operation", choices=tuple(OPERATIONS), default="delivery")
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--revision-file", required=True, type=Path)
    parser.add_argument("--expected-state-sha", required=True)
    parser.add_argument("--decision-id", required=True)
    parser.add_argument("--out", required=True, type=Path)
    add_arguments(parser)
    result = {"outcome": "blocked", "reason": "owner_fence_context_rejected"}
    operation = "delivery"
    args = None
    attempted = False
    out = None
    try:
        # Retain a safe rejection even if the full argument parser rejects input.
        output_parser = _Parser(add_help=False, allow_abbrev=False)
        output_parser.add_argument("--out", type=Path)
        output_parser.add_argument("--operation", default="delivery")
        output_parser.add_argument("--repo", type=Path)
        output_parser.add_argument("--config", type=Path)
        output_parser.add_argument("--manifest", type=Path)
        output_parser.add_argument("--revision-file", type=Path)
        output_args, _ = output_parser.parse_known_args(argv)
        out = _output_path(output_args)
        operation = output_args.operation if output_args.operation in OPERATIONS else "delivery"
        result = {"outcome": "blocked", "reason": OPERATIONS[operation][1] + "_context_rejected"}
        args = parser.parse_args(argv)
        out = _output_path(args)
        config = _checked_config(args)
        binding = _owner_binding(args, config)
        store = JournalStore(args.repo, args.manifest, args.revision_file)
        recheck_context(binding)
        # Re-read checked configuration, original payload and identities before CAS.
        if _checked_config(args) != config:
            raise ValueError("owner checked configuration changed before CAS")
        if _owner_binding(args, config).trigger != binding.trigger:
            raise ValueError("owner workflow identity changed before CAS")
        owner_operation = {"delivery": store.fence_unclaimed,
                           "continue_cutover": store.cutover_continue,
                           "next_completion": store.complete_observed_next,
                           "report_checkpoint": store.complete_failed_report_checkpoint,
                           "dispatch_observation": store.observe_reserved_dispatch,
                           "dispatch_binding": store.bind_reserved_dispatch}[operation]
        parameters = dict(decision_id=args.decision_id, expected_state_sha=args.expected_state_sha,
                          owner_trigger=binding.trigger, config=config)
        if operation in {"dispatch_observation", "dispatch_binding"}:
            # Reuse the existing Jules keyring, with no endpoint override or secret output.
            parameters["api_keys"] = KeyRing([os.environ.get("JULES_API_KEY", ""),
                                             os.environ.get("JULES_API_KEY_BACKUP", "")])
        attempted = True
        value = owner_operation(**parameters)
        result = (_observed_result(value, args.decision_id, args.expected_state_sha, config)
                  if operation == "dispatch_observation" else
                  _acknowledged_result(value, args.decision_id, operation))
    except (JournalUncertain, StateUncertain):
        result = {"outcome": "blocked", "reason": OPERATIONS[operation][1] + "_acknowledgement_unknown"}
    except (JournalConflict, StateConflict):
        result = {"outcome": "blocked", "reason": OPERATIONS[operation][1] + "_conflict"}
    except (ValueError, KeyError, TypeError, AttributeError, OSError, RuntimeError,
            subprocess.SubprocessError):
        result = {"outcome": "blocked", "reason": OPERATIONS[operation][1] +
                  ("_acknowledgement_unknown" if attempted else "_context_rejected")}
    text = json.dumps(result, indent=2) + "\n"
    if out is not None:
        try:
            _atomic_bytes(out, text.encode("utf-8"))
        except (OSError, ValueError):
            result = {"outcome": "blocked", "reason": OPERATIONS[operation][1] + "_result_retention_failed"}
            text = json.dumps(result, indent=2) + "\n"
    print(text, end="")
    return 0 if result["outcome"] in OPERATIONS[operation][2] else 1


if __name__ == "__main__":
    raise SystemExit(main())
