/** @vitest-environment jsdom */
import { act, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { readSessionTranscript, openContentLink } from "./api"
import { TranscriptModal } from "./TranscriptModal"
import { useTranscript } from "./useTranscript"
import { SEARCH_HIGHLIGHT_LIMIT } from "./transcriptSearch"
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

it("offers match case for loaded transcript text and resets match navigation without rereading", async () => {
  transcript.entries[120] = { ...transcript.entries[120], text: "path PATH Path" }
  transcript.entries[170] = {
    ...transcript.entries[170],
    text: "PATH path",
    dialogueText: "PATH path",
  }
  await click("Reread file")
  await searchFor("PATH")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 5")
  await click("Previous match")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("5 / 5")
  const reads = vi.mocked(readSessionTranscript).mock.calls.length
  const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Match case"]')!
  expect(toggle).not.toBeNull()
  expect(toggle.getAttribute("aria-pressed")).toBe("false")
  act(() => toggle.focus())
  await click("Match case")
  expect(document.activeElement).toBe(toggle)
  expect(toggle.getAttribute("aria-pressed")).toBe("true")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 2")
  expect(currentOccurrence()?.textContent).toBe("PATH")
  expect(currentOccurrence()?.closest("article")?.dataset.virtualIndex).toBe("120")
  await click("Previous match")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("2 / 2")
  expect(currentOccurrence()?.closest("article")?.dataset.virtualIndex).toBe("170")
  await click("Match case")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 5")
  expect(vi.mocked(readSessionTranscript).mock.calls.length).toBe(reads)
  expect(writeText).not.toHaveBeenCalled()
})

it("keeps match case through refresh and appearance changes, handles zero matches, and resets on reopen", async () => {
  await searchFor("NEEDLE")
  await click("Match case")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("0 / 0")
  expect(container.querySelector("mark")).toBeNull()
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Next match"]')?.disabled).toBe(
    true,
  )
  await click("Reread file")
  await searchFor("NEEDLE")
  expect(container.querySelector('[aria-label="Match case"]')?.getAttribute("aria-pressed")).toBe(
    "true",
  )
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("0 / 0")
  await click("Source")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("0 / 0")
  await searchFor("needle")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 4")
  await click("Close")
  await click("Open transcript")
  expect(container.querySelector('[aria-label="Match case"]')?.getAttribute("aria-pressed")).toBe(
    "false",
  )
})

it("does not move the reading position when match case changes with an empty query", async () => {
  const scroll = await scrollTo(80 * 102 + 25)
  const before = scroll.scrollTop
  await click("Match case")
  expect(scroll.scrollTop).toBe(before)
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("0 / 0")
  await click("Match case")
  expect(scroll.scrollTop).toBe(before)
})

it("shows loaded session details without launching, rereading or copying", async () => {
  const loaded = {
    ...session,
    id: "loaded-identity",
    cwd: "/synthetic/loaded-project",
    model: "synthetic/loaded-model",
    parentSessionPath: "raw-previous-reference",
  }
  vi.mocked(readSessionTranscript).mockResolvedValue({ ...transcript, session: loaded })
  await click("Open transcript")
  const calls = vi.mocked(readSessionTranscript).mock.calls.length
  const details = container.querySelector<HTMLDetailsElement>(".session-details")!
  expect(details.open).toBe(false)
  await act(async () => details.querySelector("summary")!.click())
  expect(details.open).toBe(true)
  expect(details.textContent).toContain("loaded-identity")
  expect(details.textContent).toContain("/synthetic/loaded-project")
  expect(details.textContent).toContain("synthetic/loaded-model")
  expect(details.textContent).toContain("raw-previous-reference")
  expect(readSessionTranscript).toHaveBeenCalledTimes(calls)
  expect(writeText).not.toHaveBeenCalled()
  expect(openContentLink).not.toHaveBeenCalled()
})

it("hides session details while reloading and after a failed read", async () => {
  await act(async () =>
    container
      .querySelector(".session-details summary")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  )
  let reject!: (error: Error) => void
  vi.mocked(readSessionTranscript).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail
      }),
  )
  await click("Reread file")
  expect(container.querySelector(".session-details")).toBeNull()
  await act(async () => reject(new Error("Synthetic read failure")))
  expect(container.querySelector(".session-details")).toBeNull()
  expect(container.textContent).toContain("Synthetic read failure")
  vi.mocked(readSessionTranscript).mockResolvedValue(transcript)
  await click("Reread file")
  expect(container.querySelector<HTMLDetailsElement>(".session-details")?.open).toBe(false)
})

