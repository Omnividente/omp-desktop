/** @vitest-environment jsdom */

import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionRow } from "./SessionRow"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

describe("focused session title disclosure", () => {
  let container: HTMLDivElement
  let root: Root
  let props: ComponentProps<typeof SessionRow>
  const row = () => container.querySelector<HTMLDivElement>(".session-select")!
  const tooltip = () => document.querySelector('[role="tooltip"]')
  const keydown = (key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    })
    act(() => row().dispatchEvent(event))
    return event
  }

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    props = {
      actionsDisabled: false,
      busy: false,
      childrenExpanded: false,
      deleting: false,
      depth: 0,
      hasChildren: false,
      lang: "en",
      launchDisabled: false,
      onDelete: vi.fn(),
      onDoubleLaunch: vi.fn(),
      onKeySelect: vi.fn(),
      onLaunch: vi.fn(),
      onRenameChange: vi.fn(),
      onRenameKeyDown: vi.fn(),
      onSelect: vi.fn(),
      onStartRename: vi.fn(),
      onSubmitRename: vi.fn(),
      onToggleChildren: vi.fn(),
      onToggleTitlePin: vi.fn(),
      onTranscript: vi.fn(),
      renameValue: "",
      renaming: false,
      selected: true,
      session: {
        id: "synthetic-session",
        title: "A long synthetic session title — 日本語",
        pinnedTitle: null,
        cwd: "/synthetic/project",
        projectKey: "/synthetic/project",
        filePath: "/synthetic/session.jsonl",
        parentSessionPath: null,
        createdAt: "2026-11-11T00:00:00.000Z",
        updatedAt: 1,
        model: null,
        thinkingLevel: null,
        configuredThinkingLevel: null,
        source: "omp",
        hasMessages: true,
        primaryProviderPinned: false,
      },
      sessionOpen: false,
      sessionRunning: false,
      sessionThinking: false,
    }
    act(() => root.render(<SessionRow {...props} />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it.each(["ru", "en"] as const)("dismisses Escape without moving the %s row focus", (lang) => {
    props = { ...props, lang }
    const parentKey = vi.fn()
    act(() =>
      root.render(
        <div onKeyDown={parentKey}>
          <SessionRow {...props} />
        </div>,
      ),
    )
    act(() => row().focus())
    expect(tooltip()?.textContent).toBe(props.session.title)
    expect(row().getAttribute("aria-describedby")).toBe(tooltip()?.id)

    const event = keydown("Escape")

    expect(tooltip()).toBeNull()
    expect(row().hasAttribute("aria-describedby")).toBe(false)
    expect(document.activeElement).toBe(row())
    expect(row().getAttribute("aria-pressed")).toBe("true")
    expect(event.defaultPrevented).toBe(true)
    expect(parentKey).not.toHaveBeenCalled()
    expect(props.onKeySelect).not.toHaveBeenCalled()
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onLaunch).not.toHaveBeenCalled()
  })

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "leaves an IME-marked Escape untouched: %j",
    (options) => {
      act(() => row().focus())
      const event = keydown("Escape", options)
      expect(tooltip()?.textContent).toBe(props.session.title)
      expect(event.defaultPrevented).toBe(false)
      expect(props.onKeySelect).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(row())
    },
  )

  it("does not claim an already handled Escape", () => {
    act(() => row().focus())
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })
    event.preventDefault()
    act(() => row().dispatchEvent(event))
    expect(tooltip()).not.toBeNull()
    expect(props.onKeySelect).toHaveBeenCalledTimes(1)
  })

  it.each(["Enter", " ", "Tab", "ArrowDown"])("preserves the %j selection handler", (key) => {
    act(() => row().focus())
    const event = keydown(key)
    expect(props.onKeySelect).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
    expect(tooltip()).not.toBeNull()
  })

  it("forwards subsequent Escape when the popup is already hidden", () => {
    act(() => row().focus())
    keydown("Escape")
    const event = keydown("Escape")
    expect(event.defaultPrevented).toBe(false)
    expect(props.onKeySelect).toHaveBeenCalledTimes(1)
    expect(tooltip()).toBeNull()
  })

  it("keeps dismissal across rerenders and allows a later focus to reopen", () => {
    act(() => row().focus())
    keydown("Escape")
    act(() => root.render(<SessionRow {...props} selected={false} />))
    expect(tooltip()).toBeNull()
    act(() => row().blur())
    act(() => row().focus())
    expect(tooltip()?.textContent).toBe(props.session.title)
  })

  it("preserves hover disclosure after keyboard dismissal", () => {
    act(() => row().focus())
    keydown("Escape")
    act(() => row().dispatchEvent(new MouseEvent("mouseover", { bubbles: true })))
    expect(tooltip()?.textContent).toBe(props.session.title)
  })

  it("leaves Escape in a rename editor with its existing handler", () => {
    act(() => row().focus())
    act(() => root.render(<SessionRow {...props} renaming renameValue="Draft" />))
    const input = container.querySelector<HTMLInputElement>(".session-rename")!
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(tooltip()).toBeNull()
    expect(props.onRenameKeyDown).toHaveBeenCalledTimes(1)
    expect(props.onKeySelect).not.toHaveBeenCalled()
  })
})
