#!/usr/bin/env python3
"""Opt-in Linux smoke against an explicit OMP binary in a disposable sandbox.

Requires bubblewrap, Python websockets/cryptography, and Node >=22.13. No model
prompt is sent. The network namespace contains only an ephemeral test relay.
The adapter remains read-only; this harness drives only its own synthetic TUI.
"""

import argparse
import asyncio
import base64
import contextlib
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
from urllib.parse import parse_qs, urlsplit


class SmokeFailure(Exception):
    """Fixed diagnostic code, never an endpoint response or terminal output."""


def require(value, code):
    if not value:
        raise SmokeFailure(code)


async def wait_for_value(fn, code, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = await fn()
        if value:
            return value
        await asyncio.sleep(0.1)
    raise SmokeFailure(code)


async def ipc(meta, op, **fields):
    reader, writer = await asyncio.wait_for(
        asyncio.open_unix_connection(meta["endpoint"]), 3
    )
    try:
        writer.write((json.dumps({"v": 1, "token": meta["token"], "op": op,
                                 **fields}) + "\n").encode())
        await writer.drain()
        raw = await asyncio.wait_for(reader.readline(), 3)
        require(len(raw) <= 65536, "runtime_response_too_large")
        return json.loads(raw)
    finally:
        writer.close()
        await writer.wait_closed()


async def worker(node):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve

    logging.getLogger("websockets").addHandler(logging.NullHandler())
    logging.getLogger("websockets").propagate = False
    results = []
    rooms = {}

    def passed(name):
        results.append({"check": name, "result": "pass"})

    async def relay(ws):
        parsed = urlsplit(ws.request.path)
        role = parse_qs(parsed.query).get("role", [None])[0]
        room_id = parsed.path.removeprefix("/r/")
        if not parsed.path.startswith("/r/") or role not in ("host", "guest"):
            await ws.close(1008)
            return
        if role == "host":
            if room_id in rooms:
                await ws.close(4009)
                return
            room = {"host": ws, "guests": {}, "next": 1}
            rooms[room_id] = room
            peer = 0
        else:
            room = rooms.get(room_id)
            if room is None:
                await ws.close(4004)
                return
            peer = room["next"]
            room["next"] += 1
            room["guests"][peer] = ws
            await room["host"].send(json.dumps({"t": "peer-joined", "peer": peer}))
        try:
            async for frame in ws:
                if not isinstance(frame, bytes) or len(frame) < 4:
                    continue
                if role == "guest":
                    await room["host"].send(struct.pack(">I", peer) + frame[4:])
                else:
                    target = struct.unpack(">I", frame[:4])[0]
                    guests = list(room["guests"].values()) if target == 0 else [room["guests"].get(target)]
                    for guest in guests:
                        if guest is not None:
                            with contextlib.suppress(Exception):
                                await guest.send(frame)
        finally:
            if role == "host" and rooms.get(room_id) is room:
                del rooms[room_id]
                for guest in list(room["guests"].values()):
                    with contextlib.suppress(Exception):
                        await guest.close(4001)
            elif role == "guest" and room["guests"].pop(peer, None):
                with contextlib.suppress(Exception):
                    await room["host"].send(json.dumps({"t": "peer-left", "peer": peer}))

    def decode_link(url):
        # New generated same-origin links only; no permissive legacy parser.
        parsed = urlsplit(url)
        require(parsed.scheme == "http" and parsed.hostname == "127.0.0.1",
                "unexpected_smoke_relay")
        fragment = parsed.fragment
        room_id, encoded = fragment.rsplit(".", 1)
        if "/r/" in room_id:
            room_id = room_id.rsplit("/r/", 1)[1]
        secret = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        require(len(secret) in (32, 48), "unexpected_capability_size")
        return f"ws://127.0.0.1:{parsed.port}/r/{room_id}?role=guest", secret

    def sealed(secret, frame):
        iv = os.urandom(12)
        return bytes(4) + iv + AESGCM(secret[:32]).encrypt(iv, json.dumps(frame).encode(), None)

    async def frame_of(ws, secret, kind):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            raw = await asyncio.wait_for(ws.recv(), max(0.1, deadline - time.monotonic()))
            if isinstance(raw, bytes) and len(raw) > 32:
                value = json.loads(AESGCM(secret[:32]).decrypt(raw[4:16], raw[16:], None))
                if value.get("t") == kind:
                    return value
        raise SmokeFailure("guest_frame_timeout")

    async def ready_read_only_guest(ws, secret):
        # Registry publication and welcome precede startupComplete upstream.
        # A guest without writeToken is denied before session.abort can run.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            await ws.send(sealed(secret, {"t": "abort"}))
            response = await frame_of(ws, secret, "error")
            message = response.get("message")
            if message == "interrupting is disabled on a read-only link":
                return
            require(message == "interrupting is unavailable until the host finishes starting up",
                    "unexpected_read_only_guard")
            await asyncio.sleep(0.1)
        raise SmokeFailure("runtime_not_ready")

    async def node_check(meta, snapshot, access):
        proc = await asyncio.create_subprocess_exec(
            node, "/probe/probe.mjs", "check-link", "--registry-dir",
            "/test-home/.omp/run/collab-hosts", "--instance", snapshot["instanceId"],
            "--session", snapshot["sessionId"], "--generation", str(snapshot["generation"]),
            "--access", access, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), 10)
        require(proc.returncode == 0, "adapter_rejected_real_runtime")
        require(meta["token"].encode() not in stdout + stderr, "adapter_leaked_token")
        require(b"http://" not in stdout + stderr and b"https://" not in stdout + stderr,
                "adapter_leaked_capability")
        require(json.loads(stdout).get("capabilityChecked") is True, "adapter_result_invalid")

    version = subprocess.run(["/omp", "--version"], capture_output=True, text=True, timeout=10)
    require(version.returncode == 0 and version.stdout.strip() == "omp/18.18.1", "unsupported_runtime")
    passed("official_runtime_18_18_1")

    async with serve(relay, "127.0.0.1", 0, max_size=8 * 1024 * 1024) as server:
        port = server.sockets[0].getsockname()[1]
        registry = Path("/test-home/.omp/run/collab-hosts")
        for access in ("view", "control"):
            case = Path("/work") / access
            case.mkdir()
            config = case / "collab.yml"
            config.write_text(
                "startup:\n  setupWizard: false\n  checkUpdate: false\n  showSplash: false\n"
                "update:\n  auto: false\n"
                f"collab:\n  autoStart: {access}\n  relayUrl: ws://127.0.0.1:{port}\n  displayName: synthetic-runtime\n"
            )
            master, slave = os.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
            proc = subprocess.Popen(
                ["/omp", "--cwd", str(case), "--config", str(config), "--session-dir", str(case / "sessions"),
                 "--no-tools", "--no-lsp", "--no-prewalk", "--no-extensions", "--no-skills",
                 "--no-rules", "--no-context-files", "--no-title"],
                stdin=slave, stdout=slave, stderr=slave, cwd=case, start_new_session=True,
            )
            os.close(slave)
            os.set_blocking(master, False)
            # Drain the TUI without recording terminal output (which can contain links).
            def drain():
                with contextlib.suppress(OSError):
                    chunk = os.read(master, 65536)
                    if b"\x1b[6n" in chunk:
                        os.write(master, b"\x1b[1;1R")
            loop = asyncio.get_running_loop()
            loop.add_reader(master, drain)
            guest = None
            try:
                async def discover():
                    if proc.poll() is not None:
                        raise SmokeFailure("runtime_exited_before_publication")
                    for entry in registry.glob("*.json"):
                        with contextlib.suppress(OSError, ValueError):
                            candidate = json.loads(entry.read_text())
                            if candidate.get("pid") == proc.pid:
                                return candidate, entry
                    return None
                meta, metadata_path = await wait_for_value(discover, "runtime_not_published")
                snapshot_reply = await ipc(meta, "snapshot")
                require(snapshot_reply.get("ok") is True, "snapshot_rejected")
                snapshot = snapshot_reply["snapshot"]
                require(snapshot["access"] == access, "overlay_access_mismatch")
                require(snapshot["pid"] == proc.pid and snapshot["relayConnected"], "runtime_identity_mismatch")
                passed(f"{access}_overlay_and_real_registry")
                link = await ipc(meta, "link", access=access, generation=snapshot["generation"])
                require(link.get("ok") is True, "link_rejected")
                url = link["url"]
                guest_url, secret = decode_link(url)
                require(len(secret) == (32 if access == "view" else 48), "wrong_access_secret")
                passed(f"{access}_capability_length")
                await node_check(meta, snapshot, access)
                passed(f"{access}_node_adapter_real_runtime")
                stale = await ipc(meta, "link", access=access, generation=snapshot["generation"] + 1)
                require(stale.get("error") == "stale_generation", "stale_generation_not_rejected")
                passed(f"{access}_stale_generation_rejected")
                if access == "view":
                    denied = await ipc(meta, "link", access="control", generation=snapshot["generation"])
                    require(denied.get("error") == "access_unavailable", "view_escalated_to_control")
                    passed("view_control_link_denied")
                guest = await connect(guest_url, max_size=8 * 1024 * 1024)
                hello = {"t": "hello", "proto": 3, "name": "synthetic-guest"}
                # Establish readiness with read-only admission in BOTH room modes.
                await guest.send(sealed(secret, hello))
                welcome = await frame_of(guest, secret, "welcome")
                require(welcome.get("readOnly") is True, "read_only_guest_not_restricted")
                require(welcome.get("header", {}).get("id") == snapshot["sessionId"],
                        "guest_session_mismatch")
                await ready_read_only_guest(guest, secret)
                passed(f"{access}_startup_complete_and_read_only_guard")
                if access == "control":
                    await guest.close()
                    guest = await connect(guest_url, max_size=8 * 1024 * 1024)
                    hello["writeToken"] = base64.urlsafe_b64encode(secret[32:]).decode().rstrip("=")
                    await guest.send(sealed(secret, hello))
                    welcome = await frame_of(guest, secret, "welcome")
                    require(welcome.get("header", {}).get("id") == snapshot["sessionId"],
                            "guest_session_mismatch")
                require(welcome.get("readOnly", False) == (access == "view"), "guest_access_mismatch")
                passed(f"{access}_encrypted_guest_welcome")
                # This is test-only operation of our own TUI, NOT a Desktop IPC API.
                os.write(master, b"/collab stop\r")
                async def unpublished():
                    return not Path(meta["endpoint"]).exists() and not metadata_path.exists()
                await wait_for_value(unpublished, "tui_stop_not_confirmed")
                await asyncio.wait_for(guest.wait_closed(), 8)
                passed(f"{access}_tui_stop_withdraws_registry_and_guest")
                require(proc.poll() is None, "tui_stop_terminated_runtime")
                passed(f"{access}_runtime_survives_tui_stop")
                old_guest = await connect(guest_url)
                await asyncio.wait_for(old_guest.wait_closed(), 5)
                require(old_guest.close_code == 4004, "retired_room_still_accepts_guest")
                passed(f"{access}_old_capability_room_gone")
            finally:
                if guest is not None:
                    await guest.close()
                loop.remove_reader(master)
                os.close(master)
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        await asyncio.wait_for(asyncio.to_thread(proc.wait), 5)
                    except TimeoutError:
                        proc.kill()
                        await asyncio.to_thread(proc.wait)
    return {"runtime": "omp/18.18.1", "isolation": "bubblewrap filesystem+pid+network",
            "providerInference": False, "productionIpcMutations": False,
            "checks": results, "limitations": ["Linux only", "TUI stop is not Desktop IPC stop",
            "No ordinary prompt delivery/ACK test", "No Telegram/browser UI or public relay"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--omp", type=Path)
    parser.add_argument("--expected-sha256")
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        require(Path("/omp").is_file() and Path("/test-home").is_dir(), "sandbox_required")
        print(json.dumps(asyncio.run(worker(args.node)), indent=2))
        return
    require(sys.platform == "linux" and shutil.which("bwrap"), "linux_bubblewrap_required")
    require(args.omp and args.omp.is_file() and args.node, "explicit_runtime_and_node_required")
    digest = hashlib.file_digest(args.omp.open("rb"), "sha256").hexdigest()
    require(args.expected_sha256 and digest == args.expected_sha256, "runtime_digest_mismatch")
    with tempfile.TemporaryDirectory(prefix="omp-remote-smoke-") as tmp:
        root = Path(tmp)
        for name in ("work", "user"):
            (root / name).mkdir(mode=0o700)
        (root / "passwd").write_text(f"test:x:{os.getuid()}:{os.getgid()}:Test:/test-home:/bin/false\n")
        cmd = ["bwrap", "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-ipc",
               "--unshare-uts", "--unshare-net", "--clearenv"]
        roots = [Path("/usr"), Path("/bin"), Path("/lib"), Path("/lib64"), Path(sys.prefix), Path(args.node).resolve().parent.parent]
        mounted = []
        for directory in roots:
            if directory.exists() and not any(directory == prior or prior in directory.parents for prior in mounted):
                cmd += ["--ro-bind", str(directory), str(directory)]
                mounted.append(directory)
        cmd += ["--dir", "/etc", "--ro-bind", str(root / "passwd"), "/etc/passwd",
                "--bind", str(root / "user"), "/test-home", "--bind", str(root / "work"), "/work",
                "--ro-bind", str(args.omp.resolve()), "/omp", "--ro-bind", str(Path(__file__).resolve().parent), "/probe",
                "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--setenv", "PATH", "/usr/bin:/bin",
                "--setenv", "LANG", "C.UTF-8", "--setenv", "TERM", "xterm-256color", "--chdir", "/work",
                "--", sys.executable, "/probe/runtime-smoke.py", "--worker", "--node", str(Path(args.node).resolve())]
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if run.returncode != 0:
            try:
                child_error = json.loads(run.stderr).get("error", "worker_failed")
            except (ValueError, AttributeError):
                child_error = "sandbox_launch_failed"
            # The worker only emits fixed failure codes; never print raw stderr.
            require(False, child_error if child_error.replace("_", "").isalnum() else "worker_failed")
        result = json.loads(run.stdout)
        result["assetSha256"] = digest
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (SmokeFailure, TimeoutError, subprocess.TimeoutExpired) as error:
        code = str(error) if isinstance(error, SmokeFailure) else "smoke_timeout"
        print(json.dumps({"error": code}), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        print(json.dumps({"error": "smoke_failed_" + type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)
