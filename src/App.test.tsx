/** @vitest-environment jsdom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App from "./App"
import * as api from "./api"
import { confirm } from "@tauri-apps/plugin-dialog"
import { checkClientUpdate, installClientUpdate } from "./clientUpdater"
import type { BootstrapPayload, OmpConfigSnapshot, TerminalStarted } from "./types"

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  bootstrap: vi.fn(),
  loadOmpConfig: vi.fn(),
  saveSettingsBundle: vi.fn(),
  startTerminal: vi.fn(),
  setTerminalPrimaryProviderPin: vi.fn(),
  checkOmpUpdate: vi.fn().mockResolvedValue({ hasUpdate: false }),
  sampleResourceHealth: vi.fn().mockRejectedValue(new Error("No resource sample in this fixture")),
}))
vi.mock("./clientUpdater", () => ({
  checkClientUpdate: vi.fn(),
  installClientUpdate: vi.fn(),
}))
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("0.9.3") }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }))
vi.mock("./TerminalView", () => ({ TerminalView: () => <div /> }))

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function config(id: string): OmpConfigSnapshot {
  const model = {
    provider: "provider",
    id,
    selector: `provider/${id}`,
    name: id,
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

const bootstrap: BootstrapPayload = {
  settings: {
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
    appFontSize: 16,
    terminalFontFamily: "monospace",
    terminalFontSize: 14,
    providerEnvKeys: [],
    secretStorageWarning: null,
    settingsWarning: null,
  },
  runtime: {
    platform: "windows",
    arch: "x86_64",
    language: "ru",
    ompAvailable: true,
    ompExecutable: "omp.exe",
    ompVersion: "omp/18.1.19",
    sessionRoot: "C:/fixture/sessions",
  },
  workspaces: [
    {
      key: "project",
      path: "C:/fixture/project",
      name: "Fixture",
      sessionCount: 1,
      lastActive: 1,
      pinned: false,
    },
  ],
  sessions: [
    {
      id: "session-1",
      title: "Fixture session",
      pinnedTitle: null,
      cwd: "C:/fixture/project",
      projectKey: "project",
      filePath: "C:/fixture/sessions/session.jsonl",
      parentSessionPath: null,
      createdAt: "2026-09-13T00:00:00Z",
      updatedAt: 1,
      model: null,
      thinkingLevel: null,
      configuredThinkingLevel: null,
      source: "omp",
      hasMessages: true,
      primaryProviderPinned: false,
    },
  ],
  sessionWarnings: [],
}
const started: TerminalStarted = {
  terminalId: "terminal-1",
  processId: 101,
  cwd: "C:/fixture/project",
}

describe("App lifecycle serialization", () => {
  let root: Root
  let container: HTMLDivElement

  function element<T extends HTMLElement = HTMLButtonElement>(selector: string): T {
    const found = container.querySelector<T>(selector)
    expect(found, selector).not.toBeNull()
    return found!
  }
  function installButton() {
    return element(".update-toast .primary")
  }

  async function mountAndResume() {
    await act(async () => root.render(<App />))
    await act(async () => element('[title="Продолжить сессию"]').click())
    expect(api.startTerminal).toHaveBeenCalledTimes(1)
  }

  async function openAndChangeSettings() {
    await act(async () => element(".runtime-pill").click())
    act(() => {
      const size = element<HTMLSelectElement>("#app-font-size")
      size.value = "18"
      size.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(element<HTMLButtonElement>(".settings-actions .primary").disabled).toBe(false)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap)
    vi.mocked(api.loadOmpConfig).mockReset().mockResolvedValue(config("Initial"))
    vi.mocked(api.saveSettingsBundle).mockReset()
    vi.mocked(api.startTerminal).mockReset().mockResolvedValue(started)
    vi.mocked(api.setTerminalPrimaryProviderPin)
      .mockReset()
      .mockResolvedValue({ ...started, terminalId: "terminal-2", processId: 102 })
    vi.mocked(checkClientUpdate).mockResolvedValue({ version: "99.0.0", date: null, body: null })
    vi.mocked(installClientUpdate)
      .mockReset()
      .mockRejectedValue(new Error("Fixture download failure"))
    vi.mocked(confirm).mockReset().mockResolvedValue(true)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it("does not start a Desktop installer while provider-pin restart is pending, even before a render", async () => {
    const restart = deferred<TerminalStarted>()
    vi.mocked(api.setTerminalPrimaryProviderPin).mockReturnValue(restart.promise)
    await mountAndResume()
    const install = installButton()
    act(() => {
      element(".primary-provider-pin").click()
      install.click()
    })
    expect(api.setTerminalPrimaryProviderPin).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalled()
    expect(installClientUpdate).not.toHaveBeenCalled()
    await act(async () => installButton().click())
    expect(installClientUpdate).not.toHaveBeenCalled()
    await act(async () => restart.reject(new Error("Fixture restart failure")))
    await act(async () => installButton().click())
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(installClientUpdate).toHaveBeenCalledTimes(1)
  })

  it("blocks pin and new launches during confirmation and install, then releases them on failure", async () => {
    const confirmation = deferred<boolean>()
    const installer = deferred<void>()
    vi.mocked(confirm).mockReturnValue(confirmation.promise)
    vi.mocked(installClientUpdate).mockReturnValue(installer.promise)
    await mountAndResume()
    const pin = element<HTMLButtonElement>(".primary-provider-pin")
    const launch = element<HTMLButtonElement>(".new-tab-button")
    act(() => {
      installButton().click()
      pin.click()
      launch.click()
    })
    expect(api.setTerminalPrimaryProviderPin).not.toHaveBeenCalled()
    expect(api.startTerminal).toHaveBeenCalledTimes(1)
    expect(pin.disabled).toBe(true)
    expect(installClientUpdate).not.toHaveBeenCalled()
    await act(async () => confirmation.resolve(true))
    expect(installClientUpdate).toHaveBeenCalledTimes(1)
    act(() => pin.click())
    expect(api.setTerminalPrimaryProviderPin).not.toHaveBeenCalled()
    expect(element<HTMLSelectElement>(".session-model-select").disabled).toBe(false)
    await act(async () => installer.reject(new Error("Fixture install failure")))
    expect(pin.disabled).toBe(false)
    await act(async () => pin.click())
    expect(api.setTerminalPrimaryProviderPin).toHaveBeenCalledTimes(1)
  })

  it("keeps post-save models when initial App and Settings requests resolve late after a save without config", async () => {
    const initial = deferred<OmpConfigSnapshot>()
    const panelInitial = deferred<OmpConfigSnapshot>()
    const fresh = deferred<OmpConfigSnapshot>()
    vi.mocked(api.loadOmpConfig)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(panelInitial.promise)
      .mockReturnValue(fresh.promise)
    vi.mocked(api.saveSettingsBundle).mockResolvedValue({
      bootstrap: { ...bootstrap, settings: { ...bootstrap.settings, appFontSize: 18 } },
      ompConfig: null,
    })
    await mountAndResume()
    await openAndChangeSettings()
    await act(async () => element(".settings-actions .primary").click())
    expect(api.saveSettingsBundle).toHaveBeenCalledWith(
      expect.objectContaining({ ompConfig: null }),
    )
    await act(async () => fresh.resolve(config("Fresh")))
    expect(element<HTMLSelectElement>(".session-model-select").value).toBe("provider/Fresh")
    await act(async () => {
      initial.resolve(config("StaleApp"))
      panelInitial.resolve(config("StalePanel"))
    })
    expect(element<HTMLSelectElement>(".session-model-select").value).toBe("provider/Fresh")
    expect(container.querySelector(".settings-save-error")).toBeNull()
    expect(document.documentElement.style.fontSize).toBe("18px")
  })

  it("accepts a returned save snapshot and ignores an older App failure", async () => {
    const initial = deferred<OmpConfigSnapshot>()
    vi.mocked(api.loadOmpConfig).mockReturnValueOnce(initial.promise)
    vi.mocked(api.saveSettingsBundle).mockResolvedValue({
      bootstrap: { ...bootstrap, settings: { ...bootstrap.settings, appFontSize: 18 } },
      ompConfig: config("Saved"),
    })
    await mountAndResume()
    await openAndChangeSettings()
    await act(async () => element(".settings-actions .primary").click())
    expect(element<HTMLSelectElement>(".session-model-select").value).toBe("provider/Saved")
    await act(async () => initial.reject(new Error("Stale App load failed")))
    expect(element<HTMLSelectElement>(".session-model-select").value).toBe("provider/Saved")
    expect(container.textContent).not.toContain("Stale App load failed")
  })
})
