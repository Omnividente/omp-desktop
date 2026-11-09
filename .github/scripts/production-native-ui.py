"""One bounded OS-accessibility operation on an owned production window.
No WebDriver, injected JavaScript, CDP, target features, or success markers.
stdin/stdout: one JSON request/result. Failure never includes an accessibility dump.
"""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys


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
    require(os.environ.get("GITHUB_ACTIONS") == "true")
    require(os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted")
    root = Path(q["root"]).resolve(strict=True)
    require(within(Path(os.environ["RUNNER_TEMP"]).resolve(strict=True), root))
    executable = Path(q["executable"]).resolve(strict=True)
    require(within(root, executable))
    windows = sys.platform == "win32"
    if windows:
        import psutil
        from pywinauto import Desktop
        candidates = []
        for w in Desktop(backend="uia").windows(title="OMP Desktop", visible_only=True):
            p = psutil.Process(w.process_id())
            if Path(p.exe()).resolve() == executable:
                candidates.append((w, p.pid))
        require(len(candidates) == 1)
        window, pid = candidates[0]
        require(pid not in q.get("excludePids", []))
        if q.get("pid"):
            require(pid == q["pid"])
        window.set_focus()
        require(window.is_visible() and not window.is_minimized())
        bounds = window.rectangle()
        require(bounds.width() >= 800 and bounds.height() >= 500)

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
            from PIL import ImageGrab
            image = ImageGrab.grab(bbox=(bounds.left, bounds.top, bounds.right, bounds.bottom))
            require(len(image.resize((64, 48)).getcolors(3072) or []) >= 9)
            image.save(path)

        def close():
            window.close()

        identity = {"pid": pid, "path": str(executable), "hwnd": window.handle,
                    "backend": "Windows UI Automation", "visible": True,
                    "bounds": [bounds.left, bounds.top, bounds.right, bounds.bottom]}
    else:
        import pyatspi
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
        require(len(candidates) == 1)
        xid, pid = candidates[0]
        require(pid not in q.get("excludePids", []))
        if q.get("pid"):
            require(pid == q["pid"])
        run("wmctrl", "-ia", xid)
        run("wmctrl", "-ir", xid, "-b", "remove,maximized_vert,maximized_horz")
        run("wmctrl", "-ir", xid, "-e", "0,16,16,1400,900")
        desktop = pyatspi.Registry.getDesktop(0)
        apps = [a for a in desktop if a.get_process_id() == pid]
        require(len(apps) == 1)
        app = apps[0]
        frames = [n for n in app if n.name == "OMP Desktop"
                  and n.getState().contains(pyatspi.STATE_SHOWING)]
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
            run("import", "-window", xid, str(path))
            from PIL import Image
            with Image.open(path) as image:
                require(image.width >= 800 and image.height >= 500)
                require(len(image.convert("RGB").resize((64, 48)).getcolors(3072) or []) >= 9)

        def close():
            run("wmctrl", "-ic", xid)

        identity = {"pid": pid, "path": str(executable), "xid": xid,
                    "nativeExecutable": os.readlink(f"/proc/{pid}/exe"),
                    "nativeExecutableSha256": file_hash(Path(f"/proc/{pid}/exe")),
                    "backend": "AT-SPI2 / X11", "visible": True}

    operation = q["operation"]
    if operation == "observe":
        # Return only the requested synthetic text match, never a full tree/profile.
        texts = []
        for n in nodes():
            if not visible(n):
                continue
            texts.append(name(n))
            if not windows:
                try:
                    t = n.queryText()
                    texts.append(t.getText(0, min(t.characterCount, 4096)))
                except NotImplementedError:
                    pass
        require(all(any(needle in text for text in texts) for needle in q["texts"]))
        identity["observedTexts"] = q["texts"]
    elif operation == "click":
        click(control(q["name"], q["kind"]))
    elif operation == "select":
        select(control(q["name"], "combo"), q["index"])
    elif operation == "value":
        actual = value(control(q["name"], q.get("kind", "combo")))
        require(actual == q["expected"])
        identity["value"] = actual
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
        path = Path(q["screenshot"])
        evidence = Path(q["evidence"]).resolve(strict=True)
        require(within(Path(os.environ["RUNNER_TEMP"]).resolve(strict=True), evidence))
        require(path.parent.resolve() == evidence and not path.exists() and path.suffix == ".png")
        capture(path)
    return identity


try:
    request = json.load(sys.stdin)
    print(json.dumps(main(request)))
except Exception:
    # OS exceptions, raw accessibility and command output are deliberately private.
    print(json.dumps({"error": "Owned native UI operation unavailable or assertion failed"}))
    sys.exit(1)
