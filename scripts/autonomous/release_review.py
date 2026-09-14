#!/usr/bin/env python3
"""Compile a release-decision report for the autonomous integration branch.

Compares the integration branch against the release branch and summarizes what
the loop has accumulated, so a human (optionally with an AI assistant) can
decide whether to cut a release. This script never mutates the repository, and
never bumps versions, tags, or publishes anything.

Everything is reported against a **resolved commit SHA**, not a branch name. A
report that says "autonomous/lab" while the verification job happened to test a
different commit is worse than no report at all: the decision would be made on
code nobody checked.

The report therefore states the verification outcome as a fact it was given, not
as an assumption. ``--verify-result`` is the real conclusion of the verification
job and ``--verified-sha`` the commit it actually checked out. If they do not
line up with the reviewed commit, the artifact itself opens with **NOT VERIFIED
- do not release**; the warning lives in the file a human downloads, not only in
a job summary they may never open.
"""
from __future__ import annotations
import argparse
import html
import json
import subprocess
from pathlib import Path
from validate_tasks import validate

RESULT_SUCCESS = "success"
VERIFY_RESULTS = ("success", "failure", "cancelled", "skipped", "none")
MAX_LAB_REPORT = 12000


def _safe(value, limit=500) -> str:
    """Render untrusted lab prose as inert, single-line Markdown text."""
    text = " ".join(str(value or "").split())
    text = text[:limit] + (" [excerpt]" if len(text) > limit else "")
    return html.escape(text, quote=True).translate({
        ord(char): "&#" + str(ord(char)) + ";" for char in "\\`*_[]()!#|~@:"
    })




def _lab_section(manifest: dict) -> list[str]:
    tasks = manifest["tasks"]
    tasks = [task for task in tasks if isinstance(task, dict)]
    counts = {}
    for task in tasks:
        status = str(task.get("status", "unknown"))
        counts[status] = counts.get(status, 0) + 1
    lines = ["## Autonomous lab results", "", "Results below are evidence for human review only; research is not release verification.", "", "### Queue summary", ""]
    lines.append("- Tasks in reviewed queue: **" + str(len(tasks)) + "**; " + ", ".join(f"`{_safe(k)}`: **{v}**" for k, v in sorted(counts.items())) + ".")
    groups = {"Active work and pending proposals": [], "Completed investigations": [], "Completed implementations": []}
    for task in reversed(tasks):
        group = ("Active work and pending proposals" if task.get("status") != "done" else
                 "Completed investigations" if task.get("task_type") == "project_discovery" else
                 "Completed implementations")
        groups[group].append(task)
    for title, selected in groups.items():
        if not selected:
            continue
        lines += ["", "### " + title, ""]
        for task in selected:
            execution = task.get("execution") if isinstance(task.get("execution"), dict) else {}
            research = task.get("research_result") if isinstance(task.get("research_result"), dict) else {}
            meta = task.get("research") if isinstance(task.get("research"), dict) else {}
            lines.append("- " + _safe(task.get("id"), 160) + " - **" + _safe(task.get("status"), 40)
                         + "**: " + _safe(task.get("title"), 300))
            if meta:
                lines.append("  - Area: " + _safe(meta.get("area_id"), 100) + "; perspective: "
                             + _safe(meta.get("perspective_id"), 100) + "; cycle: " + _safe(meta.get("cycle"), 30))
            if execution:
                lines.append("  - Execution: " + _safe(execution.get("state"), 60) + "; outcome: "
                             + _safe(execution.get("outcome"), 60) + "; attempts: " + _safe(execution.get("attempts"), 30))
                if execution.get("pull_request"):
                    lines.append("  - Pull request: #" + _safe(execution["pull_request"], 30))
                if execution.get("note"):
                    lines.append("  - Note: " + _safe(execution["note"]))
            if research:
                lines.append("  - Summary: " + _safe(research.get("summary")))
                for item in research.get("observations", [])[:8]:
                    if isinstance(item, dict):
                        lines.append("  - Observation: " + _safe("; ".join(
                            str(item.get(field) or "") for field in ("scenario", "evidence", "result"))))
                for hypothesis in research.get("next_hypotheses", [])[:8]:
                    lines.append("  - Next hypothesis: " + _safe(hypothesis))
                for identifier in research.get("proposed_task_ids", [])[:10]:
                    lines.append("  - Linked task: " + _safe(identifier, 160))
                for item in research.get("deferred_findings", [])[:10]:
                    if isinstance(item, dict):
                        lines.append("  - Deferred proposal: " + _safe(item.get("title")) + "; reason: "
                                     + _safe(item.get("reason"), 100))
                        lines.append("    - Evidence: " + _safe(item.get("evidence")))
                        lines.append("    - Paths: " + _safe(", ".join(item.get("target_paths", []))))
                        lines.append("    - Acceptance: " + _safe("; ".join(item.get("acceptance", []))))
            origin = task.get("origin") if isinstance(task.get("origin"), dict) else {}
            if origin.get("task_id"):
                lines.append("  - Found by: " + _safe(origin["task_id"], 160))
            evidence = task.get("evidence") if isinstance(task.get("evidence"), dict) else {}
            if evidence.get("detail") and not meta:
                lines.append("  - Evidence: " + _safe(evidence["detail"]))
    text = "\n".join(lines)
    if len(text) > MAX_LAB_REPORT:
        text = text[:MAX_LAB_REPORT].rsplit("\n", 1)[0] + "\n\n_Additional task details omitted for size; queue totals above include them. Read agent_tasks.json at the reported state SHA for the full history._"
    return text.splitlines() + [""]



