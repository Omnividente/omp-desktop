import { afterEach, describe, expect, it, vi } from "vitest"

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))

import {
  backendErrorCode,
  bootstrap,
  errorMessage,
  discardSwitchInputRecovery,
  sendSwitchInputRecovery,
  settingsUnavailableDetails,
  subscribeSettingsUnavailable,
  switchInputRecoveryDetails,
} from "./api"

afterEach(() => {
  invokeMock.mockReset()
})

describe("backend error codes", () => {
  it("classifies a terminal restart that failed after stopping the old process", () => {
    const error = "[terminal_restart_stopped] Не удалось запустить OMP"

    expect(backendErrorCode(error)).toBe("terminal_restart_stopped")
    expect(errorMessage(error, "ru")).toBe("Не удалось запустить OMP")
  })

  it("does not classify preflight errors as stopped restarts", () => {
    const error = "Сессия OMP ещё не готова к перезапуску"

    expect(backendErrorCode(error)).toBeNull()
    expect(errorMessage(error, "ru")).toBe(error)
  })

  it("localizes backend rejection of active session deletion", () => {
    const error = {
      code: "session_active_delete",
      message: "Не удалось удалить сессию",
      details: "Сессия используется активным терминалом",
    }

    expect(errorMessage(error, "ru")).toBe("Сначала остановите активную сессию OMP")
    expect(errorMessage(error, "en")).toBe("Stop the active OMP session before deleting it")
  })

  it("preserves structured settings recovery metadata", () => {
    const error = {
      code: "settings_unavailable",
      message: "Settings unavailable",
      details: "permission denied",
      settingsPath: "C:\\Users\\Test\\settings.json",
      backupPath: "C:\\Users\\Test\\settings.backup.json",
      failureStage: "defaults_write",
    }

    expect(settingsUnavailableDetails(error)).toEqual({
      ...error,
      code: "settings_unavailable",
    })
    expect(errorMessage(error, "en")).toBe("OMP Desktop settings are unavailable")
  })

  it("notifies the recovery surface for a settings-dependent IPC failure", async () => {
    const error = {
      code: "settings_unavailable",
      message: "Settings unavailable",
      details: "read failed",
      settingsPath: "/tmp/omp/settings.json",
      backupPath: null,
      failureStage: "read",
    }
    invokeMock.mockRejectedValueOnce(error)
    const observed = vi.fn()
    const unsubscribe = subscribeSettingsUnavailable(observed)

    await expect(bootstrap()).rejects.toEqual(error)
    expect(observed).toHaveBeenCalledOnce()
    expect(observed).toHaveBeenCalledWith(settingsUnavailableDetails(error))

    unsubscribe()
  })

  it("keeps failed-switch recovery metadata-only", () => {
    const error = {
      code: "terminal_switch_input_recovery",
      message: "switch failed",
      recovery: {
        terminalId: "terminal-1",
        state: "pending",
        generation: 7,
        byteCount: 23,
        token: "opaque-token",
        buffer: "secret input must not cross IPC",
      },
    }

    expect(switchInputRecoveryDetails(error)).toEqual({
      terminalId: "terminal-1",
      state: "pending",
      generation: 7,
      byteCount: 23,
      token: "opaque-token",
    })
    expect(JSON.stringify(switchInputRecoveryDetails(error))).not.toContain("secret input")
  })

  it("sends only recovery identity to send and discard commands", async () => {
    invokeMock.mockResolvedValue(undefined)

    await sendSwitchInputRecovery("terminal-1", 7, "opaque-token")
    await discardSwitchInputRecovery("terminal-1", 7, "opaque-token")

    const request = {
      request: { terminalId: "terminal-1", generation: 7, token: "opaque-token" },
    }
    expect(invokeMock).toHaveBeenNthCalledWith(1, "send_switch_input_recovery", request, undefined)
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "discard_switch_input_recovery",
      request,
      undefined,
    )
  })
})
