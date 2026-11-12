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

const catalog: OmpModelInfo[] = [
  {
    provider: "synthetic",
    id: "a",
    selector: "synthetic/a",
    name: "A",
    available: true,
    status: "ready",
    detail: null,
    thinking: ["high"],
    contextWindow: 32000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"],
    pricingStatus: "included",
  },
  {
    provider: "synthetic",
    id: "b",
    selector: "synthetic/b",
    name: "B",
    available: true,
    status: "ready",
    detail: null,
    thinking: ["high"],
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0 },
  },
]
const initial = "synthetic/a:high"
const changes = vi.fn()
let container: HTMLDivElement
let root: Root

function Picker({
  models = catalog,
  value = initial,
  language = "en",
}: {
  models?: OmpModelInfo[]
  value?: string
  language?: Lang
}) {
  const [open, setOpen] = useState(true)
  return (
    <ModelPicker
      models={models}
      value={value}
      language={language}
      role="default"
      open={open}
      onOpenChange={setOpen}
      onChange={changes}
    />
  )
}

const comparison = () => container.querySelector<HTMLDetailsElement>(".model-comparison")!
const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
const search = () => container.querySelector<HTMLInputElement>(".model-picker-search input")!
const values = (label: string) =>
  [...comparison().querySelectorAll("tbody tr")]
    .find((row) => row.querySelector("th")?.textContent === label)!
    .querySelectorAll("td")
const row = (label: string) => [...values(label)].map((cell) => cell.textContent)
const key = (target: HTMLElement, value: string) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    )
  })
const hover = (target: HTMLElement) =>
  act(() => target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })))
const query = (value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value)
    search().dispatchEvent(new Event("input", { bubbles: true }))
  })

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

it("compares a candidate with the selected model without changing the role draft", () => {
  expect(comparison().open).toBe(false)
  act(() => comparison().querySelector("summary")!.click())
  expect(comparison().open).toBe(true)
  expect(comparison().closest('[role="listbox"]')).toBeNull()
  hover(options()[1])
  expect(row("Catalog entry")).toEqual(["synthetic/a", "synthetic/b"])
  expect(row("Context, tokens")).toEqual(["32000", "128000"])
  expect(row("Pricing status")).toEqual(["Included", "Unknown"])
  expect(row("Input")).toEqual(["Unknown", "0"])
  expect(row("Declared input")).toEqual(["text", "text, image"])
  expect(container.querySelector(".model-picker-copy small")?.textContent).toBe(initial)
  expect(comparison().querySelectorAll("button,input,select")).toHaveLength(0)
  expect(changes).not.toHaveBeenCalled()
})

it("previews the keyboard target, ignores competing hover, and still chooses only on Enter", () => {
  key(search(), "ArrowDown")
  key(options()[0], "ArrowDown")
  hover(options()[0])
  expect(row("Catalog entry")).toEqual(["synthetic/a", "synthetic/b"])
  expect(changes).not.toHaveBeenCalled()
  key(options()[1], "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/b:high")
  expect(comparison()).toBeNull()
})

it("keeps selected metadata when filtering hides it and clears the preview on no matches", () => {
  query("b")
  expect(row("Catalog entry")).toEqual(["synthetic/a", "synthetic/b"])
  query("missing")
  expect(row("Catalog entry")).toEqual(["synthetic/a", "Unknown"])
  expect(row("Context, tokens")).toEqual(["32000", "Unknown"])
  key(search(), "Enter")
  expect(changes).not.toHaveBeenCalled()
})

it("uses fresh metadata and retained candidate identity after catalog reorder", () => {
  hover(options()[1])
  act(() =>
    root.render(
      <Picker
        models={catalog.map((model) =>
          model.id === "b"
            ? { ...model, name: "0 B", contextWindow: 256000, pricingStatus: "variable" }
            : { ...model },
        )}
      />,
    ),
  )
  expect(row("Catalog entry")).toEqual(["synthetic/a", "synthetic/b"])
  expect(row("Context, tokens")).toEqual(["32000", "256000"])
  expect(row("Pricing status")).toEqual(["Included", "Variable rate"])
  expect(comparison().textContent).not.toContain("128000")
  expect(changes).not.toHaveBeenCalled()
})

