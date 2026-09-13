/** @vitest-environment jsdom */
import { act, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { readSessionTranscript, openContentLink } from "./api"
import { TranscriptModal } from "./TranscriptModal"
import { useTranscript } from "./useTranscript"
import type { SessionSummary, SessionTranscript } from "./types"

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./api", () => ({
  readSessionTranscript: vi.fn(),
  openContentLink: vi.fn().mockResolvedValue(undefined),
  errorMessage: (error: unknown) => String(error),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const session: SessionSummary = {
  id: "synthetic",
  title: "Synthetic transcript",
  pinnedTitle: null,
  cwd: "/tmp/project",
  projectKey: "project",
  filePath: "/tmp/synthetic.jsonl",
  parentSessionPath: null,
  createdAt: "2026-01-01",
  updatedAt: 1,
  model: null,
  thinkingLevel: null,
  configuredThinkingLevel: null,
  source: "test",
  hasMessages: true,
  primaryProviderPinned: false,
}
let transcript: SessionTranscript
let container: HTMLDivElement
let root: Root
let frames: Map<number, FrameRequestCallback>
let nextFrame: number

function Harness() {
  const state = useTranscript("en")
  const { loadTranscript } = state
  useEffect(() => {
    void loadTranscript(session)
  }, [loadTranscript])
  return (
    state.transcriptSession && (
      <TranscriptModal
        lang="en"
        {...state}
        transcriptSession={state.transcriptSession}
        launching={null}
        runtimeAvailable
        onClose={state.closeTranscript}
        onRefresh={() => void state.loadTranscript(session)}
        onReread={() => undefined}
        onError={() => undefined}
        onSearchChange={state.setSearch}
        onClearSearch={() => state.setSearch("")}
        onModeChange={state.setMode}
      />
    )
  )
}

async function flushFrames() {
  for (let turn = 0; frames.size && turn < 20; turn++) {
    const batch = Array.from(frames.values())
    frames.clear()
    await act(async () => {
      for (const callback of batch) callback(turn)
    })
  }
  expect(frames.size).toBe(0)
}
async function searchFor(query: string) {
  const input = container.querySelector<HTMLInputElement>("input[type=search]")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await flushFrames()
}
async function click(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.title === label ||
      item.textContent === label,
  )!
  expect(button).toBeDefined()
  await act(async () => button.click())
  await flushFrames()
}
function currentOccurrence() {
  return container.querySelector<HTMLElement>("mark.is-current")
}

beforeEach(async () => {
  vi.clearAllMocks()
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const scroll = this.closest<HTMLElement>(".transcript-scroll")
    const article = this.closest<HTMLElement>("article")
    let top = article ? Number.parseFloat(article.style.top) - (scroll?.scrollTop ?? 0) : 0
    let height = this.classList.contains("transcript-scroll") ? 480 : 92
    if (this.tagName === "ARTICLE" && this.dataset.virtualIndex === "120") height = 1200
    if (this.tagName === "MARK") {
      top += this.dataset.matchIndex === "1" ? 1050 : 50
      height = 16
    }
    return {
      x: 0,
      y: top,
      left: 0,
      top,
      right: 800,
      bottom: top + height,
      width: 800,
      height,
      toJSON: () => ({}),
    }
  })
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480)
  transcript = {
    session,
    updatedAt: 1,
    truncated: false,
    entries: Array.from({ length: 180 }, (_, index) => ({
      id: `entry-${index}`,
      timestamp: "2026-01-01",
      role: "assistant",
      category: "dialogue" as const,
      text:
        index === 0
          ? "  selected\ntext  "
          : index === 120
            ? `needle${"\ncontext".repeat(80)}\nneedle`
            : index === 170
              ? "[needle](local://needle.txt)"
              : `Message ${index}`,
      dialogueText:
        index === 0
          ? "  selected\ntext  "
          : index === 120
            ? null
            : index === 170
              ? "[needle](local://needle.txt)"
              : `Message ${index}`,
    })),
  }
  vi.mocked(readSessionTranscript).mockResolvedValue(transcript)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Harness />))
  await flushFrames()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("finds offscreen occurrences, scrolls inside one tall message and wraps in both directions without breaking links", async () => {
  expect(container.textContent).not.toContain("needle")
  await searchFor("needle")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 3")
  expect(currentOccurrence()?.closest("article")?.dataset.virtualIndex).toBe("120")
  const scroll = container.querySelector<HTMLElement>(".transcript-scroll")!
  const firstScroll = scroll.scrollTop
  await click("Next match")
  expect(currentOccurrence()?.dataset.matchIndex).toBe("1")
  expect(scroll.scrollTop).toBeGreaterThan(firstScroll + 400)
  const input = container.querySelector("input")!
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  )
  await flushFrames()
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("3 / 3")
  const link = currentOccurrence()!.closest("a")!
  await act(async () => link.click())
  expect(openContentLink).toHaveBeenCalledWith("local://needle.txt", session.filePath, "open")
  await click("Next match")
  expect(currentOccurrence()?.dataset.matchIndex).toBe("0")
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  )
  await flushFrames()
  expect(currentOccurrence()?.dataset.matchIndex).toBe("2")
})

