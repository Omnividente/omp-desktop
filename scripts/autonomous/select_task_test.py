#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from select_task import select  # noqa: E402


def _manifest(tasks, min_todo=3):
    return {"autonomous_loop_policy": {"min_todo_tasks": min_todo}, "tasks": tasks}


def test_selects_highest_priority_todo():
    m = _manifest([
        {"id": "a", "status": "todo", "priority": 10, "risk": "low", "focus": ["tests"]},
        {"id": "b", "status": "todo", "priority": 50, "risk": "low", "focus": ["tests"]},
    ])
    r = select(m)
    assert r["selected"] is True, r
    assert r["task_id"] == "b", r
    assert r["reason_code"] == "ready", r


def test_skips_non_todo():
    m = _manifest([
        {"id": "a", "status": "done", "priority": 10},
        {"id": "b", "status": "in_progress", "priority": 50},
    ])
    r = select(m)
    assert r["selected"] is False, r
    assert r["reason_code"] == "no_todo_tasks", r


def test_excluded_and_risk_and_focus():
    m = _manifest([
        {"id": "a", "status": "todo", "priority": 10, "risk": "high", "focus": ["tests"]},
        {"id": "b", "status": "todo", "priority": 20, "risk": "low", "focus": ["perf"]},
    ])
    r = select(m, focus=["tests"], risk_ceiling="medium")
    assert r["selected"] is False, r
    assert r["reason_code"] == "no_eligible_autonomous_task", r
    r2 = select(m, risk_ceiling="high", excluded_task_ids=["b"])
    assert r2["selected"] is True and r2["task_id"] == "a", r2


def test_explicit_task_id():
    m = _manifest([{"id": "a", "status": "todo", "priority": 10, "risk": "low"}])
    r = select(m, task_id="a")
    assert r["selected"] is True and r["reason_code"] == "explicit_task_selected", r
    r2 = select(m, task_id="zzz")
    assert r2["selected"] is False and r2["reason_code"] == "explicit_task_missing", r2


def test_replenishment_flag():
    m = _manifest([{"id": "a", "status": "todo", "priority": 1, "risk": "low"}], min_todo=3)
    r = select(m)
    assert r["replenishment_required"] is True, r


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
