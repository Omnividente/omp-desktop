#!/usr/bin/env python3
"""Private subprocess adapter for dispatch_integration_test; loopback/local Git only."""
from __future__ import annotations

import argparse
import copy
import json
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

REAL_RUN = subprocess.run


def http(endpoint, path, method="GET", body=None):
    parsed = urlsplit(endpoint)
    if parsed.hostname != "127.0.0.1" or parsed.scheme != "http":
        raise ValueError("fixture endpoint must be IPv4 loopback HTTP")
    request = Request(endpoint + path, method=method,
                      data=None if body is None else json.dumps(body).encode(),
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=10) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def gh_main(args):
    if not args or args[0] != "api":
        raise ValueError("only synthetic gh api is permitted")
    method = args[args.index("--method") + 1] if "--method" in args else "GET"
    path = next(value for value in args if value.startswith("/repos/synthetic/c-send/"))
    body = json.load(sys.stdin) if "--input" in args else None
    try:
        result = http(os.environ["C_SEND_ENDPOINT"], path, method, body)
        if result is not None:
            print(json.dumps([result] if "--slurp" in args else result))
        return 0
    except Exception as exc:
        print("synthetic HTTP transport: " + str(exc), file=sys.stderr)
        return 1


def adapters(endpoint):
    # Real production gh callers still spawn a subprocess. The adapter itself
    # sends HTTP, including accepted requests whose response is deliberately lost.
    def run(command, *args, **kwargs):
        if command and str(command[0]) == "gh":
            command = [sys.executable, str(Path(__file__).resolve()), "--gh", *command[1:]]
        return REAL_RUN(command, *args, **kwargs)
    subprocess.run = run
    os.environ["C_SEND_ENDPOINT"] = endpoint


