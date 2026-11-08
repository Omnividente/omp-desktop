/** @vitest-environment jsdom */

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { confirm } from "@tauri-apps/plugin-dialog"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installClientUpdate } from "./clientUpdater"
import { UPDATE_REMINDER_SNOOZE_MS, readClientUpdateReminderSnoozedUntil } from "./updateReminder"
import { useClientUpdater, type ClientUpdaterState } from "./useClientUpdater"
import { desktopUpdateCheck, desktopUpdateStatus } from "./api"
import { listen, type EventCallback } from "@tauri-apps/api/event"
import type { DesktopUpdateStatus } from "./types"

const ready: DesktopUpdateStatus = {
  policyState: "ready",
  includePrereleases: false,
  revision: "1",
  checking: false,
  installState: "idle",
  installed: null,
  update: {
    candidateId: "candidate-1",
    version: "0.8.0",
    date: null,
    body: "Release details",
    prerelease: false,
    releaseId: "release-1",
    releaseUrl: "https://github.com/Omnividente/omp-desktop/releases/tag/v0.8.0",
  },
}
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  desktopUpdateCheck: vi.fn(),
  desktopUpdateStatus: vi.fn(),
}))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }))

vi.mock("./clientUpdater", () => ({
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
    vi.mocked(desktopUpdateCheck).mockResolvedValue(ready)
    vi.mocked(desktopUpdateStatus).mockResolvedValue(ready)
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
    vi.mocked(desktopUpdateCheck).mockResolvedValue({
      ...ready,
      update: { ...ready.update!, candidateId: "candidate-2", version: "0.9.3" },
    })
    await act(async () => container.querySelectorAll<HTMLButtonElement>("button")[1].click())
    expect(container.querySelector("span")?.textContent).toBe("0.9.3")
    expect(readClientUpdateReminderSnoozedUntil()).toBe(0)
  })

  it("reports a failed manual check and discards the obsolete offer", async () => {
    await act(async () => root.render(<Harness />))
    vi.mocked(desktopUpdateCheck).mockRejectedValue(new Error("offline-smoke"))
    await act(async () => container.querySelectorAll<HTMLButtonElement>("button")[1].click())
    expect(container.querySelector("output")?.textContent).toContain("offline-smoke")
    expect(container.querySelector("span")?.textContent).toBe("hidden")
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

  it("rejects an older event revision without rounding u64 counters to Number", async () => {
    await act(async () => root.render(<Harness />))
    const receive = vi
      .mocked(listen)
      .mock.calls.find(
        ([event]) => event === "desktop-update-state",
      )![1] as EventCallback<DesktopUpdateStatus>
    const uncertain: DesktopUpdateStatus = {
      ...ready,
      revision: "9007199254740993",
      policyState: "uncertain",
      update: null,
    }
    act(() => receive({ event: "desktop-update-state", id: 1, payload: uncertain }))
    act(() =>
      receive({
        event: "desktop-update-state",
        id: 2,
        payload: { ...ready, revision: "9007199254740992" },
      }),
    )
    expect(container.querySelector("span")?.textContent).toBe("hidden")
    act(() => updater.install())
    expect(installClientUpdate).not.toHaveBeenCalled()
  })

  it.each(["changing", "uncertain", "notReady"] as const)(
    "hides a displayed offer immediately on a native %s event",
    async (policyState) => {
      await act(async () => root.render(<Harness />))
      expect(container.querySelector("span")?.textContent).toBe(ready.update!.version)
      const receive = vi
        .mocked(listen)
        .mock.calls.find(
          ([event]) => event === "desktop-update-state",
        )![1] as EventCallback<DesktopUpdateStatus>
      const payload: DesktopUpdateStatus = {
        ...ready,
        policyState,
        includePrereleases: null,
        revision: "2",
      }
      // Even stale metadata in an invalidated snapshot cannot remain actionable.
      act(() => receive({ event: "desktop-update-state", id: 1, payload }))
      expect(container.querySelector("span")?.textContent).toBe("hidden")
      act(() => updater.install())
      expect(installClientUpdate).not.toHaveBeenCalled()
    },
  )

  it.each(["changing", "uncertain", "notReady"] as const)(
    "invalidates an offer immediately on %s and rejects a late old-channel check",
    async (policyState) => {
      await act(async () => root.render(<Harness />))
      const receive = vi
        .mocked(listen)
        .mock.calls.find(
          ([event]) => event === "desktop-update-state",
        )![1] as EventCallback<DesktopUpdateStatus>
      let complete!: (value: DesktopUpdateStatus) => void
      vi.mocked(desktopUpdateCheck).mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve
        }),
      )
      act(() => updater.checkNow())
      expect(container.querySelector("span")?.textContent).toBe("hidden")
      const changed: DesktopUpdateStatus = {
        ...ready,
        policyState,
        update: null,
        revision: "2",
        includePrereleases: null,
      }
      vi.mocked(desktopUpdateStatus).mockResolvedValue(changed)
      act(() => receive({ event: "desktop-update-state", id: 1, payload: changed }))
      expect(container.querySelectorAll<HTMLButtonElement>("button")[1].disabled).toBe(false)
      act(() => updater.install())
      expect(installClientUpdate).not.toHaveBeenCalled()
      const fresh: DesktopUpdateStatus = {
        ...ready,
        revision: "4",
        includePrereleases: true,
        update: {
          ...ready.update!,
          candidateId: "fresh-preview",
          version: "0.9.11",
          prerelease: true,
        },
      }
      act(() =>
        receive({
          event: "desktop-update-state",
          id: 2,
          payload: { ...fresh, revision: "3", update: null },
        }),
      )
      vi.mocked(desktopUpdateCheck).mockResolvedValueOnce(fresh)
      vi.mocked(desktopUpdateStatus).mockResolvedValue(fresh)
      await act(async () => container.querySelectorAll<HTMLButtonElement>("button")[1].click())
      expect(container.querySelector("span")?.textContent).toBe("0.9.11")
      await act(async () => complete(ready))
      expect(container.querySelector("span")?.textContent).toBe("0.9.11")
      expect(container.querySelector("output")?.textContent).not.toContain("up to date")
    },
  )

  it("keeps the superseding fresh check when an older response arrives later", async () => {
    await act(async () => root.render(<Harness />))
    let old!: (value: DesktopUpdateStatus) => void
    vi.mocked(desktopUpdateCheck).mockReturnValueOnce(
      new Promise((resolve) => {
        old = resolve
      }),
    )
    act(() => updater.checkNow())
    vi.mocked(desktopUpdateCheck).mockResolvedValueOnce({
      ...ready,
      update: { ...ready.update!, candidateId: "fresh", version: "0.9.9" },
    })
    await act(async () => updater.checkNow())
    await act(async () => old(ready))
    expect(container.querySelector("span")?.textContent).toBe("0.9.9")
  })

  it("uses GitHub prerelease metadata for plain SemVer and rechecks safety after confirmation", async () => {
    const preview = {
      ...ready,
      includePrereleases: true,
      update: { ...ready.update!, version: "0.9.11", prerelease: true },
    }
    vi.mocked(desktopUpdateCheck).mockResolvedValue(preview)
    vi.mocked(desktopUpdateStatus).mockResolvedValue(preview)
    let decide!: (value: boolean) => void
    vi.mocked(confirm).mockReturnValueOnce(
      new Promise((resolve) => {
        decide = resolve
      }),
    )
    let launching = false
    await act(async () =>
      root.render(<Harness safety={() => ({ runningTerminalCount: 0, launching })} />),
    )
    act(() => updater.install())
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("0.9.11")
    expect(installClientUpdate).not.toHaveBeenCalled()
    launching = true
    await act(async () => decide(true))
    expect(installClientUpdate).not.toHaveBeenCalled()
    expect(updater.isInstalling()).toBe(false)
  })

  it("does not install after a policy event invalidates an async confirmation", async () => {
    await act(async () => root.render(<Harness running={1} />))
    const receive = vi
      .mocked(listen)
      .mock.calls.find(
        ([event]) => event === "desktop-update-state",
      )![1] as EventCallback<DesktopUpdateStatus>
    let decide!: (value: boolean) => void
    vi.mocked(confirm).mockReturnValueOnce(
      new Promise((resolve) => {
        decide = resolve
      }),
    )
    act(() => updater.install())
    const next: DesktopUpdateStatus = {
      ...ready,
      revision: "2",
      policyState: "changing",
      update: null,
    }
    vi.mocked(desktopUpdateStatus).mockResolvedValue(next)
    act(() => receive({ event: "desktop-update-state", id: 1, payload: next }))
    await act(async () => decide(true))
    expect(installClientUpdate).not.toHaveBeenCalled()
    expect(container.querySelector("span")?.textContent).toBe("hidden")
  })

  it("unsubscribes and ignores a pending confirmation after unmount", async () => {
    const unlisten = vi.fn()
    vi.mocked(listen).mockResolvedValueOnce(unlisten)
    await act(async () => root.render(<Harness running={1} />))
    let decide!: (value: boolean) => void
    vi.mocked(confirm).mockReturnValueOnce(
      new Promise((resolve) => {
        decide = resolve
      }),
    )
    act(() => updater.install())
    await act(async () => root.render(null))
    await act(async () => decide(true))
    expect(installClientUpdate).not.toHaveBeenCalled()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("requires preview consent before plain SemVer install and confirms newly active terminals", async () => {
    const preview = {
      ...ready,
      includePrereleases: true,
      update: { ...ready.update!, version: "0.9.11", prerelease: true },
    }
    vi.mocked(desktopUpdateCheck).mockResolvedValue(preview)
    vi.mocked(desktopUpdateStatus).mockResolvedValue(preview)
    let running = 0
    let decidePreview!: (value: boolean) => void
    vi.mocked(confirm)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          decidePreview = resolve
        }),
      )
      .mockResolvedValueOnce(false)
    await act(async () =>
      root.render(<Harness safety={() => ({ runningTerminalCount: running, launching: false })} />),
    )
    act(() => updater.install())
    expect(installClientUpdate).not.toHaveBeenCalled()
    running = 2
    await act(async () => decidePreview(true))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(vi.mocked(confirm).mock.calls[1][0]).toContain("2")
    expect(installClientUpdate).not.toHaveBeenCalled()
    vi.mocked(confirm).mockResolvedValue(true)
    await act(async () => updater.install())
    expect(installClientUpdate).toHaveBeenCalledExactlyOnceWith(preview.update.candidateId)
  })

  it("does not resurrect a pending check after unmount and a different-policy remount", async () => {
    await act(async () => root.render(<Harness />))
    let finish!: (value: DesktopUpdateStatus) => void
    vi.mocked(desktopUpdateCheck).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    act(() => updater.checkNow())
    await act(async () => root.render(null))
    const next: DesktopUpdateStatus = {
      ...ready,
      revision: "2",
      includePrereleases: true,
      update: null,
    }
    vi.mocked(desktopUpdateStatus).mockResolvedValue(next)
    vi.mocked(desktopUpdateCheck).mockResolvedValue(next)
    await act(async () => root.render(<Harness />))
    await act(async () => finish(ready))
    expect(container.querySelector("span")?.textContent).toBe("hidden")
    act(() => updater.install())
    expect(installClientUpdate).not.toHaveBeenCalled()
  })
})
