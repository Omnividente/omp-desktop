import { describe, expect, it } from "vitest"
import type { SessionSummary, TerminalTab } from "./types"
import { normalizedPath, tabMatchesSession } from "./uiUtils"

const session: SessionSummary = {
  id: "session-42",
  title: "Path matching",
  pinnedTitle: null,
  cwd: "C:\\Work\\OMP",
  projectKey: "c:/work/omp",
  filePath: "C:\\Users\\Omniv\\.omp\\sessions\\session-42.jsonl",
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: 1_753_444_800_000,
  model: null,
  thinkingLevel: null,
  configuredThinkingLevel: null,
  source: "omp",
  hasMessages: true,
}

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: "tab-1",
    label: "Session",
    pinnedTitle: null,
    cwd: "C:\\Work\\OMP",
    processId: 1234,
    sessionId: null,
    sessionPath: null,
    status: "running",
    activity: "idle",
    exitCode: null,
    success: null,
    kind: "agent",
    switching: false,
    ...overrides,
  }
}

describe("normalizedPath", () => {
  it("normalizes Windows separators, case, and trailing separators", () => {
    expect(normalizedPath("C:\\Users\\Omniv\\Project\\\\", "windows")).toBe(
      "c:/users/omniv/project",
    )
  })

  it("preserves case on non-Windows platforms", () => {
    expect(normalizedPath("/Users/Omniv/Project/", "macos")).toBe("/Users/Omniv/Project")
  })
})

describe("tabMatchesSession", () => {
  it("matches the session id independently of the stored path", () => {
    const tab = terminalTab({
      sessionId: session.id,
      sessionPath: "C:\\Other\\session.jsonl",
    })

    expect(tabMatchesSession(tab, session, "windows")).toBe(true)
  })

  it("matches a Windows session path across case, separators, and trailing slashes", () => {
    const tab = terminalTab({
      sessionId: "stale-session-id",
      sessionPath: "c:/users/OMNIV/.omp/sessions/session-42.jsonl/",
    })

    expect(tabMatchesSession(tab, session, "windows")).toBe(true)
  })

  it("rejects a tab when neither id nor normalized path matches", () => {
    const tab = terminalTab({
      sessionId: "another-session",
      sessionPath: "C:\\Users\\Omniv\\.omp\\sessions\\another.jsonl",
    })

    expect(tabMatchesSession(tab, session, "windows")).toBe(false)
  })
})
