/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App from "./App"
import * as api from "./api"
import { confirm } from "@tauri-apps/plugin-dialog"
import type {
  BootstrapPayload,
  OmpConfigSnapshot,
  TerminalStarted,
  TerminalTab,
  PtyExitEvent,
} from "./types"
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  bootstrap: vi.fn(),
  saveWorkspaceSelection: vi.fn(),
  loadOmpConfig: vi.fn(),
  startTerminal: vi.fn(),
  switchTerminal: vi.fn(),
  checkOmpUpdate: vi.fn(),
  sampleResourceHealth: vi.fn().mockRejectedValue(new Error("Synthetic sample unavailable")),
  desktopUpdateStatus: vi.fn().mockResolvedValue({
    policyState: "notReady",
    includePrereleases: null,
    revision: "0",
    checking: false,
    installState: "idle",
    update: null,
    installed: null,
  }),
  desktopUpdateCheck: vi.fn().mockResolvedValue({
    policyState: "notReady",
    includePrereleases: null,
    revision: "0",
    checking: false,
    installState: "idle",
    update: null,
    installed: null,
  }),
}))
vi.mock("./clientUpdater", () => ({
  installClientUpdate: vi.fn(),
}))
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("0.9.10") }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }))
vi.mock("./TerminalView", () => ({
  TerminalView: ({ tab, onExit }: { tab: TerminalTab; onExit: (event: PtyExitEvent) => void }) => (
    <div data-terminal-id={tab.id}>
      <button
        data-success
        onClick={() => onExit({ terminalId: tab.id, exitCode: 0, success: true, error: null })}
      >
        Synthetic success
      </button>
      <button
        data-failure
        onClick={() => onExit({ terminalId: tab.id, exitCode: 1, success: false, error: null })}
      >
        Synthetic failure
      </button>
    </div>
  ),
}))
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
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
    desktopTheme: "dark",
    desktopUpdatePrereleases: false,
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

