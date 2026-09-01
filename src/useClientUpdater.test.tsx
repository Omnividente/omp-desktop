/** @vitest-environment jsdom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checkClientUpdate } from "./clientUpdater"
import { UPDATE_REMINDER_SNOOZE_MS, readClientUpdateReminderSnoozedUntil } from "./updateReminder"
import { useClientUpdater } from "./useClientUpdater"

vi.mock("./clientUpdater", () => ({
  checkClientUpdate: vi.fn(),
  installClientUpdate: vi.fn(),
}))

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe("useClientUpdater Desktop reminder", () => {
  let container: HTMLDivElement
  let root: Root
  function Harness() {
    const updater = useClientUpdater("en", vi.fn())
    return (
      <>
        <span>{updater.update?.version ?? "hidden"}</span>
        <button onClick={updater.remindLater} type="button">
          Snooze
        </button>
      </>
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"))
    window.localStorage.clear()
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
})
