#!/usr/bin/env python3
"""Close one explicitly selected owner delivery by native state CAS.

Delivery recovery fences only unclaimed sends. CONTINUE cutover closes only a
selected idle CONTINUE, including a claimed executor. Neither operation dispatches,
completes execution, switches the loop, or changes tasks.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

from dispatch_journal import DIGEST, SHA, JournalConflict, JournalStore, JournalUncertain
from proposal_backlog import authorize
from state_store import StateConflict, StateUncertain, _atomic_bytes
from workflow_admission import (OWNER_CONTINUE_CUTOVER, OWNER_RECOVERY, add_arguments,
                                context, recheck_context)

OPERATIONS = {
    "delivery": (OWNER_RECOVERY, "owner_fence", frozenset(("fenced", "already_fenced"))),
    "continue_cutover": (OWNER_CONTINUE_CUTOVER, "owner_continue_cutover",
                         frozenset(("cut_over", "already_cut_over"))),
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
        attempted = True
        owner_operation = (store.cutover_continue if operation == "continue_cutover"
                           else store.fence_unclaimed)
        result = _acknowledged_result(owner_operation(
            decision_id=args.decision_id, expected_state_sha=args.expected_state_sha,
            owner_trigger=binding.trigger, config=config,
        ), args.decision_id, operation)
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
