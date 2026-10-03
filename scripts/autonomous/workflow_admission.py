"""Bind actual workflow executors to the durable dispatch frontier; fail closed."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from dispatch_journal import OWNER_CONTINUE_CUTOVER, OWNER_NEXT_COMPLETION, OWNER_REPORT_CHECKPOINT, normalize_inputs


SHA = re.compile(r"[0-9a-f]{40}\Z")
WORKFLOWS = {"autonomous_next_task.yml", "autonomous_continue.yml", "autonomous_sync.yml"}
OWNER_RECOVERY = "autonomous_recover_delivery.yml"
OWNER_WORKFLOWS = frozenset((OWNER_RECOVERY, OWNER_CONTINUE_CUTOVER, OWNER_NEXT_COMPLETION, OWNER_REPORT_CHECKPOINT))


def add_arguments(parser, *, run_id=True):
    if run_id:
        parser.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID", ""))
    parser.add_argument("--run-attempt", default=os.environ.get("GITHUB_RUN_ATTEMPT", ""))
    parser.add_argument("--event-name", default=os.environ.get("GITHUB_EVENT_NAME", ""))
    parser.add_argument("--control-sha", default=os.environ.get("CONTROL_SHA", ""))
    parser.add_argument("--continuation-key", default=os.environ.get("CONTINUATION_KEY", ""))


def _bound(value, variable):
    actual = os.environ.get(variable)
    if actual is not None and value != actual:
        raise ValueError("workflow context disagrees with " + variable)
    return value


def control_revision():
    result = subprocess.run(
        ["git", "-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "HEAD"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20,
    )
    revision = result.stdout.strip()
    if not SHA.fullmatch(revision):
        raise ValueError("trusted control revision unavailable")
    return revision


@dataclass(frozen=True)
class AdmissionContext:
    workflow: str
    key: str
    trigger: dict
    control_sha: str

    def admit(self, store, inputs):
        if self.workflow not in WORKFLOWS:
            raise ValueError("owner operation cannot admit workflow execution")
        inputs = normalize_inputs(self.workflow, inputs)
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        if self.trigger["event_name"] == "workflow_dispatch" and event_path:
            original = json.loads(Path(event_path).read_text(encoding="utf-8")).get("inputs", {})
            original = dict(original)
            if original.pop("continuation_key", "") != self.key:
                raise ValueError("execution key differs from original workflow input")
            pinned = original.pop("control_sha", "")
            if pinned and pinned != self.control_sha:
                raise ValueError("execution revision differs from original workflow input")
            original = normalize_inputs(self.workflow, original)
            if self.workflow == "autonomous_sync.yml" and not self.key:
                # External optional pins are resolved against checked live heads;
                # an explicitly provided pin can never be changed by the script.
                for name, pin in original.items():
                    if pin and inputs[name] != pin:
                        raise ValueError("external sync changed an explicit pin")
            elif original != inputs:
                raise ValueError("execution differs from original workflow inputs")
        return store.admit(self.workflow, inputs, key=self.key,
                           trigger=self.trigger, control_sha=self.control_sha)


def context(args, workflow, config):
    if workflow not in WORKFLOWS and workflow not in OWNER_WORKFLOWS:
        raise ValueError("unsupported execution workflow")
    run_id = _bound(str(args.run_id), "GITHUB_RUN_ID")
    attempt = _bound(str(args.run_attempt), "GITHUB_RUN_ATTEMPT")
    event = _bound(args.event_name, "GITHUB_EVENT_NAME")
    if workflow in OWNER_WORKFLOWS:
        for value, variable in ((run_id, "GITHUB_RUN_ID"), (attempt, "GITHUB_RUN_ATTEMPT"),
                                (event, "GITHUB_EVENT_NAME")):
            if os.environ.get(variable) != value:
                raise ValueError("owner operation requires authenticated workflow identity")
    if not re.fullmatch(r"[1-9][0-9]*", run_id) or not re.fullmatch(r"[1-9][0-9]*", attempt):
        raise ValueError("execution requires an exact workflow run and attempt")
    allowed = {"workflow_dispatch"}
    if workflow == "autonomous_continue.yml":
        allowed |= {"schedule", "push", "workflow_run"}
    elif workflow == "autonomous_sync.yml":
        allowed.add("push")
    if event not in allowed or os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise ValueError("execution requires a trusted main workflow event")
    repository = config["repository"]
    if os.environ.get("GITHUB_REPOSITORY") != repository:
        raise ValueError("execution repository mismatch")
    workflow_ref = os.environ.get("GITHUB_WORKFLOW_REF", "")
    if ((workflow in OWNER_WORKFLOWS or workflow_ref)
            and workflow_ref != repository + "/.github/workflows/" + workflow + "@refs/heads/main"):
        raise ValueError("executor is running a different workflow")
    actual_sha = control_revision()
    control_sha = _bound(args.control_sha, "CONTROL_SHA") or actual_sha
    if not SHA.fullmatch(control_sha) or actual_sha != control_sha:
        raise ValueError("workflow control checkout is not the pinned revision")
    _bound(args.continuation_key, "CONTINUATION_KEY")
    if workflow in OWNER_WORKFLOWS and args.continuation_key:
        raise ValueError("owner operation cannot use an internal execution key")
    if args.continuation_key and event != "workflow_dispatch":
        raise ValueError("internal correlation is valid only for workflow dispatch")
    if event == "workflow_dispatch" and not args.continuation_key:
        from proposal_backlog import authorize
        authorize(config, os.environ.get("GITHUB_ACTOR", ""))
    trigger = {"run_id": run_id, "run_attempt": attempt, "event_name": event,
               "control_sha": control_sha, "repository": repository,
               "actor": os.environ.get("GITHUB_ACTOR", "")}
    if workflow in OWNER_WORKFLOWS:
        trigger.update(workflow=workflow, ref=os.environ["GITHUB_REF"])
    if event == "workflow_run":
        source = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))["workflow_run"]
        if (source.get("head_repository", {}).get("full_name") != repository
                or (source.get("head_branch") != "main"
                    and source.get("name") != "Autonomous Proposal Review")
                or source.get("status") != "completed"):
            raise ValueError("untrusted source callback")
        source_id = str(source.get("id", ""))
        source_attempt = str(source.get("run_attempt", ""))
        if not re.fullmatch(r"[1-9][0-9]*", source_id) or not re.fullmatch(r"[1-9][0-9]*", source_attempt):
            raise ValueError("callback source identity unavailable")
        trigger["source_run_id"] = source_id
        trigger["source_run_attempt"] = source_attempt
        trigger["source_workflow"] = source.get("name", "")
    return AdmissionContext(workflow, args.continuation_key, trigger, control_sha)


def recheck_context(binding):
    if control_revision() != binding.control_sha:
        raise ValueError("pinned control revision changed before execution")
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise ValueError("workflow ref changed before execution")
    for key, variable in (("run_id", "GITHUB_RUN_ID"), ("run_attempt", "GITHUB_RUN_ATTEMPT"),
                          ("event_name", "GITHUB_EVENT_NAME"), ("repository", "GITHUB_REPOSITORY")):
        if binding.workflow in OWNER_WORKFLOWS and os.environ.get(variable) != binding.trigger[key]:
            raise ValueError("owner workflow identity changed before execution")
        _bound(binding.trigger[key], variable)
    if binding.workflow in OWNER_WORKFLOWS:
        if os.environ.get("GITHUB_ACTOR") != binding.trigger["actor"]:
            raise ValueError("owner actor changed before execution")
        if (os.environ.get("GITHUB_WORKFLOW_REF") != binding.trigger["repository"]
                + "/.github/workflows/" + binding.workflow + "@" + binding.trigger["ref"]):
            raise ValueError("owner workflow changed before execution")


def substantive_manifest(manifest):
    """Use the journal's canonical substantive checkpoint projection."""
    from dispatch_journal import substantive_digest
    return substantive_digest(manifest)


