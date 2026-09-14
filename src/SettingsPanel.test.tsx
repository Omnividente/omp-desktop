/** @vitest-environment jsdom */

import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { SettingsPanel } from "./SettingsPanel"
import type { AppSettings, OmpConfigSnapshot, RuntimeInfo, SettingsSavePayload } from "./types"
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
  workspaceNames: {},
  hiddenWorkspaces: [],
  sessionTitlePins: {},
  primaryProviderPins: [],
  proxyProviders: [],
  railMode: "expanded",
  language: "ru",
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

describe("SettingsPanel Save state", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    loadOmpConfigMock.mockReset()
    refreshOmpConfigMock.mockReset()
    saveSettingsBundleMock.mockReset()
    confirmMock.mockReset()
    confirmMock.mockResolvedValue(true)
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

  it("keeps a failed provider draft and clears its key only after a successful retry", async () => {
    const failureReason = "Provider ID is already in use"
    saveSettingsBundleMock
      .mockRejectedValueOnce({ code: "settings_save_failed", details: failureReason })
      .mockResolvedValueOnce({
        bootstrap: { settings, runtime },
        ompConfig: {
          ...ompConfig,
          credentials: [
            ...ompConfig.credentials,
            { ...ompConfig.credentials[0], provider: "private-gateway" },
          ],
        },
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
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-providers")?.click())
    const inputs = container.querySelectorAll<HTMLInputElement>(".custom-provider-form input")
    const values = ["private-gateway", "https://gateway.example.test/v1", "secret-value"]
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!
      inputs.forEach((input, index) => {
        setValue.call(input, values[index])
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
    })
    const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
    await act(async () => save.click())
    expect(container.querySelector("[role='alert']")?.textContent).toContain(failureReason)
    expect(Array.from(inputs, (input) => input.value)).toEqual(values)
    expect(save.disabled).toBe(false)
    expect(container.textContent).not.toContain(values[2])
    expect(container.textContent).not.toContain("OMP_DESKTOP_PROVIDER_")

    await act(async () => save.click())
    expect(container.querySelector(".settings-save-error")).toBeNull()
    expect(Array.from(inputs, (input) => input.value)).toEqual(["", "", ""])
    expect(
      [...container.querySelectorAll(".provider-credential-main strong")].map(
        (node) => node.textContent,
      ),
    ).toContain("private-gateway")
    expect(save.disabled).toBe(true)
  })
})

describe("SettingsPanel configuration generations", () => {
  let container: HTMLDivElement
  let root: Root
  let onError: Mock<(message: string) => void>
  let onSaved: Mock<(result: SettingsSavePayload) => void>

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }

  function saveResult(
    snapshot: OmpConfigSnapshot | null,
    nextRuntime = runtime,
    nextSettings = settings,
  ): SettingsSavePayload {
    return {
      bootstrap: {
        settings: nextSettings,
        runtime: nextRuntime,
        workspaces: [],
        sessions: [],
        sessionWarnings: [],
      },
      ompConfig: snapshot,
    }
  }

  async function renderPanel(nextRuntime = runtime, nextSettings = settings, strict = false) {
    await act(async () => {
      const panel = (
        <SettingsPanel
          onClose={() => root.render(null)}
          onError={onError}
          onSaved={onSaved}
          runtime={nextRuntime}
          settings={nextSettings}
        />
      )
      root.render(strict ? <StrictMode>{panel}</StrictMode> : panel)
    })
  }

  function changeExecutable(value: string) {
    act(() => {
      const input = container.querySelector<HTMLInputElement>("#omp-executable")!
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
        input,
        value,
      )
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  function expectAdvisorDraft(enabled: boolean) {
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-behavior")!.click())
    expect(container.querySelector<HTMLInputElement>(".settings-options input")!.checked).toBe(
      enabled,
    )
  }

  beforeEach(() => {
    loadOmpConfigMock.mockReset().mockResolvedValue(ompConfig)
    refreshOmpConfigMock.mockReset().mockResolvedValue(ompConfig)
    saveSettingsBundleMock.mockReset()
    onError = vi.fn()
    onSaved = vi.fn()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it.each(["resolve", "reject"] as const)(
    "keeps the post-save draft when the pre-save initial load later %ss",
    async (settlement) => {
      const initial = deferred<OmpConfigSnapshot>()
      const fresh = deferred<OmpConfigSnapshot>()
      loadOmpConfigMock.mockReturnValueOnce(initial.promise).mockReturnValueOnce(fresh.promise)
      const nextRuntime = { ...runtime, ompExecutable: "new-omp.exe" }
      const nextSettings = { ...settings, ompExecutable: "new-omp.exe" }
      const result = saveResult(null, nextRuntime, nextSettings)
      saveSettingsBundleMock.mockResolvedValue(result)
      await renderPanel()
      changeExecutable("new-omp.exe")
      const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
      expect(save.disabled).toBe(false)
      await act(async () => save.click())
      expect(saveSettingsBundleMock).toHaveBeenCalledWith(
        expect.objectContaining({ ompConfig: null }),
      )
      expect(onSaved).toHaveBeenCalledWith(result)
      await renderPanel(nextRuntime, nextSettings)
      await act(async () => fresh.resolve({ ...ompConfig, advisorEnabled: true }))
      expectAdvisorDraft(true)
      expect(save.disabled).toBe(true)

      await act(async () => {
        if (settlement === "resolve") initial.resolve(ompConfig)
        else initial.reject(new Error("obsolete initial load"))
      })
      expectAdvisorDraft(true)
      expect(save.disabled).toBe(true)
      expect(onError).not.toHaveBeenCalled()
      expect(container.querySelector(".settings-loading-banner")).toBeNull()
    },
  )

  it("reloads an initial config cancelled by a failed save without losing the Desktop draft", async () => {
    const initial = deferred<OmpConfigSnapshot>()
    const replacement = deferred<OmpConfigSnapshot>()
    loadOmpConfigMock.mockReturnValueOnce(initial.promise).mockReturnValueOnce(replacement.promise)
    saveSettingsBundleMock.mockRejectedValue(new Error("Fixture save failed"))
    await renderPanel()
    changeExecutable("draft-omp.exe")
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(container.querySelector(".settings-save-error")).not.toBeNull()
    expect(container.querySelector(".settings-loading-banner")).not.toBeNull()
    await act(async () => replacement.resolve({ ...ompConfig, advisorEnabled: true }))
    await act(async () => initial.resolve(ompConfig))
    expectAdvisorDraft(true)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-general")!.click())
    expect(container.querySelector<HTMLInputElement>("#omp-executable")!.value).toBe(
      "draft-omp.exe",
    )
    expect(container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
      false,
    )
    expect(container.querySelector(".settings-save-error")).not.toBeNull()
    expect(container.querySelector(".settings-loading-banner")).toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("does not replace a newer runtime load when an earlier save fails", async () => {
    const initial = deferred<OmpConfigSnapshot>()
    const replacement = deferred<OmpConfigSnapshot>()
    const save = deferred<SettingsSavePayload>()
    loadOmpConfigMock.mockReturnValueOnce(initial.promise).mockReturnValueOnce(replacement.promise)
    saveSettingsBundleMock.mockReturnValue(save.promise)
    await renderPanel()
    changeExecutable("draft-omp.exe")
    act(() => container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click())
    await renderPanel({ ...runtime, ompVersion: "omp/19.0.0" })
    await act(async () => save.reject(new Error("Earlier save failed")))
    await act(async () => replacement.resolve({ ...ompConfig, advisorEnabled: true }))
    await act(async () => initial.resolve(ompConfig))
    expectAdvisorDraft(true)
    expect(container.querySelector(".settings-loading-banner")).toBeNull()
    expect(container.querySelector(".settings-save-error")).not.toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it.each(["resolve", "reject"] as const)(
    "keeps a returned save snapshot when a pending refresh later %ss",
    async (settlement) => {
      const refresh = deferred<OmpConfigSnapshot>()
      refreshOmpConfigMock.mockReturnValueOnce(refresh.promise)
      const result = saveResult({ ...ompConfig, advisorEnabled: true })
      saveSettingsBundleMock.mockResolvedValue(result)
      await renderPanel()
      expectAdvisorDraft(false)
      act(() => container.querySelector<HTMLInputElement>(".settings-options input")!.click())
      act(() => container.querySelector<HTMLButtonElement>(".runtime-card button")!.click())
      await act(async () =>
        container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
      )
      expect(onSaved).toHaveBeenCalledWith(result)
      expectAdvisorDraft(true)
      expect(
        container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled,
      ).toBe(true)

      await act(async () => {
        if (settlement === "resolve") refresh.resolve(ompConfig)
        else refresh.reject(new Error("obsolete refresh"))
      })
      expectAdvisorDraft(true)
      expect(
        container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled,
      ).toBe(true)
      expect(onError).not.toHaveBeenCalled()
    },
  )

  it.each(["initial", "refresh"] as const)(
    "ignores a rejected %s request after closing the panel",
    async (request) => {
      const pending = deferred<OmpConfigSnapshot>()
      if (request === "initial") loadOmpConfigMock.mockReturnValueOnce(pending.promise)
      else refreshOmpConfigMock.mockReturnValueOnce(pending.promise)
      await renderPanel()
      if (request === "refresh") {
        act(() => container.querySelector<HTMLButtonElement>(".runtime-card button")!.click())
      }
      act(() => container.querySelector<HTMLButtonElement>(".settings-header button")!.click())
      await act(async () => pending.reject(new Error("request completed after close")))
      expect(container.querySelector('[role="dialog"]')).toBeNull()
      expect(onError).not.toHaveBeenCalled()
    },
  )

  it.each(["resolve", "reject"] as const)(
    "notifies the parent only of a successful save after closing (%s)",
    async (settlement) => {
      const pending = deferred<SettingsSavePayload>()
      saveSettingsBundleMock.mockReturnValueOnce(pending.promise)
      await renderPanel()
      changeExecutable("saved-omp.exe")
      act(() => container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click())
      act(() => container.querySelector<HTMLButtonElement>(".settings-header button")!.click())
      const result = saveResult(null)
      await act(async () => {
        if (settlement === "resolve") pending.resolve(result)
        else pending.reject(new Error("save failed after close"))
      })
      expect(container.querySelector('[role="dialog"]')).toBeNull()
      if (settlement === "resolve") expect(onSaved).toHaveBeenCalledWith(result)
      else expect(onSaved).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      expect(loadOmpConfigMock).toHaveBeenCalledTimes(1)
    },
  )

  it("loads the returned runtime when Save makes OMP available", async () => {
    const unavailable = { ...runtime, ompAvailable: false, ompVersion: null }
    const fresh = deferred<OmpConfigSnapshot>()
    loadOmpConfigMock.mockReturnValueOnce(fresh.promise)
    const nextSettings = { ...settings, ompExecutable: "omp.exe" }
    const result = saveResult(null, runtime, nextSettings)
    saveSettingsBundleMock.mockResolvedValue(result)
    await renderPanel(unavailable)
    changeExecutable("omp.exe")
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(container.querySelector(".settings-loading-banner")).not.toBeNull()
    await renderPanel(runtime, nextSettings)
    await act(async () => fresh.resolve({ ...ompConfig, advisorEnabled: true }))
    expectAdvisorDraft(true)
    expect(container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
      true,
    )
  })

  it("clears the old draft without reading when Save removes the runtime", async () => {
    loadOmpConfigMock.mockResolvedValue({ ...ompConfig, advisorEnabled: true })
    const refresh = deferred<OmpConfigSnapshot>()
    refreshOmpConfigMock.mockReturnValueOnce(refresh.promise)
    const unavailable = { ...runtime, ompAvailable: false, ompVersion: null }
    const nextSettings = { ...settings, ompExecutable: "missing-omp.exe" }
    saveSettingsBundleMock.mockResolvedValue(saveResult(null, unavailable, nextSettings))
    await renderPanel()
    changeExecutable("missing-omp.exe")
    act(() => container.querySelector<HTMLButtonElement>(".runtime-card button")!.click())
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    await renderPanel(unavailable, nextSettings)
    await act(async () => refresh.resolve({ ...ompConfig, advisorEnabled: true }))
    expectAdvisorDraft(false)
    expect(container.querySelector(".runtime-card button")).toBeNull()
    expect(container.querySelector(".settings-loading-banner")).toBeNull()
    expect(loadOmpConfigMock).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it.each([
    { ...runtime, ompExecutable: "replacement-omp.exe" },
    { ...runtime, ompVersion: "omp/19.0.0" },
  ])("discards the old runtime request on a runtime identity change: %j", async (nextRuntime) => {
    const initial = deferred<OmpConfigSnapshot>()
    const fresh = deferred<OmpConfigSnapshot>()
    loadOmpConfigMock.mockReturnValueOnce(initial.promise).mockReturnValueOnce(fresh.promise)
    await renderPanel()
    await renderPanel(nextRuntime)
    await act(async () => fresh.resolve({ ...ompConfig, advisorEnabled: true }))
    await act(async () => initial.resolve(ompConfig))
    expectAdvisorDraft(true)
    expect(onError).not.toHaveBeenCalled()
  })

  it("ignores the StrictMode cleanup request without hiding the replayed load", async () => {
    const initial = deferred<OmpConfigSnapshot>()
    const replayed = deferred<OmpConfigSnapshot>()
    loadOmpConfigMock.mockReturnValueOnce(initial.promise).mockReturnValueOnce(replayed.promise)
    await renderPanel(runtime, settings, true)
    await act(async () => initial.reject(new Error("discarded StrictMode request")))
    expect(container.querySelector(".settings-loading-banner")).not.toBeNull()
    expect(onError).not.toHaveBeenCalled()
    await act(async () => replayed.resolve({ ...ompConfig, advisorEnabled: true }))
    expectAdvisorDraft(true)
    expect(container.querySelector(".settings-loading-banner")).toBeNull()
  })
})

describe("SettingsPanel keyboard lifecycle", () => {
  let container: HTMLDivElement
  let trigger: HTMLButtonElement
  let root: Root

  beforeEach(() => {
    loadOmpConfigMock.mockReset()
    loadOmpConfigMock.mockResolvedValue(ompConfig)
    container = document.createElement("div")
    trigger = document.createElement("button")
    document.body.append(trigger, container)
    trigger.focus()
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    trigger.remove()
  })

  async function renderPanel(onClose = vi.fn()) {
    await act(async () => {
      root.render(
        <StrictMode>
          <SettingsPanel
            onClose={onClose}
            onError={vi.fn()}
            onSaved={vi.fn()}
            runtime={runtime}
            settings={settings}
          />
        </StrictMode>,
      )
    })
  }

  function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init })
    act(() => target.dispatchEvent(event))
    return event
  }

  it("contains initial focus and wraps Tab around enabled, visible controls", async () => {
    await renderPanel()
    const panel = container.querySelector<HTMLElement>('[role="dialog"]')!
    const close = container.querySelector<HTMLButtonElement>(".settings-header button")!
    const cancel = container.querySelector<HTMLButtonElement>(".settings-actions .secondary")!
    const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(save.disabled).toBe(true)

    close.focus()
    press(close, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(cancel)
    press(cancel, "Tab")
    expect(document.activeElement).toBe(close)

    container.querySelector<HTMLElement>(".settings-header")!.hidden = true
    cancel.focus()
    press(cancel, "Tab")
    expect(document.activeElement).toBe(container.querySelector(".runtime-card button"))
    press(document.activeElement as HTMLElement, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(cancel)
  })

  it("repairs removed section focus and includes newly enabled controls in the loop", async () => {
    await renderPanel()
    const panel = container.querySelector<HTMLElement>('[role="dialog"]')!
    const oldControl = container.querySelector<HTMLInputElement>(".settings-fields input")!
    oldControl.focus()
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
    expect(oldControl.isConnected).toBe(false)
    expect(panel.contains(document.activeElement)).toBe(true)

    act(() => container.querySelector<HTMLInputElement>(".provider-proxy-toggle input")!.click())
    const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
    const close = container.querySelector<HTMLButtonElement>(".settings-header button")!
    expect(save.disabled).toBe(false)
    close.focus()
    press(close, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(save)
    press(save, "Tab")
    expect(document.activeElement).toBe(close)
  })

  it("uses the current close callback and restores a live trigger after StrictMode cleanup", async () => {
    const previousClose = vi.fn()
    await renderPanel(previousClose)
    const control = container.querySelector<HTMLInputElement>(".settings-fields input")!
    control.focus()
    const currentClose = vi.fn(() => root.render(null))
    await renderPanel(currentClose)
    expect(document.activeElement).toBe(control)
    press(control, "Escape")
    expect(previousClose).not.toHaveBeenCalled()
    expect(currentClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(trigger)

    await renderPanel(currentClose)
    trigger.remove()
    press(container.querySelector<HTMLElement>('[role="dialog"]')!, "Escape")
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it("lets the nested model picker consume Escape without closing settings", async () => {
    loadOmpConfigMock.mockResolvedValue({
      ...ompConfig,
      fallbackChains: { default: ["provider/model"] },
    })
    const onClose = vi.fn()
    await renderPanel(onClose)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    const picker = container.querySelector<HTMLButtonElement>(".model-picker-trigger")!
    act(() => picker.click())
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!
    listbox.focus()
    press(listbox, "Escape")
    expect(onClose).not.toHaveBeenCalled()
    expect(picker.getAttribute("aria-expanded")).toBe("false")
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    expect(container.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
    picker.focus()
    press(picker, "Escape")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("leaves select navigation, composition and stopped child events to their controls", async () => {
    const onClose = vi.fn()
    await renderPanel(onClose)
    const select = container.querySelector<HTMLSelectElement>("select")!
    select.focus()
    expect(press(select, "ArrowDown").defaultPrevented).toBe(false)
    expect(press(select, "Escape").defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(select)

    const input = container.querySelector<HTMLInputElement>(".settings-fields input")!
    input.focus()
    expect(press(input, "Escape", { isComposing: true }).defaultPrevented).toBe(false)
    expect(press(input, "Escape", { keyCode: 229 }).defaultPrevented).toBe(false)
    expect(press(input, "Enter").defaultPrevented).toBe(false)
    const stopEscape = (event: KeyboardEvent) => event.stopPropagation()
    input.addEventListener("keydown", stopEscape)
    press(input, "Escape")
    input.removeEventListener("keydown", stopEscape)
    expect(onClose).not.toHaveBeenCalled()
    press(input, "Escape")
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
