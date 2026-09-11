#!/usr/bin/env python3
"""Decide whether an autonomous pull request may land on the integration branch.

Consumes the JSON produced by `gh pr view --json ...` and returns:
  exit 0  -> merge it
  exit 10 -> skip it (not ours, draft, held, wrong base, ...)
  exit 20 -> refuse it: the diff leaves the allowed product scope

The loop may only ever merge into the integration branch. A pull request based
on the default branch is always skipped, so the loop can never release.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_change_scope import evaluate  # noqa: E402

EXIT_MERGE = 0
EXIT_SKIP = 10
EXIT_SCOPE_VIOLATION = 20


def normalize_author(value: Any) -> str:
    text = str(value or "").strip().lower()
    for prefix in ("app/", "bot/"):
        if text.startswith(prefix):
            text = text[len(prefix):]
    if text.endswith("[bot]"):
        text = text[: -len("[bot]")]
    return text


def decide(
    pull_request: Mapping[str, Any],
    config: Mapping[str, Any],
    integration_branch: str = "autonomous/lab",
) -> dict:
    automation = config.get("automation") or {}
    allowed_authors = {normalize_author(a) for a in automation.get("allowed_pr_authors") or []}
    blocking_labels = {str(name).lower() for name in automation.get("blocking_labels") or []}

    reasons = []
    base = str(pull_request.get("baseRefName") or "")
    if base != integration_branch:
        reasons.append(
            "base branch is " + repr(base) + "; the loop may only merge into "
            + repr(integration_branch)
        )
    state = str(pull_request.get("state") or "OPEN").upper()
    if state != "OPEN":
        reasons.append("pull request state is " + state)
    if pull_request.get("isDraft"):
        reasons.append("pull request is a draft")

    author = normalize_author((pull_request.get("author") or {}).get("login"))
    if allowed_authors and author not in allowed_authors:
        reasons.append("author " + repr(author) + " is not an allowed autonomous worker")

    labels = {
        str((label or {}).get("name") or "").lower()
        for label in pull_request.get("labels") or []
    }
    blocking = sorted(labels & blocking_labels)
    if blocking:
        reasons.append("blocking label(s): " + ", ".join(blocking))

    changed = [
        str((entry or {}).get("path") or "")
        for entry in pull_request.get("files") or []
    ]
    changed = [path for path in changed if path]
    if not changed:
        reasons.append("pull request has no changed files")

    scope = evaluate(config, changed)
    if reasons:
        decision = "skip"
    elif not scope["allowed"]:
        decision = "scope_violation"
    else:
        decision = "merge"
    return {
        "decision": decision,
        "reasons": reasons,
        "changed_files": changed,
        "violations": scope["violations"],
    }


EXIT_CODES = {"merge": EXIT_MERGE, "skip": EXIT_SKIP, "scope_violation": EXIT_SCOPE_VIOLATION}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pr-json", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--integration-branch", default="autonomous/lab")
    parser.add_argument("--changed-files-out", type=Path)
    args = parser.parse_args(argv)

    pull_request = json.loads(args.pr_json.read_text(encoding="utf-8"))
    config = json.loads(args.config.read_text(encoding="utf-8"))
    result = decide(pull_request, config, args.integration_branch)

    if args.changed_files_out:
        args.changed_files_out.write_text(
            "\n".join(result["changed_files"]) + "\n", encoding="utf-8"
        )

    print(json.dumps(result, ensure_ascii=False, indent=2))
    for reason in result["reasons"]:
        print("skip reason: " + reason, file=sys.stderr)
    for violation in result["violations"]:
        print(
            "out of scope: " + violation["path"] + " (" + violation["reason"] + ")",
            file=sys.stderr,
        )
    return EXIT_CODES[result["decision"]]


if __name__ == "__main__":
    raise SystemExit(main())
