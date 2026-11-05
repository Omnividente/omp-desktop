/** @vitest-environment jsdom */

import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionControls } from "./SessionControls"
import type { OmpConfigSnapshot, OmpModelInfo, TerminalTab } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const model = (id: string, overrides: Partial<OmpModelInfo> = {}): OmpModelInfo => ({
  provider: "provider",
  id,
  selector: `provider/${id}`,
  name: id,
  available: true,
  status: "ready",
  detail: null,
  thinking: ["low", "high"],
  ...overrides,
})
const primary = model("primary", { name: "Current model" })
const target = model("target-id", {
  provider: "second",
  selector: "second/target-id:tag",
  name: "Other model",
})
const unavailable = model("unavailable", { available: false, status: "missing" })
const image = model("image", { kind: "image" })
const initialTab: TerminalTab = {
  id: "tab-a",
  label: "Synthetic session",
  pinnedTitle: null,
  cwd: "/synthetic/project",
  processId: null,
  sessionId: "session-a",
  sessionPath: "/synthetic/a.jsonl",
  status: "running",
  activity: "idle",
  exitCode: null,
  success: null,
  kind: "agent",
  switching: false,
  switchRecovery: null,
  currentModel: primary.selector,
  currentThinking: "high",
  currentThinkingConfigured: "high",
  primaryProviderPinned: false,
  primaryProviderPinPending: false,
}
function snapshot(): OmpConfigSnapshot {
  return {
    models: [primary, target, unavailable, image],
    roles: [],
    agents: [],
    accounts: [],
    agentSettingsSupported: false,
    advisorEnabled: false,
    autoResume: false,
    defaultThinkingLevel: "medium",
    modelFallbackEnabled: false,
    fallbackChains: {},
    proxyProviders: [],
    disabledProviders: [],
    usageObservedAt: null,
    providerEnvKeys: [],
    credentials: [],
    warnings: [],
  }
}

