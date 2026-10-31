/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { ModelPassport } from "./ModelPassport"
import { ModelPicker } from "./ModelPicker"
import type { OmpModelInfo } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

it("replaces the whole displayed passport on refresh and keeps legacy fields unknown", () => {
  const container = document.createElement("div")
  const root = createRoot(container)
  const legacy: OmpModelInfo = {
    provider: "synthetic",
    id: "x",
    selector: "synthetic/x",
    name: "Synthetic",
    available: true,
    status: "ok",
    detail: null,
    thinking: [],
  }
  try {
    act(() =>
      root.render(
        <ModelPassport
          language="en"
          model={{
            ...legacy,
            contextWindow: 128000,
            maxTokens: 8192,
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            pricingStatus: "included",
          }}
        />,
      ),
    )
    expect(container.textContent).toContain("128000")
    expect(container.textContent).toContain("Included")
    expect(container.textContent).toContain("text, image")
    act(() => root.render(<ModelPassport language="en" model={legacy} />))
    expect(container.textContent).not.toContain("128000")
    expect(container.textContent).not.toContain("Included")
    expect(container.textContent).not.toContain("text, image")
    expect(container.textContent).toContain("Unknown")
    expect(container.querySelectorAll("button,input,select")).toHaveLength(0)
  } finally {
    act(() => root.unmount())
  }
})

it.each([
  ["fixed", "Fixed rate"],
  ["free", "Free"],
  ["included", "Included"],
  ["variable", "Variable rate"],
  ["unknown", "Unknown"],
  ["future-status", "Unknown"],
  [undefined, "Unknown"],
])(
  "shows runtime pricing status %s without inferring it from zero rates",
  (pricingStatus, expected) => {
    const container = document.createElement("div")
    const root = createRoot(container)
    const model: OmpModelInfo = {
      provider: "synthetic",
      id: "zero",
      selector: "synthetic/zero",
      name: "Zero",
      available: true,
      status: "ok",
      detail: null,
      thinking: [],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      pricingStatus,
    }
    try {
      act(() => root.render(<ModelPassport language="en" model={model} />))
      const label = Array.from(container.querySelectorAll("dt")).find(
        (node) => node.textContent === "Pricing status",
      )
      expect(label?.nextElementSibling?.textContent).toBe(expected)
      const rate = Array.from(container.querySelectorAll("dt")).find(
        (node) => node.textContent === "Input",
      )
      expect(rate?.nextElementSibling?.textContent).toBe("0")
      expect(container.querySelectorAll("button,input,select,textarea")).toHaveLength(0)
    } finally {
      act(() => root.unmount())
    }
  },
)

it("keeps the mounted picker passport read-only and replaces metadata on selection and catalog refresh", () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const onChange = vi.fn()
  const onOpenChange = vi.fn()
  const first: OmpModelInfo = {
    provider: "synthetic",
    id: "first",
    selector: "synthetic/first",
    name: "First",
    available: true,
    status: "ok",
    detail: null,
    thinking: [],
    contextWindow: 128000,
    input: ["text", "image"],
    pricingStatus: "included",
  }
  const second: OmpModelInfo = {
    provider: "synthetic",
    id: "second",
    selector: "synthetic/second",
    name: "Second",
    available: true,
    status: "ok",
    detail: null,
    thinking: [],
    contextWindow: 32000,
    input: ["text"],
    pricingStatus: "variable",
  }
  const render = (models: OmpModelInfo[], value: string) =>
    act(() =>
      root.render(
        <ModelPicker
          language="en"
          models={models}
          value={value}
          open={false}
          role="default"
          onChange={onChange}
          onOpenChange={onOpenChange}
        />,
      ),
    )
  const passport = () => container.querySelector<HTMLDetailsElement>(".model-passport")!
  try {
    render([first, second], first.selector)
    act(() => passport().querySelector("summary")!.click())
    expect(passport().open).toBe(true)
    expect(passport().textContent).toContain("128000")
    expect(passport().textContent).toContain("Included")
    expect(onChange).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()

    render([first, second], second.selector)
    expect(passport().textContent).toContain("32000")
    expect(passport().textContent).toContain("Variable rate")
    expect(passport().textContent).not.toContain("128000")
    expect(passport().textContent).not.toContain("Included")
    expect(passport().textContent).not.toContain("image")

    const refreshed = {
      ...second,
      contextWindow: undefined,
      input: undefined,
      pricingStatus: undefined,
    }
    render([first, refreshed], second.selector)
    expect(passport().textContent).not.toContain("32000")
    expect(passport().textContent).not.toContain("Variable rate")
    expect(passport().textContent).toContain("Unknown")
    expect(onChange).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
