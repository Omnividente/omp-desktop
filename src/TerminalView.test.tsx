/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { resizeTerminal } from "./api"
import { TerminalView } from "./TerminalView"
import type { PtyOutputEvent, TerminalTab } from "./types"
import { forgetTerminalContinuity } from "./terminalContinuity"

const terminalState = vi.hoisted(() => ({
  selection: "",
  focus: vi.fn(),
  paste: vi.fn(),
  clear: vi.fn(),
  selectionChanged: null as (() => void) | null,
  scrollChanged: null as (() => void) | null,
  outputListener: null as ((event: { payload: PtyOutputEvent }) => void) | null,
  writeCallbacks: [] as Array<() => void>,
  scrollToBottom: vi.fn(),
  fitThrows: false,
  instance: null as {
    cols: number
    rows: number
    options: Record<string, unknown>
    buffer: { active: { viewportY: number; baseY: number } }
  } | null,
}))
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: PtyOutputEvent }) => void) => {
    if (name.startsWith("pty-output:")) terminalState.outputListener = callback
    return () => undefined
  }),
}))
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      if (terminalState.fitThrows) throw new Error("zero-sized terminal")
      if (terminalState.instance) {
        terminalState.instance.cols = terminalState.instance.options.fontSize === 16 ? 70 : 80
      }
    }
  },
}))
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }))
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80
    rows = 24
    modes = { bracketedPasteMode: false, mouseTrackingMode: "none" }
    buffer = { active: { viewportY: 0, baseY: 0 } }
    options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      this.options = options
      terminalState.instance = this
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onSelectionChange(callback: () => void) {
      terminalState.selectionChanged = callback
      return { dispose() {} }
    }
    onScroll(callback: () => void) {
      terminalState.scrollChanged = callback
      return { dispose() {} }
    }
    onData() {
      return { dispose() {} }
    }
    onBinary() {
      return { dispose() {} }
    }
    hasSelection() {
      return terminalState.selection.length > 0
    }
    getSelection() {
      return terminalState.selection
    }
    clearSelection() {
      terminalState.clear()
      terminalState.selection = ""
      terminalState.selectionChanged?.()
    }
    focus() {
      terminalState.focus()
    }
    paste(input: string) {
      terminalState.paste(input)
    }
    scrollToBottom() {
      terminalState.scrollToBottom()
      this.buffer.active.viewportY = this.buffer.active.baseY
      terminalState.scrollChanged?.()
    }
    write(_data: string | Uint8Array, callback?: () => void) {
      if (callback) terminalState.writeCallbacks.push(callback)
    }
    dispose() {}
  },
}))
vi.mock("./api", () => ({
  openContentLink: vi.fn().mockResolvedValue(undefined),
  attachTerminal: vi.fn().mockResolvedValue({
    data: "",
    generation: 1,
    firstSeq: null,
    lastSeq: null,
    nextSeq: 1,
    truncated: false,
    droppedBytes: 0,
    baselineReset: false,
    exited: false,
    exitCode: null,
    success: true,
    error: null,
  }),
  detachTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  writeTerminal: vi.fn().mockResolvedValue(undefined),
  writeTerminalBinary: vi.fn().mockResolvedValue(undefined),
  errorMessage: (error: unknown) => String(error),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const tab: TerminalTab = {
  id: "selection-test",
  label: "Synthetic",
  pinnedTitle: null,
  cwd: "/tmp/project",
  processId: 1,
  sessionId: "synthetic",
  sessionPath: "/tmp/synthetic.jsonl",
  status: "running",
  activity: "idle",
  exitCode: null,
  success: null,
  kind: "agent",
  switching: false,
  switchRecovery: null,
  currentModel: "provider/model",
  currentModelRole: "default",
  currentThinking: null,
  currentThinkingConfigured: null,
  primaryProviderPinned: false,
  primaryProviderPinPending: false,
}
let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  vi.clearAllMocks()
  terminalState.selection = ""
  terminalState.fitThrows = false
  terminalState.instance = null
  terminalState.scrollChanged = null
  terminalState.outputListener = null
  terminalState.writeCallbacks = []
  forgetTerminalContinuity(tab.id)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal("requestAnimationFrame", () => 1)
  vi.stubGlobal("cancelAnimationFrame", () => undefined)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TerminalView
        tab={tab}
        active
        focusRequestSequence={0}
        language="en"
        terminalFontFamily="monospace"
        terminalFontSize={14}
        platform="linux"
        onExit={() => undefined}
        onError={() => undefined}
        onReady={() => undefined}
      />,
    ),
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
function showSelection(text: string) {
  terminalState.selection = text
  const host = container.querySelector(".terminal-host")!
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 })
  act(() => host.dispatchEvent(down))
  expect(down.defaultPrevented).toBe(true)
  act(() => host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))
}
function menuButton(label: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (button) => button.textContent === label,
  )!
}

it("copies the exact selection captured before menu interaction without pasting or clearing it", async () => {
  showSelection("  selected\ntext  ")
  const copy = menuButton("Copy")
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
  act(() => copy.dispatchEvent(down))
  expect(down.defaultPrevented).toBe(true)
  expect(terminalState.clear).not.toHaveBeenCalled()
  await act(async () => copy.click())
  expect(writeText).toHaveBeenCalledWith("  selected\ntext  ")
  expect(terminalState.selection).toBe("  selected\ntext  ")
  expect(terminalState.paste).not.toHaveBeenCalled()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(terminalState.focus).toHaveBeenCalled()
})

