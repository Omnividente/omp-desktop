/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { SessionList, type SessionListProps } from "./SessionList"
import type { SessionSummary } from "./types"
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
const noop = () => undefined
function data(n: number, chain = false): SessionSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    title: `Session ${i}`,
    pinnedTitle: null,
    cwd: "/synthetic",
    projectKey: "/synthetic",
    filePath: `/synthetic/${i}.jsonl`,
    parentSessionPath: chain && i > 0 ? `/synthetic/${i - 1}.jsonl` : null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: i + 1,
    model: null,
    thinkingLevel: null,
    configuredThinkingLevel: null,
    source: "omp",
    hasMessages: true,
    primaryProviderPinned: false,
  }))
}
function props(sessions: SessionSummary[], search = ""): SessionListProps {
  return {
    allSessions: sessions,
    visibleSessions: search ? sessions.filter((s) => s.id === "s0") : sessions,
    workspaceSessionsCount: sessions.length,
    lang: "en",
    search,
    onSearchChange: noop,
    onClearSearch: noop,
    selectedSessionId: null,
    launching: null,
    renamingSessionId: null,
    renameValue: "",
    deletingSessionId: null,
    tabs: [],
    platform: "linux",
    onSelectSession: noop,
    onLaunchSession: noop,
    onNewSession: noop,
    onLoadTranscript: noop,
    onStartRename: noop,
    onToggleTitlePin: noop,
    onDeleteSession: noop,
    onSubmitRename: noop,
    onRenameValueChange: noop,
    onRenameKeyDown: noop,
    onOpenCodex: noop,
    onImportOmp: noop,
    onRevealWorkspace: noop,
    selectedWorkspacePath: "/synthetic",
    selectedWorkspaceName: "Synthetic",
    canLaunch: true,
  }
}

it("reuses fixed-row layout during scroll and still invalidates changed session data", async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id)
  })
  const scroll = async (el: HTMLElement, y: number) => {
    await act(async () => {
      el.scrollTop = y
      el.dispatchEvent(new Event("scroll"))
      expect(frames.size).toBe(1)
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(performance.now())
    })
  }
  let reads = 0
  const sessions = data(10000).map((session) => {
    const id = session.id
    return {
      ...session,
      get id() {
        reads += 1
        return id
      },
    }
  })
  const div = document.createElement("div")
  document.body.append(div)
  const root = createRoot(div)
  try {
    await act(async () => root.render(<SessionList {...props(sessions)} />))
    const list = div.querySelector<HTMLElement>(".session-list")!
    expect(div.querySelector(".session-select")?.getAttribute("aria-label")).toBe("Session 9999")
    reads = 0
    await scroll(list, 570)
    expect(div.querySelector(".session-select")?.getAttribute("aria-label")).toBe("Session 9997")
    // Counts include actual row rendering; layout must not walk all 10,000 keys.
    expect(reads).toBeLessThan(1000)
    expect(div.querySelectorAll(".session-item").length).toBeLessThanOrEqual(26)
    reads = 0
    await scroll(list, 1140)
    expect(div.querySelector(".session-select")?.getAttribute("aria-label")).toBe("Session 9987")
    expect(reads).toBeLessThan(1000)
    await act(async () => root.render(<SessionList {...props(sessions, "s0")} />))
    await scroll(list, 0)
    expect(div.querySelectorAll(".session-item")).toHaveLength(1)
    expect(div.textContent).toContain("Session 0")
    const replacement = data(2).map((session) => ({
      ...session,
      title: `Replacement ${session.id}`,
    }))
    await act(async () => root.render(<SessionList {...props(replacement)} />))
    expect(div.querySelectorAll(".session-item")).toHaveLength(2)
    expect(div.textContent).toContain("Replacement s1")
    expect(div.textContent).not.toContain("Session 0")
  } finally {
    await act(async () => root.unmount())
    div.remove()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  }
})
