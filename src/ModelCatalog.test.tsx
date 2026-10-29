/** @vitest-environment jsdom */
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ModelPicker } from "./ModelPicker"
import type { OmpModelInfo } from "./types"
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
const catalog: OmpModelInfo[] = Array.from({ length: 600 }, (_, i) => {
  const provider = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"][i % 6]
  const id = `model-${String(Math.floor(i / 6)).padStart(3, "0")}:8b`
  return {
    provider,
    id,
    selector: `${provider}/${id}`,
    name: `Shared Model ${String(Math.floor(i / 6)).padStart(3, "0")}`,
    available: i % 13 !== 0,
    status: i % 13 === 0 ? "auth-error" : "ready",
    detail: null,
    thinking: ["low", "high"],
  }
})
let root: Root, container: HTMLDivElement
const changes = vi.fn()
const initial = "gamma/model-050:8b:high"
function Picker({ models = catalog }: { models?: OmpModelInfo[] }) {
  const [value, setValue] = useState(initial)
  const [open, setOpen] = useState(true)
  return (
    <ModelPicker
      language="en"
      models={models}
      value={value}
      open={open}
      onChange={(v) => {
        changes(v)
        setValue(v)
      }}
      onOpenChange={setOpen}
      role="default"
    />
  )
}
const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
const search = () => container.querySelector<HTMLInputElement>(".model-picker-search input")!
const key = (target: HTMLElement, k: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }))
  })
function query(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value)
    search().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const value = () => container.querySelector(".model-picker-copy small")?.textContent
beforeEach(() => {
  changes.mockClear()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Picker />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
it("600 catalog entries: case-insensitive provider, name, id and selector search; empty query restores all", () => {
  expect(options()).toHaveLength(600)
  query("  BETA  ")
  expect(options()).toHaveLength(100)
  expect(options().every((o) => o.querySelector("small")!.textContent!.startsWith("beta/"))).toBe(
    true,
  )
  query("Shared Model 050")
  expect(options()).toHaveLength(6)
  query("model-050:8b")
  expect(options()).toHaveLength(6)
  query("BETA/MODEL-050:8b")
  expect(options()).toHaveLength(1)
  query("")
  expect(options()).toHaveLength(600)
  expect(value()).toBe(initial)
  expect(changes).not.toHaveBeenCalled()
})
it("no results is reversible and cannot alter existing selection through Enter", () => {
  query("not-a-real-model")
  expect(options()).toHaveLength(0)
  expect(container.querySelector(".model-picker-empty")?.textContent).toBeTruthy()
  key(search(), "Enter")
  expect(changes).not.toHaveBeenCalled()
  expect(value()).toBe(initial)
  query("gamma/model-050")
  expect(options()).toHaveLength(1)
  expect(options()[0].getAttribute("aria-selected")).toBe("true")
  key(search(), "Escape")
  expect(value()).toBe(initial)
  expect(document.activeElement).toBe(container.querySelector(".model-picker-trigger"))
  act(() => container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click())
  expect(search().value).toBe("")
  expect(options()).toHaveLength(600)
})
it("keyboard reaches both ends, wraps and selects exact provider identity with thinking preserved", () => {
  query("beta")
  key(search(), "ArrowDown")
  expect(document.activeElement).toBe(options()[0])
  key(options()[0], "End")
  expect(document.activeElement).toBe(options().at(-1))
  key(options().at(-1)!, "ArrowDown")
  expect(document.activeElement).toBe(options()[0])
  key(options()[0], "ArrowUp")
  expect(document.activeElement).toBe(options().at(-1))
  const selector = options().at(-1)!.querySelector("small")!.textContent
  key(options().at(-1)!, "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith(`${selector}:high`)
  expect(value()).toBe(`${selector}:high`)
})
it("catalog replacement while typing retains query and selected selector without invoking change", () => {
  query("beta")
  act(() => root.render(<Picker models={catalog.map((m) => ({ ...m }))} />))
  expect(search().value).toBe("beta")
  expect(options()).toHaveLength(100)
  expect(value()).toBe(initial)
  expect(changes).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(search())
})
it("current substring semantics do not claim independent provider and model token filtering", () => {
  query("beta model-050")
  expect(options()).toHaveLength(1)
  query("beta 050")
  expect(options()).toHaveLength(0)
  query("beta/model-050")
  expect(options()).toHaveLength(1)
  expect(value()).toBe(initial)
})
it("catalog replacement while navigating: Enter should choose the still-focused option", () => {
  key(search(), "ArrowDown")
  const focused = document.activeElement as HTMLButtonElement
  const wanted = focused.querySelector("small")!.textContent
  expect(wanted).not.toBe("gamma/model-050:8b")
  act(() => root.render(<Picker models={catalog.map((m) => ({ ...m }))} />))
  expect(document.activeElement).toBe(focused)
  key(focused, "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith(`${wanted}:high`)
})
const tiny: OmpModelInfo[] = ["one", "two", "three"].map((id, i) => ({
  provider: "p",
  id,
  selector: `p/${id}`,
  name: i < 2 ? `Match ${i}` : "Other",
  available: true,
  status: "ready",
  detail: null,
  thinking: ["high"],
}))
function renderRaw(models = tiny, selected = "p/three:high") {
  act(() =>
    root.render(
      <ModelPicker
        language="en"
        models={models}
        value={selected}
        open={true}
        onChange={changes}
        onOpenChange={() => {}}
        role="default"
      />,
    ),
  )
}
it.each(["Enter", " "])(
  "filtered active second option survives catalog array replacement for %s",
  (keyName) => {
    renderRaw()
    query("match")
    key(search(), "ArrowDown")
    key(options()[0], "ArrowDown")
    const focused = document.activeElement as HTMLButtonElement
    expect(focused.querySelector("small")?.textContent).toBe("p/two")
    renderRaw(tiny.map((m) => ({ ...m })))
    expect(document.activeElement).toBe(focused)
    key(focused, keyName)
    expect(changes).toHaveBeenCalledExactlyOnceWith("p/two:high")
  },
)
it("reordering catalog retains exact active identity rather than the old numeric index", () => {
  renderRaw()
  query("match")
  key(search(), "ArrowDown")
  const focused = document.activeElement as HTMLButtonElement
  expect(focused.querySelector("small")?.textContent).toBe("p/one")
  renderRaw(tiny.map((m) => (m.id === "one" ? { ...m, name: "Match 9" } : { ...m })))
  expect(document.activeElement).toBe(focused)
  key(focused, "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("p/one:high")
})
it("removing active entry uses existing selected-or-first fallback without selecting spontaneously", () => {
  renderRaw()
  query("match")
  key(search(), "ArrowDown")
  key(options()[0], "ArrowDown")
  renderRaw(tiny.filter((m) => m.id !== "two"))
  expect(changes).not.toHaveBeenCalled()
  key(container.querySelector<HTMLElement>('[role="listbox"]')!, "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("p/one:high")
})
it("explicit query change resets to the new result instead of retaining an old active identity", () => {
  renderRaw()
  key(search(), "ArrowDown")
  query("p/two")
  key(search(), "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("p/two:high")
})
it("external selection change resets active selection as before", () => {
  renderRaw()
  key(search(), "ArrowDown")
  renderRaw(
    tiny.map((m) => ({ ...m })),
    "p/two:high",
  )
  key(container.querySelector<HTMLElement>('[role="listbox"]')!, "Enter")
  expect(changes).toHaveBeenCalledExactlyOnceWith("p/two:high")
})
