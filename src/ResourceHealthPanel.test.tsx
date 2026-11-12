/** @vitest-environment jsdom */

import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ResourceHealthPanel } from "./ResourceHealthPanel"
import { t, type Lang } from "./i18n"
import type { ResourceHealthSnapshot, ResourceProcessSnapshot, TerminalTab } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

type Tab = Pick<TerminalTab, "id" | "label" | "cwd" | "processId" | "status">

const first: Tab = {
  id: "terminal-1",
  label: "Review parser",
  cwd: "/synthetic/parser",
  processId: 101,
  status: "running",
}
const second: Tab = {
  id: "terminal-2",
  label: "Review parser",
  cwd: "/synthetic/other",
  processId: 202,
  status: "running",
}

function snapshot(processes?: ResourceProcessSnapshot[]): ResourceHealthSnapshot {
  return {
    sampledAt: 1_700_000_000_000,
    severity: "warning",
    memory: {
      availableBytes: 1024,
      totalBytes: 2048,
      usedSwapBytes: 0,
      totalSwapBytes: 0,
      availableSeverity: "ok",
      swapSeverity: "ok",
      severity: "ok",
    },
    volumes: [],
    unavailableVolumes: [
      { path: "/synthetic/missing", purpose: "workspace", error: "Unavailable" },
    ],
    // The native producer already sorts descending by RSS. Keep fixtures in that order.
    processes: processes ?? [
      { source: "omp", terminalId: "terminal-2", processId: 202, residentBytes: 3 * 1024 },
      { source: "desktop", terminalId: null, processId: 1, residentBytes: 2 * 1024 },
      { source: "omp", terminalId: "terminal-1", processId: 101, residentBytes: 1024 },
    ],
  }
}