it("does not retain removed metadata after catalog removal or legacy replacement", () => {
  hover(options()[1])
  act(() => root.render(<Picker models={[catalog[0]]} />))
  expect(row("Catalog entry")).toEqual(["synthetic/a", "synthetic/a"])
  act(() => root.render(<Picker models={[]} />))
  expect(row("Catalog entry")).toEqual(["Unknown", "Unknown"])
  expect(row("Context, tokens")).toEqual(["Unknown", "Unknown"])
  expect(changes).not.toHaveBeenCalled()
})

it("keeps an ambiguous selected alias unknown while showing an exact candidate", () => {
  const duplicate = {
    ...catalog[0],
    provider: "other",
    selector: "other/a",
    contextWindow: 9000,
  }
  act(() => root.render(<Picker models={[...catalog, duplicate]} value="a" />))
  const candidate = options().find((option) => option.textContent?.includes("synthetic/b"))!
  hover(candidate)
  expect(row("Catalog entry")).toEqual(["Unknown", "synthetic/b"])
  expect(row("Context, tokens")).toEqual(["Unknown", "128000"])
  expect(changes).not.toHaveBeenCalled()
})

it("preserves literal thinking-like IDs and does not guess pricing statuses", () => {
  const literal = {
    ...catalog[0],
    id: "a:high",
    selector: "synthetic/a:high",
    contextWindow: 777,
    pricingStatus: "future-status",
  }
  act(() => root.render(<Picker models={[...catalog, literal]} />))
  expect(row("Catalog entry")).toEqual(["synthetic/a:high", "synthetic/a"])
  expect(row("Context, tokens")).toEqual(["777", "32000"])
  const candidate = options().find(
    (option) => option.querySelector("small")?.textContent === "synthetic/a:high",
  )!
  hover(candidate)
  expect(row("Catalog entry")).toEqual(["synthetic/a:high", "synthetic/a:high"])
  expect(row("Context, tokens")).toEqual(["777", "777"])
  expect(row("Pricing status")).toEqual(["Unknown", "Unknown"])
  expect(changes).not.toHaveBeenCalled()
})

it.each(["Escape", "Done"])("discards the expanded comparison after %s and reopen", (method) => {
  act(() => comparison().querySelector("summary")!.click())
  hover(options()[1])
  if (method === "Escape") {
    act(() => comparison().querySelector("summary")!.focus())
    key(comparison().querySelector("summary")!, "Escape")
  } else {
    act(() => container.querySelector<HTMLButtonElement>(".model-picker-manual button")!.click())
  }
  expect(comparison()).toBeNull()
  act(() => container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click())
  expect(comparison().open).toBe(false)
  expect(row("Catalog entry")).toEqual(["synthetic/a", "synthetic/a"])
  expect(changes).not.toHaveBeenCalled()
})



it("keeps comparison disclosure and outside blur independent of selection", () => {
  key(search(), "ArrowDown")
  key(options()[0], "ArrowDown")
  const summary = comparison().querySelector("summary")!
  act(() => summary.focus())
  expect(row("Catalog entry")).toEqual(["synthetic/a", "synthetic/b"])
  for (const value of ["Enter", " "]) {
    const event = new KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
    })
    act(() => summary.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  }
  act(() => summary.click())
  expect(comparison().open).toBe(true)
  expect(row("Catalog entry")).toEqual(["synthetic/a", "synthetic/b"])
  const outside = document.createElement("button")
  container.append(outside)
  act(() => outside.focus())
  expect(comparison()).toBeNull()
  expect(changes).not.toHaveBeenCalled()
})