def checked_control_pin(args, config, store):
    """Authenticate a frozen receiver revision using checked-main code only."""
    if args.workflow not in WORKFLOWS:
        raise ValueError("owner operation cannot authorize receiver checkout")
    binding = context(args, args.workflow, config)
    if not binding.key:
        # External ingress uses the checked main revision, never arbitrary code.
        if binding.trigger["event_name"] == "workflow_dispatch":
            original = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8")).get("inputs", {})
            if original.get("control_sha"):
                raise ValueError("external ingress cannot select a controller revision")
        return binding.control_sha
    original = dict(json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8")).get("inputs", {}))
    key = original.pop("continuation_key", "")
    pin = original.pop("control_sha", "")
    if key != binding.key or not SHA.fullmatch(str(pin)):
        raise ValueError("frozen receiver requires its original key and controller revision")
    state = store.current()
    intent = next((item for item in state["intents"].values() if item["correlation_key"] == key), None)
    if intent is not None and intent["decision_id"] in state.get("owner_fences", {}):
        raise ValueError("frozen receiver was revoked by the owner")
    if intent is not None and intent["decision_id"] in state.get("continue_cutovers", {}):
        raise ValueError("frozen receiver CONTINUE was cut over by the owner")
    if (intent is None or intent["source_kind"] != "sender"
            or intent["decision_id"] not in state["send_claims"]):
        raise ValueError("frozen receiver has no durable sender claim")
    store._match(intent, args.workflow, normalize_inputs(args.workflow, original), pin, key)
    # The caller checks out full checked-main history before this read-only gate.
    # Journal identity alone must not authorize execution of an arbitrary commit.
    subprocess.run(["git", "-C", str(args.repo), "merge-base", "--is-ancestor", pin, binding.control_sha],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    recheck_context(binding)
    return pin


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only checked-main gate for frozen controller checkout")
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--workflow", required=True, choices=sorted(WORKFLOWS))
    add_arguments(parser)
    args = parser.parse_args(argv)
    from dispatch_journal import JournalStore
    import tempfile
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory(prefix="controller-pin-") as temporary:
            store = JournalStore(args.repo, Path(temporary) / "queue.json", Path(temporary) / "revision.json")
            pin = checked_control_pin(args, config, store)
    except (ValueError, RuntimeError, OSError, KeyError, subprocess.SubprocessError):
        print(json.dumps({"authorized": False, "reason": "controller_pin_rejected"}))
        return 1
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as handle:
        handle.write("control_sha=" + pin + "\n")
    with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as handle:
        handle.write("CONTROL_SHA=" + pin + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
