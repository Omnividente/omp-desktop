#!/usr/bin/env python3
"""Refresh only controller-verified proposal heads; never merge or force-push."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from jules_provenance import trusted_pull_request
from validate_tasks import validate


def github_request(method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    token = os.environ.get("GH_TOKEN", "")
    if not token:
        raise ValueError("missing authentication")
    request = Request("https://api.github.com" + path, method=method,
                      data=json.dumps(payload).encode() if payload is not None else None,
                      headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                               "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, {}


def refresh(manifest: dict, repository: str, lab_sha: str, *, request=github_request) -> dict:
    if validate(manifest) or not re.fullmatch(r"[^/\s]+/[^/\s]+", repository) or not re.fullmatch(r"[0-9a-f]{40}", lab_sha):
        raise ValueError("invalid refresh input")
    result = {"code_sha": lab_sha, "outcome": "ok", "proposals": []}
    seen = set()
    for task in manifest["tasks"]:
        execution = task.get("execution") or {}
        provenance = execution.get("provenance") or {}
        number = provenance.get("pull_request")
        if task.get("status") == "done" or not isinstance(number, int) or number <= 0 or number in seen:
            continue
        seen.add(number)
        entry = {"pull_request": number, "task_id": task["id"]}
        result["proposals"].append(entry)
        status, pr = request("GET", f"/repos/{repository}/pulls/{number}")
        if status != 200:
            entry["outcome"] = "api_error"
            result["outcome"] = "attention"
            continue
        if not trusted_pull_request(task, pr, repository, "autonomous/lab"):
            entry["outcome"] = "untrusted_skipped"
            continue
        if pr.get("state") != "open":
            entry["outcome"] = "closed"
            continue
        head = pr["head"]["sha"]
        entry["head_sha"] = head
        if not re.fullmatch(r"[0-9a-f]{40}", head):
            entry["outcome"] = "invalid_head"
            result["outcome"] = "attention"
            continue
        # GitHub compare status is relative to the base, not workflow greenness.
        # REST pr.base.sha may be historical; only the caller's live branch pin
        # identifies the lab revision that this proposal must contain.
        status, comparison = request("GET", f"/repos/{repository}/compare/{lab_sha}...{head}")
        if status != 200 or comparison.get("status") not in {"ahead", "identical", "behind", "diverged"}:
            entry["outcome"] = "api_error"
            result["outcome"] = "attention"
            continue
        if comparison["status"] in {"ahead", "identical"}:
            entry["outcome"] = "current"
            continue
        status, _ = request("PUT", f"/repos/{repository}/pulls/{number}/update-branch", {"expected_head_sha": head})
        entry["outcome"] = "refresh_requested" if status == 202 else "refresh_conflict" if status in {405, 409, 422} else "api_error"
        if status == 202:
            # The asynchronous new head must receive fresh PR checks; no previous
            # SHA's result is carried forward or represented as verified here.
            entry["checks"] = "new_head_required"
        else:
            result["outcome"] = "attention"
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--lab-sha", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = refresh(json.loads(args.manifest.read_text(encoding="utf-8")), args.repository, args.lab_sha)
    except (OSError, ValueError, TypeError, KeyError):
        result = {"outcome": "attention", "reason": "refresh_input_or_api_error", "proposals": []}
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return 0 if result["outcome"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
