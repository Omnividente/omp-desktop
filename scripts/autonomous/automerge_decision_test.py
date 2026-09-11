#!/usr/bin/env python3
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from automerge_decision import decide, normalize_author  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((REPO_ROOT / "autonomous-project.json").read_text(encoding="utf-8"))


def _pr(**over):
    base = {
        "number": 7,
        "state": "OPEN",
        "isDraft": False,
        "baseRefName": "autonomous/lab",
        "labels": [],
        "author": {"login": "google-labs-jules[bot]"},
        "files": [{"path": "src/App.tsx"}, {"path": "src/App.test.tsx"}],
    }
    base.update(over)
    return base


def test_merges_clean_autonomous_pr():
    result = decide(_pr(), CONFIG)
    assert result["decision"] == "merge", result


def test_never_merges_into_default_branch():
    result = decide(_pr(baseRefName="main"), CONFIG)
    assert result["decision"] == "skip", result
    assert any("base branch" in r for r in result["reasons"]), result


def test_refuses_version_bump():
    result = decide(_pr(files=[{"path": "package.json"}]), CONFIG)
    assert result["decision"] == "scope_violation", result


def test_refuses_workflow_edit():
    result = decide(_pr(files=[{"path": ".github/workflows/release-artifacts.yml"}]), CONFIG)
    assert result["decision"] == "scope_violation", result


def test_refuses_control_plane_edit():
    result = decide(_pr(files=[{"path": "agent_tasks.json"}]), CONFIG)
    assert result["decision"] == "scope_violation", result


def test_skips_draft_and_blocked_and_foreign_author():
    assert decide(_pr(isDraft=True), CONFIG)["decision"] == "skip"
    assert decide(_pr(labels=[{"name": "hold"}]), CONFIG)["decision"] == "skip"
    assert decide(_pr(author={"login": "somebody-else"}), CONFIG)["decision"] == "skip"
    assert decide(_pr(state="CLOSED"), CONFIG)["decision"] == "skip"


def test_author_normalization_accepts_gh_variants():
    assert normalize_author("google-labs-jules[bot]") == "google-labs-jules"
    assert normalize_author("app/google-labs-jules") == "google-labs-jules"
    assert decide(_pr(author={"login": "app/google-labs-jules"}), CONFIG)["decision"] == "merge"


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
