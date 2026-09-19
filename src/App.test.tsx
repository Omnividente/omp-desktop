/** @vitest-environment jsdom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App from "./App"
import * as api from "./api"
import { confirm } from "@tauri-apps/plugin-dialog"
import { listen, type EventCallback } from "@tauri-apps/api/event"
import { checkClientUpdate, installClientUpdate } from "./clientUpdater"
import type {
  BootstrapPayload,
  OmpConfigSnapshot,
  SingleInstanceEvent,
  TerminalStarted,
} from "./types"

const updaterAction = vi.hoisted(() => ({ install: null as (() => void) | null }))

vi.mock("./useClientUpdater", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useClientUpdater")>()
  return {
    useClientUpdater(...args: Parameters<typeof actual.useClientUpdater>) {
      const updater = actual.useClientUpdater(...args)
      updaterAction.install = updater.install
      return updater
    },
  }
})

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  bootstrap: vi.fn(),
  addWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  deleteSession: vi.fn(),
  saveWorkspaceSelection: vi.fn(),
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
    lastWorkspace: null,
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

function workspacePayload(...names: string[]): BootstrapPayload {
  return {
    ...bootstrap,
    workspaces: names.map((name) => ({
      ...bootstrap.workspaces[0],
      key: name.toLowerCase(),
      path: `C:/fixture/${name}`,
      name,
    })),
    sessions: names.map((name) => ({
      ...bootstrap.sessions[0],
      id: `session-${name}`,
      title: `${name} session`,
      projectKey: name.toLowerCase(),
      cwd: `C:/fixture/${name}`,
      filePath: `C:/fixture/sessions/${name}.jsonl`,
    })),
  }
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
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(".update-toast .primary"),
    ].find((candidate) => candidate.textContent === "Установить и перезапустить")
    expect(button).toBeDefined()
    return button!
  }

  async function mountAndResume() {
    await act(async () => root.render(<App />))
    await act(async () => element('[title="Продолжить сессию"]').click())
    expect(api.startTerminal).toHaveBeenCalledTimes(1)
  }

  function requestWorkspace(name: string) {
    const subscription = vi.mocked(listen).mock.calls.find(([event]) => event === "single-instance")
    expect(subscription).toBeDefined()
    const receive = subscription![1] as EventCallback<SingleInstanceEvent>
    receive({
      event: "single-instance",
      id: 1,
      payload: { args: ["omp-desktop", "--workspace", `C:/fixture/${name}`] },
    })
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
    vi.mocked(api.bootstrap).mockReset().mockResolvedValue(bootstrap)
    vi.mocked(api.addWorkspace).mockReset()
    vi.mocked(api.removeWorkspace).mockReset()
    vi.mocked(api.deleteSession).mockReset()
    vi.mocked(api.saveWorkspaceSelection).mockReset().mockResolvedValue(undefined)
    vi.mocked(api.loadOmpConfig).mockReset().mockResolvedValue(config("Initial"))
    vi.mocked(api.saveSettingsBundle).mockReset()
    vi.mocked(api.startTerminal).mockReset().mockResolvedValue(started)
    vi.mocked(api.checkOmpUpdate).mockReset().mockResolvedValue({
      hasUpdate: false,
      currentVersion: "18.1.19",
      latestVersion: null,
      message: "",
    })
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

  it("restores the selected workspace after remount without opening a terminal", async () => {
    let remembered: string | null = null
    const projects = workspacePayload("A", "B")
    vi.mocked(api.bootstrap).mockImplementation(async () => ({
      ...projects,
      settings: { ...projects.settings, lastWorkspace: remembered },
    }))
    vi.mocked(api.saveWorkspaceSelection).mockImplementation(async (path) => {
      remembered = path
    })
    await act(async () => root.render(<App />))
    await act(async () => element('.project-item[aria-label^="B,"]').click())
    await act(async () => root.render(null))
    await act(async () => root.render(<App />))
    expect(element(".project-item.is-active").textContent).toContain("B")
    expect(container.textContent).toContain("B session")
    expect(api.startTerminal).not.toHaveBeenCalled()
    expect(api.addWorkspace).not.toHaveBeenCalled()
  })

  it("lets an explicit workspace request override remembered selection", async () => {
    const projects = workspacePayload("A", "B")
    projects.settings = { ...projects.settings, lastWorkspace: "C:/fixture/B" }
    vi.mocked(api.bootstrap).mockResolvedValue(projects)
    vi.mocked(api.addWorkspace).mockResolvedValue(projects)
    await act(async () => root.render(<App />))
    expect(element(".project-item.is-active").textContent).toContain("B")
    await act(async () => requestWorkspace("A"))
    expect(element(".project-item.is-active").textContent).toContain("A")
    expect(api.saveWorkspaceSelection).toHaveBeenLastCalledWith("C:/fixture/A")
    expect(api.startTerminal).not.toHaveBeenCalled()
  })

  it("does not recreate a removed remembered workspace on refresh or remount", async () => {
    const projects = workspacePayload("A", "B")
    projects.settings = { ...projects.settings, lastWorkspace: "C:/fixture/B" }
    const removed = workspacePayload("A")
    // Even a stale remembered value is only a hint within the visible workspace list.
    removed.settings = { ...projects.settings, hiddenWorkspaces: ["C:/fixture/B"] }
    vi.mocked(api.bootstrap).mockResolvedValueOnce(projects).mockResolvedValue(removed)
    vi.mocked(api.removeWorkspace).mockResolvedValue(removed)
    await act(async () => root.render(<App />))
    await act(async () => element(".project-item-row.is-active .project-remove").click())
    expect(element(".project-item.is-active").textContent).toContain("A")
    await act(async () => root.render(null))
    await act(async () => root.render(<App />))
    expect(element(".project-item.is-active").textContent).toContain("A")
    expect(container.querySelectorAll(".project-item")).toHaveLength(1)
    expect(api.addWorkspace).not.toHaveBeenCalled()
    expect(api.startTerminal).not.toHaveBeenCalled()
  })

  it("restores focus to the session list after deleting its focused final session", async () => {
    const deletion = deferred<BootstrapPayload>()
    vi.mocked(api.deleteSession).mockReturnValue(deletion.promise)
    await act(async () => root.render(<App />))
    const button = element<HTMLButtonElement>(".session-delete")
    await act(async () => {
      button.focus()
      button.click()
    })
    await act(async () => deletion.resolve({ ...bootstrap, sessions: [] }))
    expect(button.isConnected).toBe(false)
    expect(document.activeElement).toBe(element(".session-list"))
    expect(element(".sidebar-empty")).toBeTruthy()
  })

  it("does not reclaim session focus after the user moved away during deletion", async () => {
    const deletion = deferred<BootstrapPayload>()
    vi.mocked(api.deleteSession).mockReturnValue(deletion.promise)
    await act(async () => root.render(<App />))
    const button = element<HTMLButtonElement>(".session-delete")
    await act(async () => {
      button.focus()
      button.click()
    })
    const search = element<HTMLInputElement>(".project-sessions input")
    act(() => {
      search.focus()
      search.blur()
    })
    await act(async () => deletion.resolve({ ...bootstrap, sessions: [] }))
    expect(button.isConnected).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it.each(["success", "failure"] as const)(
    "serializes workspace persistence past an older %s without rolling back the latest selection",
    async (outcome) => {
      const first = deferred<void>()
      const last = deferred<void>()
      const projects = workspacePayload("A", "B", "C")
      vi.mocked(api.bootstrap).mockResolvedValue(projects)
      vi.mocked(api.saveWorkspaceSelection)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(last.promise)
      await act(async () => root.render(<App />))
      await act(async () => element('.project-item[aria-label^="B,"]').click())
      await act(async () => element('.project-item[aria-label^="C,"]').click())
      expect(element(".project-item.is-active").textContent).toContain("C")
      // C cannot commit before A; B is superseded while queued.
      expect(api.saveWorkspaceSelection).toHaveBeenCalledTimes(1)
      await act(async () => {
        if (outcome === "success") first.resolve(undefined)
        else first.reject(new Error("Obsolete selection save failure"))
      })
      expect(api.saveWorkspaceSelection).toHaveBeenCalledTimes(2)
      expect(api.saveWorkspaceSelection).toHaveBeenLastCalledWith("C:/fixture/C")
      expect(container.textContent).not.toContain("Obsolete selection save failure")
      await act(async () => last.resolve(undefined))
      expect(element(".project-item.is-active").textContent).toContain("C")
      expect(container.textContent).toContain("C session")
      expect(api.bootstrap).toHaveBeenCalledTimes(1)
    },
  )

  it("keeps the latest requested workspace while reconciling an older successful mutation", async () => {
    const first = deferred<BootstrapPayload>()
    const second = deferred<BootstrapPayload>()
    const reconcile = deferred<BootstrapPayload>()
    vi.mocked(api.addWorkspace)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    await act(async () => root.render(<App />))
    vi.mocked(api.bootstrap).mockReturnValue(reconcile.promise)
    act(() => {
      requestWorkspace("A")
      requestWorkspace("B")
    })
    await act(async () => second.resolve(workspacePayload("B")))
    expect(element(".project-item.is-active").textContent).toContain("B")
    await act(async () => first.resolve(workspacePayload("A")))
    expect(element(".project-item.is-active").textContent).toContain("B")
    expect(container.textContent).toContain("B session")
    await act(async () => reconcile.resolve(workspacePayload("A", "B")))
    expect(
      [...container.querySelectorAll(".project-item strong")].map((item) => item.textContent),
    ).toEqual(["A", "B"])
    expect(element(".project-item.is-active").textContent).toContain("B")
    expect(container.textContent).toContain("B session")
    await act(async () => element<HTMLButtonElement>(".project-item").click())
    expect(container.textContent).toContain("A session")
  })

  it("does not switch to an older request while the latest one is still pending", async () => {
    const first = deferred<BootstrapPayload>()
    const second = deferred<BootstrapPayload>()
    vi.mocked(api.addWorkspace)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    await act(async () => root.render(<App />))
    act(() => {
      requestWorkspace("A")
      requestWorkspace("B")
    })
    await act(async () => first.resolve(workspacePayload("A")))
    expect(element(".project-item.is-active").textContent).toContain("Fixture")
    vi.mocked(api.bootstrap).mockResolvedValue(workspacePayload("A", "B"))
    await act(async () => second.resolve(workspacePayload("A", "B")))
    expect(element(".project-item.is-active").textContent).toContain("B")
  })

  it("suppresses superseded workspace errors but reports failure of the latest request", async () => {
    const first = deferred<BootstrapPayload>()
    const second = deferred<BootstrapPayload>()
    vi.mocked(api.addWorkspace)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    await act(async () => root.render(<App />))
    act(() => {
      requestWorkspace("A")
      requestWorkspace("B")
    })
    await act(async () => first.reject(new Error("Obsolete workspace failure")))
    expect(container.textContent).not.toContain("Obsolete workspace failure")
    await act(async () => second.reject(new Error("Current workspace failure")))
    expect(container.textContent).toContain("Current workspace failure")
    expect(element(".project-item.is-active").textContent).toContain("Fixture")
  })

  it.each(["success", "failure"] as const)(
    "ignores an initial bootstrap %s arriving after a workspace switch",
    async (outcome) => {
      const initial = deferred<BootstrapPayload>()
      vi.mocked(api.bootstrap).mockReturnValue(initial.promise)
      vi.mocked(api.addWorkspace).mockResolvedValue(workspacePayload("B"))
      await act(async () => root.render(<App />))
      await act(async () => requestWorkspace("B"))
      await act(async () => {
        if (outcome === "success") initial.resolve(bootstrap)
        else initial.reject(new Error("Obsolete bootstrap failure"))
      })
      expect(element(".project-item.is-active").textContent).toContain("B")
      expect(container.textContent).toContain("B session")
      expect(container.textContent).not.toContain("Obsolete bootstrap failure")
    },
  )

  it("loads committed workspaces when a startup switch fails after superseding the initial bootstrap", async () => {
    const initial = deferred<BootstrapPayload>()
    const addition = deferred<BootstrapPayload>()
    vi.mocked(api.bootstrap).mockReturnValueOnce(initial.promise).mockResolvedValue(bootstrap)
    vi.mocked(api.addWorkspace).mockReturnValue(addition.promise)
    await act(async () => root.render(<App />))
    act(() => requestWorkspace("Missing"))
    await act(async () => initial.resolve(bootstrap))
    await act(async () => addition.reject(new Error("Workspace no longer exists")))
    expect(element(".project-item.is-active").textContent).toContain("Fixture")
    expect(container.textContent).toContain("Workspace no longer exists")
  })

  it("does not reconcile or report workspace requests after unmount", async () => {
    const first = deferred<BootstrapPayload>()
    const second = deferred<BootstrapPayload>()
    vi.mocked(api.addWorkspace)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    await act(async () => root.render(<App />))
    act(() => {
      requestWorkspace("A")
      requestWorkspace("B")
    })
    act(() => root.render(null))
    const bootstrapCalls = vi.mocked(api.bootstrap).mock.calls.length
    await act(async () => {
      first.resolve(workspacePayload("A"))
      second.reject(new Error("Unmounted workspace failure"))
    })
    expect(api.bootstrap).toHaveBeenCalledTimes(bootstrapCalls)
    await act(async () => root.render(<App />))
    expect(element(".project-item.is-active").textContent).toContain("Fixture")
    expect(container.textContent).not.toContain("Unmounted workspace failure")
  })

  it.each(["session", "utility"] as const)(
    "guards a successful %s spawn before React publishes its tab",
    async (kind) => {
      const launch = deferred<TerminalStarted>()
      vi.mocked(api.startTerminal).mockReturnValue(launch.promise)
      if (kind === "utility") {
        vi.mocked(api.checkOmpUpdate).mockResolvedValue({
          hasUpdate: true,
          currentVersion: "18.1.19",
          latestVersion: "99.0.0",
          message: "Fixture runtime update",
        })
      }
      await act(async () => root.render(<App />))
      await act(async () => {
        element(kind === "session" ? ".new-session-button" : ".update-pill").click()
        launch.resolve(started)
        // Drain spawn continuations while act still holds the React commit.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        expect(container.querySelector(".terminal-tab")).toBeNull()
        // Exercise the real updater action, not the disabled button's separate UI guard.
        await updaterAction.install!()
      })
      expect(installClientUpdate).not.toHaveBeenCalled()
      expect(confirm).not.toHaveBeenCalled()

      // Publication releases the transient gate, but the live process still requires consent.
      const confirmation = deferred<boolean>()
      vi.mocked(confirm).mockReturnValue(confirmation.promise)
      await act(async () => installButton().click())
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(installClientUpdate).not.toHaveBeenCalled()
      await act(async () => confirmation.resolve(false))
      expect(installClientUpdate).not.toHaveBeenCalled()
    },
  )

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
