import { beforeEach, expect, it, vi } from "vitest"
import { installClientUpdate } from "./clientUpdater"
import { desktopUpdateInstall, desktopUpdateStatus } from "./api"
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
  includePrereleases: true,
  revision: "1",
  checking: false,
  installState: "idle",
  installed: null,
  update: {
    candidateId: "preview-1",
    version: "0.9.12",
    date: null,
    body: null,
    prerelease: true,
    releaseId: "release-1",
    releaseUrl: "https://github.com/Omnividente/omp-desktop/releases/tag/v0.9.12",
  },
}
const installed: DesktopUpdateStatus = {
  ...ready,
  update: null,
  installed: ready.update,
  installState: "installed",
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(desktopUpdateStatus).mockResolvedValue(ready)
  vi.mocked(desktopUpdateInstall).mockImplementation(async () => {
    vi.mocked(desktopUpdateStatus).mockResolvedValue(installed)
    return installed
  })
  vi.mocked(relaunch).mockResolvedValue(undefined)
})

it("retries only process relaunch after confirmed installation and a channel change", async () => {
  vi.mocked(relaunch).mockRejectedValueOnce(new Error("relaunch failed"))
  await expect(installClientUpdate("preview-1")).rejects.toThrow("relaunch failed")
  vi.mocked(desktopUpdateStatus).mockResolvedValue({
    ...installed,
    policyState: "changing",
    includePrereleases: null,
    revision: "2",
  })
  await installClientUpdate("preview-1")
  expect(desktopUpdateInstall).toHaveBeenCalledExactlyOnceWith("preview-1")
  expect(relaunch).toHaveBeenCalledTimes(2)
})

it("reconciles a post-install IPC error and retries relaunch, never installation", async () => {
  vi.mocked(desktopUpdateInstall).mockImplementationOnce(async () => {
    vi.mocked(desktopUpdateStatus).mockResolvedValue(installed)
    throw new Error("IPC reply lost")
  })
  await expect(installClientUpdate("preview-1")).rejects.toThrow("IPC reply lost")
  expect(relaunch).not.toHaveBeenCalled()
  await installClientUpdate("preview-1")
  expect(desktopUpdateInstall).toHaveBeenCalledTimes(1)
  expect(relaunch).toHaveBeenCalledTimes(1)
})

it("coalesces relaunch retries and retains native installed authority after another failure", async () => {
  vi.mocked(desktopUpdateStatus).mockResolvedValue(installed)
  let fail!: (error: Error) => void
  vi.mocked(relaunch).mockReturnValueOnce(
    new Promise((_, reject) => {
      fail = reject
    }),
  )
  const first = installClientUpdate("preview-1")
  const second = installClientUpdate("preview-1")
  const outcomes = Promise.allSettled([first, second])
  await Promise.resolve()
  fail(new Error("relaunch failed again"))
  expect((await outcomes).map((outcome) => outcome.status)).toEqual(["rejected", "rejected"])
  await installClientUpdate("preview-1")
  expect(desktopUpdateInstall).not.toHaveBeenCalled()
  expect(relaunch).toHaveBeenCalledTimes(2)
})
