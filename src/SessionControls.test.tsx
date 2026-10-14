/** @vitest-environment jsdom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionControls } from "./SessionControls"
import type { OmpConfigSnapshot, TerminalTab } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const tab: TerminalTab = {
  id: "terminal-1",
  label: "Session",
  pinnedTitle: null,
  cwd: "/tmp/project",
  processId: 1,
  sessionId: "session-1",
  sessionPath: "/tmp/session.jsonl",
  status: "running",
  activity: "idle",
  exitCode: null,
  success: null,
  kind: "agent",
  switching: false,
  switchRecovery: null,
  currentModel: "provider/primary",
  currentModelRole: "default",
  currentThinking: "medium",
  currentThinkingConfigured: "medium",
  primaryProviderPinned: false,
  primaryProviderPinPending: false,
}

function config(): OmpConfigSnapshot {
  const model = {
    provider: "provider",
    id: "primary",
    selector: "provider/primary",
    name: "Primary",
    available: true,
    status: "ready",
    detail: null,
    thinking: ["medium"],
  }
  return {
    roles: [
      {
        role: "default",
        selector: model.selector,
        model,
        available: true,
        status: "ready",
        detail: null,
      },
    ],
    models: [model],
    agents: [],
    agentSettingsSupported: false,
    accounts: [],
    advisorEnabled: false,
    autoResume: false,
    defaultThinkingLevel: "medium",
    modelFallbackEnabled: true,
    fallbackChains: {},
    proxyProviders: [],
    disabledProviders: [],
    usageObservedAt: null,
    providerEnvKeys: [],
    credentials: [],
    warnings: [],
  }
}
describe("SessionControls primary provider pin", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("enables the pin without a runtime capability handshake", () => {
    const onToggle = vi.fn()
    act(() => {
      root.render(
        <SessionControls
          installingDesktopUpdate={false}
          lang="ru"
          ompConfig={config()}
          onDiscardSwitchRecovery={vi.fn()}
          onSendSwitchRecovery={vi.fn()}
          onSwitch={vi.fn()}
          onTogglePrimaryProviderPin={onToggle}
          runtimeStatus="normal"
          tab={tab}
        />,
      )
    })

    const pin = container.querySelector<HTMLButtonElement>(".primary-provider-pin")
    expect(pin?.disabled).toBe(false)
    act(() => pin?.click())
    expect(onToggle).toHaveBeenCalledWith("terminal-1", true)
  })

  it.each([false, true])(
    "keeps a valid focus target during pin restart without reclaiming external focus (%s)",
    (externalFocus) => {
      const outside = document.createElement("button")
      document.body.appendChild(outside)
      const render = (pending: boolean) =>
        root.render(
          <SessionControls
            installingDesktopUpdate={false}
            lang="ru"
            ompConfig={config()}
            onDiscardSwitchRecovery={vi.fn()}
            onSendSwitchRecovery={vi.fn()}
            onSwitch={vi.fn()}
            onTogglePrimaryProviderPin={() => render(true)}
            runtimeStatus="normal"
            tab={{ ...tab, primaryProviderPinPending: pending }}
          />,
        )
      try {
        act(() => render(false))
        const pin = container.querySelector<HTMLButtonElement>(".primary-provider-pin")!
        act(() => {
          pin.focus()
          pin.click()
        })
        expect(pin.disabled).toBe(true)
        const controls = container.querySelector(".session-controls")
        expect(document.activeElement).toBe(controls)
        if (externalFocus)
          act(() => {
            outside.focus()
            outside.blur()
          })
        act(() => render(false))
        expect(pin.disabled).toBe(false)
        expect(document.activeElement).toBe(externalFocus ? document.body : pin)
      } finally {
        outside.remove()
      }
    },
  )

  it("keeps non-chat models out of running-session switches", () => {
    const snapshot = config()
    const imageModel = {
      ...snapshot.models[0],
      id: "image-generator",
      selector: "provider/image-generator",
      kind: "image",
    }
    snapshot.models.push(imageModel)
    const onSwitch = vi.fn()
    act(() => {
      root.render(
        <SessionControls
          installingDesktopUpdate={false}
          lang="ru"
          ompConfig={snapshot}
          onSwitch={onSwitch}
          onDiscardSwitchRecovery={vi.fn()}
          onSendSwitchRecovery={vi.fn()}
          onTogglePrimaryProviderPin={vi.fn()}
          runtimeStatus="normal"
          tab={tab}
        />,
      )
    })
    const select = container.querySelector<HTMLSelectElement>(".session-model-select")!
    expect(Array.from(select.options, (option) => option.value)).toEqual(["provider/primary"])
    act(() => {
      const injected = new Option("Image", imageModel.selector)
      select.add(injected)
      select.value = imageModel.selector
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it("waits for session discovery before enabling restart", () => {
    const onToggle = vi.fn()
    act(() => {
      root.render(
        <SessionControls
          installingDesktopUpdate={false}
          lang="ru"
          ompConfig={config()}
          onSwitch={vi.fn()}
          onDiscardSwitchRecovery={vi.fn()}
          onSendSwitchRecovery={vi.fn()}
          onTogglePrimaryProviderPin={onToggle}
          runtimeStatus="normal"
          tab={{ ...tab, sessionPath: null }}
        />,
      )
    })

    const pin = container.querySelector<HTMLButtonElement>(".primary-provider-pin")
    expect(pin?.disabled).toBe(true)
    act(() => pin?.click())
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("blocks conflicting controls while the session restarts", () => {
    act(() => {
      root.render(
        <SessionControls
          installingDesktopUpdate={false}
          lang="ru"
          ompConfig={config()}
          onSwitch={vi.fn()}
          onDiscardSwitchRecovery={vi.fn()}
          onSendSwitchRecovery={vi.fn()}
          onTogglePrimaryProviderPin={vi.fn()}
          runtimeStatus="fallback"
          tab={{ ...tab, primaryProviderPinPending: true }}
        />,
      )
    })

    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("select, button"),
      ).every((control) => control.disabled),
    ).toBe(true)
    expect(container.textContent).toContain("Перезапускаем…")
    expect(container.querySelector(".session-fallback")).toBeNull()
  })

  it("renders metadata-only recovery with explicit send and discard actions", () => {
    const onSend = vi.fn()
    const onDiscard = vi.fn()
    act(() => {
      root.render(
        <SessionControls
          installingDesktopUpdate={false}
          lang="ru"
          ompConfig={config()}
          onDiscardSwitchRecovery={onDiscard}
          onSendSwitchRecovery={onSend}
          onSwitch={vi.fn()}
          onTogglePrimaryProviderPin={vi.fn()}
          runtimeStatus="normal"
          tab={{
            ...tab,
            switchRecovery: {
              terminalId: tab.id,
              state: "pending",
              generation: 3,
              byteCount: 17,
              token: "backend-only-buffer-token",
            },
          }}
        />,
      )
    })

    const recovery = container.querySelector<HTMLElement>(".switch-input-recovery")
    expect(recovery?.textContent).toContain("17 байт")
    expect(recovery?.textContent).not.toContain("backend-only-buffer-token")
    expect(container.querySelector<HTMLSelectElement>(".session-model-select")?.disabled).toBe(true)
    expect(container.querySelector<HTMLSelectElement>(".session-thinking-select")?.disabled).toBe(
      true,
    )
    const buttons = Array.from(recovery?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    expect(buttons.map((button) => button.textContent)).toEqual(["Отправить", "Удалить"])
    act(() => buttons[0]?.click())
    act(() => buttons[1]?.click())
    expect(onSend).toHaveBeenCalledWith("terminal-1")
    expect(onDiscard).toHaveBeenCalledWith("terminal-1")
  })
})
