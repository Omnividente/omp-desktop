#!/usr/bin/env python3
"""Verify that changed files stay within the loop's allowed product scope.

Two independent boundaries are enforced, because "forbidden" and "needs a human"
are different answers:

* ``product.excluded`` is a hard block. A pull request touching these paths is
  refused outright, so the loop can never cut a release, bump a version, or
  rewrite its own guardrails.
* ``product.manual_review_paths`` is a soft block. The loop may propose changes
  there, but they can never land unattended: automerge downgrades such a pull
  request to manual review so a human accepts it explicitly. The auto-update
  machinery lives here - it is product code, but shipping a broken updater is
  unrecoverable, so it is never merged by a robot.

Pattern matching is fnmatch-based and deliberately ignores directory
boundaries, so ``*.test.ts`` matches ``src/api.test.ts`` as well as
``src/nested/api.test.ts``. A trailing slash marks a directory prefix.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping


def _match_any(path: str, patterns: Iterable[str]) -> bool:
    for pattern in patterns:
        p = str(pattern).rstrip()
        if not p:
            continue
        if p.endswith("/"):
            if path == p[:-1] or path.startswith(p):
                return True
            continue
        if fnmatch.fnmatch(path, p):
            return True
        if "*" not in p and (path == p or path.startswith(p + "/")):
            return True
    return False


def _paths(changed: Iterable[str]) -> list:
    return [str(raw).strip() for raw in changed if str(raw).strip()]


def evaluate(config: Mapping[str, Any], changed: Iterable[str]) -> dict:
    """Hard scope check: which changed paths the loop must never touch at all."""
    product = config.get("product") or {}
    editable = list(product.get("editable_globs") or [])
    excluded = list(product.get("excluded") or [])
    violations = []
    for path in _paths(changed):
        if _match_any(path, excluded):
            violations.append({"path": path, "reason": "excluded"})
            continue
        if editable and not _match_any(path, editable):
            violations.append({"path": path, "reason": "outside_editable_scope"})
    return {"allowed": not violations, "violations": violations}


def manual_review_hits(config: Mapping[str, Any], changed: Iterable[str]) -> list:
    """Soft scope check: changed paths that require an explicit human approval."""
    product = config.get("product") or {}
    patterns = list(product.get("manual_review_paths") or [])
    if not patterns:
        return []
    return [path for path in _paths(changed) if _match_any(path, patterns)]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--changed-files", required=True, type=Path,
                        help="newline-delimited list of changed paths")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    config = json.loads(args.config.read_text(encoding="utf-8"))
    changed = [
        line for line in args.changed_files.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    result = evaluate(config, changed)
    result["manual_review"] = manual_review_hits(config, changed)
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        for v in result["violations"]:
            print("BLOCKED " + v["path"] + " (" + v["reason"] + ")", file=sys.stderr)
        for path in result["manual_review"]:
            print("MANUAL REVIEW " + path, file=sys.stderr)
        print("scope OK" if result["allowed"] else "scope violations found")
    return 0 if result["allowed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
