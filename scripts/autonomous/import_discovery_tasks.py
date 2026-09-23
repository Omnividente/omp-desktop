#!/usr/bin/env python3
"""Import discovery findings only from an accepted immutable session report.

A discovery run that only *describes* follow-up work is wasted effort: nothing
reads the prose, so the loop rediscovers the same findings next tick. The
discovery prompt therefore requires a machine-readable block:

    <!-- AUTONOMOUS_TASKS_BEGIN -->
    ```json
    [ { "title": "...", "task_type": "bugfix", "evidence": { ... } } ]
    ```
    <!-- AUTONOMOUS_TASKS_END -->

This script parses that block, normalises actionable reports, links exact replays
and defers uncertain overlaps without discarding their evidence. It appends reported
claims, not verified facts. Missing reproduction stays deferred; malformed packaging
fails loudly. The resulting
manifest must pass the ordinary validator before the controller persists it.

"Loudly" is the whole point: a JSON error used to be swallowed into an empty
backlog, which is indistinguishable from "the worker found nothing". The block is
machine-readable by contract, so a block that is not parseable is reported as
``malformed_block`` with a non-zero exit code and a ``::error::`` annotation. The
caller still commits whatever other queue changes it made, then fails the job.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_tasks import (  # noqa: E402
    VALID_RISKS, VALID_TASK_TYPES, validate, validate_reproduction,
    _utc_timestamp, _validate_report_source,
)
from check_change_scope import evaluate as evaluate_scope  # noqa: E402
from task_lifecycle import find_task  # noqa: E402
from select_task import pending_rejection  # noqa: E402
from research_request import (CONTRACT_VERSION, MAX_REVISIT_TEXT_CHARS, CHANGE_KINDS,
                              EVIDENCE_MODES, sha256_json, sha256_text, validate_task_request)

BEGIN = "AUTONOMOUS_TASKS_BEGIN"
END = "AUTONOMOUS_TASKS_END"
BLOCK_RE = re.compile(BEGIN + r"(.*?)" + END, re.DOTALL)
DEFAULT_PRIORITY = 45
DEFAULT_MAX_NEW = 10

STATUS_OK = "ok"
STATUS_ABSENT = "absent"
STATUS_MALFORMED = "malformed_block"


def _fingerprint(text: str) -> str:
    return hashlib.sha256(text.strip().lower().encode("utf-8")).hexdigest()[:16]


def parse_block(text: str) -> dict:
    """Pull the JSON array out of the marked block and say why it failed.

    Returns ``status`` (ok / absent / malformed_block), the parsed ``entries``
    and a human ``detail``. A missing block is a legitimate answer - not every
    pull request carries a backlog. A *broken* block is a defect: the prompt
    guarantees machine-readable JSON, so silently reading it as "no findings"
    would erase real work.
    """
    text = str(text or "")
    if BEGIN not in text and END not in text:
        return {
            "status": STATUS_ABSENT, "entries": [],
            "detail": "no " + BEGIN + " block was present",
        }
    match = BLOCK_RE.search(text)
    if text.count(BEGIN) != 1 or text.count(END) != 1 or match is None:
        return {
            "status": STATUS_MALFORMED, "entries": [],
            "detail": "expected exactly one ordered pair of backlog delimiters",
        }
    body = match.group(1).strip()
    if body.startswith("-->"):
        body = body[3:].strip()
    if body.endswith("<!--"):
        body = body[:-4].strip()
    fenced = re.fullmatch(r"```(?:json)?\s*\n(.*?)\n```", body, re.DOTALL)
    if fenced:
        body = fenced.group(1)
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        return {
            "status": STATUS_MALFORMED, "entries": [],
            "detail": "the " + BEGIN + " block is not valid JSON: " + str(exc),
        }
    if not isinstance(parsed, list):
        return {
            "status": STATUS_MALFORMED, "entries": [],
            "detail": "the " + BEGIN + " block must contain a JSON array",
        }
    entries = [item for item in parsed if isinstance(item, dict)]
    if len(entries) != len(parsed):
        return {
            "status": STATUS_MALFORMED, "entries": [],
            "detail": "the task array contains entries that are not objects",
        }
    if any(entry.get("acceptance") is not None and not isinstance(entry["acceptance"], list)
           for entry in entries):
        return {
            "status": STATUS_MALFORMED, "entries": [],
            "detail": "task acceptance must be an array",
        }
    return {
        "status": STATUS_OK, "entries": entries,
        "detail": str(len(entries)) + " task entry/entries parsed",
    }


def extract_block(text: str) -> list:
    """Backwards-compatible view of parse_block: the entries only."""
    return parse_block(text)["entries"]


def sanitize_revisit(value: Any) -> dict:
    """Retain bounded worker claims, never their authority or arbitrary metadata."""
    if not isinstance(value, dict):
        return {}
    result = {}
    for field in ("contract_version", "change_kind", "difference", "evidence_mode",
                  "primary_decision_task_id"):
        item = value.get(field)
        if isinstance(item, str) and len(item) <= MAX_REVISIT_TEXT_CHARS:
            result[field] = item
        elif field in value:
            result[field] = ""
    refs = value.get("observation_refs")
    if isinstance(refs, list) and len(refs) <= 100:
        result["observation_refs"] = [item if type(item) is int else None for item in refs]
    responses = value.get("responses")
    if isinstance(responses, list) and len(responses) <= 100:
        result["responses"] = [
            {field: item[field] for field in ("decision_task_id", "decision_context_id",
                                             "why_previous_reason_no_longer_explains")
             if isinstance(item.get(field), str) and len(item[field]) <= MAX_REVISIT_TEXT_CHARS}
            if isinstance(item, dict) else {} for item in responses
        ]
    return result


def stable_candidate(candidate: Mapping[str, Any]) -> dict:
    return copy.deepcopy({field: candidate[field] for field in (
        "task_type", "title", "risk", "priority", "focus", "target_paths", "acceptance", "evidence"
    ) if field in candidate})


def normalize(entry: Mapping[str, Any], *, now: str) -> dict:
    title = str(entry.get("title") or "").strip()
    evidence = entry.get("evidence")
    if not isinstance(evidence, dict):
        evidence = {}
    detail = str(evidence.get("detail") or entry.get("detail") or "").strip()
    task_type = str(entry.get("task_type") or "product_improvement")
    if task_type not in VALID_TASK_TYPES or task_type == "project_discovery":
        task_type = "product_improvement"
    risk = str(entry.get("risk") or "low")
    if risk not in VALID_RISKS:
        risk = "low"
    try:
        priority = int(entry.get("priority", DEFAULT_PRIORITY))
    except (TypeError, ValueError, OverflowError):
        priority = DEFAULT_PRIORITY
    priority = max(1, min(90, priority))
    focus = entry.get("focus")
    if not isinstance(focus, list):
        focus = ["quality"]
    acceptance = entry.get("acceptance")
    if not isinstance(acceptance, list):
        acceptance = []
    task_id = str(entry.get("id") or "").strip() or ("discovery-" + _fingerprint(title))
    return {
        "id": task_id,
        "title": title,
        "task_type": task_type,
        "status": "proposed",
        "priority": priority,
        "risk": risk,
        "focus": [str(item) for item in focus],
        "created_at": now,
        "acceptance": [
            str(item) for item in acceptance
        ] or ["A failing-first regression test proves the change"],
        "evidence": {
            "source": str(evidence.get("source") or "project_discovery"),
            "detail": detail,
            "status": "reported",
            **({"reproduction": {
                "steps": list(evidence["reproduction"]["steps"]),
                "expected": evidence["reproduction"]["expected"],
                "actual": evidence["reproduction"]["actual"],
            }} if not validate_reproduction(evidence.get("reproduction")) else {}),
            **({"revisit": sanitize_revisit(evidence["revisit"])} if "revisit" in evidence else {}),
        },
        **({"target_paths": list(entry["target_paths"])}
           if isinstance(entry.get("target_paths"), list) else {}),
    }


def finding_error(entry: Mapping[str, Any], config: Mapping[str, Any]) -> str:
    """Worker output cannot expand the trusted product or execution boundary."""
    for field in ("title",):
        if not isinstance(entry.get(field), str) or not entry[field].strip():
            return "missing_" + field
    evidence = entry.get("evidence")
    if not isinstance(evidence, dict) or any(
        not isinstance(evidence.get(field), str) or not evidence[field].strip()
        for field in ("source", "detail")
    ):
        return "missing_evidence"
    for field in ("acceptance", "target_paths"):
        values = entry.get(field)
        if not isinstance(values, list) or not values or any(
            not isinstance(value, str) or not value.strip() for value in values
        ):
            return "missing_" + field
    if entry.get("task_type") == "project_discovery":
        return "unsafe_discovery_child"
    task_type = entry.get("task_type", "product_improvement")
    if not isinstance(task_type, str) or task_type not in VALID_TASK_TYPES:
        return "invalid_task_type"
    risk = entry.get("risk", "low")
    ranks = {"low": 0, "medium": 1, "high": 2}
    if not isinstance(risk, str) or risk not in ranks:
        return "invalid_risk"
    if ranks[risk] > ranks.get(config.get("risk_ceiling", "medium"), 1):
        return "unsafe_risk"
    paths = entry["target_paths"]
    if any(path != path.strip() or "\\" in path or ":" in path or path.startswith("/")
           or any(part in ("", ".", "..") for part in path.split("/"))
           or any(char in path for char in "*?[]") for path in paths):
        return "unsafe_target_paths"
    if not (config.get("product") or {}).get("editable_globs"):
        return "unsafe_missing_product_scope"
    if not evaluate_scope(config, paths)["allowed"]:
        return "unsafe_product_scope"
    return ""


# Boilerplate and location names cannot establish a shared behavioral contract.
_COMMON_WORDS = frozenset("""
a an the and or to of in on at by for from with without when while then that this
these those it its is are was were be been being as also can could should would
will must not no new old current another using use used set get has have had
support supports supported file files path paths src test tests ts tsx js jsx
fix issue bug defect problem regression failing first proves change expected actual
observed observe observation result returns returned return explicit explicitly
model models selector string value values state data ui component application
""".split())


def _finding_profile(task: Mapping[str, Any]) -> dict:
    paths = {path for path in task.get("target_paths", []) if isinstance(path, str)
             and not any(char in path for char in "*?[]")}
    location_words = set()
    for path in paths:
        location_words.update(re.findall(r"[a-z0-9]+", path.lower()))

    def words(text: str) -> set[str]:
        tokens = set()
        for token in re.findall(r"[a-z][a-z0-9]+", text.lower()):
            if token in _COMMON_WORDS or token in location_words:
                continue
            # Inflection only: no domain-specific synonym map or fuzzy spelling.
            if len(token) > 5 and token.endswith("ing"):
                token = token[:-3]
            elif len(token) > 4 and token.endswith("ed"):
                token = token[:-2]
            elif len(token) > 4 and token.endswith("s"):
                token = token[:-1]
            tokens.add(token)
        return tokens

    evidence = task.get("evidence") or {}
    reproduction = evidence.get("reproduction") or {}
    fields = {
        "title": str(task.get("title") or ""),
        "acceptance": " ".join(task.get("acceptance") or []),
        "expected": str(reproduction.get("expected") or ""),
        "actual": str(reproduction.get("actual") or ""),
        "detail": str(evidence.get("detail") or ""),
        "steps": " ".join(reproduction.get("steps") or []),
    }
    # Exact code identifiers and literal modifiers are useful anchors, but a
    # shared path or function name alone never proves a duplicate.
    def anchors(text: str) -> set[str]:
        for path in paths:
            text = text.replace(path, " ")
        return {value.lower() for value in re.findall(
            r":[a-zA-Z][\w-]*|\b[a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b|\b[a-z]+_[a-z_]+\b", text
        ) if value.lower() not in location_words}

    return {"task": task, "paths": paths, "fields": fields,
            "words": {key: words(value) for key, value in fields.items()},
            "anchors": anchors(" ".join(fields.values())),
            "contract": (task.get("task_type"), task.get("target_paths"), fields["title"],
                         tuple(task.get("acceptance") or []), fields["detail"],
                         tuple(reproduction.get("steps") or []), fields["expected"], fields["actual"])}


def _overlap(left: set[str], right: set[str]) -> float:
    return len(left & right) / max(len(left), len(right), 1)


def _finding_match(left: dict, right: dict) -> str:
    if not left["paths"].intersection(right["paths"]):
        return ""
    a, b = left["words"], right["words"]
    # Token similarity can only identify a review lead. Negation, preconditions
    # and ordered reproduction steps must never be lost in a proven duplicate.
    title_overlap = _overlap(a["title"], b["title"])
    acceptance_overlap = _overlap(a["acceptance"], b["acceptance"])
    shared_contract = (a["title"] | a["acceptance"]) & (b["title"] | b["acceptance"])
    shared_anchors = left["anchors"] & right["anchors"]
    if (left["paths"] == right["paths"] and left["contract"] == right["contract"]
            and not validate_reproduction((left["task"].get("evidence") or {}).get("reproduction"))):
        return "duplicate"
    # Similarity is a review lead, never silently promoted to a proven match.
    if (len(shared_contract) >= 3 and max(title_overlap, acceptance_overlap) >= 0.45
            and (shared_anchors or len(a["actual"] & b["actual"]) >= 2)):
        return "possible_duplicate"
    return ""


def _closed_finding(task: Mapping[str, Any]) -> bool:
    return (task.get("status") in {"done", "closed", "rejected", "cancelled"}
            or (task.get("proposal_decision") or {}).get("action") == "reject")


def _historical_profiles(tasks: list) -> list:
    profiles = []
    for task in tasks:
        if not isinstance(task, dict) or task.get("task_type") == "project_discovery":
            continue
        decision = task.get("proposal_decision") or {}
        if (task.get("status") != "done" or decision.get("action") not in {"reject", "resolve"}
                or pending_rejection(task)):
            continue
        if not _utc_timestamp(decision.get("at")):
            raise ValueError("historical proposal decision requires a UTC timestamp")
        profiles.append((_finding_profile(task), decision,
                         datetime.fromisoformat(decision["at"].replace("Z", "+00:00"))))
    # Stable sorts retain task identity ordering for decisions at the same instant.
    profiles.sort(key=lambda item: item[0]["task"]["id"])
    profiles.sort(key=lambda item: item[2], reverse=True)
    return profiles


def _historical_review_context(profile: dict, profiles: list, report_at: datetime) -> dict | None:
    matches = []
    title = profile["fields"]["title"].strip().lower()
    for previous, decision, decision_at in profiles:
        verdict = _finding_match(profile, previous)
        match = {"duplicate": "exact", "possible_duplicate": "possible"}.get(verdict)
        if not match and previous["fields"]["title"].strip().lower() == title:
            match = "same_title"
        if match:
            matches.append({"task_id": previous["task"]["id"], "action": decision["action"],
                            "decision_at": decision["at"], "match": match,
                            "timing": "pre" if report_at <= decision_at else "post"})
    if not matches:
        return None
    rank = {"exact": 0, "possible": 1, "same_title": 2}
    matches.sort(key=lambda item: (rank[item["match"]],
                                   -datetime.fromisoformat(item["decision_at"].replace("Z", "+00:00")).timestamp(),
                                   item["task_id"]))
    return {"kind": "historical_decision_overlap", "matches": matches}


def post_admission(candidate: dict, context: dict, source: dict, tasks_by_id: dict) -> str:
    """Check delivery and report-local links, not the truth of worker explanations."""
    strong = [item for item in context["matches"]
              if item["timing"] == "post" and item["match"] != "same_title"]
    required = [(item, tasks_by_id[item["task_id"]]["proposal_decision"].get("note"))
                for item in strong]
    required = [(item, note) for item, note in required if isinstance(note, str) and note.strip()]
    if not required:
        context.update(rationale_status="unknown", post_gate="not_applicable_no_rationale")
        return ""
    context["rationale_status"] = "recorded"
    request = source["execution"]["research_request"]
    delivered = request.get("decision_context", [])
    linked = []
    for match, note in required:
        entries = [entry for entry in delivered if isinstance(entry, dict)
                   and entry.get("task_id") == match["task_id"]
                   and entry.get("action") == match["action"]
                   and entry.get("decision_at") == match["decision_at"]
                   and entry.get("complete") is True and entry.get("truncated") is False
                   and entry.get("full_note_sha256") == sha256_text(note)
                   and entry.get("delivered_text") == note
                   and entry.get("delivered_sha256") == sha256_text(note)
                   and entry.get("context_id") == sha256_json({key: value for key, value in entry.items()
                                                                            if key != "context_id"})]
        if len(entries) != 1:
            context["post_gate"] = "historical_post_context_missing"
            return context["post_gate"]
        linked.append((match["task_id"], entries[0]["context_id"]))
    revisit = candidate["evidence"].get("revisit", {})
    refs, responses = revisit.get("observation_refs"), revisit.get("responses")
    observations = source["research_result"].get("observations", [])
    valid = (revisit.get("contract_version") == CONTRACT_VERSION
             and revisit.get("change_kind") in CHANGE_KINDS
             and isinstance(revisit.get("difference"), str) and bool(revisit["difference"].strip())
             and revisit.get("evidence_mode") in EVIDENCE_MODES
             and isinstance(refs, list) and bool(refs)
             and all(type(ref) is int and 0 <= ref < len(observations) for ref in refs)
             and len(refs) == len(set(refs))
             and revisit.get("primary_decision_task_id") == strong[0]["task_id"]
             and isinstance(responses, list) and len(responses) == len(linked))
    if valid:
        response_links = []
        for response in responses:
            explanation = response.get("why_previous_reason_no_longer_explains")
            if (not isinstance(explanation, str) or not explanation.strip()
                    or not isinstance(response.get("decision_task_id"), str)
                    or not isinstance(response.get("decision_context_id"), str)):
                valid = False
                break
            response_links.append((response.get("decision_task_id"), response.get("decision_context_id")))
        valid = valid and sorted(response_links) == sorted(linked)
    reason = "" if valid else "historical_post_unexplained"
    if valid and revisit["evidence_mode"] in {"hypothesis", "unavailable"}:
        reason = "historical_post_insufficient_evidence"
    context["post_gate"] = reason or "passed"
    return reason


def post_deferred(candidate: dict, context: dict, origin: Mapping[str, str], reason: str) -> dict:
    stable = stable_candidate(candidate)
    source = dict(origin)
    return {"title": candidate["title"], "reason": reason,
            "evidence": json.dumps(candidate["evidence"], ensure_ascii=False, sort_keys=True),
            "target_paths": list(candidate["target_paths"]), "acceptance": list(candidate["acceptance"]),
            "deferred_id": sha256_json({"source": source, "candidate": stable}),
            "candidate": stable, "review_context": copy.deepcopy(context), "source": source}


def import_tasks(manifest: dict, body: str, *, config: Mapping[str, Any],
                 max_new: int = DEFAULT_MAX_NEW, now: str | None = None,
                 origin: Mapping[str, str] | None = None) -> dict:
    stamp = now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if not isinstance(origin, Mapping):
        raise ValueError("discovery import requires an accepted session report origin")
    source = find_task(manifest, origin.get("task_id"))
    execution = (source or {}).get("execution") or {}
    accepted = (source or {}).get("research_result", {}).get("source")
    stored = str(execution.get("session_id") or "")
    resource = stored if stored.startswith("sessions/") else "sessions/" + stored
    if (not source or not stored or not execution.get("dispatch_key")
            or not isinstance(accepted, Mapping) or dict(origin) != {"task_id": source["id"], **accepted}
            or any(origin.get(field) != execution.get(field) for field in ("session_id", "dispatch_key"))
            or not re.fullmatch(re.escape(resource) + r"/activities/[^/]+", str(origin.get("activity_id") or ""))
            or origin.get("report_sha256") != hashlib.sha256(body.encode("utf-8")).hexdigest()):
        raise ValueError("discovery origin does not identify the accepted session report")
    source_errors = _validate_report_source(dict(accepted), "discovery origin")
    if source_errors:
        raise ValueError("; ".join(source_errors))
    if not isinstance(config, Mapping):
        raise ValueError("discovery import requires trusted product configuration")
    receipt = source.get("discovery_import")
    if receipt is not None:
        if validate(manifest) or receipt.get("source") != accepted:
            raise ValueError("invalid discovery import receipt")
        result = copy.deepcopy(receipt["result"])
        result["skipped"].extend({"id": identifier, "reason": "duplicate_id",
                                  "existing_task_id": identifier} for identifier in result["added"])
        result.update(changed=False, duplicates=list(dict.fromkeys(result["added"] + result["duplicates"])), added=[])
        return result
    request_errors = validate_task_request(source)
    if request_errors:
        raise ValueError("; ".join(request_errors))
    versioned = execution.get("research_request", {}).get("contract_version") == CONTRACT_VERSION
    report_at = datetime.fromisoformat(origin["activity_created_at"].replace("Z", "+00:00"))
    block = parse_block(body)
    tasks = manifest.get("tasks", [])
    known_ids = {str(task.get("id")): task for task in tasks if isinstance(task, dict)}
    profiles = [_finding_profile(task) for task in tasks
                if isinstance(task, dict) and task.get("task_type") != "project_discovery"
                and (not _closed_finding(task) or task.get("origin") == origin)]
    historical_profiles = None
    pending, added, skipped, duplicates, deferred = [], [], [], [], []
    invalid = block["status"] == STATUS_MALFORMED
    for entry in block["entries"]:
        candidate = normalize(entry, now=stamp)
        reason = finding_error(entry, config)
        if not reason and "reproduction" not in candidate["evidence"]:
            reason = "unverified_finding"
        if reason:
            skipped.append({"id": candidate["id"], "reason": reason})
            can_defer = reason.startswith("unsafe_") or reason == "unverified_finding"
            invalid = invalid or not can_defer
            if can_defer:
                deferred.append({"title": candidate["title"], "reason": reason,
                                 "evidence": json.dumps(entry["evidence"], ensure_ascii=False, sort_keys=True),
                                 "target_paths": candidate.get("target_paths", []),
                                 "acceptance": candidate["acceptance"]})
            continue
        title = candidate["title"].strip().lower()
        profile = _finding_profile(candidate)
        match, suspicion = None, None
        for previous in profiles:
            verdict = _finding_match(profile, previous)
            if verdict == "duplicate":
                match = previous["task"]
                break
            same_title = str(previous["task"].get("title") or "").strip().lower() == title
            if suspicion is None and (verdict == "possible_duplicate" or same_title):
                suspicion = previous["task"]
        if match is not None:
            skipped.append({"id": candidate["id"], "reason": "duplicate_contract",
                            "existing_task_id": match["id"]})
            if match["id"] not in duplicates:
                duplicates.append(match["id"])
            continue
        if suspicion is not None:
            skipped.append({"id": candidate["id"], "reason": "possible_duplicate",
                            "existing_task_id": suspicion["id"]})
            deferred.append({
                "title": candidate["title"], "reason": "possible_duplicate",
                "evidence": "Possible overlap with existing task " + suspicion["id"]
                            + "; not established as a duplicate. "
                            + json.dumps(entry["evidence"], ensure_ascii=False, sort_keys=True),
                "target_paths": candidate.get("target_paths", []), "acceptance": candidate["acceptance"],
            })
            continue
        if historical_profiles is None:
            historical_profiles = _historical_profiles(tasks)
        context = _historical_review_context(profile, historical_profiles, report_at)
        if context:
            strong = [item for item in context["matches"] if item["match"] != "same_title"]
            if strong and all(item["timing"] == "pre" for item in strong):
                reason = "historical_predecision_overlap"
                skipped.append({"id": candidate["id"], "reason": reason,
                                "existing_task_id": strong[0]["task_id"]})
                deferred.append({
                    "title": candidate["title"], "reason": reason,
                    "evidence": json.dumps(entry["evidence"], ensure_ascii=False, sort_keys=True),
                    "target_paths": candidate.get("target_paths", []), "acceptance": candidate["acceptance"],
                    "review_context": context,
                })
                continue
            if versioned and any(item["timing"] == "post" for item in strong):
                reason = post_admission(candidate, context, source, known_ids)
                if reason:
                    skipped.append({"id": candidate["id"], "reason": reason,
                                    "existing_task_id": next(item["task_id"] for item in strong
                                                             if item["timing"] == "post")})
                    item = post_deferred(candidate, context, origin, reason)
                    if not any(previous.get("deferred_id") == item["deferred_id"] for previous in deferred):
                        deferred.append(item)
                    continue
            candidate["review_context"] = context
        if len(added) >= max_new:
            skipped.append({"id": candidate["id"], "reason": "max_new_reached"})
            invalid = True
            continue
        if candidate["id"] in known_ids:
            # Worker IDs (including title hashes) are suggestions, not authority
            # over an existing proposal. Bind a new identity to the exact claim
            # and immutable report; never rewrite an earlier decision.
            material = json.dumps({"id": candidate["id"], "origin": dict(origin),
                                   "contract": profile["contract"]}, sort_keys=True, ensure_ascii=False)
            identifier = "discovery-" + hashlib.sha256(material.encode("utf-8")).hexdigest()
            candidate["id"] = identifier
            suffix = 0
            while candidate["id"] in known_ids:
                suffix += 1
                candidate["id"] = identifier + "-" + str(suffix)
        candidate["origin"] = dict(origin)
        pending.append(candidate)
        known_ids[candidate["id"]] = candidate
        profiles.append(profile)
        added.append(candidate["id"])

    if invalid:
        return {"changed": False, "added": [], "duplicates": [], "skipped": skipped,
                "deferred": deferred, "status": STATUS_MALFORMED,
                "detail": "incomplete discovery findings; nothing imported"}
    result = {
        "changed": bool(added or duplicates or deferred), "added": added,
        "duplicates": duplicates, "skipped": skipped, "deferred": deferred,
        "unverified_count": sum(item["reason"] == "unverified_finding" for item in deferred),
        "status": block["status"], "detail": block["detail"],
    }
    if result["changed"]:
        receipt = {"source": copy.deepcopy(accepted), "result": copy.deepcopy(result)}
        staged_source = dict(source, discovery_import=receipt)
        if versioned:
            staged_report = copy.deepcopy(source["research_result"])
            staged_report["deferred_findings"] = copy.deepcopy(deferred)
            staged_source["research_result"] = staged_report
        staged = dict(manifest, tasks=[staged_source if task is source else task for task in tasks] + pending)
        if validate(staged):
            raise ValueError("discovery import would create an invalid queue")
        source["discovery_import"] = receipt
        if versioned:
            source["research_result"] = staged_report
        tasks.extend(pending)
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--source-task-id", default="")
    parser.add_argument("--body-file", type=Path)
    parser.add_argument("--body", default="")
    parser.add_argument("--max-new", type=int, default=DEFAULT_MAX_NEW)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--github-output", default="")
    args = parser.parse_args(argv)

    body = args.body
    if args.body_file and args.body_file.exists():
        body = args.body_file.read_text(encoding="utf-8")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    config = json.loads(args.config.read_text(encoding="utf-8"))
    source = find_task(manifest, args.source_task_id)
    report_source = (source or {}).get("research_result", {}).get("source")
    if not isinstance(report_source, dict):
        print("::error::import requires a previously accepted immutable session report", file=sys.stderr)
        return 1
    origin = {"task_id": source["id"], **report_source}
    try:
        result = import_tasks(manifest, body, max_new=args.max_new, config=config, origin=origin)
    except ValueError as exc:
        print("::error::" + str(exc), file=sys.stderr)
        return 1

    if result["changed"]:
        errors = validate(manifest)
        if errors:
            for err in errors:
                print("::error::imported backlog is invalid: " + err, file=sys.stderr)
            return 1
        (args.out or args.manifest).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            handle.write(
                "imported_changed=" + ("true" if result["changed"] else "false") + "\n"
            )
            handle.write("imported_count=" + str(len(result["added"])) + "\n")
            handle.write("imported_status=" + str(result.get("status", STATUS_OK)) + "\n")
            handle.write("unverified_count=" + str(result.get("unverified_count", 0)) + "\n")
    if result.get("status") == STATUS_MALFORMED:
        print(
            "::error::discovery backlog was not imported: " + str(result.get("detail")),
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