describe("successful terminal tab cleanup", () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMock.mockResolvedValue(undefined)
    localStorage.clear()
    vi.mocked(api.bootstrap).mockResolvedValue({
      ...bootstrap,
      settings: { ...bootstrap.settings, language: "en" },
      runtime: { ...bootstrap.runtime, language: "en" },
    })
    vi.mocked(api.saveWorkspaceSelection).mockResolvedValue(undefined)
    vi.mocked(api.loadOmpConfig).mockResolvedValue(config("Initial"))
    vi.mocked(api.switchTerminal).mockReset()
    vi.mocked(api.checkOmpUpdate).mockResolvedValue({
      hasUpdate: false,
      currentVersion: "18.1.19",
      latestVersion: null,
      message: "",
    })
    let sequence = 0
    vi.mocked(api.startTerminal).mockImplementation(
      async () =>
        ({
          terminalId: `terminal-${++sequence}`,
          processId: sequence,
          cwd: "C:/fixture/project",
        }) satisfies TerminalStarted,
    )
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })
  async function launch(count: number) {
    await act(async () => root.render(<App />))
    for (let index = 0; index < count; index++) {
      const button = container.querySelector<HTMLButtonElement>(
        index === 0 ? ".main-stage .button.primary" : ".new-tab-button",
      )!
      await act(async () => button.click())
    }
  }
  async function exit(id: number, success: boolean) {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-terminal-id="terminal-${id}"] [data-${success ? "success" : "failure"}]`,
    )!
    await act(async () => button.click())
  }
  function cleanup() {
    return container.querySelector<HTMLButtonElement>(".close-successful-tabs")!
  }
  function terminalIds() {
    return Array.from(
      container.querySelectorAll<HTMLElement>("[data-terminal-id]"),
      (node) => node.dataset.terminalId,
    )
  }
  it.each(["successful exit", "failed exit", "closed tab", "recovery first"] as const)(
    "preserves %s when a model switch reports recovery",
    async (scenario) => {
      const initial = config("Initial")
      const alternate = config("Alternate").models[0]
      vi.mocked(api.loadOmpConfig).mockResolvedValue({
        ...initial,
        models: [...initial.models, alternate],
      })
      let rejectSwitch!: (error: unknown) => void
      vi.mocked(api.switchTerminal).mockReturnValue(
        new Promise((_, reject) => {
          rejectSwitch = reject
        }),
      )
      await launch(1)
      await act(async () => {
        const select = container.querySelector<HTMLSelectElement>(".session-model-select")!
        select.value = alternate.selector
        select.dispatchEvent(new Event("change", { bubbles: true }))
      })
      expect(api.switchTerminal).toHaveBeenCalledTimes(1)
      expect(container.querySelector<HTMLSelectElement>(".session-model-select")!.disabled).toBe(
        true,
      )
      const reject = () =>
        rejectSwitch({
          code: "terminal_switch_input_recovery",
          message: "Synthetic preserved input",
          recovery: {
            terminalId: "terminal-1",
            generation: 3,
            token: "synthetic-recovery-token",
            byteCount: 25,
            state: "pending",
          },
        })
      if (scenario === "recovery first") {
        await act(async () => reject())
        const buttons = container.querySelectorAll<HTMLButtonElement>(
          ".switch-input-recovery-actions button",
        )
        expect(buttons).toHaveLength(2)
        expect(buttons[0].disabled).toBe(false)
        expect(buttons[1].disabled).toBe(false)
        expect(cleanup().disabled).toBe(true)
      }
      await exit(1, scenario !== "failed exit")
      if (scenario === "closed tab") {
        await act(async () => cleanup().click())
        expect(terminalIds()).toEqual([])
      }
      if (scenario !== "recovery first") await act(async () => reject())
      expect(container.querySelector(".switch-input-recovery")).toBeNull()
      if (scenario === "closed tab") {
        expect(terminalIds()).toEqual([])
      } else if (scenario === "failed exit") {
        expect(cleanup().disabled).toBe(true)
        expect(terminalIds()).toEqual(["terminal-1"])
      } else {
        expect(cleanup().disabled).toBe(false)
        expect(cleanup().textContent).toBe("1")
        await act(async () => cleanup().click())
        expect(terminalIds()).toEqual([])
      }
      expect(api.switchTerminal).toHaveBeenCalledTimes(1)
      expect(api.startTerminal).toHaveBeenCalledTimes(1)
      expect(confirm).not.toHaveBeenCalled()
    },
  )
  it("closes successful exits together while retaining running and failed terminals", async () => {
    await launch(4)
    expect(cleanup().disabled).toBe(true)
    await exit(1, true)
    await exit(2, false)
    await exit(4, true)
    expect(cleanup().textContent).toBe("2")
    expect(cleanup().getAttribute("aria-label")).toBe("Close successfully exited tabs (2)")
    expect(cleanup().title).toContain("closed terminal output is discarded")
    invokeMock.mockClear()
    await act(async () => {
      cleanup().focus()
      cleanup().click()
      cleanup().click()
    })
    expect(terminalIds()).toEqual(["terminal-2", "terminal-3"])
    expect(
      Array.from(container.querySelectorAll(".terminal-tab.is-active .terminal-tab-label")),
    ).toHaveLength(1)
    expect(
      invokeMock.mock.calls
        .filter(([command]) => command === "close_terminal")
        .map(([command, args]) => [command, args]),
    ).toEqual([
      ["close_terminal", { terminalId: "terminal-1" }],
      ["close_terminal", { terminalId: "terminal-4" }],
    ])
    expect(invokeMock.mock.calls.every(([command]) => command === "close_terminal")).toBe(true)
    expect(
      container.querySelector<HTMLElement>(".terminal-pane.is-active [data-terminal-id]")?.dataset
        .terminalId,
    ).toBe("terminal-3")
    expect(confirm).not.toHaveBeenCalled()
    expect(api.startTerminal).toHaveBeenCalledTimes(4)
    expect(document.activeElement).toBe(container.querySelector(".terminal-tab.is-active > button"))
    expect(cleanup().disabled).toBe(true)
  })
  it("preserves the active surviving tab and does not steal a newer focus", async () => {
    await launch(3)
    await exit(1, true)
    const headers = container.querySelectorAll<HTMLButtonElement>(
      ".terminal-tab > button:first-child",
    )
    await act(async () => headers[1]!.click())
    const outside = document.createElement("input")
    document.body.append(outside)
    await act(async () => {
      cleanup().focus()
      cleanup().click()
      outside.focus()
    })
    expect(terminalIds()).toEqual(["terminal-2", "terminal-3"])
    expect(
      container.querySelector<HTMLElement>(".terminal-pane.is-active [data-terminal-id]")?.dataset
        .terminalId,
    ).toBe("terminal-2")
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
  it("reports cleanup failure without closing or restarting a surviving terminal", async () => {
    await launch(2)
    await exit(1, true)
    invokeMock.mockRejectedValueOnce(new Error("Synthetic close rejected"))
    await act(async () => cleanup().click())
    expect(terminalIds()).toEqual(["terminal-2"])
    expect(document.body.textContent).toContain("Synthetic close rejected")
    expect(api.startTerminal).toHaveBeenCalledTimes(2)
  })
  it("returns to Home when every tab has succeeded and can clean a later new tab", async () => {
    await launch(2)
    await exit(1, true)
    await exit(2, true)
    await act(async () => {
      cleanup().focus()
      cleanup().click()
    })
    expect(terminalIds()).toEqual([])
    expect(document.activeElement).toBe(container.querySelector(".main-stage .button.primary"))
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".main-stage .button.primary")!.click(),
    )
    await exit(3, true)
    await act(async () => cleanup().click())
    expect(terminalIds()).toEqual([])
  })
})
