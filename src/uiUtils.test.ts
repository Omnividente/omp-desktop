import { describe, expect, it } from "vitest"
import type { BootstrapPayload, SessionSummary, TerminalTab } from "./types"
import {
  buildSessionTree,
  extractSingleInstanceWorkspace,
  filterSessionTree,
  formatTerminalExitLine,
  flattenSessionTree,
  latestSessionInTree,
  mergeSessionIntoPayload,
  normalizedPath,
  replaceTerminalAfterRestart,
  sessionAncestorIds,
  sessionGroupExpansionIds,
  tabMatchesSession,
} from "./uiUtils"

const session: SessionSummary = {
  id: "session-42",
  title: "Path matching",
  pinnedTitle: null,
  cwd: "C:\\Work\\OMP",
  projectKey: "c:/work/omp",
  filePath: "C:\\Users\\Omniv\\.omp\\sessions\\session-42.jsonl",
  parentSessionPath: null,
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: 1_753_444_800_000,
  model: null,
  thinkingLevel: null,
  configuredThinkingLevel: null,
  source: "omp",
  hasMessages: true,
  primaryProviderPinned: false,
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
    switchRecovery: null,
    primaryProviderPinned: false,
    primaryProviderPinPending: false,
    ...overrides,
  }
}

describe("formatTerminalExitLine", () => {
  it("formats backend errors in the active UI language", () => {
    expect(
      formatTerminalExitLine(
        {
          terminalId: "terminal-1",
          exitCode: null,
          success: false,
          error: "connection failed",
        },
        "en",
      ),
    ).toBe("\r\n\x1b[38;2;239;112;112mOMP terminated: connection failed\x1b[0m\r\n")
  })

  it("formats successful exit codes in Russian", () => {
    expect(
      formatTerminalExitLine(
        {
          terminalId: "terminal-1",
          exitCode: 0,
          success: true,
          error: null,
        },
        "ru",
      ),
    ).toBe("\r\n\x1b[38;2;129;201;149mПроцесс OMP завершён · код 0\x1b[0m\r\n")
  })
})
describe("extractSingleInstanceWorkspace", () => {
  it("extracts path from --project flag", () => {
    expect(
      extractSingleInstanceWorkspace(["omp-desktop.exe", "--project", "D:\\Projects\\Test"]),
    ).toBe("D:\\Projects\\Test")
  })

  it("extracts path from --project= argument", () => {
    expect(extractSingleInstanceWorkspace(["omp-desktop", "--project=D:\\Projects\\Test"])).toBe(
      "D:\\Projects\\Test",
    )
  })

  it("extracts path from short -p flag", () => {
    expect(extractSingleInstanceWorkspace(["omp-desktop", "-p", "/home/user/code"])).toBe(
      "/home/user/code",
    )
  })

  it("extracts positional directory argument when flags are omitted", () => {
    expect(
      extractSingleInstanceWorkspace(["omp-desktop", "C:\\Users\\Omniv\\Projects\\MyApp"]),
    ).toBe("C:\\Users\\Omniv\\Projects\\MyApp")
  })

  it("supports the -- separator and ignores command flags", () => {
    expect(
      extractSingleInstanceWorkspace(["omp-desktop", "--verbose", "--", "/home/user/code"]),
    ).toBe("/home/user/code")
    expect(extractSingleInstanceWorkspace(["omp-desktop", "--verbose"])).toBeNull()
  })

  it("does not consume a missing flag value", () => {
    expect(extractSingleInstanceWorkspace(["omp-desktop", "--project", "--verbose"])).toBeNull()
  })

  it("returns null when no workspace argument is provided", () => {
    expect(extractSingleInstanceWorkspace(["omp-desktop.exe"])).toBeNull()
    expect(extractSingleInstanceWorkspace([])).toBeNull()
    expect(extractSingleInstanceWorkspace(undefined)).toBeNull()
  })
})

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

describe("mergeSessionIntoPayload", () => {
  it("keeps the live handoff session when bootstrap is stale", () => {
    const handoff: SessionSummary = {
      ...session,
      id: "session-handoff",
      title: "After handoff",
      filePath: "C:\\Users\\Omniv\\.omp\\sessions\\handoff.jsonl",
      updatedAt: session.updatedAt + 1,
    }
    const stalePayload = {
      settings: {},
      runtime: { platform: "windows" },
      workspaces: [],
      sessions: [session],
    } as unknown as BootstrapPayload

    const merged = mergeSessionIntoPayload(stalePayload, handoff, "windows")
    expect(merged.sessions.map((candidate) => candidate.id)).toEqual([
      "session-handoff",
      session.id,
    ])

    const replayed = mergeSessionIntoPayload({ ...merged, sessions: [session] }, handoff, "windows")
    expect(replayed.sessions.map((candidate) => candidate.id)).toEqual([
      "session-handoff",
      session.id,
    ])
  })
})

describe("replaceTerminalAfterRestart", () => {
  it("moves the tab to the replacement terminal and commits the pin", () => {
    const pending = terminalTab({
      id: "terminal-old",
      status: "exited",
      activity: "thinking",
      exitCode: 1,
      success: false,
      switching: true,
      primaryProviderPinPending: true,
    })

    expect(
      replaceTerminalAfterRestart(
        pending,
        "terminal-old",
        { terminalId: "terminal-new", processId: 4321, cwd: "C:\\Work\\OMP" },
        true,
      ),
    ).toMatchObject({
      id: "terminal-new",
      processId: 4321,
      status: "running",
      activity: "idle",
      exitCode: null,
      success: null,
      switching: false,
      switchRecovery: null,
      primaryProviderPinned: true,
      primaryProviderPinPending: false,
    })
  })

  it("leaves unrelated tabs unchanged", () => {
    const tab = terminalTab({ id: "terminal-other" })
    expect(
      replaceTerminalAfterRestart(
        tab,
        "terminal-old",
        { terminalId: "terminal-new", processId: 4321, cwd: tab.cwd },
        true,
      ),
    ).toBe(tab)
  })
})

