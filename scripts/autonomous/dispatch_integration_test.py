#!/usr/bin/env python3
"""Offline subprocess regression: copied source, disposable Git CAS, real HTTP.

Run candidate: python scripts/autonomous/dispatch_integration_test.py --mode candidate --report candidate.json
Run baseline:  python scripts/autonomous/dispatch_integration_test.py --mode baseline --report baseline.json
The baseline command exits 1 for observed safety violations, 2 for harness errors.
No checkout queue, config, credential, provider or workflow is read or invoked.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
from datetime import datetime, timezone
import subprocess
import sys
import tempfile
import threading
from urllib.parse import parse_qs, unquote, urlsplit

BASE = "49ec3013c53457e12a46892b7285eec3e688cb1e"
REPOSITORY = "synthetic/c-send"
NEXT = "autonomous_next_task.yml"
CONTINUE = "autonomous_continue.yml"
SYNC = "autonomous_sync.yml"
DRIVER = Path(__file__).with_name("dispatch_fixture_driver.py")


def git(repo, *args, check=True):
    return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=" + os.devnull,
                           "-c", "credential.helper=", *args], check=check,
                          capture_output=True, text=True, encoding="utf-8")


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def task(identifier, status="todo"):
    value = {"id": identifier, "title": "Synthetic clock " + identifier,
             "status": status, "task_type": "bugfix", "risk": "low", "priority": 90,
             "focus": ["quality"], "target_paths": ["src/clock.ts"],
             "acceptance": ["Synthetic clock advances"],
             "evidence": {"source": "synthetic", "detail": "Disposable fixture only"},
             "proposal_decision": {"action": "approve", "actor": "owner-a",
                                   "at": "2026-09-30T12:00:00Z", "note": "Synthetic approval"}}
    if status == "done":
        from research_request import CONTEXT_BEGIN, CONTEXT_END, snapshot
        value["task_type"] = "project_discovery"
        value.pop("proposal_decision")
        def attempt(number):
            key = ("a" if number == 1 else "b") * 24
            execution = {"attempts": number, "session_id": "synthetic-protected-" + str(number),
                         "dispatch_key": key, "base_sha": "c" * 40,
                         "starting_branch": "autonomous/attempt-" + key}
            request = {
                "prompt": "AUTONOMOUS_DISPATCH_KEY: " + key + "\nAUTONOMOUS_TASK_ID: " + identifier +
                          "\n\nResearch only on exact pinned base " + execution["base_sha"] + ".\n" +
                          CONTEXT_BEGIN + "[]" + CONTEXT_END,
                "title": "[dispatch:" + key + "] Synthetic saved request",
                "sourceContext": {"source": "sources/github/synthetic/c-send",
                                  "githubRepoContext": {"startingBranch": execution["starting_branch"]}},
                "requirePlanApproval": False,
            }
            execution["research_request"] = snapshot(request, [], "d" * 40)
            return execution
        earlier, execution = attempt(1), attempt(2)
        execution.update(state="completed", outcome="no_change", session_state="COMPLETED",
                         started_at="2026-09-30T01:00:00Z", finished_at="2026-09-30T02:00:00Z",
                         research_request_history=[earlier],
                         feedback_nudge={"result": "sent", "at": "2026-09-30T01:30:00Z"},
                         feedback_nudge_attempt_history=[{
                             "attempts": 1, "session_id": earlier["session_id"], "dispatch_key": earlier["dispatch_key"],
                             "feedback_nudge": {"result": "sent", "at": "2026-09-29T01:30:00Z"}}])
        value["execution"] = execution
        execution["released_attempt_ref"] = execution["starting_branch"]
        value["research_result"] = {
            "summary": "Synthetic accepted observation", "findings": [], "deferred_findings": [],
            "next_hypotheses": [], "proposed_task_ids": [], "completed_at": "2026-09-30T02:00:00Z",
            "observations": [{"scenario": "Disposable clock", "evidence": "Synthetic static fixture",
                              "result": "No proposed change"}],
            "source": {"session_id": execution["session_id"], "dispatch_key": execution["dispatch_key"],
                       "activity_id": "sessions/" + execution["session_id"] + "/activities/synthetic-report",
                       "activity_created_at": "2026-09-30T02:00:00Z", "report_sha256": "e" * 64}}
        value["discovery_import"] = {"source": copy.deepcopy(value["research_result"]["source"]),
                                    "result": {"status": "ok", "changed": True, "added": [], "duplicates": [],
                                               "skipped": [], "detail": "Synthetic accepted empty import",
                                               "unverified_count": 0, "deferred": []}}
    return value


def disposed_task():
    from research_disposition import research_incident
    value = task("disposed", "blocked")
    value.pop("proposal_decision")
    value["task_type"] = "project_discovery"
    value["execution"] = {"state": "exhausted", "outcome": "failed", "attempts": 2,
                          "session_id": "synthetic-disposed", "dispatch_key": "f" * 24,
                          "base_sha": "c" * 40, "starting_branch": "autonomous/attempt-" + "f" * 24,
                          "session_state": "FAILED", "finished_at": "2026-09-30T02:00:00Z"}
    value["execution"]["released_attempt_ref"] = value["execution"]["starting_branch"]
    value["research_disposition"] = {"events": [{
        "action": "close_unaccepted", "actor": "owner-a", "at": "2026-09-30T03:00:00Z",
        "note": "Synthetic historical closure", **research_incident(value)}]}
    return value


def source_checkout(root, checkout, mode, baseline):
    destination = root / "control"
    modules = destination / "scripts/autonomous"
    modules.mkdir(parents=True)
    if mode == "baseline":
        names = git(checkout, "ls-tree", "-r", "--name-only", baseline, "scripts/autonomous").stdout.splitlines()
        for name in names:
            if name.endswith(".py") and not name.endswith("_test.py"):
                (destination / name).write_text(git(checkout, "show", baseline + ":" + name).stdout,
                                               encoding="utf-8")
    else:
        for path in (checkout / "scripts/autonomous").glob("*.py"):
            if not path.name.endswith("_test.py") and path.name != DRIVER.name:
                shutil.copyfile(path, modules / path.name)
    if not (modules / "continue_loop.py").exists():
        raise RuntimeError("selected source has no production continue_loop entrypoint")
    workflows = destination / ".github/workflows"
    workflows.mkdir(parents=True)
    for name in ("autonomous_continue.yml", "autonomous_sync.yml", "autonomous_monitor.yml"):
        if mode == "baseline":
            (workflows / name).write_text(git(checkout, "show", baseline + ":.github/workflows/" + name).stdout,
                                          encoding="utf-8")
        else:
            shutil.copyfile(checkout / ".github/workflows" / name, workflows / name)
    git(root, "init", str(destination))
    git(destination, "config", "user.name", "synthetic-fixture")
    git(destination, "config", "user.email", "fixture@example.invalid")
    git(destination, "config", "commit.gpgsign", "false")
    git(destination, "add", ".")
    git(destination, "commit", "-m", "synthetic copied control source")
    return destination


class Endpoint:
    """Accepted effects and visibility are separate, including response loss."""
    def __init__(self, remote, health, scenario, *, observer_mode="injected-health"):
        self.remote, self.health, self.scenario = remote, health, scenario
        self.observer_mode = observer_mode
        self.requests = []
        self.processes = []
        self.unavailable_runs = set()
        self.enabled = True
        self.context_changed = False
        self.posts = []
        self.runs = []
        self.sessions = []
        self.worker_gets = []
        self.run_reads = 0
        self.lock = threading.RLock()
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.handle_request("GET")
            def do_POST(self):
                self.handle_request("POST")
            def do_DELETE(self):
                self.handle_request("DELETE")
            def handle_request(self, method):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length)) if length else None
                try:
                    with fixture.lock:
                        value, lost = fixture.request(method, self.path, body)
                    if lost:
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    data = json.dumps(value).encode() if value is not None else b""
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except Exception as exc:
                    data = str(exc).encode()
                    self.send_response(500)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, body):
        self.requests.append({"method": method, "path": path, "body": copy.deepcopy(body)})
        if path == "/fixture/process" and method == "POST":
            self.processes.append(copy.deepcopy(body))
            return {}, False
        if path == "/fixture/fault" and method == "POST":
            if body["fault"] == "refs-after-claim":
                parent = git(self.remote, "rev-parse", "refs/heads/main").stdout.strip()
                tree = git(self.remote, "rev-parse", parent + "^{tree}").stdout.strip()
                commit = git(self.remote, "-c", "user.name=synthetic-fixture", "-c",
                             "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
                             "commit-tree", tree, "-p", parent, "-m", "synthetic concurrent main movement").stdout.strip()
                git(self.remote, "update-ref", "refs/heads/main", commit)
            elif body["fault"] == "readiness-after-claim":
                self.runs.append({"id": 800, "workflow": NEXT, "path": ".github/workflows/" + NEXT,
                                  "display_title": "Synthetic occupied NEXT slot", "status": "in_progress",
                                  "event": "schedule", "head_branch": "main", "head_sha": self.health["control_sha"],
                                  "head_repository": {"full_name": REPOSITORY}, "repository": {"full_name": REPOSITORY},
                                  "created_at": datetime.now(timezone.utc).isoformat()})
            else:
                raise ValueError("unknown synthetic fault")
            return {}, False
        if path == "/fixture/control" and method == "POST":
            for key, value in body.items():
                setattr(self, key, value)
            return {}, False
        if path == "/fixture/health":
            value = copy.deepcopy(self.health)
            if self.context_changed:
                value.update(action="none", reason="context_changed", due_at=None)
            return value, False
        if path.startswith("/worker/"):
            if method == "GET":
                self.worker_gets.append(path)
            resource = urlsplit(path).path
            if method == "POST" and resource.endswith("/sessions"):
                value = dict(body, id=str(len(self.sessions) + 1), name="sessions/" + str(len(self.sessions) + 1),
                             state="IN_PROGRESS", outputs=[])
                self.sessions.append(value)
                return value, False
            if resource.endswith("/sessions"):
                return {"sessions": self.sessions}, False
            if resource.endswith("/activities"):
                return {"activities": []}, False
            identifier = resource.split("/")[-1]
            return next((value for value in self.sessions if value["id"] == identifier), {}), False
        prefix = "/repos/" + REPOSITORY + "/"
        if not path.startswith(prefix):
            raise ValueError("non-synthetic API route rejected")
        route = path[len(prefix):]
        if route == "actions/variables/JULES_LOOP_ENABLED":
            return {"value": "true" if self.enabled else "false"}, False
        if route.startswith("git/ref/heads/"):
            branch = unquote(route[len("git/ref/heads/"):])
            result = git(self.remote, "rev-parse", "--verify", "refs/heads/" + branch, check=False)
            return {"object": {"sha": result.stdout.strip()}}, False
        if route == "git/refs" and method == "POST":
            git(self.remote, "update-ref", body["ref"], body["sha"])
            return {}, False
        if route.startswith("git/refs/heads/") and method == "DELETE":
            git(self.remote, "update-ref", "-d", "refs/heads/" + unquote(route[len("git/refs/heads/"):]))
            return None, False
        if route.startswith("pulls?"):
            return [], False
        if route.startswith("actions/workflows/") and "/dispatches" in route and method == "POST":
            workflow = route.split("/")[2]
            inputs = copy.deepcopy(body["inputs"])
            self.posts.append({"workflow": workflow, "inputs": inputs, "accepted": True})
            identifier = 1000 + len(self.posts)
            title = ("Sync main " + inputs.get("main_sha", "") +
                     (" " + inputs["continuation_key"] if inputs.get("continuation_key") else "") if workflow == SYNC else
                     ("Next " if workflow == NEXT else "Continue ") + inputs.get("continuation_key", ""))
            run = {"id": identifier, "display_title": title, "status": "queued",
                   "event": "workflow_dispatch", "head_branch": "main", "head_sha": self.health["control_sha"],
                   "head_repository": {"full_name": REPOSITORY}, "repository": {"full_name": REPOSITORY},
                   "html_url": self.url + "/runs/" + str(identifier),
                   "path": ".github/workflows/" + workflow, "workflow": workflow,
                   "created_at": (datetime.now(timezone.utc).isoformat() if self.observer_mode == "production"
                                  else "2026-10-01T00:00:00Z")}
            if "cancel" in self.scenario or "coalesced" in self.scenario:
                run.update(status="completed", conclusion="cancelled")
            self.runs.append(run)
            if "coalesced" in self.scenario:
                self.runs.append(dict(run, id=identifier + 500, event="workflow_run", status="queued",
                                      conclusion=None, display_title="Continue trusted callback " + str(identifier + 500)))
            return None, "lost-ack" in self.scenario
        if route.startswith("actions/workflows/") and "/runs" in route:
            self.run_reads += 1
            workflow = route.split("/")[2]
            hidden = "delayed" in self.scenario or "lost-ack" in self.scenario or "late" in self.scenario
            values = [] if hidden else [copy.deepcopy(run) for run in self.runs if run["workflow"] == workflow]
            status = parse_qs(urlsplit(route).query).get("status", [None])[0]
            if status:
                values = [run for run in values if run["status"] == status]
            if status == "completed" and self.observer_mode == "production":
                limit = int(parse_qs(urlsplit(route).query).get("per_page", ["100"])[0])
                values = sorted(values, key=lambda run: int(run["id"]), reverse=True)[:limit]
            return {"total_count": len(values), "workflow_runs": values}, False
        if route.startswith("actions/runs/"):
            if route.split("/")[2] in self.unavailable_runs:
                raise ValueError("synthetic pinned run unavailable")
            return copy.deepcopy(next(run for run in self.runs if str(run["id"]) == route.split("/")[2])), False
        raise ValueError("unexpected synthetic route: " + method + " " + route)


def make_fixture(root, *, research=False):
    remote, repo = root / "remote.git", root / "repo"
    git(root, "init", "--bare", str(remote))
    git(root, "init", str(repo))
    git(repo, "config", "user.name", "synthetic-fixture")
    git(repo, "config", "user.email", "fixture@example.invalid")
    git(repo, "config", "commit.gpgsign", "false")
    git(repo, "config", "core.autocrlf", "false")
    protected = {"task": "protected", "request": {"prompt": "synthetic immutable request"},
                 "owner": "owner-a", "result": {"outcome": "accepted synthetic report"},
                 "history": [{"writer": "seed", "result": "retained"}]}
    seed = {"version": 2, "autonomous_loop_policy": {"lifecycle": {"max_attempts": 2, "stale_in_progress_hours": 6}},
            "tasks": [task("selected"), task("protected", "done"), disposed_task()], "synthetic_protected": protected}
    if research:
        selected = seed["tasks"][0]
        selected.pop("proposal_decision")
        selected.update(task_type="project_discovery", research={
            "area_id": "clock", "perspective_id": "behavior", "fingerprint": "a" * 64,
            "cycle": 1, "previous_reports": []})
    write_json(repo / "agent_tasks.json", seed)
    (repo / "src").mkdir()
    (repo / "src/clock.ts").write_text("export const clock = 0;\n", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "synthetic source fixture")
    git(repo, "branch", "-M", "autonomous/lab")
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "origin", "HEAD", "HEAD:refs/heads/main")
    sha = git(repo, "rev-parse", "HEAD").stdout.strip()
    config = {"repository": REPOSITORY, "default_branch": "main",
              "automation": {"merge_mode": "manual"}, "research": {"enabled": False},
              "parallel_mode": {"integration_branch": "autonomous/lab"},
              "merge_gate": {"owner_approvers": ["owner-a", "owner-b"]},
              "product": {"editable_globs": ["src/**"], "excluded": []}}
    if research:
        config["research"] = {"enabled": True, "revisit_after_hours": 24, "max_sessions_per_day": 24,
                              "areas": [{"id": "clock", "title": "clock", "paths": ["src/clock.ts"]}],
                              "perspectives": [{"id": "behavior", "title": "behavior", "focus": ["quality"],
                                                "instruction": "Inspect the synthetic clock boundary."}]}
    write_json(root / "config.json", config)
    templates = root / "docs/autonomous"
    templates.mkdir(parents=True)
    # Deliberately new, clearly synthetic resources; no product documentation copied.
    (templates / "JULES_TASK_PROMPT.md").write_text("Synthetic fixture {{TASK_ID}} {{TASK_JSON}}\n", encoding="utf-8")
    (templates / "JULES_PROJECT_DISCOVERY_PROMPT.md").write_text("Synthetic research {{TASK_ID}} {{TASK_JSON}}\n", encoding="utf-8")
    return repo, remote, seed, sha


def child(source, fixture, endpoint, operation, **options):
    command = [sys.executable, str(DRIVER), "--source", str(source), "--fixture", str(fixture),
               "--endpoint", endpoint.url, "--operation", operation]
    for key, value in options.items():
        command += ["--" + key.replace("_", "-"), str(value)]
    environment = {key: value for key, value in os.environ.items()
                   if not any(token in key.upper() for token in ("TOKEN", "API_KEY", "SECRET", "CREDENTIAL"))
                   and not key.startswith("GITHUB_") and not key.upper().endswith("_PROXY")
                   and key not in ("PYTHONPATH", "PYTHONSTARTUP")}
    environment.update(GIT_TERMINAL_PROMPT="0", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                       PYTHONNOUSERSITE="1", NO_PROXY="127.0.0.1,localhost", C_SEND_ENDPOINT=endpoint.url)
    result = subprocess.run(command, env=environment, capture_output=True, text=True,
                            encoding="utf-8", timeout=120)
    output_path = fixture / ("process-" + str(options.get("run", "100")) + "-" +
                             str(options.get("attempt", "1")) + "-" + operation) / "out.json"
    output = json.loads(output_path.read_text(encoding="utf-8")) if output_path.exists() else None
    # Argument/import/fixture failures are infrastructure errors, never baseline evidence.
    if any(value in result.stderr for value in ("unrecognized arguments", "ImportError", "ModuleNotFoundError", "SyntaxError", "Traceback")):
        raise RuntimeError("child infrastructure failure: " + result.stderr[-4000:])
    return {"operation": operation, "options": {key: str(value) if isinstance(value, Path) else value for key, value in options.items()}, "exit": result.returncode,
            "output": output, "stderr": result.stderr[-1000:]}


def state_snapshot(remote):
    return json.loads(git(remote, "show", "refs/heads/autonomous/state:agent_tasks.json").stdout)


SCENARIOS = [
    "lost-ack-delayed-cross-process", "cross-owner-uuid-attempt-time", "stop-resume",
    "crash-before-claim", "crash-after-claim", "crash-before-post", "crash-after-post",
    "crash-outcome-persistence", "lost-cas-ack", "callback-rerun", "foreign-key",
    "context-after-claim", "switch-after-claim", "late-successor", "cancel-successor",
    "coalesced-successor", "competing-writers", "continue-to-continue", "receiver-rerun", "sync-receiver-rerun",
    "lost-ack-delayed-cross-process-sync", "lost-ack-delayed-cross-process-continue",
    "lost-cas-ack-sync", "lost-cas-ack-continue",
    "next-handoff-poll", "callback-source-rerun",
]

CANDIDATE_SCENARIOS = ["sync-finalize-handoff"]


def scenario(source, root, name, mode):
    fixture = root / name
    fixture.mkdir()
    repo, remote, seed, sha = make_fixture(fixture)
    control = git(source, "rev-parse", "HEAD").stdout.strip()
    target = SYNC if name.endswith("-sync") else CONTINUE if name.endswith("-continue") else NEXT
    timer = target == CONTINUE or any(value in name for value in ("late", "cancel", "coalesced", "continue-to-continue"))
    health = {"health": "ok", "action": "none" if timer else "sync" if target == SYNC else "next_task",
              "reason": "research_cooldown" if timer else "work_due", "main_sha": sha,
              "lab_sha": sha, "state_sha": "", "control_sha": control,
              "scheduler": {"state": "waiting" if timer else "ready"},
              "due_at": "2026-10-02T00:00:00Z" if timer else None}
    if name == "callback-source-rerun":
        health.update(action="none", reason="terminal", due_at=None)
    if name in ("sync-receiver-rerun", "sync-finalize-handoff"):
        git(repo, "checkout", "-b", "main")
        (repo / "src/clock.ts").write_text("export const clock = 1;\n", encoding="utf-8")
        git(repo, "add", "src/clock.ts")
        git(repo, "commit", "-m", "synthetic main change")
        git(repo, "push", "origin", "main")
        health["main_sha"] = git(repo, "rev-parse", "HEAD").stdout.strip()
        git(repo, "checkout", "autonomous/lab")
    endpoint = Endpoint(remote, health, name)
    evidence = []
    expected_posts = 1
    try:
        evidence.append(child(source, fixture, endpoint, "initialize"))
        initial = state_snapshot(remote)
        if name == "next-handoff-poll":
            expected_posts = 2
            evidence.append(child(source, fixture, endpoint, "receiver", run="900", event="workflow_dispatch"))
            evidence.append(child(source, fixture, endpoint, "handoff", run="900", event="workflow_dispatch", workflow=NEXT))
            continue_key = endpoint.posts[-1]["inputs"].get("continuation_key", "")
            evidence.append(child(source, fixture, endpoint, "sender", run="1001", event="workflow_dispatch", key=continue_key))
            next_key = endpoint.posts[-1]["inputs"].get("continuation_key", "")
            polls_before = len(endpoint.worker_gets)
            evidence.append(child(source, fixture, endpoint, "receiver", run="1002", event="workflow_dispatch", key=next_key, time_offset="3600"))
            last = evidence[-1]["output"] or {}
            allowed = (len(endpoint.posts) == 2 and len(endpoint.sessions) == 1
                       and len(endpoint.worker_gets) > polls_before and all(item["exit"] == 0 for item in evidence)
                       and (mode == "baseline" or bool(last.get("effect_receipt_id"))))
        elif name == "sync-finalize-handoff":
            expected_posts = 1
            evidence.append(child(source, fixture, endpoint, "sync", run="300", event="workflow_dispatch"))
            evidence.append(child(source, fixture, endpoint, "sync-finalize", run="300", event="workflow_dispatch"))
            publication = evidence[-1]["output"] or {}
            published_sha = git(remote, "rev-parse", "refs/heads/autonomous/lab").stdout.strip()
            finalized = state_snapshot(remote)
            evidence.append(child(source, fixture, endpoint, "sync-finalize", run="300", event="workflow_dispatch"))
            repeat = evidence[-1]["output"] or {}
            unchanged = state_snapshot(remote) == finalized
            evidence.append(child(source, fixture, endpoint, "handoff", run="300", event="workflow_dispatch", workflow=SYNC))
            allowed = (publication.get("publication") == "published" and publication.get("effect_receipt_id")
                       and published_sha == publication.get("candidate_sha") and unchanged
                       and repeat.get("reason") == "finalization_already_claimed"
                       and len(endpoint.posts) == 1 and all(item["exit"] == 0 for item in evidence))
        elif name == "receiver-rerun":
            expected_posts = 0
            evidence.append(child(source, fixture, endpoint, "receiver", run="1001", event="workflow_dispatch"))
            before = state_snapshot(remote)
            first_worker_gets = len(endpoint.worker_gets)
            evidence.append(child(source, fixture, endpoint, "receiver", run="1001", attempt="2", event="workflow_dispatch"))
            after = state_snapshot(remote)
            allowed = len(endpoint.sessions) == 1 and len(endpoint.worker_gets) == first_worker_gets and before == after
        elif name == "sync-receiver-rerun":
            evidence.append(child(source, fixture, endpoint, "sync", run="300", event="workflow_dispatch"))
            before = state_snapshot(remote)
            refs_before = git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/autonomous/sync-*").stdout.splitlines()
            evidence.append(child(source, fixture, endpoint, "sync", run="300", attempt="2", event="workflow_dispatch"))
            refs_after = git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/autonomous/sync-*").stdout.splitlines()
            allowed = before == state_snapshot(remote) and refs_before == refs_after and len(refs_before) == 1
            expected_posts = 0
        elif name == "callback-source-rerun":
            expected_posts = 0
            evidence.append(child(source, fixture, endpoint, "sender", run="201", event="workflow_run"))
            before = state_snapshot(remote)
            endpoint.health.update(action="next_task", reason="work_due")
            evidence.append(child(source, fixture, endpoint, "sender", run="202", attempt="2",
                                  event="workflow_run", source_run_attempt="2"))
            allowed = len(endpoint.posts) == 0 and state_snapshot(remote) == before
        else:
            fault = name[len("crash-"):] if name.startswith("crash-") else (
                "lost-cas-ack" if name.startswith("lost-cas-ack") else
                name if name in ("switch-after-claim", "context-after-claim") else "")
            if name == "competing-writers":
                # Independent subprocesses contend through real force-with-lease.
                jobs = []
                results = []
                def launch(operation, options):
                    try:
                        results.append(child(source, fixture, endpoint, operation, **options))
                    except Exception as exc:
                        results.append({"infrastructure_error": str(exc)})
                for operation, options in (("writer", {"run": "500", "owner": "owner-b"}),
                                           ("sender", {"run": "101"}), ("sender", {"run": "102", "owner": "owner-b"})):
                    job = threading.Thread(target=launch, args=(operation, options))
                    jobs.append(job)
                    job.start()
                for job in jobs:
                    job.join()
                evidence.extend(results)
                if any("infrastructure_error" in result for result in results):
                    raise RuntimeError(str(results))
            else:
                evidence.append(child(source, fixture, endpoint, "sender", run="101", fault=fault))
            first_count = len(endpoint.posts)
            if name == "stop-resume":
                endpoint.enabled = False
                evidence.append(child(source, fixture, endpoint, "sender", run="102", owner="owner-b"))
                endpoint.enabled = True
            if name in ("switch-after-claim", "context-after-claim"):
                expected_posts = 0
            if name in ("crash-after-claim", "crash-before-post") or name.startswith("lost-cas-ack"):
                expected_posts = 0
            if name == "foreign-key":
                evidence.append(child(source, fixture, endpoint, "sender", run="103", key="foreign-key", event="workflow_dispatch"))
            else:
                evidence.append(child(source, fixture, endpoint, "sender", run="102", attempt="2", owner="owner-b",
                                      key="new-uuid", time_offset="7200", event="workflow_run" if name == "callback-rerun" else "schedule"))
            allowed = len(endpoint.posts) == expected_posts
            if name == "continue-to-continue":
                # Successor remains queued: parent must not need its executor admission.
                allowed = (first_count == 1 and len(endpoint.posts) == 1
                           and endpoint.posts[0]["workflow"] == CONTINUE
                           and endpoint.runs[0]["status"] == "queued")
        final = state_snapshot(remote)
        protected_before = initial["synthetic_protected"]
        protected_after = final["synthetic_protected"]
        preserved = all(protected_after[field] == protected_before[field]
                        for field in ("task", "request", "owner", "result"))
        preserved = preserved and protected_after["history"][:len(protected_before["history"])] == protected_before["history"]
        if name == "competing-writers":
            writer = next(value for value in evidence if value.get("operation") == "writer")
            if writer["exit"] == 0:
                preserved = preserved and {"writer": "owner-b", "result": "retained"} in protected_after["history"]
        protected_task = next(value for value in final["tasks"] if value["id"] == "protected")
        preserved = preserved and protected_task == seed["tasks"][1]
        preserved = preserved and next(value for value in final["tasks"] if value["id"] == "disposed") == seed["tasks"][2]
        preserved = preserved and [value["id"] for value in final["tasks"]] == [value["id"] for value in seed["tasks"]]
        preserved = preserved and final["tasks"][0]["proposal_decision"] == seed["tasks"][0]["proposal_decision"]
        journal = final.get("dispatch_journal", {})
        return {"scenario": name, "status": "pass" if allowed and preserved else "fail",
                "accepted_posts": len(endpoint.posts), "expected_posts": expected_posts,
                "accepted_worker_posts": len(endpoint.sessions), "worker_gets": endpoint.worker_gets, "posts": endpoint.posts,
                "protected_state_preserved": preserved, "journal_events": journal.get("events", []),
                "subprocesses": evidence, "failure_kind": None if allowed and preserved else "consumer_effect_or_state_violation"}
    finally:
        endpoint.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["baseline", "candidate"], required=True)
    parser.add_argument("--checkout", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--baseline", default=BASE)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--scenario", action="append", choices=SCENARIOS + CANDIDATE_SCENARIOS)
    args = parser.parse_args(argv)
    report = {"mode": args.mode, "baseline": args.baseline, "scenarios": [], "network": "127.0.0.1 only",
              "source_policy": "autonomous Python modules only; no product queue, credentials or config"}
    exit_code = 0
    with tempfile.TemporaryDirectory(prefix="c-send-integration-") as temporary:
        root = Path(temporary)
        try:
            source = source_checkout(root, args.checkout.resolve(), args.mode, args.baseline)
            report["source_hashes"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                       for path in (source / "scripts/autonomous").glob("*.py")}
            for name in args.scenario or (SCENARIOS + (CANDIDATE_SCENARIOS if args.mode == "candidate" else [])):
                try:
                    result = scenario(source, root, name, args.mode)
                    if result["status"] == "fail":
                        exit_code = max(exit_code, 1)
                except Exception as exc:
                    result = {"scenario": name, "status": "infrastructure_error", "error": str(exc)}
                    exit_code = 2
                report["scenarios"].append(result)
                print(name + ": " + result["status"], flush=True)
        except Exception as exc:
            report["infrastructure_error"] = str(exc)
            exit_code = 2
    report["exit_code"] = exit_code
    report["counts"] = {status: sum(value["status"] == status for value in report["scenarios"])
                        for status in ("pass", "fail", "infrastructure_error")}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    write_json(args.report, report)
    return exit_code


if __name__ == "__main__":
    if len(sys.argv) == 1:
        with tempfile.TemporaryDirectory(prefix="c-send-report-") as directory:
            raise SystemExit(main(["--mode", "candidate", "--report", str(Path(directory) / "report.json")]))
    raise SystemExit(main())
