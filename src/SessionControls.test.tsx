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
  currentModel: "provider/primary",
  currentModelRole: "default",
  currentThinking: "medium",
  currentThinkingConfigured: "medium",
  primaryProviderPinned: false,
  primaryProviderPinPending: false,
}

function config(primaryProviderPin: boolean): OmpConfigSnapshot {
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
    capabilities: { primaryProviderPin },
    advisorEnabled: false,
    autoResume: false,
    defaultThinkingLevel: "medium",
    modelFallbackEnabled: true,
    fallbackChains: {},
    proxyProviders: [],
    providerEnvKeys: [],
    credentials: [],
    warnings: [],
    raw: {},
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

  it("disables the pin for OMP builds without routing support", () => {
    const onToggle = vi.fn()
    act(() => {
      root.render(
        <SessionControls
          lang="ru"
          ompConfig={config(false)}
          onSwitch={vi.fn()}
          onTogglePrimaryProviderPin={onToggle}
          runtimeStatus="normal"
          tab={tab}
        />,
      )
    })

    const pin = container.querySelector<HTMLButtonElement>(".primary-provider-pin")
    expect(pin?.disabled).toBe(true)
    expect(pin?.title).toContain("не поддерживает")
    act(() => pin?.click())
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("enables the pin when OMP exposes the explicit runtime capability", () => {
    const onToggle = vi.fn()
    act(() => {
      root.render(
        <SessionControls
          lang="ru"
          ompConfig={config(true)}
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
})
