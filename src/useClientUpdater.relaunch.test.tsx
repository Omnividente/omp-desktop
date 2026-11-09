/** @vitest-environment jsdom */

import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { useClientUpdater, type ClientUpdaterState } from "./useClientUpdater"
import { desktopUpdateCheck, desktopUpdateInstall, desktopUpdateStatus } from "./api"
import { relaunch } from "@tauri-apps/plugin-process"
import { confirm } from "@tauri-apps/plugin-dialog"
import type { DesktopUpdateStatus } from "./types"

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  desktopUpdateStatus: vi.fn(),
  desktopUpdateCheck: vi.fn(),
  desktopUpdateInstall: vi.fn(),
}))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const container = document.createElement("div")
const root = createRoot(container)
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.localStorage.clear()
})

it("reconfirms a user retry after relaunch failure without reinstalling after a policy switch", async () => {
  window.localStorage.clear()
  document.body.appendChild(container)
  const ready: DesktopUpdateStatus = {
    policyState: "ready",
    includePrereleases: true,
    revision: "1",
    checking: false,
    installState: "idle",
    installed: null,
    update: {
      candidateId: "preview",
      version: "0.9.11",
      date: null,
      body: null,
      prerelease: true,
      releaseId: "release",
      releaseUrl: "https://github.com/Omnividente/omp-desktop/releases/tag/v0.9.11",
    },
  }
  let actual = ready
  vi.mocked(desktopUpdateStatus).mockImplementation(async () => actual)
  vi.mocked(desktopUpdateCheck).mockImplementation(async () => actual)
  vi.mocked(desktopUpdateInstall).mockImplementation(async () => {
    actual = {
      ...ready,
      policyState: "changing",
      revision: "2",
      includePrereleases: null,
      installState: "installed",
      installed: ready.update,
      update: null,
    }
    return actual
  })
  vi.mocked(confirm).mockResolvedValue(true)
  vi.mocked(relaunch).mockRejectedValueOnce(new Error("relaunch failed"))
  let updater!: ClientUpdaterState
  let running = 1
  function Harness() {
    const [error, showError] = useState("")
    const [, showNotice] = useState("")
    updater = useClientUpdater("en", showError, showNotice, () => ({
      runningTerminalCount: running,
      launching: false,
    }))
    return (
      <>
        <span>{updater.update?.version}</span>
        <output>{error}</output>
        <button onClick={updater.install} disabled={updater.installing} type="button">
          Install
        </button>
      </>
    )
  }
  await act(async () => root.render(<Harness />))
  await act(async () => container.querySelector("button")!.click())
  expect(container.querySelector("output")?.textContent).toContain("relaunch failed")
  expect(container.querySelector("span")?.textContent).toBe("0.9.11")
  expect(confirm).toHaveBeenCalledTimes(2) // Explicit preview confirmation and active terminals.
  expect(updater.isInstalling()).toBe(false)

  running = 2
  let decide!: (accepted: boolean) => void
  vi.mocked(confirm).mockReturnValueOnce(
    new Promise((resolve) => {
      decide = resolve
    }),
  )
  act(() => {
    updater.install()
    updater.install()
  })
  expect(updater.isInstalling()).toBe(true)
  expect(confirm).toHaveBeenCalledTimes(3)
  expect(vi.mocked(confirm).mock.calls[2][0]).toContain("2")
  await act(async () => decide(false))
  expect(relaunch).toHaveBeenCalledTimes(1)
  expect(desktopUpdateInstall).toHaveBeenCalledTimes(1)

  vi.mocked(confirm).mockResolvedValueOnce(true)
  vi.mocked(relaunch).mockResolvedValueOnce(undefined)
  await act(async () => container.querySelector("button")!.click())
  expect(confirm).toHaveBeenCalledTimes(4)
  expect(relaunch).toHaveBeenCalledTimes(2)
  expect(desktopUpdateInstall).toHaveBeenCalledTimes(1)
  expect(updater.isInstalling()).toBe(false)
})