describe("session lineage tree", () => {
  const lineageSession = (
    id: string,
    filePath: string,
    parentSessionPath: string | null,
    updatedAt: number,
  ): SessionSummary => ({
    ...session,
    id,
    title: id,
    filePath,
    parentSessionPath,
    updatedAt,
  })

  it("keeps the newest handoff session at root and orders groups by latest activity", () => {
    const archive = lineageSession("archive", "C:\\Sessions\\archive.jsonl", null, 100)
    const active = lineageSession("active", "C:\\Sessions\\active.jsonl", archive.filePath, 200)
    const grandchild = lineageSession(
      "grandchild",
      "C:\\Sessions\\grandchild.jsonl",
      active.filePath,
      400,
    )
    const unrelated = lineageSession("unrelated", "C:\\Sessions\\unrelated.jsonl", null, 300)

    const tree = buildSessionTree([archive, grandchild, unrelated, active], "windows")

    expect(tree.map((node) => node.session.id)).toEqual(["grandchild", "unrelated"])
    expect(tree[0].children.map((node) => node.session.id)).toEqual(["active"])
    expect(tree[0].children[0].children.map((node) => node.session.id)).toEqual(["archive"])
    expect(sessionAncestorIds(tree, "archive")).toEqual(["grandchild", "active"])
    expect(latestSessionInTree(tree[0]).id).toBe("grandchild")
  })

  it("links handoff lineage when parentSession contains a session id", () => {
    const archive = lineageSession("archive-id", "C:\\Sessions\\archive.jsonl", null, 100)
    const active = lineageSession("active-id", "C:\\Sessions\\active.jsonl", archive.id, 200)

    const tree = buildSessionTree([archive, active], "windows")

    expect(tree.map((node) => node.session.id)).toEqual(["active-id"])
    expect(tree[0].children.map((node) => node.session.id)).toEqual(["archive-id"])
  })

  it("expands the selected handoff root and archived ancestry", () => {
    const archive = lineageSession("archive", "C:\\Sessions\\archive.jsonl", null, 100)
    const active = lineageSession("active", "C:\\Sessions\\active.jsonl", archive.id, 200)
    const tree = buildSessionTree([archive, active], "windows")

    expect(sessionGroupExpansionIds(tree, "active")).toEqual(["active"])
    expect(sessionGroupExpansionIds(tree, "archive")).toEqual(["active"])
    expect(sessionGroupExpansionIds(tree, "missing")).toEqual([])
  })

  it("keeps branch archives unique while choosing the newest branch as parent", () => {
    const archive = lineageSession("archive", "C:\\Sessions\\archive.jsonl", null, 100)
    const olderActive = lineageSession(
      "older-active",
      "C:\\Sessions\\older-active.jsonl",
      archive.filePath,
      200,
    )
    const newestActive = lineageSession(
      "newest-active",
      "C:\\Sessions\\newest-active.jsonl",
      archive.filePath,
      300,
    )

    const tree = buildSessionTree([archive, olderActive, newestActive], "windows")
    const flattened = flattenSessionTree(tree, new Set(["newest-active"]))

    expect(tree.map((node) => node.session.id)).toEqual(["newest-active", "older-active"])
    expect(flattened.map((item) => item.session.id)).toEqual([
      "newest-active",
      "archive",
      "older-active",
    ])
  })

  it("flattens only expanded groups and auto-expands filtered ancestry", () => {
    const parent = lineageSession("parent", "C:\\Sessions\\parent.jsonl", null, 100)
    const child = lineageSession("child", "C:\\Sessions\\child.jsonl", parent.filePath, 200)
    const grandchild = lineageSession(
      "grandchild",
      "C:\\Sessions\\grandchild.jsonl",
      child.filePath,
      300,
    )
    const tree = buildSessionTree([grandchild, child, parent], "windows")

    expect(flattenSessionTree(tree, new Set()).map((item) => item.session.id)).toEqual([
      "grandchild",
    ])
    expect(
      flattenSessionTree(tree, new Set(["grandchild", "child"])).map((item) => item.session.id),
    ).toEqual(["grandchild", "child", "parent"])

    const filtered = filterSessionTree(tree, new Set(["parent"]))
    expect(flattenSessionTree(filtered, new Set(), true).map((item) => item.session.id)).toEqual([
      "grandchild",
      "child",
      "parent",
    ])
  })

  it("keeps orphaned and cyclic sessions at the root", () => {
    const orphan = lineageSession(
      "orphan",
      "C:\\Sessions\\orphan.jsonl",
      "C:\\Sessions\\missing.jsonl",
      300,
    )
    const first = lineageSession(
      "first",
      "C:\\Sessions\\first.jsonl",
      "C:\\Sessions\\second.jsonl",
      200,
    )
    const second = lineageSession(
      "second",
      "C:\\Sessions\\second.jsonl",
      "C:\\Sessions\\first.jsonl",
      100,
    )

    const tree = buildSessionTree([orphan, first, second], "windows")
    expect(tree.map((node) => node.session.id)).toEqual(["orphan", "first", "second"])
    expect(tree.every((node) => node.children.length === 0)).toBe(true)
  })
})
