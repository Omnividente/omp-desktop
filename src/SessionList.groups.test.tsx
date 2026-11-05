/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SessionList, type SessionListProps } from "./SessionList"
import type { SessionSummary } from "./types"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const noop = () => undefined
function sessions(count: number, prefix = "chain"): SessionSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    title: `${prefix} ${index}`,
    pinnedTitle: null,
    cwd: "/synthetic",
    projectKey: "synthetic",
    filePath: `/synthetic/${prefix}-${index}.jsonl`,
    parentSessionPath: index > 0 ? `/synthetic/${prefix}-${index - 1}.jsonl` : null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: index + 1,
    model: null,
    thinkingLevel: null,
    configuredThinkingLevel: null,
    source: "omp",
    hasMessages: true,
    primaryProviderPinned: false,
  }))
}
function props(allSessions: SessionSummary[]): SessionListProps {
  return {
    allSessions,
    visibleSessions: allSessions,
    workspaceSessionsCount: allSessions.length,
    lang: "en",
    search: "",
    onSearchChange: noop,
    onClearSearch: noop,
    selectedSessionId: null,
    launching: null,
    renamingSessionId: null,
    renameValue: "",
    deletingSessionId: null,
    tabs: [],
    platform: "linux",
    onSelectSession: vi.fn(),
    onLaunchSession: vi.fn(),
    onNewSession: vi.fn(),
    onLoadTranscript: vi.fn(),
    onStartRename: noop,
    onToggleTitlePin: vi.fn(),
    onDeleteSession: vi.fn(),
    onSubmitRename: noop,
    onRenameValueChange: noop,
    onRenameKeyDown: noop,
    onOpenCodex: vi.fn(),
    onImportOmp: vi.fn(),
    onRevealWorkspace: vi.fn(),
    selectedWorkspacePath: "/synthetic",
    selectedWorkspaceName: "Synthetic",
    canLaunch: true,
  }
}
let container: HTMLDivElement
let root: Root
let current: SessionListProps
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
async function render(overrides: Partial<SessionListProps> = {}) {
  current = { ...current, ...overrides }
  await act(async () => root.render(<SessionList {...current} />))
}
function button(label: string) {
  const node = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  )
  expect(node).toBeDefined()
  return node!
}
async function click(label: string) {
  const node = button(label)
  await act(async () => {
    node.focus()
    node.click()
  })
  return node
}
function titles() {
  return Array.from(container.querySelectorAll(".session-select"), (node) =>
    node.getAttribute("aria-label"),
  )
}
async function scroll(top: number) {
  await act(async () => {
    const list = container.querySelector<HTMLElement>(".session-list")!
    list.scrollTop = top
    list.dispatchEvent(new Event("scroll"))
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(performance.now())
  })
}
beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => frames.delete(id))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  current = props([...sessions(3, "alpha"), ...sessions(2, "beta"), ...sessions(1, "single")])
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it("expands every nested group and collapses back to the same roots without launching or selecting", async () => {
  await render()
  expect(titles()).toEqual(["alpha 2", "beta 1", "single 0"])
  const expand = await click("Expand all")
  expect(titles()).toEqual(["alpha 2", "alpha 1", "alpha 0", "beta 1", "beta 0", "single 0"])
  expect(document.activeElement).toBe(expand)
  await click("Expand all")
  expect(titles()).toHaveLength(6)
  const collapse = await click("Collapse all")
  expect(titles()).toEqual(["alpha 2", "beta 1", "single 0"])
  expect(document.activeElement).toBe(collapse)
  await click("Collapse all")
  expect(titles()).toHaveLength(3)
  for (const callback of [
    current.onSelectSession,
    current.onLaunchSession,
    current.onNewSession,
    current.onLoadTranscript,
    current.onToggleTitlePin,
    current.onDeleteSession,
    current.onOpenCodex,
    current.onImportOmp,
    current.onRevealWorkspace,
  ]) {
    expect(callback).not.toHaveBeenCalled()
  }
})

