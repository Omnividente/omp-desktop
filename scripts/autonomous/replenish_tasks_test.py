#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from replenish_tasks import (  # noqa: E402
    finding_to_task, fingerprint, merge_tasks, parse_eslint, parse_tsc,
)


def test_parse_eslint_keeps_errors_only():
    data = [{"filePath": "/runner/work/omp/omp/src/App.tsx", "messages": [
        {"ruleId": "no-unused-vars", "line": 3, "severity": 2, "message": "x unused"},
        {"ruleId": "semi", "line": 5, "severity": 1, "message": "just a warning"},
    ]}]
    findings = parse_eslint(data)
    assert len(findings) == 1, findings
    assert findings[0]["path"] == "src/App.tsx", findings
    assert findings[0]["rule"] == "no-unused-vars", findings


def test_parse_tsc_extracts_diagnostics():
    text = "src/api.ts(12,5): error TS2345: bad type\nnoise line\n"
    findings = parse_tsc(text)
    assert len(findings) == 1, findings
    assert findings[0]["rule"] == "TS2345" and findings[0]["path"] == "src/api.ts", findings


def test_task_has_evidence_and_stable_id():
    finding = {"tool": "tsc", "rule": "TS1", "path": "src/a.ts", "line": 1, "message": "m"}
    task = finding_to_task(finding, "basesha")
    assert task["id"] == "auto-tsc-" + fingerprint("tsc", "TS1", "src/a.ts"), task
    assert task["evidence"]["source"] == "tsc", task
    assert task["evidence"]["base_commit"] == "basesha", task
    assert task["status"] == "todo" and task["risk"] == "low", task


def test_merge_is_idempotent_per_defect_class():
    finding = {"tool": "tsc", "rule": "TS1", "path": "src/a.ts", "line": 1, "message": "m"}
    task = finding_to_task(finding)
    manifest = {"tasks": [task]}
    _updated, added = merge_tasks(manifest, [task])
    assert added == [], added


def test_merge_adds_new_task():
    finding = {"tool": "eslint", "rule": "r", "path": "src/a.ts", "line": 1, "message": "m"}
    updated, added = merge_tasks({"tasks": []}, [finding_to_task(finding)])
    assert len(added) == 1, added
    assert updated["tasks"][0]["evidence"]["source"] == "eslint", updated


def main():
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok - " + name)
            except AssertionError as exc:
                failures += 1
                print("FAIL - " + name + ": " + str(exc))
    if failures:
        print(str(failures) + " test(s) failed")
        return 1
    print("all tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
