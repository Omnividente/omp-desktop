import { expect, it } from "vitest"
import { contentLinks, isContentLink, isFileContentLink } from "./contentLinks"

it("keeps exact destinations for labelled files and punctuation-delimited URLs", () => {
  const links = contentLinks(
    "[Код](src/main.rs) [Wiki](https://example.test/Title_(detail))\nlocal://Отчёт.md, artifact://12; <https://example.test/q?a=1&b=2> mailto:dev@example.test.",
  )
  expect(links.map(({ label, uri }) => [label, uri])).toEqual([
    ["Код", "src/main.rs"],
    ["Wiki", "https://example.test/Title_(detail)"],
    ["local://Отчёт.md", "local://Отчёт.md"],
    ["artifact://12", "artifact://12"],
    ["https://example.test/q?a=1&b=2", "https://example.test/q?a=1&b=2"],
    ["mailto:dev@example.test", "mailto:dev@example.test"],
  ])
})

it("does not turn executable or network paths into active DOM destinations", () => {
  for (const uri of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "cmd:calc.exe",
    "//remote/share",
    "\\\\remote\\share",
    "https://example.test/\nscript",
    "javascript:raw",
    " ",
  ]) {
    expect(isContentLink(uri)).toBe(false)
  }
  expect(
    contentLinks("![remote](https://example.test/image) [bad](javascript:https://example.test)"),
  ).toEqual([])
})

it("preserves folder and selected document destinations for open and reveal menus", () => {
  const links = contentLinks(
    "[Папка](docs/) [Без расширения](README) [Документ](<local://Отчёт за день.md>) [Строки](docs/readme.md:raw:5-16,960-973) [Файл](file:///C:/Temp/%D0%9E%D1%82%D1%87%D1%91%D1%82%20дня.md)",
  )
  expect(links.map(({ uri }) => uri)).toEqual([
    "docs/",
    "README",
    "local://Отчёт за день.md",
    "docs/readme.md:raw:5-16,960-973",
    "file:///C:/Temp/%D0%9E%D1%82%D1%87%D1%91%D1%82%20дня.md",
  ])
  expect(links.every(({ uri }) => isFileContentLink(uri))).toBe(true)
  expect(isFileContentLink("artifact://12:raw")).toBe(true)
  expect(isFileContentLink("https://example.test/report.md")).toBe(false)
  expect(isFileContentLink("mailto:dev@example.test")).toBe(false)
  expect(isFileContentLink("javascript:alert(1)")).toBe(false)
})

it.each(["http://example.test/", "http://[::1]/path"])(
  "separates %s from an adjacent labelled destination without overlapping ranges",
  (url) => {
    const text = `${url}[Label](local://path)`
    const links = contentLinks(text)
    expect(links.map(({ label, uri }) => [label, uri])).toEqual([
      [url, url],
      ["Label", "local://path"],
    ])
    expect(links[0].end).toBe(links[1].start)
    expect(text.slice(links[1].start, links[1].end)).toBe("[Label](local://path)")
  },
)

it("keeps a valid label after unmatched opening brackets without consuming its prefix", () => {
  const prefix = "[".repeat(1000)
  expect(contentLinks(`${prefix}[Label](local://path)`)).toEqual([
    { start: prefix.length, end: prefix.length + 21, label: "Label", uri: "local://path" },
  ])
})

it("preserves escaped literal brackets in a label", () => {
  const links = contentLinks(String.raw`[a\[b](local://path)`)
  expect(links.map(({ label, uri }) => [label, uri])).toEqual([[String.raw`a\[b`, "local://path"]])
})

it.each(["http://[::1]", "https://[2001:db8::1]"])(
  "preserves the closing bracket of bare IPv6 authority %s",
  (uri) => {
    for (const suffix of ["", ".", ",", ";", "]", ")", " trailing text"]) {
      const links = contentLinks(`${uri}${suffix}`)
      expect(links).toEqual([{ start: 0, end: uri.length, label: uri, uri }])
    }
    const links = contentLinks(`${uri}[Label](local://path)`)
    expect(links.map(({ uri }) => uri)).toEqual([uri, "local://path"])
    expect(links[0].end).toBe(links[1].start)
  },
)

it.each([
  "http://[::1]/path",
  "http://[::1]:8080",
  "http://[::1]?q=value",
  "http://[::1]#section",
  "http://[::ffff:192.0.2.1]",
])("does not shorten an IPv6 URL continuation: %s", (uri) => {
  expect(contentLinks(uri).map(({ uri }) => uri)).toEqual([uri])
})

it.each([
  "http://example.test/report",
  "https://example.test/report",
  "file:///tmp/report.md",
  "local://report.md",
  "artifact://12",
])("keeps asterisk delimiters out of bare destination %s", (uri) => {
  for (const suffix of ["*", "**", "*note", "*. trailing text"]) {
    expect(contentLinks(`**${uri}${suffix}`)).toEqual([
      { start: 2, end: 2 + uri.length, label: uri, uri },
    ])
  }
})

it("preserves literal asterisks in explicitly labelled destinations", () => {
  const uri = "local://report*.md"
  expect(contentLinks(`[Report](${uri})`).map(({ uri }) => uri)).toEqual([uri])
})
