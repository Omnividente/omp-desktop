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
}: {
  startingTabs?: TerminalTab[]
  closeResult?: Promise<boolean>
  hasWorkspace?: boolean
  ompAvailable?: boolean
} = {}) {
  const [tabs, setTabs] = useState(startingTabs)
  return (
    <TerminalWorkspace
      activeTabId="terminal-1"
      focusRequest={null}
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
      tabs={tabs}
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
    expect(primaryAction().textContent).toContain("New session")
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
    expect(primaryAction().textContent).toContain("Open folder")
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
