/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { readSessionAnswers } from "./api"
import { CompletedAnswers } from "./CompletedAnswers"
import { applyRuntimeEventToTab } from "./runtimeEvents"
import type { PtyRuntimeEvent, SessionTranscript, TerminalTab } from "./types"

vi.mock("./api", () => ({
  readSessionAnswers: vi.fn(),
  openContentLink: vi.fn().mockResolvedValue(undefined),
  errorMessage: (error: unknown) => String(error),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function transcript(path: string, ...messages: string[]): SessionTranscript {
  return {
    session: {
      id: path,
      title: "Synthetic answers",
      pinnedTitle: null,
      cwd: "/tmp/project",
      projectKey: "project",
      filePath: path,
      parentSessionPath: null,
      createdAt: "2026-01-01",
      updatedAt: 1,
      model: null,
      thinkingLevel: null,
      configuredThinkingLevel: null,
      source: "test",
      hasMessages: true,
      primaryProviderPinned: false,
    },
    entries: messages.map((text, index) => ({
      id: `${path}-${index}`,
      timestamp: "2026-01-01",
      role: "assistant",
      text,
      dialogueText: text,
      category: "dialogue",
    })),
    updatedAt: 1,
    truncated: false,
    malformedRecords: 0,
    incompleteLastRecord: false,
  }
}
function event(activity: "thinking" | "idle"): PtyRuntimeEvent {
  return {
    terminalId: "terminal",
    kind: "activity",
    model: null,
    modelRole: null,
    thinkingLevel: null,
    configuredThinkingLevel: null,
    activity,
    errorMessage: null,
    fallbackFrom: null,
    fallbackTo: null,
    fallbackRole: null,
    resolvedModelIsFallback: null,
  }
}
const tab: TerminalTab = {
  id: "terminal",
  label: "Test",
  pinnedTitle: null,
  cwd: "/tmp/project",
  processId: 1,
  sessionId: "session",
  sessionPath: "/tmp/a.jsonl",
  status: "running",
  activity: "idle",
  exitCode: null,
  success: null,
  kind: "agent",
  switching: false,
  switchRecovery: null,
  primaryProviderPinned: false,
  primaryProviderPinPending: false,
}
let container: HTMLDivElement
let root: Root
const onError = vi.fn()

async function render(current = tab, active = true) {
  await act(async () => {
    root.render(
      <>
        <input aria-label="Draft" defaultValue="Unsent draft" />
        <CompletedAnswers
          key={current.sessionPath}
          sessionPath={current.sessionPath!}
          busy={current.activity === "thinking"}
          active={active}
          version={current.completedResponseVersion ?? 0}
          lang="en"
          onError={onError}
        />
      </>,
    )
  })
}
function button(label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find(
    (node) => node.getAttribute("aria-label") === label || node.textContent === label,
  )
  expect(result).toBeDefined()
  return result!
}

beforeEach(() => {
  vi.resetAllMocks()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it("opens a new answer after batched thinking/idle without reopening the old one or stealing focus", async () => {
  vi.mocked(readSessionAnswers).mockResolvedValue(transcript(tab.sessionPath!, "# First answer"))
  await render()
  await act(async () => button("Collapse answer").click())
  await render(tab, false)
  await render()
  expect(button("Show answer").getAttribute("aria-expanded")).toBe("false")

  const input = container.querySelector("input")!
  input.focus()
  vi.mocked(readSessionAnswers).mockResolvedValue(
    transcript(tab.sessionPath!, "# First answer", "## Second answer"),
  )
  // App reduces both events before React sees a tab; its final activity is still idle.
  const completed = [event("thinking"), event("idle")].reduce(applyRuntimeEventToTab, tab)
  await render(completed)
  expect(container.querySelector("h2")?.textContent).toBe("Second answer")
  expect(button("Collapse answer").getAttribute("aria-expanded")).toBe("true")
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe("Unsent draft")
  await act(async () => button("Previous answer").click())
  expect(container.querySelector("h1")?.textContent).toBe("First answer")
})

it("navigates from the current answer when a refresh and a click are batched", async () => {
  const path = tab.sessionPath!
  vi.mocked(readSessionAnswers).mockResolvedValueOnce(
    transcript(path, "# First answer", "# Second answer"),
  )
  await render()

  let resolveRefresh!: (value: SessionTranscript) => void
  vi.mocked(readSessionAnswers).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRefresh = resolve
    }),
  )
  await render({ ...tab, completedResponseVersion: 1 })
  await act(async () => {
    resolveRefresh(transcript(path, "# First answer", "# Second answer", "# Third answer"))
    await Promise.resolve()
    button("Previous answer").click()
  })
  expect(container.querySelector("h1")?.textContent).toBe("Second answer")
  await act(async () => button("Next answer").click())
  expect(container.querySelector("h1")?.textContent).toBe("Third answer")
})

it("ignores a pending read when work resumes and after switching sessions", async () => {
  let resolveOld!: (value: SessionTranscript) => void
  vi.mocked(readSessionAnswers).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve
    }),
  )
  await render()
  await render({ ...tab, activity: "thinking" })
  await act(async () => resolveOld(transcript(tab.sessionPath!, "# Stale answer")))
  expect(container.querySelector(".completed-answers")).toBeNull()

  let resolveInactive!: (value: SessionTranscript) => void
  vi.mocked(readSessionAnswers).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveInactive = resolve
    }),
  )
  await render()
  vi.mocked(readSessionAnswers).mockResolvedValueOnce(transcript("/tmp/b.jsonl", "# Other session"))
  await render({ ...tab, sessionPath: "/tmp/b.jsonl" })
  await act(async () => resolveInactive(transcript(tab.sessionPath!, "# Late old session")))
  expect(container.querySelector("h1")?.textContent).toBe("Other session")
  expect(container.textContent).not.toContain("Late old session")
})
