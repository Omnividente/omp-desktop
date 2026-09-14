import { Fragment, memo, useMemo } from "react"
import type { MouseEvent, ReactNode } from "react"
import { contentLinks, isFileContentLink } from "./contentLinks"

export interface LinkedTextContent {
  text: string
  parts: Array<{ text: string; start: number; uri?: string }>
}

export interface TextMatch {
  start: number
  end: number
  index: number
}

/** Search and render the same visible text, including labels rather than hidden Markdown destinations. */
export function linkedTextContent(source: string): LinkedTextContent {
  const parts: LinkedTextContent["parts"] = []
  let offset = 0
  let displayOffset = 0
  for (const link of contentLinks(source)) {
    if (link.start < offset) continue
    const plain = source.slice(offset, link.start)
    if (plain) parts.push({ text: plain, start: displayOffset })
    displayOffset += plain.length
    parts.push({ text: link.label, start: displayOffset, uri: link.uri })
    displayOffset += link.label.length
    offset = link.end
  }
  if (offset < source.length) parts.push({ text: source.slice(offset), start: displayOffset })
  return { text: parts.map((part) => part.text).join(""), parts }
}

interface LinkedTextProps {
  text: string | LinkedTextContent
  onOpen: (uri: string) => void
  onLinkContextMenu?: (event: MouseEvent<HTMLAnchorElement>, uri: string) => void
  matches?: TextMatch[]
  currentMatch?: number
}

export const LinkedText = memo(function LinkedText({
  text,
  onOpen,
  onLinkContextMenu,
  matches = [],
  currentMatch,
}: LinkedTextProps) {
  const content = useMemo(() => (typeof text === "string" ? linkedTextContent(text) : text), [text])
  const parts: ReactNode[] = []
  let matchCursor = 0
  for (const part of content.parts) {
    const children: ReactNode[] = []
    let offset = 0
    const end = part.start + part.text.length
    while (matchCursor < matches.length && matches[matchCursor].end <= part.start) matchCursor++
    for (
      let cursor = matchCursor;
      cursor < matches.length && matches[cursor].start < end;
      cursor++
    ) {
      const match = matches[cursor]
      const start = Math.max(0, match.start - part.start)
      const matchEnd = Math.min(part.text.length, match.end - part.start)
      children.push(part.text.slice(offset, start))
      children.push(
        <mark
          key={match.index}
          className={match.index === currentMatch ? "is-current" : undefined}
          data-match-index={match.index}
        >
          {part.text.slice(start, matchEnd)}
        </mark>,
      )
      offset = matchEnd
    }
    children.push(part.text.slice(offset))
    if (!part.uri) {
      parts.push(<Fragment key={part.start}>{children}</Fragment>)
      continue
    }
    const uri = part.uri
    parts.push(
      <a
        className="content-link"
        href={uri}
        key={part.start}
        onClick={(event) => {
          event.preventDefault()
          onOpen(uri)
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return
          event.preventDefault()
          onOpen(uri)
        }}
        onContextMenu={(event) => {
          if (isFileContentLink(uri) && onLinkContextMenu) onLinkContextMenu(event, uri)
        }}
        title={uri}
      >
        {children}
      </a>,
    )
  }
  return <pre>{parts}</pre>
})
