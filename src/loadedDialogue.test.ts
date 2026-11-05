import { describe, expect, it } from "vitest"
import { loadedDialogue, MAX_DIALOGUE_COPY_CHARS } from "./loadedDialogue"
import { marked, type Tokens } from "marked"
import { t } from "./i18n"
import type { SessionTranscript, TranscriptEntry } from "./types"

const entry = (
  role: string,
  dialogueText: string | null,
  text = dialogueText ?? "service",
): TranscriptEntry => ({
  id: role,
  role,
  text,
  dialogueText,
  category: dialogueText ? "dialogue" : "service",
  timestamp: "2026-11-05T00:00:00Z",
})
const transcript = (
  entries: TranscriptEntry[],
  extra: Partial<SessionTranscript> = {},
): SessionTranscript => ({
  session: {
    title: "Private title",
    filePath: "/private/session.jsonl",
    cwd: "/private/project",
  } as SessionTranscript["session"],
  entries,
  updatedAt: 1,
  truncated: false,
  malformedRecords: 0,
  incompleteLastRecord: false,
  ...extra,
})

describe("loaded dialogue excerpt", () => {
  it("preserves original Markdown, indentation, blank lines and message order", () => {
    const first = "  **hello**\n\n```ts\n\tconst n = 1\n```\n"
    const second = "A reply\n\nwith a trailing newline\n"
    expect(
      loadedDialogue(transcript([entry(" USER ", first), entry("assistant", second)]), "en"),
    ).toBe(
      `${t("en", "transcriptCopyScope")}\n\n---\n\n## User\n\n\`\`\`\`markdown\n${first}\`\`\`\`\n\n---\n\n## Assistant\n\n\`\`\`markdown\n${second}\`\`\``,
    )
  })
  it("never falls back from absent dialogue to service, thinking or tool text", () => {
    const result = loadedDialogue(
      transcript([
        entry("system", "system contents"),
        entry("tool", "tool contents"),
        entry("assistant", null, "thinking contents"),
        entry("user", "question", "question + service"),
      ]),
      "en",
    )
    expect(result).toContain("question")
    expect(result).not.toMatch(
      /system contents|tool contents|thinking contents|question \+ service/,
    )
  })
  it("does not include session identity, paths, timestamps or models", () => {
    const result = loadedDialogue(
      transcript([{ ...entry("user", "question"), model: "private-model" }]),
      "en",
    )
    expect(result).not.toMatch(/Private title|\/private|2026-11|private-model/)
  })
  it("includes all known incomplete-history warnings before copied messages", () => {
    const result = loadedDialogue(
      transcript([entry("assistant", "answer")], {
        truncated: true,
        malformedRecords: 3,
        incompleteLastRecord: true,
      }),
      "en",
    )
    for (const warning of [
      t("en", "transcriptTruncated"),
      t("en", "transcriptMalformedRecords").replace("{count}", "3"),
      t("en", "transcriptIncompleteLastRecord"),
    ]) {
      expect(result!.indexOf(warning)).toBeGreaterThan(-1)
      expect(result!.indexOf(warning)).toBeLessThan(result!.indexOf("## Assistant"))
    }
  })
  it("labels the Russian excerpt and speaker headings", () => {
    const result = loadedDialogue(
      transcript([entry("user", "Привет"), entry("assistant", "Ответ")]),
      "ru",
    )
    expect(result).toContain(t("ru", "transcriptCopyScope"))
    expect(result).toContain("## Пользователь\n\n```markdown\nПривет\n```")
    expect(result).toContain("## Ассистент\n\n```markdown\nОтвет\n```")
  })
  it("returns no copy payload when no dialogue is available", () => {
    expect(loadedDialogue(transcript([]), "en")).toBe("")
    expect(loadedDialogue(transcript([entry("tool", null), entry("assistant", "")]), "en")).toBe("")
  })
  it("does not mutate the input or trim Unicode and code content", () => {
    const value = transcript([entry("assistant", "\n👩🏽‍💻 cafe\u0301\r\n\t  code\n")])
    const before = JSON.stringify(value)
    expect(loadedDialogue(value, "en")).toContain(value.entries[0].dialogueText)
    expect(JSON.stringify(value)).toBe(before)
  })
})

it("keeps unfinished fences and HTML inside their own message source blocks", () => {
  const bodies = [
    "```ts\nunfinished",
    "<script>private()</script>\n## False speaker",
    "`````\nquoted fence\n`````",
  ]
  const result = loadedDialogue(
    transcript(bodies.map((body, index) => entry(index % 2 ? "user" : "assistant", body))),
    "en",
  )!
  const tokens = marked.lexer(result)
  expect(
    tokens
      .filter((token): token is Tokens.Heading => token.type === "heading")
      .map((token) => token.text),
  ).toEqual(["Assistant", "User", "Assistant"])
  expect(
    tokens
      .filter((token): token is Tokens.Code => token.type === "code")
      .map((token) => token.text),
  ).toEqual(bodies)
  expect(tokens.some((token) => token.type === "html")).toBe(false)
})

it("accepts the exact serialized size bound and refuses one code unit over it", () => {
  const overhead = loadedDialogue(transcript([entry("user", "x")]), "en")!.length - 1
  const body = "x".repeat(MAX_DIALOGUE_COPY_CHARS - overhead)
  expect(loadedDialogue(transcript([entry("user", body)]), "en")?.length).toBe(
    MAX_DIALOGUE_COPY_CHARS,
  )
  expect(loadedDialogue(transcript([entry("user", body + "x")]), "en")).toBeNull()
})

it("counts separating fences and UTF-16 units without truncating content", () => {
  const fences = "`".repeat(MAX_DIALOGUE_COPY_CHARS / 2)
  expect(loadedDialogue(transcript([entry("assistant", fences)]), "en")).toBeNull()
  expect(
    loadedDialogue(transcript([entry("user", "🧪".repeat(MAX_DIALOGUE_COPY_CHARS / 2))]), "en"),
  ).toBeNull()
})
