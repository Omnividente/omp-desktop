import { afterEach, describe, expect, it, vi } from "vitest"

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))

import {
  backendErrorCode,
  bootstrap,
  resolveStartupWorkspace,
  addWorkspace,
  startTerminal,
  errorMessage,
  deleteSession,
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

  it("bounds plain backend errors and tolerates circular rejection values", () => {
    const oversized = "x".repeat(9_000)
    const bounded = errorMessage(oversized, "en")
    expect(bounded).toHaveLength(8 * 1024 + 1)
    expect(bounded.endsWith("…")).toBe(true)

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorMessage(circular, "en")).toBe("[object Object]")
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

  it("exposes bounded failure reasons only when a caller requests details", () => {
    const error = {
      code: "settings_save_failed",
      message: "Could not save",
      details: "Provider ID is already in use",
    }
    expect(errorMessage(error, "en")).not.toContain(error.details)
    expect(errorMessage(JSON.stringify(error), "en", { includeDetails: true })).toContain(
      error.details,
    )
    const bounded = errorMessage({ ...error, details: "x".repeat(9_000) }, "en", {
      includeDetails: true,
    })
    expect(bounded).not.toContain("x".repeat(8 * 1024 + 1))
    expect(bounded.endsWith("…")).toBe(true)
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

  it("sends explicit stale-lease reclaim intent for session deletion", async () => {
    invokeMock.mockResolvedValue({})

    await deleteSession("C:\\sessions\\session.jsonl")
    await deleteSession("C:\\sessions\\session.jsonl", true)

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "delete_session",
      { path: "C:\\sessions\\session.jsonl", forceSessionLease: false },
      undefined,
    )
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "delete_session",
      { path: "C:\\sessions\\session.jsonl", forceSessionLease: true },
      undefined,
    )
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

describe("startup workspace resolution ordering", () => {
  it("serializes resolution with snapshots but keeps independent terminal IPC live", async () => {
    let release!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      release = resolve
    })
    invokeMock.mockImplementation((command) =>
      command === "resolve_startup_workspace" ? pending : Promise.resolve({}),
    )
    const resolution = resolveStartupWorkspace("/fixture/requested", "continue")
    const next = addWorkspace("/fixture/newer")
    await startTerminal("/fixture/existing", null)
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain("add_workspace")
    expect(invokeMock).toHaveBeenCalledWith(
      "resolve_startup_workspace",
      { requestedPath: "/fixture/requested", action: "continue" },
      undefined,
    )
    expect(invokeMock.mock.calls.map(([command]) => command)).toContain("start_terminal")
    release({})
    await resolution
    await next
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "start_terminal",
      "resolve_startup_workspace",
      "add_workspace",
    ])
  })

  it("releases the snapshot queue after failed retry and passes the exact expected path", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("prior snapshot unavailable"))
      .mockResolvedValueOnce({})
    const path = "./fixture/with spaces/../requested"
    const retry = resolveStartupWorkspace(path, "retry")
    const next = bootstrap()
    await expect(retry).rejects.toThrow("prior snapshot unavailable")
    await next
    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "resolve_startup_workspace",
      { requestedPath: path, action: "retry" },
      undefined,
    )
    expect(invokeMock).toHaveBeenNthCalledWith(2, "bootstrap", undefined, undefined)
  })
})
