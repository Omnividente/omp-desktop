/** @vitest-environment jsdom */
import { act, StrictMode, useEffect, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodexImportModal } from "./CodexImportModal"
import { ImportSessionModal } from "./ImportSessionModal"
import type { CodexSessionSummary } from "./types"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const session: CodexSessionSummary = {
  id: "synthetic",
  title: "Synthetic import",
  cwd: "/synthetic/project",
  filePath: "/synthetic/session.jsonl",
  createdAt: "2026-01-01",
  updatedAt: 1,
  model: null,
  preview: "",
}
let root: Root
let container: HTMLDivElement
let opener: HTMLButtonElement

beforeEach(() => {
  opener = document.createElement("button")
  opener.textContent = "Open import"
  container = document.createElement("div")
  document.body.append(opener, container)
  root = createRoot(container)
  opener.focus()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  opener.remove()
})

function press(target: Element, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })
  act(() => target.dispatchEvent(event))
  return event
}

function dialog() {
  return container.querySelector<HTMLElement>("[role=dialog]")!
}

function closeButton() {
  return dialog().querySelector<HTMLButtonElement>("header button")!
}

describe.each(["OMP", "Codex"] as const)("%s import keyboard navigation", (kind) => {
  function renderModal({
    importing = false,
    loading = false,
    selected = true,
    onClosed = () => undefined,
  }: {
    importing?: boolean
    loading?: boolean
    selected?: boolean
    onClosed?: () => void
  } = {}) {
    const common = {
      importing,
      language: "en" as const,
      mode: "skip" as const,
      onClose: () => {
        onClosed()
        root.render(null)
      },
      onImport: () => undefined,
      onModeChange: () => undefined,
    }
    act(() =>
      root.render(
        <StrictMode>
          {kind === "OMP" ? (
            <ImportSessionModal {...common} path={session.filePath} />
          ) : (
            <CodexImportModal
              {...common}
              loading={loading}
              sessions={loading ? [] : [session]}
              selected={selected ? { [session.filePath]: true } : {}}
              onSelectedChange={() => undefined}
            />
          )}
        </StrictMode>,
      ),
    )
  }

  it("starts in the dialog and wraps both keyboard navigation boundaries", () => {
    renderModal()
    const panel = dialog()
    const controls = Array.from(panel.querySelectorAll<HTMLElement>("button, input, select"))
    const first = controls[0]
    const last = controls[controls.length - 1]
    expect(document.activeElement).toBe(panel)
    expect(press(panel, "Tab").defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    press(first, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(last)
    press(last, "Tab")
    expect(document.activeElement).toBe(first)
    panel.focus()
    press(panel, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(last)
    first.focus()
    // Interior traversal belongs to the browser; only the boundaries are intercepted.
    expect(press(first, "Tab").defaultPrevented).toBe(false)
  })

  it("preserves active control across rerenders and restores the opener with the latest close action", () => {
    const oldClose = vi.fn()
    const currentClose = vi.fn()
    renderModal({ loading: true, onClosed: oldClose })
    const select = dialog().querySelector("select")!
    select.focus()
    renderModal({ onClosed: currentClose })
    expect(document.activeElement).toBe(select)
    closeButton().focus()
    press(closeButton(), "Escape")
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(oldClose).not.toHaveBeenCalled()
    expect(currentClose).toHaveBeenCalledOnce()
  })

  it("restores focus after pointer dismissal", () => {
    renderModal()
    act(() => closeButton().click())
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
    renderModal()
    act(() =>
      container.firstElementChild!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    )
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it("leaves Escape to native selects, composition and an inner popup", () => {
    renderModal()
    const panel = dialog()
    const select = panel.querySelector("select")!
    select.focus()
    expect(press(select, "Escape").defaultPrevented).toBe(false)
    expect(dialog()).toBe(panel)
    panel.focus()
    expect(press(panel, "Escape", { isComposing: true }).defaultPrevented).toBe(false)
    expect(press(panel, "Escape", { keyCode: 229 }).defaultPrevented).toBe(false)
    expect(dialog()).toBe(panel)
    const popup = document.createElement("button")
    popup.textContent = "Nested popup action"
    panel.append(popup)
    popup.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        popup.hidden = true
        panel.focus()
      }
    })
    popup.focus()
    press(popup, "Escape")
    expect(popup.hidden).toBe(true)
    expect(dialog()).toBe(panel)
    press(panel, "Escape")
    expect(dialog()).toBeNull()
  })

  it("keeps focus contained and rejects every dismissal while importing, then allows closing", () => {
    renderModal()
    closeButton().focus()
    renderModal({ importing: true })
    const panel = dialog()
    expect(document.activeElement).toBe(panel)
    expect(closeButton().disabled).toBe(true)
    press(panel, "Escape")
    act(() => closeButton().click())
    act(() =>
      container.firstElementChild!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    )
    expect(dialog()).toBe(panel)
    const controls = Array.from(
      panel.querySelectorAll<HTMLElement>("button, input, select"),
    ).filter((element) => !element.matches(":disabled"))
    const first = controls[0] ?? panel
    const last = controls[controls.length - 1] ?? panel
    press(panel, "Tab")
    expect(document.activeElement).toBe(first)
    press(first, "Tab", { shiftKey: true })
    expect(document.activeElement).toBe(last)
    press(last, "Tab")
    expect(document.activeElement).toBe(first)
    renderModal()
    panel.focus()
    press(panel, "Escape")
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  if (kind === "Codex") {
    it("does not tab onto the disabled import action when nothing is selected", () => {
      renderModal({ selected: false })
      const buttons = dialog().querySelectorAll<HTMLButtonElement>("footer button")
      const selectAll = buttons[0]
      expect(buttons[1].disabled).toBe(true)
      selectAll.focus()
      press(selectAll, "Tab")
      expect(document.activeElement).toBe(closeButton())
      press(closeButton(), "Tab", { shiftKey: true })
      expect(document.activeElement).toBe(selectAll)
    })
  }
})

it("keeps distant Codex sessions keyboard-reachable and selectable without mounting the entire list", () => {
  const sessions = Array.from({ length: 200 }, (_, index): CodexSessionSummary => ({
    ...session,
    id: `synthetic-${index}`,
    title: `Session ${index}`,
    filePath: `/synthetic/session-${index}.jsonl`,
    preview: index % 2 ? "A longer two-line preview of the selected session" : "",
  }))
  const imported = vi.fn()
  function LargeImport() {
    const [selected, setSelected] = useState<Record<string, boolean>>({})
    return (
      <CodexImportModal
        language="en"
        loading={false}
        importing={false}
        mode="skip"
        sessions={sessions}
        selected={selected}
        onClose={() => undefined}
        onImport={() => imported(selected)}
        onModeChange={() => undefined}
        onSelectedChange={setSelected}
      />
    )
  }
  act(() => root.render(<LargeImport />))
  const first = dialog().querySelector<HTMLInputElement>(
    '.codex-item[data-virtual-index="0"] input',
  )!
  expect(first).not.toBeNull()
  expect(dialog().querySelectorAll(".codex-item").length).toBeLessThan(40)
  act(() => first.focus())
  expect(press(first, "End").defaultPrevented).toBe(true)
  const last = dialog().querySelector<HTMLInputElement>(
    '.codex-item[data-virtual-index="199"] input',
  )!
  expect(last).not.toBeNull()
  expect(document.activeElement).toBe(last)
  expect(dialog().querySelectorAll(".codex-item").length).toBeLessThan(40)
  act(() => last.click())
  expect(last.checked).toBe(true)
  act(() => dialog().querySelector<HTMLButtonElement>("footer .primary")!.click())
  expect(imported).toHaveBeenCalledWith({ [sessions[199].filePath]: true })
  const firstAgain = () =>
    dialog().querySelector<HTMLInputElement>('.codex-item[data-virtual-index="0"] input')!
  press(last, "Home")
  act(() => {
    const input = firstAgain()
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    )
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
    )
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
    )
  })
  expect(document.activeElement).toBe(
    dialog().querySelector('.codex-item[data-virtual-index="197"] input'),
  )
  const pendingLast = document.activeElement!
  press(pendingLast, "Home")
  act(() => {
    const input = firstAgain()
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    )
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
    )
  })
  expect(document.activeElement).toBe(firstAgain())
  press(firstAgain(), "End")
  expect(press(document.activeElement!, "Home").defaultPrevented).toBe(true)
  const back = dialog().querySelector<HTMLInputElement>(
    '.codex-item[data-virtual-index="0"] input',
  )!
  expect(document.activeElement).toBe(back)
  expect(back.checked).toBe(false)
  act(() => dialog().querySelector<HTMLButtonElement>("footer .secondary")!.click())
  expect(back.checked).toBe(true)
  act(() => dialog().querySelector<HTMLButtonElement>("footer .primary")!.click())
  expect(Object.keys(imported.mock.lastCall![0]).length).toBe(sessions.length)
  expect(imported.mock.lastCall![0][sessions[199].filePath]).toBe(true)
})

