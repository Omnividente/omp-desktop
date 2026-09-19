#!/usr/bin/env python3
"""One recoverable research/proposal tick. Never merge a PR or write main."""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

from build_jules_request import build, dispatch_key, next_attempt
from complete_jules_task import atomic_write, bound_session, harvest, redact
from health_snapshot import inspect_health
from jules_dispatch import (
    DEFAULT_API_BASE, CreateRejected, KeyRing, dispatch, get_session, session_failed,
    session_is_active, session_state, session_resource, request_with_keys, urllib_transport,
)
from jules_provenance import bind_proposal, session_pull_request, trusted_pull_request
from research_cycle import plan_research, scope_fingerprints
from select_task import pending_rejection, pending_report_repair, select, valid_research_detachment
from state_store import load_state, save_state
from proposal_backlog import authorize
from task_lifecycle import (
    awaiting_report, awaiting_review, complete, find_task, iso, quarantine, reconcile,
    parse_iso, reserve, start, sweep,
)
from validate_tasks import validate
from loop_health import WAITING_REASONS, worker_observation

LAB_BRANCH = "autonomous/lab"


class StateWriteError(Exception):
    """Stop all external effects when the queue could not be durably saved."""


class GitHub:
    """Small gh adapter; every mutation is narrowly named and owner-independent."""

    def __init__(self, repository: str):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("invalid repository")
        self.repository = repository

    def api(self, path: str, *, method: str = "GET", body=None, missing=False):
        command = ["gh", "api", "--method", method, "/repos/" + self.repository + "/" + path]
        if body is not None:
            command += ["--input", "-"]
        attempts = 3 if method == "GET" else 1
        for attempt in range(attempts):
            result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                                    text=True, encoding="utf-8", stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=90)
            if result.returncode == 0:
                return json.loads(result.stdout) if result.stdout.strip() else None
            if missing and "HTTP 404" in result.stderr:
                return None
            if attempt + 1 < attempts:
                time.sleep(2 ** attempt)
        raise RuntimeError("GitHub " + method + " failed for " + path.split("?")[0])

    def enabled(self) -> bool:
        return self.api("actions/variables/JULES_LOOP_ENABLED").get("value") == "true"

    def head(self, branch: str) -> str:
        value = self.api("git/ref/heads/" + quote(branch, safe=""), missing=True)
        return str((value or {}).get("object", {}).get("sha") or "")

    def ensure_attempt(self, branch: str, sha: str) -> None:
        if not re.fullmatch(r"autonomous/attempt-[0-9a-f]{24}", branch):
            raise ValueError("invalid immutable attempt ref")
        current = self.head(branch)
        if not current:
            if not self.enabled():
                raise RuntimeError("loop_disabled_before_attempt_ref")
            try:
                self.api("git/refs", method="POST", body={"ref": "refs/heads/" + branch, "sha": sha})
            except RuntimeError:
                # Creation may have succeeded despite a lost acknowledgement.
                if self.head(branch) != sha:
                    raise
            current = self.head(branch)
        if current != sha:
            raise ValueError("attempt branch already exists at a different revision")

    def proposal(self, number: int) -> dict:
        result = self.api("pulls/" + str(number))
        if not isinstance(result, dict) or result.get("number") != number:
            raise ValueError("invalid pull request response")
        return result

    def retarget(self, pr: dict, execution: dict) -> dict:
        """Jules starts from an immutable ref; proposals must target lab, not it."""
        base = pr.get("base") or {}
        head = pr.get("head") or {}
        number = pr.get("number")
        expected_url = "https://github.com/" + self.repository + "/pull/" + str(number)
        if (pr.get("html_url") != expected_url or (base.get("repo") or {}).get("full_name") != self.repository
                or (head.get("repo") or {}).get("full_name") != self.repository):
            raise ValueError("foreign proposal cannot be retargeted")
        if base.get("ref") == LAB_BRANCH:
            return pr
        starting = execution.get("starting_branch") or ""
        if (not re.fullmatch(r"autonomous/attempt-[0-9a-f]{24}", starting)
                or base.get("ref") != starting or pr.get("state") != "open"):
            raise ValueError("proposal does not target its recorded attempt or laboratory")
        if not self.enabled():
            raise RuntimeError("loop_disabled_before_retarget")
        self.api("pulls/" + str(number), method="PATCH", body={"base": LAB_BRANCH})
        return self.proposal(number)

    def release_attempt(self, repo: Path, execution: dict) -> str:
        """Delete only a terminal worker's unchanged, unreferenced starting ref."""
        branch = execution.get("starting_branch", "")
        sha = execution.get("base_sha", "")
        if (not re.fullmatch(r"autonomous/attempt-[0-9a-f]{24}", branch)
                or branch != "autonomous/attempt-" + execution.get("dispatch_key", "")
                or not re.fullmatch(r"[0-9a-f]{40}", sha)):
            return "not_owned"
        if execution.get("session_state") not in ("COMPLETED", "FAILED"):
            return "worker_unresolved"
        current = self.head(branch)
        if not current:
            return "absent"
        if current != sha:
            return "ref_moved"
        for name, value in (("base", branch), ("head", self.repository.split("/")[0] + ":" + branch)):
            proposals = self.api("pulls?state=open&per_page=1&" + name + "=" + quote(value, safe=""))
            if not isinstance(proposals, list):
                raise ValueError("cannot verify attempt ref is unused")
            if proposals:
                return "open_proposal"
        if not self.enabled():
            return "loop_disabled"
        ref = "refs/heads/" + branch
        _git(repo, "-c", "http.https://github.com/.extraheader=", "-c", "credential.helper=",
             "-c", "credential.https://github.com.helper=!gh auth git-credential",
             "push", "--force-with-lease=" + ref + ":" + sha, "origin", ":" + ref)
        return "removed"


