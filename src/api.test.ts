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
})
