/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest"
import { replaceTerminalRow } from "./terminalDomRows"

function rowFixture() {
  const container = document.createElement("div")
  container.setAttribute("data-omp-reuse-dom-rows", "")
  const row = document.createElement("div")
  container.append(row)
  document.body.append(container)
  return row
}

function span(text: string, className = "", style = "") {
  const element = document.createElement("span")
  element.textContent = text
  element.className = className
  element.setAttribute("style", style)
  return element
}

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

it("keeps an unchanged visible row and its selected text attached without DOM mutations", () => {
  const row = rowFixture()
  const original = span("Привет 世界 e\u0301 😀", "xterm-fg-2", "letter-spacing: 0px;")
  row.append(original)
  const range = document.createRange()
  range.selectNodeContents(original)
  window.getSelection()?.addRange(range)
  const observer = new MutationObserver(() => undefined)
  observer.observe(row, { childList: true, subtree: true, attributes: true, characterData: true })

  replaceTerminalRow(row, [span("Привет 世界 e\u0301 😀", "xterm-fg-2", "letter-spacing: 0px;")])

  expect(observer.takeRecords()).toEqual([])
  expect(window.getSelection()?.toString()).toBe("Привет 世界 e\u0301 😀")
  expect(original.isConnected).toBe(true)
  observer.disconnect()
})

it("applies style-only selection, cursor and link changes and removes them again", () => {
  const row = rowFixture()
  row.append(span("link"))
  replaceTerminalRow(row, [
    span(
      "link",
      "xterm-cursor xterm-cursor-bar xterm-decoration-top",
      "color: rgb(1, 2, 3); text-decoration: underline;",
    ),
  ])
  const highlighted = row.firstElementChild as HTMLElement
  expect(highlighted.classList.contains("xterm-cursor")).toBe(true)
  expect(highlighted.classList.contains("xterm-decoration-top")).toBe(true)
  expect(highlighted.style.color).toBe("rgb(1, 2, 3)")
  expect(highlighted.style.textDecoration).toBe("underline")

  replaceTerminalRow(row, [span("link")])
  expect(row.textContent).toBe("link")
  expect(row.querySelector(".xterm-cursor, .xterm-decoration-top")).toBeNull()
  expect((row.firstElementChild as HTMLElement).style.textDecoration).toBe("")
})

it("replaces changed Unicode text even when span counts and attributes match", () => {
  const row = rowFixture()
  row.append(span("界 e\u0301 😀", "xterm-fg-4"))
  replaceTerminalRow(row, [span("語 e\u0308 🚀", "xterm-fg-4")])
  expect(row.textContent).toBe("語 e\u0308 🚀")
})

it("handles split and merged style runs, erased rows and subsequent output", () => {
  const row = rowFixture()
  row.append(span("red blue"))
  replaceTerminalRow(row, [span("red", "xterm-fg-1"), span(" blue", "xterm-fg-4")])
  expect(row.textContent).toBe("red blue")
  expect(row.querySelector(".xterm-fg-4")?.textContent).toBe(" blue")
  replaceTerminalRow(row, [span("replacement", "xterm-fg-2")])
  expect(row.textContent).toBe("replacement")
  expect(row.querySelector(".xterm-fg-4")).toBeNull()
  replaceTerminalRow(row, [])
  expect(row.textContent).toBe("")
  replaceTerminalRow(row, [span("after clear")])
  expect(row.textContent).toBe("after clear")
})
