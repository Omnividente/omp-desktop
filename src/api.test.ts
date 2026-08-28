import { describe, expect, it } from "vitest"
import { backendErrorCode, errorMessage } from "./api"

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
})
