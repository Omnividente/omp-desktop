#!/usr/bin/env python3
"""Bounded continuation timer with durable single-send Actions handoffs."""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from complete_jules_task import atomic_write, configured_secrets, redact
from health_snapshot import inspect_health, snapshot_runs
from lab_controller import GitHub
from loop_health import ACTIVE_RUN_STATUSES
from state_store import load_state
from dispatch_journal import JournalConflict, JournalStore
from workflow_admission import add_arguments, context

NEXT = "autonomous_next_task.yml"
CONTINUE = "autonomous_continue.yml"
SYNC = "autonomous_sync.yml"
API_TIMEOUT = 20
SNAPSHOT_TIMEOUT = 120
CONFIRM_SECONDS = 120
ERROR_DELAYS = (5, 15, 30)
BUSY_REASONS = {"next_task_running", "sync_running"}
TRANSIENT = (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError)


class Disabled(RuntimeError):
    """The live switch revoked permission; no further effect is permitted."""


class Clock:
    def now(self):
        return datetime.now(timezone.utc)

    def monotonic(self):
        return time.monotonic()

    def sleep(self, seconds):
        time.sleep(seconds)


def iso(moment):
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp(value):
    if not value:
        return None
    result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("deadline must include timezone")
    return result.astimezone(timezone.utc)


class ContinuationGitHub(GitHub):
    """Reuse repository identity/operations, but never inherit 3 x 90s GETs."""

    def api(self, path, *, method="GET", body=None, missing=False, paginate=False):
        command = ["gh", "api", "--method", method, "/repos/" + self.repository + "/" + path]
        if paginate:
            command += ["--paginate", "--slurp"]
        if body is not None:
            command += ["--input", "-"]
        result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                                text=True, encoding="utf-8", stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=API_TIMEOUT)
        if result.returncode:
            if missing and "HTTP 404" in result.stderr:
                return None
            raise RuntimeError("continuation API request failed")
        return json.loads(result.stdout) if result.stdout.strip() else None


def collect_snapshot(repo, config, scratch, github, *, current_run_id="", observer_context=None):
    """Only the isolated child executes the potentially slow Git/state reads."""
    for args in (("fetch", "--no-tags", "origin",
                  "+refs/heads/main:refs/remotes/origin/main",
                  "+refs/heads/autonomous/lab:refs/remotes/origin/autonomous/lab"),
                 ("checkout", "--detach", "refs/remotes/origin/autonomous/lab")):
        subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull, *args],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
    manifest = load_state(repo, scratch / "queue.json", scratch / "revision.json")
    revision = json.loads((scratch / "revision.json").read_text(encoding="utf-8"))
    return inspect_health(manifest, config, repo=repo, enabled=github.enabled(),
                          state_sha=revision["state_sha"], get=github.api,
                          current_run_id=current_run_id, observer_context=observer_context)


def stop_child(child):
    if child.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
    else:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    child.wait(timeout=10)


