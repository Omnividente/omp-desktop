#!/usr/bin/env python3
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_policy import verify  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]


def _real_config():
    return json.loads((REPO_ROOT / "autonomous-project.json").read_text(encoding="utf-8"))


def test_shipped_config_passes():
    problems = verify(_real_config())
    assert problems == [], problems


def test_enabling_releases_is_rejected():
    config = _real_config()
    config["release_policy"]["automation"] = "enabled"
    problems = verify(config)
    assert any("automation" in p for p in problems), problems


def test_merging_to_default_branch_is_rejected():
    config = _real_config()
    config["parallel_mode"]["never_merge_to_default"] = False
    problems = verify(config)
    assert any("never_merge_to_default" in p for p in problems), problems


def test_integration_branch_must_differ_from_default():
    config = _real_config()
    config["parallel_mode"]["integration_branch"] = "main"
    problems = verify(config, integration_branch="main")
    assert any("must differ" in p for p in problems), problems


def test_removing_version_file_protection_is_rejected():
    config = _real_config()
    config["product"]["excluded"] = [
        item for item in config["product"]["excluded"] if item != "package.json"
    ]
    problems = verify(config)
    assert any("package.json" in p for p in problems), problems


def test_wildcard_editable_scope_is_rejected():
    config = _real_config()
    config["product"]["editable_globs"] = ["**"]
    problems = verify(config)
    assert any("editable_globs" in p for p in problems), problems


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
