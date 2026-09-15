import { expect, it } from "vitest"
import { contentLinks, isContentLink } from "./contentLinks"

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
  ]) {
    expect(isContentLink(uri)).toBe(false)
  }
  expect(
    contentLinks("![remote](https://example.test/image) [bad](javascript:https://example.test)"),
  ).toEqual([])
})
