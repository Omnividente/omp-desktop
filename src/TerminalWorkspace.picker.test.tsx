/** @vitest-environment jsdom */

import { act, useEffect, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalWorkspace } from "./TerminalWorkspace"
import type { TerminalTab } from "./types"
import type { Lang } from "./i18n"

const mounted = vi.hoisted(() => vi.fn())
const unmounted = vi.hoisted(() => vi.fn())
vi.mock("./TerminalView", () => ({
  TerminalView: ({ tab }: { tab: TerminalTab }) => {
    useEffect(() => {
      mounted(tab.id)
      return () => unmounted(tab.id)
    }, [tab.id])
    return <div data-terminal-view={tab.id} />
  },
}))
vi.mock("./SessionControls", () => ({ SessionControls: () => null }))
vi.mock("./CompletedAnswers", () => ({ CompletedAnswers: () => null }))

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function tab(index: number, label = `Task ${index}`): TerminalTab {
  return {
    id: `terminal-${index}`,
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

const focus = vi.fn()
const effect = vi.fn()
const initialTabs = Array.from({ length: 30 }, (_, index) => tab(index))

function Harness({
  tabs = initialTabs,
  language = "en",
}: {
  tabs?: TerminalTab[]
  language?: Lang
}) {
  const [activeId, setActiveId] = useState("terminal-0")
  return (
    <TerminalWorkspace
      activeTabId={activeId}
      focusRequest={null}
      language={language}
      terminalFontFamily="monospace"
      terminalFontSize={14}
      launching={null}
      installingDesktopUpdate={false}
      ompConfig={null}
      runtime={{
        platform: "linux",
        arch: "x86_64",
        language,
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
      onCloseTab={effect}
      onDiscardSwitchRecovery={effect}
      onError={effect}
      onExit={effect}
      onFocusTab={(id) => {
        focus(id)
        setActiveId(id)
      }}
      onFocusTerminal={(id) => {
        focus(id)
        setActiveId(id)
      }}
      onShowWorkspace={effect}
      onLaunch={effect}
      onOpenFolder={effect}
      onReadTranscript={effect}
      onReady={effect}
      onReorderTabs={effect}
      onReveal={effect}
      onSendSwitchRecovery={effect}
      onSwitch={effect}
      onTogglePrimaryProviderPin={effect}
      onToggleTitlePin={effect}
    />
  )
}

describe("open terminal tab search", () => {
  let container: HTMLDivElement
  let root: Root
  let outside: HTMLButtonElement

  const trigger = () => container.querySelector<HTMLButtonElement>(".terminal-tab-picker-trigger")!
  const input = () => container.querySelector<HTMLInputElement>(".terminal-tab-picker input")!
  const results = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>(".terminal-tab-picker-result"))
  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')

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

  function filterProcessState(value: "all" | "running" | "exited") {
    const select = container.querySelector<HTMLSelectElement>(".terminal-tab-picker-state select")
    expect(select).not.toBeNull()
    act(() => {
      select!.value = value
      select!.dispatchEvent(new Event("change", { bubbles: true }))
    })
    return select!
  }

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement("div")
    outside = document.createElement("button")
    document.body.append(outside, container)
    root = createRoot(container)
    outside.focus()
    act(() => root.render(<Harness />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    outside.remove()
  })

  it("finds and activates an off-strip tab without filtering or remounting terminals", () => {
    expect(document.activeElement).toBe(outside)
    expect(dialog()).toBeNull()
    expect(mounted).toHaveBeenCalledTimes(30)
    const before = JSON.stringify(initialTabs)
    open()
    expect(results()).toHaveLength(30)
    expect(results()[0].getAttribute("aria-current")).toBe("true")
    search(" PROJECT-29 ")
    expect(results()).toHaveLength(1)
    expect(dialog()?.textContent).toContain("Tabs: 1 of 30")
    expect(container.querySelectorAll(".terminal-pane")).toHaveLength(30)
    key(input(), "Enter")
    expect(focus).toHaveBeenCalledExactlyOnceWith("terminal-29")
    expect(dialog()).toBeNull()
    expect(
      container
        .querySelector(".terminal-pane.is-active [data-terminal-view]")
        ?.getAttribute("data-terminal-view"),
    ).toBe("terminal-29")
    expect(mounted).toHaveBeenCalledTimes(30)
    expect(unmounted).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    expect(JSON.stringify(initialTabs)).toBe(before)
  })

  it("distinguishes duplicate titles by path and preserves exited tabs", () => {
    const tabs = [tab(1, "Same"), { ...tab(2, "Same"), status: "exited" as const }]
    act(() => root.render(<Harness tabs={tabs} />))
    open()
    search("same")
    expect(results()).toHaveLength(2)
    key(input(), "Enter")
    expect(focus).not.toHaveBeenCalled()
    expect(results()[1].textContent).toContain("/synthetic/project-2")
    act(() => results()[1].click())
    expect(focus).toHaveBeenCalledExactlyOnceWith("terminal-2")
    expect(effect).not.toHaveBeenCalled()
  })

  it.each(["en", "ru"] as const)(
    "filters identical title/path tabs by observed process state in %s without changing terminals",
    (language) => {
      const tabs: TerminalTab[] = [
        tab(1, "Same"),
        { ...tab(2, "Same"), status: "exited", success: true },
        { ...tab(3, "Same"), status: "exited", success: false },
        { ...tab(4, "Same"), status: "exited", success: null },
        { ...tab(5, "Same"), kind: "utility", activity: "thinking" },
      ].map((entry) => ({ ...entry, cwd: "/synthetic/same project" })) as TerminalTab[]
      act(() => root.render(<Harness tabs={tabs} language={language} />))
      const before = JSON.stringify(tabs)
      const mounts = mounted.mock.calls.length
      const unmounts = unmounted.mock.calls.length
      open()
      expect(results()).toHaveLength(5)
      const running = language === "ru" ? "Процесс запущен" : "Process running"
      const exited = language === "ru" ? "Процесс завершён" : "Process exited"
      expect(results()[0].textContent).toContain(running)
      expect(results()[1].textContent).toContain(exited)
      filterProcessState("running")
      expect(results()).toHaveLength(2)
      expect(results().every((result) => result.textContent?.includes(running))).toBe(true)
      filterProcessState("exited")
      expect(results()).toHaveLength(3)
      expect(results().every((result) => result.textContent?.includes(exited))).toBe(true)
      expect(dialog()?.textContent).toContain(
        language === "ru" ? "Вкладки: 3 из 5" : "Tabs: 3 of 5",
      )
      expect(container.querySelectorAll(".terminal-pane")).toHaveLength(5)
      expect(mounted).toHaveBeenCalledTimes(mounts)
      expect(unmounted).toHaveBeenCalledTimes(unmounts)
      expect(focus).not.toHaveBeenCalled()
      expect(effect).not.toHaveBeenCalled()
      expect(JSON.stringify(tabs)).toBe(before)
      act(() => results()[2].click())
      expect(focus).toHaveBeenCalledExactlyOnceWith("terminal-4")
    },
  )

  it("intersects process state with canonical search and current props without auto-selecting", () => {
    const tabs = [tab(1, "Café"), { ...tab(2, "Cafe\u0301"), status: "exited" as const }, tab(3)]
    act(() => root.render(<Harness tabs={tabs} />))
    open()
    search(" CAFE\u0301 ")
    filterProcessState("running")
    expect(results()).toHaveLength(1)
    expect(results()[0].textContent).toContain("/synthetic/project-1")
    results()[0].focus()
    const updated = [tabs[2], { ...tabs[0], status: "exited" as const }, tabs[1]]
    act(() => root.render(<Harness tabs={updated} />))
    expect(results()).toHaveLength(0)
    expect(document.activeElement).toBe(dialog())
    expect(input().value).toBe(" CAFE\u0301 ")
    expect(
      container.querySelector<HTMLSelectElement>(".terminal-tab-picker-state select")?.value,
    ).toBe("running")
    expect(dialog()?.textContent).toContain("Tabs: 0 of 3")
    key(input(), "Enter")
    expect(focus).not.toHaveBeenCalled()
    filterProcessState("exited")
    expect(results()).toHaveLength(2)
    expect(results()[0].textContent).toContain("/synthetic/project-1")
    filterProcessState("all")
    search("project-3")
    expect(results()).toHaveLength(1)
    expect(results()[0].textContent).toContain("/synthetic/project-3")
    expect(effect).not.toHaveBeenCalled()
  })

  it("keeps native-select Escape and Enter local and guards filtered single-result selection", () => {
    const tabs = [tab(1), { ...tab(2), status: "exited" as const }]
    act(() => root.render(<Harness tabs={tabs} />))
    open()
    const select = filterProcessState("exited")
    select.focus()
    key(select, "Enter")
    expect(focus).not.toHaveBeenCalled()
    expect(key(select, "Escape").defaultPrevented).toBe(false)
    expect(dialog()).not.toBeNull()
    input().focus()
    for (const extra of [
      { isComposing: true },
      { keyCode: 229 },
      { ctrlKey: true },
      { shiftKey: true },
    ]) {
      key(input(), "Enter", extra)
    }
    expect(focus).not.toHaveBeenCalled()
    key(input(), "Enter")
    expect(focus).toHaveBeenCalledExactlyOnceWith("terminal-2")
    expect(effect).not.toHaveBeenCalled()
  })

  it("traps focus after an empty filter and resets both controls only on reopening", () => {
    open()
    const select = filterProcessState("exited")
    search("missing")
    expect(results()).toHaveLength(0)
    select.focus()
    expect(key(select, "Tab").defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog()?.querySelector("button"))
    input().focus()
    key(input(), "Escape")
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    open()
    expect(input().value).toBe("")
    expect(
      container.querySelector<HTMLSelectElement>(".terminal-tab-picker-state select")?.value,
    ).toBe("all")
    expect(results()).toHaveLength(30)
    expect(focus).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
  })

  it("matches canonical text and case without changing the labels or paths", () => {
    const tabs = [tab(1, "Café"), tab(2, "Cafe\u0301"), tab(3, "CAFETERIA")]
    act(() => root.render(<Harness tabs={tabs} />))
    open()
    search(" CAFE\u0301 ")
    expect(results()).toHaveLength(2)
    expect(results()[0].textContent).toContain("Café")
    expect(results()[1].textContent).toContain("Cafe\u0301")
    search("ＣＡＦÉ")
    expect(results()).toHaveLength(0)
    expect(dialog()?.textContent).toContain("No matching open tabs")
    key(input(), "Enter")
    expect(focus).not.toHaveBeenCalled()
    search("")
    expect(results()).toHaveLength(3)
  })

  it("restores the trigger on Escape, close and backdrop dismissal; reopening clears search", () => {
    for (const dismissal of ["escape", "button", "backdrop"]) {
      open()
      search("Task 29")
      if (dismissal === "escape") key(input(), "Escape")
      if (dismissal === "button")
        act(() => dialog()!.querySelector<HTMLButtonElement>(".icon-button")!.click())
      if (dismissal === "backdrop")
        act(() =>
          container
            .querySelector(".terminal-tab-picker-backdrop")!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
        )
      expect(dialog()).toBeNull()
      expect(document.activeElement).toBe(trigger())
      expect(focus).not.toHaveBeenCalled()
    }
    open()
    expect(input().value).toBe("")
    expect(results()).toHaveLength(30)
  })

  it("keeps composition and modified Enter from selecting or dismissing", () => {
    open()
    search("project-29")
    key(input(), "Enter", { isComposing: true })
    key(input(), "Escape", { isComposing: true })
    key(input(), "Enter", { keyCode: 229 })
    key(input(), "Escape", { keyCode: 229 })
    for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"])
      key(input(), "Enter", { [modifier]: true })
    expect(dialog()).not.toBeNull()
    expect(input().value).toBe("project-29")
    expect(focus).not.toHaveBeenCalled()
  })

  it("contains Tab focus and prevents app shortcuts from escaping focused results", () => {
    open()
    search("project-29")
    const close = dialog()!.querySelector<HTMLButtonElement>(".icon-button")!
    close.focus()
    expect(key(close, "Tab", { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(results()[0])
    expect(key(results()[0], "Tab").defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
    const listener = vi.fn()
    window.addEventListener("keydown", listener)
    try {
      key(results()[0], "w", { ctrlKey: true, code: "KeyW" })
      key(results()[0], "n", { metaKey: true, code: "KeyN" })
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener("keydown", listener)
    }
    expect(effect).not.toHaveBeenCalled()
  })

  it("uses current tab identities and metadata across removal, rename and reorder", () => {
    open()
    search("Task 2")
    expect(results()).toHaveLength(11)
    const updated = [tab(29, "Renamed"), tab(2), tab(1)]
    act(() => root.render(<Harness tabs={updated} />))
    expect(input().value).toBe("Task 2")
    expect(results()).toHaveLength(1)
    search("renamed")
    expect(results()).toHaveLength(1)
    act(() => root.render(<Harness tabs={[tab(2), tab(1)]} />))
    expect(results()).toHaveLength(0)
    key(input(), "Enter")
    expect(focus).not.toHaveBeenCalled()
    search("project-1")
    act(() => results()[0].click())
    expect(focus).toHaveBeenCalledExactlyOnceWith("terminal-1")
  })

  it("does not reopen after all tabs disappear and a new tab arrives", () => {
    open()
    act(() => root.render(<Harness tabs={[]} />))
    expect(dialog()).toBeNull()
    expect(container.querySelector(".terminal-workspace")).toBeNull()
    expect(container.querySelector(".main-stage button")).not.toBeNull()
    act(() => root.render(<Harness tabs={[tab(99)]} />))
    expect(dialog()).toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    open()
    expect(results()).toHaveLength(1)
    expect(results()[0].textContent).toContain("Task 99")
  })

  it("updates localized labels without losing the query", () => {
    open()
    search("project-29")
    act(() => root.render(<Harness language="ru" />))
    expect(dialog()?.textContent).toContain("Найти открытую вкладку")
    expect(dialog()?.textContent).toContain("Вкладки: 1 из 30")
    expect(input().value).toBe("project-29")
    expect(input().getAttribute("aria-label")).toBe("Поиск по заголовку или пути проекта")
  })
})
