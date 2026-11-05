import { expect, it } from "vitest"
import { SEARCH_HIGHLIGHT_LIMIT, TranscriptSearch } from "./transcriptSearch"

it("optionally distinguishes code identifiers while keeping literal UTF-16 match spans", () => {
  const contents = [{ text: "😀PATH path Path PATH.* path.*" }]
  const search = new TranscriptSearch(contents, "PATH", true)
  expect(search.count).toBe(2)
  expect(search.matchesForEntry(0, 0)).toEqual([
    { start: 2, end: 6, index: 0 },
    { start: 17, end: 21, index: 1 },
  ])
  expect(new TranscriptSearch(contents, "PATH").count).toBe(5)
  expect(new TranscriptSearch(contents, "PATH.*", true).matchesForEntry(0, 0)).toEqual([
    { start: 17, end: 23, index: 0 },
  ])
  expect(new TranscriptSearch(contents, "", true).count).toBe(0)
})

it("does not case-fold Unicode when match case is selected", () => {
  const search = new TranscriptSearch([{ text: "😀𐐨 𐐀 K K k" }], "𐐀", true)
  expect(search.matchesForEntry(0, 0)).toEqual([{ start: 5, end: 7, index: 0 }])
  expect(new TranscriptSearch([{ text: "K K k" }], "k", true).matchesForEntry(0, 0)).toEqual([
    { start: 4, end: 5, index: 0 },
  ])
  expect(new TranscriptSearch([{ text: "Путь путь" }], "Путь", true).count).toBe(1)
})

it("keeps bounded windows and global indices when a case-sensitive search skips entries", () => {
  const search = new TranscriptSearch(
    [{ text: "x".repeat(5000) }, { text: "Xx".repeat(4500) }, { text: "x" }, { text: "X" }],
    "X",
    true,
  )
  expect(search.count).toBe(4501)
  expect(search.entryIndex(0)).toBe(1)
  expect(search.entryIndex(4500)).toBe(3)
  for (const index of [0, 4095, 4096, 4499]) {
    const matches = search.matchesForEntry(1, index)
    expect(matches.length).toBeLessThanOrEqual(SEARCH_HIGHLIGHT_LIMIT)
    expect(matches.find((match) => match.index === index)).toEqual({
      start: index * 2,
      end: index * 2 + 1,
      index,
    })
  }
  expect(search.matchesForEntry(0, 0)).toEqual([])
})

it("keeps UTF-16 offsets and Unicode case-folded match spans", () => {
  const search = new TranscriptSearch([{ text: "😀K k K" }], "k")
  expect(search.count).toBe(3)
  expect(search.matchesForEntry(0, 0)).toEqual([
    { start: 2, end: 3, index: 0 },
    { start: 4, end: 5, index: 1 },
    { start: 6, end: 7, index: 2 },
  ])

  const astral = new TranscriptSearch([{ text: "😀𐐨 𐐀" }], "𐐀")
  expect(astral.matchesForEntry(0, 0)).toEqual([
    { start: 2, end: 4, index: 0 },
    { start: 5, end: 7, index: 1 },
  ])
  expect(new TranscriptSearch([{ text: "ſ S s" }], "s").matchesForEntry(0, 0)).toEqual([
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
  expect(search.matchesForEntry(0, 0)).toEqual([
    { start: 2, end: 16, index: 0 },
    { start: 17, end: 31, index: 1 },
  ])
})

it("keeps global numbering across empty entries and independently materialized rows", () => {
  const contents = ["", "needle needle", "", "NEEDLE", "", "needle", ""].map((text) => ({ text }))
  const search = new TranscriptSearch(contents, "needle")
  expect(search.count).toBe(4)
  expect([0, 1, 2, 3].map((index) => search.entryIndex(index))).toEqual([1, 1, 3, 5])
  expect(search.matchesForEntry(5, 0)).toEqual([{ start: 0, end: 6, index: 3 }])
  expect(search.matchesForEntry(1, 0)).toEqual([
    { start: 0, end: 6, index: 0 },
    { start: 7, end: 13, index: 1 },
  ])
  expect(search.matchesForEntry(3, 0)).toEqual([{ start: 0, end: 6, index: 2 }])
  expect(search.matchesForEntry(0, 0)).toEqual([])
  expect(search.matchesForEntry(2, 0)).toEqual([])
  expect(search.matchesForEntry(6, 0)).toEqual([])

  const cleared = new TranscriptSearch(contents, "")
  expect(cleared.count).toBe(0)
  expect(cleared.matchesForEntry(1, -1)).toEqual([])
  const absent = new TranscriptSearch(contents, "absent")
  expect(absent.count).toBe(0)
  expect(absent.matchesForEntry(3, -1)).toEqual([])
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
  for (const index of [3500, 4095, 4096, 4499]) {
    const matches = search.matchesForEntry(1, index)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.length).toBeLessThanOrEqual(SEARCH_HIGHLIGHT_LIMIT)
    expect(matches.find((match) => match.index === index)).toEqual({
      start: index - 3500,
      end: index - 3500 + 1,
      index,
    })
    for (const match of matches) {
      expect(match).toEqual({
        start: match.index - 3500,
        end: match.index - 3500 + 1,
        index: match.index,
      })
    }
  }
  const noncurrent = search.matchesForEntry(1, 4500)
  expect(noncurrent[0]).toEqual({ start: 0, end: 1, index: 3500 })
  expect(noncurrent.length).toBeLessThanOrEqual(SEARCH_HIGHLIGHT_LIMIT)
  expect(search.matchesForEntry(2, 4500)).toEqual([{ start: 0, end: 1, index: 4500 }])
})

it("keeps a million occurrences navigable through fresh bounded first, distant and last windows", () => {
  const contents = [{ text: "x".repeat(1_000_000) }]
  const search = new TranscriptSearch(contents, "x")
  expect(search.count).toBe(1_000_000)
  expect(SEARCH_HIGHLIGHT_LIMIT).toBeLessThanOrEqual(512)
  for (const index of [0, 4095, 4096, 500_000, 999_999, 500_000, 0, 999_999]) {
    expect(search.entryIndex(index)).toBe(0)
    const matches = search.matchesForEntry(0, index)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.length).toBeLessThanOrEqual(SEARCH_HIGHLIGHT_LIMIT)
    expect(matches.find((match) => match.index === index)).toEqual({
      start: index,
      end: index + 1,
      index,
    })
    for (let offset = 0; offset < matches.length; offset++) {
      const globalIndex = matches[0].index + offset
      expect(matches[offset]).toEqual({
        start: globalIndex,
        end: globalIndex + 1,
        index: globalIndex,
      })
    }
  }
  const first = search.matchesForEntry(0, -1)
  expect(first[0]).toEqual({ start: 0, end: 1, index: 0 })
  expect(first.length).toBeLessThanOrEqual(SEARCH_HIGHLIGHT_LIMIT)
  first[0].start = -1
  expect(search.matchesForEntry(0, 0)[0]).toEqual({ start: 0, end: 1, index: 0 })
  const reindexed = new TranscriptSearch(contents, "X")
  expect(reindexed.count).toBe(1_000_000)
  const last = reindexed.matchesForEntry(0, 999_999)
  expect(last[last.length - 1]).toEqual({ start: 999_999, end: 1_000_000, index: 999_999 })
  const cleared = new TranscriptSearch(contents, "")
  expect(cleared.count).toBe(0)
  expect(cleared.matchesForEntry(0, -1)).toEqual([])
})
