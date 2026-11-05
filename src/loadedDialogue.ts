import { t, type Lang } from "./i18n"
import type { SessionTranscript } from "./types"

// Bound additional serialization and the clipboard request, not the source reader.
// String.length counts UTF-16 code units; this is not an OS clipboard byte limit.
export const MAX_DIALOGUE_COPY_CHARS = 4 * 1024 * 1024

/** A portable reading excerpt, not a backup or a complete session export. null means too large. */
export function loadedDialogue(transcript: SessionTranscript, lang: Lang): string | null {
  const notes = [t(lang, "transcriptCopyScope")]
  if (transcript.truncated) notes.push(t(lang, "transcriptTruncated"))
  if (transcript.malformedRecords > 0)
    notes.push(
      t(lang, "transcriptMalformedRecords").replace("{count}", String(transcript.malformedRecords)),
    )
  if (transcript.incompleteLastRecord) notes.push(t(lang, "transcriptIncompleteLastRecord"))

  const separator = "\n\n---\n\n"
  const parts = [notes.join("\n\n")]
  let length = parts[0].length
  for (const entry of transcript.entries) {
    const role = entry.role.trim().toLocaleLowerCase("en-US")
    if (!entry.dialogueText || (role !== "user" && role !== "assistant")) continue
    const heading = `## ${t(lang, role === "user" ? "transcriptRoleUser" : "transcriptRoleAssistant")}\n\n`
    const body = entry.dialogueText
    // Separate source blocks keep unfinished Markdown in one message from swallowing
    // the next speaker heading. Never change the original message text itself.
    if (length + separator.length + heading.length + body.length > MAX_DIALOGUE_COPY_CHARS)
      return null
    let longestRun = 0
    let run = 0
    for (let index = 0; index < body.length; index++) {
      run = body[index] === "`" ? run + 1 : 0
      longestRun = Math.max(longestRun, run)
    }
    const fenceLength = Math.max(3, longestRun + 1)
    const trailingNewline = body.endsWith("\n") ? "" : "\n"
    length +=
      separator.length +
      heading.length +
      body.length +
      fenceLength * 2 +
      "markdown\n".length +
      trailingNewline.length
    if (length > MAX_DIALOGUE_COPY_CHARS) return null
    const fence = "`".repeat(fenceLength)
    parts.push(separator, heading, fence, "markdown\n", body, trailingNewline, fence)
  }
  return parts.length > 1 ? parts.join("") : ""
}