class Runtime:
    """Production adapter. Its repo must be a private laboratory checkout."""

    def __init__(self, repo, config_path, scratch, *, clock, check_interval, admission_args):
        self.repo = Path(repo).resolve()
        self.config_path = Path(config_path).resolve()
        self.config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.github = ContinuationGitHub(self.config["repository"])
        self.repository = self.github.repository
        self.scratch = Path(scratch)
        self.clock = clock
        self.check_interval = check_interval
        self.admission_args = admission_args
        self.admission = context(admission_args, admission_args.source_workflow, self.config)
        self.trigger = self.admission.trigger
        self.continuation_key = self.admission.key
        self.receipt_id = admission_args.receipt_id
        self.journal = JournalStore(self.repo, self.scratch / "journal-queue.json",
                                    self.scratch / "journal-revision.json")
        self.control_sha = self.admission.control_sha

    def recheck_context(self):
        if context(self.admission_args, self.admission_args.source_workflow, self.config) != self.admission:
            raise ValueError("workflow context changed")

    def enabled(self):
        return self.github.enabled()

    def observe(self, *, observer_context=None):
        # Supervise the entire Git/state/API snapshot, including state_store's
        # longer Git calls. Disable is observed even while a child read hangs.
        destination = self.scratch / "snapshot.json"
        destination.unlink(missing_ok=True)
        command = [sys.executable, str(Path(__file__).resolve()), "--repo", str(self.repo),
                   "--config", str(self.config_path), "--out", str(destination), "--_snapshot-child"]
        if observer_context is not None:
            observer_path = self.scratch / "observer-context.json"
            atomic_write(observer_path, json.dumps(observer_context) + "\n")
            command += ["--_observer-context", str(observer_path),
                        "--source-workflow", self.admission.workflow]
        child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=os.name != "nt")
        deadline = self.clock.monotonic() + SNAPSHOT_TIMEOUT
        try:
            while child.poll() is None:
                remaining = deadline - self.clock.monotonic()
                if remaining <= 0:
                    raise TimeoutError("snapshot deadline exceeded")
                try:
                    child.wait(timeout=min(self.check_interval, remaining))
                except subprocess.TimeoutExpired:
                    pass
                if not self.enabled():
                    raise Disabled("loop_disabled")
            if child.returncode:
                raise RuntimeError("snapshot incomplete")
            return json.loads(destination.read_text(encoding="utf-8"))
        finally:
            stop_child(child)

    def runs(self, workflow):
        deadline = self.clock.monotonic() + SNAPSHOT_TIMEOUT
        def get(path, **options):
            if self.clock.monotonic() >= deadline:
                raise TimeoutError("run snapshot deadline exceeded")
            if not self.enabled():
                raise Disabled("loop_disabled")
            return self.github.api(path, **options)
        # Recent completions plus complete active pages: never paginate all
        # historical runs (the 1000-result cap would eventually stop the loop).
        return snapshot_runs(get, workflow)

    def dispatch(self, workflow, inputs):
        return self.github.api("actions/workflows/" + workflow + "/dispatches", method="POST",
                               body={"ref": "main", "inputs": inputs})


def trusted(run, repository, current_run_id, *, dispatched=True):
    # A workflow_run listing does not prove its upstream passes the job gate.
    events = {"workflow_dispatch"} if dispatched else {"workflow_dispatch", "push", "schedule"}
    return (str(run.get("id", "")) != str(current_run_id)
            and run.get("head_branch") == "main"
            and run.get("event") in events
            and (run.get("head_repository") or {}).get("full_name") == repository)


def run_receipt(run):
    return {"run_id": run["id"], "url": run.get("html_url"), "run_status": run.get("status"),
            "conclusion": run.get("conclusion"), "event": run.get("event"),
            "display_title": run.get("display_title"), "created_at": run.get("created_at"),
            "head_sha": run.get("head_sha"), "head_branch": run.get("head_branch"),
            "repository": (run.get("repository") or {}).get("full_name"),
            "head_repository": (run.get("head_repository") or {}).get("full_name"),
            "path": run.get("path")}



def operation(health):
    """Map the shared policy's decision to inputs, never select work here."""
    if health.get("action") == "next_task":
        return NEXT, {"automatic": "true"}
    if health.get("action") == "sync":
        return SYNC, {"main_sha": health["main_sha"], "lab_sha": health["lab_sha"]}
    return None


