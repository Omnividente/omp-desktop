export interface ContentLink {
  start: number
  end: number
  label: string
  uri: string
}

// The backend is the authority for paths, containment and protocol validation.
// This allowlist prevents rendering executable URLs as active DOM anchors.
export function isContentLink(uri: string): boolean {
  if (!uri || uri.startsWith("\\\\")) return false
  for (let index = 0; index < uri.length; index++) {
    const code = uri.charCodeAt(index)
    if (code < 32 || code === 127) return false
  }
  if (/^(?:https?:\/\/|mailto:|file:\/\/|local:\/\/|artifact:\/\/)/i.test(uri)) return true
  if (/^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith("//") || uri.startsWith("#")) return false
  return !uri.startsWith("/") && /[^/]+\.[^/]+$/.test(uri)
}

// xterm's addon handles wrapped lines and Unicode cell positions. Use the same
// conservative URL boundary for hierarchical links in the transcript.
export const CONTENT_URL_PATTERN =
  /(?:https?|file|local|artifact):\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':;,.!?{}|\\^~\[\]`()<>]/gi
const MARKDOWN_LINK =
  /\[([^\]\n]+)\]\((<[^>\n]+>|(?:\\.|[^()\s\\]|\([^()\s]*\))+)(?:\s+"[^"\n]*")?\)/g
const MAIL_LINK = /mailto:[^\s<>"'`]+/gi

function trimMailLink(value: string): string {
  return value.replace(/[.,;!?\])}]+$/, "")
}

export function contentLinks(text: string): ContentLink[] {
  const links: ContentLink[] = []
  const markdownSpans: Array<{ start: number; end: number }> = []
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    markdownSpans.push({ start: match.index, end: match.index + match[0].length })
    const destination = match[2]
    const uri = (destination.startsWith("<") ? destination.slice(1, -1) : destination).replace(
      /\\([\\()])/g,
      "$1",
    )
    // Images are not links. Unsafe Markdown remains text, including its label.
    if (text[match.index - 1] !== "!" && isContentLink(uri)) {
      links.push({ start: match.index, end: match.index + match[0].length, label: match[1], uri })
    }
  }
  for (const pattern of [CONTENT_URL_PATTERN, MAIL_LINK]) {
    let markdownIndex = 0
    for (const match of text.matchAll(pattern)) {
      const uri = pattern === MAIL_LINK ? trimMailLink(match[0]) : match[0]
      while (
        markdownIndex < markdownSpans.length &&
        markdownSpans[markdownIndex].end <= match.index
      ) {
        markdownIndex++
      }
      if (markdownSpans[markdownIndex]?.start <= match.index) continue
      links.push({ start: match.index, end: match.index + uri.length, label: uri, uri })
    }
  }
  return links.sort((left, right) => left.start - right.start)
}
