import { expect, it } from "vitest"
import { transcriptUserMessages, TRANSCRIPT_OUTLINE_LIMIT } from "./transcriptNavigation"
import type { TranscriptEntry } from "./types"

const entry = (id: string, role: string, text: string): TranscriptEntry => ({
  id,
  role,
  text,
  dialogueText: null,
  category: "dialogue",
  timestamp: "2026-01-01",
})

it("keeps loaded user-message order and original identities without inferring branches", () => {
  const entries = [
    entry("branch-b", " USER ", " second\n question "),
    entry("a", "assistant", "no"),
    entry("branch-a", "user", "first"),
  ]
  const before = JSON.stringify(entries)
  expect(transcriptUserMessages(entries).messages).toEqual([
    { id: "branch-b", preview: "second question" },
    { id: "branch-a", preview: "first" },
  ])
  expect(JSON.stringify(entries)).toBe(before)
})

it("preserves explicit empty dialogue text and bounds previews without splitting code points", () => {
  expect(
    transcriptUserMessages([
      { ...entry("empty", "user", "service text"), dialogueText: "" },
      entry("long", "user", "😀".repeat(81)),
    ]).messages,
  ).toEqual([
    { id: "empty", preview: "" },
    { id: "long", preview: "😀".repeat(80) + "…" },
  ])
  expect(transcriptUserMessages([])).toEqual({ messages: [], limited: false })
})

it("bounds option count and preview scanning while disclosing omitted outline entries", () => {
  const entries = Array.from({ length: TRANSCRIPT_OUTLINE_LIMIT + 1 }, (_, index) =>
    entry(String(index), "user", " ".repeat(100_000) + "late text"),
  )
  const outline = transcriptUserMessages(entries)
  expect(outline.messages).toHaveLength(100)
  expect(outline.limited).toBe(true)
  expect(outline.messages[0].preview).toBe("…")
  expect(transcriptUserMessages(entries.slice(0, 100)).limited).toBe(false)
  const boundary = transcriptUserMessages([entry("boundary", "user", " ".repeat(511) + "😀")])
  expect(boundary.messages[0].preview).toBe("…")
})
