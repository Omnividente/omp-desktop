"""One bounded OS-accessibility operation on an owned production window.
No WebDriver, injected JavaScript, CDP, target features, or success markers.
stdin/stdout: one JSON request/result. Failure exposes only phase/class/counts, never raw errors or a tree.
"""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys

phase = "request-admission"
counts = {}


def require(value):
    if not value:
        raise RuntimeError("native UI contract unavailable")


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=15).decode().strip()


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while True:
            chunk = file.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def within(root, path):
    return path != root and root in path.parents


def main(q):
    global phase
    phase = "runtime-admission"
    require(os.environ.get("GITHUB_ACTIONS") == "true")
    require(os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted")
    root = Path(q["root"]).resolve(strict=True)
    require(within(Path(os.environ["RUNNER_TEMP"]).resolve(strict=True), root))
    executable = Path(q["executable"]).resolve(strict=True)
    require(within(root, executable))
    windows = sys.platform == "win32"
    if windows:
        phase = "windows-native-discovery"
        import psutil
        import ctypes
        from ctypes import wintypes
        from pywinauto import Desktop
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        get_owner_pid = user32.GetWindowThreadProcessId
        get_owner_pid.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        get_owner_pid.restype = wintypes.DWORD
        is_iconic = user32.IsIconic
        is_iconic.argtypes = [wintypes.HWND]
        is_iconic.restype = wintypes.BOOL
        foreground = user32.GetForegroundWindow
        foreground.argtypes = []
        foreground.restype = wintypes.HWND
        post_message = user32.PostMessageW
        post_message.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        post_message.restype = wintypes.BOOL

        def native_pid(hwnd):
            owner = wintypes.DWORD()
            require(get_owner_pid(hwnd, ctypes.byref(owner)) != 0)
            return owner.value

        candidates = []
        for w in Desktop(backend="win32").windows(title="OMP Desktop", visible_only=True):
            try:
                p = psutil.Process(native_pid(w.handle))
                if Path(p.exe()).resolve() == executable:
                    candidates.append((w, p))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        counts["ownedWindows"] = len(candidates)
        require(len(candidates) == 1)
        native_window, owner_process = candidates[0]
        pid = owner_process.pid
        started_at = owner_process.create_time()
        phase = "windows-window-identity"
        require(pid not in q.get("excludePids", []))
        if q.get("pid"):
            require(pid == q["pid"])
        native_window.set_focus()
        require(native_window.is_visible() and not is_iconic(native_window.handle))
        require(foreground() == native_window.handle)
        bounds = native_window.rectangle()
        require(bounds.width() >= 800 and bounds.height() >= 500)

        # Accessibility is rooted in the independently verified native HWND.
        # Failure capture/close must still work when the accessibility tree is absent.
        window = None
        if q.get("operation") not in {"capture", "close"}:
            phase = "windows-uia-attachment"
            window = Desktop(backend="uia").window(handle=native_window.handle).wrapper_object()
            require(window.handle == native_window.handle)

        def nodes():
            return [window] + window.descendants()

        def name(n):
            return n.window_text()

        def visible(n):
            return n.is_visible()

        def control(label, kind):
            types = {"button": "Button", "tab": "TabItem", "combo": "ComboBox", "edit": "Edit"}
            found = [n for n in nodes() if name(n) == label
                     and n.element_info.control_type == types[kind]]
            require(len(found) == 1 and found[0].is_enabled())
            node = found[0]
            if not visible(node):
                node.iface_scroll_item.ScrollIntoView()
            require(visible(node))
            return node

        def click(n):
            n.click_input()

        def select(n, index):
            n.set_focus()
            n.type_keys("{HOME}" + "{DOWN}" * index + "{ENTER}", set_foreground=True)

        def value(n):
            if n.element_info.control_type == "Edit":
                return n.iface_value.CurrentValue
            selection = n.iface_selection.GetCurrentSelection()
            require(selection.Length == 1)
            return selection.GetElement(0).CurrentName

        def capture(path):
            require(native_pid(native_window.handle) == pid and owner_process.is_running())
            require(owner_process.create_time() == started_at and foreground() == native_window.handle)
            from PIL import ImageGrab
            image = ImageGrab.grab(bbox=(bounds.left, bounds.top, bounds.right, bounds.bottom))
            require(len(image.resize((64, 48)).getcolors(3072) or []) >= 9)
            image.save(path)

        def close():
            require(post_message(native_window.handle, 0x0010, 0, 0))  # WM_CLOSE

        identity = {"pid": pid, "ownerPid": native_pid(native_window.handle),
                    "startedAtUnixSeconds": started_at, "path": str(executable),
                    "hwnd": native_window.handle, "backend": "Win32 HWND / UIAutomation",
                    "accessibilityAttached": window is not None, "visible": True,
                    "bounds": [bounds.left, bounds.top, bounds.right, bounds.bottom]}
    else:
        phase = "linux-x11-discovery"
        # Match an actual mapped X11 window, not a headless accessibility tree.
        candidates = []
        for line in run("wmctrl", "-lp").splitlines():
            parts = line.split(None, 4)
            if len(parts) != 5 or parts[4] != "OMP Desktop":
                continue
            pid = int(parts[2])
            try:
                fields = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
                appimage = next(f[9:].decode() for f in fields if f.startswith(b"APPIMAGE="))
                if Path(appimage).resolve() == executable:
                    candidates.append((parts[0], pid))
            except (OSError, StopIteration):
                continue
        counts["ownedWindows"] = len(candidates)
        require(len(candidates) == 1)
        xid, pid = candidates[0]
        phase = "linux-window-identity"
        require(pid not in q.get("excludePids", []))
        if q.get("pid"):
            require(pid == q["pid"])
        run("wmctrl", "-ia", xid)
        run("wmctrl", "-ir", xid, "-b", "remove,maximized_vert,maximized_horz")
        run("wmctrl", "-ir", xid, "-e", "0,16,16,1400,900")
        phase = "linux-map-state"

        def window_info():
            info = {}
            for row in run("xwininfo", "-id", xid).splitlines():
                key, separator, value = row.partition(":")
                if separator:
                    info[key.strip()] = value.strip()
            return info

        info = window_info()
        require(info.get("Map State") == "IsViewable")
        require(int(run("xdotool", "getactivewindow")) == int(xid, 16))
        left, top = int(info["Absolute upper-left X"]), int(info["Absolute upper-left Y"])
        width, height = int(info["Width"]), int(info["Height"])
        require(width >= 800 and height >= 500)

        def process_start_ticks():
            return int(Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19])

        started_at = process_start_ticks()
        window = None
        if q.get("operation") not in {"capture", "close"}:
            phase = "linux-accessibility-import"
            import pyatspi
            phase = "linux-atspi-app"
            desktop = list(pyatspi.Registry.getDesktop(0))
            counts["accessibilityApplications"] = len(desktop)
            apps = [a for a in desktop if a.get_process_id() == pid]
            counts["ownedAccessibilityApplications"] = len(apps)
            require(len(apps) == 1)
            app = apps[0]
            phase = "linux-atspi-window"
            frames = [n for n in app if n.name == "OMP Desktop"
                      and n.getState().contains(pyatspi.STATE_SHOWING)]
            counts["ownedAccessibleFrames"] = len(frames)
            require(len(frames) == 1)
            window = frames[0]

        def nodes():
            result, pending = [], [window]
            while pending:
                n = pending.pop()
                result.append(n)
                require(len(result) < 12000)
                pending.extend(list(n))
            return result

        def name(n):
            return n.name or ""

        def visible(n):
            return n.getState().contains(pyatspi.STATE_SHOWING)

        def control(label, kind):
            roles = {"button": {"push button"}, "tab": {"page tab"},
                     "combo": {"combo box"}, "edit": {"entry", "text"}}
            found = [n for n in nodes() if name(n) == label
                     and n.getRoleName() in roles[kind]]
            require(len(found) == 1 and found[0].getState().contains(pyatspi.STATE_ENABLED))
            node = found[0]
            if not visible(node):
                require(node.queryComponent().scrollTo(pyatspi.SCROLL_ANYWHERE))
            require(visible(node))
            return node

        def click(n):
            action = n.queryAction()
            options = [i for i in range(action.nActions)
                       if action.getName(i).lower() in {"click", "press", "activate"}]
            require(len(options) == 1 and action.doAction(options[0]))

        def select(n, index):
            require(n.queryComponent().grabFocus())
            run("xdotool", "key", "--clearmodifiers", "Home", *( ["Down"] * index), "Return")

        def value(n):
            if n.getRoleName() in {"entry", "text"}:
                text = n.queryText()
                return text.getText(0, text.characterCount)
            selection = n.querySelection()
            require(selection.nSelectedChildren == 1)
            return selection.getSelectedChild(0).name

        def capture(path):
            require(process_start_ticks() == started_at)
            require(int(run("xdotool", "getwindowpid", xid)) == pid)
            require(window_info().get("Map State") == "IsViewable")
            require(int(run("xdotool", "getactivewindow")) == int(xid, 16))
            run("import", "-window", xid, str(path))
            from PIL import Image
            with Image.open(path) as image:
                require(image.width >= 800 and image.height >= 500)
                require(len(image.convert("RGB").resize((64, 48)).getcolors(3072) or []) >= 9)

        def close():
            run("wmctrl", "-ic", xid)

        identity = {"pid": pid, "path": str(executable), "xid": xid,
                    "startedAtProcTicks": started_at, "mapState": info["Map State"],
                    "bounds": [left, top, left + width, top + height],
                    "nativeExecutable": os.readlink(f"/proc/{pid}/exe"),
                    "nativeExecutableSha256": file_hash(Path(f"/proc/{pid}/exe")),
                    "backend": "X11 / AT-SPI2", "accessibilityAttached": window is not None,
                    "visible": True}

    operation = q["operation"]
    phase = "native-operation"
    if operation == "observe":
        phase = "text-observation"
        # Return only the requested synthetic text match, never a full tree/profile.
        texts = []
        counts["requestedTexts"] = len(q["texts"])
        counts["visibleNodes"] = 0
        for n in nodes():
            if not visible(n):
                continue
            counts["visibleNodes"] += 1
            texts.append(name(n))
            if not windows:
                try:
                    t = n.queryText()
                    texts.append(t.getText(0, min(t.characterCount, 4096)))
                except NotImplementedError:
                    pass
        counts["matchedTexts"] = sum(any(needle in text for text in texts) for needle in q["texts"])
        require(counts["matchedTexts"] == len(q["texts"]))
        identity["observedTexts"] = q["texts"]
    elif operation == "click":
        click(control(q["name"], q["kind"]))
    elif operation == "select":
        select(control(q["name"], "combo"), q["index"])
    elif operation == "value":
        phase = "value-observation"
        actual = value(control(q["name"], q.get("kind", "combo")))
        require(actual == q["expected"])
        identity["value"] = actual
    elif operation == "capture":
        require(q.get("screenshot"))
    elif operation == "escape":
        if windows:
            window.type_keys("{ESC}", set_foreground=True)
        else:
            run("xdotool", "key", "--clearmodifiers", "Escape")
    elif operation == "close":
        close()
    else:
        raise RuntimeError("unsupported native UI operation")
    if q.get("screenshot"):
        phase = "screenshot"
        path = Path(q["screenshot"])
        evidence = Path(q["evidence"]).resolve(strict=True)
        require(within(Path(os.environ["RUNNER_TEMP"]).resolve(strict=True), evidence))
        require(path.parent.resolve() == evidence and not path.exists() and path.suffix == ".png")
        capture(path)
    return identity


try:
    request = json.load(sys.stdin)
    print(json.dumps(main(request)))
except Exception as error:
    # OS exceptions, raw accessibility and command output are deliberately private.
    print(json.dumps({"error": "Owned native UI operation unavailable or assertion failed",
                      "phase": phase, "exception": type(error).__name__, "counts": counts}))
    sys.exit(1)