it("leaves search expansion alone and restores prior partial expansion after clearing", async () => {
  await render()
  await click("Expand child sessions: alpha 2")
  expect(titles()).toEqual(["alpha 2", "alpha 1", "beta 1", "single 0"])
  await render({ search: "alpha 0", visibleSessions: [current.allSessions[0]] })
  expect(titles()).toEqual(["alpha 2", "alpha 1", "alpha 0"])
  expect(button("Expand all").disabled).toBe(true)
  expect(button("Collapse all").disabled).toBe(true)
  expect(button("Collapse all").title).toBe("Groups are expanded automatically while searching")
  await click("Collapse all")
  await render({ search: "", visibleSessions: current.allSessions })
  expect(titles()).toEqual(["alpha 2", "alpha 1", "beta 1", "single 0"])
  expect(button("Expand all").disabled).toBe(false)
})

it("does not hide an active rename editor with bulk controls", async () => {
  await render()
  await click("Expand all")
  await render({ renamingSessionId: "alpha-0", renameValue: "Unsent title" })
  const input = container.querySelector<HTMLInputElement>(".session-rename")!
  expect(input.value).toBe("Unsent title")
  input.focus()
  expect(button("Expand all").disabled).toBe(true)
  expect(button("Collapse all").disabled).toBe(true)
  await act(async () => button("Collapse all").click())
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe("Unsent title")
  await render({ renamingSessionId: null })
  expect(button("Collapse all").disabled).toBe(false)
})

it("resets bulk expansion on a workspace change even when session IDs are reused", async () => {
  await render()
  await click("Expand all")
  await render({ selectedWorkspacePath: "/synthetic-other", selectedWorkspaceName: "Other" })
  expect(titles()).toEqual(["alpha 2", "beta 1", "single 0"])
})

it("preserves selection and still reveals a newly selected archived session", async () => {
  await render({ selectedSessionId: "alpha-0" })
  expect(titles()).toContain("alpha 0")
  await click("Collapse all")
  expect(titles()).not.toContain("alpha 0")
  expect(current.onSelectSession).not.toHaveBeenCalled()
  await render({ selectedSessionId: "beta-0" })
  expect(titles()).toContain("beta 0")
  expect(
    container.querySelector('.session-select[aria-pressed="true"]')?.getAttribute("aria-label"),
  ).toBe("beta 0")
})

it("hides controls in empty and ungrouped projects and translates them", async () => {
  const ungrouped = sessions(3).map((session) => ({ ...session, parentSessionPath: null }))
  await render({ allSessions: ungrouped, visibleSessions: ungrouped })
  expect(container.querySelector(".session-group-actions")).toBeNull()
  await render({ allSessions: [], visibleSessions: [] })
  expect(container.querySelector(".session-group-actions")).toBeNull()
  const chain = sessions(2)
  await render({ allSessions: chain, visibleSessions: chain, lang: "ru" })
  expect(button("Раскрыть все")).toBeDefined()
  expect(button("Свернуть все")).toBeDefined()
  expect(
    container.querySelector('.session-group-actions[aria-label="Группы сессий"]'),
  ).not.toBeNull()
})

it("expands a 10,000-session chain with bounded mounted rows then returns to the roots", async () => {
  const chain = sessions(10_000)
  await render({ allSessions: chain, visibleSessions: chain })
  expect(titles()).toEqual(["chain 9999"])
  await click("Expand all")
  expect(titles()).toContain("chain 9998")
  expect(container.querySelectorAll(".session-item").length).toBeLessThanOrEqual(26)
  await scroll(9999 * 57)
  expect(titles()).toContain("chain 0")
  await click("Collapse all")
  expect(titles()).toEqual(["chain 9999"])
  expect(container.querySelector<HTMLElement>(".session-list")!.scrollTop).toBe(0)
})