describe("running-session model search", () => {
  let container: HTMLDivElement
  let root: Root
  let props: ComponentProps<typeof SessionControls>
  beforeEach(() => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    props = {
      tab: initialTab,
      ompConfig: snapshot(),
      lang: "en",
      runtimeStatus: "normal",
      installingDesktopUpdate: false,
      onDiscardSwitchRecovery: vi.fn(),
      onSendSwitchRecovery: vi.fn(),
      onSwitch: vi.fn(),
      onTogglePrimaryProviderPin: vi.fn(),
    }
    render()
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  function render(next: Partial<typeof props> = {}) {
    props = { ...props, ...next }
    act(() => root.render(<SessionControls {...props} />))
  }
  const toggle = () => container.querySelector<HTMLButtonElement>(".session-model-search-toggle")!
  const input = () => container.querySelector<HTMLInputElement>(".session-model-search")!
  const select = () => container.querySelector<HTMLSelectElement>(".session-model-select")!
  const values = () => Array.from(select().options, (option) => option.value)
  function openSearch() {
    act(() => toggle().click())
  }
  function query(value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(),
        value,
      )
      input().dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  function choose(value: string) {
    act(() => {
      select().value = value
      select().dispatchEvent(new Event("change", { bubbles: true }))
    })
  }
  it.each(["Other model", "SECOND", "target-id", "target-id:tag"])(
    "filters by %s without changing the current model or restarting",
    (text) => {
      expect(input()).toBeNull()
      openSearch()
      expect(document.activeElement).toBe(input())
      expect(toggle().getAttribute("aria-controls")).toBe(input().parentElement?.id)
      query(` ${text} `)
      expect(values()).toEqual([primary.selector, target.selector])
      expect(select().value).toBe(primary.selector)
      expect(props.onSwitch).not.toHaveBeenCalled()
      expect(props.onTogglePrimaryProviderPin).not.toHaveBeenCalled()
      choose(target.selector)
      expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith("tab-a", target.selector, "high")
    },
  )
  it("preserves distinct selectors for identically named models", () => {
    const config = snapshot()
    config.models = [primary, { ...target, name: primary.name }]
    render({ ompConfig: config })
    openSearch()
    query("second")
    expect(select().options[0].textContent).toBe(`${primary.name} (${primary.selector})`)
    expect(select().querySelector("optgroup")?.label).toBe("second")
    expect(values()).toEqual([primary.selector, target.selector])
    expect(props.onSwitch).not.toHaveBeenCalled()
    choose(target.selector)
    expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith("tab-a", target.selector, "high")
  })

  it.each(["ru", "en"] as const)(
    "retains current and unknown selections with no matches (%s)",
    (lang) => {
      render({ lang })
      openSearch()
      query("no matching synthetic model")
      expect(select().value).toBe(primary.selector)
      expect(select().options[1].disabled).toBe(true)
      expect(select().textContent).toContain(
        lang === "ru" ? "Подходящие модели не найдены" : "No matching models",
      )
      render({ tab: { ...initialTab, currentModel: "missing/old-model" } })
      expect(input().value).toBe("no matching synthetic model")
      expect(select().value).toBe("missing/old-model")
      expect(select().options[0].textContent).toBe("missing/old-model")
      expect(props.onSwitch).not.toHaveBeenCalled()
    },
  )
  it("keeps unavailable results disabled and image models excluded", () => {
    openSearch()
    query("unavailable")
    expect(values()).toEqual([primary.selector, unavailable.selector])
    expect(select().options[1].disabled).toBe(true)
    choose(unavailable.selector)
    expect(props.onSwitch).not.toHaveBeenCalled()
    query("image")
    expect(values()).not.toContain(image.selector)
    expect(props.onSwitch).not.toHaveBeenCalled()
  })
  it("clears on close and Escape without closing during IME composition", () => {
    openSearch()
    query("target")
    act(() =>
      input().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }),
      ),
    )
    expect(input().value).toBe("target")
    act(() =>
      input().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    )
    expect(input()).toBeNull()
    expect(document.activeElement).toBe(toggle())
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(values()).toEqual([primary.selector, unavailable.selector, target.selector])
    openSearch()
    expect(input().value).toBe("")
    query("target")
    act(() => toggle().click())
    openSearch()
    expect(input().value).toBe("")
    expect(props.onSwitch).not.toHaveBeenCalled()
  })
  it("uses normal input-to-select tab order and preserves focus within the search controls", () => {
    openSearch()
    const tabEvent = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    act(() => input().dispatchEvent(tabEvent))
    expect(tabEvent.defaultPrevented).toBe(false)
    expect(
      input().compareDocumentPosition(select()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    act(() => select().focus())
    expect(input()).not.toBeNull()
    expect(document.activeElement).toBe(select())
    act(() =>
      select().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    )
    expect(input()).toBeNull()
    expect(document.activeElement).toBe(toggle())
    expect(props.onSwitch).not.toHaveBeenCalled()
  })

  it.each(["pointer", "focus"])("closes on outside %s without taking the new focus", (method) => {
    const outside = document.createElement("button")
    document.body.append(outside)
    try {
      openSearch()
      query("target")
      act(() => {
        if (method === "pointer") outside.dispatchEvent(new Event("pointerdown", { bubbles: true }))
        outside.focus()
      })
      expect(input()).toBeNull()
      expect(document.activeElement).toBe(outside)
      expect(values()).toEqual([primary.selector, unavailable.selector, target.selector])
      expect(props.onSwitch).not.toHaveBeenCalled()
      openSearch()
      expect(input().value).toBe("")
    } finally {
      outside.remove()
    }
  })

  it("retains the search across a null blur and ignores composing Enter or Escape", () => {
    openSearch()
    query("target")
    act(() => input().blur())
    expect(input()).not.toBeNull()
    act(() => input().focus())
    for (const key of ["Escape", "Enter"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      })
      act(() => input().dispatchEvent(event))
      expect(event.defaultPrevented).toBe(false)
      expect(input().value).toBe("target")
    }
    expect(props.onSwitch).not.toHaveBeenCalled()
  })

  it("only observes outside pointers while open and cleans up on close or unmount", () => {
    const add = vi.spyOn(document, "addEventListener")
    const remove = vi.spyOn(document, "removeEventListener")
    const extra = document.createElement("div")
    document.body.append(extra)
    const extraRoot = createRoot(extra)
    try {
      act(() => extraRoot.render(<SessionControls {...props} />))
      expect(add.mock.calls.filter(([type]) => type === "pointerdown")).toHaveLength(0)
      const button = extra.querySelector<HTMLButtonElement>(".session-model-search-toggle")!
      act(() => button.click())
      const firstListener = add.mock.calls.find(([type]) => type === "pointerdown")![1]
      act(() => button.click())
      expect(remove).toHaveBeenCalledWith("pointerdown", firstListener)
      act(() => button.click())
      const secondListener = add.mock.calls.filter(([type]) => type === "pointerdown")[1][1]
      act(() => extraRoot.unmount())
      expect(remove).toHaveBeenCalledWith("pointerdown", secondListener)
    } finally {
      add.mockRestore()
      remove.mockRestore()
      extra.remove()
    }
  })

  it("preserves query during catalog refresh and resets it for a different session", () => {
    openSearch()
    query("target")
    const config = snapshot()
    config.models.push(model("target-new"))
    render({ ompConfig: config })
    expect(input().value).toBe("target")
    expect(values()).toEqual([primary.selector, target.selector, "provider/target-new"])
    expect(select().value).toBe(primary.selector)
    render({ tab: { ...initialTab, id: "tab-b", sessionPath: "/synthetic/b.jsonl" } })
    expect(input()).toBeNull()
    openSearch()
    expect(input().value).toBe("")
    expect(props.onSwitch).not.toHaveBeenCalled()
  })
  it.each(["switching", "primaryProviderPinPending", "switchRecovery"] as const)(
    "blocks searching and selecting during %s",
    (state) => {
      openSearch()
      query("target")
      render({
        tab: {
          ...initialTab,
          [state]:
            state === "switchRecovery"
              ? {
                  terminalId: initialTab.id,
                  state: "pending",
                  generation: 1,
                  byteCount: 3,
                  token: "synthetic-token",
                }
              : true,
        },
      })
      expect(input().disabled).toBe(true)
      expect(toggle().disabled).toBe(true)
      expect(select().disabled).toBe(true)
      choose(target.selector)
      expect(props.onSwitch).not.toHaveBeenCalled()
      render({ tab: initialTab })
      expect(input().value).toBe("target")
      expect(select().disabled).toBe(false)
    },
  )
})
