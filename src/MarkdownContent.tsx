import { createElement, Fragment, memo, type MouseEvent, type ReactNode } from "react"
import { marked, type MarkedToken, type Token, type Tokens } from "marked"
import { contentLinks, isContentLink, isFileContentLink } from "./contentLinks"
import { CopyButton } from "./CopyButton"
import { t, type Lang } from "./i18n"
import "./MarkdownContent.css"

export interface TextMatch {
  start: number
  end: number
  index: number
}

type MarkdownTag =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "strong"
  | "em"
  | "del"
  | "code"
  | "blockquote"
  | "ul"
  | "ol"
  | "li"
  | "hr"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "th"
  | "td"
  | "span"
  | "a"
interface TextNode {
  kind: "text"
  value: string
  start: number
}
interface ElementNode {
  kind: "element"
  tag: MarkdownTag
  children: MarkdownNode[]
  uri?: string
  className?: string
  start?: number
  align?: "left" | "center" | "right" | null
}
interface CodeNode {
  kind: "code"
  language: string
  body: TextNode
}
type MarkdownNode = TextNode | ElementNode | CodeNode

export interface MarkdownDocument {
  /** Visible body only: no hidden destinations, fence markers or copy controls. */
  text: string
  nodes: MarkdownNode[]
  sourceMode: boolean
}

// Decode only character references, never markup. The detached textarea receives
// one entity at a time, so source tags cannot create DOM nodes or fetch resources.
let entityDecoder: HTMLTextAreaElement | undefined
function decodeEntities(text: string): string {
  return text.replace(/&(?:#[0-9]{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]+);/g, (entity) => {
    entityDecoder ??= document.createElement("textarea")
    entityDecoder.innerHTML = entity
    return entityDecoder.value
  })
}

