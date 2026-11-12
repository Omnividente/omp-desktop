/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { marked } from "marked"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { MarkdownContent, markdownContent } from "./MarkdownContent"
import { SEARCH_HIGHLIGHT_LIMIT, TranscriptSearch } from "./transcriptSearch"
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
  vi.restoreAllMocks()
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

it("renders bounded first, distant and last highlight windows without truncating a million-match entry", () => {
  const content = markdownContent("x".repeat(1_000_000))
  const search = new TranscriptSearch([content], "x")
  expect(search.count).toBe(1_000_000)
  for (const currentMatch of [0, 500_000, 999_999, 0, 999_999]) {
    const matches = search.matchesForEntry(0, currentMatch)
    expect(matches.length).toBeLessThanOrEqual(SEARCH_HIGHLIGHT_LIMIT)
    act(() =>
      root.render(
        <MarkdownContent
          content={content}
          lang="en"
          onOpen={vi.fn()}
          onError={vi.fn()}
          matches={matches}
          currentMatch={currentMatch}
        />,
      ),
    )
    const marks = container.querySelectorAll("mark[data-match-index]")
    expect(marks.length).toBeLessThanOrEqual(SEARCH_HIGHLIGHT_LIMIT)
    expect(marks.length).toBe(matches.length)
    expect(container.querySelector("mark.is-current")?.getAttribute("data-match-index")).toBe(
      String(currentMatch),
    )
    expect(container.querySelector("mark.is-current")?.textContent).toBe("x")
    expect(container.textContent).toBe(content.text)
  }
  act(() =>
    root.render(<MarkdownContent content={content} lang="en" onOpen={vi.fn()} onError={vi.fn()} />),
  )
  expect(container.querySelector("mark")).toBeNull()
  expect(container.textContent).toBe(content.text)
})

it("bounds marks across split Markdown leaves and reserves the late active anchor", () => {
  const group = "**x** ".repeat(700)
  const content = markdownContent(`${group}\n\n${group}`)
  const search = new TranscriptSearch([content], markdownContent(group).text)
  expect(search.count).toBe(2)
  for (const currentMatch of [1, 0, 1]) {
    act(() =>
      root.render(
        <MarkdownContent
          content={content}
          lang="en"
          onOpen={vi.fn()}
          onError={vi.fn()}
          matches={search.matchesForEntry(0, currentMatch)}
          currentMatch={currentMatch}
        />,
      ),
    )
    expect(container.querySelectorAll("mark").length).toBeLessThanOrEqual(SEARCH_HIGHLIGHT_LIMIT)
    expect(container.querySelector("mark.is-current")?.getAttribute("data-match-index")).toBe(
      String(currentMatch),
    )
    expect(container.querySelector("mark.is-current")?.textContent).toBe("x")
    expect(container.querySelectorAll("strong")).toHaveLength(1400)
    expect(container.textContent).toBe(content.text)
  }
})

it.each([
  ["backticks at EOF", "```", "\t", false],
  ["tildes at EOF", "~~~", " \t ", false],
  ["backticks before a closing fence", "```", "\t", true],
  ["tildes before a closing fence", "~~~", " \t ", true],
] as const)(
  "keeps a tab-suffixed fence and its following text: %s",
  async (_name, fence, suffix, closed) => {
    const literal = `  alpha\n${fence}${suffix}\n\nIMPORTANT follow-up\n`
    const source = `${fence}text\n${literal}${closed ? fence : ""}`
    const content = markdownContent(source)
    expect(content.text).toBe(literal)
    const search = new TranscriptSearch([content], "IMPORTANT")
    expect(search.count).toBe(1)
    act(() =>
      root.render(
        <MarkdownContent
          content={content}
          lang="en"
          onOpen={vi.fn()}
          onError={vi.fn()}
          matches={search.matchesForEntry(0, 0)}
          currentMatch={0}
        />,
      ),
    )
    expect(container.querySelector("pre code")?.textContent).toBe(literal)
    expect(container.querySelector("mark.is-current")?.textContent).toBe("IMPORTANT")
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click())
    expect(writeText).toHaveBeenCalledWith(literal)
    const raw = markdownContent(source, true)
    act(() =>
      root.render(<MarkdownContent content={raw} lang="en" onOpen={vi.fn()} onError={vi.fn()} />),
    )
    expect(raw.text).toBe(source)
    expect(container.textContent).toBe(source)
    expect(new TranscriptSearch([raw], "IMPORTANT").count).toBe(1)
  },
)

