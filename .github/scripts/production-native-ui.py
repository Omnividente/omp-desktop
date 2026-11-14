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
import re
import tempfile


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
        if q["operation"] != "folder":
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

        def edit(n, text):
            n.set_edit_text(text)

        def keys(sequence):
            window.type_keys(sequence, set_foreground=True, with_spaces=True)

        def terminal_focus():
            # xterm's helper textarea is intentionally zero-sized/offscreen.
            # Click the owned visible lower console, never inject DOM focus hooks.
            window.click_input(coords=(int(bounds.width() * .65), int(bounds.height() * .78)))
        def folder(path):
            dialog = Desktop(backend="uia").get_active()
            require(dialog.process_id() == pid and dialog.handle != window.handle)
            dialog.type_keys("^l", set_foreground=True)
            from pywinauto.keyboard import send_keys
            send_keys(str(path), with_spaces=True, vk_packet=True)
            send_keys("{ENTER}%s")

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
        if q["operation"] != "folder":
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

        def edit(n, text):
            require(n.queryEditableText().setTextContents(text))

        def keys(sequence):
            run("xdotool", "key", "--clearmodifiers", *sequence)

        def terminal_focus():
            geometry = dict(line.split("=", 1) for line in run("xdotool", "getwindowgeometry", "--shell", xid).splitlines())
            x = int(geometry["X"]) + int(int(geometry["WIDTH"]) * .65)
            y = int(geometry["Y"]) + int(int(geometry["HEIGHT"]) * .78)
            run("xdotool", "mousemove", str(x), str(y), "click", "1")

        def folder(path):
            active = run("xdotool", "getactivewindow")
            require(int(active, 0) != int(xid, 0))
            require(int(run("xdotool", "getwindowpid", active)) == pid)
            run("xdotool", "key", "--clearmodifiers", "ctrl+l")
            run("xdotool", "type", "--clearmodifiers", "--", str(path))
            run("xdotool", "key", "--clearmodifiers", "Return", "alt+o")

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
        require(not any(any(needle in text for text in texts) for needle in q.get("absentTexts", [])))
    elif operation == "click":
        click(control(q["name"], q["kind"]))
    elif operation == "select":
        select(control(q["name"], "combo"), q["index"])
    elif operation == "value":
        actual = value(control(q["name"], q.get("kind", "combo")))
        require(actual == q["expected"])
        identity["value"] = actual
    elif operation == "edit":
        edit(control(q["name"], "edit"), q["text"])
    elif operation == "folder":
        path = Path(q["path"]).resolve(strict=True)
        require(within(root, path) and path.is_dir())
        folder(path)
    elif operation == "terminal-keys":
        if q.get("focus", True):
            terminal_focus()
        sequences = {
            "escape": ("{ESC}", ["Escape"]),
            "draft": ("nativefocusdraft", list("nativefocusdraft")),
            "clear": ("^a{BACKSPACE}", ["ctrl+a", "BackSpace"]),
        }
        require(q["keys"] in sequences)
        keys(sequences[q["keys"]][0 if windows else 1])
    elif operation == "terminal-ocr":
        # Canvas TUI is read from the real mapped surface, never DOM/testhook output.
        with tempfile.TemporaryDirectory(prefix="native-ocr-", dir=root) as temp:
            image_path = Path(temp) / "surface.png"
            capture(image_path)
            from PIL import Image
            with Image.open(image_path) as image:
                width, height = image.size
                image.crop((int(width * .25), int(height * .12), width, int(height * .94))).save(image_path)
            text = run(q["tesseract"], str(image_path), "stdout", "--psm", "11")
            require(any(re.search(pattern, text, re.IGNORECASE) for pattern in q["patterns"]))
            identity["terminalObservation"] = q["label"]
            identity["method"] = "native-window cropped screenshot OCR; raw text not retained"
    elif operation == "runtime-process":
        runtime = Path(q["runtime"]).resolve(strict=True)
        project = Path(q["project"]).resolve(strict=True)
        require(within(root, project))
        if windows:
            matches = [p for p in psutil.Process(pid).children(recursive=True)
                       if Path(p.exe()).resolve() == runtime and Path(p.cwd()).resolve() == project]
            require(len(matches) == 1)
            child_pid = matches[0].pid
            pty = "Windows native child in Desktop terminal (ConPTY launcher)"
        else:
            parents, matches = {pid}, []
            for _ in range(8):
                previous = set(parents)
                for entry in Path("/proc").iterdir():
                    if not entry.name.isdigit():
                        continue
                    try:
                        status = (entry / "status").read_text()
                        parent = int(re.search(r"^PPid:\s+(\d+)", status, re.MULTILINE).group(1))
                        if parent in parents:
                            parents.add(int(entry.name))
                    except (OSError, AttributeError):
                        continue
                if parents == previous:
                    break
            for child in parents - {pid}:
                try:
                    proc = Path(f"/proc/{child}")
                    if (proc / "exe").resolve() == runtime and (proc / "cwd").resolve() == project:
                        require(os.readlink(proc / "fd/0").startswith("/dev/pts/"))
                        matches.append(child)
                except OSError:
                    continue
            require(len(matches) == 1)
            child_pid, pty = matches[0], "Linux /dev/pts stdin and owned Desktop ancestry"
        identity["runtime"] = {"pid": child_pid, "path": str(runtime),
                               "sha256": file_hash(runtime), "cwd": str(project), "pty": pty}
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
        if q.get("theme"):
            from PIL import Image, ImageStat
            require(q["theme"] in {"dark", "light"})
            with Image.open(path) as image:
                width, height = image.size
                surface = image.convert("L").crop((int(width * .45), int(height * .4),
                                                    int(width * .9), int(height * .75)))
                luminance = ImageStat.Stat(surface).mean[0]
            require((luminance > 128) == (q["theme"] == "light"))
            identity["themeSurface"] = {"expected": q["theme"], "meanLuminance": luminance}
    return identity


try:
    request = json.load(sys.stdin)
    print(json.dumps(main(request)))
except Exception:
    # OS exceptions, raw accessibility and command output are deliberately private.
    print(json.dumps({"error": "Owned native UI operation unavailable or assertion failed"}))
    sys.exit(1)
