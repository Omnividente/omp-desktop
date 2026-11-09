import { beforeEach, expect, it, vi } from "vitest"
import { installClientUpdate } from "./clientUpdater"
import { desktopUpdateCheck, desktopUpdateInstall, desktopUpdateStatus } from "./api"
import { relaunch } from "@tauri-apps/plugin-process"
import type { DesktopUpdateStatus } from "./types"

vi.mock("./api", () => ({
  desktopUpdateCheck: vi.fn(),
  desktopUpdateInstall: vi.fn(),
  desktopUpdateStatus: vi.fn(),
}))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }))
const ready: DesktopUpdateStatus = {
  policyState: "ready",
  includePrereleases: false,
  revision: "1",
  checking: false,
  installState: "idle",
  installed: null,
  update: {
    candidateId: "candidate-1",
    version: "0.9.12",
    date: null,
    body: null,
    prerelease: false,
    releaseId: "release-1",
    releaseUrl: "https://github.com/Omnividente/omp-desktop/releases/tag/v0.9.12",
  },
}
const installed: DesktopUpdateStatus = {
  ...ready,
  installState: "installed",
  installed: ready.update,
  update: null,
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(desktopUpdateStatus).mockResolvedValue(ready)
  vi.mocked(desktopUpdateInstall).mockResolvedValue(installed)
  vi.mocked(relaunch).mockResolvedValue(undefined)
})

it("does not install a candidate invalidated by a fresh native check", async () => {
  vi.mocked(desktopUpdateCheck).mockResolvedValue({ ...ready, update: null })
  await desktopUpdateCheck()
  vi.mocked(desktopUpdateStatus).mockResolvedValue({ ...ready, update: null })
  await expect(installClientUpdate("candidate-1")).rejects.toThrow()
  expect(desktopUpdateInstall).not.toHaveBeenCalled()
  expect(relaunch).not.toHaveBeenCalled()
})

it.each(["notReady", "changing", "uncertain"] as const)(
  "blocks installation under %s policy even with stale metadata",
  async (policyState) => {
    vi.mocked(desktopUpdateStatus).mockResolvedValue({ ...ready, policyState })
    await expect(installClientUpdate("candidate-1")).rejects.toThrow()
    expect(desktopUpdateInstall).not.toHaveBeenCalled()
  },
)

it("reads native status after an unknown IPC outcome and refuses to repeat uncertain installation", async () => {
  vi.mocked(desktopUpdateInstall).mockRejectedValue(new Error("IPC lost after install side effect"))
  const uncertain: DesktopUpdateStatus = { ...ready, installState: "uncertain", update: null }
  vi.mocked(desktopUpdateStatus).mockResolvedValueOnce(ready).mockResolvedValue(uncertain)
  await expect(installClientUpdate("candidate-1")).rejects.toThrow("IPC lost")
  expect(desktopUpdateStatus).toHaveBeenCalledTimes(2)
  await expect(installClientUpdate("candidate-1")).rejects.toThrow()
  expect(desktopUpdateInstall).toHaveBeenCalledTimes(1)
  expect(relaunch).not.toHaveBeenCalled()
})

it("never relaunches on an unconfirmed native install result", async () => {
  vi.mocked(desktopUpdateInstall).mockResolvedValue({ ...ready, installState: "uncertain" })
  await expect(installClientUpdate("candidate-1")).rejects.toThrow()
  expect(relaunch).not.toHaveBeenCalled()
})

it("coalesces duplicate explicit clicks while native installation is in flight", async () => {
  let complete!: (value: DesktopUpdateStatus) => void
  vi.mocked(desktopUpdateInstall).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve
    }),
  )
  const first = installClientUpdate("candidate-1")
  const duplicate = installClientUpdate("candidate-1")
  await Promise.resolve()
  expect(desktopUpdateInstall).toHaveBeenCalledTimes(1)
  complete(installed)
  await Promise.all([first, duplicate])
  expect(relaunch).toHaveBeenCalledTimes(1)
})