def _git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True, stderr=subprocess.STDOUT).strip()


def resolve(ref: str) -> str:
    return _git("rev-parse", "--verify", "--end-of-options", ref + "^{commit}")


def verification_status(head_sha: str, verified_sha: str, verify_result: str) -> dict:
    """Decide what may honestly be claimed about verification.

    Only one combination is green: the verification job reported success **and**
    the commit it checked out is the commit this report describes. Everything
    else - no run, a run that failed, a run whose SHA is unknown or different -
    is reported as not verified, because a release decision made on an assumed
    green run is exactly the failure this tooling exists to prevent.
    """
    result = str(verify_result or "none").strip().lower() or "none"
    if result not in VERIFY_RESULTS:
        result = "none"
    verified = str(verified_sha or "").strip()
    head = str(head_sha or "").strip()

    if not verified or result in ("none", "skipped"):
        return {
            "verified": False, "result": result,
            "headline": "NOT VERIFIED - do not release",
            "detail": (
                "No verification run is attached to this report"
                + (" (job result: " + result + ")" if result != "none" else "")
                + ". Nothing below has been checked by CI; treat the diff as unverified."
            ),
        }
    if not head:
        return {
            "verified": False, "result": result,
            "headline": "NOT VERIFIED - do not release",
            "detail": (
                "This report is not pinned to a commit, so the run on `" + verified[:12]
                + "` cannot be attributed to the diff below."
            ),
        }
    if verified != head:
        return {
            "verified": False, "result": result,
            "headline": "NOT VERIFIED - do not release",
            "detail": (
                "The verification job checked out `" + verified[:12] + "` but this diff "
                "describes `" + head[:12] + "`. Re-run the review so both use one commit."
            ),
        }
    if result != RESULT_SUCCESS:
        return {
            "verified": False, "result": result,
            "headline": "NOT VERIFIED - do not release",
            "detail": (
                "The verification job for `" + head[:12] + "` finished with result \""
                + result + "\", not success."
            ),
        }
    return {
        "verified": True, "result": result,
        "headline": "Verified",
        "detail": (
            "The verification job in this run checked out exactly `" + head
            + "` and reported success, so the green result belongs to the code "
            "described here."
        ),
    }


