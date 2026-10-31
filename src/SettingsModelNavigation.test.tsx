/** @vitest-environment jsdom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsPanel } from "./SettingsPanel"
import type { AppSettings, OmpConfigSnapshot, RuntimeInfo } from "./types"
import type * as Api from "./api"

const { confirmMock, loadOmpConfigMock, refreshOmpConfigMock, saveSettingsBundleMock } = vi.hoisted(
  () => ({
    confirmMock: vi.fn(),
    loadOmpConfigMock: vi.fn(),
    refreshOmpConfigMock: vi.fn(),
    saveSettingsBundleMock: vi.fn(),
  }),
)

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  loadOmpConfig: loadOmpConfigMock,
  refreshOmpConfig: refreshOmpConfigMock,
  saveSettingsBundle: saveSettingsBundleMock,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock, open: vi.fn() }))

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const settings: AppSettings = {
  ompExecutable: null,
  sessionRoot: null,
  recentWorkspaces: [],
  lastWorkspace: null,
  workspaceNames: {},
  hiddenWorkspaces: [],
  sessionTitlePins: {},
  primaryProviderPins: [],
  proxyProviders: [],
  railMode: "expanded",
  language: "ru",
  desktopTheme: "dark",
  appFontFamily: "Inter",
  appFontSize: 16,
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
  agents: [],
  agentSettingsSupported: false,
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
  disabledProviders: [],
  providerEnvKeys: [],
  credentials: [
    {
      provider: "codex-lb",
      keyName: "OMP_DESKTOP_PROVIDER_636F6465782D6C62_API_KEY",
      source: "command",
      status: "ready",
      available: true,
      modelCount: 1,
      custom: true,
      baseUrl: "https://gateway.example.test/v1",
      api: "openai-completions",
    },
    {
      provider: "openai",
      keyName: "OPENAI_API_KEY",
      source: "environment",
      status: "ready",
      available: true,
      modelCount: 2,
      custom: false,
      baseUrl: null,
      api: null,
    },
  ],
  warnings: [],
}

describe("SettingsPanel model navigation across ordinary clock tick", () => {
  let container: HTMLDivElement, root: Root
  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    loadOmpConfigMock.mockReset()
    saveSettingsBundleMock.mockReset()
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })
  it.each([
    { key: "Enter", tick: 1000 },
    { key: " ", tick: 1000 },
    { key: "Enter", tick: 0 },
    { key: "click", tick: 1000 },
  ])("focused option should commit: %j", async ({ key, tick }) => {
    const models = Array.from({ length: 600 }, (_, i) => ({
      provider: `provider-${i % 6}`,
      id: `m${i}`,
      selector: `provider-${i % 6}/m${i}`,
      name: `Model ${i}`,
      available: true,
      status: "ready",
      detail: null,
      thinking: ["high"],
    }))
    const selected = models[500]
    const snapshot = {
      ...ompConfig,
      models,
      roles: [
        {
          role: "default",
          selector: selected.selector + ":high",
          model: selected,
          available: true,
          status: "ready",
          detail: null,
        },
      ],
    }
    loadOmpConfigMock.mockResolvedValue(snapshot)
    await act(async () =>
      root.render(
        <SettingsPanel
          initialOmpConfig={snapshot}
          onClose={vi.fn()}
          onError={vi.fn()}
          onSaved={vi.fn()}
          runtime={runtime}
          settings={settings}
        />,
      ),
    )
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-role="default"] .model-picker-trigger')!
        .click(),
    )
    const search = container.querySelector<HTMLInputElement>(".model-picker-search input")!
    act(() =>
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    )
    const focused = document.activeElement as HTMLButtonElement
    const intended = focused.querySelector("small")!.textContent
    expect(intended).not.toBe(selected.selector)
    act(() => vi.advanceTimersByTime(tick))
    expect(document.activeElement).toBe(focused)
    const listbox = container.querySelector('[role="listbox"]')!
    expect(
      document
        .getElementById(listbox.getAttribute("aria-activedescendant")!)
        ?.querySelector("small")?.textContent,
    ).toBe(intended)
    act(() =>
      key === "click"
        ? focused.click()
        : focused.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
          ),
    )
    expect(saveSettingsBundleMock).not.toHaveBeenCalled()
    expect(
      container.querySelector('[data-role="default"] .model-picker-copy small')?.textContent,
    ).toBe(intended + ":high")
  })
})
