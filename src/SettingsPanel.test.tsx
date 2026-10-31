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

  async function renderRuntime(nextRuntime: RuntimeInfo, nextSettings = settings) {
    await act(async () => {
      root.render(
        <SettingsPanel
          initialOmpConfig={null}
          onClose={vi.fn()}
          onError={vi.fn()}
          onSaved={vi.fn()}
          runtime={nextRuntime}
          settings={nextSettings}
        />,
      )
    })
  }

  const failedRuntime: RuntimeInfo = {
    ...runtime,
    ompAvailable: false,
    ompVersion: null,
    ompProbeFailures: [{ source: "configured", reason: "timeout" }],
  }

  function editExecutableDraft() {
    const input = container.querySelector<HTMLInputElement>("#omp-executable")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "synthetic-unsubmitted-runtime.exe",
      )
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    return input
  }

  it("updates probe guidance with the settings language without losing the executable draft", async () => {
    await renderRuntime(failedRuntime)
    expect(container.querySelector(".runtime-card")?.textContent).toContain(
      "Проверка версии превысила лимит времени.",
    )
    const executable = editExecutableDraft()
    act(() => {
      const language = container.querySelector<HTMLSelectElement>("#language-select")!
      language.value = "en"
      language.dispatchEvent(new Event("change", { bubbles: true }))
    })

    expect(container.querySelector(".runtime-card")?.textContent).toContain(
      "The version probe timed out.",
    )
    expect(container.querySelector(".runtime-card")?.textContent).not.toContain(
      "Проверка версии превысила лимит времени.",
    )
    expect(executable.value).toBe("synthetic-unsubmitted-runtime.exe")
    expect(executable.disabled).toBe(false)
  })

  it("bounds diagnostic output and never displays unknown wire values or raw probe details", async () => {
    const diagnostics = JSON.parse(
      JSON.stringify([
        {
          source: "synthetic-private-path",
          reason: "synthetic-private-reason",
          stderr: "synthetic-private-stderr",
        },
        null,
        ...Array.from({ length: 30 }, () => ({ source: "searchPath", reason: "launchFailed" })),
      ]),
    )
    await renderRuntime(
      { ...failedRuntime, ompProbeFailures: diagnostics },
      { ...settings, language: "en" },
    )

    const card = container.querySelector(".runtime-card")!
    expect(card.querySelectorAll("li")).toHaveLength(5)
    expect(card.textContent).toContain("The unavailability reason was not reported.")
    expect(card.textContent).toContain("The probe command could not be started.")
    expect(card.textContent).not.toContain("synthetic-private-")
    expect(container.querySelector<HTMLInputElement>("#omp-executable")!.disabled).toBe(false)
  })

  it("clears failed probe guidance after runtime recovery without resetting an unsaved path", async () => {
    await renderRuntime({ ...failedRuntime, ompProbeFailures: undefined })
    expect(container.querySelector(".runtime-card strong")?.textContent).toBe("OMP недоступен")
    await renderRuntime(failedRuntime)
    expect(container.querySelectorAll(".runtime-card li")).toHaveLength(1)
    const executable = editExecutableDraft()
    await renderRuntime({ ...runtime, ompProbeFailures: failedRuntime.ompProbeFailures })

    expect(container.querySelector(".runtime-card strong")?.textContent).toBe("OMP подключён")
    expect(container.querySelectorAll(".runtime-card li")).toHaveLength(0)
    expect(executable.value).toBe("synthetic-unsubmitted-runtime.exe")
  })

  it("enables Save only after a settings change", async () => {
    await act(async () => {
      root.render(
        <SettingsPanel
          initialOmpConfig={null}
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
          initialOmpConfig={null}
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
          initialOmpConfig={null}
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

  async function renderPanel(
    nextRuntime = runtime,
    nextSettings = settings,
    strict = false,
    initialSnapshot: OmpConfigSnapshot | null = null,
  ) {
    await act(async () => {
      const panel = (
        <SettingsPanel
          initialOmpConfig={initialSnapshot}
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

  function changeField(selector: string, value: string) {
    act(() => {
      const field = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
      const prototype =
        field.tagName === "SELECT"
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value)
      field.dispatchEvent(
        new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
      )
    })
  }

  function addKey(name: string, value: string) {
    changeField(".provider-add-row input:first-child", name)
    changeField(".provider-add-row input[type=password]", value)
    act(() => container.querySelector<HTMLButtonElement>(".provider-add-row button")!.click())
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

  it("saves only the submitted Desktop theme and keeps a later theme draft with a sticky acknowledgement", async () => {
    const pending = deferred<SettingsSavePayload>()
    saveSettingsBundleMock.mockReturnValueOnce(pending.promise)
    await renderPanel(runtime, settings, true, ompConfig)
    changeField("#desktop-theme-select", "light")
    const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
    act(() => save.click())
    expect(saveSettingsBundleMock.mock.lastCall![0]).toMatchObject({
      update: { desktopTheme: "light" },
      ompConfig: null,
    })
    const status = container.querySelector<HTMLElement>('.settings-save-status[role="status"]')!
    const pendingStatus = status.textContent
    changeField("#desktop-theme-select", "system")
    const committedSettings = { ...settings, desktopTheme: "light" as const }
    await act(async () => pending.resolve(saveResult(ompConfig, runtime, committedSettings)))
    await renderPanel(runtime, committedSettings, true, ompConfig)
    expect(container.querySelector<HTMLSelectElement>("#desktop-theme-select")!.value).toBe(
      "system",
    )
    expect(save.disabled).toBe(false)
    const acknowledgement = status.textContent
    expect(acknowledgement).toBeTruthy()
    expect(acknowledgement).not.toBe(pendingStatus)
    changeField("#desktop-theme-select", "dark")
    expect(status.textContent).toBe(acknowledgement)
    saveSettingsBundleMock.mockRejectedValueOnce(new Error("Synthetic theme save failure"))
    await act(async () => save.click())
    expect(saveSettingsBundleMock.mock.lastCall![0]).toMatchObject({
      update: { desktopTheme: "dark" },
      ompConfig: null,
    })
    expect(status.textContent).toBe("")
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Synthetic theme save failure",
    )
    expect(container.querySelector<HTMLSelectElement>("#desktop-theme-select")!.value).toBe("dark")
    expect(save.disabled).toBe(false)
    expect(loadOmpConfigMock).not.toHaveBeenCalled()
  })

  const savedRole = "synthetic/chosen"
  const pendingConfig: OmpConfigSnapshot = {
    ...ompConfig,
    roles: [
      {
        role: "default",
        selector: "synthetic/original",
        model: null,
        available: false,
        status: "missing",
        detail: null,
      },
    ],
  }
  const committedConfig: OmpConfigSnapshot = {
    ...pendingConfig,
    roles: [{ ...pendingConfig.roles[0], selector: savedRole }],
  }
  const editableFields = [
    ["advisor", "behavior", ".settings-options input", "advisorEnabled", true],
    ["auto-resume", "behavior", ".settings-options label:nth-child(2) input", "autoResume", true],
    ["thinking", "behavior", "#thinking-level", "defaultThinkingLevel", "high"],
    ["enabled", "providers", ".provider-enabled-toggle input", "disabledProviders", ["codex-lb"]],
    ["proxy", "providers", ".provider-proxy-toggle input", "proxyProviders", ["codex-lb"]],
  ] as const

  function changeModelDraft() {
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-role="default"] .model-picker-trigger')!
        .click(),
    )
    changeField('[data-role="default"] .model-picker-manual input', savedRole)
  }

  it.each(
    editableFields.flatMap((field) =>
      [false, true].map(
        (retry) => [field[0], retry, field[1], field[2], field[3], field[4]] as const,
      ),
    ),
  )(
    "keeps later %s edits after config Save (corrected retry: %s)",
    async (name, retry, section, selector, key, value) => {
      const pending = deferred<SettingsSavePayload>()
      if (retry)
        saveSettingsBundleMock.mockRejectedValueOnce(new Error("Synthetic provider ID collision"))
      saveSettingsBundleMock.mockReturnValueOnce(pending.promise)
      await renderPanel(runtime, settings, true, pendingConfig)
      changeModelDraft()
      if (retry) {
        act(() => container.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
        changeField(".custom-provider-form input", "taken-id")
        changeField(
          '.custom-provider-form input[placeholder="https://gateway.example.com/v1"]',
          "https://fixture.example.test/v1",
        )
        changeField(".custom-provider-form input[type=password]", "synthetic-key")
        await act(async () =>
          container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
        )
        expect(container.querySelector(".settings-save-error")).not.toBeNull()
        changeField(".custom-provider-form input", "corrected-id")
      }
      const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
      act(() => save.click())
      expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig.roles).toEqual({
        default: savedRole,
      })
      act(() => container.querySelector<HTMLButtonElement>(`#settings-tab-${section}`)!.click())
      const control = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
      expect(control.matches(":disabled")).toBe(false)
      if (name === "thinking") changeField(selector, "high")
      else act(() => (control as HTMLInputElement).click())
      expect(save.disabled).toBe(true)
      const snapshot: OmpConfigSnapshot = retry
        ? {
            ...committedConfig,
            credentials: [
              ...committedConfig.credentials,
              { ...ompConfig.credentials[0], provider: "corrected-id" },
            ],
          }
        : committedConfig
      await act(async () => pending.resolve(saveResult(snapshot)))
      expect(onSaved).toHaveBeenCalledOnce()
      const after = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
      expect(name === "thinking" ? after.value : (after as HTMLInputElement).checked).toBe(
        name === "thinking" ? "high" : name !== "enabled",
      )
      expect(save.disabled).toBe(false)
      expect(saveSettingsBundleMock).toHaveBeenCalledTimes(retry ? 2 : 1)
      saveSettingsBundleMock.mockResolvedValueOnce(saveResult({ ...snapshot, [key]: value }))
      await act(async () => save.click())
      expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig).toMatchObject({
        [key]: value,
        roles: {},
        customProviderUpserts: [],
        removedCustomProviders: [],
        operationalChanges: {},
      })
      expect(saveSettingsBundleMock.mock.lastCall![0].update).not.toHaveProperty("providerEnv")
      expect(save.disabled).toBe(true)
      expect(onSaved).toHaveBeenCalledTimes(2)
      expect(onError).toHaveBeenCalledTimes(retry ? 1 : 0)
    },
  )

  it.each(editableFields)(
    "keeps a pending reversal of the submitted %s value",
    async (name, section, selector, key, value) => {
      const pending = deferred<SettingsSavePayload>()
      saveSettingsBundleMock.mockReturnValueOnce(pending.promise)
      await renderPanel(runtime, settings, true, ompConfig)
      act(() => container.querySelector<HTMLButtonElement>(`#settings-tab-${section}`)!.click())
      const control = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
      if (name === "thinking") changeField(selector, "high")
      else act(() => (control as HTMLInputElement).click())
      const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
      act(() => save.click())
      expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig[key]).toEqual(value)
      if (name === "thinking") changeField(selector, "medium")
      else act(() => (control as HTMLInputElement).click())
      await act(async () => pending.resolve(saveResult({ ...ompConfig, [key]: value })))
      expect(name === "thinking" ? control.value : (control as HTMLInputElement).checked).toBe(
        name === "thinking" ? "medium" : name === "enabled",
      )
      expect(save.disabled).toBe(false)
      saveSettingsBundleMock.mockResolvedValueOnce(saveResult(ompConfig))
      await act(async () => save.click())
      expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig[key]).toEqual(
        name === "thinking" ? "medium" : name === "advisor" || name === "auto-resume" ? false : [],
      )
      expect(save.disabled).toBe(true)
    },
  )

  it("accepts committed values in untouched fields and clears an edit reverted to the submitted value", async () => {
    const pending = deferred<SettingsSavePayload>()
    saveSettingsBundleMock.mockReturnValueOnce(pending.promise)
    await renderPanel(runtime, settings, true, pendingConfig)
    changeModelDraft()
    const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
    act(() => save.click())
    expectAdvisorDraft(false)
    const advisor = container.querySelector<HTMLInputElement>(".settings-options input")!
    act(() => advisor.click())
    act(() => advisor.click())
    await act(async () =>
      pending.resolve(saveResult({ ...committedConfig, defaultThinkingLevel: "auto" })),
    )
    expect(advisor.checked).toBe(false)
    expect(container.querySelector<HTMLSelectElement>("#thinking-level")!.value).toBe("auto")
    expect(save.disabled).toBe(true)
    expect(saveSettingsBundleMock).toHaveBeenCalledOnce()
  })

  it("reconciles provider membership without discarding committed changes to another provider", async () => {
    const pending = deferred<SettingsSavePayload>()
    saveSettingsBundleMock.mockReturnValueOnce(pending.promise)
    await renderPanel(runtime, settings, true, { ...pendingConfig, proxyProviders: ["codex-lb"] })
    changeModelDraft()
    const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
    act(() => save.click())
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
    act(() => container.querySelector<HTMLInputElement>(".provider-enabled-toggle input")!.click())
    const snapshot = { ...committedConfig, proxyProviders: ["codex-lb", "openai"] }
    await act(async () => pending.resolve(saveResult(snapshot)))
    expect(
      [...container.querySelectorAll<HTMLInputElement>(".provider-enabled-toggle input")].map(
        (input) => input.checked,
      ),
    ).toEqual([false, true])
    expect(
      [...container.querySelectorAll<HTMLInputElement>(".provider-proxy-toggle input")].map(
        (input) => input.checked,
      ),
    ).toEqual([false, true])
    saveSettingsBundleMock.mockResolvedValueOnce(
      saveResult({ ...snapshot, disabledProviders: ["codex-lb"], proxyProviders: ["openai"] }),
    )
    await act(async () => save.click())
    expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig).toMatchObject({
      disabledProviders: ["codex-lb"],
      proxyProviders: ["openai"],
      roles: {},
    })
    expect(save.disabled).toBe(true)
  })

  it.each(["before", "after"] as const)(
    "retains a later removal confirmed %s Save settles without replaying the submitted removal",
    async (when) => {
      const pending = deferred<SettingsSavePayload>()
      const confirmation = deferred<boolean>()
      confirmMock.mockReset().mockResolvedValueOnce(true).mockReturnValueOnce(confirmation.promise)
      saveSettingsBundleMock.mockReturnValueOnce(pending.promise)
      const snapshot = {
        ...ompConfig,
        credentials: [
          ...ompConfig.credentials,
          { ...ompConfig.credentials[0], provider: "second-custom" },
        ],
      }
      await renderPanel(runtime, settings, true, snapshot)
      act(() => container.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
      await act(async () =>
        container.querySelector<HTMLButtonElement>(".provider-remove-button")!.click(),
      )
      const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
      act(() => save.click())
      act(() => container.querySelector<HTMLButtonElement>(".provider-remove-button")!.click())
      const committed = {
        ...snapshot,
        credentials: snapshot.credentials.filter(
          (credential) => credential.provider !== "codex-lb",
        ),
      }
      if (when === "before") await act(async () => confirmation.resolve(true))
      await act(async () => pending.resolve(saveResult(committed)))
      if (when === "after") await act(async () => confirmation.resolve(true))
      expect(container.querySelector(".provider-remove-button")).toBeNull()
      expect(save.disabled).toBe(false)
      saveSettingsBundleMock.mockResolvedValueOnce(
        saveResult({ ...committed, credentials: [ompConfig.credentials[1]] }),
      )
      await act(async () => save.click())
      expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig.removedCustomProviders).toEqual([
        "second-custom",
      ])
      expect(save.disabled).toBe(true)
    },
  )

  it("resets old-runtime pending drafts when Save returns a different runtime", async () => {
    const pending = deferred<SettingsSavePayload>()
    saveSettingsBundleMock.mockReturnValueOnce(pending.promise)
    await renderPanel(runtime, settings, true, pendingConfig)
    changeModelDraft()
    const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
    act(() => save.click())
    expectAdvisorDraft(false)
    act(() => container.querySelector<HTMLInputElement>(".settings-options input")!.click())
    const nextRuntime = { ...runtime, ompExecutable: "synthetic-new-runtime.exe" }
    await act(async () => pending.resolve(saveResult(committedConfig, nextRuntime)))
    await renderPanel(nextRuntime, settings, true, committedConfig)
    expectAdvisorDraft(false)
    expect(save.disabled).toBe(true)
    expect(onSaved).toHaveBeenCalledOnce()
    expect(loadOmpConfigMock).not.toHaveBeenCalled()
  })

  it("opens a cached role baseline as clean and editable in Strict Mode", async () => {
    const model = {
      provider: "catalog",
      id: "cached",
      selector: "catalog/cached",
      name: "Cached model",
      available: true,
      status: "ok",
      detail: null,
      thinking: [],
    }
    const snapshot = {
      ...ompConfig,
      models: [model],
      roles: [
        {
          role: "default",
          selector: model.selector,
          model,
          available: true,
          status: "ok",
          detail: null,
        },
      ],
      advisorEnabled: true,
      autoResume: true,
      defaultThinkingLevel: "high",
      modelFallbackEnabled: false,
      fallbackChains: { default: [model.selector] },
      proxyProviders: ["catalog"],
      disabledProviders: ["unused"],
    }
    loadOmpConfigMock.mockReturnValue(deferred<OmpConfigSnapshot>().promise)
    await renderPanel(runtime, settings, true, snapshot)
    expect(container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
      true,
    )
    expectAdvisorDraft(true)
    act(() => container.querySelector<HTMLInputElement>(".settings-options input")!.click())
    expect(container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
      false,
    )
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    const picker = container.querySelector<HTMLButtonElement>(".model-picker-trigger")!
    expect(picker.textContent).toContain("Cached model")
    act(() => picker.click())
    expect(container.querySelector(".model-picker-option")?.textContent).toContain("Cached model")
    expect(container.querySelector(".settings-loading-banner")).toBeNull()
  })

  it("makes a discovered model selectable without replacing drafts edited during refresh", async () => {
    const oldModel = {
      provider: "catalog",
      id: "old",
      selector: "catalog/old",
      name: "Old model",
      available: true,
      status: "ok",
      detail: null,
      thinking: [],
    }
    const newModel = { ...oldModel, id: "new", selector: "catalog/new", name: "New model" }
    const initial = {
      ...ompConfig,
      models: [oldModel],
      roles: [
        {
          role: "default",
          selector: oldModel.selector,
          model: oldModel,
          available: true,
          status: "ok",
          detail: null,
        },
      ],
    }
    loadOmpConfigMock.mockResolvedValueOnce(initial)
    const refreshed = deferred<OmpConfigSnapshot>()
    refreshOmpConfigMock.mockReturnValueOnce(refreshed.promise)
    saveSettingsBundleMock.mockResolvedValue(saveResult(initial))
    await renderPanel()
    act(() => container.querySelector<HTMLButtonElement>(".runtime-card button")!.click())
    changeExecutable("draft-omp.exe")
    expectAdvisorDraft(false)
    act(() => container.querySelector<HTMLInputElement>(".settings-options input")!.click())
    await act(async () => refreshed.resolve({ ...initial, models: [oldModel, newModel] }))
    expectAdvisorDraft(true)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    act(() => container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click())
    const newOption = [
      ...container.querySelectorAll<HTMLButtonElement>(".model-picker-option"),
    ].find((option) => option.textContent?.includes("New model"))!
    act(() => newOption.click())
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ ompExecutable: "draft-omp.exe" }),
        ompConfig: expect.objectContaining({
          advisorEnabled: true,
          roles: { default: "catalog/new" },
        }),
      }),
    )
  })

  it("saves only changed agent fields without collapsing inherited or ordered overrides", async () => {
    const reviewer = {
      name: "reviewer",
      description: "Reviews code",
      source: "builtin",
      enabled: false,
      modelOverride: ["slow", "catalog/*"],
      defaultModelSelectors: ["slow"],
    }
    const security = {
      name: "security-reviewer",
      description: "Reviews security",
      source: "project",
      enabled: true,
      modelOverride: null,
      defaultModelSelectors: [],
    }
    const snapshot = { ...ompConfig, agents: [reviewer, security], agentSettingsSupported: true }
    saveSettingsBundleMock.mockResolvedValue(saveResult(snapshot))
    await renderPanel(runtime, settings, false, snapshot)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    expect(container.querySelectorAll(".agent-row")).toHaveLength(2)
    const reviewerRow = container.querySelector<HTMLElement>('[data-agent="reviewer"]')!
    expect(reviewerRow.querySelectorAll(".model-picker-trigger")).toHaveLength(2)
    act(() => reviewerRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock.mock.calls[0][0].ompConfig.agentChanges).toEqual({
      reviewer: { enabled: true, expectedEnabled: false },
    })
  })

  it("configures agent models through the picker and clears overrides to inherit", async () => {
    const agent = {
      name: "security-reviewer",
      description: "Reviews security",
      source: "project",
      enabled: true,
      modelOverride: null,
      defaultModelSelectors: [],
    }
    const snapshot = {
      ...ompConfig,
      agents: [agent],
      agentSettingsSupported: true,
      roles: [
        {
          role: "default",
          selector: "catalog/main",
          model: null,
          available: true,
          status: "ok",
          detail: null,
        },
      ],
    }
    saveSettingsBundleMock.mockResolvedValue(saveResult(snapshot))
    await renderPanel(runtime, settings, false, snapshot)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    changeField('[data-agent="security-reviewer"] .agent-model-mode select', "override")
    expect(
      container.querySelector('[data-agent="security-reviewer"] .model-picker-copy small')!
        .textContent,
    ).toBe("@default")
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-agent="security-reviewer"] .model-picker-trigger')!
        .click(),
    )
    changeField('[data-agent="security-reviewer"] .model-picker-shortcuts select', "@default")
    expect(
      container.querySelector('[data-agent="security-reviewer"] .model-picker-panel'),
    ).toBeNull()
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-agent="security-reviewer"] .model-picker-trigger')!
        .click(),
    )
    changeField(
      '[data-agent="security-reviewer"] .model-picker-manual input',
      "catalog/custom:high",
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock.mock.calls[0][0].ompConfig.agentChanges).toEqual({
      "security-reviewer": { modelOverride: ["catalog/custom:high"], expectedModelOverride: null },
    })
    const overridden = { ...snapshot, agents: [{ ...agent, modelOverride: ["slow", "catalog/*"] }] }
    await act(async () => root.unmount())
    root = createRoot(container)
    await renderPanel(runtime, settings, false, overridden)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    changeField('[data-agent="security-reviewer"] .agent-model-mode select', "inherit")
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock.mock.calls[1][0].ompConfig.agentChanges).toEqual({
      "security-reviewer": { modelOverride: null, expectedModelOverride: ["slow", "catalog/*"] },
    })
  })

  it("does not send model configuration for a preference-only save with agents", async () => {
    const snapshot = {
      ...ompConfig,
      agentSettingsSupported: true,
      agents: [
        {
          name: "reviewer",
          description: "Reviews code",
          source: "builtin",
          enabled: true,
          modelOverride: ["slow", "catalog/*"],
          defaultModelSelectors: ["slow"],
        },
      ],
    }
    saveSettingsBundleMock.mockResolvedValue(saveResult(snapshot))
    await renderPanel(runtime, settings, false, snapshot)
    changeField("#app-font-size", "20")
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock.mock.calls[0][0].ompConfig).toBeNull()
  })

  it("keeps unsupported agent configuration read-only", async () => {
    const snapshot = {
      ...ompConfig,
      agents: [
        {
          name: "reviewer",
          description: "Reviews code",
          source: "builtin",
          enabled: true,
          modelOverride: ["slow"],
          defaultModelSelectors: ["slow"],
        },
      ],
    }
    await renderPanel(runtime, settings, false, snapshot)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    expect(container.querySelector('[data-agent="reviewer"] input')!.matches(":disabled")).toBe(
      true,
    )
    expect(container.querySelector('[data-agent="reviewer"] select')!.matches(":disabled")).toBe(
      true,
    )
    expect(
      container
        .querySelector('[data-agent="reviewer"] .model-picker-trigger')!
        .matches(":disabled"),
    ).toBe(true)
    expect(container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
      true,
    )
  })

  it("merges discovered roles and agents while retaining model, agent and fallback drafts", async () => {
    const reviewer = {
      name: "reviewer",
      description: "Reviews code",
      source: "builtin",
      enabled: false,
      modelOverride: ["slow", "catalog/*"],
      defaultModelSelectors: ["slow"],
    }
    const role = {
      role: "default",
      selector: "catalog/main",
      model: null,
      available: true,
      status: "ok",
      detail: null,
    }
    const snapshot = {
      ...ompConfig,
      agents: [reviewer],
      agentSettingsSupported: true,
      roles: [role],
      fallbackChains: { default: ["catalog/first", "catalog/second"] },
    }
    const refresh = deferred<OmpConfigSnapshot>()
    refreshOmpConfigMock.mockReturnValueOnce(refresh.promise)
    saveSettingsBundleMock.mockResolvedValue(saveResult(snapshot))
    await renderPanel(runtime, settings, false, snapshot)
    act(() => container.querySelector<HTMLButtonElement>(".runtime-card button")!.click())
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-role="default"] .model-picker-trigger')!
        .click(),
    )
    changeField('[data-role="default"] .model-picker-manual input', "catalog/draft")
    act(() =>
      container
        .querySelector<HTMLInputElement>('[data-agent="reviewer"] input[type="checkbox"]')!
        .click(),
    )
    act(() =>
      container
        .querySelectorAll<HTMLButtonElement>('[data-agent="reviewer"] .model-picker-trigger')[1]
        .click(),
    )
    changeField('[data-agent="reviewer"] .model-picker-manual input', "catalog/agent-draft")
    const moveDown = container.querySelector<HTMLButtonElement>(
      ".fallback-entry-actions button:nth-child(2)",
    )!
    act(() => moveDown.click())
    changeField(".fallback-chain-key input", "custom-chain")
    await act(async () =>
      refresh.resolve({
        ...snapshot,
        roles: [role, { ...role, role: "extra-role", selector: "catalog/extra" }],
        agents: [
          { ...reviewer, enabled: true, modelOverride: ["other"] },
          { ...reviewer, name: "security-reviewer", modelOverride: null },
        ],
        fallbackChains: { default: ["catalog/external"] },
      }),
    )
    expect(container.querySelectorAll('[data-role="default"]')).toHaveLength(1)
    expect(container.querySelector('[data-role="extra-role"]')).not.toBeNull()
    expect(container.querySelector('[data-role="extra-role"] strong')!.textContent).toBe(
      "extra-role",
    )
    expect(container.querySelector('[data-agent="security-reviewer"]')).not.toBeNull()
    expect(
      container.querySelectorAll(".settings-models-controls > .settings-section"),
    ).toHaveLength(3)
    expect(
      container.querySelector<HTMLButtonElement>('[data-role="default"] .model-picker-trigger')!
        .textContent,
    ).toContain("catalog/draft")
    expect(
      container.querySelector<HTMLInputElement>('[data-agent="reviewer"] input[type="checkbox"]')!
        .checked,
    ).toBe(true)
    expect(
      container.querySelectorAll('[data-agent="reviewer"] .model-picker-trigger'),
    ).toHaveLength(2)
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock.mock.calls[0][0].ompConfig).toEqual(
      expect.objectContaining({
        roles: { default: "catalog/draft" },
        agentChanges: {
          reviewer: {
            enabled: true,
            expectedEnabled: false,
            modelOverride: ["slow", "catalog/agent-draft"],
            expectedModelOverride: ["slow", "catalog/*"],
          },
        },
        fallbackChains: { "custom-chain": ["catalog/second", "catalog/first"] },
      }),
    )
  })

  it("adds and removes fallback chains and entries without saving discarded selectors", async () => {
    const snapshot = { ...ompConfig, fallbackChains: { default: ["catalog/one", "catalog/two"] } }
    saveSettingsBundleMock.mockResolvedValue(saveResult(snapshot))
    await renderPanel(runtime, settings, false, snapshot)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    act(() => container.querySelector<HTMLButtonElement>(".fallback-add-model")!.click())
    expect(container.querySelectorAll(".fallback-entry")).toHaveLength(3)
    act(() =>
      container
        .querySelectorAll<HTMLButtonElement>(".fallback-entry-actions button:nth-child(3)")[2]
        .click(),
    )
    expect(container.querySelectorAll(".fallback-entry")).toHaveLength(2)
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          ".settings-fallbacks-section .settings-section-heading button",
        )!
        .click(),
    )
    expect(container.querySelectorAll(".fallback-chain")).toHaveLength(2)
    act(() => container.querySelectorAll<HTMLButtonElement>(".fallback-chain-remove")[1].click())
    expect(container.querySelectorAll(".fallback-chain")).toHaveLength(1)
    act(() =>
      container
        .querySelector<HTMLButtonElement>(".fallback-entry-actions button:nth-child(3)")!
        .click(),
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock.mock.calls[0][0].ompConfig.fallbackChains).toEqual({
      default: ["catalog/two"],
    })
  })

  it("offers catalog models matching each auxiliary role kind", async () => {
    const model = {
      provider: "catalog",
      id: "chat",
      selector: "catalog/chat",
      name: "Chat",
      available: true,
      status: "ok",
      detail: null,
      thinking: [],
      kind: "chat",
    }
    const image = { ...model, id: "image", selector: "catalog/image", name: "Image", kind: "image" }
    const speech = {
      ...model,
      id: "speech",
      selector: "catalog/speech",
      name: "Speech",
      kind: "tts",
    }
    const role = {
      role: "image",
      selector: image.selector,
      model: image,
      available: true,
      status: "ok",
      detail: null,
    }
    const snapshot = {
      ...ompConfig,
      models: [model, image, speech],
      roles: [
        { ...role, role: "default", selector: model.selector, model },
        role,
        { ...role, role: "speech", selector: speech.selector, model: speech },
      ],
    }
    await renderPanel(runtime, settings, false, snapshot)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    for (const [name, selector] of [
      ["default", model.selector],
      ["image", image.selector],
      ["speech", speech.selector],
    ]) {
      act(() =>
        container
          .querySelector<HTMLButtonElement>(`[data-role="${name}"] .model-picker-trigger`)!
          .click(),
      )
      expect(
        [...container.querySelectorAll(".model-picker-option small")].map(
          (entry) => entry.textContent,
        ),
      ).toEqual([selector])
    }
  })

  it("preserves ordered agent selector arrays when editing a single entry", async () => {
    const snapshot = {
      ...ompConfig,
      agentSettingsSupported: true,
      agents: [
        {
          name: "reviewer",
          description: "Reviews code",
          source: "builtin",
          enabled: true,
          modelOverride: ["slow", "catalog/*"],
          defaultModelSelectors: ["slow"],
        },
      ],
    }
    saveSettingsBundleMock.mockResolvedValue(saveResult(snapshot))
    await renderPanel(runtime, settings, false, snapshot)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    act(() =>
      container
        .querySelectorAll<HTMLButtonElement>('[data-agent="reviewer"] .model-picker-trigger')[1]
        .click(),
    )
    changeField('[data-agent="reviewer"] .model-picker-manual input', "catalog/updated")
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock.mock.calls[0][0].ompConfig.agentChanges).toEqual({
      reviewer: {
        modelOverride: ["slow", "catalog/updated"],
        expectedModelOverride: ["slow", "catalog/*"],
      },
    })
  })

  it("drops old-runtime agent drafts and ignores the cancelled refresh", async () => {
    const agent = {
      name: "reviewer",
      description: "Reviews code",
      source: "builtin",
      enabled: false,
      modelOverride: null,
      defaultModelSelectors: ["slow"],
    }
    const snapshot = { ...ompConfig, agents: [agent], agentSettingsSupported: true }
    const refresh = deferred<OmpConfigSnapshot>()
    const fresh = deferred<OmpConfigSnapshot>()
    refreshOmpConfigMock.mockReturnValueOnce(refresh.promise)
    loadOmpConfigMock.mockReturnValueOnce(fresh.promise)
    await renderPanel(runtime, settings, false, snapshot)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    act(() =>
      container
        .querySelector<HTMLInputElement>('[data-agent="reviewer"] input[type="checkbox"]')!
        .click(),
    )
    act(() => container.querySelector<HTMLButtonElement>(".runtime-card button")!.click())
    await renderPanel({ ...runtime, ompExecutable: "other-omp.exe" }, settings)
    await act(async () => fresh.resolve(snapshot))
    await act(async () => refresh.resolve({ ...snapshot, agents: [{ ...agent, enabled: true }] }))
    expect(
      container.querySelector<HTMLInputElement>('[data-agent="reviewer"] input[type="checkbox"]')!
        .checked,
    ).toBe(false)
    expect(container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
      true,
    )
  })

  it("keeps the usable catalog and a dirty draft visible when refresh rejects", async () => {
    refreshOmpConfigMock.mockRejectedValueOnce(new Error("Catalog refresh failed"))
    await renderPanel()
    expectAdvisorDraft(false)
    act(() => container.querySelector<HTMLInputElement>(".settings-options input")!.click())
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".runtime-card button")!.click(),
    )
    expectAdvisorDraft(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Catalog refresh failed",
    )
    expect(container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
      false,
    )
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
    expect(container.textContent).toContain("codex-lb")
  })

  it.each(["save", "refresh"] as const)(
    "keeps a structured %s failure visible locally without forwarding a duplicate generic error",
    async (operation) => {
      const failure = {
        code: "settings_unavailable",
        message: "Settings storage unavailable",
        details: "Fixture disk unavailable",
        settingsPath: "C:/fixture/settings.json",
        backupPath: null,
        failureStage: "read",
      }
      if (operation === "save") saveSettingsBundleMock.mockRejectedValueOnce(failure)
      else refreshOmpConfigMock.mockRejectedValueOnce(failure)
      await renderPanel()
      changeExecutable("draft-omp.exe")
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            operation === "save" ? ".settings-actions .primary" : ".runtime-card button",
          )!
          .click(),
      )
      expect(container.querySelector('[role="dialog"]')).not.toBeNull()
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(container.querySelector<HTMLInputElement>("#omp-executable")!.value).toBe(
        "draft-omp.exe",
      )
      expect(
        container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled,
      ).toBe(false)
      expect(onError).not.toHaveBeenCalled()
      expect(onSaved).not.toHaveBeenCalled()
    },
  )

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

  it("keeps live catalog and newer drafts after preferences-only Save", async () => {
    const oldModel = {
      provider: "catalog",
      id: "old",
      selector: "catalog/old",
      name: "Old model",
      available: true,
      status: "ok",
      detail: null,
      thinking: [],
    }
    const newModel = { ...oldModel, id: "new", selector: "catalog/new", name: "New model" }
    const initial = {
      ...ompConfig,
      models: [oldModel],
      roles: [
        {
          role: "default",
          selector: oldModel.selector,
          model: oldModel,
          available: true,
          status: "ok",
          detail: null,
        },
      ],
    }
    const configured = { ...settings, providerEnvKeys: ["OPENAI_API_KEY"] }
    const fontStack = '"Cascadia Code", "Noto Sans Mono", Consolas, monospace'
    const savedSettings = { ...configured, appFontSize: 32, terminalFontFamily: fontStack }
    const pendingSave = deferred<SettingsSavePayload>()
    saveSettingsBundleMock.mockReturnValueOnce(pendingSave.promise)
    refreshOmpConfigMock.mockResolvedValueOnce({ ...initial, models: [oldModel, newModel] })
    await renderPanel(runtime, configured, false, initial)
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".runtime-card button")!.click(),
    )
    changeField("#app-font-size", "32")
    expectAdvisorDraft(false)
    changeField("#terminal-font-family", fontStack)
    act(() => container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click())
    const request = saveSettingsBundleMock.mock.lastCall![0]
    expect(request.update).not.toHaveProperty("providerEnv")
    expect(request.ompConfig).toBeNull()
    expect(request.update.terminalFontFamily).toBe(fontStack)
    expect(request.update.appFontSize).toBe(32)

    // A no-config result must not clear edits started after this preferences save.
    act(() => container.querySelector<HTMLInputElement>(".settings-options input")!.click())
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
    addKey("ANTHROPIC_API_KEY", "synthetic-new-key")
    await act(async () => pendingSave.resolve(saveResult(null, runtime, savedSettings)))
    await renderPanel(runtime, savedSettings, false, initial)
    expect(container.querySelectorAll(".provider-key-row")).toHaveLength(2)
    expectAdvisorDraft(true)
    expect(container.querySelector<HTMLInputElement>("#terminal-font-family")!.value).toBe(
      fontStack,
    )
    expect(container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
      false,
    )
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-models")!.click())
    act(() => container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click())
    expect(
      [...container.querySelectorAll(".model-picker-option")].some((option) =>
        option.textContent?.includes("New model"),
      ),
    ).toBe(true)
    expect(loadOmpConfigMock).not.toHaveBeenCalled()
    expect(refreshOmpConfigMock).toHaveBeenCalledOnce()

    saveSettingsBundleMock.mockResolvedValueOnce(saveResult({ ...initial, advisorEnabled: true }))
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock.mock.lastCall![0]).toEqual(
      expect.objectContaining({
        update: expect.objectContaining({
          providerEnv: { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "synthetic-new-key" },
        }),
        ompConfig: expect.objectContaining({ advisorEnabled: true }),
      }),
    )
  })

  it.each(["replace", "add", "remove"] as const)(
    "keeps credential %s distinct from unchanged placeholders through failure and retry",
    async (mutation) => {
      const configured = { ...settings, providerEnvKeys: ["OPENAI_API_KEY", "KEEP_API_KEY"] }
      const expected =
        mutation === "replace"
          ? { OPENAI_API_KEY: "synthetic-replacement", KEEP_API_KEY: "" }
          : mutation === "add"
            ? { OPENAI_API_KEY: "", KEEP_API_KEY: "", NEW_API_KEY: "synthetic-addition" }
            : { KEEP_API_KEY: "" }
      const savedSettings = { ...configured, providerEnvKeys: Object.keys(expected) }
      saveSettingsBundleMock
        .mockRejectedValueOnce(new Error("Synthetic secret write failure"))
        .mockResolvedValueOnce(saveResult(ompConfig, runtime, savedSettings))
      await renderPanel(runtime, configured, false, ompConfig)
      act(() => container.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
      if (mutation === "replace") addKey("OPENAI_API_KEY", "synthetic-replacement")
      else if (mutation === "add") addKey("NEW_API_KEY", "synthetic-addition")
      else {
        const row = [...container.querySelectorAll(".provider-key-row")].find(
          (node) => node.querySelector("code")?.textContent === "OPENAI_API_KEY",
        )!
        act(() => row.querySelector<HTMLButtonElement>("button")!.click())
      }
      const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
      await act(async () => save.click())
      expect(container.querySelector(".settings-save-error")).not.toBeNull()
      expect(save.disabled).toBe(false)
      expect(saveSettingsBundleMock.mock.lastCall![0].update.providerEnv).toEqual(expected)
      expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig).toBeNull()
      await act(async () => save.click())
      expect(saveSettingsBundleMock.mock.lastCall![0].update.providerEnv).toEqual(expected)
      await renderPanel(runtime, savedSettings, false, ompConfig)
      expect(save.disabled).toBe(true)
      expect(
        [...container.querySelectorAll(".provider-key-row code")]
          .map((node) => node.textContent)
          .sort(),
      ).toEqual(Object.keys(expected).sort())
      expect(container.textContent).not.toContain("synthetic-replacement")
      expect(container.textContent).not.toContain("synthetic-addition")

      // The accepted values become blank keep-placeholders, not repeated writes.
      act(() => container.querySelector<HTMLButtonElement>("#settings-tab-general")!.click())
      changeField("#app-font-size", "20")
      saveSettingsBundleMock.mockResolvedValueOnce(
        saveResult(null, runtime, { ...savedSettings, appFontSize: 20 }),
      )
      await act(async () => save.click())
      expect(saveSettingsBundleMock.mock.lastCall![0].update).not.toHaveProperty("providerEnv")
      expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig).toBeNull()
      expect(loadOmpConfigMock).not.toHaveBeenCalled()
    },
  )

  it("keeps newer config drafts after a verified credential-only save", async () => {
    const pending = deferred<SettingsSavePayload>()
    const savedSettings = { ...settings, providerEnvKeys: ["NEW_API_KEY"] }
    saveSettingsBundleMock.mockReturnValueOnce(pending.promise)
    await renderPanel(runtime, settings, false, ompConfig)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
    addKey("NEW_API_KEY", "synthetic-key")
    act(() => container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click())
    expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig).toBeNull()
    expectAdvisorDraft(false)
    act(() => container.querySelector<HTMLInputElement>(".settings-options input")!.click())
    await act(async () => pending.resolve(saveResult(ompConfig, runtime, savedSettings)))
    await renderPanel(runtime, savedSettings, false, ompConfig)
    expectAdvisorDraft(true)
    expect(container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
      false,
    )
    saveSettingsBundleMock.mockResolvedValueOnce(
      saveResult({ ...ompConfig, advisorEnabled: true }, runtime, savedSettings),
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock.mock.lastCall![0].update).not.toHaveProperty("providerEnv")
    expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig.advisorEnabled).toBe(true)
  })

  it("verifies custom-provider removal without rewriting kept keys", async () => {
    confirmMock.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const configured = { ...settings, providerEnvKeys: ["KEEP_API_KEY"] }
    const savedSnapshot = {
      ...ompConfig,
      credentials: ompConfig.credentials.filter((credential) => credential.provider !== "codex-lb"),
    }
    saveSettingsBundleMock
      .mockRejectedValueOnce(new Error("Synthetic removal failure"))
      .mockResolvedValueOnce(saveResult(savedSnapshot, runtime, configured))
    await renderPanel(runtime, configured, false, ompConfig)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
    const save = container.querySelector<HTMLButtonElement>(".settings-actions .primary")!
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".provider-remove-button")!.click(),
    )
    expect(save.disabled).toBe(true)
    expect(container.querySelector(".provider-remove-button")).not.toBeNull()
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".provider-remove-button")!.click(),
    )
    expect(container.querySelector(".provider-remove-button")).toBeNull()
    await act(async () => save.click())
    expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig.removedCustomProviders).toEqual([
      "codex-lb",
    ])
    expect(saveSettingsBundleMock.mock.lastCall![0].update).not.toHaveProperty("providerEnv")
    expect(container.querySelector(".settings-save-error")).not.toBeNull()
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    expect(save.disabled).toBe(true)
    expect(
      [...container.querySelectorAll(".provider-credential-main strong")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["openai"])
  })

  it.each([null, 5])("preserves explicit operational reset against baseline %s", async (value) => {
    const snapshot: OmpConfigSnapshot = {
      ...ompConfig,
      operationalSettings: [
        {
          key: "retry.maxRetries",
          category: "retry",
          type: "number",
          description: "Synthetic retry limit",
          value,
          choices: [],
        },
      ],
    }
    saveSettingsBundleMock.mockResolvedValueOnce(saveResult(snapshot))
    await renderPanel(runtime, settings, false, snapshot)
    act(() => container.querySelector<HTMLButtonElement>("#settings-tab-operations")!.click())
    act(() =>
      container.querySelector<HTMLButtonElement>(".settings-operation-actions button")!.click(),
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    expect(saveSettingsBundleMock.mock.lastCall![0].ompConfig.operationalChanges).toEqual({
      "retry.maxRetries": { expectedValue: value, value: null, reset: true },
    })
    expect(saveSettingsBundleMock.mock.lastCall![0].update).not.toHaveProperty("providerEnv")
  })

  it("seeds fresh drafts after switching away from a fully loaded runtime", async () => {
    await renderPanel()
    expectAdvisorDraft(false)
    loadOmpConfigMock.mockResolvedValueOnce({ ...ompConfig, advisorEnabled: true })
    await renderPanel({ ...runtime, ompExecutable: "new-runtime.exe" })
    expectAdvisorDraft(true)
    expect(container.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
      true,
    )
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
            initialOmpConfig={null}
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
    const wrapped = document.activeElement
    expect(wrapped).not.toBe(cancel)
    expect(panel.contains(wrapped)).toBe(true)
    expect(wrapped?.matches(":disabled, [hidden], [tabindex='-1']")).toBe(false)
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

describe("unsaved dismissal guard", () => {
  let host: HTMLDivElement
  let root: Root
  let closed: Mock
  let saved: Mock
  let noticed: Mock
  async function mount(nextSettings = settings) {
    await act(async () =>
      root.render(
        <SettingsPanel
          settings={nextSettings}
          runtime={runtime}
          initialOmpConfig={ompConfig}
          onClose={closed}
          onSaved={saved}
          onNotice={noticed}
          onError={vi.fn()}
        />,
      ),
    )
  }
  function edit(selector = "#omp-executable", value = "synthetic-custom-omp") {
    act(() => {
      const input = host.querySelector<HTMLInputElement>(selector)!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  function press(target: Element, key: string, extra: KeyboardEventInit = {}) {
    act(() =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...extra,
        }),
      ),
    )
  }
  const dialog = () => host.querySelector<HTMLElement>('[role="alertdialog"]')
  const input = () => host.querySelector<HTMLInputElement>("#omp-executable")!
  async function dismiss(route: string) {
    await act(async () => {
      if (route === "backdrop")
        host
          .querySelector(".settings-backdrop")!
          .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
      if (route === "header")
        host.querySelector<HTMLButtonElement>(".settings-header button")!.click()
      if (route === "escape")
        input().dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        )
    })
  }
  beforeEach(async () => {
    confirmMock.mockReset()
    loadOmpConfigMock.mockReset().mockResolvedValue(ompConfig)
    saveSettingsBundleMock.mockReset()
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    closed = vi.fn(() => root.render(null))
    saved = vi.fn()
    noticed = vi.fn()
    await mount()
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })
  it.each([false, true])(
    "does not treat an added key name as unsaved; next new name=%s",
    async (newName) => {
      act(() => host.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
      edit(".provider-add-row input:first-child", "CUSTOM_SYNTHETIC_KEY")
      edit(".provider-add-row input[type=password]", "synthetic-value")
      act(() => host.querySelector<HTMLButtonElement>(".provider-add-row button")!.click())
      const nextSettings = { ...settings, providerEnvKeys: ["CUSTOM_SYNTHETIC_KEY"] }
      saveSettingsBundleMock.mockResolvedValue({
        bootstrap: {
          settings: nextSettings,
          runtime,
          workspaces: [],
          sessions: [],
          sessionWarnings: [],
        },
        ompConfig,
      })
      await act(async () =>
        host.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
      )
      await mount(nextSettings)
      expect(host.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(
        true,
      )
      if (newName) edit(".provider-add-row input:first-child", "ANOTHER_SYNTHETIC_KEY")
      await dismiss("header")
      if (newName) {
        expect(dialog()).not.toBeNull()
        expect(closed).not.toHaveBeenCalled()
      } else {
        expect(dialog()).toBeNull()
        expect(closed).toHaveBeenCalledTimes(1)
      }
    },
  )
  it.each(["discard", "keep-cancel", "keep-discard"] as const)(
    "restores the original external opener after %s",
    async (route) => {
      act(() => root.unmount())
      const opener = document.createElement("button")
      document.body.append(opener)
      opener.focus()
      root = createRoot(host)
      await mount()
      edit()
      await dismiss("escape")
      if (route !== "discard") {
        await act(async () => dialog()!.querySelector<HTMLButtonElement>(".primary")!.click())
        if (route === "keep-cancel") {
          await act(async () =>
            host
              .querySelector<HTMLButtonElement>(
                '.settings-panel[role="dialog"] .settings-actions .secondary',
              )!
              .click(),
          )
        } else {
          await dismiss("escape")
        }
      }
      if (route !== "keep-cancel") {
        await act(async () => dialog()!.querySelector<HTMLButtonElement>(".secondary")!.click())
      }
      expect(document.activeElement).toBe(opener)
      opener.remove()
    },
  )
  for (const route of ["backdrop", "header", "escape"]) {
    it(`keeps dirty draft after accidental ${route} until explicit discard`, async () => {
      edit()
      input().focus()
      await dismiss(route)
      expect(closed).not.toHaveBeenCalled()
      expect(dialog()).not.toBeNull()
      expect(document.activeElement?.textContent).toBe("Продолжить редактирование")
      expect(host.querySelector<HTMLElement>('.settings-panel[role="dialog"]')!.style.display).toBe(
        "none",
      )
      expect(host.querySelector('.settings-panel[role="dialog"]')?.hasAttribute("inert")).toBe(true)
      expect(confirmMock).not.toHaveBeenCalled()
      expect(saveSettingsBundleMock).not.toHaveBeenCalled()
      await act(async () => dialog()!.querySelector<HTMLButtonElement>(".primary")!.click())
      expect(dialog()).toBeNull()
      expect(input().value).toBe("synthetic-custom-omp")
      expect(document.activeElement).toBe(input())
      await dismiss(route)
      await act(async () => dialog()!.querySelector<HTMLButtonElement>(".secondary")!.click())
      expect(closed).toHaveBeenCalledTimes(1)
      expect(saveSettingsBundleMock).not.toHaveBeenCalled()
      await mount()
      expect(input().value).toBe(settings.ompExecutable ?? "")
    })
  }
  it("uses Escape/backdrop as Keep editing and traps confirmation focus", async () => {
    edit()
    input().focus()
    await dismiss("escape")
    const keep = dialog()!.querySelector<HTMLButtonElement>(".primary")!
    const discard = dialog()!.querySelector<HTMLButtonElement>(".secondary")!
    press(keep, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(discard)
    press(discard, "Tab")
    expect(document.activeElement).toBe(keep)
    press(keep, "Escape")
    expect(dialog()).toBeNull()
    expect(closed).not.toHaveBeenCalled()
    await dismiss("header")
    await act(async () =>
      dialog()!.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    )
    expect(dialog()).toBeNull()
    expect(input().value).toBe("synthetic-custom-omp")
  })
  it("leaves section navigation and nested select/IME Escape owned by their controls", async () => {
    edit()
    await act(async () => host.querySelector<HTMLButtonElement>("#settings-tab-behavior")!.click())
    await act(async () => host.querySelector<HTMLButtonElement>("#settings-tab-general")!.click())
    expect(input().value).toBe("synthetic-custom-omp")
    press(host.querySelector("select")!, "Escape")
    press(input(), "Escape", { isComposing: true })
    press(input(), "Escape", { keyCode: 229 })
    expect(dialog()).toBeNull()
    expect(closed).not.toHaveBeenCalled()
  })
  it("closes clean and harmless normalized whitespace without confirmation", async () => {
    edit("#omp-executable", "  ")
    await dismiss("header")
    expect(closed).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
  })
  it("preserves explicit Cancel as intentional discard", async () => {
    edit()
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".settings-actions .secondary")!.click(),
    )
    expect(closed).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
    expect(saveSettingsBundleMock).not.toHaveBeenCalled()
  })
  it("protects unadded provider key input without enabling or sending Save", async () => {
    await act(async () => host.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
    edit(".provider-add-row input[type=password]", "synthetic-only-key")
    expect(host.querySelector<HTMLButtonElement>(".settings-actions .primary")!.disabled).toBe(true)
    await dismiss("header")
    expect(dialog()).not.toBeNull()
    expect(closed).not.toHaveBeenCalled()
    expect(saveSettingsBundleMock).not.toHaveBeenCalled()
    expect(dialog()!.textContent).not.toContain("synthetic-only-key")
  })
  it("protects a custom key name draft before Add", async () => {
    await act(async () => host.querySelector<HTMLButtonElement>("#settings-tab-providers")!.click())
    edit(".provider-add-row input:first-child", "CUSTOM_SYNTHETIC_KEY")
    await dismiss("header")
    expect(dialog()).not.toBeNull()
  })
  it("blocks accidental close during pending Save without queuing dismissal", async () => {
    let resolve!: (v: SettingsSavePayload) => void
    saveSettingsBundleMock.mockImplementation(
      () =>
        new Promise<SettingsSavePayload>((r) => {
          resolve = r
        }),
    )
    edit()
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    for (const route of ["backdrop", "header", "escape"]) await dismiss(route)
    expect(closed).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(host.textContent).toContain("Сохраняем…")
    await act(async () =>
      resolve({
        bootstrap: {
          settings: { ...settings, ompExecutable: "synthetic-custom-omp" },
          runtime,
          workspaces: [],
          sessions: [],
          sessionWarnings: [],
        },
        ompConfig,
      }),
    )
    expect(saved).toHaveBeenCalledTimes(1)
    expect(closed).not.toHaveBeenCalled()
    expect(saveSettingsBundleMock).toHaveBeenCalledTimes(1)
  })
  it("still permits explicit Cancel during pending Save and acknowledges only the submitted snapshot", async () => {
    let resolve!: (v: SettingsSavePayload) => void
    saveSettingsBundleMock.mockImplementation(
      () =>
        new Promise<SettingsSavePayload>((r) => {
          resolve = r
        }),
    )
    edit()
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".settings-actions .primary")!.click(),
    )
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".settings-actions .secondary")!.click(),
    )
    expect(closed).toHaveBeenCalledTimes(1)
    expect(noticed).not.toHaveBeenCalled()
    await act(async () =>
      resolve({
        bootstrap: {
          settings: { ...settings, language: "en" },
          runtime,
          workspaces: [],
          sessions: [],
          sessionWarnings: [],
        },
        ompConfig,
      }),
    )
    expect(saved).toHaveBeenCalledTimes(1)
    expect(noticed).toHaveBeenCalledTimes(1)
    expect(noticed.mock.lastCall![0]).toContain("Submitted")
    expect(host.querySelector('[role="status"]')).toBeNull()
    expect(saveSettingsBundleMock).toHaveBeenCalledTimes(1)
  })
})