function codeBody(token: Tokens.Code): string {
  if (token.codeBlockStyle === "indented") return token.text
  const opening = /^( {0,3})(`{3,}|~{3,})[^\n]*\n/.exec(token.raw)
  if (!opening) return token.text
  const body = token.raw.slice(opening[0].length)
  const closing = new RegExp(
    `^ {0,3}${opening[2][0]}{${opening[2].length},}[ \\t]*(?:\\n|$)`,
    "m",
  ).exec(body)
  const literal = closing ? body.slice(0, closing.index) : body
  const indent = opening[1].length
  // Match CommonMark's removal of the opening fence's indentation only.
  return indent
    ? literal.replace(/^ */gm, (spaces) => spaces.slice(Math.min(indent, spaces.length)))
    : literal
}

/** Parse once per entry. Search, displayed-message copy and highlights share these leaves. */
export function markdownContent(source: string, sourceMode = false): MarkdownDocument {
  const chunks: string[] = []
  let offset = 0
  const leaf = (value: string): TextNode => {
    const node: TextNode = { kind: "text", value, start: offset }
    chunks.push(value)
    offset += value.length
    return node
  }
  const element = (
    tag: MarkdownTag,
    children: MarkdownNode[],
    extra: Partial<Omit<ElementNode, "kind" | "tag" | "children">> = {},
  ): ElementNode => ({ kind: "element", tag, children, ...extra })
  const plain = (text: string, links: boolean): MarkdownNode[] => {
    if (!links) return [leaf(text)]
    const nodes: MarkdownNode[] = []
    let cursor = 0
    for (const link of contentLinks(text)) {
      if (link.start < cursor || !isContentLink(link.uri)) continue
      if (link.start > cursor) nodes.push(leaf(text.slice(cursor, link.start)))
      nodes.push(element("a", [leaf(link.label)], { uri: link.uri }))
      cursor = link.end
    }
    if (cursor < text.length) nodes.push(leaf(text.slice(cursor)))
    return nodes
  }
  const inline = (tokens: Token[], links = true): MarkdownNode[] =>
    tokens.flatMap((entry): MarkdownNode[] => {
      const token = entry as MarkedToken
      switch (token.type) {
        case "strong":
        case "em":
        case "del":
          return [element(token.type, inline(token.tokens, links))]
        case "codespan":
          return [element("code", [leaf(token.text)])]
        case "escape":
          return [leaf(token.text)]
        case "html":
          return [leaf(token.raw)]
        case "br":
          return [leaf("\n")]
        case "checkbox":
          return [
            element("span", [leaf(token.checked ? "[x] " : "[ ] ")], {
              className: "markdown-task",
            }),
          ]
        case "link": {
          const uri = token.autolink ? token.href : decodeEntities(token.href)
          if (!links || !isContentLink(uri)) return [leaf(token.raw)]
          const children = token.autolink ? [leaf(token.text)] : inline(token.tokens, false)
          return [element("a", children, { uri })]
        }
        case "image": {
          const uri = decodeEntities(token.href)
          // Images are captions with an explicit link, never <img> or CSS URLs.
          const caption = token.text || token.title || token.href
          const children = [leaf(decodeEntities(caption))]
          return [
            element(links && isContentLink(uri) ? "a" : "span", children, {
              uri: links && isContentLink(uri) ? uri : undefined,
              className: "markdown-image-caption",
            }),
          ]
        }
        case "text":
          if (token.tokens) return inline(token.tokens, links)
          return plain(
            token.escaped ? token.text : decodeEntities(token.text),
            links && !token.escaped,
          )
        default:
          return [leaf(token.raw)]
      }
    })
  const blocks = (tokens: Token[], separator = "\n\n"): MarkdownNode[] => {
    const nodes: MarkdownNode[] = []
    let afterCheckbox = false
    for (const entry of tokens) {
      const token = entry as MarkedToken
      if (token.type === "space" || token.type === "def") continue
      if (nodes.length && !afterCheckbox) nodes.push(leaf(separator))
      afterCheckbox = token.type === "checkbox"
      switch (token.type) {
        case "heading":
          nodes.push(element(`h${token.depth}` as MarkdownTag, inline(token.tokens)))
          break
        case "paragraph":
          nodes.push(element("p", inline(token.tokens)))
          break
        case "text":
          nodes.push(...inline([token]))
          break
        case "code":
          nodes.push({
            kind: "code",
            language: decodeEntities(token.lang?.split(/\s+/, 1)[0] ?? ""),
            body: leaf(codeBody(token)),
          })
          break
        case "blockquote":
          nodes.push(element("blockquote", blocks(token.tokens)))
          break
        case "list": {
          const items = token.items.map((item, index) => {
            // Keep structural separators inside <li>, never invalid children of lists.
            const children = blocks(item.tokens, "\n")
            if (index < token.items.length - 1) children.push(leaf("\n"))
            return element("li", children, {
              className: item.task ? "markdown-task-item" : undefined,
            })
          })
          nodes.push(
            element(token.ordered ? "ol" : "ul", items, {
              start: token.ordered ? Number(token.start) : undefined,
            }),
          )
          break
        }
        case "table": {
          const row = (cells: Tokens.TableCell[], last: boolean): ElementNode =>
            element(
              "tr",
              cells.map((cell, index) => {
                const children = inline(cell.tokens)
                if (index < cells.length - 1) children.push(leaf("\t"))
                else if (!last) children.push(leaf("\n"))
                return element(cell.header ? "th" : "td", children, { align: cell.align })
              }),
            )
          const head = element("thead", [row(token.header, token.rows.length === 0)])
          const body = element(
            "tbody",
            token.rows.map((cells, index) => row(cells, index === token.rows.length - 1)),
          )
          nodes.push(element("table", [head, body]))
          break
        }
        case "hr":
          nodes.push(element("hr", []))
          break
        case "html":
          nodes.push(element("p", [leaf(token.raw)], { className: "markdown-literal-html" }))
          break
        default:
          nodes.push(...inline([token]))
      }
    }
    return nodes
  }
  const nodes = sourceMode ? [leaf(source)] : blocks(marked.lexer(source, { gfm: true }))
  return { text: chunks.join(""), nodes, sourceMode }
}

interface MarkdownContentProps {
  content: MarkdownDocument
  lang: Lang
  onOpen: (uri: string) => void
  onLinkContextMenu?: (event: MouseEvent<HTMLAnchorElement>, uri: string) => void
  onError: (message: string) => void
  matches?: TextMatch[]
  currentMatch?: number
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  lang,
  onOpen,
  onLinkContextMenu,
  onError,
  matches = [],
  currentMatch,
}: MarkdownContentProps) {
  let matchCursor = 0
  const text = (node: TextNode): ReactNode => {
    const parts: ReactNode[] = []
    const end = node.start + node.value.length
    let offset = 0
    while (matchCursor < matches.length && matches[matchCursor].end <= node.start) matchCursor++
    for (
      let cursor = matchCursor;
      cursor < matches.length && matches[cursor].start < end;
      cursor++
    ) {
      const match = matches[cursor]
      const start = Math.max(offset, match.start - node.start)
      const stop = Math.min(node.value.length, match.end - node.start)
      if (stop <= start) continue
      parts.push(node.value.slice(offset, start))
      parts.push(
        <mark
          key={match.index}
          className={match.index === currentMatch ? "is-current" : undefined}
          data-match-index={match.index}
        >
          {node.value.slice(start, stop)}
        </mark>,
      )
      offset = stop
    }
    parts.push(node.value.slice(offset))
    return parts
  }
  const render = (nodes: MarkdownNode[]): ReactNode =>
    nodes.map((node, index) => {
      if (node.kind === "text") return <Fragment key={index}>{text(node)}</Fragment>
      if (node.kind === "code")
        return (
          <section className="markdown-code-block" key={index}>
            <header className="markdown-code-toolbar" data-markdown-controls="true">
              <span>{node.language || t(lang, "transcriptCodeText")}</span>
              <CopyButton
                text={node.body.value}
                label={t(lang, "copyCode")}
                lang={lang}
                onError={onError}
              />
            </header>
            <pre tabIndex={0}>
              <code>{text(node.body)}</code>
            </pre>
          </section>
        )
      const children = render(node.children)
      if (node.tag === "a" && node.uri) {
        const uri = node.uri
        return (
          <a
            key={index}
            href={uri}
            title={uri}
            className={`content-link ${node.className ?? ""}`}
            onClick={(event) => {
              event.preventDefault()
              onOpen(uri)
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                onOpen(uri)
              }
            }}
            onContextMenu={(event) => {
              if (isFileContentLink(uri) && onLinkContextMenu) onLinkContextMenu(event, uri)
            }}
          >
            {children}
          </a>
        )
      }
      const rendered = createElement(
        node.tag,
        {
          key: index,
          className: node.className,
          ...(node.tag === "ol" ? { start: node.start } : {}),
          ...(node.tag === "th" || node.tag === "td"
            ? { style: { textAlign: node.align ?? undefined } }
            : {}),
        },
        node.tag === "hr" ? undefined : children,
      )
      return node.tag === "table" ? (
        <div className="markdown-table-scroll" key={index} tabIndex={0}>
          {rendered}
        </div>
      ) : (
        rendered
      )
    })
  return content.sourceMode ? (
    <pre className="markdown-content markdown-source">{render(content.nodes)}</pre>
  ) : (
    <div className="markdown-content">{render(content.nodes)}</div>
  )
})
