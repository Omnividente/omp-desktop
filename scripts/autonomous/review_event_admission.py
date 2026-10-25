#!/usr/bin/env python3
"""Select exact lab review candidates before taking the reporting lock or reading state.

This is event admission, not Jules provenance or product acceptance. The reporting
job must still verify the unique persisted session receipt and revision evidence.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

from health_snapshot import gh_get
from jules_provenance import trusted_pull_request
from proposal_backlog import authorize
from workflow_admission import checked_callback_source, control_revision


WORKFLOW = "autonomous_review.yml"
EVIDENCE = {"autonomous_evidence_gate.yml": "Autonomous Evidence Gate"}
SHA = re.compile(r"[0-9a-f]{40}\Z")


def _repository(event):
    repository = event.get("repository")
    if (not isinstance(repository, dict) or not isinstance(repository.get("full_name"), str)
            or type(repository.get("id")) is not int or repository["id"] <= 0
            or repository.get("default_branch") != "main"):
        raise ValueError("review repository identity unavailable")
    return repository


def _candidate(pr, repository):
    if not isinstance(pr, dict) or type(pr.get("number")) is not int or pr["number"] <= 0:
        raise ValueError("review pull request identity unavailable")
    number = pr["number"]
    if (pr.get("state") != "open" or pr.get("merged") is not False
            or pr.get("html_url") != "https://github.com/" + repository["full_name"] + "/pull/" + str(number)):
        raise ValueError("review requires a current open pull request")
    for side in ("base", "head"):
        branch = pr.get(side)
        if (not isinstance(branch, dict) or not isinstance(branch.get("repo"), dict)
                or type(branch["repo"].get("id")) is not int
                or any(branch["repo"].get(key) != repository[key] for key in ("id", "full_name"))
                or not isinstance(branch.get("sha"), str) or not SHA.fullmatch(branch["sha"])
                or not isinstance(branch.get("ref"), str) or not branch["ref"].strip()):
            raise ValueError("review requires exact same-repository branch identities")
    if pr["base"]["ref"] != "autonomous/lab":
        raise ValueError("review only accepts laboratory proposals")
    return {"number": number, "head_sha": pr["head"]["sha"], "head_ref": pr["head"]["ref"]}


def candidate_prs(event_name, event, source, prs):
    """Validate the full selected set; a callback never falls back to a lab scan."""
    repository = _repository(event)
    if not isinstance(prs, list):
        raise ValueError("review candidate listing incomplete")
    candidates = []
    for pr in prs:
        if event_name in ("schedule", "workflow_dispatch") and isinstance(pr, dict):
            # Closed/retargeted/fork proposals are not Jules review subjects.
            # Their presence must not starve another persisted lab proposal.
            base, head = pr.get("base"), pr.get("head")
            if (pr.get("state") == "closed"
                    or not isinstance(base, dict) or not isinstance(base.get("repo"), dict)
                    or type(base["repo"].get("id")) is not int
                    or any(base["repo"].get(key) != repository[key] for key in ("id", "full_name"))
                    or base.get("ref") != "autonomous/lab"
                    or not isinstance(head, dict) or not isinstance(head.get("repo"), dict)
                    or type(head["repo"].get("id")) is not int
                    or any(head["repo"].get(key) != repository[key] for key in ("id", "full_name"))):
                continue
        candidates.append(_candidate(pr, repository))
    if len({pr["number"] for pr in candidates}) != len(candidates):
        raise ValueError("ambiguous review candidates")
    if event_name == "workflow_run":
        if (not isinstance(source, dict) or source.get("event") != "pull_request"
                or source.get("name") != EVIDENCE["autonomous_evidence_gate.yml"]
                or source.get("path") != ".github/workflows/autonomous_evidence_gate.yml"
                or source.get("status") != "completed" or len(candidates) != 1):
            raise ValueError("review requires one exact evidence callback candidate")
        associations = source.get("pull_requests")
        if (not isinstance(associations, list) or len(associations) != 1
                or not isinstance(associations[0], dict)
                or type(associations[0].get("number")) is not int
                or associations[0]["number"] != candidates[0]["number"]
                or source.get("head_sha") != candidates[0]["head_sha"]
                or source.get("head_branch") != candidates[0]["head_ref"]):
            raise ValueError("evidence callback is stale or ambiguously associated")
    elif event_name not in ("schedule", "workflow_dispatch") or source is not None:
        raise ValueError("unsupported review event")
    return candidates


def _selected(value):
    if (not isinstance(value, list) or not value
            or any(not isinstance(pr, dict) or set(pr) != {"number", "head_sha", "head_ref"}
                   or type(pr["number"]) is not int or pr["number"] <= 0
                   or not isinstance(pr["head_sha"], str) or not SHA.fullmatch(pr["head_sha"])
                   or not isinstance(pr["head_ref"], str) or not pr["head_ref"].strip() for pr in value)
            or len({pr["number"] for pr in value}) != len(value)):
        raise ValueError("review selection unavailable")
    return value


def admit_review(event_name, event, config, *, actor, get, expected=None, manifest=None):
    """Metadata first; only unique saved Jules proposals may take the report lock."""
    repository = _repository(event)
    if repository["full_name"] != config["repository"]:
        raise ValueError("review repository mismatch")
    if expected is not None:
        expected = _selected(expected)

    def pull_request(number):
        pr = get("pulls/" + str(number))
        if not isinstance(pr, dict) or type(pr.get("number")) is not int or pr["number"] != number:
            raise ValueError("review pull request response identity mismatch")
        return pr
    source = None
    if event_name == "workflow_run":
        envelope = event.get("workflow_run")
        if (event.get("action") != "completed" or not isinstance(envelope, dict)
                or envelope.get("name") != EVIDENCE["autonomous_evidence_gate.yml"]
                or envelope.get("event") != "pull_request"):
            raise ValueError("untrusted review callback")
        source = checked_callback_source(repository["full_name"], envelope, workflows=EVIDENCE, get=get)
        if source["repository"]["id"] != repository["id"]:
            raise ValueError("review callback repository mismatch")
        associations = source.get("pull_requests")
        if (not isinstance(associations, list) or len(associations) != 1
                or not isinstance(associations[0], dict)
                or type(associations[0].get("number")) is not int or associations[0]["number"] <= 0):
            raise ValueError("ambiguous evidence pull request association")
        prs = [pull_request(associations[0]["number"])]
    else:
        if event_name == "workflow_dispatch":
            authorize(config, actor)
        elif event_name != "schedule":
            raise ValueError("unsupported review event")
        if expected is not None:
            # Rechecking after a queue wait must not widen the admitted scan.
            numbers = [pr["number"] for pr in expected]
        else:
            numbers, page = [], 1
            while True:
                values = get("pulls?state=open&base=autonomous/lab&per_page=100&page=" + str(page))
                if (not isinstance(values, list) or len(values) > 100
                        or any(not isinstance(pr, dict) or type(pr.get("number")) is not int
                               or pr["number"] <= 0 for pr in values)):
                    raise ValueError("review pull request listing unavailable")
                batch = [pr["number"] for pr in values]
                if len(set(batch)) != len(batch) or set(numbers).intersection(batch):
                    raise ValueError("review pull request pagination repeated")
                numbers.extend(batch)
                if len(values) < 100:
                    break
                page += 1
        # The list response omits merged and is not a current per-PR snapshot.
        prs = [pull_request(number) for number in numbers]
    candidates = candidate_prs(event_name, event, source, prs)
    if expected is not None and candidates != expected:
        raise ValueError("review selection changed while waiting")
    if manifest is not None:
        verified = []
        by_number = {pr["number"]: pr for pr in prs}
        for candidate in candidates:
            pr = by_number[candidate["number"]]
            matches = [task for task in manifest["tasks"]
                       if trusted_pull_request(task, pr, repository["full_name"])]
            if event_name == "workflow_run" and len(matches) != 1:
                raise ValueError("review requires unique persisted Jules provenance")
            if len(matches) == 1:
                verified.append(candidate)
        candidates = verified
    return {"admitted": bool(candidates), "reason": "review_candidates_verified" if candidates else "no_jules_lab_proposals",
            "pull_requests": candidates,
            "source_run_id": source["id"] if source else None,
            "source_run_attempt": source["run_attempt"] if source else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args(argv)
    result = {"admitted": False, "reason": "review_event_rejected", "pull_requests": []}
    status = 1
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        repository = config["repository"]
        pin = control_revision()
        if (os.environ.get("GITHUB_REF") != "refs/heads/main"
                or os.environ.get("GITHUB_REPOSITORY") != repository
                or os.environ.get("GITHUB_WORKFLOW_REF") != repository + "/.github/workflows/" + WORKFLOW + "@refs/heads/main"
                or os.environ.get("GITHUB_SHA") != pin
                or any(not re.fullmatch(r"[1-9][0-9]*", os.environ.get(key, ""))
                       for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"))):
            raise ValueError("review requires a pinned trusted main workflow")
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
        # The event-only pass runs before state checkout/load. A provenance pass
        # and the reporting job re-read only the previously selected revisions.
        selected = os.environ.get("REVIEW_CANDIDATES")
        expected = json.loads(selected) if selected is not None else None
        options = {"actor": os.environ.get("GITHUB_ACTOR", ""),
                   "get": lambda path: gh_get(repository, path), "expected": expected}
        result = admit_review(os.environ["GITHUB_EVENT_NAME"], event, config, **options)
        if args.manifest and result["admitted"]:
            from state_store import _manifest
            manifest = _manifest(args.manifest.read_bytes())
            options["expected"] = result["pull_requests"]
            result = admit_review(os.environ["GITHUB_EVENT_NAME"], event, config, manifest=manifest, **options)
        result["control_sha"] = pin
        status = 0
    except (ValueError, RuntimeError, OSError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        # Do not echo API errors, payloads or attacker-controlled event prose.
        result = {"admitted": False, "reason": "review_event_rejected", "pull_requests": []}
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as handle:
            handle.write("admitted=" + str(result["admitted"]).lower() + "\n")
            handle.write("candidates=" + json.dumps(result["pull_requests"], separators=(",", ":")) + "\n")
            if "control_sha" in result:
                handle.write("control_sha=" + result["control_sha"] + "\n")
    print(json.dumps({key: result[key] for key in ("admitted", "reason")}))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
