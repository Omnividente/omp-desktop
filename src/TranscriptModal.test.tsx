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
let sessionNumber = 0
let rowHeights: Map<number, number>
let viewportWidth: number
let resizeObservers: Set<() => void>

function Harness({ hideSearchedEntries = false }: { hideSearchedEntries?: boolean }) {
  const state = useTranscript("en")
  const { loadTranscript } = state
  useEffect(() => {
    void loadTranscript(session)
  }, [loadTranscript])
  return (
    <>
      <button onClick={() => void state.loadTranscript(session)}>Open transcript</button>
      <button onClick={() => void state.loadTranscriptPath(session.filePath)}>
        Read current transcript
      </button>
      <button
        onClick={() =>
          void state.loadTranscript({ ...session, filePath: `${session.filePath}.other` })
        }
      >
        Open other transcript
      </button>
      {state.transcriptSession && (
        <TranscriptModal
          lang="en"
          {...state}
          initialPosition={state.transcriptInitialPosition}
          transcriptSession={state.transcriptSession}
          launching={null}
          runtimeAvailable
          visibleEntries={hideSearchedEntries && state.transcriptSearch ? [] : state.visibleEntries}
          onClose={state.closeTranscript}
          onRefresh={() => void state.loadTranscript(session)}
          onReread={() => undefined}
          onError={() => undefined}
          onSearchChange={state.setSearch}
          onClearSearch={() => state.setSearch("")}
          onModeChange={state.setMode}
        />
      )}
    </>
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

async function scrollTo(top: number) {
  const scroll = container.querySelector<HTMLElement>(".transcript-scroll")!
  act(() => {
    scroll.scrollTop = top
    scroll.dispatchEvent(new Event("scroll"))
  })
  await flushFrames()
  return scroll
}

function readingRow() {
  return Array.from(container.querySelectorAll<HTMLElement>("article[data-virtual-index]")).find(
    (row) => row.getBoundingClientRect().bottom > 0,
  )!
}

async function resizeTo(width: number, containerFirst = false) {
  await act(async () => {
    viewportWidth = width
    const callbacks = Array.from(resizeObservers)
    if (containerFirst) callbacks.reverse()
    for (const callback of callbacks) callback()
  })
  await flushFrames()
}

beforeEach(async () => {
  vi.clearAllMocks()
  session.filePath = `/tmp/synthetic-${++sessionNumber}.jsonl`
  rowHeights = new Map([[120, 1200]])
  viewportWidth = 800
  resizeObservers = new Set()
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
        resizeObservers.add(this.notify)
      }
      observe(target: Element) {
        this.targets.add(target)
      }
      unobserve(target: Element) {
        this.targets.delete(target)
      }
      disconnect() {
        this.targets.clear()
        resizeObservers.delete(this.notify)
      }
    },
  )
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
    if (this.tagName === "ARTICLE") height = rowHeights.get(Number(this.dataset.virtualIndex)) ?? 92
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
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewportWidth)
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    const entries = this.querySelector<HTMLElement>(".transcript-entries")
    return entries ? Number.parseFloat(entries.style.height) : 480
  })
  transcript = {
    session,
    updatedAt: 1,
    truncated: false,
    malformedRecords: 0,
    incompleteLastRecord: false,
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

it("restores a tall-message anchor after asynchronous reopen and remeasurement without borrowing another session's position", async () => {
  await scrollTo(120 * 102 + 850)
  expect(readingRow().dataset.virtualIndex).toBe("120")
  expect(readingRow().getBoundingClientRect().top).toBe(-850)
  await click("Close")

  const original = transcript
  vi.mocked(readSessionTranscript).mockResolvedValue({
    ...original,
    session: { ...session, filePath: `${session.filePath}.other` },
  })
  await click("Open other transcript")
  expect(container.querySelector<HTMLElement>(".transcript-scroll")!.scrollTop).toBe(0)
  await scrollTo(40 * 102 + 25)
  await click("Close")

  let resolve!: (value: SessionTranscript) => void
  vi.mocked(readSessionTranscript).mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  rowHeights.set(110, 300)
  await click("Open transcript")
  expect(container.querySelector("article")).toBeNull()
  await act(async () => resolve(original))
  await flushFrames()
  expect(readingRow().dataset.virtualIndex).toBe("120")
  expect(readingRow().getBoundingClientRect().top).toBe(-850)

  await click("Close")
  vi.mocked(readSessionTranscript).mockResolvedValue({
    ...original,
    session: { ...session, filePath: `${session.filePath}.other` },
  })
  await click("Open other transcript")
  expect(readingRow().dataset.virtualIndex).toBe("40")
  expect(readingRow().getBoundingClientRect().top).toBe(-25)
})

it("follows a moved anchor, clamps a shortened message, and falls back when the anchor disappears", async () => {
  await scrollTo(120 * 102 + 850)
  await click("Close")
  const moved = { ...transcript, entries: transcript.entries.slice(5) }
  rowHeights.clear()
  rowHeights.set(115, 200)
  vi.mocked(readSessionTranscript).mockResolvedValue(moved)
  await click("Open transcript")
  expect(readingRow().dataset.virtualIndex).toBe("115")
  expect(readingRow().textContent).toContain("needle")
  expect(readingRow().getBoundingClientRect().top).toBe(-199)
  await click("Close")

  vi.mocked(readSessionTranscript).mockResolvedValue({
    ...transcript,
    entries: transcript.entries.slice(0, 8),
  })
  await click("Open transcript")
  const scroll = container.querySelector<HTMLElement>(".transcript-scroll")!
  expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight)
  expect(container.textContent).toContain("Message 7")
})

