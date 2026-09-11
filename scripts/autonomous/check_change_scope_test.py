#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_change_scope import evaluate  # noqa: E402

CONFIG = {
    "product": {
        "editable_globs": ["src/**", "src-tauri/src/**", "src-tauri/tests/**"],
        "excluded": [
            ".github/workflows/**", "package.json", "src-tauri/tauri.conf.json",
            "autonomous-project.json", "agent_tasks.json", "**/*.png",
        ],
    }
}


def test_allows_src():
    r = evaluate(CONFIG, ["src/App.tsx", "src/uiUtils.ts", "src-tauri/src/main.rs"])
    assert r["allowed"] is True, r


def test_blocks_release_and_version():
    assert evaluate(CONFIG, ["package.json"])["allowed"] is False
    assert evaluate(CONFIG, [".github/workflows/release-artifacts.yml"])["allowed"] is False
    assert evaluate(CONFIG, ["src-tauri/tauri.conf.json"])["allowed"] is False


def test_blocks_outside_scope():
    r = evaluate(CONFIG, ["README.md"])
    assert r["allowed"] is False and r["violations"][0]["reason"] == "outside_editable_scope", r


def test_blocks_png_even_in_src():
    assert evaluate(CONFIG, ["src/assets/logo.png"])["allowed"] is False


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
