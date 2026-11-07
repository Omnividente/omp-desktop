/** @vitest-environment jsdom */

import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionControls } from "./SessionControls"
import type { OmpModelInfo, TerminalTab } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const model = (provider: string, id: string, thinking = ["low", "high"]): OmpModelInfo => ({
  provider,
  id,
  selector: `${provider}/${id}`,
  name: `${provider} ${id}`,
  available: true,
  status: "ready",
  detail: null,
  thinking,
})
const initial = model("initial", "current")
const exact = model("beta", "shared", ["high"])
const collision = model("alpha", "beta/shared", ["low"])
const tab: TerminalTab = {
  id: "synthetic-tab",
  label: "Synthetic session",
  pinnedTitle: null,
  cwd: "/synthetic/project",
  processId: null,
  sessionId: "synthetic-session",
  sessionPath: "/synthetic/session.jsonl",
  status: "running",
  activity: "idle",
  exitCode: null,
  success: null,
  kind: "agent",
  switching: false,
  switchRecovery: null,
  currentModel: initial.selector,
  currentThinking: "high",
  currentThinkingConfigured: "high",
  primaryProviderPinned: false,
  primaryProviderPinPending: false,
}

describe("running-session catalog identity", () => {
  let container: HTMLDivElement
  let root: Root
  let props: ComponentProps<typeof SessionControls>
  beforeEach(() => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    props = {
      tab,
      ompConfig: {
        models: [initial, collision, exact],
        roles: [],
        agents: [],
        accounts: [],
        agentSettingsSupported: false,
        advisorEnabled: false,
        autoResume: false,
        defaultThinkingLevel: "high",
        modelFallbackEnabled: false,
        fallbackChains: {},
        proxyProviders: [],
        disabledProviders: [],
        usageObservedAt: null,
        providerEnvKeys: [],
        credentials: [],
        warnings: [],
      },
      lang: "en",
      runtimeStatus: "normal",
      installingDesktopUpdate: false,
      onDiscardSwitchRecovery: vi.fn(),
      onSendSwitchRecovery: vi.fn(),
      onSwitch: vi.fn(),
      onTogglePrimaryProviderPin: vi.fn(),
    }
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const select = () => container.querySelector<HTMLSelectElement>(".session-model-select")!
  const thinking = () => container.querySelector<HTMLSelectElement>(".session-thinking-select")!
  function render(models = props.ompConfig!.models, current = props.tab) {
    props = {
      ...props,
      tab: current,
      ompConfig: { ...props.ompConfig!, models },
    }
    act(() => root.render(<SessionControls {...props} />))
  }
  function choose(value: string, control = select()) {
    act(() => {
      control.value = value
      control.dispatchEvent(new Event("change", { bubbles: true }))
    })
  }

  it.each([false, true])(
    "honors the explicitly chosen qualified option independent of catalog order (%s)",
    (reverse) => {
      render([initial, ...(reverse ? [exact, collision] : [collision, exact])])
      choose(exact.selector)
      expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith(tab.id, exact.selector, "high")
    },
  )

  it("does not let an unavailable raw-ID collision block an available option", () => {
    render([initial, { ...collision, available: false }, exact])
    choose(exact.selector)
    expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith(tab.id, exact.selector, "high")
  })

  it("does not let an available raw-ID collision enable an unavailable option", () => {
    render([initial, collision, { ...exact, available: false }])
    choose(exact.selector)
    expect(props.onSwitch).not.toHaveBeenCalled()
  })

  it("keeps current identity and thinking aligned after catalog reorder", () => {
    render([exact, collision], { ...tab, currentModel: exact.selector })
    render([collision, exact])
    expect(select().value).toBe(exact.selector)
    expect(select().selectedOptions[0].textContent).toBe(exact.name)
    expect(Array.from(thinking().options, (option) => option.value)).toEqual([
      "off",
      "auto",
      "high",
    ])
    expect(props.onSwitch).not.toHaveBeenCalled()
    choose("off", thinking())
    expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith(tab.id, exact.selector, "off")
  })

  it("does not guess a provider or thinking options for an ambiguous bare current ID", () => {
    render([model("alpha", "shared"), exact], {
      ...tab,
      currentModel: "shared",
    })
    expect(select().value).toBe("shared")
    expect(select().selectedOptions[0].textContent).toBe("shared")
    expect(thinking().disabled).toBe(true)
    expect(props.onSwitch).not.toHaveBeenCalled()
    choose(exact.selector)
    expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith(tab.id, exact.selector, "high")
  })

  it.each(["high", "off", "auto"])(
    "preserves a literal catalog selector ending in :%s",
    (suffix) => {
      const literal = model("beta", `shared:${suffix}`, ["low"])
      render([initial, exact, literal])
      expect(Array.from(select().options, (option) => option.value)).toContain(literal.selector)
      choose(literal.selector)
      expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith(tab.id, literal.selector, "low")
      props.onSwitch = vi.fn()
      render([exact, literal], {
        ...tab,
        currentModel: literal.selector,
        currentThinking: null,
        currentThinkingConfigured: null,
      })
      expect(select().value).toBe(literal.selector)
      expect(thinking().value).toBe("low")
      choose("off", thinking())
      expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith(tab.id, literal.selector, "off")
    },
  )

  it("retains a separately appended thinking suffix and a unique bare selector", () => {
    render([exact], {
      ...tab,
      currentModel: "shared:high",
      currentThinking: null,
      currentThinkingConfigured: null,
    })
    expect(select().value).toBe(exact.selector)
    expect(thinking().value).toBe("high")
    expect(props.onSwitch).not.toHaveBeenCalled()
  })

  it("removes guessed metadata when a once-unique bare current ID becomes ambiguous", () => {
    render([exact], { ...tab, currentModel: "shared" })
    expect(select().value).toBe(exact.selector)
    render([model("alpha", "shared"), exact])
    expect(select().value).toBe("shared")
    expect(thinking().disabled).toBe(true)
    render([exact])
    expect(select().value).toBe(exact.selector)
    expect(props.onSwitch).not.toHaveBeenCalled()
  })

  it.each(["shared:high", "beta/shared:high"])(
    "retains an unresolved literal %s instead of guessing from its stripped suffix",
    (selector) => {
      const models = [model("alpha", selector), model("other", selector), model("beta", "shared")]
      render(models, {
        ...tab,
        currentModel: selector,
        currentThinking: null,
        currentThinkingConfigured: null,
      })
      expect(select().value).toBe(selector)
      expect(thinking().disabled).toBe(true)
      expect(props.onSwitch).not.toHaveBeenCalled()
    },
  )

  it("rejects duplicate canonical selectors instead of selecting whichever came first", () => {
    render([initial, exact, { ...exact, name: "Duplicate declaration", thinking: ["low"] }])
    choose(exact.selector)
    expect(props.onSwitch).not.toHaveBeenCalled()
  })
})
