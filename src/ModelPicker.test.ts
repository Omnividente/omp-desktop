/** @vitest-environment jsdom */

import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  matchesSelector,
  ModelPicker,
  normalizeThinkingLevel,
  selectorWithThinking,
  splitSelector,
  thinkingLevelsForModel,
  thinkingOptionsForModel,
} from "./ModelPicker"
import type { OmpModelInfo } from "./types"

const model: OmpModelInfo = {
  provider: "anthropic",
  id: "claude-sonnet-4-20250514",
  selector: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  available: true,
  status: "ready",
  detail: null,
  thinking: ["low", "high"],
}

const taggedModel: OmpModelInfo = {
  ...model,
  provider: "ollama",
  id: "llama3.1:8b",
  selector: "ollama/llama3.1:8b",
  name: "Llama 3.1 8B",
}

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe("splitSelector", () => {
  it.each([
    ["claude-sonnet-4:off", "off"],
    ["claude-sonnet-4:HIGH", "high"],
    ["anthropic/claude-sonnet-4-20250514:xhigh", "xhigh"],
    ["claude-sonnet-4:auto", "auto"],
    ["ollama/llama3.1:8b:high", "high"],
  ])("splits the supported thinking suffix from %s", (selector, thinking) => {
    expect(splitSelector(selector)).toEqual({
      base: selector.slice(0, selector.lastIndexOf(":")),
      thinking,
    })
  })

  it("keeps an unsupported suffix as part of the selector", () => {
    expect(splitSelector("claude-sonnet-4:turbo")).toEqual({
      base: "claude-sonnet-4:turbo",
      thinking: null,
    })
    expect(splitSelector("ollama/llama3.1:8b")).toEqual({
      base: "ollama/llama3.1:8b",
      thinking: null,
    })
    expect(splitSelector("ollama/llama3.1:8b:internal")).toEqual({
      base: "ollama/llama3.1:8b:internal",
      thinking: null,
    })
  })
})

describe("matchesSelector", () => {
  it.each([
    "claude-sonnet-4",
    "CLAUDE-SONNET-4:HIGH",
    "claude-sonnet-4-20250514",
    "anthropic/claude-sonnet-4-20250514:low",
  ])("matches the model's canonical selector or id form: %s", (selector) => {
    expect(matchesSelector(model, selector)).toBe(true)
  })

  it("rejects another model selector", () => {
    expect(matchesSelector(model, "anthropic/claude-opus-4")).toBe(false)
  })

  it("matches an Ollama tag with or without a final thinking suffix", () => {
    expect(matchesSelector(taggedModel, "ollama/llama3.1:8b")).toBe(true)
    expect(matchesSelector(taggedModel, "ollama/llama3.1:8b:high")).toBe(true)
  })
})

describe("thinking selector controls", () => {
  it("offers only the levels reported for the selected model", () => {
    expect(thinkingLevelsForModel({ ...model, thinking: ["low", "high", "low"] })).toEqual([
      "low",
      "high",
    ])
  })

  it("replaces or removes a configured thinking suffix", () => {
    expect(selectorWithThinking("anthropic/claude-sonnet-4:low", "high")).toBe(
      "anthropic/claude-sonnet-4:high",
    )
    expect(selectorWithThinking("ollama/qwen3:30b", null)).toBe("ollama/qwen3:30b")
    expect(selectorWithThinking("ollama/llama3.1:8b", "high")).toBe("ollama/llama3.1:8b:high")
  })

  it("maps the current reasoning level to the closest level supported by a new model", () => {
    expect(normalizeThinkingLevel("high", ["off", "auto", "medium"])).toBe("medium")
    expect(normalizeThinkingLevel("xhigh", ["off", "auto", "low", "high"])).toBe("high")
    expect(normalizeThinkingLevel("medium", ["off", "auto", "low", "high"])).toBe("low")
  })

  it("preserves exact levels and uses the configured fallback when no preference is usable", () => {
    expect(normalizeThinkingLevel("auto", ["off", "auto", "medium"])).toBe("auto")
    expect(normalizeThinkingLevel("unknown", ["off", "auto", "medium"], "medium")).toBe("medium")
    expect(normalizeThinkingLevel("high", [])).toBeNull()
  })

  it("builds the runtime thinking cycle from model capabilities", () => {
    expect(thinkingOptionsForModel({ ...model, thinking: ["medium", "high"] })).toEqual([
      "off",
      "auto",
      "medium",
      "high",
    ])
  })
})

