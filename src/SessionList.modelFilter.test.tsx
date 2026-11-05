/** @vitest-environment jsdom */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { SessionList, type SessionListProps } from "./SessionList"
import type { SessionSummary } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const noop = () => undefined
function session(id: string, model: string | null, parent: string | null = null): SessionSummary {
  return {
    id,
    title: id,
    model,
    pinnedTitle: null,
    cwd: "/synthetic",
    projectKey: "/synthetic",
    filePath: `/synthetic/${id}.jsonl`,
    parentSessionPath: parent ? `/synthetic/${parent}.jsonl` : null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: 1,
    thinkingLevel: null,
    configuredThinkingLevel: null,
    source: "omp",
    hasMessages: true,
    primaryProviderPinned: false,
  }
}

const div = document.createElement("div")
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  div.remove()
})

async function mount(sessions: SessionSummary[]) {
  document.body.append(div)
  root = createRoot(div)
  let props: SessionListProps = {
    allSessions: sessions,
    visibleSessions: sessions,
    workspaceSessionsCount: sessions.length,
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
    onSelectSession: (selected) => {
      props = {
        ...props,
        selectedSessionId: selected.id,
        search: "",
        visibleSessions: props.allSessions,
      }
      root?.render(<SessionList {...props} />)
    },
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
  const render = async (next: Partial<SessionListProps> = {}) => {
    props = { ...props, ...next }
    await act(async () => root?.render(<SessionList {...props} />))
  }
  await render()
  return render
}

function select() {
  return div.querySelector<HTMLSelectElement>(".session-model-filter select")!
}

async function filter(model: string | null) {
  await act(async () => {
    select().value = model === null ? "all" : JSON.stringify(model)
    select().dispatchEvent(new Event("change", { bubbles: true }))
  })
}

function titles() {
  return [...div.querySelectorAll(".session-select")].map((row) => row.getAttribute("aria-label"))
}

it("filters recorded model exactly, independently of title and existing text search", async () => {
  const sessions = [session("target", "alpha"), session("alpha mentioned", "beta")]
  const render = await mount(sessions)
  await filter("alpha")
  expect(titles()).toEqual(["target"])
  expect(div.querySelector('[role="status"]')?.textContent).toContain("Matches: 1.")
  await render({ search: "alpha mentioned", visibleSessions: [sessions[1]] })
  expect(titles()).toEqual([])
  expect(div.textContent).toContain("Nothing found")
  expect(div.textContent).toContain("Select all models or change the search")
  // Clearing only text does not discard the independently selected model.
  await render({ search: "", visibleSessions: sessions })
  expect(select().value).toBe(JSON.stringify("alpha"))
  expect(titles()).toEqual(["target"])
})

it("retains nonmatching ancestors as context and counts direct matches only", async () => {
  const sessions = [session("archive", "alpha"), session("newest", "beta", "archive")]
  const render = await mount(sessions)
  await render({ search: "archive", visibleSessions: [sessions[0]] })
  await filter("alpha")
  expect(titles()).toEqual(["newest", "archive"])
  expect(div.querySelector('[role="status"]')?.textContent).toContain("Matches: 1.")
  expect(div.textContent).toContain("Related sessions may be shown for context.")
})

it("groups absent and empty model metadata without matching a literal label", async () => {
  await mount([
    session("missing", null),
    session("empty", ""),
    session("literal", "Model not recorded"),
  ])
  await filter("")
  expect(titles().sort()).toEqual(["empty", "missing"])
  await filter("Model not recorded")
  expect(titles()).toEqual(["literal"])
})

it("retains an unavailable selected model after refresh until explicitly cleared", async () => {
  const sessions = [session("target", "alpha"), session("other", "beta")]
  const render = await mount(sessions)
  await filter("alpha")
  await render({ allSessions: [sessions[1]], visibleSessions: [sessions[1]] })
  expect(select().value).toBe(JSON.stringify("alpha"))
  expect(titles()).toEqual([])
  expect(div.textContent).toContain("Matches: 0.")
  await filter(null)
  expect(titles()).toEqual(["other"])
  const optionValues = [...select().options].map((option) => option.value)
  expect(optionValues).not.toContain(JSON.stringify("alpha"))
})

it("resets the filter on workspace change and does not resurrect it on return", async () => {
  const sessions = [session("target", "alpha"), session("other", "beta")]
  const render = await mount(sessions)
  await filter("alpha")
  await render({ selectedWorkspacePath: "/synthetic-other" })
  expect(select().value).toBe("all")
  expect(titles()).toHaveLength(2)
  await render({ selectedWorkspacePath: "/synthetic" })
  expect(select().value).toBe("all")
})

it("clears the model filter on selection and preserves its callback", async () => {
  const sessions = [session("target", "alpha"), session("other", "beta")]
  const render = await mount(sessions)
  const onSelectSession = vi.fn()
  await render({ onSelectSession })
  await filter("alpha")
  const target = div.querySelector<HTMLButtonElement>(".session-select")!
  await act(async () => {
    target.focus()
    target.click()
  })
  expect(onSelectSession).toHaveBeenCalledWith(sessions[0])
  expect(select().value).toBe("all")
  expect(titles()).toHaveLength(2)
})

it("localizes the filter and keeps its model identity through language changes", async () => {
  const render = await mount([session("target", "__proto__")])
  await filter("__proto__")
  await render({ lang: "ru" })
  expect(div.querySelector(".session-model-filter")?.textContent).toContain("Модель в истории")
  expect(div.textContent).toContain("Совпадений: 1.")
  expect(select().value).toBe(JSON.stringify("__proto__"))
  expect(select().labels?.length).toBe(1)
})

it("reveals the selected result after clearing a model-only filter in a long list", async () => {
  const sessions = Array.from({ length: 200 }, (_, index) => ({
    ...session(`session-${index}`, index === 0 ? "alpha" : "beta"),
    updatedAt: index + 1,
  }))
  await mount(sessions)
  await filter("alpha")
  const target = div.querySelector<HTMLButtonElement>(".session-select")!
  await act(async () => {
    target.focus()
    target.click()
  })
  expect(select().value).toBe("all")
  expect(document.activeElement?.getAttribute("aria-label")).toBe("session-0")
  expect(
    div.querySelector(".session-item.is-selected .session-select")?.getAttribute("aria-label"),
  ).toBe("session-0")
  expect(div.querySelector<HTMLElement>(".session-list")!.scrollTop).toBeGreaterThan(0)
})
