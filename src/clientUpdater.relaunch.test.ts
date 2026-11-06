import { beforeEach, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }))
vi.mock("@tauri-apps/plugin-updater", () => ({ check: sdk.check }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: sdk.relaunch }))

let updater: typeof import("./clientUpdater")

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  sdk.relaunch.mockResolvedValue(undefined)
  updater = await import("./clientUpdater")
})

function candidate() {
  return {
    version: "0.9.11",
    date: "2026-11-05",
    body: "Synthetic release",
    close: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  }
}

it("retries only relaunch after installation succeeded", async () => {
  const update = candidate()
  sdk.check.mockResolvedValue(update)
  await updater.checkClientUpdate()
  sdk.relaunch.mockRejectedValueOnce(new Error("relaunch failed"))

  await expect(updater.installClientUpdate()).rejects.toThrow("relaunch failed")
  await expect(updater.installClientUpdate()).resolves.toBeUndefined()

  expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)
  expect(update.close).toHaveBeenCalledTimes(1)
  expect(sdk.relaunch).toHaveBeenCalledTimes(2)
})

it("retains installed metadata without checking or installing another candidate", async () => {
  const update = candidate()
  const newer = { ...candidate(), version: "0.9.12" }
  sdk.check.mockResolvedValueOnce(update).mockResolvedValue(newer)
  await updater.checkClientUpdate()
  sdk.relaunch.mockRejectedValueOnce(new Error("relaunch failed"))
  await expect(updater.installClientUpdate()).rejects.toThrow("relaunch failed")

  await expect(updater.checkClientUpdate()).resolves.toEqual({
    version: update.version,
    date: update.date,
    body: update.body,
  })
  expect(sdk.check).toHaveBeenCalledTimes(1)
  await updater.installClientUpdate()
  expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)
  expect(newer.downloadAndInstall).not.toHaveBeenCalled()

  await expect(updater.checkClientUpdate()).resolves.toMatchObject({ version: newer.version })
  expect(sdk.check).toHaveBeenCalledTimes(2)
})

it("coalesces concurrent relaunch retries and retains recovery after another failure", async () => {
  const update = candidate()
  sdk.check.mockResolvedValue(update)
  await updater.checkClientUpdate()
  sdk.relaunch.mockRejectedValueOnce(new Error("first relaunch failed"))
  await expect(updater.installClientUpdate()).rejects.toThrow("first relaunch failed")

  let rejectRelaunch!: (reason: Error) => void
  sdk.relaunch.mockReturnValueOnce(
    new Promise<void>((_, reject) => {
      rejectRelaunch = reject
    }),
  )
  const first = updater.installClientUpdate()
  const second = updater.installClientUpdate()
  const outcomes = Promise.allSettled([first, second])
  const duringRetry = updater.checkClientUpdate()
  expect(sdk.relaunch).toHaveBeenCalledTimes(2)
  rejectRelaunch(new Error("second relaunch failed"))
  expect(await outcomes).toEqual([
    { status: "rejected", reason: new Error("second relaunch failed") },
    { status: "rejected", reason: new Error("second relaunch failed") },
  ])
  await expect(duringRetry).resolves.toMatchObject({ version: update.version })

  await expect(updater.installClientUpdate()).resolves.toBeUndefined()
  expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)
  expect(update.close).toHaveBeenCalledTimes(1)
  expect(sdk.relaunch).toHaveBeenCalledTimes(3)
  expect(sdk.check).toHaveBeenCalledTimes(1)
})

it("retains relaunch recovery even if releasing the installed SDK resource failed", async () => {
  const update = candidate()
  update.close.mockRejectedValue(new Error("resource already consumed"))
  sdk.check.mockResolvedValue(update)
  await updater.checkClientUpdate()
  sdk.relaunch.mockRejectedValueOnce(new Error("relaunch failed"))

  await expect(updater.installClientUpdate()).rejects.toThrow("relaunch failed")
  await expect(updater.installClientUpdate()).resolves.toBeUndefined()
  expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)
  expect(update.close).toHaveBeenCalledTimes(1)
  expect(sdk.relaunch).toHaveBeenCalledTimes(2)
})

it("does not treat a failed installation as ready to relaunch", async () => {
  const update = candidate()
  update.downloadAndInstall.mockRejectedValueOnce(new Error("download failed"))
  sdk.check.mockResolvedValue(update)
  await updater.checkClientUpdate()

  await expect(updater.installClientUpdate()).rejects.toThrow("download failed")
  expect(update.close).not.toHaveBeenCalled()
  expect(sdk.relaunch).not.toHaveBeenCalled()
  await expect(updater.installClientUpdate()).resolves.toBeUndefined()
  expect(update.downloadAndInstall).toHaveBeenCalledTimes(2)
  expect(update.close).toHaveBeenCalledTimes(1)
  expect(sdk.relaunch).toHaveBeenCalledTimes(1)
})

it("retains the installed snapshot while its resource is still being released", async () => {
  const update = candidate()
  let release!: () => void
  update.close.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  sdk.check.mockResolvedValue(update)
  await updater.checkClientUpdate()
  const install = updater.installClientUpdate()
  await Promise.resolve()
  const observed = updater.checkClientUpdate()
  release()
  await install

  await expect(observed).resolves.toMatchObject({ version: update.version })
  expect(sdk.check).toHaveBeenCalledTimes(1)
  expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)
  expect(update.close).toHaveBeenCalledTimes(1)
})