it("does not carry expanded details to another history", async () => {
  await act(async () => container.querySelector<HTMLElement>(".session-details summary")!.click())
  const next = { ...session, id: "other-id", filePath: "/synthetic/other.jsonl" }
  vi.mocked(readSessionTranscript).mockResolvedValue({ ...transcript, session: next })
  await click("Open other transcript")
  const details = container.querySelector<HTMLDetailsElement>(".session-details")!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain("other-id")
  expect(details.textContent).toContain("/synthetic/other.jsonl")
})

it("announces empty and filtered-out transcripts as status changes", async () => {
  vi.mocked(readSessionTranscript).mockResolvedValue({ ...transcript, entries: [] })
  await click("Open transcript")
  expect(container.querySelector('[role="status"].transcript-state')?.textContent).toContain(
    "There are no transcript entries yet",
  )

  vi.mocked(readSessionTranscript).mockResolvedValue(transcript)
  await click("Open transcript")
  await act(async () => root.render(<Harness hideSearchedEntries />))
  await searchFor("needle")
  expect(container.querySelector('[role="status"].transcript-state')?.textContent).toContain(
    "No matches in the selected transcript content",
  )
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

it("reindexes rendered and source text without shifting Unicode highlights or selection", async () => {
  const source = "😀**K** [k](local://k.txt)"
  vi.mocked(readSessionTranscript).mockResolvedValue({
    ...transcript,
    entries: [{ ...transcript.entries[0], text: source, dialogueText: source }],
  })
  await click("Reread file")
  await searchFor("k")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 2")
  expect(currentOccurrence()?.textContent).toBe("K")
  expect(currentOccurrence()?.closest("strong")).not.toBeNull()
  await click("Previous match")
  expect(currentOccurrence()?.dataset.matchIndex).toBe("1")
  expect(currentOccurrence()?.closest("a")?.getAttribute("href")).toBe("local://k.txt")

  await click("Source")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 3")
  const pre = container.querySelector<HTMLElement>("pre.markdown-source")!
  expect(pre.textContent).toBe(source)
  const marks = Array.from(pre.querySelectorAll("mark"))
  expect(marks.map((mark) => [mark.dataset.matchIndex, mark.textContent])).toEqual([
    ["0", "K"],
    ["1", "k"],
    ["2", "k"],
  ])
  expect(marks[0].previousSibling?.textContent).toBe("😀**")
  expect(marks[0].nextSibling?.textContent).toBe("** [")
  expect(marks[1].nextSibling?.textContent).toBe("](local://")
  expect(marks[2].nextSibling?.textContent).toBe(".txt)")
  const range = document.createRange()
  range.selectNodeContents(pre)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  expect(window.getSelection()!.toString()).toBe(source)
  window.getSelection()!.removeAllRanges()

  await click("Previous match")
  expect(currentOccurrence()?.dataset.matchIndex).toBe("2")
  await click("Next match")
  expect(currentOccurrence()?.dataset.matchIndex).toBe("0")
  await click("Formatted")
  expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe("1 / 2")
  expect(currentOccurrence()?.textContent).toBe("K")
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

it("keeps native copy available when a selected file link crosses the transcript boundary", async () => {
  await searchFor("needle")
  await click("Previous match")
  const link = currentOccurrence()!.closest("a")!
  const outside = document.createElement("p")
  outside.textContent = "selection beyond the virtual viewport"
  document.body.appendChild(outside)
  try {
    const range = document.createRange()
    range.setStart(link, 0)
    range.setEnd(outside.firstChild!, outside.textContent.length)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const down = new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true })
    act(() => link.dispatchEvent(down))
    expect(down.defaultPrevented).toBe(true)
    const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    act(() => link.dispatchEvent(context))
    expect(context.defaultPrevented).toBe(false)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  } finally {
    outside.remove()
  }
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

it("clears a focused transcript query on Escape before Escape closes the reader", async () => {
  await searchFor("needle")
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
  act(() => input.focus())
  const clear = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  await act(async () => input.dispatchEvent(clear))
  expect(clear.defaultPrevented).toBe(true)
  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  expect(input.value).toBe("")
  expect(document.activeElement).toBe(input)

  const close = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  await act(async () => input.dispatchEvent(close))
  expect(close.defaultPrevented).toBe(true)
  expect(container.querySelector('[role="dialog"]')).toBeNull()
})

it("reaches the bottom of an oversized final message on Latest and a direct read", async () => {
  rowHeights.set(179, 1400)
  await click("Latest message")
  let scroll = container.querySelector<HTMLElement>(".transcript-scroll")!
  expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight)
  rowHeights.set(179, 2200)
  await resizeTo(viewportWidth)
  expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight)
  expect(
    container
      .querySelector<HTMLElement>('article[data-virtual-index="179"]')!
      .getBoundingClientRect().bottom,
  ).toBe(480)
  const readingTop = scroll.scrollTop - 250
  await scrollTo(readingTop)
  rowHeights.set(179, 3000)
  await resizeTo(viewportWidth)
  expect(scroll.scrollTop).toBe(readingTop)

  await click("Close")
  rowHeights.set(178, 1400)
  await click("Read current transcript")
  scroll = container.querySelector<HTMLElement>(".transcript-scroll")!
  expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight)
  expect(
    container
      .querySelector<HTMLElement>('article[data-virtual-index="178"]')!
      .getBoundingClientRect().bottom,
  ).toBe(480)
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

it("navigates and wraps a million-match entry with bounded replacement windows through reindex and clear", async () => {
  const text = "x".repeat(1_000_000)
  const dense = {
    ...transcript,
    entries: [{ ...transcript.entries[0], text, dialogueText: text }],
  }
  rowHeights.set(0, 1200)
  vi.mocked(readSessionTranscript).mockResolvedValue(dense)
  await click("Open transcript")
  await searchFor("x")
  const expectWindow = (index: number) => {
    expect(container.querySelector('[aria-label="Matches"]')?.textContent).toBe(
      `${index + 1} / 1000000`,
    )
    const marks = container.querySelectorAll("mark[data-match-index]")
    expect(marks.length).toBeGreaterThan(0)
    expect(marks.length).toBeLessThanOrEqual(SEARCH_HIGHLIGHT_LIMIT)
    const current = currentOccurrence()!
    expect(current?.dataset.matchIndex).toBe(String(index))
    expect(current?.textContent).toBe("x")
    let precedingLength = 0
    for (let sibling = current.previousSibling; sibling; sibling = sibling.previousSibling) {
      precedingLength += sibling.textContent?.length ?? 0
    }
    expect(precedingLength).toBe(index)
    expect(container.querySelector(".markdown-content")?.textContent).toBe(text)
    if (index === 999_999) expect(container.querySelector('mark[data-match-index="0"]')).toBeNull()
    if (index === 0) expect(container.querySelector('mark[data-match-index="999999"]')).toBeNull()
  }
  expectWindow(0)
  for (let repeat = 0; repeat < 2; repeat++) {
    await click("Previous match")
    expectWindow(999_999)
    await click("Next match")
    expectWindow(0)
    await click("Next match")
    expectWindow(1)
    await click("Previous match")
    expectWindow(0)
  }
  await click("Previous match")
  expectWindow(999_999)
  await click("Source")
  expectWindow(0)
  await click("Previous match")
  expectWindow(999_999)
  await click("Formatted")
  expectWindow(0)
  await searchFor("X")
  expectWindow(0)
  await click("Previous match")
  expectWindow(999_999)
  vi.mocked(readSessionTranscript).mockResolvedValue({ ...dense, updatedAt: 2 })
  await click("Reread file")
  expectWindow(0)
  await click("Copy text")
  expect(writeText).toHaveBeenLastCalledWith(text)
  await click("Copy Markdown")
  expect(writeText).toHaveBeenLastCalledWith(text)
  await searchFor("")
  expect(container.querySelector("mark")).toBeNull()
  expect(container.querySelector(".markdown-content")?.textContent).toBe(text)
  await searchFor("x")
  expectWindow(0)
})

it("jumps to an unmounted user message after search and keeps subsequent manual reading", async () => {
  const entries = transcript.entries.map((entry, index) => ({
    ...entry,
    role: index === 40 || index === 120 ? "user" : "assistant",
  }))
  vi.mocked(readSessionTranscript).mockResolvedValue({ ...transcript, entries })
  await click("Reread file")
  await searchFor("needle")
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Select a user message"]')!
  expect(select.options.length).toBe(3)
  const choose = async () => {
    await act(async () => {
      select.focus()
      select.value = "entry-40"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await flushFrames()
    expect(select.value).toBe("entry-40")
    await click("Go to message")
  }
  await choose()
  expect(readingRow().dataset.virtualIndex).toBe("40")
  expect(select.isConnected).toBe(true)
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe("")
  await scrollTo(60 * 102)
  expect(readingRow().dataset.virtualIndex).toBe("60")
  await click("Latest message")
  await choose()
  expect(readingRow().dataset.virtualIndex).toBe("40")
  await searchFor("needle")
  expect(currentOccurrence()).not.toBeNull()
})

it("disables the user-message outline when there are no loaded user entries", () => {
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Select a user message"]')!
  expect(select.disabled).toBe(true)
  expect(select.options.length).toBe(1)
})

it("retains native selection without moving the reader until the explicit Go action", async () => {
  vi.mocked(readSessionTranscript).mockResolvedValue({
    ...transcript,
    entries: transcript.entries.map((entry) => ({ ...entry, role: "user" })),
  })
  await click("Reread file")
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Select a user message"]')!
  expect(select.options.length).toBe(101)
  expect(container.textContent).toContain("The list shows the first 100 user messages")
  await act(async () => {
    select.value = "entry-40"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await flushFrames()
  expect(select.value).toBe("entry-40")
  expect(readingRow().dataset.virtualIndex).toBe("0")
  await act(async () => {
    select.value = "entry-41"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  expect(select.value).toBe("entry-41")
  expect(readingRow().dataset.virtualIndex).toBe("0")
  await click("Go to message")
  expect(readingRow().dataset.virtualIndex).toBe("41")
})

it.each(["same-turn", "before-animation-frame"])(
  "does not replay a %s jump after refresh replaces its snapshot",
  async (timing) => {
    const snapshot = {
      ...transcript,
      entries: transcript.entries.map((entry, index) => ({
        ...entry,
        role: index === 40 ? "user" : "assistant",
      })),
    }
    vi.mocked(readSessionTranscript).mockResolvedValue(snapshot)
    await click("Reread file")
    await scrollTo(60 * 102)
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Select a user message"]',
    )!
    await act(async () => {
      select.value = "entry-40"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    let finish!: (value: SessionTranscript) => void
    vi.mocked(readSessionTranscript).mockImplementationOnce(
      () =>
        new Promise<SessionTranscript>((resolve) => {
          finish = resolve
        }),
    )
    const go = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Go to message",
    )!
    const refresh = container.querySelector<HTMLButtonElement>('[title="Reread file"]')!
    if (timing === "before-animation-frame") {
      await act(async () => go.click())
      expect(frames.size).toBeGreaterThan(0)
      await act(async () => refresh.click())
    } else {
      await act(async () => {
        go.click()
        refresh.click()
      })
    }
    expect(select.isConnected).toBe(false)
    expect(container.querySelector('[aria-label="Select a user message"]')).toBeNull()
    await act(async () => {
      finish({
        ...snapshot,
        updatedAt: 2,
        entries: snapshot.entries.map((entry, index) =>
          index === 40 ? { ...entry, id: "replacement-40" } : entry,
        ),
      })
    })
    await flushFrames()
    const refreshedSelect = container.querySelector<HTMLSelectElement>(
      '[aria-label="Select a user message"]',
    )!
    expect(refreshedSelect).not.toBe(select)
    expect(refreshedSelect.disabled).toBe(false)
    expect(readingRow().dataset.virtualIndex).toBe("60")
  },
)

it("cancels an unsettled jump on direct snapshot replacement without preservePosition", async () => {
  const first = {
    ...transcript,
    entries: transcript.entries.map((entry, index) => ({
      ...entry,
      role: index === 40 ? "user" : "assistant",
    })),
  }
  const renderSnapshot = (value: SessionTranscript) => {
    root.render(
      <TranscriptModal
        lang="en"
        transcriptSession={session}
        transcript={value}
        transcriptLoading={false}
        transcriptError={null}
        transcriptSearch=""
        transcriptMode="dialogue"
        launching={null}
        runtimeAvailable
        visibleEntries={value.entries}
        onClose={() => undefined}
        onRefresh={() => undefined}
        onError={() => undefined}
        onReread={() => undefined}
        onSearchChange={() => undefined}
        onClearSearch={() => undefined}
        onModeChange={() => undefined}
      />,
    )
  }
  await act(async () => renderSnapshot(first))
  await flushFrames()
  await scrollTo(60 * 102)
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Select a user message"]')!
  await act(async () => {
    select.value = "entry-40"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  const go = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Go to message",
  )!
  await act(async () => go.click())
  expect(frames.size).toBeGreaterThan(0)
  await act(async () =>
    renderSnapshot({
      ...first,
      updatedAt: 2,
      entries: first.entries.map((entry, index) =>
        index === 40 ? first.entries[100] : index === 100 ? first.entries[40] : entry,
      ),
    }),
  )
  await flushFrames()
  // The first jump already moved the viewport. Cancellation must not chase the
  // old entry ID to its new location in the replacement snapshot.
  expect(readingRow().dataset.virtualIndex).toBe("40")
  expect(select.value).toBe("entry-40")
  await scrollTo(60 * 102)
  expect(readingRow().dataset.virtualIndex).toBe("60")
})
it("copies the loaded dialogue beyond the mounted rows, excluding service text", async () => {
  expect(container.querySelectorAll("article").length).toBeLessThan(transcript.entries.length)
  expect(container.textContent).not.toContain("Message 179")
  await click("Copy loaded dialogue (Markdown)")
  const copied = vi.mocked(writeText).mock.calls.at(-1)![0]
  expect(copied).toContain("  selected\ntext  ")
  expect(copied).toContain("Message 179")
  expect(copied).not.toContain("context")
  expect(copied).toContain("This is not a complete session export.")
  expect(copied).not.toContain(session.filePath)
  expect(readSessionTranscript).toHaveBeenCalledTimes(1)
})

it("copies the same loaded dialogue after search, display and service-filter changes", async () => {
  await click("Copy loaded dialogue (Markdown)")
  const original = vi.mocked(writeText).mock.calls.at(-1)![0]
  await searchFor("nothing-matches-this")
  await click("Source")
  await click("Dialogue only")
  await click("Copy loaded dialogue (Markdown)")
  expect(vi.mocked(writeText).mock.calls.at(-1)![0]).toBe(original)
})

it("does not offer a loaded-dialogue copy during refresh or after a failed read", async () => {
  let rejectRead!: (reason: unknown) => void
  vi.mocked(readSessionTranscript).mockReturnValueOnce(
    new Promise((_, reject) => {
      rejectRead = reject
    }),
  )
  await click("Reread file")
  expect(container.querySelector('[aria-label="Copy loaded dialogue (Markdown)"]')).toBeNull()
  await act(async () => rejectRead(new Error("synthetic read failure")))
  expect(container.querySelector('[aria-label="Copy loaded dialogue (Markdown)"]')).toBeNull()
  expect(writeText).not.toHaveBeenCalled()
})

it("does not offer a copy for service-only transcripts", async () => {
  vi.mocked(readSessionTranscript).mockResolvedValueOnce({
    ...transcript,
    entries: transcript.entries.map((entry) => ({ ...entry, dialogueText: null })),
  })
  await click("Reread file")
  expect(container.querySelector('[aria-label="Copy loaded dialogue (Markdown)"]')).toBeNull()
  expect(writeText).not.toHaveBeenCalled()
})

it("waits for the clipboard response and prevents repeated copy while pending", async () => {
  let complete!: () => void
  vi.mocked(writeText).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      complete = resolve
    }),
  )
  await click("Copy loaded dialogue (Markdown)")
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Copy loaded dialogue (Markdown)"]',
  )!
  expect(button.disabled).toBe(true)
  expect(button.textContent).toBe("Copying…")
  await act(async () => button.click())
  expect(writeText).toHaveBeenCalledTimes(1)
  await act(async () => complete())
  expect(button.disabled).toBe(false)
  expect(button.textContent).toBe("Copied")
})

it("does not apply an old clipboard response to a different transcript", async () => {
  let complete!: () => void
  vi.mocked(writeText).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      complete = resolve
    }),
  )
  await click("Copy loaded dialogue (Markdown)")
  const other = {
    ...transcript,
    session: { ...session, filePath: `${session.filePath}.other` },
    entries: [{ ...transcript.entries[0], dialogueText: "Other session" }],
  }
  vi.mocked(readSessionTranscript).mockResolvedValueOnce(other)
  await click("Open other transcript")
  await act(async () => complete())
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Copy loaded dialogue (Markdown)"]',
  )!
  expect(button.textContent).toBe("Copy loaded dialogue (Markdown)")
  expect(writeText).toHaveBeenCalledTimes(1)
  await click("Copy loaded dialogue (Markdown)")
  expect(vi.mocked(writeText).mock.calls.at(-1)![0]).toContain("Other session")
  expect(vi.mocked(writeText).mock.calls.at(-1)![0]).not.toContain("Message 179")
})

it("explains the clipboard and privacy scope before copying", () => {
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Copy loaded dialogue (Markdown)"]',
  )!
  const hint = document.getElementById(button.getAttribute("aria-describedby")!)!
  expect(hint.textContent).toContain("system clipboard")
  expect(hint.textContent).toContain("private data")
  expect(hint.textContent).toContain("Search and display filters do not limit the copy")
  expect(writeText).not.toHaveBeenCalled()
})

it("refuses oversized dialogue without dispatching a clipboard request", async () => {
  vi.mocked(readSessionTranscript).mockResolvedValueOnce({
    ...transcript,
    entries: [{ ...transcript.entries[0], dialogueText: "x".repeat(4 * 1024 * 1024) }],
  })
  await click("Reread file")
  expect(container.querySelector('[aria-label="Copy loaded dialogue (Markdown)"]')).toBeNull()
  expect(container.querySelector(".transcript-copy-action [role=status]")?.textContent).toContain(
    "too large",
  )
  expect(writeText).not.toHaveBeenCalled()
})

it.each([
  ["another session", "resolve"],
  ["another session", "reject"],
  ["a refreshed snapshot", "resolve"],
  ["a refreshed snapshot", "reject"],
])(
  "ignores old clipboard feedback after %s with identical content (%s)",
  async (context, outcome) => {
    const onError = vi.fn()
    const render = async (value: SessionTranscript) => {
      await act(async () =>
        root.render(
          <TranscriptModal
            lang="en"
            transcriptSession={value.session}
            transcript={value}
            transcriptLoading={false}
            transcriptError={null}
            transcriptSearch=""
            transcriptMode="all"
            launching={null}
            runtimeAvailable
            visibleEntries={value.entries}
            onClose={() => undefined}
            onRefresh={() => undefined}
            onReread={() => undefined}
            onError={onError}
            onSearchChange={() => undefined}
            onClearSearch={() => undefined}
            onModeChange={() => undefined}
          />,
        ),
      )
      await flushFrames()
    }
    await render(transcript)
    let settle!: () => void
    vi.mocked(writeText).mockReturnValueOnce(
      new Promise<void>((resolve, reject) => {
        settle =
          outcome === "resolve"
            ? resolve
            : () => reject(new Error("old synthetic clipboard failure"))
      }),
    )
    await click("Copy loaded dialogue (Markdown)")
    await render({
      ...transcript,
      session:
        context === "another session"
          ? { ...session, filePath: `${session.filePath}.other` }
          : session,
    })
    await act(async () => settle())
    expect(onError).not.toHaveBeenCalled()
    expect(
      container.querySelector('[aria-label="Copy loaded dialogue (Markdown)"]')?.textContent,
    ).toBe("Copy loaded dialogue (Markdown)")
    expect(writeText).toHaveBeenCalledTimes(1)
  },
)

it("preserves reader actions after an offscreen Markdown failure", async () => {
  const source = "> ".repeat(8000) + "UNIQUE_FALLBACK_NEEDLE"
  const entries = transcript.entries.map((entry, index) =>
    index === 120 ? { ...entry, text: source, dialogueText: source } : entry,
  )
  vi.mocked(readSessionTranscript).mockResolvedValue({ ...transcript, entries })
  await click("Reread file")
  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  expect(container.querySelector('[data-virtual-index="120"]')).toBeNull()
  await searchFor("UNIQUE_FALLBACK_NEEDLE")
  expect(currentOccurrence()?.textContent).toBe("UNIQUE_FALLBACK_NEEDLE")
  expect(container.querySelector('[data-virtual-index="120"] .markdown-source')?.textContent).toBe(
    source,
  )
  const failedEntry = container.querySelector<HTMLElement>('[data-virtual-index="120"]')!
  const copyText = failedEntry.querySelector<HTMLButtonElement>('[aria-label="Copy text"]')!
  const copyMarkdown = failedEntry.querySelector<HTMLButtonElement>('[aria-label="Copy Markdown"]')!
  await act(async () => copyText.click())
  expect(writeText).toHaveBeenLastCalledWith(source)
  await act(async () => copyMarkdown.click())
  expect(writeText).toHaveBeenLastCalledWith(source)
  await click("Source")
  expect(container.querySelector('[data-virtual-index="120"] .markdown-source')?.textContent).toBe(
    source,
  )
  await click("Formatted")
  expect(currentOccurrence()?.textContent).toBe("UNIQUE_FALLBACK_NEEDLE")
  await click("Close")
  expect(container.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector("button")?.textContent).toBe("Open transcript")
})
