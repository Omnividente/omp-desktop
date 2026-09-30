import type { TextMatch } from "./MarkdownContent"

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

  /** Materialize only mounted virtual rows; callers must not cache all visited rows. */
  matchesForEntry(entryIndex: number): TextMatch[] {
    const start = this.entryStarts[entryIndex]
    const end = this.entryStarts[entryIndex + 1]
    const matches: TextMatch[] = new Array(end - start)
    for (let index = start; index < end; index++) {
      const chunk = this.positions[Math.floor(index / MATCHES_PER_CHUNK)]
      const offset = (index % MATCHES_PER_CHUNK) * 2
      matches[index - start] = { start: chunk[offset], end: chunk[offset + 1], index }
    }
    return matches
  }
}
