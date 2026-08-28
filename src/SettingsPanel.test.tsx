/** @vitest-environment jsdom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsPanel } from "./SettingsPanel"
import type { AppSettings, OmpConfigSnapshot, RuntimeInfo } from "./types"

const { loadOmpConfigMock, saveSettingsBundleMock } = vi.hoisted(() => ({
  loadOmpConfigMock: vi.fn(),
  saveSettingsBundleMock: vi.fn(),
}))

vi.mock("./api", () => ({
  errorMessage: (error: unknown) => String(error),
  loadOmpConfig: loadOmpConfigMock,
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
  advisorEnabled: false,
  autoResume: false,
  defaultThinkingLevel: null,
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
  raw: {},
}

describe("SettingsPanel Save state", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    loadOmpConfigMock.mockReset()
    saveSettingsBundleMock.mockReset()
    loadOmpConfigMock.mockResolvedValue(ompConfig)
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
    expect(proxyMode).not.toBeNull()
    act(() => proxyMode?.click())

    expect(save?.disabled).toBe(false)
  })
})
