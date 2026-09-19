/** @vitest-environment jsdom */
import { act, useLayoutEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { readSessionTranscript } from "./api"
import { useTranscript, type TranscriptState } from "./useTranscript"
import type { SessionTranscript } from "./types"

vi.mock("./api", () => ({
  readSessionTranscript: vi.fn(),
  errorMessage: (error: unknown) => String(error),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let state: TranscriptState
let root: Root
let container: HTMLDivElement
function Harness() {
  const current = useTranscript("en")
  useLayoutEffect(() => {
    state = current
  }, [current])
  return current.transcriptSession ? (
    <section role="dialog">
      <h1>{current.transcriptSession.title}</h1>
      <span>{current.transcriptMode}</span>
      {current.visibleEntries.map((entry) => (
        <p key={entry.id}>{entry.text}</p>
      ))}
    </section>
  ) : null
}
function transcript(path: string): SessionTranscript {
  return {
    session: {
      id: path,
      title: path,
      filePath: path,
      cwd: "/project",
      projectKey: "project",
      pinnedTitle: null,
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
    entries: [],
    updatedAt: 1,
    truncated: false,
    malformedRecords: 0,
    incompleteLastRecord: false,
  }
}
function pendingRead() {
  let resolve!: (value: SessionTranscript) => void
  let reject!: (error: Error) => void
  const promise = new Promise<SessionTranscript>((done, fail) => {
    resolve = done
    reject = fail
  })
  vi.mocked(readSessionTranscript).mockReturnValueOnce(promise)
  return { resolve, reject }
}
beforeEach(() => {
  vi.resetAllMocks()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Harness />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it("does not reopen a reader closed while a direct-path read was pending", async () => {
  const read = pendingRead()
  let loading!: Promise<void>
  act(() => {
    loading = state.loadTranscriptPath("/a.jsonl")
  })
  act(() => state.closeTranscript())
  await act(async () => {
    read.resolve(transcript("/a.jsonl"))
    await loading
  })
  expect(container.querySelector('[role="dialog"]')).toBeNull()
})

it("keeps the newer reader open and reports only current direct-read errors", async () => {
  const obsolete = pendingRead()
  const errors = vi.fn()
  let first!: Promise<void>
  act(() => {
    first = state.loadTranscriptPath("/old.jsonl").catch(errors)
  })
  vi.mocked(readSessionTranscript).mockResolvedValueOnce(transcript("/new.jsonl"))
  await act(async () => state.loadTranscriptPath("/new.jsonl"))
  await act(async () => {
    obsolete.reject(new Error("obsolete"))
    await first
  })
  expect(container.querySelector("h1")?.textContent).toBe("/new.jsonl")
  expect(errors).not.toHaveBeenCalled()
  const failure = new Error("unreadable")
  vi.mocked(readSessionTranscript).mockRejectedValueOnce(failure)
  await act(async () => state.loadTranscriptPath("/missing.jsonl").catch(errors))
  expect(errors).toHaveBeenCalledWith(failure)
  expect(container.querySelector('[role="dialog"]')).toBeNull()
})

it("honors a sidebar open of the same path rather than the preceding pending direct read", async () => {
  const obsolete = pendingRead()
  let first!: Promise<void>
  act(() => {
    first = state.loadTranscriptPath("/a.jsonl")
  })
  const full = transcript("/a.jsonl")
  full.entries = [
    {
      id: "tool",
      timestamp: "2026-01-01",
      role: "tool",
      category: "service",
      text: "Service output",
      dialogueText: null,
    },
  ]
  vi.mocked(readSessionTranscript).mockResolvedValueOnce(full)
  await act(async () => state.loadTranscript(full.session))
  await act(async () => {
    obsolete.resolve(transcript("obsolete"))
    await first
  })
  expect(container.querySelector("h1")?.textContent).toBe("/a.jsonl")
  expect(container.textContent).toContain("Service output")
})
