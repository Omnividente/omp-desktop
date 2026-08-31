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

function Harness() {
  const [tabs, setTabs] = useState(initialTabs)
  return (
    <TerminalWorkspace
      activeTabId="terminal-1"
      focusRequest={null}
      language="en"
      terminalFontFamily="monospace"
      terminalFontSize={14}
      launching={null}
      ompConfig={null}
      runtime={{
        platform: "windows",
        arch: "x86_64",
        language: "en",
        ompAvailable: true,
        ompExecutable: "omp",
        ompVersion: "omp/18.0.11",
        sessionRoot: "/tmp/sessions",
      }}
      runtimeStatusByTerminal={{}}
      selectedSession={null}
      selectedWorkspace={{
        key: "project",
        path: "/tmp/project",
        name: "Project",
        sessionCount: 0,
        lastActive: 0,
        pinned: false,
      }}
      tabs={tabs}
      workspaceSessions={[]}
      onCloseTab={vi.fn()}
      onDiscardSwitchRecovery={vi.fn()}
      onError={vi.fn()}
      onExit={vi.fn()}
      onFocusTab={vi.fn()}
      onLaunch={vi.fn()}
      onOpenFolder={vi.fn()}
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
