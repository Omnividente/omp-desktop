/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it } from "vitest"
import { KeyboardShortcuts } from "./KeyboardShortcuts"
import { t, type Lang } from "./i18n"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it.each([
  ["en", "windows"],
  ["ru", "windows"],
  ["en", "linux"],
  ["ru", "linux"],
  ["en", "macos"],
  ["ru", "macos"],
] as const)("shows scoped commands in %s on %s", (language, platform) => {
  act(() => root.render(<KeyboardShortcuts language={language} platform={platform} />))
  const details = container.querySelector("details")!
  const summary = details.querySelector("summary")!
  expect(details.open).toBe(false)
  expect(summary.textContent).toBe(t(language, "keyboardShortcutsTitle"))
  act(() => summary.click())
  expect(details.open).toBe(true)
  const modifier = platform === "macos" ? "⌘" : "Ctrl"
  expect(Array.from(container.querySelectorAll("kbd"), (element) => element.textContent)).toEqual([
    `${modifier} + Shift + O`,
    `${modifier} + B`,
    `${modifier} + N`,
    `${modifier} + W`,
    "Alt + Shift + ← / →",
    `${modifier} + F`,
    "↑ / ↓ / Home / End",
  ])
  const scopes = Array.from(container.querySelectorAll("small"), (element) => element.textContent)
  expect(scopes).toEqual([
    ...Array<string>(4).fill(t(language, "shortcutDesktopScope")),
    t(language, "shortcutTabScope"),
    t(language, "shortcutHistoryScope"),
    t(language, "shortcutCategoryScope"),
  ])
  expect(container.textContent).toContain(t(language, "keyboardShortcutsHelp"))
  expect(container.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0)
  act(() => summary.click())
  expect(details.open).toBe(false)
})

it("updates the reference language without resetting its disclosure", () => {
  const render = (language: Lang) =>
    act(() => root.render(<KeyboardShortcuts language={language} platform="windows" />))
  render("en")
  act(() => container.querySelector("summary")!.click())
  render("ru")
  expect(container.querySelector("details")!.open).toBe(true)
  expect(container.querySelector("summary")!.textContent).toBe(t("ru", "keyboardShortcutsTitle"))
  expect(container.textContent).toContain(t("ru", "shortcutCategoryScope"))
  expect(container.textContent).not.toContain(t("en", "shortcutCategoryScope"))
})
