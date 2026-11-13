import { describe, expect, it } from "vitest"
import { filterCodexSessions } from "./codexSessionSearch"
import type { CodexSessionSummary } from "./types"

const session: CodexSessionSummary = {
  id: "hidden-id",
  filePath: "/hidden-file.jsonl",
  title: "Cafe\u0301 [429]",
  cwd: "/synthetic/Project Alpha",
  model: "provider/example-model",
  preview: "Investigate the retry budget",
  createdAt: "2026-01-01",
  updatedAt: 1,
}

describe("filterCodexSessions", () => {
  it.each(["", " \t\n "])("keeps the source array for an empty query %j", (query) => {
    const sessions = [session]
    expect(filterCodexSessions(sessions, query)).toBe(sessions)
  })

  it.each([" CAFÉ ", "[429]", "PROJECT ALPHA", "EXAMPLE-MODEL", "RETRY BUDGET"])(
    "matches displayed metadata with literal query %j",
    (query) => {
      expect(filterCodexSessions([session], query)).toEqual([session])
    },
  )

  it.each([".*", "hidden-id", "hidden-file", "2026-01-01", "cafe", "[429]/synthetic"])(
    "does not invent a match for %j",
    (query) => {
      expect(filterCodexSessions([session], query)).toEqual([])
    },
  )

  it("handles missing models without creating a null match", () => {
    expect(filterCodexSessions([{ ...session, model: null }], "null")).toEqual([])
  })

  it("preserves exact paths, object identity and source order without mutation", () => {
    const first = Object.freeze({ ...session, filePath: " /synthetic/first.jsonl " })
    const second = Object.freeze({ ...session, filePath: "/synthetic/second.jsonl" })
    const sessions = [first, { ...session, title: "Other", preview: "" }, second]
    Object.freeze(sessions)
    const result = filterCodexSessions(sessions, "café")
    expect(result).toEqual([first, second])
    expect(result[0]).toBe(first)
    expect(result[1]).toBe(second)
    expect(result[0].filePath).toBe(" /synthetic/first.jsonl ")
    expect(sessions).toHaveLength(3)
  })

  it("filters the entire discovered list, not just rendered rows", () => {
    const sessions = Array.from({ length: 120 }, (_, index) => ({
      ...session,
      filePath: `/synthetic/${index}.jsonl`,
      title: index % 12 === 0 ? "Migration task" : "Other task",
    }))
    expect(filterCodexSessions(sessions, "migration")).toEqual(
      sessions.filter((_, index) => index % 12 === 0),
    )
  })
})
