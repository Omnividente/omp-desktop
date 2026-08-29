/** @vitest-environment jsdom */

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsRecoveryScreen } from "./SettingsRecoveryScreen"
import type { SettingsUnavailableDetails } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const recovery: SettingsUnavailableDetails = {
  code: "settings_unavailable",
  message: "Настройки недоступны",
  details: "Отказано в доступе",
  settingsPath: "C:\\Users\\Test\\AppData\\Roaming\\omp-desktop\\settings.json",
  backupPath: "C:\\Users\\Test\\AppData\\Roaming\\omp-desktop\\settings.backup.json",
  failureStage: "defaults_write",
}

describe("SettingsRecoveryScreen", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("renders paths and all recovery actions instead of a retry-only error", () => {
    const onOpenFolder = vi.fn()
    const onRetry = vi.fn()
    const onStartWithDefaults = vi.fn()

    act(() => {
      root.render(
        <SettingsRecoveryScreen
          busy={false}
          language="ru"
          recovery={recovery}
          onOpenFolder={onOpenFolder}
          onRetry={onRetry}
          onStartWithDefaults={onStartWithDefaults}
        />,
      )
    })

    expect(container.querySelector(".settings-recovery-card")).not.toBeNull()
    expect(container.textContent).toContain(recovery.settingsPath)
    expect(container.textContent).toContain(recovery.backupPath)
    expect(container.textContent).toContain(recovery.failureStage)
    expect(container.textContent).toContain(recovery.details)

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons).toHaveLength(3)
    act(() => buttons[0].click())
    act(() => buttons[1].click())
    act(() => buttons[2].click())
    expect(onOpenFolder).toHaveBeenCalledOnce()
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onStartWithDefaults).toHaveBeenCalledOnce()
  })

  it("disables every destructive or retry action while recovery is running", () => {
    act(() => {
      root.render(
        <SettingsRecoveryScreen
          busy
          language="en"
          recovery={{ ...recovery, backupPath: null }}
          onOpenFolder={vi.fn()}
          onRetry={vi.fn()}
          onStartWithDefaults={vi.fn()}
        />,
      )
    })

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons).toHaveLength(3)
    expect(buttons.every((button) => button.disabled)).toBe(true)
    expect(container.textContent).not.toContain(recovery.backupPath)
  })
})