def inherited_adapters(fixture, endpoint):
    """Route only external gh transport in every real Python snapshot child.

    sitecustomize avoids platform-specific executable shims (.cmd is not an
    executable on Windows). It never imports or modifies production modules.
    The disposable directory is the sole inherited PYTHONPATH entry.
    """
    directory = fixture / "external-adapter"
    directory.mkdir(exist_ok=True)
    source = (
        "import importlib.util, os, sys\n"
        "spec = importlib.util.spec_from_file_location('_fixture_external', " + repr(str(Path(__file__).resolve())) + ")\n"
        "adapter = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(adapter)\n"
        "adapter.adapters(os.environ['C_SEND_ENDPOINT'])\n"
        "adapter.http(os.environ['C_SEND_ENDPOINT'], '/fixture/process', 'POST', {'argv': sys.argv})\n"
    )
    (directory / "sitecustomize.py").write_text(source, encoding="utf-8")
    os.environ["PYTHONPATH"] = str(directory)

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--gh":
        return gh_main(sys.argv[2:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--operation", choices=["initialize", "sender", "handoff", "receiver", "writer", "sync", "sync-finalize", "health", "control-pin"], required=True)
    parser.add_argument("--fault", default="")
    parser.add_argument("--observer-mode", choices=["injected-health", "production"], default="injected-health")
    parser.add_argument("--run", default="100")
    parser.add_argument("--attempt", default="1")
    parser.add_argument("--source-run-attempt", default="1")
    parser.add_argument("--source-run-id", default="101")
    parser.add_argument("--gates", default="success")
    parser.add_argument("--sync-result", type=Path)
    parser.add_argument("--owner", default="owner-a")
    parser.add_argument("--key", default="")
    parser.add_argument("--time-offset", type=float, default=0)
    parser.add_argument("--workflow", default="autonomous_next_task.yml")
    parser.add_argument("--event", default="schedule")
    parser.add_argument("--task-id", default="selected")
    parser.add_argument("--original-control-sha", default="")
    parser.add_argument("--event-sha", default="")
    options = parser.parse_args()
    sys.path.insert(0, str(options.source / "scripts" / "autonomous"))
    adapters(options.endpoint)
    fixture = options.fixture
    if options.observer_mode == "production":
        inherited_adapters(fixture, options.endpoint)
    repo = fixture / "repo"
    work = fixture / ("process-" + options.run + "-" + options.attempt + "-" + options.operation)
    work.mkdir(exist_ok=True)
    manifest, revision = work / "queue.json", work / "revision.json"
    os.environ.update(GITHUB_RUN_ID=options.run, GITHUB_RUN_ATTEMPT=options.attempt,
                      GITHUB_EVENT_NAME=options.event, GITHUB_ACTOR=options.owner,
                      GITHUB_REPOSITORY="synthetic/c-send", GITHUB_REF="refs/heads/main",
                      CONTINUATION_KEY=options.key if options.event == "workflow_dispatch" else "",
                      JULES_API_KEY="synthetic-not-a-credential")
    workflow = ("autonomous_next_task.yml" if options.operation == "receiver" else
                "autonomous_sync.yml" if options.operation in ("sync", "sync-finalize") else
                options.workflow if options.operation in ("handoff", "control-pin") else "autonomous_continue.yml")
    os.environ["GITHUB_WORKFLOW_REF"] = "synthetic/c-send/.github/workflows/" + workflow + "@refs/heads/main"
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "JULES_API_KEY_BACKUP", "GITHUB_STEP_SUMMARY"):
        os.environ.pop(name, None)
    import state_store
    state = state_store.load_state(repo, manifest, revision)
    control = REAL_RUN(["git", "-C", str(options.source), "rev-parse", "HEAD"],
                       check=True, capture_output=True, text=True).stdout.strip()
    os.environ["GITHUB_SHA"] = options.event_sha or control
    os.environ["CONTROL_SHA"] = control
    if options.event == "workflow_run":
        event_path = work / "event.json"
        event_path.write_text(json.dumps({"workflow_run": {
            "id": int(options.source_run_id), "run_attempt": int(options.source_run_attempt), "name": "Autonomous Continue",
            "head_repository": {"full_name": "synthetic/c-send"},
            "head_branch": "main", "status": "completed"}}), encoding="utf-8")
        os.environ["GITHUB_EVENT_PATH"] = str(event_path)
    elif options.event == "workflow_dispatch":
        inputs = {"continuation_key": options.key}
        if workflow == "autonomous_next_task.yml":
            inputs.update(task_id="" if options.key else options.task_id, automatic="true" if options.key else "false")
        elif workflow == "autonomous_sync.yml":
            health = http(options.endpoint, "/fixture/health")
            inputs.update(main_sha=health["main_sha"], lab_sha=health["lab_sha"])
        if options.key:
            inputs["control_sha"] = options.original_control_sha or control
        event_path = work / "event.json"
        event_path.write_text(json.dumps({"inputs": inputs}), encoding="utf-8")
        os.environ["GITHUB_EVENT_PATH"] = str(event_path)
    if options.operation == "control-pin":
        import workflow_admission
        output, environment = work / "github-output", work / "github-env"
        output.write_text("", encoding="utf-8")
        environment.write_text("", encoding="utf-8")
        os.environ.update(GITHUB_OUTPUT=str(output), GITHUB_ENV=str(environment))
        status = workflow_admission.main([
            "--repo", str(options.source), "--config", str(fixture / "config.json"),
            "--workflow", workflow,
        ])
        result = dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines())
        (work / "out.json").write_text(json.dumps(result), encoding="utf-8")
        print(json.dumps(result))
        return status
    if options.operation == "initialize":
        state_store.save_state(repo, manifest, revision)
        expected = json.loads(revision.read_text())["state_sha"]
        if (options.source / "scripts/autonomous/dispatch_journal.py").exists():
            from dispatch_journal import JournalStore
            JournalStore(repo, manifest, revision).initialize(
                expected_sha=expected, control_sha=control,
                basis={"kind": "fenced_bootstrap", "state_sha": expected,
                       "legacy_senders_fenced": True, "pending_legacy": "none"})
        print(json.dumps({"initialized": True, "control_sha": control}))
        return 0

    original_git = state_store._git
    fault_used = False
    def fault_git(path, *args, **kwargs):
        nonlocal fault_used
        result = original_git(path, *args, **kwargs)
        send_claim = False
        if "push" in args:
            refspec = next((value for value in args if value.endswith(":refs/heads/autonomous/state")), "")
            if refspec and (options.source / "scripts/autonomous/dispatch_journal.py").exists():
                raw = original_git(path, "show", refspec.split(":", 1)[0] + ":agent_tasks.json").stdout
                events = json.loads(raw).get("dispatch_journal", {}).get("events", [])
                send_claim = bool(events and events[-1]["type"] == "SendClaim")
        if options.fault == "lost-cas-ack" and send_claim and not fault_used:
            fault_used = True
            return subprocess.CompletedProcess(result.args, 1, result.stdout, b"synthetic lost CAS ACK")
        return result
    state_store._git = fault_git

    if (options.source / "scripts/autonomous/dispatch_journal.py").exists():
        import dispatch_journal
        original_reserve = dispatch_journal.JournalStore.reserve_send
        def reserve(store, *args, **kwargs):
            if options.fault == "before-claim":
                os._exit(86)
            value = original_reserve(store, *args, **kwargs)
            if value[1] is not None:
                if options.fault == "after-claim":
                    os._exit(86)
                if options.fault == "switch-after-claim":
                    http(options.endpoint, "/fixture/control", "POST", {"enabled": False})
                if options.fault == "context-after-claim":
                    if options.observer_mode == "production":
                        os.environ["GITHUB_RUN_ATTEMPT"] = str(int(options.attempt) + 1)
                    else:
                        http(options.endpoint, "/fixture/control", "POST", {"context_changed": True})
                if options.fault == "owner-after-claim":
                    os.environ["GITHUB_ACTOR"] = "owner-b"
                if options.fault == "inputs-after-claim":
                    os.environ["CONTINUATION_KEY"] = "f" * 64
                if options.fault in ("refs-after-claim", "readiness-after-claim"):
                    http(options.endpoint, "/fixture/fault", "POST", {"fault": options.fault})
            return value
        dispatch_journal.JournalStore.reserve_send = reserve
        if options.fault == "outcome-persistence":
            original_delivery = dispatch_journal.JournalStore.observe_delivery
            def delivery(store, *args, **kwargs):
                os._exit(86)
            dispatch_journal.JournalStore.observe_delivery = delivery

    if options.operation == "writer":
        # Concurrent user result is real authoritative queue state, not a mock.
        state["synthetic_protected"]["history"].append({"writer": options.owner, "result": "retained"})
        manifest.write_text(json.dumps(state), encoding="utf-8")
        try:
            state_store.save_state(repo, manifest, revision)
        except state_store.StateConflict:
            print(json.dumps({"conflict": "stale writer safely rejected"}))
            return 3
        print(json.dumps({"written": options.owner}))
        return 0

    if options.operation == "health":
        if options.observer_mode == "production":
            snapshot = REAL_RUN([sys.executable, str(options.source / "scripts/autonomous/health_snapshot.py"),
                                 "--manifest", str(manifest), "--config", str(fixture / "config.json"),
                                 "--out-dir", str(work)], capture_output=True, text=True, encoding="utf-8")
            if snapshot.returncode:
                (work / "out.json").write_text(snapshot.stdout, encoding="utf-8")
                print(snapshot.stdout, end="")
                return snapshot.returncode
            enabled = http(options.endpoint, "/repos/synthetic/c-send/actions/variables/JULES_LOOP_ENABLED")["value"]
            command = [sys.executable, str(options.source / "scripts/autonomous/loop_health.py"),
                       "--manifest", str(manifest), "--state-revision", str(revision), "--repo", str(repo),
                       "--config", str(fixture / "config.json"), "--enabled", enabled,
                       "--runs", str(work / "next-runs.json"), "--sync-runs", str(work / "sync-runs.json"),
                       "--wakeup-runs", str(work / "wakeup-runs.json"), "--pull-requests", str(work / "pull-requests.json")]
            if options.time_offset:
                command += ["--now", (datetime.now(timezone.utc) + timedelta(seconds=options.time_offset)).isoformat()]
            result = REAL_RUN(command, capture_output=True, text=True, encoding="utf-8")
            (work / "out.json").write_text(result.stdout, encoding="utf-8")
            print(result.stdout, end="")
            print(result.stderr, end="", file=sys.stderr)
            return result.returncode
        import health_snapshot
        import loop_health
        if health_snapshot.main(["--manifest", str(manifest), "--config", str(fixture / "config.json"),
                                 "--out-dir", str(work)]):
            raise RuntimeError("synthetic snapshot failed")
        enabled = http(options.endpoint, "/repos/synthetic/c-send/actions/variables/JULES_LOOP_ENABLED")["value"]
        argv = ["--manifest", str(manifest), "--state-revision", str(revision), "--repo", str(repo),
                "--config", str(fixture / "config.json"), "--enabled", enabled,
                "--now", (datetime(2026, 10, 1, tzinfo=timezone.utc) + timedelta(seconds=options.time_offset)).isoformat(),
                "--runs", str(work / "next-runs.json"), "--sync-runs", str(work / "sync-runs.json"),
                "--wakeup-runs", str(work / "wakeup-runs.json"), "--pull-requests", str(work / "pull-requests.json")]
        if options.sync_result:
            argv += ["--sync-result", str(options.sync_result)]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = loop_health.main(argv)
        (work / "out.json").write_text(output.getvalue(), encoding="utf-8")
        print(output.getvalue(), end="")
        return status

    import continue_loop
    class Clock:
        def __init__(self):
            self.seconds = options.time_offset
            self.origin = (datetime.now(timezone.utc) if options.observer_mode == "production" else
                           datetime(2026, 10, 1, tzinfo=timezone.utc))
        def now(self):
            return self.origin + timedelta(seconds=self.seconds)
        def monotonic(self):
            return self.seconds
        def sleep(self, seconds):
            self.seconds += max(seconds, 60)
    # Only elapsed clock passage is synthetic in production-observer mode;
    # the child reads real refs/state/APIs and computes policy without overrides.
    continue_loop.Clock = Clock
    if options.observer_mode == "injected-health" and hasattr(continue_loop, "uuid"):
        continue_loop.uuid.uuid4 = lambda: type("UUID", (), {"hex": options.key or ("uuid-" + options.run + "-" + options.attempt)})()
    def observe(runtime, *, observer_context=None):
        # Snapshot dependencies are deterministic; authoritative state is still
        # loaded through production Git store at every real Runtime observation.
        state_store.load_state(runtime.repo, Path(runtime.scratch) / "snapshot-state.json",
                               Path(runtime.scratch) / "snapshot-revision.json")
        observation = http(options.endpoint, "/fixture/health")
        observation["state_sha"] = json.loads((Path(runtime.scratch) / "snapshot-revision.json").read_text())["state_sha"]
        return observation
    if options.observer_mode == "injected-health":
        continue_loop.Runtime.observe = observe
    original_dispatch = continue_loop.Runtime.dispatch
    def dispatch(runtime, workflow, inputs):
        if options.fault == "before-post":
            os._exit(86)
        if options.fault == "before-claim" and not hasattr(runtime, "journal"):
            os._exit(86)
        try:
            result = original_dispatch(runtime, workflow, inputs)
        finally:
            if options.fault == "after-post":
                os._exit(86)
        return result
    continue_loop.Runtime.dispatch = dispatch
    if options.operation in ("sender", "handoff"):
        argv = ["--repo", str(repo), "--config", str(fixture / "config.json"),
                "--out", str(work / "out.json"), "--max-wait-seconds", "2", "--check-interval", "1"]
        if options.operation == "handoff":
            argv += ["--handoff"]
            if (options.source / "scripts/autonomous/workflow_admission.py").exists():
                argv += ["--source-workflow", options.workflow]
        # Candidate CLI extensions must not be forwarded to baseline argparse.
        return continue_loop.main(argv)

    if options.operation == "receiver":
        import lab_controller
        import jules_dispatch
        def transport(method, url, headers, payload):
            value = http(options.endpoint, "/worker" + urlsplit(url).path, method, payload)
            return jules_dispatch.Response(200, value)
        original_tick = lab_controller.tick
        def tick(*args, **kwargs):
            if options.fault == "executor-before-effect":
                os._exit(86)
            kwargs["transport"] = transport
            kwargs["api_base"] = options.endpoint + "/v1alpha"
            kwargs["now"] = (datetime.now(timezone.utc) if options.observer_mode == "production" else
                             datetime(2026, 10, 1, tzinfo=timezone.utc) + timedelta(seconds=options.time_offset))
            return original_tick(*args, **kwargs)
        lab_controller.tick = tick
        argv = ["--repo", str(repo), "--config", str(fixture / "config.json"),
                "--manifest", str(manifest), "--revision-file", str(revision),
                "--out", str(work / "out.json"), "--run-id", options.run]
        argv += ["--automatic"] if options.key else ["--task-id", options.task_id]
        # Normalize only the new admission interface, never replace receiver/body.
        if (options.source / "scripts/autonomous/workflow_admission.py").exists():
            argv += ["--continuation-key", options.key]
        return lab_controller.main(argv)

    import sync_main
    pulls = work / "pulls.json"
    pulls.write_text("[]", encoding="utf-8")
    health = http(options.endpoint, "/fixture/health")
    argv = ["--repo", str(repo), "--config", str(fixture / "config.json"),
            "--manifest", str(manifest), "--state-revision", str(revision),
            "--main-sha", health["main_sha"], "--lab-sha", health["lab_sha"],
            "--pull-requests", str(pulls), "--out", str(work / "out.json")]
    if (options.source / "scripts/autonomous/workflow_admission.py").exists():
        argv += ["--candidate-branch", "autonomous/sync-" + options.run + "-" + options.attempt]
        if options.operation == "sync-finalize":
            preparation = fixture / ("process-" + options.run + "-1-sync") / "out.json"
            argv += ["--action", "finalize", "--preparation", str(preparation), "--gates", options.gates]
    status = sync_main.main(argv)
    if not (options.source / "scripts/autonomous/workflow_admission.py").exists():
        # Baseline workflow's original isolated-candidate publication step.
        result = json.loads((work / "out.json").read_text())
        if result.get("status") == "prepared":
            REAL_RUN(["git", "-C", str(repo), "push", "origin", result["candidate_sha"] +
                      ":refs/heads/autonomous/sync-" + options.run + "-" + options.attempt],
                     check=True, capture_output=True)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
