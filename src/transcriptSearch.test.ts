import { expect, it } from "vitest"
import { TranscriptSearch } from "./transcriptSearch"

it("keeps UTF-16 offsets and Unicode case-folded match spans", () => {
  const search = new TranscriptSearch([{ text: "😀K k K" }], "k")
  expect(search.count).toBe(3)
  expect(search.matchesForEntry(0)).toEqual([
    { start: 2, end: 3, index: 0 },
    { start: 4, end: 5, index: 1 },
    { start: 6, end: 7, index: 2 },
  ])

  const astral = new TranscriptSearch([{ text: "😀𐐨 𐐀" }], "𐐀")
  expect(astral.matchesForEntry(0)).toEqual([
    { start: 2, end: 4, index: 0 },
    { start: 5, end: 7, index: 1 },
  ])
  expect(new TranscriptSearch([{ text: "ſ S s" }], "s").matchesForEntry(0)).toEqual([
    { start: 0, end: 1, index: 0 },
    { start: 2, end: 3, index: 1 },
    { start: 4, end: 5, index: 2 },
  ])
})

it("treats regex syntax as a literal query, including brackets and backslash", () => {
  const search = new TranscriptSearch(
    [{ text: "😀.*+?^${}()|[]\\ .*+?^${}()|[]\\" }],
    ".*+?^${}()|[]\\",
  )
  expect(search.count).toBe(2)
  expect(search.matchesForEntry(0)).toEqual([
    { start: 2, end: 16, index: 0 },
    { start: 17, end: 31, index: 1 },
  ])
})

it("keeps global numbering across empty entries and independently materialized rows", () => {
  const contents = ["", "needle needle", "", "NEEDLE", "", "needle", ""].map((text) => ({ text }))
  const search = new TranscriptSearch(contents, "needle")
  expect(search.count).toBe(4)
  expect([0, 1, 2, 3].map((index) => search.entryIndex(index))).toEqual([1, 1, 3, 5])
  expect(search.matchesForEntry(5)).toEqual([{ start: 0, end: 6, index: 3 }])
  expect(search.matchesForEntry(1)).toEqual([
    { start: 0, end: 6, index: 0 },
    { start: 7, end: 13, index: 1 },
  ])
  expect(search.matchesForEntry(3)).toEqual([{ start: 0, end: 6, index: 2 }])
  expect(search.matchesForEntry(0)).toEqual([])
  expect(search.matchesForEntry(2)).toEqual([])
  expect(search.matchesForEntry(6)).toEqual([])

  const cleared = new TranscriptSearch(contents, "")
  expect(cleared.count).toBe(0)
  expect(cleared.matchesForEntry(1)).toEqual([])
  const absent = new TranscriptSearch(contents, "absent")
  expect(absent.count).toBe(0)
  expect(absent.matchesForEntry(3)).toEqual([])
})

it("preserves late global indices and local offsets in a match-dense transcript", () => {
  const search = new TranscriptSearch(
    [{ text: "x".repeat(3500) }, { text: "x".repeat(1000) }, { text: "x" }],
    "x",
  )
  expect(search.count).toBe(4501)
  expect(search.entryIndex(3499)).toBe(0)
  expect(search.entryIndex(3500)).toBe(1)
  expect(search.entryIndex(4500)).toBe(2)
  const matches = search.matchesForEntry(1)
  expect(matches[0]).toEqual({ start: 0, end: 1, index: 3500 })
  expect(matches[595]).toEqual({ start: 595, end: 596, index: 4095 })
  expect(matches[596]).toEqual({ start: 596, end: 597, index: 4096 })
  expect(matches[999]).toEqual({ start: 999, end: 1000, index: 4499 })
  expect(search.matchesForEntry(2)).toEqual([{ start: 0, end: 1, index: 4500 }])
})
