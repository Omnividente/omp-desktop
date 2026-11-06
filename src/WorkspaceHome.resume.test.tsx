/** @vitest-environment jsdom */
import { act, type ComponentProps } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { WorkspaceHome } from "./WorkspaceHome"
import type { SessionSummary } from "./types"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function session(id: string, updatedAt: number): SessionSummary {
  return {
    id,
    title: `Synthetic ${id}`,
    pinnedTitle: null,
    cwd: "/synthetic",
    projectKey: "/synthetic",
    filePath: `/synthetic/${id}.jsonl`,
    parentSessionPath: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt,
    model: null,
    thinkingLevel: null,
    configuredThinkingLevel: null,
    source: "omp",
    hasMessages: true,
    primaryProviderPinned: false,
  }
}

it.each(["en", "ru"] as const)("labels the Home resume target without changing it (%s)", (lang) => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const latest = session("latest", 2)
  const older = session("older", 1)
  const props: ComponentProps<typeof WorkspaceHome> = {
    primaryActionRef: { current: null },
    workspace: {
      key: "/synthetic",
      path: "/synthetic",
      name: "Synthetic",
      sessionCount: 2,
      lastActive: 2,
      pinned: false,
    },
    sessions: [latest, older],
    selectedSession: older,
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
    onLaunch: vi.fn(),
    onReadTranscript: vi.fn(),
    onError: vi.fn(),
    onReveal: vi.fn(),
    onOpenFolder: vi.fn(),
  }
  const resume = () => container.querySelector<HTMLButtonElement>(".hero-actions .secondary")!
  try {
    act(() => root.render(<WorkspaceHome {...props} />))
    act(() => resume().click())
    expect(props.onLaunch).toHaveBeenCalledExactlyOnceWith(older)
    expect(resume().textContent).toBe(lang === "en" ? "Resume selected" : "Продолжить выбранную")

    for (const selectedSession of [null, { ...latest }]) {
      act(() => root.render(<WorkspaceHome {...props} selectedSession={selectedSession} />))
      expect(resume().textContent).toBe(lang === "en" ? "Resume last" : "Продолжить последнюю")
      act(() => resume().click())
      expect(props.onLaunch).toHaveBeenLastCalledWith(latest)
    }
    act(() => root.render(<WorkspaceHome {...props} sessions={[]} selectedSession={null} />))
    expect(resume()).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
