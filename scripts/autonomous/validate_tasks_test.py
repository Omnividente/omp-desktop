#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_tasks import validate  # noqa: E402


def _task(**over):
    base = {
        "id": "t1", "title": "x", "status": "todo", "task_type": "bugfix",
        "risk": "low", "priority": 1, "focus": ["tests"],
        "evidence": {"source": "ci", "detail": "d"},
    }
    base.update(over)
    return base


def test_valid():
    m = {"version": 1, "autonomous_loop_policy": {}, "tasks": [_task()]}
    assert validate(m) == [], validate(m)


def test_missing_evidence():
    t = _task()
    del t["evidence"]
    m = {"version": 1, "autonomous_loop_policy": {}, "tasks": [t]}
    errs = validate(m)
    assert any("evidence" in e for e in errs), errs


def test_bad_status_and_dupe():
    m = {"version": 1, "autonomous_loop_policy": {}, "tasks": [_task(status="nope"), _task()]}
    errs = validate(m)
    assert any("status" in e for e in errs), errs
    assert any("duplicated" in e for e in errs), errs


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