it.each([
  ["equal closing fence at EOF", "```\nalpha\n```", "alpha\n"],
  ["longer fence and spaces before LF", "```\nalpha\n````  \n", "alpha\n"],
  ["three-space closing indent", "~~~\nalpha\n   ~~~\n", "alpha\n"],
  ["opening indentation and blank lines", "  ```\n    alpha\n\n  ```", "  alpha\n\n"],
  ["shorter fence", "````\nalpha\n```\ntail\n", "alpha\n```\ntail\n"],
  ["other fence character", "```\nalpha\n~~~\ntail\n", "alpha\n~~~\ntail\n"],
  ["four-space closing indent", "```\nalpha\n    ```\ntail\n", "alpha\n    ```\ntail\n"],
  ["text after fence", "~~~\nalpha\n~~~x\ntail\n", "alpha\n~~~x\ntail\n"],
])("preserves fenced code boundaries: %s", (_name, source, expected) => {
  const content = markdownContent(source)
  expect(content.text).toBe(expected)
  act(() =>
    root.render(<MarkdownContent content={content} lang="en" onOpen={vi.fn()} onError={vi.fn()} />),
  )
  expect(container.querySelector("pre code")?.textContent).toBe(expected)
})

it.each(["en", "ru"] as const)(
  "keeps deeply nested Markdown readable and searchable after a parser failure (%s)",
  (lang) => {
    const source = "> ".repeat(8000) + "needle <script>inert</script> https://example.test"
    const content = markdownContent(source)
    expect(content.formattingFailed).toBe(true)
    expect(content.sourceMode).toBe(true)
    expect(content.text).toBe(source)
    const search = new TranscriptSearch([content], "needle")
    expect(search.count).toBe(1)
    act(() =>
      root.render(
        <MarkdownContent
          content={content}
          lang={lang}
          onOpen={vi.fn()}
          onError={vi.fn()}
          matches={search.matchesForEntry(0, 0)}
          currentMatch={0}
        />,
      ),
    )
    expect(container.querySelector(".markdown-source")?.textContent).toBe(source)
    expect(container.querySelector("mark.is-current")?.textContent).toBe("needle")
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      t(lang, "markdownFormattingFailed"),
    )
    expect(container.querySelector("script, a, img")).toBeNull()
    act(() =>
      root.render(
        <MarkdownContent
          content={markdownContent("**ordinary**")}
          lang={lang}
          onOpen={vi.fn()}
          onError={vi.fn()}
        />,
      ),
    )
    expect(container.querySelector("strong")?.textContent).toBe("ordinary")
    expect(container.querySelector('[role="status"]')).toBeNull()
  },
)

it("discards partial leaves and offsets if Markdown node conversion fails", () => {
  const tokens = marked.lexer("already parsed\n\n**later**")
  Object.defineProperty(tokens[1], "type", {
    get: () => {
      throw new Error("Synthetic conversion failure")
    },
  })
  vi.spyOn(marked, "lexer").mockReturnValueOnce(tokens)
  const source = "source stays complete"
  expect(markdownContent(source)).toEqual({
    text: source,
    nodes: [{ kind: "text", value: source, start: 0 }],
    sourceMode: true,
    formattingFailed: true,
  })
})

it("does not parse explicit source mode or mark ordinary Markdown as a fallback", () => {
  const lexer = vi.spyOn(marked, "lexer")
  const source = "> ".repeat(8000) + "literal"
  const raw = markdownContent(source, true)
  expect(lexer).not.toHaveBeenCalled()
  expect(raw.text).toBe(source)
  expect(raw.formattingFailed).toBeUndefined()
  expect(markdownContent("**ordinary**").formattingFailed).toBeUndefined()
  expect(lexer).toHaveBeenCalledTimes(1)
})
