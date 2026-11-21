/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest"
import { marked } from "marked"
import { markdownContent } from "./MarkdownContent"
import { TranscriptContentCache } from "./transcriptContentCache"

afterEach(() => vi.restoreAllMocks())

it("reuses exact bodies across loading and refresh while eagerly parsing changed and appended bodies", () => {
  const cache = new TranscriptContentCache()
  const lexer = vi.spyOn(marked, "lexer")
  const first = cache.project("a", ["**old**", "stable"], false)
  expect(lexer).toHaveBeenCalledTimes(2)
  expect(cache.project("a", null, false)).toEqual([])
  const same = cache.project("a", ["**old**", "stable"], false)
  expect(same[0]).toBe(first[0])
  expect(same[1]).toBe(first[1])
  expect(lexer).toHaveBeenCalledTimes(2)
  const next = cache.project("a", ["**changed**", "stable", "appended"], false)
  expect(next.map((document) => document.text)).toEqual(["changed", "stable", "appended"])
  expect(next[1]).toBe(first[1])
  expect(lexer).toHaveBeenCalledTimes(4)
})

it("keeps exact formatted and source projections distinct without discarding reusable formatted bodies", () => {
  const cache = new TranscriptContentCache()
  const sources = ["**Ж𝄞** [site](https://example.test) &amp;", "```txt\n  code\n```"]
  const expected = sources.map((source) => markdownContent(source))
  const lexer = vi.spyOn(marked, "lexer")
  const formatted = cache.project("a", sources, false)
  expect(formatted).toEqual(expected)
  expect(cache.project("a", sources, true).map((document) => document.text)).toEqual(sources)
  expect(lexer).toHaveBeenCalledTimes(2)
  const again = cache.project("a", sources, false)
  expect(again[0]).toBe(formatted[0])
  expect(again[1]).toBe(formatted[1])
  expect(lexer).toHaveBeenCalledTimes(2)
  // The selected dialogue/all text is the key, not a caller's unchanged entry ID.
  expect(cache.project("a", ["different projection"], false)[0].text).toBe("different projection")
  expect(lexer).toHaveBeenCalledTimes(3)
})

it("clears retained bodies on path change, a successful empty snapshot and a new reader", () => {
  const cache = new TranscriptContentCache()
  const lexer = vi.spyOn(marked, "lexer")
  cache.project("a", ["body"], false)
  cache.project("b", null, false)
  cache.project("b", ["body"], false)
  cache.project("b", [], true)
  cache.project("b", ["body"], false)
  new TranscriptContentCache().project("b", ["body"], false)
  expect(lexer).toHaveBeenCalledTimes(4)
})

it("does not retain a formatting failure and allows a later parse to recover", () => {
  const cache = new TranscriptContentCache()
  const lexer = vi.spyOn(marked, "lexer").mockImplementationOnce(() => {
    throw new Error("Synthetic parse failure")
  })
  expect(cache.project("a", ["**body**"], false)[0].formattingFailed).toBe(true)
  const recovered = cache.project("a", ["**body**"], false)[0]
  expect(recovered.formattingFailed).toBeUndefined()
  expect(recovered.text).toBe("body")
  expect(lexer).toHaveBeenCalledTimes(2)
})

it("bounds retained document count without sequential LRU thrashing or dropping output", () => {
  const cache = new TranscriptContentCache()
  const sources = Array.from({ length: 513 }, (_, index) => `message-${index}`)
  const lexer = vi.spyOn(marked, "lexer")
  expect(cache.project("a", sources, false)).toHaveLength(513)
  expect(lexer).toHaveBeenCalledTimes(513)
  expect(cache.project("a", [...sources], false).map((document) => document.text)).toEqual(sources)
  expect(lexer).toHaveBeenCalledTimes(514)
  // Lookup of the previous snapshot stays intact when the first next item is a miss.
  const rotated = ["new-first", ...sources.slice(0, 512)]
  expect(cache.project("a", rotated, false).map((document) => document.text)).toEqual(rotated)
  expect(lexer).toHaveBeenCalledTimes(515)
})

it("bounds retained source units and bypasses oversized documents without dropping them", () => {
  const cache = new TranscriptContentCache()
  const large = ["a".repeat(1100000), "b".repeat(1100000)]
  const lexer = vi.spyOn(marked, "lexer")
  expect(cache.project("a", large, false).map((document) => document.text.length)).toEqual([
    1100000, 1100000,
  ])
  cache.project("a", large, false)
  expect(lexer).toHaveBeenCalledTimes(3)
  const oversized = "c".repeat(2 * 1024 * 1024 + 1)
  expect(cache.project("a", [oversized], false)[0].text).toBe(oversized)
  cache.project("a", [oversized], false)
  expect(lexer).toHaveBeenCalledTimes(5)
})

it("counts repeated exact bodies once without removing duplicate output entries", () => {
  const cache = new TranscriptContentCache()
  const lexer = vi.spyOn(marked, "lexer")
  const result = cache.project("a", ["body", "body", "body"], false)
  expect(result).toHaveLength(3)
  expect(result[1]).toBe(result[0])
  expect(result[2]).toBe(result[0])
  expect(lexer).toHaveBeenCalledTimes(1)
})
