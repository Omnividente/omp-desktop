/** @vitest-environment jsdom */
import { act, StrictMode } from "react"
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
