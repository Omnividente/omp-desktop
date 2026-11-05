/** @vitest-environment jsdom */

import { act, useEffect, useState, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalWorkspace } from "./TerminalWorkspace"
import type { TerminalTab } from "./types"

const lifecycle = vi.hoisted(() => ({ mounts: [] as string[], disposals: [] as string[] }))

vi.mock("./TerminalView", () => ({
  TerminalView: ({ tab, active }: { tab: TerminalTab; active: boolean }) => {
    useEffect(() => {
      lifecycle.mounts.push(tab.id)
      return () => {
        lifecycle.disposals.push(tab.id)
      }
    }, [tab.id])
    return <div data-terminal-view={tab.id} data-active={active} />
  },
}))
vi.mock("./CompletedAnswers", () => ({
  CompletedAnswers: ({ active }: { active: boolean }) => <div data-answers-active={active} />,
}))

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const tabs: TerminalTab[] = ["one", "two"].map((id) => ({
  id,
  label: id,
  pinnedTitle: null,
  cwd: "/synthetic/project",
  processId: 42,
  sessionId: id,
  sessionPath: `/synthetic/${id}.jsonl`,
  status: "running",
  activity: "idle",
  exitCode: null,
  success: null,
  kind: "agent",
  switching: false,
  switchRecovery: null,
  primaryProviderPinned: false,
  primaryProviderPinPending: false,
}))

function Harness({
  launching = null,
  installingDesktopUpdate = false,
  language = "en",
  workspace = true,
}: {
  launching?: string | null
  installingDesktopUpdate?: boolean
  language?: "ru" | "en"
  workspace?: boolean
} = {}) {
  const [activeTabId, setActiveTabId] = useState<string | null>("one")
  const [visibleTabs, setVisibleTabs] = useState(tabs)
  const callbacks = {
    onDiscardSwitchRecovery: vi.fn(),
    onCloseTab: (id: string) => setVisibleTabs((current) => current.filter((tab) => tab.id !== id)),
    onError: vi.fn(),
    onExit: vi.fn(),
    onLaunch: vi.fn(),
    onOpenFolder: vi.fn(),
    onReadTranscript: vi.fn(),
    onReady: vi.fn(),
    onReveal: vi.fn(),
    onSendSwitchRecovery: vi.fn(),
    onSwitch: vi.fn(),
    onTogglePrimaryProviderPin: vi.fn(),
    onToggleTitlePin: vi.fn(),
  }
  const props: ComponentProps<typeof TerminalWorkspace> = {
    ...callbacks,
    activeTabId,
    focusRequest: null,
    language,
    terminalFontFamily: "monospace",
    terminalFontSize: 14,
    launching,
    installingDesktopUpdate,
    ompConfig: null,
    runtime: {
      platform: "linux",
      arch: "x86_64",
      language,
      ompAvailable: true,
      ompExecutable: "synthetic-omp",
      ompVersion: "synthetic",
      sessionRoot: "/synthetic/sessions",
    },
    runtimeStatusByTerminal: {},
    selectedSession: null,
    selectedWorkspace: workspace
      ? {
          key: "project",
          name: "Synthetic project",
          path: "/synthetic/project",
          sessionCount: 0,
          lastActive: 0,
          pinned: false,
        }
      : null,
    tabs: visibleTabs,
    workspaceSessions: [],
    onFocusTab: setActiveTabId,
    onFocusTerminal: setActiveTabId,
    onShowWorkspace: () => setActiveTabId(null),
  }
  return <TerminalWorkspace {...props} />
}

describe("TerminalWorkspace project overview", () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    lifecycle.mounts.length = 0
    lifecycle.disposals.length = 0
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const overview = () => container.querySelector<HTMLButtonElement>(".workspace-overview-button")!

  it("keeps terminal instances mounted while showing the overview and returning to a tab", () => {
    act(() => root.render(<Harness />))
    const nodes = Array.from(container.querySelectorAll("[data-terminal-view]"))
    overview().focus()
    act(() => overview().click())
    expect(container.querySelector(".workspace-home h1")?.textContent).toBe("Synthetic project")
    expect(overview().getAttribute("aria-pressed")).toBe("true")
    expect(container.querySelector(".terminal-pane.is-active")).toBeNull()
    expect(container.querySelector(".terminal-meta")?.textContent).toBe("")
    expect(container.querySelector('[data-terminal-view][data-active="true"]')).toBeNull()
    expect(container.querySelector('[data-answers-active="true"]')).toBeNull()
    expect(document.activeElement).toBe(overview())
    act(() => overview().click())
    expect(Array.from(container.querySelectorAll("[data-terminal-view]"))).toEqual(nodes)
    act(() => container.querySelector<HTMLButtonElement>(".terminal-tab > button")!.click())
    expect(container.querySelector(".workspace-home")).toBeNull()
    expect(container.querySelector('[data-terminal-view="one"]')?.getAttribute("data-active")).toBe(
      "true",
    )
    expect(Array.from(container.querySelectorAll("[data-terminal-view]"))).toEqual(nodes)
    expect(lifecycle.mounts).toEqual(["one", "two"])
    expect(lifecycle.disposals).toEqual([])
  })

  it.each([{ launching: "new" }, { installingDesktopUpdate: true }])(
    "does not switch during %j",
    (props) => {
      act(() => root.render(<Harness {...props} />))
      expect(overview().disabled).toBe(true)
      act(() => overview().click())
      expect(container.querySelector(".workspace-home")).toBeNull()
    },
  )

  it("can show the no-project view without closing terminals", () => {
    act(() => root.render(<Harness workspace={false} />))
    act(() => overview().click())
    expect(container.querySelector(".empty-workspace")).not.toBeNull()
    expect(container.querySelectorAll("[data-terminal-view]")).toHaveLength(2)
    expect(lifecycle.disposals).toEqual([])
  })

  it("preserves newer outside focus across ordinary overview rerenders", () => {
    act(() => root.render(<Harness />))
    act(() => overview().click())
    const outside = document.createElement("input")
    document.body.append(outside)
    outside.focus()
    act(() => root.render(<Harness language="ru" />))
    expect(overview().getAttribute("aria-label")).toBe("Обзор выбранного проекта")
    expect(document.activeElement).toBe(outside)
    expect(container.querySelector(".workspace-home")).not.toBeNull()
    outside.remove()
  })
  it("closes background tabs from overview without activating another", () => {
    act(() => root.render(<Harness />))
    act(() => overview().click())
    const close = () => container.querySelector<HTMLButtonElement>(".tab-close")!
    close().focus()
    act(() => close().click())
    expect(container.querySelector(".workspace-home")).not.toBeNull()
    expect(container.querySelector(".terminal-pane.is-active")).toBeNull()
    expect(lifecycle.mounts).toEqual(["one", "two"])
    expect(lifecycle.disposals).toEqual(["one"])
    close().focus()
    act(() => close().click())
    expect(container.querySelector(".workspace-home")).not.toBeNull()
    expect(container.querySelectorAll("[data-terminal-view]")).toHaveLength(0)
    expect(document.activeElement).toBe(container.querySelector(".button.primary"))
    expect(lifecycle.disposals).toEqual(["one", "two"])
  })
})
