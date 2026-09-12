#!/usr/bin/env python3
"""Build an AI worker CreateSession request body for the selected task.

The prompt is rendered from a template in docs/autonomous and carries two
markers:

* ``AUTONOMOUS_DISPATCH_KEY`` - the idempotency key jules_dispatch.py uses to
  recognise a session it already started. It is derived from repository, task id
  and **attempt number**. Folding the branch head into it would change the key on
  every new commit and duplicate work that is still running; leaving the attempt
  out is just as bad in the other direction - a retry would keep matching the
  previous, already finished session and never actually run again.
* ``AUTONOMOUS_TASK_ID`` - lets task_lifecycle.py map the resulting pull request
  back to the queue entry and close it out.

The base commit still travels in the prompt as context for the worker; it just
no longer influences identity.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any, Mapping


def dispatch_key(repo: str, task_id: str, attempt: int = 1) -> str:
    try:
        number = int(attempt)
    except (TypeError, ValueError):
        number = 1
    number = max(1, number)
    material = "\n".join((str(repo), str(task_id), "attempt=" + str(number)))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]


def next_attempt(task: Mapping[str, Any]) -> int:
    """Keep an active attempt stable; only a queued retry gets a new identity."""
    block = task.get("execution") or {}
    try:
        attempts = int(block.get("attempts") or 0)
    except (TypeError, ValueError):
        attempts = 0
    if str(task.get("status") or "") == "in_progress":
        return max(1, attempts)
    return max(0, attempts) + 1


def render_prompt(template: str, replacements: Mapping[str, str]) -> str:
    prompt = template
    for name, value in replacements.items():
        prompt = prompt.replace("{{" + name + "}}", str(value))
    return prompt


def build(
    task: Mapping[str, Any],
    *,
    template: str,
    repo: str,
    branch: str,
    base_sha: str,
    focus: str = "",
    risk_ceiling: str = "medium",
    attempt: int | None = None,
) -> dict:
    task_id = str(task.get("id") or "")
    number = next_attempt(task) if attempt is None else attempt
    key = dispatch_key(repo, task_id, number)
    replacements = {
        "PROJECT_REPO": repo,
        "INTEGRATION_BRANCH": branch,
        "BASE_COMMIT": base_sha,
        "FOCUS": focus,
        "RISK_CEILING": risk_ceiling,
        "TASK_ID": task_id,
        "TASK_TITLE": str(task.get("title") or ""),
        "TASK_TYPE": str(task.get("task_type") or ""),
        "TASK_JSON": json.dumps(task, ensure_ascii=False, indent=2),
        "ATTEMPT": str(number),
    }
    marker = "AUTONOMOUS_DISPATCH_KEY: " + key + "\nAUTONOMOUS_TASK_ID: " + task_id + "\n\n"
    prompt = marker + render_prompt(template, replacements)
    title = "[dispatch:" + key + "] " + (str(task.get("title") or task_id))
    return {
        "prompt": prompt,
        "sourceContext": {
            "source": "sources/github/" + repo,
            "githubRepoContext": {"startingBranch": branch},
        },
        "automationMode": "AUTO_CREATE_PR",
        "requirePlanApproval": False,
        "title": title[:200],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--base-sha", default="")
    parser.add_argument("--focus", default="")
    parser.add_argument("--risk-ceiling", default="medium")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--github-output", default="")
    args = parser.parse_args(argv)

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    task = next(
        (t for t in manifest.get("tasks", []) if str(t.get("id")) == args.task_id), None
    )
    if task is None:
        raise SystemExit("task " + repr(args.task_id) + " not found in manifest")

    base_sha = args.base_sha
    if not base_sha:
        try:
            base_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        except Exception:
            base_sha = ""

    body = build(
        task,
        template=args.template.read_text(encoding="utf-8"),
        repo=args.repo,
        branch=args.branch,
        base_sha=base_sha,
        focus=args.focus,
        risk_ceiling=args.risk_ceiling,
    )
    args.out.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    attempt = next_attempt(task)
    key = dispatch_key(args.repo, args.task_id, attempt)
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            handle.write("dispatch_key=" + key + "\n")
            handle.write("dispatch_attempt=" + str(attempt) + "\n")
    print(
        "wrote request for task " + args.task_id + " (startingBranch " + args.branch
        + ", attempt " + str(attempt) + ", dispatch key " + key + ")"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
