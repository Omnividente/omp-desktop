/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App from "./App"
import * as api from "./api"
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification"
import { t, type Lang } from "./i18n"
import type {
  BootstrapPayload,
  OmpConfigSnapshot,
  TerminalStarted,
  TerminalTab,
  PtyExitEvent,
} from "./types"
const { invokeMock, terminalExits } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  terminalExits: new Map<string, (event: PtyExitEvent) => void>(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  bootstrap: vi.fn(),
  saveWorkspaceSelection: vi.fn(),
  loadOmpConfig: vi.fn(),
  startTerminal: vi.fn(),
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
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}))
vi.mock("./TerminalView", () => ({
  TerminalView: ({ tab, onExit }: { tab: TerminalTab; onExit: (event: PtyExitEvent) => void }) => {
    terminalExits.set(tab.id, onExit)
    return <div data-terminal-id={tab.id} data-terminal-status={tab.status} />
  },
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

describe("terminal completion notification payloads", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    terminalExits.clear()
    localStorage.clear()
    invokeMock.mockResolvedValue(undefined)
    vi.mocked(api.saveWorkspaceSelection).mockResolvedValue(undefined)
    vi.mocked(api.loadOmpConfig).mockResolvedValue(config("Initial"))
    vi.mocked(api.checkOmpUpdate).mockResolvedValue({
      hasUpdate: false,
      currentVersion: "18.1.19",
      latestVersion: null,
      message: "",
    })
    vi.mocked(api.startTerminal).mockResolvedValue({
      terminalId: "terminal-notification",
      processId: 101,
      cwd: bootstrap.workspaces[0].path,
    } satisfies TerminalStarted)
    vi.mocked(isPermissionGranted).mockResolvedValue(true)
    vi.mocked(requestPermission).mockResolvedValue("granted")
    vi.mocked(sendNotification).mockImplementation(() => undefined)
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  async function launch(language: Lang, label: string) {
    vi.mocked(api.bootstrap).mockResolvedValue({
      ...bootstrap,
      settings: { ...bootstrap.settings, language },
      runtime: { ...bootstrap.runtime, language },
      sessions: [{ ...bootstrap.sessions[0], title: label }],
    })
    await act(async () => root.render(<App />))
    const resume = container.querySelector<HTMLButtonElement>(".recent-resume")
    expect(resume).not.toBeNull()
    await act(async () => resume!.click())
    expect(api.startTerminal).toHaveBeenCalledTimes(1)
    expect(terminalExits.has("terminal-notification")).toBe(true)
  }

  async function exit(success: boolean, error: string | null = null, exitCode: number | null = 0) {
    await act(async () =>
      terminalExits.get("terminal-notification")!({
        terminalId: "terminal-notification",
        success,
        error,
        exitCode,
      }),
    )
  }

  describe.each(["en", "ru"] as const)("%s payload", (language) => {
    it.each(["$$", "$&", "$`", "$'", "Literal {code} and {title}", "東京 😀"])(
      "preserves a successful session title %j literally",
      async (label) => {
        await launch(language, label)
        await exit(true)
        expect(sendNotification).toHaveBeenCalledExactlyOnceWith({
          title: t(language, "notificationSuccessTitle"),
          body:
            language === "en"
              ? `Session “${label}” completed successfully.`
              : `Сессия «${label}» успешно завершена.`,
        })
        expect(requestPermission).not.toHaveBeenCalled()
      },
    )

    it.each(["$$", "$&", "$`", "$'", "Literal {code} and {title}", "東京 😀"])(
      "preserves failure text %j without reinterpreting the title",
      async (error) => {
        const label = "Session $& {code} {title}"
        await launch(language, label)
        await exit(false, error, 7)
        expect(sendNotification).toHaveBeenCalledExactlyOnceWith({
          title: t(language, "notificationFailureTitle"),
          body:
            language === "en"
              ? `Session “${label}” exited with code ${error}.`
              : `Сессия «${label}» завершена с кодом ${error}.`,
        })
      },
    )

    it.each([7, null])("retains the fallback exit code %s", async (exitCode) => {
      await launch(language, "Ordinary session")
      await exit(false, null, exitCode)
      const code = String(exitCode ?? "?")
      expect(sendNotification).toHaveBeenCalledExactlyOnceWith({
        title: t(language, "notificationFailureTitle"),
        body:
          language === "en"
            ? `Session “Ordinary session” exited with code ${code}.`
            : `Сессия «Ordinary session» завершена с кодом ${code}.`,
      })
    })
  })

  it("requests missing permission once and preserves duplicate-exit suppression", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false)
    await launch("en", "$& {code}")
    await exit(true)
    await exit(true)
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(sendNotification).toHaveBeenCalledExactlyOnceWith({
      title: "Agent finished",
      body: "Session “$& {code}” completed successfully.",
    })
  })

  it("does not send after permission is denied", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false)
    vi.mocked(requestPermission).mockResolvedValue("denied")
    await launch("en", "Ordinary session")
    await exit(false, "Synthetic failure", 7)
    expect(sendNotification).not.toHaveBeenCalled()
    expect(container.querySelector('[data-terminal-status="exited"]')).not.toBeNull()
  })

  it("does not notify while the completed tab is visible and focused", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    vi.mocked(document.hasFocus).mockReturnValue(true)
    await launch("en", "Ordinary session")
    await exit(true)
    expect(isPermissionGranted).not.toHaveBeenCalled()
    expect(sendNotification).not.toHaveBeenCalled()
  })
})