it("allows manual scrolling after find and returns to a lone match on Next", async () => {
  await searchFor("needle")
  await click("Dialogue only")
  const scroll = container.querySelector<HTMLElement>(".transcript-scroll")!
  act(() => {
    scroll.scrollTop = 3000
    scroll.dispatchEvent(new Event("scroll"))
  })
  await flushFrames()
  expect(scroll.scrollTop).toBe(3000)
  expect(currentOccurrence()).toBeNull()
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 1")
  await click("Next match")
  expect(currentOccurrence()?.closest("a")?.getAttribute("href")).toBe("local://needle.txt")
})

it("resets occurrence state for mode changes, missing queries, clear and refreshed content", async () => {
  await searchFor("needle")
  await click("Next match")
  await click("Dialogue only")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 1")
  await searchFor("absent")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("0 / 0")
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Next match"]')?.disabled).toBe(
    true,
  )
  expect(currentOccurrence()).toBeNull()
  await searchFor("")
  expect(container.querySelector<HTMLElement>(".transcript-scroll")?.scrollTop).toBe(0)
  await searchFor("needle")
  vi.mocked(readSessionTranscript).mockResolvedValue({
    ...transcript,
    entries: [{ ...transcript.entries[0], text: "needle needle", dialogueText: "needle needle" }],
  })
  await click("Reread file")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 2")
  expect(currentOccurrence()?.closest("article")?.dataset.virtualIndex).toBe("0")
})

it("scopes Ctrl/Cmd+F to the modal and preserves exact selected text until Copy", async () => {
  const panel = container.querySelector<HTMLElement>('[role="dialog"]')!
  const input = container.querySelector<HTMLInputElement>("input[type=search]")!
  for (const modifier of ["ctrlKey", "metaKey"]) {
    const event = new KeyboardEvent("keydown", {
      key: "f",
      code: "KeyF",
      [modifier]: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => panel.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
  }
  const outside = document.createElement("input")
  document.body.appendChild(outside)
  const externalFind = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  outside.dispatchEvent(externalFind)
  expect(externalFind.defaultPrevented).toBe(false)
  outside.remove()
  const pre = container.querySelector("pre")!
  const range = document.createRange()
  range.selectNodeContents(pre)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  const rightDown = new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true })
  act(() => pre.dispatchEvent(rightDown))
  expect(rightDown.defaultPrevented).toBe(true)
  act(() =>
    pre.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 1020,
        clientY: 760,
      }),
    ),
  )
  const copy = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
  act(() => copy.dispatchEvent(down))
  expect(down.defaultPrevented).toBe(true)
  expect(selection.toString()).toBe("  selected\ntext  ")
  await act(async () => copy.click())
  expect(writeText).toHaveBeenCalledWith("  selected\ntext  ")
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it("offers reveal for file links and does not steal an unrelated selection", async () => {
  await searchFor("needle")
  await click("Previous match")
  const link = currentOccurrence()!.closest("a")!
  const outside = document.createElement("p")
  outside.textContent = "unrelated selection"
  document.body.appendChild(outside)
  const range = document.createRange()
  range.selectNodeContents(outside)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  expect(window.getSelection()?.toString()).toBe("unrelated selection")
  act(() => link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))
  expect(
    Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.textContent),
  ).not.toContain("Copy")
  expect(window.getSelection()?.toString()).toBe("unrelated selection")
  await click("Show in folder")
  expect(openContentLink).toHaveBeenCalledWith("local://needle.txt", session.filePath, "reveal")
  expect(writeText).not.toHaveBeenCalled()
  outside.remove()
})

it("does not offer Copy for a selection crossing the transcript boundary", () => {
  const outside = document.createElement("p")
  outside.textContent = "outside"
  document.body.appendChild(outside)
  try {
    const pre = container.querySelector("pre")!
    const range = document.createRange()
    range.setStart(pre, 0)
    range.setEnd(outside.firstChild!, 7)
    window.getSelection()!.addRange(range)
    const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    act(() => pre.dispatchEvent(context))
    expect(context.defaultPrevented).toBe(false)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(writeText).not.toHaveBeenCalled()
  } finally {
    outside.remove()
  }
})
