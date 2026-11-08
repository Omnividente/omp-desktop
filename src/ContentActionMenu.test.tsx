/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ContentActionMenu } from "./ContentActionMenu"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement
let origin: HTMLInputElement
let root: Root
const dismiss = vi.fn()
const run = vi.fn()

function render() {
  act(() =>
    root.render(
      <ContentActionMenu
        left={10}
        top={10}
        onDismiss={dismiss}
        actions={[
          { label: "First", run },
          { label: "Unavailable", disabled: true, run },
          { label: "Last", run },
        ]}
      />,
    ),
  )
}

function items() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
}

function press(target: HTMLElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  act(() => target.dispatchEvent(event))
  return event
}

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement("div")
  origin = document.createElement("input")
  document.body.append(container, origin)
  root = createRoot(container)
  origin.focus()
  render()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  origin.remove()
})

const keys = [
  { key: "Escape" },
  { key: "Tab", shiftKey: false },
  { key: "Tab", shiftKey: true },
  { key: "ArrowDown" },
  { key: "ArrowUp" },
]
const compositionSignals = [
  { isComposing: true, keyCode: 0 },
  { isComposing: false, keyCode: 229 },
  { isComposing: true, keyCode: 229 },
]

it.each(compositionSignals.flatMap((signal) => keys.map((key) => ({ ...key, ...signal }))))(
  "leaves $key (shift=$shiftKey, composing=$isComposing, code=$keyCode) to its owner",
  (init) => {
    const downstream = vi.fn()
    document.addEventListener("keydown", downstream)
    try {
      for (const target of [origin, items()[0]]) {
        act(() => target.focus())
        for (let repeat = 0; repeat < 2; repeat++) {
          const event = press(target, init)
          expect(event.defaultPrevented).toBe(false)
          expect(downstream).toHaveBeenLastCalledWith(event)
          expect(document.activeElement).toBe(target)
          expect(document.querySelector('[role="menu"]')).not.toBeNull()
          expect(dismiss).not.toHaveBeenCalled()
          expect(run).not.toHaveBeenCalled()
        }
      }
      const ordinary = press(items()[0], { key: "Escape" })
      expect(ordinary.defaultPrevented).toBe(true)
      expect(dismiss).toHaveBeenCalledExactlyOnceWith(true)
      expect(downstream).toHaveBeenCalledTimes(4)
    } finally {
      document.removeEventListener("keydown", downstream)
    }
  },
)

it("immediately resumes ordinary arrows, skipping disabled items and wrapping", () => {
  press(origin, { key: "ArrowDown", keyCode: 229 })
  const [first, , last] = items()
  for (const [key, expected] of [
    ["ArrowUp", last],
    ["ArrowDown", first],
    ["ArrowDown", last],
    ["ArrowUp", first],
  ] as const) {
    const event = press(document.activeElement as HTMLElement, { key })
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(expected)
  }
  expect(dismiss).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

it.each([false, true])("preserves ordinary Tab dismissal with shift=%s", (shiftKey) => {
  const downstream = vi.fn()
  document.addEventListener("keydown", downstream)
  try {
    const first = items()[0]
    act(() => first.focus())
    press(first, { key: "Tab", shiftKey, keyCode: 229 })
    downstream.mockClear()
    expect(press(first, { key: "Tab", shiftKey }).defaultPrevented).toBe(true)
    expect(dismiss).toHaveBeenLastCalledWith(true)
    expect(downstream).not.toHaveBeenCalled()
    act(() => origin.focus())
    const outside = press(origin, { key: "Tab", shiftKey })
    expect(outside.defaultPrevented).toBe(false)
    expect(dismiss).toHaveBeenLastCalledWith(false)
    expect(downstream).toHaveBeenCalledExactlyOnceWith(outside)
  } finally {
    document.removeEventListener("keydown", downstream)
  }
})

it("removes its capture listener on unmount and installs only one on reopen", () => {
  act(() => root.render(null))
  expect(press(origin, { key: "Escape" }).defaultPrevented).toBe(false)
  expect(dismiss).not.toHaveBeenCalled()
  render()
  press(origin, { key: "Escape", keyCode: 229 })
  expect(dismiss).not.toHaveBeenCalled()
  expect(press(origin, { key: "Escape" }).defaultPrevented).toBe(true)
  expect(dismiss).toHaveBeenCalledExactlyOnceWith(true)
})
