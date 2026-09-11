#!/usr/bin/env python3
"""Fail fast unless the project policy still forbids automated releases.

Every loop workflow runs this first. If someone (human or AI) ever relaxes the
no-release policy or points the loop at the default branch, the loop stops
instead of shipping something nobody approved.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping

REQUIRED_EXCLUSIONS = (
    ".github/workflows/**",
    "package.json",
    "package-lock.json",
    "src-tauri/Cargo.toml",
    "src-tauri/tauri.conf.json",
    "autonomous-project.json",
    "agent_tasks.json",
)


def verify(config: Mapping[str, Any], integration_branch: str = "autonomous/lab") -> list:
    problems = []
    release = config.get("release_policy") or {}
    parallel = config.get("parallel_mode") or {}
    product = config.get("product") or {}

    if release.get("automation") != "disabled":
        problems.append("release_policy.automation must be 'disabled'")
    if release.get("human_gated") is not True:
        problems.append("release_policy.human_gated must be true")
    if parallel.get("enabled") is not True:
        problems.append("parallel_mode.enabled must be true")
    if parallel.get("never_merge_to_default") is not True:
        problems.append("parallel_mode.never_merge_to_default must be true")
    if parallel.get("integration_branch") != integration_branch:
        problems.append(
            "parallel_mode.integration_branch must be " + repr(integration_branch)
        )
    if parallel.get("integration_branch") == config.get("default_branch"):
        problems.append("the integration branch must differ from the default branch")

    excluded = [str(item) for item in product.get("excluded") or []]
    for pattern in REQUIRED_EXCLUSIONS:
        if pattern not in excluded:
            problems.append("product.excluded must contain " + repr(pattern))

    editable = [str(item) for item in product.get("editable_globs") or []]
    if not editable:
        problems.append("product.editable_globs must not be empty")
    for glob in editable:
        if glob.startswith(".github") or glob in ("**", "*", "/"):
            problems.append("product.editable_globs must not include " + repr(glob))
    return problems


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--integration-branch", default="autonomous/lab")
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print("::error::cannot read project config: " + str(exc), file=sys.stderr)
        return 1
    problems = verify(config, args.integration_branch)
    for problem in problems:
        print("::error::" + problem, file=sys.stderr)
    if problems:
        return 1
    print("policy OK: release automation disabled, integration branch " + args.integration_branch)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
