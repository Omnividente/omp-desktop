import { describe, expect, it } from "vitest"
import { importFailureMessage } from "./importFailure"
import type { ImportItemResult } from "./types"

const item = (message: string | null): ImportItemResult => ({
  sourcePath: "C:/source/исходник space.jsonl",
  destinationPath: null,
  status: "failed",
  message,
})

describe("import failure presentation", () => {
  it.each(["en", "ru"] as const)(
    "adds a neutral %s summary without losing raw detail",
    (language) => {
      const raw =
        "[session_lease_active] Сессия используется активным терминалом: C:/target/другая папка.jsonl\n  "
      const result = importFailureMessage(item(raw), language)
      expect(result).toBe(
        `${language === "en" ? "Cannot import: the session is in use" : "Невозможно импортировать: сессия используется"}\n${raw}`,
      )
      expect(result).not.toContain("another")
      expect(result).not.toContain(item(raw).sourcePath)
    },
  )

  it.each([
    "[unknown_code] untranslated detail",
    "ordinary detail",
    "",
    "prefix [session_lease_active] not a code",
    "[session_lease_stale] not active",
  ])("preserves an unrecognized diagnostic: %s", (raw) => {
    expect(importFailureMessage(item(raw), "en")).toBe(raw)
  })

  it("retains the source fallback for an absent diagnostic", () => {
    expect(importFailureMessage(item(null), "en")).toBe(item(null).sourcePath)
  })

  it("does not truncate or reinterpret a long HTML-looking raw diagnostic", () => {
    const raw =
      "[session_lease_active] <img src=x onerror=alert(1)>" +
      "x".repeat(10000) +
      " C:/target/end.jsonl"
    expect(importFailureMessage(item(raw), "en")).toBe(
      `Cannot import: the session is in use\n${raw}`,
    )
  })
})
