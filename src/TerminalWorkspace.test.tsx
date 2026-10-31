/** @vitest-environment jsdom */

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalWorkspace } from "./TerminalWorkspace"
import type { TerminalTab } from "./types"
import { reorderTerminalTabs } from "./uiUtils"

vi.mock("./TerminalView", () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) => <div data-terminal-view={terminalId} />,
}))

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function tab(id: string, label: string): TerminalTab {
  return {
    id,
    label,
    pinnedTitle: null,
    cwd: "/tmp/project",
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

const initialTabs = [
  tab("terminal-1", "First"),
  tab("terminal-2", "Second"),
  tab("terminal-3", "Third"),
]

function Harness({
  startingTabs = initialTabs,
  closeResult,
  hasWorkspace = true,
  ompAvailable = true,
  activeTabId = "terminal-1",
  focusRequest = null,
  visibleTabs,
}: {
  startingTabs?: TerminalTab[]
  closeResult?: Promise<boolean>
  hasWorkspace?: boolean
  ompAvailable?: boolean
  activeTabId?: string | null
  focusRequest?: { terminalId: string; sequence: number } | null
  visibleTabs?: TerminalTab[]
} = {}) {
  const [tabs, setTabs] = useState(startingTabs)
  return (
    <TerminalWorkspace
      activeTabId={activeTabId}
      focusRequest={focusRequest}
      language="en"
      terminalFontFamily="monospace"
      terminalFontSize={14}
      launching={null}
      installingDesktopUpdate={false}
      ompConfig={null}
      runtime={{
        platform: "windows",
        arch: "x86_64",
        language: "en",
        ompAvailable,
        ompExecutable: "omp",
        ompVersion: "omp/18.0.11",
        sessionRoot: "/tmp/sessions",
      }}
      runtimeStatusByTerminal={{}}
      selectedSession={null}
      selectedWorkspace={
        hasWorkspace
          ? {
              key: "project",
              path: "/tmp/project",
              name: "Project",
              sessionCount: 0,
              lastActive: 0,
              pinned: false,
            }
          : null
      }
      tabs={visibleTabs ?? tabs}
      workspaceSessions={[]}
      onCloseTab={(id) => {
        const close = () => setTabs((current) => current.filter((candidate) => candidate.id !== id))
        if (closeResult) {
          void closeResult.then((accepted) => {
            if (accepted) close()
          })
        } else {
          close()
        }
      }}
      onDiscardSwitchRecovery={vi.fn()}
      onError={vi.fn()}
      onExit={vi.fn()}
      onFocusTab={vi.fn()}
      onLaunch={vi.fn()}
      onOpenFolder={vi.fn()}
      onReadTranscript={vi.fn()}
      onReady={vi.fn()}
      onReorderTabs={(draggedId, targetId) =>
        setTabs((current) => reorderTerminalTabs(current, draggedId, targetId))
      }
      onReveal={vi.fn()}
      onSendSwitchRecovery={vi.fn()}
      onSwitch={vi.fn()}
      onTogglePrimaryProviderPin={vi.fn()}
      onToggleTitlePin={vi.fn()}
    />
  )
}

function dispatchDrag(source: Element, target: Element) {
  const values = new Map<string, string>()
  const dataTransfer = {
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? "",
  }
  const dragStart = new Event("dragstart", { bubbles: true, cancelable: true })
  Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer })
  source.dispatchEvent(dragStart)
  const drop = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(drop, "dataTransfer", { value: dataTransfer })
  target.dispatchEvent(drop)
}

describe("TerminalWorkspace tab drag and drop", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<Harness />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("moves the dragged tab to the dropped tab position", () => {
    const tabs = () => Array.from(container.querySelectorAll<HTMLElement>(".terminal-tab"))
    const labels = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".terminal-tab-label"), (node) =>
        node.textContent?.trim(),
      )

    expect(labels()).toEqual(["First", "Second", "Third"])
    act(() => dispatchDrag(tabs()[0]!, tabs()[2]!))
    expect(labels()).toEqual(["Second", "Third", "First"])

    act(() => dispatchDrag(tabs()[2]!, tabs()[0]!))
    expect(labels()).toEqual(["First", "Second", "Third"])
  })
})

