import { memo, useMemo } from "react"
import type { ReactNode } from "react"
import { contentLinks } from "./contentLinks"

interface LinkedTextProps {
  text: string
  onOpen: (uri: string) => void
}

export const LinkedText = memo(function LinkedText({ text, onOpen }: LinkedTextProps) {
  const links = useMemo(() => contentLinks(text), [text])
  const parts: ReactNode[] = []
  let offset = 0
  for (const link of links) {
    if (link.start < offset) continue
    parts.push(text.slice(offset, link.start))
    parts.push(
      <a
        className="content-link"
        href={link.uri}
        key={link.start}
        onClick={(event) => {
          event.preventDefault()
          onOpen(link.uri)
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return
          event.preventDefault()
          onOpen(link.uri)
        }}
        title={link.uri}
      >
        {link.label}
      </a>,
    )
    offset = link.end
  }
  parts.push(text.slice(offset))
  return <pre>{parts}</pre>
})
