import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { checkClientUpdate, installClientUpdate } from "./clientUpdater"

const sdk = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }))
vi.mock("@tauri-apps/plugin-updater", () => ({ check: sdk.check }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: sdk.relaunch }))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  sdk.check.mockResolvedValue(null)
  await checkClientUpdate()
})

it("owns only the latest update while a failed check preserves the installable candidate", async () => {
  const resources = new Set<string>()
  const installed: string[] = []
  let sequence = 0
  sdk.check.mockImplementation(async () => {
    const version = `0.9.${++sequence}`
    resources.add(version)
    return {
      version,
      date: null,
      body: null,
      close: async () => {
        resources.delete(version)
      },
      downloadAndInstall: async () => {
        if (!resources.has(version)) throw new Error("closed update resource")
        installed.push(version)
      },
    }
  })
  await checkClientUpdate()
  await checkClientUpdate()
  expect([...resources]).toEqual(["0.9.2"])
  sdk.check.mockRejectedValueOnce(new Error("offline"))
  await expect(checkClientUpdate()).rejects.toThrow("offline")
  await installClientUpdate()
  expect(installed).toEqual(["0.9.2"])
  expect([...resources]).toEqual([])
})

it("retains a failed installation for retry and never replaces an in-flight install", async () => {
  let release!: () => void
  let attempts = 0
  let closed = false
  sdk.check.mockResolvedValue({
    version: "0.9.9",
    close: async () => {
      closed = true
    },
    downloadAndInstall: async () => {
      if (closed) throw new Error("closed update resource")
      if (++attempts === 1) throw new Error("download failed")
      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
  })
  await checkClientUpdate()
  await expect(installClientUpdate()).rejects.toThrow("download failed")
  const install = installClientUpdate()
  const duplicate = installClientUpdate()
  try {
    expect(await checkClientUpdate()).toMatchObject({ version: "0.9.9" })
    expect(attempts).toBe(2)
    expect(closed).toBe(false)
  } finally {
    release()
    await Promise.all([install, duplicate])
  }
  expect(closed).toBe(true)
})
