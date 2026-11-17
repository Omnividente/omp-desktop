import { markdownContent, type MarkdownDocument } from "./MarkdownContent"

// Retention budgets, not heap-size estimates: parsed nodes have additional overhead.
const MAX_DOCUMENTS = 512
const MAX_SOURCE_UNITS = 2 * 1024 * 1024

/** Owned by one mounted reader. Never shares transcript bodies between sessions. */
export class TranscriptContentCache {
  private path: string | null = null
  private previous = new Map<string, MarkdownDocument>()

  project(
    path: string,
    sources: readonly string[] | null,
    sourceMode: boolean,
  ): MarkdownDocument[] {
    if (path !== this.path) {
      this.path = path
      this.previous.clear()
    }
    // Refresh/error temporarily removes the snapshot, not the mounted reader.
    if (sources === null) return []
    if (!sources.length) {
      this.previous.clear()
      return []
    }
    if (sourceMode) return sources.map((source) => markdownContent(source, true))

    const next = new Map<string, MarkdownDocument>()
    let sourceUnits = 0
    const documents = sources.map((source) => {
      const document = next.get(source) ?? this.previous.get(source) ?? markdownContent(source)
      if (
        !next.has(source) &&
        !document.formattingFailed &&
        next.size < MAX_DOCUMENTS &&
        source.length <= MAX_SOURCE_UNITS - sourceUnits
      ) {
        next.set(source, document)
        sourceUnits += source.length
      }
      return document
    })
    // Keep the prior lookup intact during traversal to avoid over-budget LRU thrashing.
    this.previous = next
    return documents
  }
}