describe("resource terminal context", () => {
  let container: HTMLDivElement
  let root: Root
  const returnFocusRef = createRef<HTMLButtonElement>()
  const onClose = vi.fn()
  const onFocusTerminal = vi.fn(() => true)
  const onRefresh = vi.fn()

  beforeEach(() => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    returnFocusRef.current = document.createElement("button")
    document.body.append(returnFocusRef.current)
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0)
      return 1
    })
    onClose.mockReset()
    onFocusTerminal.mockReset().mockReturnValue(true)
    onRefresh.mockReset()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    returnFocusRef.current?.remove()
    vi.restoreAllMocks()
  })

  async function render(
    tabs: readonly Tab[],
    value: ResourceHealthSnapshot | null = snapshot(),
    language: Lang = "en",
    error: string | null = null,
  ) {
    await act(async () =>
      root.render(
        <ResourceHealthPanel
          snapshot={value}
          error={error}
          language={language}
          tabs={tabs}
          returnFocusRef={returnFocusRef}
          onClose={onClose}
          onFocusTerminal={onFocusTerminal}
          onRefresh={onRefresh}
        />,
      ),
    )
  }

  function rows(): HTMLDivElement[] {
    return Array.from(container.querySelectorAll(".resource-process"))
  }

  it.each(["en", "ru", "zh"] as const)(
    "offers refresh for a sample or failure and preserves the focused pending control in %s",
    async (language) => {
      await render([], snapshot(), language)
      const refresh = container.querySelector<HTMLButtonElement>(".resource-panel-footer button")!
      const close = container.querySelector<HTMLButtonElement>(".resource-panel-header button")!
      expect(refresh.textContent).toBe(t(language, "resourceRefresh"))
      refresh.focus()
      await act(async () => refresh.click())
      expect(onRefresh).toHaveBeenCalledTimes(1)
      await render([], null, language)
      expect(refresh.getAttribute("aria-disabled")).toBe("true")
      expect(refresh.disabled).toBe(false)
      expect(document.activeElement).toBe(refresh)
      expect(container.querySelector(".resource-panel-footer span")).toBeNull()
      await act(async () => refresh.click())
      expect(onRefresh).toHaveBeenCalledTimes(1)
      refresh.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      )
      expect(document.activeElement).toBe(close)
      close.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      expect(document.activeElement).toBe(refresh)
      await render([], null, language, "Synthetic sampling failure")
      expect(refresh.getAttribute("aria-disabled")).toBe("false")
      await act(async () => refresh.click())
      expect(onRefresh).toHaveBeenCalledTimes(2)
      expect(onClose).not.toHaveBeenCalled()
    },
  )

  it("identifies equally named running terminals by their current project paths while preserving raw identity, RSS, and producer order", async () => {
    const value = snapshot()
    const before = structuredClone(value)
    Object.freeze(value.processes)
    await render([first, second], value)
    expect(rows()).toHaveLength(3)
    expect(rows()[0].textContent).toContain("OMP process · terminal-2")
    expect(rows()[0].textContent).toContain("Current tab: Review parser")
    expect(rows()[0].textContent).toContain("/synthetic/other")
    expect(rows()[1].textContent).toBe("OMP Desktop2.00 KiB")
    expect(rows()[2].textContent).toContain("/synthetic/parser")
    expect(
      Array.from(
        container.querySelectorAll(".resource-process strong"),
        (node) => node.textContent,
      ),
    ).toEqual(["3.00 KiB", "2.00 KiB", "1.00 KiB"])
    expect(value).toEqual(before)
  })

  it.each([
    { ...first, id: "other-terminal" },
    { ...first, processId: 999 },
    { ...first, processId: null },
    { ...first, status: "exited" as const },
  ])(
    "keeps the original technical row without a guessed current title when a live match is unavailable: %j",
    async (tab) => {
      await render([tab])
      expect(container.querySelector(".resource-process-tab")).toBeNull()
      expect(rows()[2].textContent).toBe("OMP process · terminal-11.00 KiB")
      expect(rows()).toHaveLength(3)
    },
  )

  it("does not attach a terminal label to a Desktop row or an OMP row without a terminal ID", async () => {
    await render(
      [first],
      snapshot([
        { source: "desktop", terminalId: "terminal-1", processId: 101, residentBytes: 200 },
        { source: "omp", terminalId: null, processId: 101, residentBytes: 100 },
      ]),
    )
    expect(container.querySelector(".resource-process-tab")).toBeNull()
  })

  it("updates current tab text on rename and drops it after replacement or removal without changing a retained measurement", async () => {
    const value = snapshot()
    await render([first], value)
    await render([{ ...first, label: "Renamed task", cwd: "/synthetic/renamed" }], value)
    expect(rows()[2].textContent).toContain("Current tab: Renamed task")
    expect(rows()[2].textContent).toContain("/synthetic/renamed")
    expect(rows()[2].querySelector("strong")?.textContent).toBe("1.00 KiB")
    await render([{ ...first, processId: 999 }], value)
    expect(container.querySelector(".resource-process-tab")).toBeNull()
    await render([], value)
    expect(rows()).toHaveLength(3)
    expect(container.querySelector(".resource-process-tab")).toBeNull()
  })

  it("matches a replacement only when a fresh measurement has its current process ID", async () => {
    const replacement = { ...first, label: "Replacement", processId: 999 }
    await render([replacement])
    expect(container.querySelector(".resource-process-tab")).toBeNull()
    await render(
      [replacement],
      snapshot([{ source: "omp", terminalId: "terminal-1", processId: 999, residentBytes: 900 }]),
    )
    expect(rows()[0].textContent).toContain("Current tab: Replacement")
  })

  it.each(["en", "ru"] as const)(
    "labels the metadata as current and preserves measurement scope, timestamp, warnings, and safe text in %s",
    async (language) => {
      const title = '<img src=x onerror="bad()"> 😀'
      const path = "/synthetic/<script>/日本語"
      await render([{ ...first, label: title, cwd: path }], snapshot(), language)
      expect(rows()[2].textContent).toContain(
        t(language, "resourceCurrentTab").replace("{title}", title),
      )
      expect(rows()[2].textContent).toContain(path)
      expect(container.querySelector("img, script")).toBeNull()
      expect(container.textContent).toContain(t(language, "resourceScopeNote"))
      expect(container.textContent).toContain(t(language, "resourcePartial"))
      expect(container.querySelector(".resource-panel-footer")?.textContent).toContain(
        new Date(1_700_000_000_000).toLocaleTimeString(language === "ru" ? "ru-RU" : "en-US"),
      )
      expect(container.querySelectorAll("meter")).toHaveLength(1)
      expect(container.querySelector(".resource-summary")?.textContent).toContain(
        t(language, "resourceWarning"),
      )
    },
  )

  it("keeps the original close focus without activating a process action", async () => {
    await render([first])
    const close = container.querySelector("button")!
    expect(document.activeElement).toBe(close)
    expect(
      container.querySelectorAll(
        ".resource-process button, .resource-process a, .resource-process input",
      ),
    ).toHaveLength(1)
    expect(onFocusTerminal).not.toHaveBeenCalled()
    close.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    )
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => root.render(null))
    expect(document.activeElement).toBe(returnFocusRef.current)
  })

  it.each(["en", "ru", "zh"] as const)(
    "navigates only the matching row and preserves the destination focus in %s",
    async (language) => {
      await render([first, second], snapshot(), language)
      const buttons = container.querySelectorAll<HTMLButtonElement>(".resource-open-terminal")
      expect(buttons).toHaveLength(2)
      expect(buttons[0].textContent).toContain(t(language, "resourceOpenTerminal"))
      expect(buttons[0].getAttribute("aria-label")).toContain(second.cwd)
      expect(buttons[1].getAttribute("aria-label")).toContain(first.cwd)
      await act(async () => buttons[0].click())
      expect(onFocusTerminal).toHaveBeenCalledExactlyOnceWith(second.id, second.processId)
      expect(onClose).toHaveBeenCalledTimes(1)
      // Repeated activation before removal must not schedule another handoff.
      await act(async () => buttons[0].click())
      expect(onFocusTerminal).toHaveBeenCalledTimes(1)
      const destination = document.createElement("button")
      document.body.append(destination)
      destination.focus()
      await act(async () => root.render(null))
      expect(document.activeElement).toBe(destination)
      destination.remove()
    },
  )

  it("keeps the dialog and ordinary return focus when the current tab rejects activation", async () => {
    await render([first])
    onFocusTerminal.mockReturnValue(false)
    const button = container.querySelector<HTMLButtonElement>(".resource-open-terminal")!
    button.focus()
    await act(async () => button.click())
    expect(onFocusTerminal).toHaveBeenCalledExactlyOnceWith(first.id, first.processId)
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button)
    await act(async () => root.render(null))
    expect(document.activeElement).toBe(returnFocusRef.current)
  })

  it("removes navigation for retained measurements after exit, replacement, or removal", async () => {
    const value = snapshot()
    await render([first], value)
    expect(container.querySelectorAll(".resource-open-terminal")).toHaveLength(1)
    for (const tabs of [
      [{ ...first, status: "exited" as const }],
      [{ ...first, processId: 999 }],
      [],
    ]) {
      await render(tabs, value)
      expect(container.querySelector(".resource-open-terminal")).toBeNull()
    }
    expect(onFocusTerminal).not.toHaveBeenCalled()
  })

  it("includes navigation in the modal Tab loop", async () => {
    await render([first, second])
    const close = container.querySelector<HTMLButtonElement>(".resource-panel-header button")!
    const last = container.querySelector<HTMLButtonElement>(".resource-panel-footer button")!
    last.focus()
    last.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(close)
    close.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(last)
    expect(onFocusTerminal).not.toHaveBeenCalled()
  })

  it.each(["en", "ru"] as const)(
    "preserves literal replacement tokens in the current title in %s",
    async (language) => {
      const label = "Investigate $& / $$ / $` / $'"
      await render([{ ...first, label }], snapshot(), language)
      expect(rows()[2].querySelector(".resource-process-tab span")?.textContent).toBe(
        (language === "ru" ? "Текущая вкладка: " : "Current tab: ") + label,
      )
    },
  )

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "leaves composition Escape to its owner before ordinary dismissal (%j)",
    async (options) => {
      await render([first])
      const close = container.querySelector<HTMLButtonElement>(".resource-panel-header button")!
      const composition = new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true, ...options,
      })
      close.dispatchEvent(composition)
      expect(composition.defaultPrevented).toBe(false)
      expect(onClose).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(close)
      close.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      }))
      expect(onClose).toHaveBeenCalledOnce()
    },
  )
})
