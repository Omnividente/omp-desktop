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
import time


class NativeContractError(RuntimeError):
    pass


def require(value, code="native-contract"):
    if not value:
        raise NativeContractError(code)


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


def wait_for(read, seconds=5):
    """Poll native readiness only, never an input action."""
    deadline = time.monotonic() + seconds
    while True:
        result = read()
        if result or time.monotonic() >= deadline:
            return result
        time.sleep(.05)


def copy_selection(anchor, select_all, copy, deselect, clear, read):
    selection_started = False
    try:
        clear()
        anchor()
        selection_started = True
        select_all()
        copy()
        text = wait_for(read, seconds=2)
        require(text, "native-copy-empty")
        require(len(text) < 65536, "native-copy-too-large")
        return text
    finally:
        try:
            if selection_started:
                deselect()
        finally:
            clear()


def literal(text):
    require(isinstance(text, str) and len(text) <= 4096 and not re.search(r"[\x00-\x1f\x7f]", text),
            "native-invalid-literal")
    return text


VERSION = r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
HEADER_BRAND = re.compile(r"\bOMP\s*Desktop(?=\b|v[0-9])")
HEADER_VERSION = re.compile(r"\bOMP\s*Desktop\s*v?(" + VERSION + r")(?![\w.+-])")


def main(q):
    require(os.environ.get("GITHUB_ACTIONS") == "true")
    require(os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted")
    root = Path(q["root"]).resolve(strict=True)
    require(within(Path(os.environ["RUNNER_TEMP"]).resolve(strict=True), root))
    executable = Path(q["executable"]).resolve(strict=True)
    require(within(root, executable))
    windows = sys.platform == "win32"
    operation = q["operation"]
    expected_version = q.get("expectedVersion") if operation == "observe" else None
    copy_text = q.get("copyText", False) if operation == "observe" else False
    require(isinstance(copy_text, bool), "native-invalid-copy-option")
    require(expected_version is None or (isinstance(expected_version, str)
            and re.fullmatch(VERSION, expected_version)), "native-invalid-expected-version")
    copying = copy_text or expected_version is not None
    version_labels = q.get("versionLabels") if copying else None
    if copying:
        require(isinstance(version_labels, list) and version_labels
                and all(isinstance(s, str) and s for s in version_labels), "native-invalid-version-labels")
    label = q.get("name")
    control_id = q.get("controlId")
    require(control_id is None or (isinstance(control_id, str) and 0 < len(control_id) <= 256),
            "native-invalid-control-id")
    terminal_help = "Ctrl+Z undoes an edit in the current OMP input."
    if windows:
        import psutil
        import pywintypes
        import win32api
        import win32clipboard
        import win32con
        import win32gui
        import win32process
        from pywinauto import Desktop, mouse
        from pywinauto.keyboard import send_keys
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
        if copying and not q.get("pid"):
            area = win32api.GetMonitorInfo(win32api.MonitorFromWindow(
                window.handle, win32con.MONITOR_DEFAULTTONEAREST))["Work"]
            window.restore()
            win32gui.SetWindowPos(window.handle, 0, area[0], area[1], area[2] - area[0], area[3] - area[1],
                                 win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE)
            window.set_focus()
        require(window.is_visible() and not window.is_minimized())
        bounds = window.rectangle()
        require(bounds.width() >= 800 and bounds.height() >= 500)

        def nodes():
            return [window] + window.descendants()

        def name(n):
            return n.element_info.name or ""

        def visible(n):
            return n.is_visible()

        def is_foreground(handle):
            return (win32gui.GetForegroundWindow() == handle and win32gui.IsWindowVisible(handle)
                    and not win32gui.IsIconic(handle) and win32process.GetWindowThreadProcessId(handle)[1] == pid)

        def guard(handle=window.handle):
            require(is_foreground(handle), "native-foreground-owner")

        def labelled(n, text):
            if control_id is not None:
                return n.element_info.automation_id == control_id
            if name(n) == text:
                return True
            related = n.element_info.element.CurrentLabeledBy
            return bool(related) and related.CurrentName == text

        def control(text, kind, prefix=False):
            types = {"button": "Button", "tab": "TabItem", "combo": "ComboBox", "edit": "Edit"}
            require(prefix or control_id or isinstance(text, str), "native-control-selector")
            found = wait_for(lambda: [n for n in nodes() if n.element_info.control_type == types[kind]
                                     and (name(n).startswith(text) if prefix else labelled(n, text))])
            require(len(found) == 1, "native-control-count")
            node = found[0]
            require(node.is_enabled(), "native-control-disabled")
            if not visible(node):
                guard()
                node.iface_scroll_item.ScrollIntoView()
                require(wait_for(lambda: visible(node)), "native-control-hidden")
            return node

        def click_point(x, y):
            require(bounds.left <= x < bounds.right and bounds.top <= y < bounds.bottom,
                    "native-click-outside-window")
            guard()
            hit = win32gui.WindowFromPoint((x, y))
            require(hit and win32gui.GetAncestor(hit, win32con.GA_ROOT) == window.handle,
                    "native-click-window-owner")
            mouse.click(coords=(x, y))

        def click(n, x_offset=None):
            require(n.is_enabled() and visible(n), "native-control-not-actionable")
            rect = n.rectangle()
            require(rect.width() > 0 and rect.height() > 0, "native-click-empty-bounds")
            click_point(rect.left + (rect.width() // 2 if x_offset is None else x_offset),
                        rect.top + rect.height() // 2)

        def focused(n):
            return n.element_info.element.CurrentHasKeyboardFocus

        def focus(n):
            guard()
            require(n.is_enabled() and visible(n), "native-control-not-actionable")
            n.element_info.element.SetFocus()
            require(wait_for(lambda: focused(n)), "native-control-focus")

        def select(n, index):
            focus(n)
            keys("%{DOWN}{HOME}" + "{DOWN}" * index + "{ENTER}")

        def value(n, kind):
            if kind == "edit":
                return n.iface_value.CurrentValue
            return n.legacy_properties()["Value"]

        def keys(sequence, handle=window.handle, packet=False):
            guard(handle)
            send_keys(sequence, with_spaces=True, vk_packet=packet, pause=.02)

        def quote(text):
            return re.sub(r"[+^%~{}()]", lambda m: "{" + m.group() + "}", literal(text))

        def edit(n, text):
            sequence = "^a" + (quote(text) if text else "{BACKSPACE}")
            click(n)
            require(wait_for(lambda: focused(n) and n.is_enabled() and visible(n)), "native-edit-focus")
            keys(sequence, packet=True)

        def terminal_focus():
            # The first console row beside Help avoids provider rows and update notices.
            click(control(terminal_help, "button", prefix=True), x_offset=-24)

        def terminal_type(text):
            keys(text)

        def rendered_text(labels):
            guard()

            def anchor():
                current = [n for n in nodes() if visible(n)]
                # UIA_AriaRolePropertyId exposes this dialog via native accessibility.
                dialogs = [n for n in current if n.element_info.element.GetCurrentPropertyValue(30101) == "dialog"]
                require(len(dialogs) <= 1 and not (dialogs and expected_version), "native-copy-dialog")
                if dialogs:
                    rect = dialogs[0].rectangle()
                    require(rect.width() > 32 and rect.height() > 32, "native-copy-bounds")
                    click_point(rect.left + 32, rect.top + 32)
                else:
                    buttons = [n for n in current if n.element_info.control_type == "Button" and name(n) in labels]
                    require(len(buttons) == 1, "native-copy-version-control")
                    rect = buttons[0].rectangle()
                    require(rect.width() > 0 and rect.height() > 0, "native-copy-bounds")
                    click_point(rect.left - 3, (rect.top + rect.bottom) // 2)

            def try_open():
                try:
                    win32clipboard.OpenClipboard(window.handle)
                except pywintypes.error:
                    return False
                return True

            def clear():
                require(wait_for(try_open, seconds=2), "native-clipboard-busy")
                try:
                    win32clipboard.EmptyClipboard()
                finally:
                    win32clipboard.CloseClipboard()

            def read():
                guard()
                if not try_open():
                    return ""
                try:
                    fmt = win32con.CF_UNICODETEXT
                    return win32clipboard.GetClipboardData(fmt) if win32clipboard.IsClipboardFormatAvailable(fmt) else ""
                finally:
                    win32clipboard.CloseClipboard()

            return copy_selection(anchor, lambda: keys("^a"), lambda: keys("^c"), lambda: keys("{RIGHT}"), clear, read)

        def folder(path):
            def chooser():
                handle = win32gui.GetForegroundWindow()
                if handle and handle != window.handle and is_foreground(handle):
                    require(win32gui.GetClassName(handle) == "#32770"
                            and win32gui.GetAncestor(handle, win32con.GA_ROOTOWNER) == window.handle,
                            "native-folder-dialog-owner")
                    return handle
                return None

            handle = wait_for(chooser)
            require(handle, "native-folder-dialog-unavailable")
            dialog = Desktop(backend="uia").window(handle=handle).wrapper_object()

            def closed():
                return not win32gui.IsWindow(handle) or not win32gui.IsWindowVisible(handle)

            def focused_edit():
                guard(handle)
                fields = [n for n in dialog.descendants(control_type="Edit")
                          if n.is_enabled() and visible(n) and focused(n)]
                require(len(fields) <= 1, "native-folder-location-count")
                return fields[0] if fields else None

            path_text = str(path)
            keys("^l", handle)
            address = wait_for(focused_edit)
            address_id = tuple(address.element_info.element.GetRuntimeId()) if address is not None else None
            require(address, "native-folder-location-unavailable")
            keys("^a" + quote(path_text), handle, packet=True)
            require(wait_for(lambda: focused(address) and value(address, "edit") == path_text),
                    "native-folder-location-mismatch")
            keys("{ENTER}", handle)

            def accept_ready():
                if closed():
                    return (None,)
                guard(handle)
                field = focused_edit()
                if field is not None and tuple(field.element_info.element.GetRuntimeId()) == address_id:
                    return None  # Explorer is still in address-edit mode.
                buttons = [n for n in dialog.descendants(control_type="Button") if visible(n)
                           and n.element_info.automation_id == str(win32con.IDOK)]
                require(len(buttons) <= 1, "native-folder-accept-count")
                return (buttons[0],) if buttons and buttons[0].is_enabled() else None

            ready = wait_for(accept_ready)
            require(ready, "native-folder-accept-unavailable")
            button, = ready
            if button is not None and not closed():
                invoke = button.iface_invoke
                require(button.is_enabled() and visible(button), "native-folder-accept-disabled")
                guard(handle)
                invoke.Invoke()  # The real IDOK, once; never click its logical owner or retry a response.
            require(wait_for(closed), "native-folder-dialog-not-closed")

        def capture(path):
            from PIL import ImageGrab
            guard()
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
        from gi.repository import GLib
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
        if copying and not q.get("pid"):
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

        def nodes(root=window):
            result, pending = [], [root]
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

        def state(n, flag):
            return n.getState().contains(flag)

        def enabled(n):
            return state(n, pyatspi.STATE_ENABLED) and state(n, pyatspi.STATE_SENSITIVE)

        def foreground(handle):
            active = run("xdotool", "getactivewindow")
            return int(active, 0) == int(handle, 0) and int(run("xdotool", "getwindowpid", active)) == pid

        def guard(handle=xid):
            require((handle != xid or visible(window)) and foreground(handle), "native-foreground-owner")

        def labelled(n, text):
            if control_id is not None:
                attrs = n.get_attributes()
                return control_id in (attrs.get("id"), attrs.get("html-id"))
            if name(n) == text:
                return True
            return any(name(relation.getTarget(i)) == text for relation in n.getRelationSet()
                       if relation.getRelationType() == pyatspi.RELATION_LABELLED_BY
                       for i in range(relation.getNTargets()))

        def control(text, kind, prefix=False):
            roles = {"button": "push button", "tab": "page tab", "combo": "combo box"}
            require(prefix or control_id or isinstance(text, str), "native-control-selector")

            def find():
                try:
                    return [n for n in nodes()
                            if (state(n, pyatspi.STATE_EDITABLE) if kind == "edit" else n.getRoleName() == roles[kind])
                            and (name(n).startswith(text) if prefix else labelled(n, text))]
                except (GLib.Error, ValueError):
                    app.clear_cache()
                    return []

            found = wait_for(find)
            require(len(found) == 1, "native-control-count")
            node = found[0]
            require(enabled(node), "native-control-disabled")
            if not visible(node):
                guard()
                require(node.queryComponent().scrollTo(pyatspi.SCROLL_ANYWHERE), "native-control-scroll")
                require(wait_for(lambda: visible(node)), "native-control-hidden")
            return node

        def extents(n):
            return n.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)

        def click_point(x, y):
            frame = extents(window)
            require(frame.x <= x < frame.x + frame.width and frame.y <= y < frame.y + frame.height,
                    "native-click-outside-window")
            guard()
            run("xdotool", "mousemove", str(x), str(y), "click", "1")

        def click(n, x_offset=None):
            require(enabled(n) and visible(n), "native-control-not-actionable")
            rect = extents(n)
            require(rect.width > 0 and rect.height > 0, "native-click-empty-bounds")
            click_point(rect.x + (rect.width // 2 if x_offset is None else x_offset), rect.y + rect.height // 2)

        def focus(n):
            guard()
            require(enabled(n) and visible(n), "native-control-not-actionable")
            require(n.queryComponent().grabFocus(), "native-control-focus")

        def select(n, index):
            focus(n)
            # Tab commits and leaves the WebKit/GTK combo popup before the next action.
            keys(["alt+Down", "Home", *(["Down"] * index), "Return", "Tab"])
            require(wait_for(lambda: not state(n, pyatspi.STATE_EXPANDED)), "native-combo-expanded")

        def read_text(n):
            text = n.queryText()
            return text.getText(0, text.characterCount)

        def value(n, kind):
            if kind == "edit":
                try:
                    return read_text(n)
                except NotImplementedError:
                    fields = [child for child in n if visible(child) and enabled(child)
                              and state(child, pyatspi.STATE_EDITABLE) and "Text" in child.get_interfaces()]
                    require(len(fields) == 1, "native-edit-text-interface")
                    return read_text(fields[0])
            selected = [child for child in nodes(n)[1:] if state(child, pyatspi.STATE_SELECTED)]
            require(len(selected) == 1, "native-combo-selected-count")
            return name(selected[0])

        def edit(n, text):
            text = literal(text)
            click(n)

            def field_focused():
                return (visible(n) and enabled(n) and state(n, pyatspi.STATE_EDITABLE)
                        and state(n, pyatspi.STATE_FOCUSED))

            require(wait_for(field_focused), "native-edit-focus")
            keys(["ctrl+a", "BackSpace"])
            if text:
                require(field_focused(), "native-edit-focus")
                type_text(text)

        def keys(sequence, handle=xid):
            guard(handle)
            run("xdotool", "key", "--clearmodifiers", *sequence)

        def type_text(text, handle=xid):
            guard(handle)
            run("xdotool", "type", "--clearmodifiers", "--delay", "0", "--", text)

        def terminal_focus():
            # The first console row beside Help avoids provider rows and update notices.
            click(control(terminal_help, "button", prefix=True), x_offset=-24)

        def terminal_type(text):
            type_text(text)

        def rendered_text(labels):
            require(wait_for(lambda: foreground(xid)), "native-foreground-owner")
            guard()

            def anchor():
                current = [n for n in nodes() if visible(n)]
                dialogs = [n for n in current if n.getRoleName() == "dialog"]
                require(len(dialogs) <= 1 and not (dialogs and expected_version), "native-copy-dialog")
                if dialogs:
                    rect = extents(dialogs[0])
                    require(rect.width > 32 and rect.height > 32, "native-copy-bounds")
                    click_point(rect.x + 32, rect.y + 32)
                else:
                    buttons = [n for n in current if n.getRoleName() == "push button" and name(n) in labels]
                    require(len(buttons) == 1, "native-copy-version-control")
                    rect = extents(buttons[0])
                    require(rect.width > 0 and rect.height > 0, "native-copy-bounds")
                    click_point(rect.x - 3, rect.y + rect.height // 2)

            def clear():
                subprocess.run(["xclip", "-selection", "clipboard", "-in"], input=b"", stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=5, check=True)

            def read():
                guard()
                try:
                    return run("xclip", "-selection", "clipboard", "-out")
                except subprocess.CalledProcessError:
                    return ""

            return copy_selection(anchor, lambda: keys(["ctrl+a"]), lambda: keys(["ctrl+c"]),
                                  lambda: keys(["Right"]), clear, read)

        def folder(path):
            def chooser():
                active = run("xdotool", "getactivewindow")
                return active if int(active, 0) != int(xid, 0) and foreground(active) else None

            handle = wait_for(chooser)
            require(handle, "native-folder-dialog-unavailable")
            title = run("xdotool", "getwindowname", handle)

            def dialog():
                candidates = [n for n in app if visible(n) and n != window and name(n) == title
                              and n.getRoleName() in {"file chooser", "dialog", "frame"}]
                require(len(candidates) <= 1, "native-folder-dialog-count")
                if candidates and any(n.getRoleName() == "file chooser" for n in nodes(candidates[0])):
                    return candidates[0]
                return None

            picker = wait_for(dialog)
            require(picker, "native-folder-dialog-unavailable")

            def location():
                guard(handle)
                fields = [n for n in nodes(picker) if visible(n) and enabled(n)
                          and state(n, pyatspi.STATE_EDITABLE) and state(n, pyatspi.STATE_FOCUSED)
                          and "Text" in n.get_interfaces()]
                require(len(fields) <= 1, "native-folder-location-count")
                return fields[0] if fields else None

            path_text = literal(str(path))
            # A fresh picker starts in Recent, where Select stays disabled. Enter browse mode first.
            keys(["alt+Home", "ctrl+l"], handle)
            entry = wait_for(location)
            require(entry, "native-folder-location-unavailable")
            keys(["ctrl+a"], handle)
            type_text(path_text, handle)

            # GTK can leave Select disabled until the typed location is committed.
            # Check the exact requested path before native Return; the caller
            # independently verifies the resulting project's persisted path.
            require(location() == entry and read_text(entry) == path_text, "native-folder-location-mismatch")

            def closed():
                return not any(int(line.split()[0], 16) == int(handle, 0)
                               for line in run("wmctrl", "-l").splitlines() if line.split())

            keys(["Return"], handle)
            # Some native GTK pickers accept the directory on Return.
            if wait_for(closed, seconds=2):
                return

            def accept_ready():
                buttons = [n for n in nodes(picker) if visible(n) and n.getRoleName() == "push button"
                           and name(n) in {"Select", "Open"}]
                require(len(buttons) <= 1, "native-folder-accept-count")
                return buttons[0] if buttons and enabled(buttons[0]) else None

            button = wait_for(accept_ready)
            require(button, "native-folder-accept-unavailable")
            action = button.queryAction()
            options = [i for i in range(action.nActions) if action.getName(i).lower() in {"click", "press", "activate"}]
            require(len(options) == 1 and enabled(button) and visible(button), "native-folder-accept-disabled")
            guard(handle)
            require(action.doAction(options[0]), "native-folder-accept-failed")
            require(wait_for(closed), "native-folder-dialog-not-closed")

        def capture(path):
            guard()
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

    if operation == "observe":
        wanted = q["texts"]
        absent = q.get("absentTexts", [])
        require(all(isinstance(items, list) and all(isinstance(item, str) for item in items)
                    for items in (wanted, absent)), "native-invalid-text-probes")
        if copying:
            text = rendered_text(version_labels)
            texts = [text]
            identity["textObservation"] = "owned native selection/copy; clipboard cleared; raw text not retained"
            if expected_version is not None:
                # The update button's accessible name is an action, not its visible version.
                # Parse the first brand, not a later transcript or notice mentioning a version.
                brand = HEADER_BRAND.search(text)
                version = HEADER_VERSION.match(text, brand.start()) if brand else None
                require(version, "native-header-version-unselected")
                require(version.group(1) == expected_version, "native-header-version-mismatch")
                identity["observedVersion"] = version.group(1)
                identity["versionObservation"] = identity["textObservation"]
        else:
            # PTY-sensitive reads never click, copy, refocus or resize the app.
            texts = []
            for n in (nodes() if wanted or absent else []):
                if not visible(n):
                    continue
                texts.append(name(n))
                if not windows:
                    try:
                        t = n.queryText()
                        texts.append(t.getText(0, min(t.characterCount, 4096)))
                    except NotImplementedError:
                        pass
        require(all(any(needle in text for text in texts) for needle in wanted), "expected-text-missing")
        require(not any(any(needle in text for text in texts) for needle in absent), "unexpected-text-present")
        identity["observedTexts"] = wanted  # Request probes only, not native or clipboard data.
    elif operation == "click":
        click(control(label, q["kind"]))
    elif operation == "select":
        index = q["index"]
        require(type(index) is int and 0 <= index <= 100, "native-invalid-combo-index")
        select(control(label, "combo"), index)
    elif operation == "focus":
        focus(control(label, q["kind"]))
    elif operation == "value":
        kind = q.get("kind", "combo")
        require(isinstance(q["expected"], str), "native-invalid-expected-value")
        require(value(control(label, kind), kind) == q["expected"], "native-control-value-mismatch")
    elif operation == "edit":
        edit(control(label, "edit"), q["text"])
    elif operation == "shortcut":
        shortcuts = {
            "previous-control": ("+{TAB}", ["shift+Tab"]),
            "open-folder": ("^+o", ["ctrl+shift+o"]),
            "new-session": ("^n", ["ctrl+n"]),
        }
        require(label in shortcuts, "native-unsupported-shortcut")
        keys(shortcuts[label][0 if windows else 1])
    elif operation == "folder":
        path = Path(q["path"]).resolve(strict=True)
        require(within(root, path) and path.is_dir())
        folder(path)
    elif operation == "terminal-text":
        text = q["text"]
        require(isinstance(text, str) and 0 < len(text) <= 128 and re.fullmatch(r"[a-z0-9]+", text),
                "native-invalid-terminal-text")
        terminal_focus()
        terminal_type(text)
    elif operation == "terminal-keys":
        # Space skips the splash; it never confirms provider setup.
        require(q["keys"] == "space", "native-unsupported-terminal-key")
        terminal_focus()
        keys("{SPACE}" if windows else ["space"])
    elif operation == "terminal-ocr":
        # Canvas TUI is read from the real mapped surface, never DOM/testhook output.
        with tempfile.TemporaryDirectory(prefix="native-ocr-", dir=root) as temp:
            image_path = Path(temp) / "surface.png"
            capture(image_path)
            from PIL import Image
            with Image.open(image_path) as image:
                width, height = image.size
                crop = image.crop((int(width * .25), int(height * .12), width, int(height * .94)))
                crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS).save(image_path)
            text = run(q["tesseract"], str(image_path), "stdout", "--psm", "11")
            require(any(re.search(pattern, text, re.IGNORECASE) for pattern in q["patterns"]))
            identity["terminalObservation"] = q["label"]
            identity["method"] = "native-window crop, fixed 2x LANCZOS screenshot OCR; raw text not retained"
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
            import termios

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
                        fd = os.open(proc / "fd/0", os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
                        try:
                            input_flags = termios.tcgetattr(fd)[3]
                        finally:
                            os.close(fd)
                        require(not input_flags & termios.ICANON, "native-pty-input-not-ready")
                        matches.append(child)
                except OSError:
                    continue
            require(len(matches) == 1)
            child_pid, pty = matches[0], "Linux /dev/pts stdin, noncanonical input and owned Desktop ancestry"
        identity["runtime"] = {"pid": child_pid, "path": str(runtime),
                               "sha256": file_hash(runtime), "cwd": str(project), "pty": pty}
    elif operation == "escape":
        keys("{ESC}" if windows else ["Escape"])
    elif operation == "close":
        close()
    else:
        raise NativeContractError("native-unsupported-operation")
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


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        print(json.dumps(main(request)))
    except Exception as error:
        # Only bounded static codes. Never expose OS exceptions, values, or native text.
        print(json.dumps({"error": "Owned native UI operation unavailable or assertion failed",
                          "code": error.args[0] if isinstance(error, NativeContractError) else "native-api"}))
        sys.exit(1)
