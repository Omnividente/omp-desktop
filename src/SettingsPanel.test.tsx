/** @vitest-environment jsdom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsPanel } from "./SettingsPanel"
import type { AppSettings, OmpConfigSnapshot, RuntimeInfo } from "./types"

const { loadOmpConfigMock, refreshOmpConfigMock, saveSettingsBundleMock } = vi.hoisted(() => ({
  loadOmpConfigMock: vi.fn(),
  refreshOmpConfigMock: vi.fn(),
  saveSettingsBundleMock: vi.fn(),
}))

vi.mock("./api", () => ({
  errorMessage: (error: unknown) => String(error),
  loadOmpConfig: loadOmpConfigMock,
  refreshOmpConfig: refreshOmpConfigMock,
  saveSettingsBundle: saveSettingsBundleMock,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }))

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const settings: AppSettings = {
  ompExecutable: null,
  sessionRoot: null,
  recentWorkspaces: [],
  workspaceNames: {},
  hiddenWorkspaces: [],
  sessionTitlePins: {},
  primaryProviderPins: [],
  proxyProviders: [],
  railMode: "expanded",
  language: "ru",
  appFontFamily: "Inter",
  terminalFontFamily: "Cascadia Mono",
  terminalFontSize: 14,
  providerEnvKeys: [],
  secretStorageWarning: null,
  settingsWarning: null,
}

const runtime: RuntimeInfo = {
  platform: "windows",
  arch: "x86_64",
  language: "ru",
  ompAvailable: true,
  ompExecutable: "omp.exe",
  ompVersion: "omp/18.0.9",
  sessionRoot: "C:\\Users\\Test\\.omp\\agent\\sessions",
}

const ompConfig: OmpConfigSnapshot = {
  roles: [],
  models: [],
  accounts: [
    {
      id: "cred-1",
      provider: "openai-codex",
      configured: true,
      statusReason: null,
      reporting: true,
      routes: [
        {
          id: "chat",
          label: "Codex Chat",
          status: "ready",
          routingEligible: true,
        },
      ],
      credentialType: "oauth",
      label: "wor***@example.test · 2f07d258",
      status: "limited",
      routingEligible: true,
      routingEvidence: "usage",
      limits: [
        {
          id: "openai-codex:chat:5h",
          label: "ChatGPT",
          status: "warning",
          usedPercent: 82,
          windowLabel: "5h",
          resetsAt: null,
        },
      ],
      fetchedAt: Date.now(),
    },
  ],
  advisorEnabled: false,
  autoResume: false,
  defaultThinkingLevel: null,
  usageObservedAt: Date.now(),
  modelFallbackEnabled: true,
  fallbackChains: {},
  proxyProviders: [],
  providerEnvKeys: [],
  credentials: [
    {
      provider: "codex-lb",
      keyName: null,
      source: "command",
      status: "ready",
      available: true,
      modelCount: 1,
    },
  ],
  warnings: [],
}

describe("SettingsPanel Save state", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    loadOmpConfigMock.mockReset()
    refreshOmpConfigMock.mockReset()
    saveSettingsBundleMock.mockReset()
    loadOmpConfigMock.mockResolvedValue(ompConfig)
    refreshOmpConfigMock.mockResolvedValue(ompConfig)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("enables Save only after a settings change", async () => {
    await act(async () => {
      root.render(
        <SettingsPanel
          onClose={vi.fn()}
          onError={vi.fn()}
          onSaved={vi.fn()}
          runtime={runtime}
          settings={settings}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")
    expect(save?.disabled).toBe(true)

    const providersTab = [
      ...container.querySelectorAll<HTMLButtonElement>(".settings-nav button"),
    ].find((button) => button.textContent?.includes("Провайдеры"))
    act(() => providersTab?.click())
    const proxyMode = container.querySelector<HTMLInputElement>(".provider-proxy-toggle input")
    act(() => proxyMode?.click())

    expect(save?.disabled).toBe(false)
  })

  it("keeps a non-reporting account visible beside a healthy sibling", async () => {
    const healthy = ompConfig.accounts[0]
    if (!healthy) throw new Error("account fixture missing")
    loadOmpConfigMock.mockResolvedValue({
      ...ompConfig,
      accounts: [
        healthy,
        {
          ...healthy,
          id: "cred-2",
          label: "sec***@example.test · 4a994ea1",
          status: "unknown",
          reporting: false,
          routingEvidence: "unknown",
          routingEligible: false,
          statusReason: "usage limits were not reported",
          limits: [],
          fetchedAt: null,
          routes: [],
        },
      ],
    })

    await act(async () => {
      root.render(
        <SettingsPanel
          onClose={vi.fn()}
          onError={vi.fn()}
          onSaved={vi.fn()}
          runtime={runtime}
          settings={settings}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const providersTab = [
      ...container.querySelectorAll<HTMLButtonElement>(".settings-nav button"),
    ].find((button) => button.textContent?.includes("Провайдеры"))
    act(() => providersTab?.click())

    const cards = [...container.querySelectorAll<HTMLDetailsElement>("details.provider-account")]
    expect(cards).toHaveLength(2)

    const reporting = container.querySelector<HTMLDetailsElement>(
      '[data-testid="provider-account-cred-1"]',
    )
    const missing = container.querySelector<HTMLDetailsElement>(
      '[data-testid="provider-account-cred-2"]',
    )
    expect(reporting?.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("82")
    expect(missing?.querySelector('[role="meter"]')).toBeNull()
    expect(missing?.open).toBe(false)
    act(() => missing?.querySelector("summary")?.click())
    expect(missing?.open).toBe(true)
  })
})
