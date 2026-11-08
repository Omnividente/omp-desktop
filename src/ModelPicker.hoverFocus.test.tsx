/** @vitest-environment jsdom */
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ModelPicker } from "./ModelPicker"
import type { OmpModelInfo } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const catalog: OmpModelInfo[] = ["one", "two", "three"].map((id, index) => ({
  provider: "synthetic",
  id,
  selector: `synthetic/${id}`,
  name: `Model ${index}`,
  available: true,
  status: "ready",
  detail: null,
  thinking: ["high"],
}))
const changes = vi.fn()
let container: HTMLDivElement
let root: Root

function Picker({ models = catalog }: { models?: OmpModelInfo[] }) {
  const [open, setOpen] = useState(true)
  return (
    <ModelPicker
      language="en"
      models={models}
      value="synthetic/one:high"
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
const key = (target: HTMLElement, value: string, isComposing = false) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
        isComposing,
      }),
    )
  })
const hover = (target: HTMLElement) =>
  act(() => {
    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }))
  })
const activeOption = () => document.getElementById(listbox().getAttribute("aria-activedescendant")!)

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
})

it.each(["Enter", " "])("hover does not replace the focused model for %s", (keyName) => {
  key(search(), "ArrowDown")
  const focused = options()[0]
  hover(options()[1])
  expect(document.activeElement).toBe(focused)
  expect(activeOption()).toBe(focused)
  expect(changes).not.toHaveBeenCalled()
  key(focused, keyName)
  expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/one:high")
  expect(document.activeElement).toBe(container.querySelector(".model-picker-trigger"))
})

it.each([
  ["ArrowDown", 1],
  ["ArrowUp", 2],
  ["Home", 0],
  ["End", 2],
] as const)("%s navigates from the keyboard target after hover", (keyName, expectedIndex) => {
  key(search(), "ArrowDown")
  const focused = options()[0]
  hover(options()[1])
  key(focused, keyName)
  expect(document.activeElement).toBe(options()[expectedIndex])
  expect(activeOption()).toBe(options()[expectedIndex])
  expect(changes).not.toHaveBeenCalled()
})

it("retains focused identity through hover, catalog replacement and reorder", () => {
  key(search(), "ArrowDown")
  const focused = options()[0]
  hover(options()[1])
  act(() =>
    root.render(
      <Picker
        models={catalog.map((model) => ({
          ...model,
          name: model.id === "one" ? "Z" : model.name,
        }))}
      />,
    ),
  )
  expect(document.activeElement).toBe(focused)
  hover(options()[0])
  expect(activeOption()).toBe(focused)
  key(focused, "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/one:high")
})

it("preserves hover selection while the search input owns focus", () => {
  expect(document.activeElement).toBe(search())
  hover(options()[1])
  expect(document.activeElement).toBe(search())
  expect(activeOption()).toBe(options()[1])
  key(search(), "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/two:high")
})

it("allows hover again after focus returns from an option to search", () => {
  key(search(), "ArrowDown")
  hover(options()[1])
  act(() => search().focus())
  hover(options()[2])
  expect(document.activeElement).toBe(search())
  expect(activeOption()).toBe(options()[2])
  key(search(), "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/three:high")
})

it("also ignores hover entering a different option's child text", () => {
  key(search(), "ArrowDown")
  hover(options()[1].querySelector<HTMLElement>("strong")!)
  expect(document.activeElement).toBe(options()[0])
  expect(activeOption()).toBe(options()[0])
  key(options()[0], "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/one:high")
})

it("keeps the active descendant while the listbox itself owns focus", () => {
  act(() => listbox().focus())
  const active = activeOption()
  hover(options()[1])
  expect(document.activeElement).toBe(listbox())
  expect(activeOption()).toBe(active)
  key(listbox(), "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/one:high")
})

it("still permits a pointer click on another model while an option owns focus", () => {
  key(search(), "ArrowDown")
  hover(options()[1])
  act(() => options()[1].click())
  expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/two:high")
})

it("does not commit a model during composition after hover", () => {
  key(search(), "ArrowDown")
  hover(options()[1])
  key(options()[0], "Enter", true)
  expect(changes).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(options()[0])
  key(options()[0], "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/one:high")
})
