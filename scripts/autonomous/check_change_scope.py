#!/usr/bin/env python3
"""Verify that changed files stay within the loop's allowed product scope.

The autonomous loop may only edit product source. This gate blocks any change
to release, version, updater, or control-plane files so the loop can never cut
a release or disable its own guardrails.
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


def evaluate(config: Mapping[str, Any], changed: Iterable[str]) -> dict:
    product = config.get("product") or {}
    editable = list(product.get("editable_globs") or [])
    excluded = list(product.get("excluded") or [])
    violations = []
    for raw in changed:
        path = str(raw).strip()
        if not path:
            continue
        if _match_any(path, excluded):
            violations.append({"path": path, "reason": "excluded"})
            continue
        if editable and not _match_any(path, editable):
            violations.append({"path": path, "reason": "outside_editable_scope"})
    return {"allowed": not violations, "violations": violations}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--changed-files", required=True, type=Path,
                        help="newline-delimited list of changed paths")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    config = json.loads(args.config.read_text(encoding="utf-8"))
    changed = [line for line in args.changed_files.read_text(encoding="utf-8").splitlines() if line.strip()]
    result = evaluate(config, changed)
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        for v in result["violations"]:
            print("BLOCKED " + v["path"] + " (" + v["reason"] + ")", file=sys.stderr)
        print("scope OK" if result["allowed"] else "scope violations found")
    return 0 if result["allowed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
