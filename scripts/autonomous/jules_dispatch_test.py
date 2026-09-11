#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jules_dispatch import Response, dispatch, extract_key  # noqa: E402

REQ = {
    "prompt": "AUTONOMOUS_DISPATCH_KEY: abc123\nAUTONOMOUS_TASK_ID: t\n\ndo work",
    "title": "[dispatch:abc123] task t",
}


class FakeApi:
    def __init__(self, sessions=None, create_status=200, create_payload=None):
        self.sessions = sessions or []
        self.create_status = create_status
        self.create_payload = create_payload or {"id": "sess-new", "state": "QUEUED"}
        self.create_calls = 0
        self.list_calls = 0

    def __call__(self, method, url, headers, payload):
        if method == "GET":
            self.list_calls += 1
            return Response(200, {"sessions": self.sessions})
        if method == "POST":
            self.create_calls += 1
            if self.create_status // 100 == 2:
                return Response(self.create_status, self.create_payload)
            return Response(self.create_status, None)
        raise AssertionError("unexpected method " + method)


def test_extract_key():
    assert extract_key(REQ["prompt"]) == "abc123", extract_key(REQ["prompt"])


def test_creates_when_no_match():
    api = FakeApi(sessions=[])
    r = dispatch(api, api_base="https://x/v1", api_key="k", request_body=REQ)
    assert r["result"] == "created" and r["session_id"] == "sess-new", r
    assert api.create_calls == 1, api.create_calls


def test_reconciles_existing_active_session():
    api = FakeApi(sessions=[
        {"id": "sess-old", "state": "IN_PROGRESS", "title": "[dispatch:abc123] task t"}
    ])
    r = dispatch(api, api_base="https://x/v1", api_key="k", request_body=REQ)
    assert r["result"] == "reconciled" and r["session_id"] == "sess-old", r
    assert api.create_calls == 0, api.create_calls


def test_ignores_completed_session_and_creates():
    api = FakeApi(sessions=[
        {"id": "sess-done", "state": "COMPLETED", "title": "[dispatch:abc123] task t"}
    ])
    r = dispatch(api, api_base="https://x/v1", api_key="k", request_body=REQ)
    assert r["result"] == "created", r


def test_transient_failure_reconciles_async_session():
    class FlakyApi(FakeApi):
        def __call__(self, method, url, headers, payload):
            if method == "POST":
                self.create_calls += 1
                self.sessions = [
                    {"id": "sess-async", "state": "QUEUED", "title": "[dispatch:abc123] t"}
                ]
                return Response(503, None)
            self.list_calls += 1
            return Response(200, {"sessions": self.sessions})

    api = FlakyApi()
    r = dispatch(api, api_base="https://x/v1", api_key="k", request_body=REQ,
                 sleeper=lambda _seconds: None)
    assert r["result"] == "reconciled" and r["session_id"] == "sess-async", r
    assert api.create_calls == 1, api.create_calls


def test_permanent_failure_raises():
    api = FakeApi(create_status=400)
    try:
        dispatch(api, api_base="https://x/v1", api_key="k", request_body=REQ,
                 sleeper=lambda _seconds: None)
    except RuntimeError:
        return
    raise AssertionError("expected RuntimeError for HTTP 400")


def test_missing_marker_raises():
    try:
        dispatch(FakeApi(), api_base="https://x/v1", api_key="k",
                 request_body={"prompt": "no marker here"})
    except RuntimeError:
        return
    raise AssertionError("expected RuntimeError for missing marker")


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
