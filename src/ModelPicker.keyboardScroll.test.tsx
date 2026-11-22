/** @vitest-environment jsdom */
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ModelPicker } from "./ModelPicker"
import type { Lang } from "./i18n"
import type { OmpModelInfo } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const catalog: OmpModelInfo[] = Array.from({ length: 10 }, (_, index) => ({
  provider: "synthetic",
  id: `model-${index}`,
  selector: `synthetic/model-${index}`,
  name: `Model ${index}`,
  available: true,
  status: "ready",
  detail: null,
  thinking: ["high"],
}))
const changes = vi.fn()
let container: HTMLDivElement
let root: Root

function Picker({
  language = "en",
  models = catalog,
}: {
  language?: Lang
  models?: OmpModelInfo[]
}) {
  const [open, setOpen] = useState(true)
  return (
    <ModelPicker
      language={language}
      models={models}
      value="synthetic/model-0:high"
      open={open}
      onChange={changes}
      onOpenChange={setOpen}
      role="default"
    />
  )
}

const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
const search = () => container.querySelector<HTMLInputElement>(".model-picker-search input")!
const listbox = () => container.querySelector<HTMLElement>('[role="listbox"]')!
const key = (target: HTMLElement, value: string, extra: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    )
  })

// jsdom does not lay out the catalog. Explicit synthetic geometry exercises the
// mounted component's handlers; it is not native browser or screen-reader proof.
function geometry({ scroll = 0, rowHeight = 30, height = 100 } = {}) {
  const list = listbox()
  const rows = options()
  Object.defineProperties(list, {
    clientTop: { configurable: true, value: 2 },
    clientHeight: { configurable: true, value: height },
  })
  list.scrollTop = scroll
  container.scrollTop = 123
  vi.spyOn(list, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 50, 200, height + 4),
  )
  rows.forEach((row, index) => {
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 52 + index * rowHeight - list.scrollTop, 197, rowHeight),
    )
  })
  return list
}

function expectViewport(list: HTMLElement, scroll: number, focusedIndex: number) {
  expect(list.scrollTop).toBe(scroll)
  expect(container.scrollTop).toBe(123)
  expect(document.activeElement).toBe(options()[focusedIndex])
  expect(document.getElementById(list.getAttribute("aria-activedescendant")!)).toBe(
    options()[focusedIndex],
  )
  expect(changes).not.toHaveBeenCalled()
}

beforeEach(() => {
  changes.mockReset()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Picker />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it.each(["en", "ru"] as const)("reveals the last model from search ArrowUp in %s", (language) => {
  act(() => root.render(<Picker language={language} />))
  const list = geometry()
  key(search(), "ArrowUp")
  expectViewport(list, 200, 9)
})

it("reveals the first model from search ArrowDown after prior scrolling", () => {
  const list = geometry({ scroll: 200 })
  key(search(), "ArrowDown")
  expectViewport(list, 0, 0)
})

it.each([
  ["End", 0, 0, 200, 9],
  ["Home", 9, 200, 0, 0],
  ["ArrowDown", 2, 0, 20, 3],
  ["ArrowUp", 4, 100, 90, 3],
  ["ArrowDown", 9, 200, 0, 0],
  ["ArrowUp", 0, 0, 200, 9],
] as const)("reveals %s from row %i at scroll %i", (name, active, before, after, target) => {
  const list = geometry({ scroll: before })
  act(() => options()[active].focus({ preventScroll: true }))
  key(options()[active], name)
  expectViewport(list, after, target)
})

it("does not move the list when the next model is already fully visible", () => {
  const list = geometry({ height: 90 })
  act(() => options()[1].focus({ preventScroll: true }))
  key(options()[1], "ArrowDown")
  expectViewport(list, 0, 2)
})

it("aligns the beginning of an oversized model row", () => {
  const list = geometry({ rowHeight: 150 })
  key(list, "End")
  expectViewport(list, 1350, 9)
})

it("leaves Home and End inside the search editor", () => {
  const list = geometry({ scroll: 90 })
  key(search(), "Home")
  key(search(), "End")
  expect(list.scrollTop).toBe(90)
  expect(container.scrollTop).toBe(123)
  expect(document.activeElement).toBe(search())
  expect(changes).not.toHaveBeenCalled()
})

it.each([{ isComposing: true }, { keyCode: 229 }])(
  "does not move focus or scroll for an IME-marked arrow %j",
  (extra) => {
    const list = geometry()
    key(search(), "ArrowUp", extra)
    expect(document.activeElement).toBe(search())
    act(() => options()[0].focus({ preventScroll: true }))
    key(options()[0], "End", extra)
    expectViewport(list, 0, 0)
  },
)

it("leaves an empty catalog untouched", () => {
  act(() => root.render(<Picker models={[]} />))
  const list = geometry()
  key(search(), "ArrowUp")
  key(list, "End")
  expect(list.scrollTop).toBe(0)
  expect(container.scrollTop).toBe(123)
  expect(document.activeElement).toBe(search())
  expect(changes).not.toHaveBeenCalled()
})

it("does not scroll the keyboard target on hover or catalog refresh", () => {
  const list = geometry()
  key(search(), "ArrowUp")
  act(() => options()[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })))
  expectViewport(list, 200, 9)
  act(() => root.render(<Picker models={catalog.map((model) => ({ ...model }))} />))
  expectViewport(list, 200, 9)
})

it.each(["Enter", " "])("selects the revealed model with %s and returns focus", (name) => {
  const list = geometry()
  key(search(), "ArrowUp")
  expectViewport(list, 200, 9)
  key(options()[9], name)
  expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/model-9:high")
  expect(container.querySelector(".model-picker-panel")).toBeNull()
  expect(document.activeElement).toBe(container.querySelector(".model-picker-trigger"))
  expect(container.scrollTop).toBe(123)
})
