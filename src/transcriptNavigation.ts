import type { TranscriptEntry } from "./types"

// Bound both native option count and preview processing. The existing reader
// remains available beyond this small outline; no entries are removed from it.
export const TRANSCRIPT_OUTLINE_LIMIT = 100
const PREVIEW_SCAN_LIMIT = 512
const PREVIEW_LENGTH = 80

function preview(text: string) {
  let prefix = text.slice(0, PREVIEW_SCAN_LIMIT)
  // Do not split a surrogate pair at the scan boundary.
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1)
  const points = Array.from(prefix.replace(/\s+/gu, " ").trim())
  return (
    points.slice(0, PREVIEW_LENGTH).join("") +
    (text.length > prefix.length || points.length > PREVIEW_LENGTH ? "…" : "")
  )
}

// Navigation uses loaded order, not an inferred active branch.
export function transcriptUserMessages(entries: readonly TranscriptEntry[]) {
  const messages: Array<{ id: string; preview: string }> = []
  for (const entry of entries) {
    if (entry.role.trim().toLocaleLowerCase("en-US") !== "user") continue
    if (messages.length === TRANSCRIPT_OUTLINE_LIMIT) return { messages, limited: true }
    messages.push({ id: entry.id, preview: preview(entry.dialogueText ?? entry.text) })
  }
  return { messages, limited: false }
}
