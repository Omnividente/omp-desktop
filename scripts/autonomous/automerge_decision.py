#!/usr/bin/env python3
"""Decide whether an autonomous pull request may land on the integration branch.

Exit codes:
  0  -> merge it
  10 -> skip it (not ours, draft, held, wrong base, head moved, a gate is still running)
  20 -> refuse it: the diff leaves the allowed product scope
  30 -> hand it to a human: unproven fix, unverifiable diff, or a manual-review path

Four invariants, each of which was a real way to merge something nobody checked.

**One revision.** ``--ci-sha`` is the commit whose gates produced the results
below. If the pull request head has moved since, the answer is skip, and the
caller merges with ``--match-head-commit <ci-sha>`` so GitHub itself refuses a
branch that moves in between.

**The whole diff, or no decision.** A scope check is worth exactly as much as
the file list it sees, and GitHub truncates file lists. ``--pr-files`` carries
every entry the pull request reports - including ``previous_filename``, so a
renamed guardrail file cannot slip through under a new name - and
``--expected-file-count`` carries the number of files GitHub says the pull
request changes. If the two disagree the list is not provably complete, and an
unprovable diff goes to a human instead of being checked against a fragment.

**No unproven fix, and "still running" is not a verdict.** ``--quality-state``
and ``--evidence-state`` carry check-run results for that same SHA. While a gate
is ``pending`` the decision is skip and nothing is labelled, so the next gate
completion can decide again; a blocking label is only applied to a real negative
result.

**Approval belongs to a revision, not to a branch.** A label survives a
force-push, so a label is not an approval. Only an approving review recorded
against ``--ci-sha`` by a configured owner clears manual review, and it never
clears a scope violation.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_change_scope import evaluate, manual_review_hits  # noqa: E402

EXIT_MERGE = 0
EXIT_SKIP = 10
EXIT_SCOPE_VIOLATION = 20
EXIT_MANUAL_REVIEW = 30

EVIDENCE_PASSED = "passed"
EVIDENCE_NOT_REQUIRED = "not_required"
EVIDENCE_PENDING = "pending"
EVIDENCE_FAILED = "failed"
EVIDENCE_MISSING = "missing"
EVIDENCE_STATES = (
    EVIDENCE_PASSED, EVIDENCE_NOT_REQUIRED, EVIDENCE_PENDING, EVIDENCE_FAILED,
    EVIDENCE_MISSING,
)
ACCEPTED_EVIDENCE = (EVIDENCE_PASSED, EVIDENCE_NOT_REQUIRED)

QUALITY_PASSED = "passed"
QUALITY_PENDING = "pending"
QUALITY_FAILED = "failed"
QUALITY_MISSING = "missing"
QUALITY_STATES = (QUALITY_PASSED, QUALITY_PENDING, QUALITY_FAILED, QUALITY_MISSING)

DEFAULT_MAX_CHANGED_FILES = 200


def normalize_author(login: Any) -> str:
    text = str(login or "").strip().lower()
    for prefix in ("app/", "bot/"):
        if text.startswith(prefix):
            text = text[len(prefix):]
    return text


def _labels(pull_request: Mapping[str, Any]) -> set:
    return {
        str((label or {}).get("name") or "").lower()
        for label in pull_request.get("labels") or []
    }


def _unique(paths: Sequence[str]) -> list:
    seen, ordered = set(), []
    for raw in paths:
        path = str(raw)
        if path and path not in seen:
            seen.add(path)
            ordered.append(path)
    return ordered


def file_paths(entries: Sequence[Mapping[str, Any]]) -> tuple:
    """Every path a file list touches, plus the renames inside it.

    A rename is two paths: where the file was and where it went. Checking only
    the new name lets a pull request move a guardrail file out of the way, and
    checking only the old one lets it create a manual-review file under a new
    name. Both are checked.
    """
    paths, renames, seen = [], [], set()
    for entry in entries or []:
        if not isinstance(entry, Mapping):
            continue
        new_path = str(entry.get("filename") or entry.get("path") or "")
        old_path = str(entry.get("previous_filename") or "")
        if not new_path or new_path in seen or (entry.get("status") == "renamed" and not old_path):
            continue
        seen.add(new_path)
        if new_path:
            paths.append(new_path)
        if old_path:
            paths.append(old_path)
            renames.append({"from": old_path, "to": new_path})
    return paths, renames, len(seen)


def _approvals(entries) -> list:
    latest = {}
    for entry in entries or []:
        if not isinstance(entry, Mapping):
            continue
        user = entry.get("user")
        login = entry.get("login")
        if not login and isinstance(user, Mapping):
            login = user.get("login")
        state = str(entry.get("state") or "").strip().upper()
        if not login or state not in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            continue
        latest[str(login).lower()] = {
            "login": str(login).strip(),
            "commit_id": str(entry.get("commit_id") or entry.get("commit") or "").strip(),
            "state": state,
        }
    return list(latest.values())


def decide(
    pull_request: Mapping[str, Any],
    config: Mapping[str, Any],
    integration_branch: str = "autonomous/lab",
    *,
    ci_sha: str = "",
    changed_files: Sequence[str] | None = None,
    file_entries: Sequence[Mapping[str, Any]] | None = None,
    expected_file_count: int | None = None,
    evidence_state: str = EVIDENCE_MISSING,
    quality_state: str = QUALITY_MISSING,
    approvals: Sequence[Mapping[str, Any]] = (),
) -> dict:
    automation = config.get("automation") or {}
    gate = config.get("merge_gate") or {}
    allowed_authors = {normalize_author(a) for a in automation.get("allowed_pr_authors") or []}
    blocking_labels = {str(name).lower() for name in automation.get("blocking_labels") or []}
    approval_labels = {str(name).lower() for name in gate.get("manual_approval_labels") or []}
    owners = {str(name).strip().lower() for name in gate.get("owner_approvers") or [] if str(name).strip()}
    require_evidence = gate.get("require_regression_test") is not False
    try:
        max_files = int(gate.get("max_changed_files", DEFAULT_MAX_CHANGED_FILES))
    except (TypeError, ValueError):
        max_files = DEFAULT_MAX_CHANGED_FILES
    max_files = max(1, max_files)

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

    # The revision the gates verified must still be the revision we would merge.
    head_oid = str(pull_request.get("headRefOid") or "")
    verified_sha = str(ci_sha or "")
    short_sha = verified_sha[:12] or "an unknown revision"
    if not verified_sha:
        reasons.append("no CI-verified revision was supplied; refusing to merge blind")
    elif head_oid != verified_sha:
        reasons.append(
            "head moved since CI: verified " + verified_sha[:12]
            + " but the pull request now points at " + head_oid[:12]
        )

    normalized_quality = str(quality_state or QUALITY_MISSING).strip().lower()
    if normalized_quality not in QUALITY_STATES:
        normalized_quality = QUALITY_MISSING
    normalized_evidence = str(evidence_state or EVIDENCE_MISSING).strip().lower()
    if normalized_evidence not in EVIDENCE_STATES:
        normalized_evidence = EVIDENCE_MISSING

    # "Not finished yet" is not a result. Skipping keeps the pull request clean so
    # the next gate completion re-evaluates it; a blocking label would be permanent.
    pending = []
    if normalized_quality == QUALITY_PENDING:
        pending.append("the quality gate")
    if normalized_evidence == EVIDENCE_PENDING:
        pending.append("the evidence gate")
    if pending:
        reasons.append(
            "still waiting for " + ", ".join(pending) + " on " + short_sha
        )
    if normalized_quality == QUALITY_FAILED:
        reasons.append("the quality gate is red for " + short_sha)
    elif normalized_quality == QUALITY_MISSING:
        reasons.append("no quality-gate result was found for " + short_sha)

    renames = []
    entry_count = 0
    completeness_note = ""
    if file_entries is not None:
        changed, renames, entry_count = file_paths(file_entries)
        files_are_sha_bound = True
    elif changed_files is not None:
        changed = [str(path) for path in changed_files]
        entry_count = len(changed)
        files_are_sha_bound = True
    else:
        changed = [
            str((entry or {}).get("path") or "")
            for entry in pull_request.get("files") or []
        ]
        entry_count = len(changed)
        files_are_sha_bound = False

    changed = _unique(changed)
    if not changed:
        reasons.append("pull request has no changed files")

    expected = None
    if expected_file_count is not None:
        try:
            expected = int(expected_file_count)
        except (TypeError, ValueError):
            expected = None

    if expected is None:
        complete = False
        completeness_note = (
            "the number of files this pull request changes was not supplied, so the "
            + str(entry_count) + " listed path(s) cannot be proven complete"
        )
    elif expected != entry_count:
        complete = False
        completeness_note = (
            "the file list is not complete: " + str(entry_count) + " entr(y/ies) were "
            "read for a pull request that changes " + str(expected) + " file(s)"
        )
    else:
        complete = True

    if not files_are_sha_bound:
        review_reasons.append(
            "the changed-file list was not pinned to the CI-verified revision"
        )
    elif not complete:
        review_reasons.append(completeness_note)
    if expected is not None and expected > max_files:
        review_reasons.append(
            "the diff is too large to check mechanically: " + str(expected)
            + " files against a limit of " + str(max_files)
        )

    scope = evaluate(config, changed)
    needs_human = manual_review_hits(config, changed)
    if needs_human:
        review_reasons.append(
            "touches manual-review path(s): " + ", ".join(sorted(needs_human))
        )

    if (
        require_evidence
        and normalized_evidence not in ACCEPTED_EVIDENCE
        and normalized_evidence != EVIDENCE_PENDING
    ):
        review_reasons.append(
            "the fix is unproven: evidence gate is " + normalized_evidence
            + " for " + short_sha
        )

    # An approval is a statement about one revision. A label is not.
    parsed_approvals = _approvals(approvals)
    valid_approvals = [
        entry for entry in parsed_approvals
        if entry["state"] == "APPROVED"
        and entry["commit_id"]
        and verified_sha
        and entry["commit_id"] == verified_sha
        and entry["login"].lower() in owners
    ]
    label_claims = sorted(labels & approval_labels)
    overridden = []
    if review_reasons:
        if valid_approvals and complete and files_are_sha_bound:
            overridden = review_reasons
            review_reasons = []
        elif label_claims:
            review_reasons.append(
                "the " + ", ".join(label_claims) + " label is not an approval of "
                + short_sha + ": approve this exact revision in a pull request review "
                "(a label survives a force-push, an approval does not)"
            )

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
        "overridden_review_reasons": overridden,
        "approved_by": sorted({entry["login"] for entry in valid_approvals if entry["login"]}),
        "label_approvals": label_claims,
        "pending": bool(pending),
        "ci_sha": verified_sha,
        "head_sha": head_oid,
        "evidence_state": normalized_evidence,
        "quality_state": normalized_quality,
        "changed_files": changed,
        "changed_file_count": entry_count,
        "expected_file_count": expected,
        "changed_files_complete": bool(complete),
        "renamed_paths": renames,
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


def _read_json_array(path: Path) -> list:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8") or "[]")
    except json.JSONDecodeError:
        return []
    return loaded if isinstance(loaded, list) else []


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pr-json", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--integration-branch", default="autonomous/lab")
    parser.add_argument("--ci-sha", default="",
                        help="the commit whose gate runs produced these results")
    parser.add_argument("--changed-files", type=Path,
                        help="file list computed for --ci-sha (newline-delimited)")
    parser.add_argument("--pr-files", type=Path,
                        help="JSON array of pull request file entries (filename, previous_filename)")
    parser.add_argument("--expected-file-count", type=int, default=-1,
                        help="how many files GitHub says the pull request changes; "
                             "a mismatch means the list is truncated")
    parser.add_argument("--evidence-state", default=EVIDENCE_MISSING, choices=list(EVIDENCE_STATES))
    parser.add_argument("--quality-state", default=QUALITY_MISSING, choices=list(QUALITY_STATES))
    parser.add_argument("--approvals", type=Path,
                        help="JSON array of reviews with login, state and commit_id")
    parser.add_argument("--changed-files-out", type=Path)
    parser.add_argument("--decision-out", type=Path)
    args = parser.parse_args(argv)

    pull_request = json.loads(args.pr_json.read_text(encoding="utf-8"))
    config = json.loads(args.config.read_text(encoding="utf-8"))
    changed_files = None
    if args.changed_files and args.changed_files.exists():
        changed_files = _read_lines(args.changed_files)
    file_entries = None
    if args.pr_files and args.pr_files.exists():
        file_entries = _read_json_array(args.pr_files)
    approvals = []
    if args.approvals and args.approvals.exists():
        approvals = _read_json_array(args.approvals)

    result = decide(
        pull_request, config, args.integration_branch,
        ci_sha=args.ci_sha, changed_files=changed_files, file_entries=file_entries,
        expected_file_count=None if args.expected_file_count < 0 else args.expected_file_count,
        evidence_state=args.evidence_state, quality_state=args.quality_state,
        approvals=approvals,
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
    for reason in result["overridden_review_reasons"]:
        print(
            "overridden by owner approval of " + result["ci_sha"][:12] + ": " + reason,
            file=sys.stderr,
        )
    for violation in result["violations"]:
        print(
            "out of scope: " + violation["path"] + " (" + violation["reason"] + ")",
            file=sys.stderr,
        )
    return EXIT_CODES[result["decision"]]


if __name__ == "__main__":
    raise SystemExit(main())
