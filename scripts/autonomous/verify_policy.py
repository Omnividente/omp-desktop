#!/usr/bin/env python3
"""Fail fast unless the project policy still forbids automated releases.

Every loop workflow runs this first, reading the config from the default branch.
If someone (human or AI) ever relaxes the no-release policy, points the loop at
the default branch, removes a guardrail exclusion, drops the auto-update surface
out of manual review, or turns off the fix-evidence requirement, the loop stops
instead of shipping something nobody approved.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping

# Paths the loop may never touch at all.
REQUIRED_EXCLUSIONS = (
    ".git/",
    ".github/workflows/**",
    ".github/scripts/**",
    ".github/release-notes/**",
    ".github/release-tag-exceptions.json",
    "scripts/autonomous/**",
    "docs/autonomous/**",
    "package.json",
    "package-lock.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.updater-e2e.conf.json",
    "src-tauri/src/secrets.rs",
    "autonomous-project.json",
    "agent_tasks.json",
)

# Auto-update surface. These are ordinary product code, so the loop is allowed
# to propose fixes, but a broken updater cannot be repaired remotely: it must
# never be merged without a human explicitly accepting it.
#
# The list has to be the *whole* surface. Guarding two of ten files means the
# other eight can be dropped out of manual review without this check noticing,
# which is precisely the hole a policy verifier exists to close.
REQUIRED_MANUAL_REVIEW = (
    "src/clientUpdater.ts",
    "src/useClientUpdater.ts",
    "src/useClientUpdater.test.tsx",
    "src/ClientUpdateNotice.tsx",
    "src/UpdateNotice.tsx",
    "src/UpdateNotices.test.tsx",
    "src/updateReminder.ts",
    "src/updateReminder.test.ts",
    "src-tauri/src/update.rs",
    "src-tauri/tests/update.rs",
    "src-tauri/src/updater*",
    "src-tauri/tests/updater*",
)


def verify(config: Mapping[str, Any], integration_branch: str = "autonomous/lab") -> list:
    problems = []
    release = config.get("release_policy") or {}
    parallel = config.get("parallel_mode") or {}
    product = config.get("product") or {}
    gate = config.get("merge_gate") or {}
    automation = config.get("automation") or {}
    if automation.get("merge_mode") != "manual":
        problems.append("automation.merge_mode must be 'manual'")
    if automation.get("state_branch") != "autonomous/state":
        problems.append("automation.state_branch must be 'autonomous/state'")
    if "allowed_pr_authors" in automation:
        problems.append("automation.allowed_pr_authors is obsolete; persisted session provenance is required")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", str(config.get("repository") or "")):
        problems.append("repository must identify the GitHub owner/repository")

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
    if parallel.get("merge_target") != integration_branch:
        problems.append("parallel_mode.merge_target must be " + repr(integration_branch))
    if parallel.get("integration_branch") == config.get("default_branch"):
        problems.append("the integration branch must differ from the default branch")

    excluded = [str(item) for item in product.get("excluded") or []]
    for pattern in REQUIRED_EXCLUSIONS:
        if pattern not in excluded:
            problems.append("product.excluded must contain " + repr(pattern))

    manual = [str(item) for item in product.get("manual_review_paths") or []]
    for pattern in REQUIRED_MANUAL_REVIEW:
        if pattern not in manual and pattern not in excluded:
            problems.append(
                "product.manual_review_paths must contain " + repr(pattern)
                + " (the auto-update surface is never merged unattended)"
            )

    editable = [str(item) for item in product.get("editable_globs") or []]
    if not editable:
        problems.append("product.editable_globs must not be empty")
    for glob in editable:
        if glob.startswith(".github") or glob in ("**", "*", "/"):
            problems.append("product.editable_globs must not include " + repr(glob))

    # Before/after evidence is reported independently from human acceptance.
    # It must not silently disappear from a proposal's risk assessment.
    if gate.get("require_regression_test") is not True:
        problems.append("merge_gate.require_regression_test must be true")
    if not [str(name) for name in gate.get("manual_approval_labels") or []]:
        problems.append("merge_gate.manual_approval_labels must list at least one label")
    if not [str(glob) for glob in gate.get("test_globs") or []]:
        problems.append("merge_gate.test_globs must not be empty")
    if gate.get("evidence_check_name") != "Autonomous Evidence Gate":
        problems.append(
            "merge_gate.evidence_check_name must be 'Autonomous Evidence Gate'"
        )

    # These are check-run names, not the containing workflow name. Additional
    # required checks may tighten policy, but neither platform may be dropped.
    required_checks = gate.get("required_check_names")
    for name in ("Checks (ubuntu-latest)", "Checks (windows-latest)"):
        if not isinstance(required_checks, list) or name not in required_checks:
            problems.append("merge_gate.required_check_names must contain " + repr(name))
    # An approval is only meaningful if it can be attributed to a person: a label
    # survives a force-push, a review approval of a specific commit does not.
    if not [str(name) for name in gate.get("owner_approvers") or [] if str(name).strip()]:
        problems.append(
            "merge_gate.owner_approvers must list the logins whose review approval "
            "can release a manual-review pull request"
        )
    try:
        max_files = int(gate.get("max_changed_files", 0))
    except (TypeError, ValueError):
        max_files = 0
    if max_files < 1:
        problems.append(
            "merge_gate.max_changed_files must be a positive number so an unreadably "
            "large diff cannot be merged unattended"
        )
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
    print(
        "policy OK: acceptance manual, release automation disabled, fix evidence required, integration branch "
        + args.integration_branch
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