describe("ModelPicker model changes", () => {
  let container: HTMLDivElement
  let root: Root

  function Picker({
    initial,
    target,
    initiallyOpen = true,
  }: {
    initial: string
    target: OmpModelInfo
    initiallyOpen?: boolean
  }) {
    const [value, setValue] = useState(initial)
    const [open, setOpen] = useState(initiallyOpen)
    return createElement(ModelPicker, {
      language: "en",
      models: [model, target],
      onChange: setValue,
      onOpenChange: setOpen,
      open,
      role: "default",
      value,
    })
  }

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  function chooseTarget() {
    const option = [...container.querySelectorAll<HTMLButtonElement>("[role='option']")].find(
      (button) => button.querySelector("small")?.textContent === taggedModel.selector,
    )!
    act(() => option.click())
  }

  it.each(["off", "auto"])(
    "preserves explicit %s on a thinking-capable model without changing its colon tag",
    (thinking) => {
      act(() => {
        root.render(
          createElement(Picker, { initial: `${model.selector}:${thinking}`, target: taggedModel }),
        )
      })
      expect(container.querySelector("select")?.value).toBe(thinking)

      chooseTarget()

      expect(container.querySelector(".model-picker-copy small")?.textContent).toBe(
        `${taggedModel.selector}:${thinking}`,
      )
      expect(container.querySelector("select")?.value).toBe(thinking)
      expect(container.querySelector("[role='listbox']")).toBeNull()
    },
  )

  it("drops the override when the target has no thinking capabilities", () => {
    act(() => {
      root.render(
        createElement(Picker, {
          initial: `${model.selector}:off`,
          target: { ...taggedModel, thinking: [] },
        }),
      )
    })

    chooseTarget()

    expect(container.querySelector(".model-picker-copy small")?.textContent).toBe(
      taggedModel.selector,
    )
    expect(container.querySelector("select")).toBeNull()
  })

  it("uses the default rather than inventing an unsupported level on keyboard selection", () => {
    act(() => {
      root.render(
        createElement(Picker, {
          initial: `${model.selector}:high`,
          target: { ...taggedModel, thinking: ["low"] },
        }),
      )
    })
    const listbox = container.querySelector<HTMLElement>("[role='listbox']")!
    act(() => listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })))
    const option = container.querySelector<HTMLButtonElement>(`[role='option'][id$='-1']`)!
    expect(document.activeElement).toBe(option)
    act(() => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))

    expect(container.querySelector(".model-picker-copy small")?.textContent).toBe(
      taggedModel.selector,
    )
    expect(container.querySelector("select")?.value).toBe("")
    expect(document.activeElement).toBe(container.querySelector(".model-picker-trigger"))
  })

  it("opens ready to type, preserves text keys, and selects a filtered model from the keyboard", () => {
    act(() => {
      root.render(
        createElement(Picker, {
          initial: `${model.selector}:off`,
          target: taggedModel,
          initiallyOpen: false,
        }),
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>(".model-picker-trigger")!
    act(() => {
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    })
    const search = container.querySelector<HTMLInputElement>(".model-picker-search input")!
    expect(document.activeElement).toBe(search)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "llama",
      )
      search.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(container.querySelectorAll("[role='option']")).toHaveLength(1)
    for (const key of ["Home", "End", " ", "Enter"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
      act(() => search.dispatchEvent(event))
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(search)
    }
    act(() =>
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    )
    const option = container.querySelector<HTMLButtonElement>("[role='option']")!
    expect(document.activeElement).toBe(option)
    act(() => option.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })))
    expect(container.querySelector(".model-picker-copy small")?.textContent).toBe(
      `${taggedModel.selector}:off`,
    )
    expect(container.querySelector(".model-picker-panel")).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it.each(["Escape", "Done", "model click"])("returns focus on explicit close via %s", (action) => {
    const parentKeyDown = vi.fn()
    act(() => {
      root.render(
        createElement(
          "div",
          { onKeyDown: parentKeyDown },
          createElement(Picker, { initial: model.selector, target: taggedModel }),
        ),
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>(".model-picker-trigger")!
    const control =
      action === "Escape"
        ? container.querySelector<HTMLInputElement>(".model-picker-manual input")!
        : action === "Done"
          ? container.querySelector<HTMLButtonElement>(".model-picker-manual button")!
          : container.querySelector<HTMLButtonElement>("[role='option']")!
    act(() => {
      control.focus()
      if (action === "Escape") {
        control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      } else {
        control.click()
      }
    })
    expect(container.querySelector(".model-picker-panel")).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(parentKeyDown).not.toHaveBeenCalled()
  })

  it("does not reclaim focus after an intentional move within or outside the picker", () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    )
    act(() => {
      root.render(
        createElement(
          "div",
          null,
          createElement(Picker, { initial: model.selector, target: taggedModel }),
          createElement("button", { className: "outside" }, "Outside"),
        ),
      )
    })
    const manual = container.querySelector<HTMLInputElement>(".model-picker-manual input")!
    act(() => {
      manual.focus()
      frames.splice(0).forEach((callback) => callback(0))
    })
    expect(document.activeElement).toBe(manual)
    const search = container.querySelector<HTMLInputElement>(".model-picker-search input")!
    act(() => {
      search.focus()
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
    })
    expect(document.activeElement?.querySelector("small")?.textContent).toBe(taggedModel.selector)
    act(() => {
      manual.focus()
      frames.splice(0).forEach((callback) => callback(0))
    })
    expect(document.activeElement).toBe(manual)
    const outside = container.querySelector<HTMLButtonElement>(".outside")!
    act(() => outside.focus())
    expect(container.querySelector(".model-picker-panel")).toBeNull()
    expect(document.activeElement).toBe(outside)
  })
})
