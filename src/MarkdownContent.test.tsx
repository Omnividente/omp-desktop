/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { MarkdownContent, markdownContent } from "./MarkdownContent"
import { t } from "./i18n"

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.mocked(writeText).mockReset().mockResolvedValue(undefined)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it("copies the literal fenced prompt, preserving whitespace without copying fences or activating its links", async () => {
  const literal =
    "  first line\n\t[do not open](local://secret.txt)\n<script>alert(1)</script> &amp;\n\n"
  const content = markdownContent("```text\n" + literal + "```")
  act(() =>
    root.render(<MarkdownContent content={content} lang="en" onOpen={vi.fn()} onError={vi.fn()} />),
  )
  const code = container.querySelector("pre code")!
  expect(code.textContent).toBe(literal)
  expect(content.text).toBe(literal)
  expect(code.querySelector("a, script")).toBeNull()
  const buttons = container.querySelectorAll("button")
  expect(buttons).toHaveLength(1)
  await act(async () => buttons[0].click())
  expect(writeText).toHaveBeenCalledWith(literal)
})

it("waits for the clipboard result, reports failure and allows a subsequent successful copy", async () => {
  let rejectCopy!: (error: Error) => void
  vi.mocked(writeText).mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        rejectCopy = reject
      }),
  )
  const onError = vi.fn()
  act(() =>
    root.render(
      <MarkdownContent
        content={markdownContent("```\nprompt\n```")}
        lang="en"
        onOpen={vi.fn()}
        onError={onError}
      />,
    ),
  )
  const button = container.querySelector("button")!
  act(() => button.click())
  expect(button.disabled).toBe(true)
  expect(button.textContent).not.toBe(t("en", "clipboardCopied"))
  await act(async () => rejectCopy(new Error("Clipboard denied")))
  expect(onError).toHaveBeenCalledWith("Clipboard denied")
  expect(button.disabled).toBe(false)
  expect(button.textContent).not.toBe(t("en", "clipboardCopied"))
  await act(async () => button.click())
  expect(button.textContent).toBe(t("en", "clipboardCopied"))
})

it("routes permitted links through desktop actions while raw HTML, unsafe protocols and remote images remain inert", () => {
  const onOpen = vi.fn()
  const onLinkContextMenu = vi.fn()
  const source =
    "[Отчёт](<local://Отчёт за день.md>) https://example.test/a. artifact://result mailto:user@example.test\n\n" +
    "[Вредный](javascript:alert(1)) [entity](jav&#x61;script:alert(1)) [data](data:text/html,evil) `https://inside.test`\n\n" +
    "<script>alert(1)</script>\n\n![diagram](https://images.test/private.png)"
  const content = markdownContent(source)
  act(() =>
    root.render(
      <MarkdownContent
        content={content}
        lang="en"
        onOpen={onOpen}
        onLinkContextMenu={onLinkContextMenu}
        onError={vi.fn()}
      />,
    ),
  )
  const links = container.querySelectorAll("a")
  expect(Array.from(links, (link) => link.getAttribute("href"))).toEqual([
    "local://Отчёт за день.md",
    "https://example.test/a",
    "artifact://result",
    "mailto:user@example.test",
    "https://images.test/private.png",
  ])
  const click = new MouseEvent("click", { bubbles: true, cancelable: true })
  act(() => links[0].dispatchEvent(click))
  expect(click.defaultPrevented).toBe(true)
  expect(onOpen).toHaveBeenCalledWith("local://Отчёт за день.md")
  act(() =>
    links[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  )
  expect(onLinkContextMenu.mock.calls[0][1]).toBe("local://Отчёт за день.md")
  expect(container.querySelector("script, img, iframe, object")).toBeNull()
  expect(container.textContent).toContain("<script>alert(1)</script>")
  expect(container.textContent).toContain("[Вредный](javascript:alert(1))")
  expect(container.textContent).toContain("diagram")
  expect(container.textContent).toBe(content.text)
})

it("searches decoded visible leaves across emphasis and links without losing Unicode or changing destinations", () => {
  const content = markdownContent(
    "before **nee**[dle](local://needle.txt) after &amp; \\*literal\\* 𝄞 needle",
  )
  const query = "re needle af"
  const start = content.text.indexOf(query)
  const last = content.text.lastIndexOf("needle")
  act(() =>
    root.render(
      <MarkdownContent
        content={content}
        lang="en"
        onOpen={vi.fn()}
        onError={vi.fn()}
        currentMatch={0}
        matches={[
          { start, end: start + query.length, index: 0 },
          { start: last, end: last + 6, index: 1 },
        ]}
      />,
    ),
  )
  expect(content.text).toBe("before needle after & *literal* 𝄞 needle")
  expect(container.textContent).toBe(content.text)
  expect(
    Array.from(container.querySelectorAll("mark.is-current"), (mark) => mark.textContent).join(""),
  ).toBe(query)
  expect(container.querySelector("strong mark")?.textContent).toBe("nee")
  expect(container.querySelector("a mark")?.textContent).toBe("dle")
  expect(container.querySelector("a")?.getAttribute("href")).toBe("local://needle.txt")
  expect(container.querySelector("mark:not(.is-current)")?.textContent).toBe("needle")
})

it("renders semantic blocks with nested tasks, table text and readable paragraph line breaks", () => {
  const content = markdownContent(
    "# Heading\n\nline one\nline two with *em* and ~~old~~\n\n> quote\n\n3. outer\n   - [x] complete\n   - [ ] pending\n\n---\n\n| Name | Value |\n| --- | ---: |\n| alpha | `a & b` |",
  )
  act(() =>
    root.render(<MarkdownContent content={content} lang="en" onOpen={vi.fn()} onError={vi.fn()} />),
  )
  expect(container.querySelector("h1")?.textContent).toBe("Heading")
  expect(container.querySelector("p")?.textContent).toBe("line one\nline two with em and old")
  expect(container.querySelector("em")?.textContent).toBe("em")
  expect(container.querySelector("del")?.textContent).toBe("old")
  expect(container.querySelector("blockquote")?.textContent).toBe("quote")
  expect(container.querySelector("ol")?.start).toBe(3)
  expect(container.querySelector("ol ul")?.textContent).toBe("[x] complete\n[ ] pending")
  expect(container.querySelector("hr")).not.toBeNull()
  expect(container.querySelector("table")?.textContent).toBe("Name\tValue\nalpha\ta & b")
  expect(container.textContent).toBe(content.text)
})

it("keeps unknown-language, indented and unfinished code literal, and source mode byte-for-byte unformatted", () => {
  const source = "~~~unfamiliar\n  unknown\n~~~\n\n    indented\n\n```text\nunclosed\n"
  const content = markdownContent(source)
  act(() =>
    root.render(<MarkdownContent content={content} lang="en" onOpen={vi.fn()} onError={vi.fn()} />),
  )
  expect(Array.from(container.querySelectorAll("pre code"), (code) => code.textContent)).toEqual([
    "  unknown\n",
    "indented",
    "unclosed\n",
  ])
  const rawSource = "**raw** &amp; [label](local://file.md)\r\n```text\n literal\n```"
  const raw = markdownContent(rawSource, true)
  act(() =>
    root.render(<MarkdownContent content={raw} lang="en" onOpen={vi.fn()} onError={vi.fn()} />),
  )
  expect(raw.text).toBe(rawSource)
  expect(container.textContent).toBe(rawSource)
  expect(container.querySelector("strong, a, button")).toBeNull()
})
