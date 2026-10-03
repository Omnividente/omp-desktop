import type { TextMatch } from "./MarkdownContent"

// Per entry, independent of the full occurrence count and Markdown leaf count.
export const SEARCH_HIGHLIGHT_LIMIT = 512

// Fixed chunks avoid growing/copying a full index or retaining a JS object per
// occurrence. Each pair contains UTF-16 start/end offsets in its own entry.
const MATCHES_PER_CHUNK = 4096

export class TranscriptSearch {
  readonly count: number
  private readonly entryStarts: Float64Array
  private readonly positions: Uint32Array[] = []

  constructor(contents: readonly { text: string }[], query: string) {
    // Prefix counts also map global match indices to entries with no matches.
    this.entryStarts = new Float64Array(contents.length + 1)
    let count = 0
    if (query) {
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
      for (let entryIndex = 0; entryIndex < contents.length; entryIndex++) {
        pattern.lastIndex = 0
        let found: RegExpExecArray | null
        while ((found = pattern.exec(contents[entryIndex].text)) !== null) {
          const offset = (count % MATCHES_PER_CHUNK) * 2
          if (offset === 0) this.positions.push(new Uint32Array(MATCHES_PER_CHUNK * 2))
          const chunk = this.positions[this.positions.length - 1]
          chunk[offset] = found.index
          chunk[offset + 1] = found.index + found[0].length
          count++
        }
        this.entryStarts[entryIndex + 1] = count
      }
    }
    this.count = count
  }

  /** Resolve a valid global match index without materializing other matches. */
  entryIndex(index: number): number {
    let low = 0
    let high = this.entryStarts.length - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.entryStarts[middle + 1] <= index) low = middle + 1
      else high = middle
    }
    return low
  }

  /** Fresh bounded window around the active global index, or the entry's first window. */
  matchesForEntry(entryIndex: number, currentIndex: number): TextMatch[] {
    const start = this.entryStarts[entryIndex]
    const end = this.entryStarts[entryIndex + 1]
    const first =
      currentIndex >= start && currentIndex < end
        ? Math.max(
            start,
            Math.min(
              currentIndex - Math.floor(SEARCH_HIGHLIGHT_LIMIT / 2),
              end - SEARCH_HIGHLIGHT_LIMIT,
            ),
          )
        : start
    const last = Math.min(end, first + SEARCH_HIGHLIGHT_LIMIT)
    const matches: TextMatch[] = new Array(last - first)
    for (let index = first; index < last; index++) {
      const chunk = this.positions[Math.floor(index / MATCHES_PER_CHUNK)]
      const offset = (index % MATCHES_PER_CHUNK) * 2
      matches[index - first] = { start: chunk[offset], end: chunk[offset + 1], index }
    }
    return matches
  }
}