def _git(repo: Path, *args: str, check=True):
    result = subprocess.run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=90)
    if check and result.returncode:
        raise RuntimeError("cannot establish laboratory product revision")
    return result


def _request(task: dict, repository: str, templates: Path, *, focus: str, risk: str) -> dict:
    execution = task.get("execution") or {}
    name = "JULES_PROJECT_DISCOVERY_PROMPT.md" if task.get("task_type") == "project_discovery" else "JULES_TASK_PROMPT.md"
    return build(task, template=(templates / name).read_text(encoding="utf-8"), repo=repository,
                 branch=LAB_BRANCH, base_sha=execution.get("base_sha", ""),
                 starting_branch=execution.get("starting_branch", LAB_BRANCH),
                 attempt=execution.get("attempts") or 1, focus=focus, risk_ceiling=risk)


def tick(
    manifest: dict, config: dict, *, repo: Path, templates: Path, github, persist,
    api_keys, transport=urllib_transport, api_base=DEFAULT_API_BASE,
    now: datetime | None = None, task_id: str = "", focus: str = "", risk: str = "medium",
    recover_report: bool = False, diagnostics: Path | None = None,
    automatic: bool = False, run_id: str = "", repair_after: str = "", actor: str = "",
) -> dict:
    """CAS-check before effects; persist transitions, report every observation separately."""
    clock = (lambda: now) if now is not None else lambda: datetime.now(timezone.utc)
    now = clock()
    repository = config["repository"]
    ring = api_keys if isinstance(api_keys, KeyRing) else KeyRing(api_keys)
    result = {"observed_at": iso(now), "action": "none", "reason": "idle", "attention": [],
              "proposals": [], "observations": [], "waiting_workers": [], "research": {}, "merge_mode": "manual"}
    if config.get("automation", {}).get("merge_mode") != "manual":
        raise ValueError("laboratory controller requires manual acceptance")
    if config.get("parallel_mode", {}).get("integration_branch") != LAB_BRANCH:
        raise ValueError("laboratory target must not be main")
    if repair_after:
        if automatic or not recover_report or not task_id:
            raise ValueError("repeat repair requires an explicit report recovery for one task")
        actor = authorize(config, actor)
    if automatic:
        if task_id or focus or recover_report:
            raise ValueError("automatic ticks cannot select or recover a task")
        result["automatic"] = True
        if not github.enabled():
            return dict(result, reason="loop_disabled", skipped=True)
        branch = config.get("default_branch", "main")
        if branch != "main":
            raise ValueError("automatic ticks require the trusted main control plane")
        _git(repo, "fetch", "--no-tags", "origin",
             "+refs/heads/main:refs/remotes/origin/main",
             "+refs/heads/autonomous/lab:refs/remotes/origin/autonomous/lab")
        lab_sha = _git(repo, "rev-parse", "HEAD").stdout.decode().strip()
        current_lab = _git(repo, "rev-parse", "refs/remotes/origin/autonomous/lab").stdout.decode().strip()
        if lab_sha != current_lab:
            return dict(result, reason="product_moved", skipped=True)
        readiness = inspect_health(manifest, config, repo=repo, enabled=True,
                                   now=now, current_run_id=run_id)
        result["scheduler"] = readiness["scheduler"]
        if readiness["action"] != "next_task":
            return dict(result, reason=readiness["reason"], skipped=True)
        if not github.enabled():
            return dict(result, reason="loop_disabled", skipped=True)

    def checkpoint():
        try:
            persist(manifest)
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
            raise StateWriteError("state save failed; reload the authoritative queue before continuing") from exc

    def finish():
        useful = (result["observations"] or result["proposals"]
                  or result["research"].get("research_changed")
                  or result["action"] not in ("none", "stopped"))
        # Targeted report recovery is not a poll of the other saved workers.
        if not recover_report and useful and not result["attention"] and result["reason"] != "loop_disabled":
            controller = manifest.setdefault("controller", {})
            controller["last_tick_at"] = iso(clock())
            if run_id:
                controller["run_id"] = run_id
            checkpoint()
        return result

    if recover_report:
        target = find_task(manifest, task_id)
        if target is None:
            raise ValueError("report recovery requires an existing task")
        if target.get("status") == "done" and (target.get("execution") or {}).get("outcome") in ("no_change", "researched"):
            return dict(result, reason="attempt_already_resolved")
        if not awaiting_report(target):
            raise ValueError("report recovery requires the same parked research attempt")
        if repair_after:
            execution = target["execution"]
            prior = execution.get("report_repair") or {}
            consumed = any(item.get("at") == repair_after for item in execution.get("report_repair_history", []))
            if not consumed and (prior.get("at") != repair_after
                                 or prior.get("status") not in ("invalid", "rejected", "expired", "failed")
                                 or parse_iso(repair_after) is None or now <= parse_iso(repair_after)):
                raise ValueError("repeat repair must identify a settled failed receipt by its exact at timestamp")
    # Explicit recovery must not reconcile or quarantine unrelated attempts.
    if not recover_report:
        reconcile(manifest, now=now)
    checkpoint()
    enabled = github.enabled()
    if not enabled and not recover_report:
        for task in manifest["tasks"]:
            if task.get("status") == "in_progress":
                quarantine(manifest, task["id"], reason="loop_disabled", now=now)
        checkpoint()

    def record_error(task, exc):
        task = find_task(manifest, task["id"])
        message = redact(str(exc), ring.keys)[:500]
        execution = task.setdefault("execution", {})
        if (execution.get("last_error") or {}).get("detail") != message:
            execution["last_error"] = {"at": iso(now), "detail": message}
        observation = dict(worker_observation(task, now), reason=message)
        result["observations"].append(observation)
        result["attention"].append(observation)
        checkpoint()

    def detach_waiting_research(task, state):
        # A reported question is not permission to implement or invent an answer.
        # Preserve the unresolved session on its own immutable ref; another scope
        # may proceed even if the worker never acknowledges this instruction.
        execution = task["execution"]
        if (task.get("task_type") != "project_discovery" or state not in WAITING_REASONS
                or awaiting_report(task) or not enabled or not github.enabled()):
            return
        detached = {"at": iso(now), "reason": state}
        if not valid_research_detachment(dict(task, execution=dict(execution, research_detached=detached))):
            return
        if not execution.get("research_detached"):
            execution["research_detached"] = detached
            checkpoint()
        if state != "AWAITING_USER_FEEDBACK" or execution.get("feedback_nudge"):
            return
        receipt = {"at": iso(now), "result": "pending"}
        execution["feedback_nudge"] = receipt
        checkpoint()  # No blind retry after a lost acknowledgement or process crash.
        if not github.enabled():
            return
        response = request_with_keys(
            transport, ring, "POST", api_base.rstrip("/") + "/"
            + session_resource(execution["session_id"]) + ":sendMessage",
            {"prompt": (
                "This session is read-only research, not implementation. Do not wait for an answer, "
                "approval or a choice of which proposal to implement. Finish this same session now "
                "with the observations already available, unresolved questions and environment "
                "limitations in AUTONOMOUS_RESEARCH_BEGIN/END. Include actionable proposals only "
                "in AUTONOMOUS_TASKS_BEGIN/END for later human review. Do not fabricate observations, "
                "change product files, create a PR or start further work. No permission is granted "
                "to execute any proposed change or privileged action."
            )}, max_attempts=1,
        )
        receipt["result"] = "sent" if response.status // 100 == 2 else "unknown" if response.status == 0 or response.status >= 500 else "rejected"
        checkpoint()

    def request_report_repair(task, source=None):
        execution = task["execution"]
        previous = execution.get("report_repair")
        repeat = (previous and repair_after == previous.get("at")
                  and previous.get("status") in ("invalid", "rejected", "expired", "failed"))
        if (previous and not repeat) or not enabled or not github.enabled():
            return
        receipt = {"at": iso(clock()), "result": "pending", "status": "pending"}
        if repeat:
            execution.setdefault("report_repair_history", []).append(copy.deepcopy(previous))
            receipt.update(actor=actor, after=repair_after)
        if source:
            receipt["source"] = source
        execution["report_repair"] = receipt
        checkpoint()  # Even a crash before POST consumes the sole send permission.
        if not github.enabled():
            receipt.update(status="rejected", detail="loop_disabled_before_report_repair")
            checkpoint()
            return
        response = request_with_keys(
            transport, KeyRing([ring.current]), "POST", api_base.rstrip("/") + "/"
            + session_resource(execution["session_id"]) + ":sendMessage",
            {"prompt": (
                "Repackage only the observations already obtained in this same research session. "
                "Do not investigate further, use tools, change files, create a PR, ask for approval "
                "or implement anything. Return exactly one AUTONOMOUS_RESEARCH_BEGIN / "
                "AUTONOMOUS_RESEARCH_END block containing a JSON object with summary (nonempty string), "
                "observations (nonempty array of objects with nonempty scenario, evidence and result strings), "
                "and next_hypotheses (array of strings). Preserve uncertainty and environment limitations; "
                "do not invent evidence. Return existing actionable proposals only in one "
                "AUTONOMOUS_TASKS_BEGIN / AUTONOMOUS_TASKS_END JSON array, using the original task schema "
                "and product scope; use [] if none. These are proposals for later human review, not authorization. "
                "This is a report-format repair request, not a new task or research attempt."
            )}, max_attempts=1,
        )
        receipt["result"] = "sent" if response.status // 100 == 2 else "unknown" if response.status == 0 or response.status >= 500 else "rejected"
        if receipt["result"] == "rejected":
            receipt.update(status="rejected", detail="report_repair_send_rejected_http_" + str(response.status))
        checkpoint()

    def collect_rejection(task, session, state, number):
        execution = task["execution"]
        decision = task["proposal_decision"]
        if number is not None:
            pr = github.proposal(number)
            branch = (pr.get("base") or {}).get("ref")
            if branch not in (LAB_BRANCH, execution.get("starting_branch")):
                raise ValueError("rejected worker PR has an unexpected target")
            if (state not in ("COMPLETED", "FAILED") or pr.get("state") != "closed"
                    or pr.get("merged") or pr.get("merged_at")):
                raise ValueError("rejected worker has a PR; inspect and close it before settling the rejection")
            staged = copy.deepcopy(task)
            single = {"tasks": [staged]}
            bind_proposal(single, task["id"], session, pr, repository=repository,
                          integration_branch=branch, now=now)
            complete(single, task["id"], outcome="closed_unmerged", pull_request=number,
                     note="owner rejected implementation; verified PR closed without merge", now=now)
            staged["proposal_decision"].update(status="completed", completed_at=iso(now))
            staged["execution"].pop("last_error", None)
            task.update(staged)
            checkpoint()
            return
        if execution.get("pull_request"):
            raise ValueError("rejected worker no longer reports its saved PR")
        if state in ("COMPLETED", "FAILED"):
            complete(manifest, task["id"], outcome="failed" if state == "FAILED" else "no_change",
                     note="owner rejected implementation; observed terminal worker " + state, now=now)
            task["status"] = "done"
            decision.update(status="completed", completed_at=iso(now))
            execution.pop("last_error", None)
        elif not execution.get("rejection_stop") and enabled and github.enabled():
            receipt = {"at": iso(clock()), "result": "pending"}
            execution["rejection_stop"] = receipt
            checkpoint()  # An uncertain send is not permission to send again.
            if github.enabled():
                response = request_with_keys(
                    transport, KeyRing([ring.current]), "POST", api_base.rstrip("/") + "/"
                    + session_resource(execution["session_id"]) + ":sendMessage",
                    {"prompt": (
                        "The repository owner has rejected this implementation. Stop work in this same session. "
                        "Do not investigate further, run tools, change files, create a PR, ask for approval "
                        "or implement anything. Finish the session with a factual summary of work already done "
                        "and any limitations. Preserve the existing session and its history. "
                        "This is withdrawal of authorization, not a new task or permission to retry."
                    )}, max_attempts=1,
                )
                receipt["result"] = ("sent" if response.status // 100 == 2 else "unknown"
                                     if response.status == 0 or response.status >= 500 else "rejected")
            else:
                receipt["result"] = "rejected"
        if pending_rejection(task):
            result["attention"].append({"task_id": task["id"], "reason": "rejection_awaiting_worker",
                                        "send_result": (execution.get("rejection_stop") or {}).get("result")})
        checkpoint()

    def collect(task, session):
        execution = task["execution"]
        bound_session(session, execution)
        parked = awaiting_report(task)
        repair = execution.get("report_repair")
        number = session_pull_request(session, execution, repository)
        state = session_state(session)
        if not recover_report:
            manifest.setdefault("controller", {})["last_poll_at"] = iso(clock())
        if execution.get("session_state") != state:
            execution["session_state"] = state
            execution["observed_at"] = iso(now)
        observation = worker_observation(task, now)
        result["observations"].append(observation)
        if state in WAITING_REASONS:
            result["waiting_workers"].append(observation)
        if pending_rejection(task):
            collect_rejection(task, session, state, number)
            return
        if number is not None:
            if parked:
                if repair and repair["status"] == "pending":
                    repair.update(status="conflict", detail="report_repair_session_has_pull_request")
                raise ValueError("report repair session has a pull request; manual provenance review required")
            pr = github.retarget(github.proposal(number), execution)
            if (not trusted_pull_request(task, pr, repository)
                    or (execution.get("provenance") or {}).get("head_sha") != pr["head"]["sha"]
                    or not session_is_active(session)):
                bind_proposal(manifest, task["id"], session, pr, repository=repository, now=now)
            sweep(manifest, [pr], config=config, now=now)
            result["proposals"].append({"task_id": task["id"], "number": number,
                                        "url": pr["html_url"], "state": pr["state"]})
        elif session_failed(session) and not (parked and recover_report):
            if parked:
                if repair and repair["status"] == "pending":
                    repair.update(status="failed", detail="report_repair_session_failed")
            else:
                complete(manifest, task["id"], outcome="failed", note="Jules reported a terminal failure", now=now)
        elif state == "COMPLETED" or (state == "FAILED" and parked and recover_report):
            quarantined = execution.get("state") == "quarantined"
            harvested = harvest(manifest, config, task["id"], session, transport=transport,
                                api_base=api_base, api_keys=ring, now=now,
                                retry_report=parked, reparse_report=parked and recover_report,
                                diagnostics=diagnostics)
            current = find_task(manifest, task["id"])
            if (awaiting_report(current) and not quarantined and state == "COMPLETED"
                    and harvested.get("report_error_code") != "report_identity_conflict"
                    and harvested.get("reason") != "report_source_unavailable"
                    and (not parked or recover_report)):
                request_report_repair(current, harvested.get("report_source")
                                      or (current["execution"].get("report_error") or {}).get("source"))
        current = find_task(manifest, task["id"])
        if not awaiting_report(current):
            current["execution"].pop("last_error", None)
        elif (current["execution"].get("report_repair") or {}).get("status") not in (None, "pending"):
            result["attention"].append({"task_id": task["id"], "reason": "report_repair_" + current["execution"]["report_repair"]["status"]})
        detach_waiting_research(find_task(manifest, task["id"]), state)
        checkpoint()

    # Only stored identities are queried. A foreign PR cannot occupy the worker.
    for identifier in [entry["id"] for entry in manifest["tasks"]]:
        if recover_report and identifier != task_id:
            continue
        task = find_task(manifest, identifier)
        execution = task.get("execution") or {}
        if awaiting_review(task):
            try:
                pr = github.proposal(execution["pull_request"])
                if not trusted_pull_request(task, pr, repository):
                    raise ValueError("proposal identity changed; manual inspection required")
                sweep(manifest, [pr], config=config, now=now)
                result["proposals"].append({"task_id": task["id"], "number": pr["number"],
                                            "url": pr["html_url"], "state": pr["state"]})
                checkpoint()
            except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
                record_error(task, exc)
            continue
        recovering = recover_report and task["id"] == task_id and awaiting_report(task)
        if pending_report_repair(task):
            repair = execution["report_repair"]
            if now >= parse_iso(repair["at"]) + timedelta(hours=6):
                repair.update(status="expired", detail="no valid repaired report within six hours; explicit inspection required")
                result["attention"].append({"task_id": task["id"], "reason": "report_repair_expired"})
                checkpoint()
        if not (task.get("status") == "in_progress" or execution.get("state") == "quarantined"
                or recovering or pending_report_repair(task)):
            continue
        try:
            if not ring:
                raise RuntimeError("no Jules API key is configured")
            if execution.get("session_id"):
                session = get_session(transport, api_base, ring, execution["session_id"])
            else:
                response = dispatch(transport, api_base=api_base, api_keys=ring,
                                    request_body=_request(task, repository, templates, focus=focus, risk=risk),
                                    allow_create=False)
                if response["result"] == "deferred":
                    result["attention"].append({"task_id": task["id"], "reason": "unbound_dispatch_intent"})
                    continue
                start(manifest, task["id"], session_id=response["session_id"],
                      dispatch_key=execution["dispatch_key"], now=now)
                checkpoint()
                session = get_session(transport, api_base, ring, response["session_id"])
            collect(task, session)
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
            record_error(task, exc)

    if recover_report:
        result.update(reason="report_recovery", action="reconciled")
        return finish()
    if not enabled or not github.enabled():
        result["reason"] = "loop_disabled"
        return finish()
    for task in manifest["tasks"]:
        execution = task.get("execution") or {}
        branch = execution.get("starting_branch")
        if (awaiting_report(task) or not branch or execution.get("session_state") not in ("COMPLETED", "FAILED")
                or execution.get("released_attempt_ref") == branch):
            continue
        try:
            outcome = github.release_attempt(repo, execution)
            result.setdefault("attempt_refs", []).append({"task_id": task["id"], "branch": branch, "outcome": outcome})
            if outcome in ("removed", "absent"):
                execution["released_attempt_ref"] = branch
                checkpoint()
            elif outcome == "ref_moved":
                result["attention"].append({"task_id": task["id"], "reason": "attempt_ref_moved"})
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
            record_error(task, exc)
    selection = select(manifest, task_id=task_id or None, focus=focus.split(",") if focus else [],
                       risk_ceiling=risk, allow_discovery=bool(config.get("research", {}).get("enabled")))
    if selection["reason_code"] == "work_in_progress":
        result["reason"] = next((entry["reason"] for entry in result["attention"] + result["waiting_workers"]
                                 if entry.get("task_id") == selection["task_id"]), "worker_running")
        return finish()
    if task_id and not selection["selected"]:
        result["reason"] = selection["reason_code"]
        return finish()
    lab_sha = _git(repo, "rev-parse", "HEAD").stdout.decode().strip()
    main_sha = github.head("main")
    if not main_sha or github.head(LAB_BRANCH) != lab_sha:
        result["reason"] = "product_moved"
        return finish()
    _git(repo, "fetch", "--no-tags", "origin", main_sha)
    ancestry = _git(repo, "merge-base", "--is-ancestor", main_sha, lab_sha, check=False).returncode
    if ancestry not in (0, 1):
        raise RuntimeError("product ancestry check failed")
    result.update(main_sha=main_sha, lab_sha=lab_sha)
    if ancestry:
        result.update(action="sync", reason="main_not_integrated")
        return finish()
    updated, research = plan_research(
        manifest, config, scope_fingerprints(config, repo) if (config.get("research", {}).get("enabled")
                                                             and not selection["selected"] and not task_id) else {},
        now=now, focus=focus.split(",") if focus else [], risk_ceiling=risk, task_id=task_id or None,
    )
    if updated is not manifest:
        manifest.clear()
        manifest.update(updated)
    result["research"] = research
    checkpoint()
    selection = select(manifest, task_id=task_id or None, focus=focus.split(",") if focus else [],
                       risk_ceiling=risk, allow_discovery=bool(config.get("research", {}).get("enabled")))
    if not selection["selected"]:
        result["reason"] = selection["reason_code"]
        return finish()
    if not ring:
        raise RuntimeError("no Jules API key is configured")
    task = next(t for t in manifest["tasks"] if t["id"] == selection["task_id"])
    if task.get("task_type") != "project_discovery":
        decision = task.get("proposal_decision") or {}
        try:
            authorize(config, decision.get("actor", ""))
        except ValueError:
            result["reason"] = "implementation_not_approved"
            return finish()
    key = dispatch_key(repository, task["id"], next_attempt(task))
    starting_branch = "autonomous/attempt-" + key
    if not github.enabled() or github.head("main") != main_sha or github.head(LAB_BRANCH) != lab_sha:
        result["reason"] = "dispatch_conditions_changed"
        return finish()
    github.ensure_attempt(starting_branch, lab_sha)
    request = build(task, template=(templates / ("JULES_PROJECT_DISCOVERY_PROMPT.md" if task.get("task_type") == "project_discovery" else "JULES_TASK_PROMPT.md")).read_text(encoding="utf-8"),
                    repo=repository, branch=LAB_BRANCH, base_sha=lab_sha, starting_branch=starting_branch,
                    focus=focus, risk_ceiling=risk)
    reserve(manifest, task["id"], key, base_sha=lab_sha, starting_branch=starting_branch, now=now)
    checkpoint()  # No external session exists before the reservation is durable.
    if not github.enabled():
        quarantine(manifest, task["id"], reason="loop_disabled_before_create", now=now)
        checkpoint()
        result["reason"] = "loop_disabled"
        return finish()

    def create_transport(method, url, headers, payload):
        # ListSessions may paginate or back off after the earlier switch read.
        if method == "POST":
            reason = "loop_disabled_before_create" if not github.enabled() else ""
            if not reason and (github.head("main") != main_sha or github.head(LAB_BRANCH) != lab_sha):
                reason = "product_moved_before_create"
            if reason:
                quarantine(manifest, task["id"], reason=reason, now=now)
                checkpoint()
                raise RuntimeError(reason)
        return transport(method, url, headers, payload)

    try:
        response = dispatch(create_transport, api_base=api_base, api_keys=ring, request_body=request, allow_create=True)
        if response["result"] == "deferred":
            result.update(action="reconcile", reason=response.get("reason", "unbound_dispatch_intent"))
            return finish()
        start(manifest, task["id"], session_id=response["session_id"], dispatch_key=key, now=now)
        checkpoint()
        if not github.enabled():
            quarantine(manifest, task["id"], reason="loop_disabled_during_create", now=now)
            checkpoint()
        collect(task, get_session(transport, api_base, ring, response["session_id"]))
        reason = WAITING_REASONS.get(find_task(manifest, task["id"])["execution"].get("session_state"), response["result"])
        result.update(action="dispatched", reason=reason, task_id=task["id"])
    except CreateRejected as exc:
        complete(manifest, task["id"], outcome="failed", note=str(exc), now=now)
        record_error(task, exc)
        result.update(action="rejected", reason="create_rejected", http_status=exc.status)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        record_error(task, exc)
        result.update(action="reconcile", reason="dispatch_requires_reconciliation")
    return finish()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--revision-file", type=Path, required=True)
    parser.add_argument("--task-id", default="")
    parser.add_argument("--focus", default="")
    parser.add_argument("--risk-ceiling", default="medium")
    parser.add_argument("--recover-report", action="store_true")
    parser.add_argument("--repair-after", default="", help="Exact failed report_repair.at authorizing one new format-only message")
    parser.add_argument("--actor", default=os.environ.get("GITHUB_ACTOR", ""))
    parser.add_argument("--automatic", action="store_true")
    parser.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID", ""))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--quarantine-all", action="store_true")
    args = parser.parse_args(argv)
    config = {}
    loaded = False
    api_keys = [os.environ.get("JULES_API_KEY", ""), os.environ.get("JULES_API_KEY_BACKUP", "")]

    def persist(data):
        errors = validate(data)
        if errors:
            raise ValueError("invalid transition: " + "; ".join(errors))
        content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        # First migration preserves original bytes even if no semantic change.
        if json.loads(args.manifest.read_bytes()) != data:
            atomic_write(args.manifest, content)
        return save_state(args.repo, args.manifest, args.revision_file)

    try:
        if args.automatic and (args.task_id or args.focus or args.recover_report or args.repair_after or args.quarantine_all):
            raise ValueError("automatic ticks cannot select, recover or quarantine a task")
        if args.run_id and not re.fullmatch(r"[1-9][0-9]*", args.run_id):
            raise ValueError("invalid workflow run id")
        if "GITHUB_ACTOR" in os.environ and args.actor.casefold() != os.environ["GITHUB_ACTOR"].casefold():
            raise ValueError("--actor must match GITHUB_ACTOR")
        config = json.loads(args.config.read_text(encoding="utf-8"))
        manifest = load_state(args.repo, args.manifest, args.revision_file)
        loaded = True
        if args.quarantine_all:
            for task in manifest["tasks"]:
                if task.get("status") == "in_progress":
                    quarantine(manifest, task["id"], reason="owner_disabled_loop")
            persist(manifest)
            result = {"reason": "loop_disabled", "merge_mode": "manual"}
        else:
            if args.recover_report and not args.task_id:
                raise ValueError("report recovery requires a task id")
            result = tick(manifest, config, repo=args.repo,
                          templates=args.config.parent / "docs" / "autonomous",
                          github=GitHub(config["repository"]), persist=persist,
                          api_keys=api_keys, task_id=args.task_id, focus=args.focus, risk=args.risk_ceiling,
                          recover_report=args.recover_report, diagnostics=args.out.with_name("research-diagnostics.json"),
                          automatic=args.automatic, run_id=args.run_id, repair_after=args.repair_after, actor=args.actor)
    except (StateWriteError, ValueError, RuntimeError, OSError, KeyError, subprocess.SubprocessError) as exc:
        result = {"action": "stopped", "merge_mode": "manual",
                  "reason": "state_write_failed" if isinstance(exc, StateWriteError) else "controller_error",
                  "attention": [{"reason": redact(str(exc), api_keys + [os.environ.get("GH_TOKEN", "")])[:500]}]}
    result["state_sha"] = json.loads(args.revision_file.read_bytes())["state_sha"] if loaded else ""
    atomic_write(args.out, json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write("### Laboratory: proposals require your decision\n\n")
            if result["state_sha"]:
                handle.write("Last confirmed queue revision: [state snapshot](https://github.com/" + config["repository"]
                             + "/blob/" + result["state_sha"] + "/agent_tasks.json).\n\n")
            else:
                handle.write("No durable state revision was confirmed.\n\n")
            handle.write("```json\n" + json.dumps(result, ensure_ascii=True, indent=2) + "\n```\n")
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result.get("attention") else 0


if __name__ == "__main__":
    raise SystemExit(main())
