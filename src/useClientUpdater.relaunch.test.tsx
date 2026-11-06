/** @vitest-environment jsdom */

import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { useClientUpdater, type ClientUpdaterState } from "./useClientUpdater"

const sdk = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn(), confirm: vi.fn() }))
vi.mock("@tauri-apps/plugin-updater", () => ({ check: sdk.check }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: sdk.relaunch }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: sdk.confirm }))

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const container = document.createElement("div")
const root = createRoot(container)

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.localStorage.clear()
})

it("reconfirms a user retry after relaunch failure without downloading twice", async () => {
  window.localStorage.clear()
  document.body.appendChild(container)
  const update = {
    version: "0.9.11",
    close: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  }
  sdk.check.mockResolvedValue(update)
  sdk.confirm.mockResolvedValueOnce(true)
  sdk.relaunch.mockRejectedValueOnce(new Error("relaunch failed"))
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
  expect(container.querySelector("output")?.textContent).toBe("relaunch failed")
  expect(container.querySelector("span")?.textContent).toBe("0.9.11")
  expect(updater.isInstalling()).toBe(false)
  expect(container.querySelector("button")!.disabled).toBe(false)

  // A new terminal appeared after the first attempt; retry must ask again.
  running = 2
  let decide!: (accepted: boolean) => void
  sdk.confirm.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      decide = resolve
    }),
  )
  act(() => {
    updater.install()
    updater.install()
  })
  expect(updater.isInstalling()).toBe(true)
  expect(sdk.confirm).toHaveBeenCalledTimes(2)
  expect(sdk.confirm.mock.calls[1][0]).toContain("2")
  expect(sdk.relaunch).toHaveBeenCalledTimes(1)
  await act(async () => decide(false))
  expect(updater.isInstalling()).toBe(false)
  expect(sdk.relaunch).toHaveBeenCalledTimes(1)
  expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)

  sdk.confirm.mockResolvedValueOnce(true)
  sdk.relaunch.mockResolvedValueOnce(undefined)
  await act(async () => container.querySelector("button")!.click())
  expect(sdk.confirm).toHaveBeenCalledTimes(3)
  expect(sdk.relaunch).toHaveBeenCalledTimes(2)
  expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)
  expect(update.close).toHaveBeenCalledTimes(1)
  expect(updater.isInstalling()).toBe(false)
})
