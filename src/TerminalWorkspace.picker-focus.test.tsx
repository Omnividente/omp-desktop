/** @vitest-environment jsdom */
import { act, createRef, useImperativeHandle, useRef, useState, type Ref } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalWorkspace } from "./TerminalWorkspace"
import { attachTerminal, writeTerminal, writeTerminalBinary } from "./api"
import { forgetTerminalContinuity } from "./terminalContinuity"
import type { PtyOutputEvent, TerminalTab } from "./types"
// Real Workspace/View/picker/useModalFocus. Only native and xterm boundaries are mocked.
vi.mock("./SessionControls", () => ({ SessionControls: () => null }))
vi.mock("./CompletedAnswers", () => ({ CompletedAnswers: () => null }))
const terminalState = vi.hoisted(() => ({
  selection: "",
  focus: vi.fn(),
  paste: vi.fn(),
  clear: vi.fn(),
  selectionChanged: null as (() => void) | null,
  scrollChanged: null as (() => void) | null,
  outputListener: null as ((event: { payload: PtyOutputEvent }) => void) | null,
  writeCallbacks: [] as Array<() => void>,
  written: [] as string[],
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
    proposeDimensions() {
      return { cols: 80, rows: 24 }
    }
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
    private readonly input = document.createElement("textarea")
    constructor(options: Record<string, unknown>) {
      this.options = options
      terminalState.instance = this
    }
    loadAddon() {}
    open(container: HTMLElement) {
      this.input.className = "mock-terminal-input"
      container.appendChild(this.input)
    }
    refresh() {}
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
      this.input.focus()
    }
    paste(input: string) {
      terminalState.paste(input)
    }
    scrollToBottom() {
      terminalState.scrollToBottom()
      this.buffer.active.viewportY = this.buffer.active.baseY
      terminalState.scrollChanged?.()
    }
    write(data: string | Uint8Array, callback?: () => void) {
      terminalState.written.push(typeof data === "string" ? data : new TextDecoder().decode(data))
      if (callback) terminalState.writeCallbacks.push(callback)
    }
    dispose() {
      this.input.remove()
    }
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
const attachment = {
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
}
function tab(index: number, label = `Task ${index}`): TerminalTab {
  return {
    id: `picker-race-${index}`,
    label,
    pinnedTitle: null,
    cwd: `/synthetic/project-${index}`,
    processId: null,
    sessionId: null,
    sessionPath: null,
    status: "running",
    activity: "idle",
    exitCode: null,
    success: null,
    kind: "agent",
    switching: false,
    switchRecovery: null,
    primaryProviderPinned: false,
    primaryProviderPinPending: false,
  }
}
const effects = vi.fn()
interface Controls {
  request: (id: string) => void
}
function Harness({
  ref,
  initial = [tab(0), tab(1), tab(2)],
}: {
  ref: Ref<Controls>
  initial?: TerminalTab[]
}) {
  const tabs = initial
  const [active, setActive] = useState("picker-race-0")
  const [focus, setFocus] = useState<{ terminalId: string; sequence: number } | null>(null)
  const sequence = useRef(0)
  const request = (id: string) => {
    setActive(id)
    setFocus({ terminalId: id, sequence: ++sequence.current })
  }
  useImperativeHandle(ref, () => ({ request }))
  return (
    <TerminalWorkspace
      activeTabId={active}
      focusRequest={focus}
      language="en"
      terminalFontFamily="monospace"
      terminalFontSize={14}
      launching={null}
      installingDesktopUpdate={false}
      ompConfig={null}
      runtime={{
        platform: "linux",
        arch: "x86_64",
        language: "en",
        ompAvailable: true,
        ompExecutable: "synthetic-omp",
        ompVersion: null,
        sessionRoot: "/synthetic/sessions",
      }}
      runtimeStatusByTerminal={{}}
      selectedSession={null}
      selectedWorkspace={null}
      tabs={tabs}
      workspaceSessions={[]}
      onCloseTab={effects}
      onDiscardSwitchRecovery={effects}
      onError={effects}
      onExit={effects}
      onFocusTab={setActive}
      onFocusTerminal={request}
      onShowWorkspace={effects}
      onLaunch={effects}
      onOpenFolder={effects}
      onReadTranscript={effects}
      onReady={() => undefined}
      onReorderTabs={effects}
      onReveal={effects}
      onSendSwitchRecovery={effects}
      onSwitch={effects}
      onTogglePrimaryProviderPin={effects}
      onToggleTitlePin={effects}
    />
  )
}

describe("open tab picker delayed focus cancellation", () => {
  let container: HTMLDivElement, root: Root
  let controls: ReturnType<typeof createRef<Controls>>
  let frameId = 0
  let frames: Map<number, FrameRequestCallback>
  const trigger = () => container.querySelector<HTMLButtonElement>(".terminal-tab-picker-trigger")!
  const input = () => container.querySelector<HTMLInputElement>(".terminal-tab-picker input")!
  const activeInput = () => container.querySelector(".terminal-pane.is-active textarea")
  function key(target: Element, name: string, extra: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
      ...extra,
    })
    act(() => target.dispatchEvent(event))
    return event
  }
  function open() {
    trigger().focus()
    act(() => trigger().click())
    expect(document.activeElement).toBe(input())
  }
  function search(value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(),
        value,
      )
      input().dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  async function flush() {
    await act(async () => {
      await Promise.resolve()
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((callback) => callback(0))
      await Promise.resolve()
    })
  }
  async function render() {
    await act(async () => root.render(<Harness ref={controls} />))
    await flush()
  }
  beforeEach(() => {
    vi.clearAllMocks()
    terminalState.selection = ""
    terminalState.fitThrows = false
    terminalState.writeCallbacks = []
    for (let i = 0; i < 32; i++) forgetTerminalContinuity(`picker-race-${i}`)
    vi.mocked(attachTerminal).mockResolvedValue(attachment)
    frames = new Map()
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback)
      return frameId
    })
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    )
    controls = createRef<Controls>()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    expect(writeTerminal).not.toHaveBeenCalled()
    expect(writeTerminalBinary).not.toHaveBeenCalled()
    expect(effects).not.toHaveBeenCalled()
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const dismissals = ["Escape", "Close", "backdrop"] as const
  function dismissPicker(method: (typeof dismissals)[number]) {
    if (method === "Escape") key(input(), "Escape")
    else if (method === "Close")
      act(() =>
        container.querySelector<HTMLButtonElement>(".terminal-tab-picker .icon-button")!.click(),
      )
    else
      act(() =>
        container
          .querySelector(".terminal-tab-picker-backdrop")!
          .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
      )
  }
  it.each(
    dismissals.flatMap((method) => [
      [method, "picker-race-0"] as const,
      [method, "picker-race-1"] as const,
    ]),
  )("consumes %s-before-animation-frame explicit request to %s", async (method, id) => {
    await render()
    open()
    act(() => controls.current!.request(id))
    expect(document.activeElement).toBe(input())
    dismissPicker(method)
    expect(document.activeElement).toBe(trigger())
    await flush()
    expect(document.activeElement).toBe(trigger())
    act(() => controls.current!.request(id))
    await flush()
    expect(document.activeElement).toBe(activeInput())
  })
  it.each(dismissals)("consumes %s-before-animation-frame late attach focus", async (method) => {
    let release!: (value: typeof attachment) => void
    vi.mocked(attachTerminal).mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    await render()
    open()
    await act(async () => release(attachment))
    expect(document.activeElement).toBe(input())
    dismissPicker(method)
    expect(document.activeElement).toBe(trigger())
    await flush()
    expect(document.activeElement).toBe(trigger())
    open()
    search("project-0")
    key(input(), "Enter")
    await flush()
    expect(document.activeElement).toBe(activeInput())
  })
})
