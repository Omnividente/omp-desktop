#!/usr/bin/env python3
"""Turn "the regression test fails before the fix" into an executable plan.

The prompt asks the AI worker for a failing-first regression test, but a prompt
is not a guarantee. This module decides, from the diff alone, what a proof run
must do:

* ``no_source_change``    - no product source or tests changed; no proof performed.
* ``test_only``           - tests changed without source; no failing-first proof.
* ``missing_test``        - product source changed with no accompanying test: unprovable.
* ``proof_required_ts``   - TypeScript source plus TypeScript tests: the gate reverts
                            the source to the base revision and requires the new test
                            to FAIL, then restores the fix and requires it to PASS.
* ``proof_unsupported``   - the diff needs a proof this gate cannot run offline
                            (for example Rust sources); the required check fails.

The gate never reports a regression proof for a diff it did not actually prove.
The proposal report preserves this limitation even when quality checks pass.
A failed unsupported, test-only or missing-test gate requires supported proof or
a separate explicit owner server-side bypass, never merely a PR approval. The
report's manual_bypass_required decision is not readiness and performs no bypass.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_change_scope import _match_any  # noqa: E402

DEFAULT_TEST_GLOBS = (
    "*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx", "src-tauri/tests/**",
)
TS_TEST_SUFFIXES = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")
TS_SOURCE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css")

MODE_NO_SOURCE = "no_source_change"
MODE_TEST_ONLY = "test_only"
MODE_MISSING_TEST = "missing_test"
MODE_PROOF_TS = "proof_required_ts"
MODE_UNSUPPORTED = "proof_unsupported"

PROVABLE_MODES = (MODE_PROOF_TS,)


def plan(config: Mapping[str, Any], changed: Iterable[str]) -> dict:
    product = config.get("product") or {}
    gate = config.get("merge_gate") or {}
    test_globs = list(gate.get("test_globs") or DEFAULT_TEST_GLOBS)
    excluded = list(product.get("excluded") or [])

    paths = [str(raw) for raw in changed if str(raw)]
    tests = [p for p in paths if _match_any(p, test_globs)]
    test_set = set(tests)
    source = [p for p in paths if p not in test_set and not _match_any(p, excluded)]

    ts_tests = [p for p in tests if p.endswith(TS_TEST_SUFFIXES)]
    non_ts_tests = [p for p in tests if not p.endswith(TS_TEST_SUFFIXES)]
    non_ts_source = [p for p in source if not p.endswith(TS_SOURCE_SUFFIXES)]

    if not source:
        mode = MODE_TEST_ONLY if tests else MODE_NO_SOURCE
    elif not tests:
        mode = MODE_MISSING_TEST
    elif non_ts_source or non_ts_tests or not ts_tests:
        mode = MODE_UNSUPPORTED
    else:
        mode = MODE_PROOF_TS

    return {
        "mode": mode,
        "proof_supported": mode in PROVABLE_MODES,
        "test_files": tests,
        "ts_test_files": ts_tests,
        "source_files": source,
        "unsupported_paths": sorted(set(non_ts_source) | set(non_ts_tests)),
    }


def explain(result: Mapping[str, Any]) -> str:
    mode = str(result.get("mode"))
    if mode == MODE_NO_SOURCE:
        return "No product source changed, so there is no regression to reproduce."
    if mode == MODE_TEST_ONLY:
        return (
            "Only tests changed: reverting product source cannot establish failing-first "
            "evidence. Review the assertions and coverage, but owner approval does not "
            "satisfy a failed required check. Add supported proof or request a separate "
            "explicit owner server-side bypass; passing tests alone are not proof of a fix."
        )
    if mode == MODE_MISSING_TEST:
        return (
            "Product source changed without any accompanying test, so the claim that a "
            "regression existed cannot be reproduced. Add a failing-first test and rerun "
            "the gate, or request a separate explicit owner server-side bypass. Owner "
            "approval alone does not satisfy the failed required check."
        )
    if mode == MODE_UNSUPPORTED:
        paths = ", ".join(result.get("unsupported_paths") or []) or "unknown paths"
        return (
            "This diff needs a proof run this gate cannot perform offline ("
            + paths + "). Add supported proof or request a separate explicit owner "
            "server-side bypass. Owner approval alone does not satisfy the failed "
            "required check."
        )
    return (
        "Reverting the source changes must make "
        + ", ".join(result.get("ts_test_files") or [])
        + " fail; restoring them must make it pass."
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--changed-files", required=True, type=Path)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--github-output", default="")
    args = parser.parse_args(argv)

    config = json.loads(args.config.read_text(encoding="utf-8"))
    changed = json.loads(args.changed_files.read_text(encoding="utf-8"))
    if not isinstance(changed, list) or any(not isinstance(path, str) for path in changed):
        parser.error("--changed-files must contain a JSON array of paths")
    result = plan(config, changed)
    print(json.dumps(result, ensure_ascii=False, indent=None if args.json else 2))
    print(explain(result))
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            handle.write("mode=" + result["mode"] + "\n")
            handle.write(
                "proof_supported="
                + ("true" if result["proof_supported"] else "false") + "\n"
            )
            handle.write("ts_test_files=" + json.dumps(result["ts_test_files"]) + "\n")
            handle.write("source_files=" + json.dumps(result["source_files"]) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
