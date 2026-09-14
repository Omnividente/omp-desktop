/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Terminal } from "@xterm/xterm"
import { TerminalView } from "./TerminalView"
import { openContentLink } from "./api"
import type { TerminalTab } from "./types"

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }))
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }))
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate() {}
    fit() {}
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
  id: "link-selection-test",
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
let terminal: Terminal

beforeEach(async () => {
  vi.clearAllMocks()
  // jsdom supplies events but not layout; keep xterm's real linkifier and selection service.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal("matchMedia", () => ({ addListener() {}, removeListener() {} }))
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return {
          measureText: (text: string) => ({
            width: text.length * 10,
            fontBoundingBoxAscent: 16,
            fontBoundingBoxDescent: 4,
          }),
        }
      }
    },
  )
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 800, 560),
  )
  const open = vi.spyOn(Terminal.prototype, "open")
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
  terminal = open.mock.contexts[0] as Terminal
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mouse(type: string, x: number, buttons = 0) {
  const screen = container.querySelector(".xterm-screen")!
  act(() =>
    screen.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: 10,
        button: 0,
        buttons,
        detail: 1,
      }),
    ),
  )
}

it.each([
  {
    kind: "OSC-8 folder",
    uri: "file:///tmp/folder",
    output: "\x1b]8;;file:///tmp/folder\x1b\\Folder link\x1b]8;;\x1b\\",
  },
  { kind: "plain web URL", uri: "https://example.test/path", output: "https://example.test/path" },
])("ends the selection gesture when opening a $kind", async ({ uri, output }) => {
  await act(
    async () =>
      new Promise<void>((resolve) => terminal.write(output + " trailing text\r\n", resolve)),
  )
  mouse("mousemove", 25)
  await vi.waitFor(() =>
    expect(container.querySelector(".terminal-link-preview")?.textContent).toBe(uri),
  )
  mouse("mousedown", 25, 1)
  mouse("mouseup", 25)
  expect(openContentLink).toHaveBeenCalledExactlyOnceWith(uri, tab.sessionPath)
  mouse("mousemove", 355)
  expect(terminal.getSelection()).toBe("")

  // A deliberate drag can still select link text without following the link.
  mouse("mousemove", 25)
  await vi.waitFor(() =>
    expect(container.querySelector(".terminal-link-preview")?.textContent).toBe(uri),
  )
  mouse("mousedown", 25, 1)
  mouse("mousemove", 75, 1)
  mouse("mouseup", 75)
  const selected = terminal.getSelection()
  expect(selected).toBe(uri.startsWith("file:") ? "lder " : "tps:/")
  expect(openContentLink).toHaveBeenCalledTimes(1)
  mouse("mousemove", 355)
  expect(terminal.getSelection()).toBe(selected)
})
