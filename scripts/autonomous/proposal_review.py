#!/usr/bin/env python3
"""Produce a revision-bound human review report; never accept a proposal.

Inputs are collected from GitHub REST while bracketing file pagination with head
reads. Persisted session provenance is the only proposal ownership authority.
A ready report describes checks and review prerequisites, not permission to land.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_change_scope import evaluate, manual_review_hits
from evidence_plan import MODE_PROOF_TS, explain, plan
from jules_provenance import trusted_pull_request
from verify_policy import verify

GITHUB_ACTIONS_APP_ID = 15368


def file_paths(entries: Sequence[Mapping[str, Any]]) -> tuple:
    """Count distinct valid entries and inspect both names of every rename."""
    paths, renames, seen = [], [], set()
    malformed = False
    for entry in entries:
        if not isinstance(entry, Mapping):
            malformed = True
            continue
        name = entry.get("filename")
        previous = entry.get("previous_filename") or ""
        if (not isinstance(name, str) or not name or name in seen
                or not isinstance(previous, str)
                or (entry.get("status") == "renamed" and not previous)):
            malformed = True
            continue
        seen.add(name)
        paths.append(name)
        if previous:
            paths.append(previous)
            renames.append({"from": previous, "to": name})
    return list(dict.fromkeys(paths)), renames, len(seen), malformed


def check_result(name: str, checks: Sequence[Mapping[str, Any]], sha: str) -> dict:
    """Only the latest GitHub Actions run on this exact SHA is evidence."""
    matching = [check for check in checks if isinstance(check, Mapping)
                and check.get("name") == name and check.get("head_sha") == sha]
    result = {"name": name, "state": "missing", "url": "", "id": None}
    if not matching:
        return result
    if any(not isinstance(check.get("app"), Mapping)
           or type(check["app"].get("id")) is not int
           or check["app"]["id"] != GITHUB_ACTIONS_APP_ID for check in matching):
        result["state"] = "foreign"
        return result
    if any(type(check.get("id")) is not int for check in matching):
        result["state"] = "invalid"
        return result
    latest = max(matching, key=lambda check: check["id"])
    result.update(id=latest["id"], url=str(latest.get("html_url") or ""))
    if latest.get("status") != "completed":
        result["state"] = "pending"
    else:
        result["state"] = "passed" if latest.get("conclusion") == "success" else "failed"
    return result


def _approvals(entries: Sequence[Mapping[str, Any]]) -> list:
    latest = {}
    # REST pagination is chronological; ids make repeated/out-of-order reads safe.
    ordered = sorted(entries, key=lambda entry: entry.get("id", 0)
                     if isinstance(entry, Mapping) and type(entry.get("id", 0)) is int else 0)
    for entry in ordered:
        if not isinstance(entry, Mapping):
            continue
        login = str((entry.get("user") or {}).get("login") or entry.get("login") or "").strip()
        state = str(entry.get("state") or "").upper()
        if login and state in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            latest[login.lower()] = {"login": login, "state": state,
                                     "commit_id": entry.get("commit_id")}
    return list(latest.values())


def decide(pull_request: Mapping[str, Any], config: Mapping[str, Any],
           manifest: Mapping[str, Any], integration_branch: str = "autonomous/lab", *,
           ci_sha: str = "", files_sha: str = "", lab_sha: str = "",
           comparison: Mapping[str, Any] | None = None,
           file_entries: Sequence[Mapping[str, Any]] = (),
           expected_file_count: int | None = None,
           checks: Sequence[Mapping[str, Any]] = (),
           approvals: Sequence[Mapping[str, Any]] = ()) -> dict:
    repository = str(config.get("repository") or "")
    gate = config.get("merge_gate") or {}
    reasons = verify(config, integration_branch)
    risks = []
    head_sha = str((pull_request.get("head") or {}).get("sha") or "")
    number = pull_request.get("number")
    trusted = [task for task in manifest.get("tasks", [])
               if isinstance(task, Mapping)
               and trusted_pull_request(task, pull_request, repository, integration_branch)]
    provenance_verified = len(trusted) == 1
    if not provenance_verified:
        reasons.append("No unique persisted session provenance identifies this proposal; ask the controller to reconcile its session receipt.")
    if str(pull_request.get("state") or "").lower() != "open" or pull_request.get("merged"):
        reasons.append("The proposal is not open.")
    if pull_request.get("draft"):
        reasons.append("The proposal is a draft.")
    labels = {str(label.get("name") or "").lower() for label in pull_request.get("labels", [])
              if isinstance(label, Mapping)}
    held = labels & {str(label).lower() for label in (config.get("automation") or {}).get("blocking_labels", [])}
    if held:
        reasons.append("Blocking labels: " + ", ".join(sorted(held)))
    if not re.fullmatch(r"[0-9a-f]{40}", ci_sha):
        reasons.append("No exact reviewed commit SHA was supplied.")
    if head_sha != ci_sha:
        reasons.append("Head moved: collected checks describe " + ci_sha + ", current head is " + head_sha + ". Recollect all inputs.")
    if not re.fullmatch(r"[0-9a-f]{40}", lab_sha):
        reasons.append("No exact current laboratory SHA was supplied; read the live integration branch before collecting inputs.")
    if not isinstance(comparison, Mapping):
        reasons.append("Laboratory ancestry is unknown; fetch the exact comparison of lab SHA...reviewed SHA.")
    else:
        compared_base = comparison.get("base_commit")
        if not isinstance(compared_base, Mapping) or compared_base.get("sha") != lab_sha:
            reasons.append("The comparison is not bound to the current laboratory SHA; recollect it from the pinned lab SHA...reviewed SHA endpoint.")
        status = comparison.get("status")
        if status == "behind":
            reasons.append("The reviewed SHA is behind the current laboratory SHA; refresh the proposal and collect checks on its new head.")
        elif status == "diverged":
            reasons.append("The reviewed SHA has diverged from the current laboratory SHA; update the proposal against lab and resolve conflicts before review.")
        elif status not in ("ahead", "identical"):
            reasons.append("Laboratory ancestry is unknown: the comparison has no recognized ancestry status.")
    if files_sha != ci_sha:
        reasons.append("The file list is not bound to the reviewed SHA; recollect it with head checks before and after pagination.")

    changed, renames, count, malformed = file_paths(file_entries)
    expected = expected_file_count
    complete = (type(expected) is int and expected > 0 and expected == count
                and pull_request.get("changed_files") == expected and not malformed)
    if not complete:
        reasons.append("The full diff is not proven complete: expected " + str(expected)
                       + ", read " + str(count) + ". Missing, duplicate or malformed entries cannot be approved away.")
    if not changed:
        reasons.append("The proposal has no changed files.")
    max_files = gate.get("max_changed_files", 200)
    if type(max_files) is not int or max_files < 1:
        max_files = 200
    if type(expected) is int and expected > max_files:
        risks.append("Large diff: " + str(expected) + " files exceeds the review limit " + str(max_files) + ".")
    scope = evaluate(config, changed)
    if not scope["allowed"]:
        reasons.append("Excluded or out-of-scope paths must be removed; owner approval cannot waive the product boundary.")
    manual_paths = sorted(manual_review_hits(config, changed))
    if manual_paths:
        risks.append("Sensitive updater paths need explicit owner review: " + ", ".join(manual_paths))

    required = gate.get("required_check_names") or []
    if not isinstance(required, list):
        required = []
    quality = [check_result(name, checks, ci_sha) for name in required]
    evidence = check_result(str(gate.get("evidence_check_name") or ""), checks, ci_sha)
    for check in quality:
        if check["state"] != "passed":
            reasons.append(check["name"] + " is " + check["state"] + " on the reviewed SHA; rerun or wait for the trusted GitHub Actions check.")
    if evidence["state"] in ("missing", "foreign", "invalid", "pending"):
        reasons.append(evidence["name"] + " is " + evidence["state"] + "; no ready claim is possible without a trusted completed evidence check.")
    proof = plan(config, changed)
    if proof["mode"] != MODE_PROOF_TS:
        risks.append(explain(proof))
    if evidence["state"] == "failed":
        risks.append("Evidence check failed: inspect its logs. No failing-first proof is established for this revision.")

    owners = {str(owner).lower() for owner in gate.get("owner_approvers", [])}
    reviews = _approvals(approvals)
    approved = sorted(review["login"] for review in reviews
                      if review["state"] == "APPROVED" and review["commit_id"] == ci_sha
                      and review["login"].lower() in owners)
    changes_requested = [review["login"] for review in reviews
                         if review["state"] == "CHANGES_REQUESTED" and review["commit_id"] == ci_sha
                         and review["login"].lower() in owners]
    if changes_requested:
        reasons.append("Owner requested changes on this revision: " + ", ".join(changes_requested))
    label_claims = sorted(labels & {str(label).lower() for label in gate.get("manual_approval_labels", [])})
    decision = "blocked" if reasons else "manual_review" if risks and not approved else "ready_for_review"
    url = "https://github.com/" + repository + "/pull/" + str(number)
    return {
        "decision": decision, "acceptance": "manual", "reasons": reasons,
        "review_reasons": risks, "owner_review_required": bool(risks),
        "approved_by": approved, "label_approvals": label_claims,
        "provenance_verified": provenance_verified,
        "task_id": trusted[0].get("id") if provenance_verified else None,
        "pull_request": number, "repository": repository,
        "ci_sha": ci_sha, "head_sha": head_sha, "files_sha": files_sha, "lab_sha": lab_sha,
        "changed_files": changed, "changed_file_count": count,
        "expected_file_count": expected, "changed_files_complete": complete,
        "renamed_paths": renames, "violations": scope["violations"],
        "manual_review_paths": manual_paths, "proof_plan": proof,
        "proof_established": proof["mode"] == MODE_PROOF_TS and evidence["state"] == "passed",
        "checks": quality + [evidence],
        "links": {"proposal": url, "diff": url + "/files/" + ci_sha,
                  "revision": "https://github.com/" + repository + "/commit/" + ci_sha,
                  "checks": url + "/checks"},
    }


def render_report(result: Mapping[str, Any]) -> str:
    sha = result["ci_sha"]
    lines = ["<!-- autonomous-proposal-review:" + sha + " -->",
             "## Autonomous proposal review: " + result["decision"], "",
             "Reviewed revision: [`" + sha + "`](" + result["links"]["revision"] + ")", "",
             "Pinned laboratory revision: `" + result["lab_sha"] + "`", "",
             "This is a SHA-bound review report, not acceptance. The laboratory never accepts its own proposals.",
             "A later proposal push or laboratory commit invalidates readiness in this report; rerun against both current revisions.", "",
             "[Proposal](" + result["links"]["proposal"] + ") · [Reviewed diff](" + result["links"]["diff"]
             + ") · [Checks and logs](" + result["links"]["checks"] + ")", "",
             "- Persisted session provenance: " + ("verified" if result["provenance_verified"] else "unknown or ambiguous"),
             "- Complete diff: " + str(result["changed_files_complete"]).lower()
             + " (" + str(result["changed_file_count"]) + "/" + str(result["expected_file_count"]) + " files)",
             "- Failing-first proof: " + ("established" if result["proof_established"] else "not established"),
             "- Owner approval of this SHA: " + (", ".join(result["approved_by"]) or "none"), "", "### Checks"]
    for check in result["checks"]:
        link = check["url"]
        suffix = " ([logs](" + link + "))" if link.startswith("https://github.com/" + result["repository"] + "/") else ""
        lines.append("- " + check["name"] + ": **" + check["state"] + "**" + suffix)
    for title, items in (("Blockers", result["reasons"]), ("Manual risks (retained even after approval)", result["review_reasons"])):
        if items:
            lines.extend(["", "### " + title] + ["- " + item for item in items])
    for violation in result["violations"]:
        lines.append("- Out of scope: `" + violation["path"] + "` (" + violation["reason"] + ")")
    if result["label_approvals"]:
        lines.extend(["", "Approval labels are only hints; they are not approval of this revision."])
    lines.extend(["", "### Next action"])
    if result["decision"] == "blocked":
        lines.append("Resolve the blockers and rerun this report for the current head. Do not treat a partial or foreign check result as readiness.")
    elif result["decision"] == "manual_review":
        lines.append("Inspect the diff, evidence logs and risks; a configured owner must explicitly review this exact SHA. Passing quality checks do not prove the fix.")
    else:
        lines.append("Checks and review prerequisites are satisfied for this SHA. A human or Main AI must still assess usefulness and choose whether to accept the proposal manually.")
    lines.append("Close the PR to decline it permanently; the laboratory will not retry a declined proposal.")
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("pr-json", "config", "manifest", "pr-files", "checks", "approvals"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--integration-branch", default="autonomous/lab")
    parser.add_argument("--ci-sha", required=True)
    parser.add_argument("--files-sha", required=True)
    parser.add_argument("--lab-sha", default="")
    parser.add_argument("--comparison-json", type=Path)
    parser.add_argument("--expected-file-count", required=True, type=int)
    parser.add_argument("--decision-out", type=Path)
    parser.add_argument("--report-out", type=Path)
    args = parser.parse_args(argv)
    try:
        loaded = {name: json.loads(getattr(args, name).read_text(encoding="utf-8"))
                  for name in ("pr_json", "config", "manifest", "pr_files", "checks", "approvals")}
        for name in ("pr_json", "config", "manifest"):
            if not isinstance(loaded[name], dict):
                raise ValueError(name + " must be a JSON object")
        for name in ("pr_files", "checks", "approvals"):
            if not isinstance(loaded[name], list):
                raise ValueError(name + " must be a JSON array")
        comparison = json.loads(args.comparison_json.read_text(encoding="utf-8")) if args.comparison_json else None
        result = decide(loaded["pr_json"], loaded["config"], loaded["manifest"], args.integration_branch,
                        ci_sha=args.ci_sha, files_sha=args.files_sha, lab_sha=args.lab_sha,
                        comparison=comparison, file_entries=loaded["pr_files"],
                        expected_file_count=args.expected_file_count, checks=loaded["checks"],
                        approvals=loaded["approvals"])
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        print("Cannot produce a trustworthy review report: " + str(exc), file=sys.stderr)
        return 1
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.decision_out:
        args.decision_out.write_text(serialized, encoding="utf-8")
    if args.report_out:
        args.report_out.write_text(render_report(result), encoding="utf-8")
    print(serialized, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