def build_report(base: str, head: str, *, base_sha: str = "", head_sha: str = "",
                 verified_sha: str = "", verify_result: str = "none",
                 verify_run_url: str = "", manifest: dict, state_sha: str = "") -> str:
    if validate(manifest):
        raise ValueError("invalid state manifest")
    # Resolve even explicitly supplied SHAs: a caller-provided label or a
    # nonexistent object is not proof that the report describes that commit.
    base_sha = resolve(base_sha or base)
    head_sha = resolve(head_sha or head)
    base_rev = base_sha
    head_rev = head_sha
    ahead = _git("rev-list", "--count", base_rev + ".." + head_rev)
    behind = _git("rev-list", "--count", head_rev + ".." + base_rev)
    log = _git("log", "--no-merges", "--pretty=format:- %h %s (%an, %ad)", "--date=short",
               base_rev + ".." + head_rev)
    stat = _git("diff", "--stat", base_rev + "..." + head_rev)

    status = verification_status(head_sha, verified_sha, verify_result)
    if status["verified"]:
        pinning = "**" + status["headline"] + ".** " + status["detail"]
        verification_line = (
            "- Verification: **success** on `" + (verified_sha or head_sha) + "`"
        )
        checklist_verification = (
            "- [x] The verification job in this run is green **for the commit named above**"
        )
    else:
        pinning = "> **" + status["headline"] + ".** " + status["detail"]
        verification_line = (
            "- Verification: **" + status["result"] + "** for `"
            + ((verified_sha or "no commit")[:40]) + "` - not a green result for this diff"
        )
        checklist_verification = (
            "- [ ] **Blocked:** this report has no green verification run for the reviewed "
            "commit; re-run the review before deciding anything"
        )
    if verify_run_url:
        verification_line += " ([run](" + verify_run_url + "))"

    lines = [
        "# Autonomous integration review: `" + head + "` vs `" + base + "`",
        "",
        pinning,
        "",
        "- Reviewed head: `" + (head_sha or "unresolved") + "` (`" + head + "`)",
        "- Compared against: `" + (base_sha or "unresolved") + "` (`" + base + "`)",
        "- State revision (independent of reviewed code): `" + (state_sha or "unpublished legacy seed") + "`",
        "- Pending proposals are not accepted product changes; only the code diff below is verified.",
        verification_line,
        "- Commits ahead of `" + base + "`: **" + ahead + "**",
        "- Commits behind `" + base + "`: **" + behind + "**",
        "",
        "## Commits accumulated by the loop",
        "",
        log or "_No unique commits._",
        "",
        "## Changed files",
        "",
        "```",
        stat or "(no differences)",
        "```",
        "",
        *(_lab_section(manifest)),
        "## Release decision checklist (human-gated)",
        "",
        checklist_verification,
        "- [ ] Every change is inside product scope (no release/version files)",
        "- [ ] Any auto-update change was reviewed by hand (it is never merged unattended)",
        "- [ ] Each change is backed by a test or reproducible evidence",
        "- [ ] Manual smoke of the built app is acceptable",
        "- [ ] Decision: promote to the release branch, or keep iterating",
        "",
        "_Generated by autonomous_release_review. This tooling never bumps versions,",
        "creates tags, or publishes releases - promotion stays a manual human action._",
    ]
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="main")
    parser.add_argument("--head", default="autonomous/lab")
    parser.add_argument("--base-sha", default="")
    parser.add_argument("--head-sha", default="",
                        help="the single commit this review decides on")
    parser.add_argument("--verified-sha", default="",
                        help="the commit the verification job actually checked out")
    parser.add_argument("--verify-result", default="none",
                        help="conclusion of the verification job: " + ", ".join(VERIFY_RESULTS))
    parser.add_argument("--verify-run-url", default="")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--state-revision", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("release-review.md"))
    args = parser.parse_args(argv)
    exit_code = 0
    try:
        report = build_report(
            args.base, args.head, base_sha=args.base_sha, head_sha=args.head_sha,
            verified_sha=args.verified_sha, verify_result=args.verify_result,
            verify_run_url=args.verify_run_url,
            manifest=json.loads(args.manifest.read_text(encoding="utf-8")),
            state_sha=json.loads(args.state_revision.read_text(encoding="utf-8")).get("state_sha") or "",
        )
    except (OSError, ValueError, TypeError, KeyError, subprocess.CalledProcessError):
        exit_code = 1
        report = "\n".join([
            "# Autonomous integration review",
            "",
            "> **NOT VERIFIED - do not release.** The reviewed diff could not be read.",
            "",
            "- Requested head: `" + (args.head_sha or args.head) + "`",
            "- Requested base: `" + (args.base_sha or args.base) + "`",
            "- Verification job result: `" + args.verify_result + "`",
            "- Report generation failed: code or state snapshot could not be read safely.",
            "",
            "Resolve the Git failure and re-run this review before making a release decision.",
        ])
    args.out.write_text(report + "\n", encoding="utf-8")
    print(report)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
