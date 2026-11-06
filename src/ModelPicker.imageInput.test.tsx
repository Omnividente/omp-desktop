/** @vitest-environment jsdom */

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ModelPicker } from "./ModelPicker"
import type { Lang } from "./i18n"
import type { OmpModelInfo } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function model(id: string, input?: string[] | null, available = true): OmpModelInfo {
  return {
    id,
    provider: "synthetic",
    selector: `synthetic/${id}`,
    name: id,
    available,
    status: available ? "ready" : "auth-error",
    detail: null,
    thinking: ["high"],
    input,
  }
}

const catalog = [
  model("alpha-vision", ["text", "image"]),
  model("beta-vision", ["image"]),
  model("gamma-locked", ["text", "image"], false),
  model("image-in-name-only", ["text"]),
  model("unknown"),
  model("null", null),
  model("empty", []),
  model("other-metadata", ["audio", "IMAGE"]),
]
const initial = "synthetic/image-in-name-only:high"
const changes = vi.fn()
let root: Root
let container: HTMLDivElement

function Picker({
  models = catalog,
  language = "en",
}: {
  models?: OmpModelInfo[]
  language?: Lang
}) {
  const [value, setValue] = useState(initial)
  const [open, setOpen] = useState(true)
  return (
    <ModelPicker
      language={language}
      models={models}
      value={value}
      open={open}
      onChange={(selector) => {
        changes(selector)
        setValue(selector)
      }}
      onOpenChange={setOpen}
      role="default"
      selectorSuggestions={["runtime-alias"]}
    />
  )
}

const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
const selectors = () => options().map((option) => option.querySelector("small")!.textContent)
const filter = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
const search = () => container.querySelector<HTMLInputElement>(".model-picker-search input")!
const selection = () => container.querySelector(".model-picker-copy small")?.textContent

function toggle() {
  expect(filter()).not.toBeNull()
  act(() => filter().click())
}

function query(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value)
    search().dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function key(target: HTMLElement, value: string) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    )
  })
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
})

describe("declared image-input filter", () => {
  it("starts unfiltered and only includes explicit image metadata, preserving unavailable entries", () => {
    expect(options()).toHaveLength(catalog.length)
    toggle()
    expect(selectors()).toEqual([
      "synthetic/alpha-vision",
      "synthetic/beta-vision",
      "synthetic/gamma-locked",
    ])
    expect(selection()).toBe(initial)
    expect(changes).not.toHaveBeenCalled()
    toggle()
    expect(options()).toHaveLength(catalog.length)
  })

  it("intersects the existing query without changing its text or selected selector", () => {
    query("  BETA  ")
    toggle()
    expect(search().value).toBe("  BETA  ")
    expect(selectors()).toEqual(["synthetic/beta-vision"])
    query("image-in-name-only")
    expect(options()).toHaveLength(0)
    expect(container.querySelector(".model-picker-empty")?.textContent).toBeTruthy()
    key(search(), "Enter")
    expect(changes).not.toHaveBeenCalled()
    expect(selection()).toBe(initial)
    toggle()
    expect(selectors()).toEqual(["synthetic/image-in-name-only"])
  })

  it("selects the exact filtered model with the existing thinking suffix through keyboard navigation", () => {
    toggle()
    key(search(), "ArrowDown")
    key(options()[0], "ArrowDown")
    expect(document.activeElement).toBe(options()[1])
    key(options()[1], "Enter")
    expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/beta-vision:high")
    expect(container.querySelector(".model-picker-panel")).toBeNull()
  })

  it("keeps the active filtered identity on a fresh catalog array and reordering", () => {
    toggle()
    key(search(), "ArrowDown")
    key(options()[0], "ArrowDown")
    const active = options()[1]
    act(() =>
      root.render(
        <Picker
          models={catalog.map((entry) => ({
            ...entry,
            name: entry.id === "beta-vision" ? "AAA" : entry.name,
          }))}
        />,
      ),
    )
    expect(document.activeElement).toBe(active)
    key(active, "Enter")
    expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/beta-vision:high")
  })

  it("reconciles changed catalog metadata without changing the stored selection", () => {
    toggle()
    const refreshed = catalog.map((entry) => ({
      ...entry,
      input: entry.id === "unknown" ? ["image"] : undefined,
    }))
    act(() => root.render(<Picker models={refreshed} />))
    expect(filter().checked).toBe(true)
    expect(selectors()).toEqual(["synthetic/unknown"])
    expect(selection()).toBe(initial)
    expect(changes).not.toHaveBeenCalled()
    key(search(), "Enter")
    expect(changes).toHaveBeenCalledExactlyOnceWith("synthetic/unknown:high")
  })

  it("resets the filter and query on Escape and restores trigger focus", () => {
    toggle()
    query("alpha")
    act(() => filter().focus())
    key(filter(), "Escape")
    const trigger = container.querySelector<HTMLButtonElement>(".model-picker-trigger")!
    expect(document.activeElement).toBe(trigger)
    expect(changes).not.toHaveBeenCalled()
    act(() => trigger.click())
    expect(filter().checked).toBe(false)
    expect(search().value).toBe("")
    expect(options()).toHaveLength(catalog.length)
  })

  it("leaves manual selectors and runtime shortcuts accessible when the catalog filter is empty", () => {
    toggle()
    query("not-present")
    expect(options()).toHaveLength(0)
    expect(container.querySelector<HTMLInputElement>('[id$="-manual"]')?.value).toBe(initial)
    const shortcuts = container.querySelector<HTMLSelectElement>(".model-picker-shortcuts select")!
    act(() => {
      shortcuts.value = "runtime-alias"
      shortcuts.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(changes).toHaveBeenCalledExactlyOnceWith("runtime-alias")
  })

  it.each(["en", "ru"] as const)(
    "has a native checkbox with an explicit catalog label in %s",
    (language) => {
      act(() => root.render(<Picker language={language} />))
      expect(filter()).not.toBeNull()
      expect(filter().labels?.[0].textContent).toBe(
        language === "en"
          ? "Image input declared in catalog"
          : "Ввод изображений заявлен в каталоге",
      )
      expect(filter().checked).toBe(false)
      toggle()
      const descriptionId = filter().getAttribute("aria-describedby")!
      expect(document.getElementById(descriptionId)?.textContent).toBe(
        language === "en"
          ? "Catalog metadata only; image delivery is not verified."
          : "Это сведения каталога, а не проверка передачи изображений.",
      )
    },
  )
})
