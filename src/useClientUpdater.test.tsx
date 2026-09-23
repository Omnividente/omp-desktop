/** @vitest-environment jsdom */

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { confirm } from "@tauri-apps/plugin-dialog"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checkClientUpdate, installClientUpdate } from "./clientUpdater"
import { UPDATE_REMINDER_SNOOZE_MS, readClientUpdateReminderSnoozedUntil } from "./updateReminder"
import { useClientUpdater, type ClientUpdaterState } from "./useClientUpdater"

vi.mock("./clientUpdater", () => ({
  checkClientUpdate: vi.fn(),
  installClientUpdate: vi.fn(),
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }))
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe("useClientUpdater Desktop reminder", () => {
  let container: HTMLDivElement
  let root: Root
  let updater: ClientUpdaterState
  function Harness({
    running = 0,
    safety = () => ({ runningTerminalCount: running, launching: false }),
  }: {
    running?: number
    safety?: Parameters<typeof useClientUpdater>[3]
  } = {}) {
    const [error, setError] = useState("")
    const [notice, setNotice] = useState("")
    updater = useClientUpdater("en", setError, setNotice, safety)
    return (
      <>
        <span>{updater.update?.version ?? "hidden"}</span>
        <button onClick={updater.remindLater} type="button">
          Snooze
        </button>
        <button onClick={updater.checkNow} disabled={updater.checking} type="button">
          Check
        </button>
        <button onClick={updater.install} disabled={updater.installing} type="button">
          Install
        </button>
        <output>{error || notice}</output>
      </>
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"))
    window.localStorage.clear()
    vi.mocked(confirm).mockResolvedValue(false)
    vi.mocked(installClientUpdate).mockResolvedValue(undefined)
    vi.mocked(checkClientUpdate).mockResolvedValue({
      version: "0.8.0",
      date: null,
      body: "Release details",
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    window.localStorage.clear()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("hides an available update for five hours and restores it at the deadline", async () => {
    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
    })
    const displayedVersion = () => container.querySelector("span")?.textContent
    expect(displayedVersion()).toBe("0.8.0")

    act(() => container.querySelector<HTMLButtonElement>("button")?.click())
    expect(displayedVersion()).toBe("hidden")
    expect(readClientUpdateReminderSnoozedUntil()).toBe(Date.now() + UPDATE_REMINDER_SNOOZE_MS)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_REMINDER_SNOOZE_MS)
    })
    expect(displayedVersion()).toBe("0.8.0")
    expect(readClientUpdateReminderSnoozedUntil()).toBe(0)
  })

  it("a manual check fetches a fresh version and overrides the saved reminder delay", async () => {
    await act(async () => root.render(<Harness />))
    act(() => container.querySelector<HTMLButtonElement>("button")?.click())
    expect(container.querySelector("span")?.textContent).toBe("hidden")
    vi.mocked(checkClientUpdate).mockResolvedValue({ version: "0.9.3", date: null, body: null })
    await act(async () => container.querySelectorAll<HTMLButtonElement>("button")[1].click())
    expect(container.querySelector("span")?.textContent).toBe("0.9.3")
    expect(readClientUpdateReminderSnoozedUntil()).toBe(0)
  })

  it("reports a failed manual check without discarding an already available update", async () => {
    await act(async () => root.render(<Harness />))
    vi.mocked(checkClientUpdate).mockRejectedValue(new Error("offline-smoke"))
    await act(async () => container.querySelectorAll<HTMLButtonElement>("button")[1].click())
    expect(container.querySelector("output")?.textContent).toContain("offline-smoke")
    expect(container.querySelector("span")?.textContent).toBe("0.8.0")
    expect(container.querySelectorAll<HTMLButtonElement>("button")[1].disabled).toBe(false)
  })

  it("holds the synchronous guard during confirmation and releases it on cancellation", async () => {
    let decide!: (accepted: boolean) => void
    vi.mocked(confirm).mockReturnValueOnce(
      new Promise((resolve) => {
        decide = resolve
      }),
    )
    await act(async () => root.render(<Harness running={3} />))
    const isInstalling = updater.isInstalling
    const launch = vi.fn()
    const launchIfAllowed = () => {
      if (!isInstalling()) launch()
    }
    const install = () => container.querySelectorAll<HTMLButtonElement>("button")[2]
    act(() => {
      updater.install()
      launchIfAllowed()
      updater.install()
      expect(isInstalling()).toBe(true)
    })
    expect(updater.isInstalling).toBe(isInstalling)
    expect(install().disabled).toBe(true)
    expect(launch).not.toHaveBeenCalled()
    expect(installClientUpdate).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledTimes(1)
    await act(async () => decide(false))
    launchIfAllowed()
    expect(isInstalling()).toBe(false)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(install().disabled).toBe(false)
    expect(installClientUpdate).not.toHaveBeenCalled()
    expect(container.querySelector("span")?.textContent).toBe("0.8.0")
    vi.mocked(confirm).mockResolvedValueOnce(true)
    await act(async () => install().click())
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(installClientUpdate).toHaveBeenCalledTimes(1)
  })

  it("keeps callers blocked from confirmation through installation and recovers after failure", async () => {
    let decide!: (accepted: boolean) => void
    let failInstall!: (error: Error) => void
    vi.mocked(confirm).mockReturnValueOnce(
      new Promise((resolve) => {
        decide = resolve
      }),
    )
    vi.mocked(installClientUpdate).mockReturnValueOnce(
      new Promise((_, reject) => {
        failInstall = reject
      }),
    )
    await act(async () => root.render(<Harness running={1} />))
    const isInstalling = updater.isInstalling
    const restart = vi.fn()
    const restartIfAllowed = () => {
      if (!isInstalling()) restart()
    }
    act(() => {
      updater.install()
      restartIfAllowed()
    })
    expect(restart).not.toHaveBeenCalled()
    expect(installClientUpdate).not.toHaveBeenCalled()
    await act(async () => decide(true))
    act(() => {
      restartIfAllowed()
      updater.install()
    })
    expect(isInstalling()).toBe(true)
    expect(updater.isInstalling).toBe(isInstalling)
    expect(restart).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(installClientUpdate).toHaveBeenCalledTimes(1)
    await act(async () => failInstall(new Error("download-failed")))
    restartIfAllowed()
    expect(isInstalling()).toBe(false)
    expect(restart).toHaveBeenCalledTimes(1)
    expect(container.querySelector("output")?.textContent).toContain("download-failed")
    expect(container.querySelectorAll<HTMLButtonElement>("button")[2].disabled).toBe(false)
    vi.mocked(confirm).mockResolvedValueOnce(true)
    await act(async () => updater.install())
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(installClientUpdate).toHaveBeenCalledTimes(2)
    expect(isInstalling()).toBe(false)
  })

  it("reads a pending restart without a rerender and installs only after it settles", async () => {
    let finishRestart!: () => void
    let restarting = false
    const safety = () => ({ runningTerminalCount: 0, launching: restarting })
    await act(async () => root.render(<Harness safety={safety} />))
    const install = updater.install
    restarting = true
    const pendingRestart = new Promise<void>((resolve) => {
      finishRestart = resolve
    }).then(() => {
      restarting = false
    })
    act(() => install())
    expect(installClientUpdate).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(updater.isInstalling()).toBe(false)
    await act(async () => {
      finishRestart()
      await pendingRestart
      install()
    })
    expect(installClientUpdate).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalled()
  })
})
