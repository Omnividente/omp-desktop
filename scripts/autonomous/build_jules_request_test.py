#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_jules_request import build, dispatch_key  # noqa: E402
from jules_dispatch import extract_key  # noqa: E402

TEMPLATE = "Task {{TASK_ID}} on {{INTEGRATION_BRANCH}} base {{BASE_COMMIT}}\n{{TASK_JSON}}"


def test_marker_matches_dispatch_key():
    task = {"id": "task-9", "title": "Fix thing"}
    body = build(task, template=TEMPLATE, repo="o/r", branch="autonomous/lab",
                 base_sha="deadbeef", focus="tests", risk_ceiling="medium")
    key = dispatch_key("o/r", "task-9", "deadbeef")
    assert extract_key(body["prompt"]) == key, body["prompt"][:120]
    assert body["title"].startswith("[dispatch:" + key + "]"), body["title"]


def test_source_context_targets_integration_branch():
    body = build({"id": "t", "title": "x"}, template=TEMPLATE, repo="o/r",
                 branch="autonomous/lab", base_sha="c")
    assert body["sourceContext"]["source"] == "sources/github/o/r", body
    assert body["sourceContext"]["githubRepoContext"]["startingBranch"] == "autonomous/lab", body
    assert body["automationMode"] == "AUTO_CREATE_PR", body
    assert body["requirePlanApproval"] is False, body


def test_all_placeholders_are_filled():
    body = build({"id": "t", "title": "x"}, template=TEMPLATE, repo="o/r",
                 branch="b", base_sha="c")
    assert "{{" not in body["prompt"], body["prompt"]


def test_key_is_stable_and_input_sensitive():
    a = dispatch_key("o/r", "t1", "sha1")
    assert a == dispatch_key("o/r", "t1", "sha1")
    assert a != dispatch_key("o/r", "t1", "sha2")
    assert a != dispatch_key("o/r", "t2", "sha1")


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
