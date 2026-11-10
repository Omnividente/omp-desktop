/** @vitest-environment jsdom */

import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { saveTerminalCapture } from "./api"
import { t } from "./i18n"
import { IncidentCenter } from "./IncidentCenter"
import type { Lang } from "./i18n"
import type { RuntimeIncident } from "./runtimeIncidents"
import type { TerminalTab } from "./types"

vi.mock("./api", () => ({ errorMessage: String, saveTerminalCapture: vi.fn() }))
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function incident(id: number, terminalId: string, resolved = false): RuntimeIncident {
  return {
    id: `runtime-incident-${id}`,
    groupingKey: `key-${id}`,
    terminalId,
    terminalLabel: `Recorded ${terminalId}`,
    kind: "runtimeError",
    sourceKind: "runtimeError",
    status: resolved ? "resolved" : "active",
    role: null,
    model: null,
    modelRole: null,
    fallbackRole: null,
    fallbackFrom: null,
    fallbackTo: null,
    reason: `Synthetic reason ${id}`,
    count: 1,
    firstSeenAt: id * 1000,
    lastSeenAt: id * 1000,
    resolvedAt: resolved ? id * 1000 : null,
    resolutionReason: resolved ? "terminalEnded" : null,
  }
}

function tab(id: string, label: string): TerminalTab {
  return {
    id,
    label,
    pinnedTitle: null,
    cwd: "/synthetic/project",
    processId: 1,
    sessionId: null,
    sessionPath: null,
    status: "running",
    activity: "idle",
    exitCode: null,
    success: null,
    kind: "agent",
    switching: false,
    switchRecovery: null,
    currentModel: undefined,
    currentModelRole: null,
    currentThinking: null,
    currentThinkingConfigured: null,
    primaryProviderPinned: false,
    primaryProviderPinPending: false,
  }
}

