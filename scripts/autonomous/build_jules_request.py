#!/usr/bin/env python3
"""Build a Jules CreateSession request body for the selected autonomous task.

The prompt is rendered from a template in docs/autonomous and carries an
idempotency marker that jules_dispatch.py uses to reconcile sessions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any, Mapping


def dispatch_key(repo: str, task_id: str, base_sha: str) -> str:
    material = "\n".join((str(repo), str(task_id), str(base_sha)))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]


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
) -> dict:
    task_id = str(task.get("id") or "")
    key = dispatch_key(repo, task_id, base_sha)
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
    print("wrote Jules request for task " + args.task_id + " (startingBranch " + args.branch + ")")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