class Controller:
    def __init__(self, runtime, *, clock=None, current_run_id="", max_wait_seconds=1800,
                 check_interval=30, publish=None):
        if not 0 < max_wait_seconds <= 1800 or not 0 < check_interval <= 30:
            raise ValueError("wait must be within 1800s and switch interval within 30s")
        self.runtime = runtime
        self.clock = clock or Clock()
        self.current_run_id = str(current_run_id)
        self.max_wait_seconds = max_wait_seconds
        self.check_interval = check_interval
        self.publish = publish or (lambda result: None)
        self.health = None
        self.handoff = None
        self.deadline = None
        self.execution = None
        self.admitted_intent = None
        self.stage_started_at = None
        self.stage_started = None
        self.effect_receipt = None

    def report(self, outcome, reason, **extra):
        result = {"observed_at": iso(self.clock.now()), "outcome": outcome, "reason": reason,
                  "wakeup_run_id": self.current_run_id or None, "health": self.health,
                  "scheduler": (self.health or {}).get("scheduler"), "handoff": self.handoff,
                  "wait_deadline": iso(self.deadline) if self.deadline else None, **extra}
        self.publish(result)
        return result

    def check_enabled(self):
        if not self.runtime.enabled():
            raise Disabled("loop_disabled")

    def pause(self, seconds):
        until = self.clock.monotonic() + max(0, seconds)
        while self.clock.monotonic() < until:
            self.check_enabled()
            remaining = until - self.clock.monotonic()
            if remaining <= 0:
                break
            self.clock.sleep(min(self.check_interval, remaining))
        self.check_enabled()

    def observe(self, capability=None):
        self.check_enabled()
        capability = capability or self.execution
        observer = capability.observer_context() if capability is not None else None
        self.health = self.runtime.observe(observer_context=observer)
        self.check_enabled()
        return self.health

    def finish_stage(self):
        if self.effect_receipt is not None or self.execution is None:
            return
        self.check_enabled()
        self.runtime.recheck_context()
        observation = {name: self.health.get(name) for name in
                       ("health", "action", "reason", "due_at", "main_sha", "lab_sha", "state_sha")}
        evidence = {**self.runtime.trigger, "decision_id": self.admitted_intent["decision_id"],
                    "stage_started_at": self.stage_started_at, "stage_completed_at": iso(self.clock.now()),
                    "observation": observation, "waited_seconds": self.clock.monotonic() - self.stage_started,
                    "stage": "bounded_observe_wait", "switch_enabled": True}
        self.effect_receipt = self.runtime.journal.record_effect(self.execution, "continue_handoff", evidence)
        self.runtime.journal.advance(self.effect_receipt["receipt_id"])

    def recheck_dispatch(self, workflow, inputs, timer_handoff, capability=None):
        self.check_enabled()
        self.runtime.recheck_context()
        if workflow == CONTINUE and not timer_handoff:
            return True
        before = self.health
        fresh = self.observe(capability)
        if capability is not None and any(fresh.get(name) != before.get(name)
                                          for name in ("main_sha", "lab_sha")):
            return False
        if workflow == CONTINUE:
            return not operation(fresh) and (fresh.get("reason") in BUSY_REASONS or bool(self.future_due(fresh)))
        return operation(fresh) == (workflow, inputs)

    def confirm(self, workflow, inputs, *, timer_handoff=False):
        inputs = dict(inputs)
        if not self.recheck_dispatch(workflow, inputs, timer_handoff):
            return self.report("changed", "snapshot_changed_before_dispatch")
        self.finish_stage()
        intent, capability = self.runtime.journal.reserve_send(
            workflow, inputs, basis={"health": self.health, "receipt_id":
                                     self.effect_receipt["receipt_id"] if self.effect_receipt else None},
            trigger=self.runtime.trigger, control_sha=self.runtime.control_sha)
        key = intent["correlation_key"]
        dispatch_inputs = {name: ("true" if value else "false") if isinstance(value, bool) else value
                           for name, value in intent["normalized_inputs"].items()}
        dispatch_inputs.update(continuation_key=key, control_sha=intent["control_sha"])
        expected_title = (("Next " if workflow == NEXT else "Continue ") + key if workflow != SYNC
                          else "Sync main " + inputs["main_sha"] + " " + key)
        self.handoff = {"workflow": workflow, "key": key, "decision_id": intent["decision_id"],
                        "control_sha": intent["control_sha"], "status": "pending", "attempts": 0}
        acknowledged = False
        end = self.clock.monotonic() + CONFIRM_SECONDS
        if capability is not None:
            # Claim acknowledgement is the only source of send permission.
            # Recheck after consuming; any failure permanently spends this claim.
            capability.consume()
            if not self.recheck_dispatch(workflow, inputs, timer_handoff, capability):
                return self.report("blocked", "snapshot_changed_after_send_claim")
            self.check_enabled()
            if self.clock.monotonic() >= end:
                return self.report("blocked", "send_recheck_deadline_exceeded")
            self.handoff["intent_at"] = iso(self.clock.now())
            self.handoff["attempts"] = 1
            self.report("dispatching", "requesting_successor")
            try:
                self.runtime.dispatch(workflow, dispatch_inputs)
                acknowledged = True
                self.runtime.journal.observe_delivery(intent["decision_id"],
                    {"kind": "post_acknowledged", "observed_at": iso(self.clock.now())})
            except Disabled:
                raise
            except TRANSIENT:
                self.handoff["status"] = "unknown"
                self.runtime.journal.observe_delivery(intent["decision_id"],
                    {"kind": "post_unknown", "observed_at": iso(self.clock.now())})
            # Continue owns autonomous-lab-wakeup: never await its successor.
            if workflow == CONTINUE:
                self.handoff["status"] = "pending" if acknowledged else "unknown"
                return self.report("handed_off" if acknowledged else "unknown", "successor_requested")
        while self.clock.monotonic() < end:
            self.check_enabled()
            try:
                runs = self.runtime.runs(workflow)
            except Disabled:
                raise
            except TRANSIENT:
                self.pause(min(5, max(0, end - self.clock.monotonic())))
                continue
            matches = [run for run in runs if trusted(run, self.runtime.repository, self.current_run_id)
                       and run.get("display_title") == expected_title]
            if matches:
                viable = [run for run in matches if run.get("status") in ACTIVE_RUN_STATUSES
                          or (run.get("status") == "completed" and run.get("conclusion") == "success")]
                observed = min(viable or matches, key=lambda run: int(run["id"]))
                self.runtime.journal.observe_delivery(intent["decision_id"],
                    {"kind": "run_observed", "observed_at": iso(self.clock.now()), **run_receipt(observed)})
                self.handoff.update(status="confirmed" if viable else "failed", **run_receipt(observed))
                # Titles are delivery metadata only; no admission, replacement,
                # effect receipt or frontier advancement can be inferred here.
                return self.report("handed_off" if viable else "unknown",
                                   "successor_observed" if viable else "successor_failed")
            if workflow == CONTINUE:
                break
            self.pause(min(5, max(0, end - self.clock.monotonic())))
        self.handoff["status"] = "pending" if acknowledged else "unknown"
        return self.report(self.handoff["status"], "successor_confirmation_unavailable")

    def future_due(self, health):
        due = timestamp(health.get("due_at") or health.get("research_next_at"))
        return due if due and due > self.clock.now() else None

    def run(self, *, handoff=False):
        start = self.clock.monotonic()
        self.deadline = self.clock.now() + timedelta(seconds=self.max_wait_seconds)
        failures = 0
        stale_decisions = 0
        try:
            self.check_enabled()
            self.runtime.recheck_context()
            if handoff:
                self.effect_receipt = self.runtime.journal.outcome_for_trigger(self.runtime.trigger)
                if self.effect_receipt is None and not self.runtime.receipt_id:
                    state = self.runtime.journal.current()
                    intent = (next((item for item in state["intents"].values()
                                    if item["correlation_key"] == self.runtime.continuation_key), None)
                              if self.runtime.continuation_key else state["active_intent"])
                    if self.runtime.continuation_key and intent is None:
                        return self.report("blocked", "source_effect_receipt_unavailable")
                    # Handoff observes checked event-main; it cannot repin or
                    # execute the original receiver, which may use an older SHA.
                    try:
                        disposition = self.runtime.journal.nonexecution_outcome(
                            intent, key="", trigger=self.runtime.trigger,
                            control_sha=self.runtime.control_sha)
                        if disposition["outcome"] == "stopped":
                            return self.report(**disposition)
                        runs = self.runtime.runs(intent["workflow"]) if intent else ()
                        self.check_enabled()
                        self.runtime.recheck_context()
                        disposition = self.runtime.journal.nonexecution_outcome(
                            intent, key="", trigger=self.runtime.trigger,
                            control_sha=self.runtime.control_sha, runs=runs)
                    except JournalConflict:
                        return self.report("blocked", "source_effect_receipt_unavailable")
                    return self.report(**disposition)
                if self.effect_receipt is None or (self.runtime.receipt_id and
                        self.runtime.receipt_id != self.effect_receipt["receipt_id"]):
                    return self.report("blocked", "source_effect_receipt_unavailable")
                if not self.runtime.journal.advance(self.effect_receipt["receipt_id"]):
                    return self.report("stopped", "source_receipt_superseded")
                return self.confirm(CONTINUE, {})
            if self.runtime.trigger["event_name"] == "workflow_run":
                source_outcome = self.runtime.journal.outcome_for_trigger(self.runtime.trigger)
                if source_outcome is not None and not self.runtime.journal.advance(source_outcome["receipt_id"]):
                    return self.report("stopped", "source_receipt_superseded")
            self.admitted_intent, self.execution = self.runtime.journal.admit(
                CONTINUE, {}, key=self.runtime.continuation_key,
                trigger=self.runtime.trigger, control_sha=self.runtime.control_sha)
            if self.execution is None:
                disposition = self.runtime.journal.nonexecution_outcome(
                    self.admitted_intent, key=self.runtime.continuation_key,
                    trigger=self.runtime.trigger, control_sha=self.runtime.control_sha)
                if disposition["outcome"] == "stopped":
                    return self.report(**disposition)
                runs = self.runtime.runs(self.admitted_intent["workflow"]) if self.admitted_intent else ()
                self.check_enabled()
                self.runtime.recheck_context()
                disposition = self.runtime.journal.nonexecution_outcome(
                    self.admitted_intent, key=self.runtime.continuation_key,
                    trigger=self.runtime.trigger, control_sha=self.runtime.control_sha, runs=runs)
                return self.report(**disposition)
            self.check_enabled()
            self.runtime.recheck_context()
            self.execution.consume()
            self.stage_started_at = iso(self.clock.now())
            self.stage_started = self.clock.monotonic()
            while True:
                try:
                    health = self.observe()
                    if health.get("health") == "disabled" or health.get("reason") == "loop_disabled":
                        return self.report("disabled", "loop_disabled")
                    if health.get("reason") in BUSY_REASONS:
                        remaining = self.max_wait_seconds - (self.clock.monotonic() - start)
                        if remaining > 0:
                            self.report("waiting", health["reason"])
                            self.pause(min(self.check_interval, remaining))
                            continue
                        result = self.confirm(CONTINUE, {}, timer_handoff=True)
                        if result["outcome"] != "changed":
                            return result
                        self.handoff = None
                        stale_decisions += 1
                        if stale_decisions >= 3:
                            return self.report("unknown", "snapshot_unstable")
                        self.pause(5)
                        continue
                    selected = operation(health)
                    if selected:
                        result = self.confirm(*selected)
                    else:
                        due = self.future_due(health)
                        if due is None:
                            self.finish_stage()
                            return self.report("stopped", health.get("reason", "terminal"))
                        remaining = self.max_wait_seconds - (self.clock.monotonic() - start)
                        if remaining <= 0:
                            result = self.confirm(CONTINUE, {}, timer_handoff=True)
                        else:
                            self.report("waiting", health.get("reason", "deadline_pending"), due_at=iso(due))
                            self.pause(min(remaining, (due - self.clock.now()).total_seconds()))
                            continue
                    if result["outcome"] != "changed":
                        return result
                    # A raced decision is not an effect. Refresh instead of
                    # acting on stale pins, but bound churn without a hot loop.
                    self.handoff = None
                    stale_decisions += 1
                    if stale_decisions >= 3:
                        return self.report("unknown", "snapshot_unstable")
                    self.pause(5)
                except (Disabled, JournalConflict):
                    raise
                except TRANSIENT:
                    if self.handoff and self.handoff.get("attempts"):
                        self.handoff["status"] = "unknown"
                        return self.report("unknown", "handoff_interrupted")
                    if failures >= len(ERROR_DELAYS):
                        return self.report("error", "snapshot_unavailable")
                    delay = ERROR_DELAYS[failures]
                    failures += 1
                    self.report("retrying", "snapshot_unavailable", retry_after_seconds=delay)
                    self.pause(delay)
        except Disabled:
            return self.report("disabled", "loop_disabled")
        except JournalConflict:
            return self.report("blocked", "journal_frontier_conflict")
        except TRANSIENT:
            if self.handoff and self.handoff.get("attempts"):
                self.handoff["status"] = "unknown"
            return self.report("unknown" if self.handoff else "error", "continuation_unavailable")