it("retains Reply quoting and clears only after choosing Reply; Escape dismisses without clearing", async () => {
  showSelection("first\nsecond")
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  act(() => window.dispatchEvent(escape))
  expect(escape.defaultPrevented).toBe(true)
  expect(terminalState.selection).toBe("first\nsecond")
  expect(terminalState.paste).not.toHaveBeenCalled()
  showSelection("first\nsecond")
  const reply = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (button) => button.textContent !== "Copy",
  )!
  await act(async () => reply.click())
  expect(terminalState.paste.mock.calls[0][0]).toContain("first")
  expect(terminalState.paste.mock.calls[0][0]).toContain("second")
  expect(terminalState.clear).toHaveBeenCalledOnce()
  expect(writeText).not.toHaveBeenCalled()
})

it("resizes the PTY when font metrics change without container resize", async () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback))
  try {
    await act(async () =>
      root.render(
        <TerminalView
          tab={tab}
          active
          focusRequestSequence={1}
          language="en"
          terminalFontFamily="monospace"
          terminalFontSize={14}
          platform="linux"
          onExit={() => undefined}
          onError={() => undefined}
          onReady={() => undefined}
        />,
      ),
    )
    await act(async () => frames.splice(0).forEach((frame) => frame(0)))
    vi.mocked(resizeTerminal).mockClear()

    await act(async () =>
      root.render(
        <TerminalView
          tab={tab}
          active
          focusRequestSequence={1}
          language="en"
          terminalFontFamily="monospace"
          terminalFontSize={16}
          platform="linux"
          onExit={() => undefined}
          onError={() => undefined}
          onReady={() => undefined}
        />,
      ),
    )
    await act(async () => frames.splice(0).forEach((frame) => frame(0)))
    expect(resizeTerminal).toHaveBeenCalledWith(tab.id, 70, 24)
  } finally {
    width.mockRestore()
  }
})

it("restores keyboard focus when fit fails during tab activation", async () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback))
  try {
    await act(async () =>
      root.render(
        <TerminalView
          tab={tab}
          active={false}
          focusRequestSequence={0}
          language="en"
          terminalFontFamily="monospace"
          terminalFontSize={14}
          platform="linux"
          onExit={() => undefined}
          onError={() => undefined}
          onReady={() => undefined}
        />,
      ),
    )
    terminalState.fitThrows = true
    terminalState.focus.mockClear()
    await act(async () =>
      root.render(
        <TerminalView
          tab={tab}
          active
          focusRequestSequence={0}
          language="en"
          terminalFontFamily="monospace"
          terminalFontSize={14}
          platform="linux"
          onExit={() => undefined}
          onError={() => undefined}
          onReady={() => undefined}
        />,
      ),
    )
    await act(async () => frames.splice(0).forEach((frame) => frame(0)))
    expect(terminalState.focus).toHaveBeenCalled()
  } finally {
    width.mockRestore()
  }
})

it("shows a labeled return control only away from the latest output", async () => {
  const buffer = terminalState.instance!.buffer.active
  expect(container.querySelector(".terminal-scroll-bottom")).toBeNull()
  act(() => {
    buffer.baseY = 26
    buffer.viewportY = 8
    terminalState.scrollChanged?.()
  })
  const button = container.querySelector<HTMLButtonElement>(".terminal-scroll-bottom")!
  expect(button.getAttribute("aria-label")).toBe("Jump to latest output")
  await act(async () => button.click())
  expect(buffer.viewportY).toBe(buffer.baseY)
  expect(container.querySelector(".terminal-scroll-bottom")).toBeNull()
  expect(terminalState.focus).toHaveBeenCalled()
})

it("recovers an output-induced viewport jump when following live output", () => {
  const buffer = terminalState.instance!.buffer.active
  const sendOutput = (seq: number) => {
    terminalState.outputListener?.({
      payload: { terminalId: tab.id, generation: 1, seq, data: btoa("next\r\n") },
    })
  }
  act(() => sendOutput(1))
  expect(terminalState.writeCallbacks).toHaveLength(1)
  act(() => {
    buffer.baseY = 30
    buffer.viewportY = 8
    terminalState.scrollChanged?.()
    terminalState.writeCallbacks.shift()?.()
  })
  expect(buffer.viewportY).toBe(30)
  expect(terminalState.scrollToBottom).toHaveBeenCalledOnce()
})

it("does not override a user's scroll while PTY output is pending", () => {
  const buffer = terminalState.instance!.buffer.active
  act(() => {
    terminalState.outputListener?.({
      payload: { terminalId: tab.id, generation: 1, seq: 1, data: btoa("next\r\n") },
    })
    container
      .querySelector(".terminal-host")!
      .dispatchEvent(new WheelEvent("wheel", { bubbles: true }))
    buffer.baseY = 31
    buffer.viewportY = 11
    terminalState.scrollChanged?.()
    terminalState.writeCallbacks.shift()?.()
  })
  expect(buffer.viewportY).toBe(11)
  expect(terminalState.scrollToBottom).not.toHaveBeenCalled()
  expect(container.querySelector(".terminal-scroll-bottom")).not.toBeNull()
})
