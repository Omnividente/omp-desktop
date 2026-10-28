/** @vitest-environment jsdom */
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { open } from "@tauri-apps/plugin-dialog"
import { importSessions } from "./api"
import { SessionCopyModal } from "./SessionCopyModal"
import type { ImportBatchPayload, SessionSummary } from "./types"
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }))
vi.mock("./api", () => ({ importSessions: vi.fn(), errorMessage: (error: Error) => error.message }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const session = {
  id: "old-id",
  title: "Removed worktree",
  cwd: "/gone/worktree",
  filePath: "/synthetic/sessions/old.jsonl",
} as SessionSummary
const bootstrap = {
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
const success = {
  bootstrap,
  items: [
    {
      sourcePath: session.filePath,
      destinationPath: "/synthetic/sessions/new.jsonl",
      status: "imported",
      message: null,
    },
  ],
} as unknown as ImportBatchPayload
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let root: Root
let container: HTMLDivElement
let imported: ReturnType<typeof vi.fn<(result: ImportBatchPayload) => void>>
let closed: ReturnType<typeof vi.fn<() => void>>
let opener: HTMLButtonElement
function button(text: string) {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent === text,
  )
  expect(match).toBeDefined()
  return match!
}
async function mount() {
  await act(async () =>
    root.render(
      <StrictMode>
        <SessionCopyModal
          session={session}
          language="en"
          onImported={imported}
          onClose={() => {
            closed()
            root.render(null)
          }}
        />
      </StrictMode>,
    ),
  )
}
async function choose() {
  await act(async () => button("Choose destination folder").click())
}
async function copy() {
  await act(async () => button("Create copy").click())
}
beforeEach(() => {
  vi.resetAllMocks()
  container = document.createElement("div")
  opener = document.createElement("button")
  document.body.append(opener, container)
  opener.focus()
  root = createRoot(container)
  imported = vi.fn()
  closed = vi.fn()
  vi.mocked(open).mockResolvedValue("/synthetic/live")
  vi.mocked(importSessions).mockResolvedValue(success)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  opener.remove()
})
describe("Session copy confirmation", () => {
  it("accepts explicit null warnings and extra fields without defaulting the snapshot", async () => {
    const extra = {
      ...success,
      bootstrap: { ...success.bootstrap, extraFutureField: { present: true } },
    }
    vi.mocked(importSessions).mockResolvedValue(extra)
    await mount()
    await choose()
    await copy()
    expect(imported).toHaveBeenCalledExactlyOnceWith(extra)
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Copies created")
  })
  it.each([
    { secretStorageWarning: {} },
    { secretStorageWarning: undefined },
    { settingsWarning: {} },
    { settingsWarning: undefined },
    { settingsWarning: { code: "synthetic", message: {}, details: null } },
    { settingsWarning: { code: "synthetic", message: "message", details: {} } },
  ])("rejects invalid present warning values %j", async (warnings) => {
    vi.mocked(importSessions).mockResolvedValue({
      ...success,
      bootstrap: { ...success.bootstrap, settings: { ...success.bootstrap.settings, ...warnings } },
    } as unknown as ImportBatchPayload)
    await mount()
    await choose()
    await copy()
    expect(imported).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not confirmed")
  })
  it.each([0, 8640000000000000])("accepts valid Date boundary %s", async (time) => {
    const snapshot = structuredClone(success)
    snapshot.bootstrap.sessions[0].updatedAt = time
    snapshot.bootstrap.workspaces[0].lastActive = time
    vi.mocked(importSessions).mockResolvedValue(snapshot)
    await mount()
    await choose()
    await copy()
    expect(imported).toHaveBeenCalledExactlyOnceWith(snapshot)
  })

  it.each([null, {}, { sessions: null }, { sessions: [] }])(
    "rejects unusable bootstrap %j before calling the consumer",
    async (snapshot) => {
      vi.mocked(importSessions).mockResolvedValue({
        ...success,
        bootstrap: snapshot,
      } as unknown as ImportBatchPayload)
      await mount()
      await choose()
      await copy()
      expect(imported).not.toHaveBeenCalled()
      expect(container.querySelector('[role="status"]')).toBeNull()
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("not confirmed")
      expect(button("Create copy").disabled).toBe(true)
    },
  )
  it("never publishes success when the consumer throws", async () => {
    imported.mockImplementation(() => {
      throw new Error("Consumer rejected snapshot")
    })
    await mount()
    await choose()
    await copy()
    expect(imported).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not confirmed")
    expect(button("Create copy").disabled).toBe(true)
    expect(importSessions).toHaveBeenCalledOnce()
  })
  it("waits for asynchronous consumer acceptance before success and locks on rejection", async () => {
    let reject!: (error: Error) => void
    const acceptance = new Promise<void>((_resolve, fail) => {
      reject = fail
    })
    imported.mockImplementation(() => acceptance)
    await mount()
    await choose()
    await copy()
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(
      container.querySelector<HTMLButtonElement>(".settings-actions .secondary")?.disabled,
    ).toBe(true)
    await act(async () => reject(new Error("Acceptance failed")))
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not confirmed")
    expect(button("Create copy").disabled).toBe(true)
  })

  it("requires destination then explicit confirmation, defaults skip and cannot update", async () => {
    await mount()
    expect(button("Create copy").disabled).toBe(true)
    await choose()
    expect(importSessions).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Choose destination folder",
    })
    expect(container.textContent).toContain("/synthetic/live")
    expect([...container.querySelectorAll("option")].map((o) => o.value)).toEqual(["skip", "copy"])
    await copy()
    expect(importSessions).toHaveBeenCalledExactlyOnceWith([
      { path: session.filePath, targetCwd: "/synthetic/live", mode: "skip" },
    ])
    expect(imported).toHaveBeenCalledExactlyOnceWith(success)
    expect(button("Create copy").disabled).toBe(true)
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Copies created")
  })
  it("sends explicit copy only after it is chosen", async () => {
    await mount()
    await choose()
    const select = container.querySelector("select")!
    act(() => {
      select.value = "copy"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await copy()
    expect(importSessions).toHaveBeenCalledWith([
      { path: session.filePath, targetCwd: "/synthetic/live", mode: "copy" },
    ])
  })
  it("does nothing after destination picker cancellation", async () => {
    vi.mocked(open).mockResolvedValue(null)
    await mount()
    await choose()
    expect(button("Create copy").disabled).toBe(true)
    expect(importSessions).not.toHaveBeenCalled()
  })
  it("ignores a picker completing after Cancel and restores opener focus", async () => {
    const pending = deferred<string>()
    vi.mocked(open).mockReturnValue(pending.promise)
    await mount()
    await choose()
    act(() => button("Cancel").click())
    await act(async () => pending.resolve("/synthetic/live"))
    expect(closed).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(opener)
    expect(importSessions).not.toHaveBeenCalled()
    expect(container.textContent).toBe("")
  })
  it("does not apply old picker result to a replacement dialog", async () => {
    const pending = deferred<string>()
    vi.mocked(open).mockReturnValue(pending.promise)
    await mount()
    await choose()
    await act(async () =>
      root.render(
        <SessionCopyModal
          key="new"
          session={{ ...session, filePath: "/new.jsonl" }}
          language="en"
          onImported={imported}
          onClose={closed}
        />,
      ),
    )
    await act(async () => pending.resolve("/synthetic/old-target"))
    expect(container.textContent).not.toContain("old-target")
    expect(button("Create copy").disabled).toBe(true)
  })
  it("serializes repeated confirms and blocks dismissal while a write is pending", async () => {
    const pending = deferred<ImportBatchPayload>()
    vi.mocked(importSessions).mockReturnValue(pending.promise)
    await mount()
    await choose()
    await act(async () => {
      const confirm = button("Create copy")
      confirm.click()
      confirm.click()
    })
    act(() =>
      container
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    )
    expect(importSessions).toHaveBeenCalledOnce()
    expect(closed).not.toHaveBeenCalled()
    await act(async () => pending.resolve(success))
    expect(imported).toHaveBeenCalledOnce()
  })
  it("suppresses completion after unmount without retrying the import", async () => {
    const pending = deferred<ImportBatchPayload>()
    vi.mocked(importSessions).mockReturnValue(pending.promise)
    await mount()
    await choose()
    await copy()
    act(() => root.render(null))
    await act(async () => pending.resolve(success))
    expect(imported).not.toHaveBeenCalled()
    expect(importSessions).toHaveBeenCalledOnce()
  })
  it("reports skip without claiming creation", async () => {
    vi.mocked(importSessions).mockResolvedValue({
      ...success,
      items: [{ ...success.items[0], status: "skipped" }],
    })
    await mount()
    await choose()
    await copy()
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Skipped")
    expect(button("Create copy").disabled).toBe(true)
  })
  it("keeps a known failed import open with the source and destination unchanged", async () => {
    vi.mocked(importSessions).mockResolvedValue({
      ...success,
      items: [
        {
          ...success.items[0],
          status: "failed",
          destinationPath: null,
          message: "Folder no longer exists",
        },
      ],
    })
    await mount()
    await choose()
    await copy()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Folder no longer exists")
    expect(button("Create copy").disabled).toBe(false)
    expect(imported).not.toHaveBeenCalled()
    expect(container.textContent).toContain(session.filePath)
    expect(container.textContent).toContain("/synthetic/live")
  })
  it("does not blindly resend after an uncertain IPC rejection", async () => {
    vi.mocked(importSessions).mockRejectedValue(new Error("Disconnected"))
    await mount()
    await choose()
    await copy()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not confirmed")
    expect(button("Create copy").disabled).toBe(true)
    expect(imported).not.toHaveBeenCalled()
  })
  it("does not trust an unrelated or missing response item", async () => {
    vi.mocked(importSessions).mockResolvedValue({ ...success, items: [] })
    await mount()
    await choose()
    await copy()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not confirmed")
    expect(imported).not.toHaveBeenCalled()
  })
  it("shows directory picker errors without importing", async () => {
    vi.mocked(open).mockRejectedValue(new Error("Permission refused"))
    await mount()
    await choose()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Permission refused")
    expect(importSessions).not.toHaveBeenCalled()
  })
})