describe("TerminalWorkspace last-tab focus", () => {
  let container: HTMLDivElement
  let outside: HTMLInputElement
  let root: Root
  const lastTab = [tab("terminal-1", "Last")]

  beforeEach(() => {
    outside = document.createElement("input")
    outside.setAttribute("aria-label", "Outside workspace")
    container = document.createElement("div")
    document.body.append(outside, container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    outside.remove()
  })

  function closeButton() {
    return container.querySelector<HTMLButtonElement>(".tab-close")!
  }

  function primaryAction() {
    return container.querySelector<HTMLButtonElement>(".main-stage .button.primary")!
  }

  function deferredClose() {
    let finish!: (accepted: boolean) => void
    const result = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    return { result, finish }
  }

  it("moves focus from the removed last tab to New session", () => {
    act(() => root.render(<Harness startingTabs={lastTab} />))
    closeButton().focus()
    act(() => closeButton().click())
    expect(document.activeElement).toBe(primaryAction())
  })

  it("does not autofocus an initially empty workspace", () => {
    outside.focus()
    act(() => root.render(<Harness startingTabs={[]} />))
    expect(document.activeElement).toBe(outside)
  })

  it("uses Open folder when no workspace is selected", () => {
    act(() => root.render(<Harness startingTabs={lastTab} hasWorkspace={false} />))
    closeButton().focus()
    act(() => closeButton().click())
    expect(document.activeElement).toBe(primaryAction())
  })

  it("uses an enabled Home action when the runtime is unavailable", () => {
    act(() => root.render(<Harness startingTabs={lastTab} ompAvailable={false} />))
    closeButton().focus()
    act(() => closeButton().click())
    expect(primaryAction().disabled).toBe(true)
    expect(document.activeElement).toBe(container.querySelector(".hero-path"))
  })

  it("preserves focus moved outside while an async close is pending", async () => {
    const pending = deferredClose()
    act(() => root.render(<Harness startingTabs={lastTab} closeResult={pending.result} />))
    closeButton().focus()
    act(() => closeButton().click())
    outside.focus()
    await act(async () => pending.finish(true))
    expect(container.querySelector(".workspace-home")).not.toBeNull()
    expect(document.activeElement).toBe(outside)
  })

  it("does not reclaim focus after an outside pointer action", async () => {
    const pending = deferredClose()
    act(() => root.render(<Harness startingTabs={lastTab} closeResult={pending.result} />))
    const button = closeButton()
    button.focus()
    act(() => button.click())
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    button.blur()
    await act(async () => pending.finish(true))
    expect(container.querySelector(".workspace-home")).not.toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it("keeps the tab and its focus when closing is cancelled", async () => {
    const pending = deferredClose()
    act(() => root.render(<Harness startingTabs={lastTab} closeResult={pending.result} />))
    const button = closeButton()
    button.focus()
    act(() => button.click())
    await act(async () => pending.finish(false))
    expect(closeButton()).toBe(button)
    expect(document.activeElement).toBe(button)
  })
})

describe("TerminalWorkspace selected-header reveal", () => {
  let container: HTMLDivElement
  let outside: HTMLTextAreaElement
  let root: Root
  let viewportWidth: number
  let contentWidth: number
  let headerWidth: number
  let stripLeft: number

  const strip = () => container.querySelector<HTMLDivElement>(".terminal-tabs-scroll")!
  const rect = (left: number, width: number) =>
    ({
      left,
      right: left + width,
      width,
      top: 20,
      bottom: 50,
      height: 30,
      x: left,
      y: 20,
    }) as DOMRect

  beforeEach(() => {
    viewportWidth = 300
    contentWidth = 1200
    headerWidth = 100
    stripLeft = 120
    container = document.createElement("div")
    outside = document.createElement("textarea")
    document.body.append(outside, container)
    root = createRoot(container)
    const originalRect = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if (this.classList.contains("terminal-tabs-scroll")) return rect(stripLeft, viewportWidth + 8)
      if (this.classList.contains("terminal-tab")) {
        const label = this.querySelector(".terminal-tab-label")?.textContent
        const start = label === "First" ? 0 : label === "Second" ? 360 : 720
        return rect(stripLeft + 4 + start - strip().scrollLeft, headerWidth)
      }
      return originalRect.call(this)
    })
    vi.spyOn(Element.prototype, "clientLeft", "get").mockReturnValue(4)
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("terminal-tabs-scroll") ? viewportWidth : 0
    })
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("terminal-tabs-scroll") ? contentWidth : 0
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.restoreAllMocks()
    container.remove()
    outside.remove()
  })

  it("reveals selection to either side using the strip's bordered viewport only", () => {
    act(() => root.render(<Harness />))
    const ancestor = container.querySelector<HTMLElement>(".main-stage")!
    ancestor.scrollTop = 42
    ancestor.scrollLeft = 19
    strip().scrollTop = 7
    outside.focus()
    act(() => root.render(<Harness activeTabId="terminal-3" />))
    expect(strip().scrollLeft).toBe(520)
    act(() => root.render(<Harness activeTabId="terminal-1" />))
    expect(strip().scrollLeft).toBe(0)
    expect(strip().scrollTop).toBe(7)
    expect(ancestor.scrollTop).toBe(42)
    expect(ancestor.scrollLeft).toBe(19)
    expect(document.activeElement).toBe(outside)
  })

  it("reveals a newly created selected header", () => {
    act(() => root.render(<Harness visibleTabs={initialTabs.slice(0, 2)} />))
    act(() => root.render(<Harness visibleTabs={initialTabs} activeTabId="terminal-3" />))
    expect(strip().scrollLeft).toBe(520)
  })

  it("re-reveals only a newer matching explicit focus request", () => {
    const render = (terminalId: string, sequence: number) => {
      act(() =>
        root.render(<Harness activeTabId="terminal-3" focusRequest={{ terminalId, sequence }} />),
      )
    }
    render("terminal-3", 10)
    strip().scrollLeft = 0
    render("terminal-3", 10)
    expect(strip().scrollLeft).toBe(0)
    render("terminal-3", 9)
    expect(strip().scrollLeft).toBe(0)
    render("terminal-2", 11)
    expect(strip().scrollLeft).toBe(0)
    render("terminal-3", 10)
    expect(strip().scrollLeft).toBe(0)
    render("terminal-3", 12)
    expect(strip().scrollLeft).toBe(520)
  })

  it("preserves manual scroll on status/title updates, reorder and ordinary rerenders", () => {
    act(() => root.render(<Harness activeTabId="terminal-3" />))
    strip().scrollLeft = 17
    const updated = initialTabs.map((item) =>
      item.id === "terminal-3"
        ? { ...item, label: "Updated", activity: "thinking" as const }
        : item,
    )
    act(() => root.render(<Harness activeTabId="terminal-3" visibleTabs={updated} />))
    expect(strip().scrollLeft).toBe(17)
    act(() =>
      root.render(<Harness activeTabId="terminal-3" visibleTabs={[...updated].reverse()} />),
    )
    expect(strip().scrollLeft).toBe(17)
    act(() =>
      root.render(<Harness activeTabId="terminal-3" visibleTabs={[...updated].reverse()} />),
    )
    expect(strip().scrollLeft).toBe(17)
  })

  it("aligns an oversized header at its start and clamps to the scrollable range", () => {
    headerWidth = 500
    act(() => root.render(<Harness activeTabId="terminal-3" />))
    expect(strip().scrollLeft).toBe(720)
    contentWidth = 950
    act(() => root.render(<Harness activeTabId="terminal-2" />))
    expect(strip().scrollLeft).toBe(360)
    act(() => root.render(<Harness activeTabId="terminal-3" />))
    expect(strip().scrollLeft).toBe(650)
  })

  it("does not scroll an already visible header", () => {
    act(() => root.render(<Harness />))
    strip().scrollLeft = 300
    act(() => root.render(<Harness activeTabId="terminal-2" />))
    expect(strip().scrollLeft).toBe(300)
  })

  it.each(["hidden", "invalid", "missing"] as const)(
    "consumes a reveal with %s geometry without retrying on ordinary renders",
    (problem) => {
      if (problem === "hidden") viewportWidth = 0
      if (problem === "invalid") stripLeft = Number.NaN
      act(() =>
        root.render(
          <Harness
            activeTabId="terminal-3"
            visibleTabs={problem === "missing" ? initialTabs.slice(0, 2) : initialTabs}
          />,
        ),
      )
      expect(strip().scrollLeft).toBe(0)
      viewportWidth = 300
      stripLeft = 120
      act(() => root.render(<Harness activeTabId="terminal-3" visibleTabs={initialTabs} />))
      expect(strip().scrollLeft).toBe(0)
      act(() =>
        root.render(
          <Harness
            activeTabId="terminal-3"
            focusRequest={{ terminalId: "terminal-3", sequence: 1 }}
          />,
        ),
      )
      expect(strip().scrollLeft).toBe(520)
    },
  )
})
