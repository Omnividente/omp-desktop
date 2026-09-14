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