it("scrolls deferred Codex discovery and preserves reload/close boundaries", async () => {
  const sessions = Array.from({ length: 200 }, (_, index): CodexSessionSummary => ({
    ...session,
    id: `async-${index}`,
    title: `Discovered ${index}`,
    filePath: `/synthetic/discovered-${index}.jsonl`,
  }))
  let discover!: (sessions: CodexSessionSummary[]) => void
  const discovery = new Promise<CodexSessionSummary[]>((resolve) => {
    discover = resolve
  })
  const imported = vi.fn()
  const observers = new Set<() => void>()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  let viewportHeight = 480
  let viewportWidth = 700
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame))
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      private targets = new Set<Element>()
      private notify: () => void
      constructor(callback: ResizeObserverCallback) {
        this.notify = () =>
          callback(
            Array.from(this.targets, (target) => ({ target }) as ResizeObserverEntry),
            this,
          )
        observers.add(this.notify)
      }
      observe(target: Element) {
        this.targets.add(target)
      }
      unobserve(target: Element) {
        this.targets.delete(target)
      }
      disconnect() {
        this.targets.clear()
        observers.delete(this.notify)
      }
    },
  )
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight)
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewportWidth)
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    const contents = this.querySelector<HTMLElement>(".codex-list-contents")
    return contents ? Number.parseFloat(contents.style.height) : viewportHeight
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const list = this.closest<HTMLElement>(".codex-list")
    const top = this.classList.contains("codex-item")
      ? Number.parseFloat(this.style.top) - (list?.scrollTop ?? 0)
      : 0
    const height = this.classList.contains("codex-item") ? 86 : viewportHeight
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: viewportWidth,
      bottom: top + height,
      width: viewportWidth,
      height,
      toJSON: () => ({}),
    }
  })
  async function flushFrames() {
    await act(async () => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(0)
    })
  }
  function AsyncImport({ reloading = false }: { reloading?: boolean }) {
    const [loaded, setLoaded] = useState<CodexSessionSummary[]>([])
    const [selected, setSelected] = useState<Record<string, boolean>>({})
    useEffect(() => {
      let active = true
      void discovery.then((rows) => {
        if (active) setLoaded(rows)
      })
      return () => {
        active = false
      }
    }, [])
    return (
      <CodexImportModal
        language="en"
        loading={reloading || loaded.length === 0}
        importing={false}
        mode="skip"
        sessions={loaded}
        selected={selected}
        onSelectedChange={setSelected}
        onClose={() => root.render(null)}
        onImport={() => imported(selected)}
        onModeChange={() => undefined}
      />
    )
  }
  try {
    act(() =>
      root.render(
        <StrictMode>
          <AsyncImport />
        </StrictMode>,
      ),
    )
    const list = container.querySelector<HTMLElement>(".codex-list")!
    expect(list).not.toBeNull()
    expect(list.querySelector(".codex-item")).toBeNull()
    await act(async () => discover(sessions))
    expect(list.querySelector('.codex-item[data-virtual-index="0"]')).not.toBeNull()
    expect(list.querySelectorAll(".codex-item").length).toBeLessThan(40)
    act(() => {
      list.scrollTop = list.scrollHeight - list.clientHeight
      list.dispatchEvent(new Event("scroll"))
    })
    expect(frames.size).toBe(1)
    await flushFrames()
    const last = list.querySelector<HTMLInputElement>(
      '.codex-item[data-virtual-index="199"] input',
    )!
    expect(last).not.toBeNull()
    expect(list.querySelector('.codex-item[data-virtual-index="0"]')).toBeNull()
    expect(last.closest<HTMLElement>(".codex-item")!.getBoundingClientRect().bottom).toBe(
      viewportHeight,
    )
    act(() => last.click())
    expect(last.checked).toBe(true)
    act(() => dialog().querySelector<HTMLButtonElement>("footer .primary")!.click())
    expect(imported).toHaveBeenCalledWith({ [sessions[199].filePath]: true })

    const position = list.scrollTop
    act(() =>
      root.render(
        <StrictMode>
          <AsyncImport reloading />
        </StrictMode>,
      ),
    )
    expect(container.querySelector(".codex-list")).toBe(list)
    expect(list.scrollTop).toBe(position)
    expect(list.querySelector('.codex-item[data-virtual-index="199"]')).not.toBeNull()
    act(() =>
      root.render(
        <StrictMode>
          <AsyncImport />
        </StrictMode>,
      ),
    )
    const oldCount = list.querySelectorAll(".codex-item").length
    await act(async () => {
      viewportWidth = 400
      viewportHeight = 240
      for (const notify of [...observers]) notify()
    })
    act(() => {
      list.scrollTop = list.scrollHeight - list.clientHeight
      list.dispatchEvent(new Event("scroll"))
    })
    expect(frames.size).toBe(1)
    await flushFrames()
    expect(list.querySelectorAll(".codex-item").length).toBeLessThan(oldCount)
    expect(
      list.querySelector('.codex-item[data-virtual-index="199"]')!.getBoundingClientRect().bottom,
    ).toBe(viewportHeight)

    act(() => list.dispatchEvent(new Event("scroll")))
    expect(frames.size).toBe(1)
    act(() => closeButton().click())
    expect(dialog()).toBeNull()
    expect(frames.size).toBe(0)
    expect(observers.size).toBe(0)
    list.dispatchEvent(new Event("scroll"))
    expect(frames.size).toBe(0)
  } finally {
    act(() => root.render(null))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