it("lets explicit search and mode navigation supersede an unsettled restore", async () => {
  await scrollTo(120 * 102 + 850)
  await click("Close")
  // Reopen without advancing animation frames: restoration is still settling.
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Open transcript")!
      .click()
  })
  await searchFor("Message 40")
  expect(currentOccurrence()?.closest("article")?.dataset.virtualIndex).toBe("40")
  await searchFor("")
  expect(container.querySelector<HTMLElement>(".transcript-scroll")!.scrollTop).toBe(0)

  await scrollTo(60 * 102 + 25)
  await click("Close")
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Open transcript")!
      .click()
  })
  await click("Dialogue only")
  expect(container.querySelector<HTMLElement>(".transcript-scroll")!.scrollTop).toBe(0)
})

it("keeps the transcript viewport keyboard-accessible without consuming native scroll keys", () => {
  const panel = container.querySelector<HTMLElement>('[role="dialog"]')!
  const scroll = container.querySelector<HTMLElement>('[role="region"]')!
  const first = panel.querySelector<HTMLButtonElement>("button")!
  act(() => {
    first.focus()
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    )
  })
  expect(document.activeElement).toBe(panel.querySelector("article:last-child button:last-child"))
  expect(scroll.tabIndex).toBe(0)
  expect(document.getElementById(scroll.getAttribute("aria-labelledby")!)?.textContent).toBe(
    session.title,
  )
  for (const key of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    act(() => scroll.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  }
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
  await click("Source")
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
    const pre = container.querySelector(".markdown-content")!
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

it("opens direct reads at the latest saved dialogue and returns there after search", async () => {
  await click("Close")
  const calls = vi.mocked(readSessionTranscript).mock.calls.length
  await click("Read current transcript")
  expect(readSessionTranscript).toHaveBeenCalledTimes(calls + 1)
  expect(
    container.querySelector('[aria-label="Transcript content"] button[aria-pressed="true"]')
      ?.textContent,
  ).toBe("Dialogue only")
  const last = container.querySelector<HTMLElement>('article[data-virtual-index="178"]')!
  expect(last.textContent).toContain("Message 179")
  expect(last.getBoundingClientRect().top).toBeLessThan(480)
  expect(last.getBoundingClientRect().bottom).toBeGreaterThan(0)
  await searchFor("Message 20")
  await click("Latest message")
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("")
  expect(
    container
      .querySelector<HTMLElement>('article[data-virtual-index="178"]')!
      .getBoundingClientRect().bottom,
  ).toBeGreaterThan(0)
})

it("keeps the reading message through source toggles and a refresh with appended entries", async () => {
  await scrollTo(60 * 102 + 25)
  await click("Source")
  expect(readingRow().dataset.virtualIndex).toBe("60")
  await click("Formatted")
  expect(readingRow().dataset.virtualIndex).toBe("60")
  vi.mocked(readSessionTranscript).mockResolvedValue({
    ...transcript,
    entries: [
      ...transcript.entries,
      {
        ...transcript.entries[0],
        id: "appended",
        text: "Latest appended",
        dialogueText: "Latest appended",
      },
    ],
  })
  await click("Reread file")
  expect(readingRow().dataset.virtualIndex).toBe("60")
  await click("Latest message")
  expect(container.textContent).toContain("Latest appended")
})

it("preserves a tall visible row through width invalidation, clamps shrinking content, and yields to navigation", async () => {
  // Seed a measured row that will be offscreen when width changes.
  rowHeights.set(20, 400)
  await scrollTo(20 * 102)
  await scrollTo(120 * 102 + 308 + 850)
  expect(readingRow().dataset.virtualIndex).toBe("120")
  expect(readingRow().getBoundingClientRect().top).toBe(-850)

  rowHeights.set(20, 200)
  rowHeights.set(110, 300)
  rowHeights.set(120, 1000)
  await resizeTo(600)
  expect(readingRow().dataset.virtualIndex).toBe("120")
  expect(readingRow().getBoundingClientRect().top).toBe(-850)
  // The unmounted row 20 must no longer contribute its stale 400px height.
  expect(Number.parseFloat(readingRow().style.top)).toBe(120 * 102 + 208)

  rowHeights.set(120, 400)
  await resizeTo(1000, true)
  expect(readingRow().dataset.virtualIndex).toBe("120")
  expect(readingRow().getBoundingClientRect().top).toBe(-399)
  rowHeights.set(120, 1200)
  await resizeTo(600)
  expect(readingRow().getBoundingClientRect().top).toBe(-399)
  await click("Close")
  await click("Open transcript")
  expect(readingRow().dataset.virtualIndex).toBe("120")
  expect(readingRow().getBoundingClientRect().top).toBe(-399)

  await searchFor("needle")
  await click("Next match")
  expect(currentOccurrence()?.dataset.matchIndex).toBe("1")
  expect(currentOccurrence()!.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
  expect(currentOccurrence()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(480)
  await scrollTo(40 * 102 + 25)
  await resizeTo(900)
  expect(readingRow().dataset.virtualIndex).toBe("40")
  expect(readingRow().getBoundingClientRect().top).toBe(-25)
  await click("Latest message")
  expect(container.querySelector('article[data-virtual-index="179"]')).not.toBeNull()
})

it("returns both explicit Clear search actions to the search input without stealing Latest focus", async () => {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
  await searchFor("needle")
  const inline = container.querySelector<HTMLButtonElement>(".transcript-search-field button")!
  act(() => inline.focus())
  await act(async () => inline.click())
  await flushFrames()
  expect(input.value).toBe("")
  expect(document.activeElement).toBe(input)

  await act(async () => root.render(<Harness hideSearchedEntries />))
  await searchFor("missing")
  const empty = container.querySelector<HTMLButtonElement>(".transcript-state button")!
  act(() => empty.focus())
  await act(async () => empty.click())
  await flushFrames()
  expect(input.value).toBe("")
  expect(document.activeElement).toBe(input)

  await act(async () => root.render(<Harness />))
  await searchFor("needle")
  const latest = container.querySelector<HTMLButtonElement>('[aria-label="Latest message"]')!
  act(() => latest.focus())
  await click("Latest message")
  expect(document.activeElement).toBe(latest)
})

it("consumes menu-item Tab in both directions but leaves outside Tab navigation alone", async () => {
  await searchFor("needle")
  await click("Next match")
  await click("Next match")
  const link = container.querySelector<HTMLAnchorElement>('a[href="local://needle.txt"]')!
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
  const downstream = vi.fn()
  document.addEventListener("keydown", downstream)
  try {
    for (const shiftKey of [false, true]) {
      act(() => {
        link.focus()
        link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
      })
      act(() =>
        link.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
          }),
        ),
      )
      expect(document.activeElement?.getAttribute("role")).toBe("menuitem")
      const tab = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      })
      act(() => document.activeElement!.dispatchEvent(tab))
      expect(tab.defaultPrevented).toBe(true)
      expect(document.querySelector('[role="menu"]')).toBeNull()
      expect(document.activeElement).toBe(link)
      expect(downstream).not.toHaveBeenCalled()
    }

    act(() =>
      link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    )
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    act(() => {
      input.focus()
      input.dispatchEvent(tab)
    })
    expect(tab.defaultPrevented).toBe(false)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(input)
    expect(downstream).toHaveBeenCalledTimes(1)
  } finally {
    document.removeEventListener("keydown", downstream)
  }
})
