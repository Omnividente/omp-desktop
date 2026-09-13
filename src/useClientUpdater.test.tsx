/** @vitest-environment jsdom */

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { confirm } from "@tauri-apps/plugin-dialog"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checkClientUpdate, installClientUpdate } from "./clientUpdater"
import { UPDATE_REMINDER_SNOOZE_MS, readClientUpdateReminderSnoozedUntil } from "./updateReminder"
import { useClientUpdater } from "./useClientUpdater"

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
  function Harness({ running = 0, launching = false } = {}) {
    const [error, setError] = useState("")
    const [notice, setNotice] = useState("")
    const updater = useClientUpdater("en", setError, setNotice, {
      runningTerminalCount: running,
      launching,
    })
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

  it("does not install with running terminals when confirmation is cancelled", async () => {
    let decide!: (accepted: boolean) => void
    vi.mocked(confirm).mockReturnValue(
      new Promise((resolve) => {
        decide = resolve
      }),
    )
    await act(async () => root.render(<Harness running={3} />))
    const install = () => container.querySelectorAll<HTMLButtonElement>("button")[2]
    await act(async () => install().click())
    expect(install().disabled).toBe(true)
    expect(installClientUpdate).not.toHaveBeenCalled()
    await act(async () => install().click())
    expect(confirm).toHaveBeenCalledTimes(1)
    await act(async () => decide(false))
    expect(install().disabled).toBe(false)
    expect(installClientUpdate).not.toHaveBeenCalled()
    expect(container.querySelector("span")?.textContent).toBe("0.8.0")
  })

  it("requires confirmation for a running terminal and recovers from installation failure", async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    vi.mocked(installClientUpdate).mockRejectedValueOnce(new Error("download-failed"))
    await act(async () => root.render(<Harness running={1} />))
    const install = () => container.querySelectorAll<HTMLButtonElement>("button")[2]
    await act(async () => install().click())
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(installClientUpdate).toHaveBeenCalledTimes(1)
    expect(container.querySelector("output")?.textContent).toContain("download-failed")
    expect(install().disabled).toBe(false)
    await act(async () => install().click())
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(installClientUpdate).toHaveBeenCalledTimes(2)
  })

  it("waits for an in-flight terminal launch but installs directly when none are running", async () => {
    await act(async () => root.render(<Harness launching />))
    const install = () => container.querySelectorAll<HTMLButtonElement>("button")[2]
    await act(async () => install().click())
    expect(installClientUpdate).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    await act(async () => root.render(<Harness />))
    await act(async () => install().click())
    expect(installClientUpdate).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalled()
  })
})