def safe_result(value, secrets):
    if isinstance(value, dict):
        return {key: safe_result(child, secrets) for key, child in value.items()}
    if isinstance(value, list):
        return [safe_result(child, secrets) for child in value]
    return redact(value, secrets) if isinstance(value, str) else value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--handoff", action="store_true")
    add_arguments(parser)
    parser.add_argument("--source-workflow", choices=(CONTINUE, NEXT, SYNC), default=CONTINUE)
    parser.add_argument("--receipt-id", default=os.environ.get("EFFECT_RECEIPT_ID", ""))
    parser.add_argument("--max-wait-seconds", type=float, default=1800)
    parser.add_argument("--check-interval", type=float, default=30)
    parser.add_argument("--_snapshot-child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--_observer-context", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    config = {}
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        secrets = configured_secrets(config, [])
        def publish(value):
            atomic_write(args.out, json.dumps(safe_result(value, secrets), indent=2) + "\n")
        with tempfile.TemporaryDirectory(prefix="continuation-", dir=args.out.parent) as temporary:
            if args._snapshot_child:
                observer = None
                run_id = ""
                if args._observer_context is not None:
                    observer = json.loads(args._observer_context.read_text(encoding="utf-8"))
                    binding = context(args, args.source_workflow, config)
                    if (not isinstance(observer, dict) or observer.get("trigger") != binding.trigger
                            or observer.get("control_sha") != binding.control_sha):
                        raise ValueError("snapshot owner differs from trusted workflow context")
                    run_id = binding.trigger["run_id"]
                snapshot = collect_snapshot(args.repo, config, Path(temporary), ContinuationGitHub(config["repository"]),
                                            current_run_id=run_id, observer_context=observer)
                publish(snapshot)
                return 0
            clock = Clock()
            runtime = Runtime(args.repo, args.config, temporary, clock=clock,
                              check_interval=args.check_interval, admission_args=args)
            result = Controller(runtime, clock=clock, current_run_id=args.run_id,
                                max_wait_seconds=args.max_wait_seconds, check_interval=args.check_interval,
                                publish=publish).run(handoff=args.handoff)
    except TRANSIENT:
        result = {"observed_at": iso(datetime.now(timezone.utc)), "outcome": "error",
                  "reason": "continuation_initialization_failed", "wakeup_run_id": os.environ.get("GITHUB_RUN_ID"),
                  "health": None, "scheduler": None, "handoff": None}
    text = json.dumps(safe_result(result, configured_secrets(config, [])), indent=2) + "\n"
    atomic_write(args.out, text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a", encoding="utf-8") as handle:
            handle.write("### Autonomous continuation\n\n```json\n" + text + "```\n")
    print(text, end="")
    return 1 if result["outcome"] in {"error", "unknown", "pending", "blocked"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
