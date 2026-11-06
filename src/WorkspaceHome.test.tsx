/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { WorkspaceHome } from "./WorkspaceHome"
import type { SessionSummary } from "./types"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function session(id: string): SessionSummary {
  return {
    id,
    title: `Synthetic ${id}`,
    pinnedTitle: null,
    cwd: "/synthetic",
    projectKey: "/synthetic",
    filePath: `/synthetic/${id}.jsonl`,
    parentSessionPath: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: 1,
    model: null,
    thinkingLevel: null,
    configuredThinkingLevel: null,
    source: "omp",
    hasMessages: true,
    primaryProviderPinned: false,
  }
}

it("keeps each recent read target separate from resume and limits both to four cards", () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const read = vi.fn(),
    launch = vi.fn()
  const sessions = ["one", "two", "three", "four", "five"].map(session)
  const props = {
    primaryActionRef: { current: null },
    workspace: {
      key: "/synthetic",
      path: "/synthetic",
      name: "Synthetic",
      sessionCount: 5,
      lastActive: 1,
      pinned: false,
    },
    sessions,
    selectedSession: sessions[4],
    runtime: {
      platform: "linux",
      arch: "x64",
      language: "en",
      ompAvailable: true,
      ompExecutable: "omp",
      ompVersion: null,
      sessionRoot: "/synthetic",
    },
    launching: null,
    lang: "en" as const,
    onLaunch: launch,
    onError: vi.fn(),
    onReadTranscript: read,
    onReveal: vi.fn(),
    onOpenFolder: vi.fn(),
  }
  try {
    act(() => root.render(<WorkspaceHome {...props} />))
    const reads = container.querySelectorAll<HTMLButtonElement>(".recent-read")
    expect(reads).toHaveLength(4)
    expect(container.querySelectorAll(".recent-resume")).toHaveLength(4)
    reads.forEach((button, index) => {
      expect(button.textContent).toContain("Read")
      expect(button.getAttribute("aria-label")).toContain(sessions[index].title)
      expect(button.parentElement?.tagName).toBe("DIV")
      act(() => button.click())
      expect(read).toHaveBeenLastCalledWith(sessions[index].filePath)
    })
    expect(launch).not.toHaveBeenCalled()
    act(() => container.querySelector<HTMLButtonElement>(".recent-resume")!.click())
    expect(launch).toHaveBeenCalledExactlyOnceWith(sessions[0])
    expect(read).toHaveBeenCalledTimes(4)
    act(() => root.render(<WorkspaceHome {...props} sessions={[]} selectedSession={null} />))
    expect(container.querySelector(".recent-read")).toBeNull()
    expect(container.textContent).toContain("No sessions")
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it.each(["en", "ru"] as const)(
  "blocks recent resumes during unavailable launches without blocking history (%s)",
  (lang) => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const sessions = ["one", "two"].map(session)
    const launch = vi.fn()
    const read = vi.fn()
    const props = {
      primaryActionRef: { current: null },
      workspace: {
        key: "/synthetic",
        path: "/synthetic",
        name: "Synthetic",
        sessionCount: 2,
        lastActive: 1,
        pinned: false,
      },
      sessions,
      selectedSession: null,
      runtime: {
        platform: "linux",
        arch: "x64",
        language: lang,
        ompAvailable: true,
        ompExecutable: "omp",
        ompVersion: null,
        sessionRoot: "/synthetic",
      },
      launching: null,
      lang,
      onLaunch: launch,
      onError: vi.fn(),
      onReadTranscript: read,
      onReveal: vi.fn(),
      onOpenFolder: vi.fn(),
    }
    try {
      for (const [launching, ompAvailable] of [
        ["one", true],
        ["new", true],
        [null, false],
        ["one", false],
      ] as const) {
        act(() =>
          root.render(
            <WorkspaceHome
              {...props}
              launching={launching}
              runtime={{ ...props.runtime, ompAvailable }}
            />,
          ),
        )
        const resumes = container.querySelectorAll<HTMLButtonElement>(".recent-resume")
        const reads = container.querySelectorAll<HTMLButtonElement>(".recent-read")
        expect(resumes).toHaveLength(2)
        resumes.forEach((button) => {
          expect(button.disabled).toBe(true)
          act(() => button.click())
        })
        expect(launch).not.toHaveBeenCalled()
        reads.forEach((button, index) => {
          expect(button.disabled).toBe(false)
          act(() => button.click())
          expect(read).toHaveBeenLastCalledWith(sessions[index].filePath)
        })
      }
      act(() => root.render(<WorkspaceHome {...props} />))
      const resumed = container.querySelectorAll<HTMLButtonElement>(".recent-resume")[1]
      expect(resumed.disabled).toBe(false)
      act(() => resumed.click())
      expect(launch).toHaveBeenCalledExactlyOnceWith(sessions[1])
      expect(read).toHaveBeenCalledTimes(8)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  },
)