describe("Incident Center terminal filter", () => {
  let container: HTMLDivElement
  let root: Root
  const returnFocusRef = createRef<HTMLButtonElement>()
  const onClearResolved = vi.fn()
  const onClose = vi.fn()
  const onFocusTerminal = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  })
  afterEach(async () => {
    await act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function render(
    incidents: RuntimeIncident[],
    tabs: TerminalTab[] = [],
    language: Lang = "en",
  ) {
    await act(() =>
      root.render(
        <IncidentCenter
          incidents={incidents}
          tabs={tabs}
          language={language}
          returnFocusRef={returnFocusRef}
          onClearResolved={onClearResolved}
          onClose={onClose}
          onFocusTerminal={onFocusTerminal}
        />,
      ),
    )
  }
  function select() {
    const element = container.querySelector<HTMLSelectElement>(".incident-terminal-filter select")
    expect(element).not.toBeNull()
    return element!
  }
  async function choose(value: string) {
    const element = select()
    await act(() => {
      element.value = value
      element.dispatchEvent(new Event("change", { bubbles: true }))
    })
  }
  async function allStatuses() {
    await act(() =>
      container.querySelectorAll<HTMLButtonElement>(".incident-filter button")[1].click(),
    )
  }
  function visibleReasons() {
    return [...container.querySelectorAll(".incident-reason > p")].map(
      (element) => element.textContent,
    )
  }

  it.each(["en", "ru"] as const)(
    "labels exact identities, using current names and recorded closed names (%s)",
    async (language) => {
      await render(
        [incident(1, "a"), incident(2, "b"), incident(3, "closed", true)],
        [tab("a", "Shared Ω"), tab("b", "Shared Ω"), tab("no-incidents", "Unused")],
        language,
      )
      const element = select()
      expect(element.labels?.[0]?.textContent).toContain(
        language === "en" ? "Terminal" : "Терминал",
      )
      expect([...element.options].map((option) => option.value)).toEqual(["", "closed", "b", "a"])
      expect(element.querySelector('[value="a"]')?.textContent).toBe("Shared Ω (a)")
      expect(element.querySelector('[value="b"]')?.textContent).toBe("Shared Ω (b)")
      expect(element.querySelector('[value="closed"]')?.textContent).toBe(
        "Recorded closed (closed)",
      )
      expect(element.options[0].textContent).toBe(
        language === "en" ? "All terminals" : "Все терминалы",
      )
      await choose("a")
      expect(visibleReasons()).toEqual(["Synthetic reason 1"])
      expect(onFocusTerminal).not.toHaveBeenCalled()
      expect(onClearResolved).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    },
  )

  it("intersects terminal and status filters and restores the existing latest-first order", async () => {
    const incidents = [incident(1, "a"), incident(2, "b"), incident(3, "a", true)]
    const original = JSON.stringify(incidents)
    await render(incidents)
    await choose("a")
    expect(visibleReasons()).toEqual(["Synthetic reason 1"])
    await allStatuses()
    expect(select().value).toBe("a")
    expect(visibleReasons()).toEqual(["Synthetic reason 3", "Synthetic reason 1"])
    await choose("")
    expect(visibleReasons()).toEqual([
      "Synthetic reason 3",
      "Synthetic reason 2",
      "Synthetic reason 1",
    ])
    expect(JSON.stringify(incidents)).toBe(original)
  })

  it("keeps a closed terminal selectable and explains its empty active view", async () => {
    await render([incident(1, "a"), incident(2, "closed", true)])
    await choose("closed")
    expect(container.querySelector(".incident-empty")?.textContent).toContain(
      "No active incidents for this terminal",
    )
    expect(container.querySelector(".incident-open-terminal")).toBeNull()
    await allStatuses()
    expect(visibleReasons()).toEqual(["Synthetic reason 2"])
    expect(container.querySelector(".incident-terminal-closed")).not.toBeNull()
  })

  it("preserves identity and focus across label and live incident updates", async () => {
    await render([incident(1, "a"), incident(2, "b")], [tab("a", "Before")])
    await choose("a")
    select().focus()
    await render([incident(1, "a"), incident(2, "b"), incident(3, "a")], [tab("a", "After")])
    expect(select().value).toBe("a")
    expect(document.activeElement).toBe(select())
    expect(select().querySelector('[value="a"]')?.textContent).toBe("After (a)")
    expect(visibleReasons()).toEqual(["Synthetic reason 3", "Synthetic reason 1"])
  })

  it("returns to all terminals when the selected identity disappears without reviving the old selection", async () => {
    await render([incident(1, "a"), incident(2, "b")])
    await choose("b")
    await render([incident(1, "a")])
    expect(select().value).toBe("")
    expect(visibleReasons()).toEqual(["Synthetic reason 1"])
    await render([incident(1, "a"), incident(3, "b")])
    expect(select().value).toBe("")
    expect(visibleReasons()).toEqual(["Synthetic reason 3", "Synthetic reason 1"])
  })

  it("makes the existing clear action's all-terminal scope explicit", async () => {
    await render([incident(1, "a", true), incident(2, "b", true)])
    await choose("a")
    const clear = container.querySelector<HTMLButtonElement>(".incident-clear-button")!
    expect(clear.textContent).toBe("Clear all resolved")
    await act(() => clear.click())
    expect(onClearResolved).toHaveBeenCalledOnce()
    expect(onClearResolved).toHaveBeenCalledWith()
  })

  it("supports empty input and existing Escape dismissal from the new control", async () => {
    await render([])
    expect(select().options).toHaveLength(1)
    expect(container.querySelector(".incident-empty")?.textContent).toContain(
      "No runtime incidents yet",
    )
    select().focus()
    await act(() =>
      select().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  function statusButton(status: "active" | "all" | "resolved", language: Lang = "en") {
    const label = t(
      language,
      {
        active: "incidentFilterActive",
        all: "incidentFilterAll",
        resolved: "incidentFilterResolved",
      }[status] as "incidentFilterActive" | "incidentFilterAll" | "incidentFilterResolved",
    )
    const element = [
      ...container.querySelectorAll<HTMLButtonElement>(".incident-filter button"),
    ].find((button) => button.firstChild?.textContent === label)
    expect(element).toBeDefined()
    return element!
  }

  it("shows only resolved records in latest-first order without altering incidents or triggering actions", async () => {
    const incidents = [
      incident(1, "a", true),
      incident(4, "b"),
      incident(3, "b", true),
      incident(2, "a"),
    ]
    const before = structuredClone(incidents)
    Object.freeze(incidents)
    await render(incidents)
    expect(visibleReasons()).toEqual(["Synthetic reason 4", "Synthetic reason 2"])
    const resolved = statusButton("resolved")
    resolved.focus()
    await act(() => resolved.click())
    expect(visibleReasons()).toEqual(["Synthetic reason 3", "Synthetic reason 1"])
    expect(resolved.getAttribute("aria-pressed")).toBe("true")
    expect(document.activeElement).toBe(resolved)
    expect(container.querySelectorAll('.incident-filter [aria-pressed="true"]')).toHaveLength(1)
    await act(() => resolved.click())
    expect(visibleReasons()).toEqual(["Synthetic reason 3", "Synthetic reason 1"])
    await act(() => statusButton("all").click())
    expect(visibleReasons()).toEqual([
      "Synthetic reason 4",
      "Synthetic reason 3",
      "Synthetic reason 2",
      "Synthetic reason 1",
    ])
    await act(() => statusButton("active").click())
    expect(visibleReasons()).toEqual(["Synthetic reason 4", "Synthetic reason 2"])
    expect(incidents).toEqual(before)
    expect(onClearResolved).not.toHaveBeenCalled()
    expect(onFocusTerminal).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(saveTerminalCapture).not.toHaveBeenCalled()
  })

  it.each(["en", "ru"] as const)(
    "intersects resolved and terminal filters and explains empty results (%s)",
    async (language) => {
      const incidents = [incident(1, "a"), incident(2, "b", true), incident(3, "c", true)]
      await render(incidents, [], language)
      await act(() => statusButton("resolved", language).click())
      await choose("b")
      expect(visibleReasons()).toEqual(["Synthetic reason 2"])
      expect(statusButton("resolved", language).querySelector("span")?.textContent).toBe("2")
      await choose("a")
      expect(visibleReasons()).toEqual([])
      expect(container.querySelector(".incident-empty")?.textContent).toContain(
        t(language, "incidentNoResolvedForTerminal"),
      )
      await choose("")
      await render([incident(1, "a")], [], language)
      expect(container.querySelector(".incident-empty")?.textContent).toContain(
        t(language, "incidentNoResolvedIncidents"),
      )
      expect(statusButton("resolved", language).querySelector("span")?.textContent).toBe("0")
      await render([], [], language)
      expect(container.querySelector(".incident-empty")?.textContent).toContain(
        t(language, "incidentNoIncidents"),
      )
    },
  )

  it("uses current resolved state after updates and does not revive a removed terminal filter", async () => {
    await render([incident(1, "a"), incident(2, "b", true)])
    await choose("a")
    const resolved = statusButton("resolved")
    resolved.focus()
    await act(() => resolved.click())
    expect(visibleReasons()).toEqual([])
    await render([incident(1, "a", true), incident(2, "b", true), incident(3, "a")])
    expect(visibleReasons()).toEqual(["Synthetic reason 1"])
    expect(document.activeElement).toBe(resolved)
    await render([incident(1, "a"), incident(2, "b", true)])
    expect(visibleReasons()).toEqual([])
    await render([incident(2, "b", true)])
    expect(select().value).toBe("")
    expect(visibleReasons()).toEqual(["Synthetic reason 2"])
    await render([incident(2, "b", true), incident(4, "a", true)])
    expect(select().value).toBe("")
    expect(visibleReasons()).toEqual(["Synthetic reason 4", "Synthetic reason 2"])
  })

  it("keeps clear-all global while preserving the resolved view after parent removal", async () => {
    await render([incident(1, "a", true), incident(2, "b", true), incident(3, "b")])
    await choose("a")
    await act(() => statusButton("resolved").click())
    const clear = container.querySelector<HTMLButtonElement>(".incident-clear-button")!
    expect(clear.textContent).toBe("Clear all resolved")
    await act(() => clear.click())
    expect(onClearResolved).toHaveBeenCalledOnce()
    expect(onClearResolved).toHaveBeenCalledWith()
    await render([incident(3, "b")])
    expect(select().value).toBe("")
    expect(statusButton("resolved").getAttribute("aria-pressed")).toBe("true")
    expect(visibleReasons()).toEqual([])
    expect(clear.disabled).toBe(true)
    expect(container.querySelector(".incident-empty")?.textContent).toContain(
      "No resolved runtime incidents",
    )
    expect(document.activeElement).toBe(statusButton("active"))
  })

  it("keeps Escape dismissal and returns to default Active on remount", async () => {
    const incidents = [incident(1, "a"), incident(2, "b", true)]
    await render(incidents)
    const resolved = statusButton("resolved")
    await act(() => resolved.click())
    resolved.focus()
    await act(() =>
      resolved.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    )
    expect(onClose).toHaveBeenCalledOnce()
    await act(() => root.render(null))
    await render(incidents)
    expect(statusButton("active").getAttribute("aria-pressed")).toBe("true")
    expect(visibleReasons()).toEqual(["Synthetic reason 1"])
  })

  function kindSelect() {
    const element = container.querySelector<HTMLSelectElement>(".incident-kind-filter select")
    expect(element).not.toBeNull()
    return element!
  }
  async function chooseKind(value: string) {
    const element = kindSelect()
    await act(() => {
      element.value = value
      element.dispatchEvent(new Event("change", { bubbles: true }))
    })
  }
  function ofKind(id: number, kind: RuntimeIncident["kind"], terminalId = "a", resolved = false) {
    return { ...incident(id, terminalId, resolved), kind }
  }

  it.each(["en", "ru"] as const)(
    "offers all recorded kinds with a persistent accessible label (%s)",
    async (language) => {
      await render([], [], language)
      const select = kindSelect()
      expect(select.value).toBe("all")
      expect(select.labels?.[0]?.textContent).toContain(t(language, "incidentKindFilter"))
      expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
        ["all", t(language, "incidentAllKinds")],
        ["fallback", t(language, "incidentFallback")],
        ["modelError", t(language, "incidentModelError")],
        ["runtimeError", t(language, "incidentRuntimeError")],
      ])
      await chooseKind("fallback")
      expect(container.querySelector(".incident-empty")?.textContent).toContain(
        t(language, "incidentNoIncidents"),
      )
    },
  )

  it("isolates each kind in 100 records without changing counters or data", async () => {
    const kinds = ["fallback", "modelError", "runtimeError"] as const
    const incidents = Array.from({ length: 100 }, (_, index) =>
      ofKind(index + 1, kinds[index % kinds.length], index % 2 ? "a" : "b", index % 4 === 0),
    )
    const before = structuredClone(incidents)
    Object.freeze(incidents)
    await render(incidents)
    await allStatuses()
    const allReasons = visibleReasons()
    const counters = container.querySelector(".incident-filter")?.textContent
    for (const kind of kinds) {
      await chooseKind(kind)
      expect(visibleReasons()).toEqual(
        incidents
          .filter((entry) => entry.kind === kind)
          .reverse()
          .map((entry) => entry.reason),
      )
      expect(container.querySelector(".incident-filter")?.textContent).toBe(counters)
    }
    await chooseKind("all")
    expect(visibleReasons()).toEqual(allReasons)
    expect(incidents).toEqual(before)
    expect(onClearResolved).not.toHaveBeenCalled()
    expect(onFocusTerminal).not.toHaveBeenCalled()
    expect(saveTerminalCapture).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("intersects kind, exact terminal and all three status views", async () => {
    await render([
      ofKind(1, "fallback", "a"),
      ofKind(2, "modelError", "a"),
      ofKind(3, "fallback", "b"),
      ofKind(4, "fallback", "a", true),
      ofKind(5, "runtimeError", "a", true),
    ])
    await choose("a")
    await chooseKind("fallback")
    expect(visibleReasons()).toEqual(["Synthetic reason 1"])
    await act(() => statusButton("resolved").click())
    expect(visibleReasons()).toEqual(["Synthetic reason 4"])
    await allStatuses()
    expect(visibleReasons()).toEqual(["Synthetic reason 4", "Synthetic reason 1"])
    await choose("")
    expect(visibleReasons()).toEqual([
      "Synthetic reason 4",
      "Synthetic reason 3",
      "Synthetic reason 1",
    ])
    expect(kindSelect().value).toBe("fallback")
  })

  it.each(["en", "ru"] as const)(
    "explains an empty intersection without claiming no active incidents (%s)",
    async (language) => {
      await render([ofKind(1, "runtimeError")], [], language)
      await chooseKind("modelError")
      expect(visibleReasons()).toEqual([])
      expect(container.querySelector(".incident-empty")?.textContent).toContain(
        t(language, "incidentNoMatchingIncidents"),
      )
      expect(statusButton("active", language).querySelector("span")?.textContent).toBe("1")
      await chooseKind("runtimeError")
      expect(visibleReasons()).toEqual(["Synthetic reason 1"])
    },
  )

  it("preserves kind and focus through empty data, live updates and locale", async () => {
    await render([ofKind(1, "fallback"), ofKind(2, "runtimeError")])
    await chooseKind("fallback")
    kindSelect().focus()
    await render([ofKind(1, "fallback", "a", true), ofKind(2, "runtimeError")])
    expect(visibleReasons()).toEqual([])
    expect(kindSelect().value).toBe("fallback")
    expect(document.activeElement).toBe(kindSelect())
    await render([])
    await render([ofKind(3, "fallback"), ofKind(4, "modelError")], [], "ru")
    expect(kindSelect().value).toBe("fallback")
    expect(document.activeElement).toBe(kindSelect())
    expect(visibleReasons()).toEqual(["Synthetic reason 3"])
  })

  it("keeps clear-all global even when the chosen kind has no resolved matches", async () => {
    await render([ofKind(1, "fallback"), ofKind(2, "modelError", "b", true)])
    await chooseKind("fallback")
    await act(() => statusButton("resolved").click())
    expect(visibleReasons()).toEqual([])
    const clear = container.querySelector<HTMLButtonElement>(".incident-clear-button")!
    expect(clear.disabled).toBe(false)
    expect(clear.textContent).toBe("Clear all resolved")
    await act(() => clear.click())
    expect(onClearResolved).toHaveBeenCalledExactlyOnceWith()
    await render([ofKind(1, "fallback")])
    expect(kindSelect().value).toBe("fallback")
    expect(clear.disabled).toBe(true)
    expect(statusButton("resolved").getAttribute("aria-pressed")).toBe("true")
  })

  it("allows Escape from the kind control and resets to all kinds on reopening", async () => {
    const incidents = [ofKind(1, "fallback"), ofKind(2, "runtimeError")]
    await render(incidents)
    await chooseKind("fallback")
    kindSelect().focus()
    await act(() =>
      kindSelect().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    )
    expect(onClose).toHaveBeenCalledOnce()
    await act(() => root.render(null))
    await render(incidents)
    expect(kindSelect().value).toBe("all")
    expect(visibleReasons()).toEqual(["Synthetic reason 2", "Synthetic reason 1"])
  })
})
