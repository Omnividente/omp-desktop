#!/usr/bin/env python3
"""Decide whether an autonomous pull request may land on the integration branch.

Exit codes:
  0  -> merge it
  10 -> skip it (not ours, draft, held, wrong base, head moved under us, ...)
  20 -> refuse it: the diff leaves the allowed product scope
  30 -> hand it to a human: the fix is unproven or touches a manual-review path

Two invariants matter more than anything else here.

**One revision.** The caller passes ``--ci-sha``: the exact commit whose Quality
Gate run triggered this decision, plus the file list computed for that same
commit. If the pull request head has moved since, the decision is `skip`. The
caller then merges with ``--match-head-commit <ci-sha>`` so GitHub itself
refuses the merge should the branch move in between. CI-verified, scope-checked
and merged revision are therefore the same SHA by construction, not by luck.

**No unproven fix.** "The regression test fails before the fix" is a claim the
worker cannot be trusted to self-certify, so it is not read from the pull
request description. ``--evidence-state`` carries the result of the Autonomous
Evidence Gate check run for that same SHA. Anything other than a proven pass
(or an explicit owner approval label) routes the pull request to manual review.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_change_scope import evaluate, manual_review_hits  # noqa: E402

EXIT_MERGE = 0
EXIT_SKIP = 10
EXIT_SCOPE_VIOLATION = 20
EXIT_MANUAL_REVIEW = 30

EVIDENCE_PASSED = "passed"
EVIDENCE_NOT_REQUIRED = "not_required"
EVIDENCE_FAILED = "failed"
EVIDENCE_MISSING = "missing"
EVIDENCE_STATES = (
    EVIDENCE_PASSED, EVIDENCE_NOT_REQUIRED, EVIDENCE_FAILED, EVIDENCE_MISSING,
)
ACCEPTED_EVIDENCE = (EVIDENCE_PASSED, EVIDENCE_NOT_REQUIRED)


def normalize_author(value: Any) -> str:
    text = str(value or "").strip().lower()
    for prefix in ("app/", "bot/"):
        if text.startswith(prefix):
            text = text[len(prefix):]
    if text.endswith("[bot]"):
        text = text[: -len("[bot]")]
    return text


def _labels(pull_request: Mapping[str, Any]) -> set:
    return {
        str((label or {}).get("name") or "").lower()
        for label in pull_request.get("labels") or []
    }


def decide(
    pull_request: Mapping[str, Any],
    config: Mapping[str, Any],
    integration_branch: str = "autonomous/lab",
    *,
    ci_sha: str = "",
    changed_files: Sequence[str] | None = None,
    evidence_state: str = EVIDENCE_MISSING,
) -> dict:
    automation = config.get("automation") or {}
    gate = config.get("merge_gate") or {}
    allowed_authors = {normalize_author(a) for a in automation.get("allowed_pr_authors") or []}
    blocking_labels = {str(name).lower() for name in automation.get("blocking_labels") or []}
    approval_labels = {str(name).lower() for name in gate.get("manual_approval_labels") or []}
    require_evidence = gate.get("require_regression_test") is not False

    reasons = []
    review_reasons = []

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

    labels = _labels(pull_request)
    blocking = sorted(labels & blocking_labels)
    if blocking:
        reasons.append("blocking label(s): " + ", ".join(blocking))

    # The revision CI verified must still be the revision we are about to merge.
    head_oid = str(pull_request.get("headRefOid") or "")
    verified_sha = str(ci_sha or "")
    if not verified_sha:
        reasons.append("no CI-verified revision was supplied; refusing to merge blind")
    elif head_oid and head_oid != verified_sha:
        reasons.append(
            "head moved since CI: verified " + verified_sha[:12]
            + " but the pull request now points at " + head_oid[:12]
        )

    if changed_files is None:
        changed = [
            str((entry or {}).get("path") or "")
            for entry in pull_request.get("files") or []
        ]
        files_are_sha_bound = False
    else:
        changed = [str(path) for path in changed_files]
        files_are_sha_bound = True
    changed = [path.strip() for path in changed if path.strip()]
    if not changed:
        reasons.append("pull request has no changed files")
    if not files_are_sha_bound:
        review_reasons.append(
            "the changed-file list was not pinned to the CI-verified revision"
        )

    scope = evaluate(config, changed)
    needs_human = manual_review_hits(config, changed)
    if needs_human:
        review_reasons.append(
            "touches manual-review path(s): " + ", ".join(sorted(needs_human))
        )

    normalized_evidence = str(evidence_state or EVIDENCE_MISSING).strip().lower()
    if normalized_evidence not in EVIDENCE_STATES:
        normalized_evidence = EVIDENCE_MISSING
    if require_evidence and normalized_evidence not in ACCEPTED_EVIDENCE:
        review_reasons.append(
            "the fix is unproven: evidence gate is " + normalized_evidence
            + " for " + (verified_sha[:12] or "an unknown revision")
        )

    approvals = sorted(labels & approval_labels)
    if approvals and review_reasons:
        review_reasons = []

    if reasons:
        decision = "skip"
    elif not scope["allowed"]:
        decision = "scope_violation"
    elif review_reasons:
        decision = "manual_review"
    else:
        decision = "merge"

    return {
        "decision": decision,
        "reasons": reasons,
        "review_reasons": review_reasons,
        "approved_by": approvals,
        "ci_sha": verified_sha,
        "head_sha": head_oid,
        "evidence_state": normalized_evidence,
        "changed_files": changed,
        "violations": scope["violations"],
        "manual_review_paths": sorted(needs_human),
    }


EXIT_CODES = {
    "merge": EXIT_MERGE,
    "skip": EXIT_SKIP,
    "scope_violation": EXIT_SCOPE_VIOLATION,
    "manual_review": EXIT_MANUAL_REVIEW,
}


def _read_lines(path: Path) -> list:
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pr-json", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--integration-branch", default="autonomous/lab")
    parser.add_argument("--ci-sha", default="",
                        help="the commit whose Quality Gate run triggered this decision")
    parser.add_argument("--changed-files", type=Path,
                        help="file list computed for --ci-sha (newline-delimited)")
    parser.add_argument("--evidence-state", default=EVIDENCE_MISSING, choices=list(EVIDENCE_STATES))
    parser.add_argument("--changed-files-out", type=Path)
    parser.add_argument("--decision-out", type=Path)
    args = parser.parse_args(argv)

    pull_request = json.loads(args.pr_json.read_text(encoding="utf-8"))
    config = json.loads(args.config.read_text(encoding="utf-8"))
    changed_files = None
    if args.changed_files and args.changed_files.exists():
        changed_files = _read_lines(args.changed_files)

    result = decide(
        pull_request, config, args.integration_branch,
        ci_sha=args.ci_sha, changed_files=changed_files,
        evidence_state=args.evidence_state,
    )

    if args.changed_files_out:
        args.changed_files_out.write_text(
            "\n".join(result["changed_files"]) + "\n", encoding="utf-8"
        )
    if args.decision_out:
        args.decision_out.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    print(json.dumps(result, ensure_ascii=False, indent=2))
    for reason in result["reasons"]:
        print("skip reason: " + reason, file=sys.stderr)
    for reason in result["review_reasons"]:
        print("manual review: " + reason, file=sys.stderr)
    for violation in result["violations"]:
        print(
            "out of scope: " + violation["path"] + " (" + violation["reason"] + ")",
            file=sys.stderr,
        )
    return EXIT_CODES[result["decision"]]


if __name__ == "__main__":
    raise SystemExit(main())
