/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { ModelPicker } from "./ModelPicker"
import { catalogModelForSelector } from "./modelPassportMetadata"
import type { OmpModelInfo } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function model(provider: string, id: string, contextWindow: number): OmpModelInfo {
  return {
    provider,
    id,
    selector: `${provider}/${id}`,
    name: `${provider} ${id}`,
    available: true,
    status: "ok",
    detail: null,
    thinking: ["high"],
    contextWindow,
  }
}

function mount(models: OmpModelInfo[], value: string, open = false) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const onChange = vi.fn()
  const onOpenChange = vi.fn()
  const render = (next: OmpModelInfo[], selected = value) =>
    act(() =>
      root.render(
        <ModelPicker
          language="en"
          models={next}
          value={selected}
          role="default"
          open={open}
          onChange={onChange}
          onOpenChange={onOpenChange}
        />,
      ),
    )
  render(models)
  return {
    container,
    onChange,
    onOpenChange,
    render,
    dispose: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function context(container: HTMLElement) {
  return Array.from(container.querySelectorAll(".model-passport dt")).find(
    (node) => node.textContent === "Context, tokens",
  )?.nextElementSibling?.textContent
}

it("prioritizes a qualified selector over an earlier raw ID collision", () => {
  const rawIdCollision = {
    ...model("alpha", "beta/shared", 11111),
    status: "missing",
    thinking: ["low"],
  }
  const exact = { ...model("beta", "shared", 22222), thinking: [] }
  const mounted = mount([rawIdCollision, exact], "beta/shared", true)
  try {
    expect(context(mounted.container)).toBe("22222")
    expect(mounted.container.querySelector(".model-picker-trigger strong")?.textContent).toBe(
      exact.name,
    )
    expect(
      mounted.container.querySelector(".model-picker-status")?.classList.contains("is-ok"),
    ).toBe(true)
    expect(mounted.container.querySelector(".model-picker-thinking")).toBeNull()
    expect(
      [...mounted.container.querySelectorAll('[role="option"][aria-selected="true"]')].map(
        (node) => node.querySelector("small")?.textContent,
      ),
    ).toEqual([exact.selector])
    expect(mounted.onChange).not.toHaveBeenCalled()
    expect(mounted.onOpenChange).not.toHaveBeenCalled()
  } finally {
    mounted.dispose()
  }
})

it("keeps the qualified passport identity stable after catalog reorder", () => {
  const rawIdCollision = model("alpha", "beta/shared", 11111)
  const exact = model("beta", "shared", 22222)
  const mounted = mount([exact, rawIdCollision], "beta/shared")
  try {
    expect(context(mounted.container)).toBe("22222")
    mounted.render([rawIdCollision, exact])
    expect(context(mounted.container)).toBe("22222")
    expect(mounted.onChange).not.toHaveBeenCalled()
    expect(mounted.onOpenChange).not.toHaveBeenCalled()
  } finally {
    mounted.dispose()
  }
})

it("preserves a literal known model ID ending with a thinking word", () => {
  const ordinary = model("synthetic", "shared", 11111)
  const literal = model("synthetic", "shared:high", 22222)
  const mounted = mount([ordinary, literal], "synthetic/shared:high", true)
  try {
    expect(context(mounted.container)).toBe("22222")
    expect(mounted.container.querySelector(".model-picker-trigger strong")?.textContent).toBe(
      literal.name,
    )
    expect(
      mounted.container.querySelector<HTMLSelectElement>(".model-picker-thinking select")?.value,
    ).toBe("")
    const thinking = mounted.container.querySelector<HTMLSelectElement>(
      ".model-picker-thinking select",
    )!
    act(() => {
      thinking.value = "high"
      thinking.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(mounted.onChange).toHaveBeenCalledExactlyOnceWith("synthetic/shared:high:high")
  } finally {
    mounted.dispose()
  }
})

it("does not claim one provider for an ambiguous bare ID", () => {
  const mounted = mount(
    [model("alpha", "shared", 11111), model("beta", "shared", 22222)],
    "shared",
    true,
  )
  try {
    expect(mounted.container.querySelector(".model-passport")).toBeNull()
    expect(mounted.container.querySelector(".model-picker-thinking")).toBeNull()
    expect(mounted.container.querySelector('[role="option"][aria-selected="true"]')).toBeNull()
    expect(mounted.onChange).not.toHaveBeenCalled()
    expect(mounted.onOpenChange).not.toHaveBeenCalled()
  } finally {
    mounted.dispose()
  }
})

it("still shows a unique selector with a separate thinking suffix", () => {
  const mounted = mount([model("synthetic", "shared:8b", 22222)], "synthetic/shared:8b:high")
  try {
    expect(context(mounted.container)).toBe("22222")
  } finally {
    mounted.dispose()
  }
})

it.each([
  ["unique bare", [model("alpha", "shared", 22222)], "shared", "shared", "alpha/shared"],
  [
    "unique bare thinking",
    [model("alpha", "shared", 22222)],
    "shared:high",
    "shared",
    "alpha/shared",
  ],
  [
    "literal bare",
    [model("alpha", "shared", 11111), model("alpha", "shared:high", 22222)],
    "shared:high",
    "shared",
    "alpha/shared:high",
  ],
  [
    "case-insensitive exact",
    [model("alpha", "shared", 22222)],
    "ALPHA/SHARED",
    "ALPHA/SHARED",
    "alpha/shared",
  ],
  [
    "duplicate exact",
    [model("alpha", "shared", 11111), model("alpha", "shared", 22222)],
    "alpha/shared",
    "alpha/shared",
    undefined,
  ],
  [
    "unknown qualified",
    [model("alpha", "beta/shared", 11111)],
    "beta/shared",
    "beta/shared",
    undefined,
  ],
  ["unsupported alias", [model("alpha", "shared", 22222)], "@default", "@default", undefined],
  ["missing", [], "alpha/shared", "alpha/shared", undefined],
] as const)(
  "identifies %s conservatively without altering input",
  (_name, source, value, base, expected) => {
    const models = source.map((item) =>
      Object.freeze({
        ...item,
        thinking: Object.freeze([...item.thinking]) as unknown as string[],
      }),
    )
    const before = JSON.stringify(models)
    expect(catalogModelForSelector(models, value, base)?.selector).toBe(expected)
    expect(JSON.stringify(models)).toBe(before)
  },
)

it("removes stale metadata when a once-unique bare selector becomes ambiguous", () => {
  const alpha = model("alpha", "shared", 22222)
  const mounted = mount([alpha], "shared")
  try {
    expect(context(mounted.container)).toBe("22222")
    expect(mounted.container.querySelector(".model-passport")?.textContent).toContain(
      "alpha/shared",
    )
    mounted.render([alpha, model("beta", "shared", 11111)])
    expect(mounted.container.querySelector(".model-passport")).toBeNull()
    mounted.render([alpha])
    expect(context(mounted.container)).toBe("22222")
    mounted.render([])
    expect(mounted.container.querySelector(".model-passport")).toBeNull()
    expect(mounted.onChange).not.toHaveBeenCalled()
    expect(mounted.onOpenChange).not.toHaveBeenCalled()
  } finally {
    mounted.dispose()
  }
})

it.each([false, true])(
  "does not strip a thinking word from unsupported slash-containing raw IDs (duplicate=%s)",
  (duplicate) => {
    const raw = model("custom-alpha", "beta/shared:high", 11111)
    const mounted = mount(
      [
        raw,
        ...(duplicate ? [model("custom-gamma", "beta/shared:high", 33333)] : []),
        model("beta", "shared", 22222),
      ],
      "beta/shared:high",
    )
    try {
      expect(mounted.container.querySelector(".model-passport")).toBeNull()
      expect(mounted.onChange).not.toHaveBeenCalled()
      expect(mounted.onOpenChange).not.toHaveBeenCalled()
    } finally {
      mounted.dispose()
    }
  },
)
