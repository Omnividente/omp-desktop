/** @vitest-environment jsdom */

import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { WorkspaceHome } from "./WorkspaceHome"
import { TerminalWorkspace } from "./TerminalWorkspace"
import { t, type Lang } from "./i18n"

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./TerminalView", () => ({ TerminalView: () => null }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement
let root: Root
let props: ComponentProps<typeof WorkspaceHome>

beforeEach(() => {
  vi.mocked(writeText).mockReset().mockResolvedValue(undefined)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  props = {
    primaryActionRef: { current: null },
    workspace: {
      key: "synthetic-project",
      path: "/synthetic/Example Project",
      name: "Example Project",
      sessionCount: 0,
      lastActive: 0,
      pinned: false,
    },
    sessions: [],
    selectedSession: null,
    runtime: {
      platform: "linux",
      arch: "x64",
      language: "en",
      ompAvailable: true,
      ompExecutable: "omp",
      ompVersion: null,
      sessionRoot: "/synthetic/sessions",
    },
    launching: null,
    lang: "en",
    onError: vi.fn(),
    onReadTranscript: vi.fn(),
    onLaunch: vi.fn(),
    onReveal: vi.fn(),
    onOpenFolder: vi.fn(),
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function render(changes: Partial<typeof props> = {}) {
  props = { ...props, ...changes }
  act(() => root.render(<WorkspaceHome {...props} />))
}

function copy(lang: Lang = props.lang) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label") === t(lang, "copyWorkspacePath"),
  )
  expect(button).toBeDefined()
  return button!
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it.each([
  ["en", "/synthetic/Case Sensitive/Проект e\u0301 🧪/"],
  ["ru", "C:\\Synthetic Projects\\Проект Ω\\"],
  ["en", "\\\\synthetic-server\\share\\Project"],
] as const)("copies the exact %s path only after an explicit click", async (lang, path) => {
  render({ lang, workspace: { ...props.workspace!, path } })
  expect(writeText).not.toHaveBeenCalled()
  expect(copy().textContent).toBe(t(lang, "copyWorkspacePath"))
  await act(async () => copy().click())
  expect(writeText).toHaveBeenCalledExactlyOnceWith(path)
  expect(copy().textContent).toBe(t(lang, "clipboardCopied"))
  expect(props.onReveal).not.toHaveBeenCalled()
  expect(props.onLaunch).not.toHaveBeenCalled()
  expect(props.onOpenFolder).not.toHaveBeenCalled()
})

it("keeps the existing reveal action separate from copy", () => {
  render()
  act(() => container.querySelector<HTMLButtonElement>(".hero-path")!.click())
  expect(props.onReveal).toHaveBeenCalledExactlyOnceWith(props.workspace!.path)
  expect(writeText).not.toHaveBeenCalled()
})

it("does not offer a path when no project is selected", () => {
  render({ workspace: null })
  expect(container.querySelector(".hero-path-actions")).toBeNull()
  expect(writeText).not.toHaveBeenCalled()
})

it("allows copying while OMP is unavailable or another launch is pending", async () => {
  render({ runtime: { ...props.runtime, ompAvailable: false }, launching: "new" })
  expect(copy().disabled).toBe(false)
  await act(async () => copy().click())
  expect(writeText).toHaveBeenCalledExactlyOnceWith(props.workspace!.path)
  expect(props.onLaunch).not.toHaveBeenCalled()
})

it("waits for the clipboard acknowledgement and coalesces repeated clicks", async () => {
  const pending = deferred()
  vi.mocked(writeText).mockReturnValueOnce(pending.promise)
  render()
  const button = copy()
  act(() => {
    button.click()
    button.click()
  })
  expect(writeText).toHaveBeenCalledTimes(1)
  expect(button.disabled).toBe(true)
  expect(button.textContent).toBe(t("en", "copying"))
  await act(async () => pending.resolve())
  expect(button.disabled).toBe(false)
  expect(button.textContent).toBe(t("en", "clipboardCopied"))
})

it("reports a current failure without claiming success and permits an explicit retry", async () => {
  vi.mocked(writeText).mockRejectedValueOnce(new Error("Synthetic clipboard unavailable"))
  render()
  await act(async () => copy().click())
  expect(props.onError).toHaveBeenCalledExactlyOnceWith("Synthetic clipboard unavailable")
  expect(copy().textContent).toBe(t("en", "copyWorkspacePath"))
  expect(copy().disabled).toBe(false)
  await act(async () => copy().click())
  expect(writeText).toHaveBeenCalledTimes(2)
  expect(copy().textContent).toBe(t("en", "clipboardCopied"))
})

it.each(["resolve", "reject"] as const)(
  "ignores late %s feedback after moving to another project path",
  async (outcome) => {
    const old = deferred()
    vi.mocked(writeText).mockReturnValueOnce(old.promise)
    render()
    act(() => copy().click())
    const nextPath = "/synthetic/Another Project"
    render({ workspace: { ...props.workspace!, key: "next", path: nextPath } })
    expect(copy().textContent).toBe(t("en", "copyWorkspacePath"))
    if (outcome === "resolve") await act(async () => old.resolve())
    else await act(async () => old.reject(new Error("Old synthetic failure")))
    expect(props.onError).not.toHaveBeenCalled()
    expect(copy().textContent).toBe(t("en", "copyWorkspacePath"))
    await act(async () => copy().click())
    expect(writeText).toHaveBeenLastCalledWith(nextPath)
    expect(writeText).toHaveBeenCalledTimes(2)
  },
)

it("drops pending feedback when the selected project disappears", async () => {
  const old = deferred()
  vi.mocked(writeText).mockReturnValueOnce(old.promise)
  render()
  act(() => copy().click())
  render({ workspace: null })
  await act(async () => old.reject(new Error("Old synthetic failure")))
  expect(props.onError).not.toHaveBeenCalled()
  expect(container.querySelector(".hero-path-actions")).toBeNull()
})

it("keeps a current copy acknowledgement across a rename and clears it after the timer", async () => {
  vi.useFakeTimers()
  render()
  await act(async () => copy().click())
  render({ workspace: { ...props.workspace!, name: "Renamed project" }, lang: "ru" })
  expect(copy().textContent).toBe(t("ru", "clipboardCopied"))
  act(() => vi.advanceTimersByTime(2000))
  expect(copy().textContent).toBe(t("ru", "copyWorkspacePath"))
  expect(writeText).toHaveBeenCalledTimes(1)
})

it("routes clipboard failures through the real workspace host error callback", async () => {
  vi.mocked(writeText).mockRejectedValueOnce(new Error("Synthetic host error"))
  act(() =>
    root.render(
      <TerminalWorkspace
        activeTabId={null}
        focusRequest={null}
        language="en"
        terminalFontFamily="monospace"
        terminalFontSize={14}
        launching={null}
        installingDesktopUpdate={false}
        ompConfig={null}
        runtime={props.runtime}
        runtimeStatusByTerminal={{}}
        selectedSession={null}
        selectedWorkspace={props.workspace}
        tabs={[]}
        workspaceSessions={[]}
        onCloseTab={vi.fn()}
        onDiscardSwitchRecovery={vi.fn()}
        onError={props.onError}
        onExit={vi.fn()}
        onFocusTab={vi.fn()}
        onFocusTerminal={vi.fn()}
        onShowWorkspace={vi.fn()}
        onLaunch={props.onLaunch}
        onOpenFolder={props.onOpenFolder}
        onReadTranscript={vi.fn()}
        onReady={vi.fn()}
        onReveal={props.onReveal}
        onSendSwitchRecovery={vi.fn()}
        onSwitch={vi.fn()}
        onTogglePrimaryProviderPin={vi.fn()}
        onToggleTitlePin={vi.fn()}
      />,
    ),
  )
  await act(async () => copy().click())
  expect(props.onError).toHaveBeenCalledExactlyOnceWith("Synthetic host error")
})
