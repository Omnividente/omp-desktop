/** @vitest-environment jsdom */

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionRow } from "./SessionRow"
import { SessionList, type SessionListProps } from "./SessionList"
import type { SessionSummary } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const session: SessionSummary = {
  id: "session-1",
  title: "Initial title",
  pinnedTitle: null,
  cwd: "/tmp/project",
  projectKey: "/tmp/project",
  filePath: "/tmp/session.jsonl",
  parentSessionPath: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: 1,
  model: null,
  thinkingLevel: null,
  configuredThinkingLevel: null,
  source: "omp",
  hasMessages: true,
  primaryProviderPinned: false,
}

function RenameFixture({
  onSave,
  onLaunch,
  onSelect,
  removeOnFinish = false,
}: {
  onSave: (title: string) => void | Promise<void>
  onLaunch: () => void
  onSelect: () => void
  removeOnFinish?: boolean
}) {
  const [sessions, setSessions] = useState([session])
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(session.id)
  const [renameValue, setRenameValue] = useState("Changed title")
  const finish = () => {
    setRenamingSessionId(null)
    if (removeOnFinish) setSessions([])
  }
  const submit = () => {
    const saved = onSave(renameValue)
    const complete = () =>
      setSessions((current) =>
        removeOnFinish ? [] : current.map((item) => ({ ...item, title: renameValue })),
      )
    if (saved) void saved.then(complete)
    else complete()
    setRenamingSessionId(null)
  }
  return (
    <>
      <button className="outside-list" type="button">
        Outside list
      </button>
      <SessionList
        allSessions={sessions}
        canLaunch
        deletingSessionId={null}
        lang="ru"
        launching={null}
        onClearSearch={vi.fn()}
        onDeleteSession={vi.fn()}
        onImportOmp={vi.fn()}
        onLaunchSession={onLaunch}
        onLoadTranscript={vi.fn()}
        onNewSession={onLaunch}
        onOpenCodex={vi.fn()}
        onRenameKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            submit()
          } else if (event.key === "Escape") {
            event.preventDefault()
            finish()
          }
        }}
        onRenameValueChange={setRenameValue}
        onRevealWorkspace={vi.fn()}
        onSearchChange={vi.fn()}
        onSelectSession={onSelect}
        onStartRename={() => setRenamingSessionId(session.id)}
        onSubmitRename={submit}
        onToggleTitlePin={vi.fn()}
        platform="linux"
        renameValue={renameValue}
        renamingSessionId={renamingSessionId}
        search=""
        selectedSessionId={session.id}
        selectedWorkspaceName="Project"
        selectedWorkspacePath={session.cwd}
        tabs={[]}
        visibleSessions={sessions}
        workspaceSessionsCount={sessions.length}
      />
    </>
  )
}

describe("SessionRow rename input", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("keeps Space inside the rename input", () => {
    const onLaunch = vi.fn()
    const onKeySelect = vi.fn()
    const onRenameKeyDown = vi.fn()
    act(() => {
      root.render(
        <SessionRow
          actionsDisabled={false}
          busy={false}
          childrenExpanded={false}
          deleting={false}
          depth={0}
          hasChildren={false}
          lang="ru"
          launchDisabled={false}
          onDelete={vi.fn()}
          onDoubleLaunch={onLaunch}
          onKeySelect={onKeySelect}
          onLaunch={onLaunch}
          onRenameChange={vi.fn()}
          onRenameKeyDown={onRenameKeyDown}
          onSelect={vi.fn()}
          onStartRename={vi.fn()}
          onSubmitRename={vi.fn()}
          onToggleChildren={vi.fn()}
          onToggleTitlePin={vi.fn()}
          onTranscript={vi.fn()}
          renameValue="Initial title"
          renaming
          selected={false}
          session={session}
          sessionOpen={false}
          sessionRunning={false}
          sessionThinking={false}
        />,
      )
    })

    const input = container.querySelector<HTMLInputElement>(".session-rename")
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }))
    })

    expect(document.activeElement).toBe(input)
    expect(onLaunch).not.toHaveBeenCalled()
    expect(onKeySelect).not.toHaveBeenCalled()
  })

  it("keeps row selection out of the labeled rename control", () => {
    const onSelect = vi.fn()
    act(() =>
      root.render(<RenameFixture onSave={vi.fn()} onLaunch={vi.fn()} onSelect={onSelect} />),
    )

    const rowControl = container.querySelector<HTMLElement>(".session-select")!
    const input = container.querySelector<HTMLInputElement>(".session-rename")!
    expect(rowControl.hasAttribute("role")).toBe(false)
    expect(rowControl.hasAttribute("tabindex")).toBe(false)
    expect(input.getAttribute("aria-label")).toBe("Изменить фиксированное название")
    act(() => rowControl.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it.each(["Enter", "Escape"])("returns keyboard focus to the session after %s", (key) => {
    const onSave = vi.fn()
    const onLaunch = vi.fn()
    const onSelect = vi.fn()
    act(() =>
      root.render(<RenameFixture onSave={onSave} onLaunch={onLaunch} onSelect={onSelect} />),
    )
    const input = container.querySelector<HTMLInputElement>(".session-rename")!
    expect(document.activeElement).toBe(input)

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }))
      // A blur before React commits the unmount must not submit the draft again.
      input.blur()
    })

    expect(input.isConnected).toBe(false)
    expect(document.activeElement).toBe(container.querySelector(".session-select"))
    expect(container.querySelector(".session-select strong")?.textContent).toBe(
      key === "Enter" ? "Changed title" : "Initial title",
    )
    if (key === "Enter") {
      expect(onSave).toHaveBeenCalledExactlyOnceWith("Changed title")
    } else {
      expect(onSave).not.toHaveBeenCalled()
    }
    expect(onLaunch).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("saves on ordinary blur without taking focus from the chosen control", () => {
    const onSave = vi.fn()
    const onLaunch = vi.fn()
    const onSelect = vi.fn()
    act(() =>
      root.render(<RenameFixture onSave={onSave} onLaunch={onLaunch} onSelect={onSelect} />),
    )
    const outside = container.querySelector<HTMLButtonElement>(".outside-list")!

    act(() => outside.focus())

    expect(container.querySelector(".session-rename")).toBeNull()
    expect(document.activeElement).toBe(outside)
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Changed title")
    expect(onLaunch).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("focuses the accessible list when the edited session disappears on completion", () => {
    const onSave = vi.fn()
    act(() =>
      root.render(
        <RenameFixture onSave={onSave} onLaunch={vi.fn()} onSelect={vi.fn()} removeOnFinish />,
      ),
    )
    const input = container.querySelector<HTMLInputElement>(".session-rename")!

    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      ),
    )

    expect(container.querySelector(".session-item")).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[role="region"][aria-label]'))
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Changed title")
  })

  it.each([false, true])(
    "handles delayed disappearance after rename without stealing external focus (%s)",
    async (moveFocusOutside) => {
      let complete!: () => void
      const saved = new Promise<void>((resolve) => {
        complete = resolve
      })
      act(() =>
        root.render(
          <RenameFixture
            onSave={() => saved}
            onLaunch={vi.fn()}
            onSelect={vi.fn()}
            removeOnFinish
          />,
        ),
      )
      const input = container.querySelector<HTMLInputElement>(".session-rename")!
      act(() =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
          }),
        ),
      )
      expect(document.activeElement).toBe(container.querySelector(".session-select"))
      const outside = container.querySelector<HTMLButtonElement>(".outside-list")!
      if (moveFocusOutside) act(() => outside.focus())

      await act(async () => complete())

      expect(container.querySelector(".session-item")).toBeNull()
      expect(document.activeElement).toBe(
        moveFocusOutside ? outside : container.querySelector('[role="region"][aria-label]'),
      )
    },
  )
})

describe("session pin search transitions", () => {
  it.each([false, true])(
    "keeps useful focus when unpinning removes the search result (%s)",
    (externalFocus) => {
      const container = document.createElement("div")
      document.body.appendChild(container)
      const root = createRoot(container)
      function PinFixture() {
        const [pinned, setPinned] = useState(true)
        const [search, setSearch] = useState("Pinned")
        const current = {
          ...session,
          title: pinned ? "Pinned" : "Original",
          pinnedTitle: pinned ? "Pinned" : null,
        }
        return (
          <>
            <button className="outside-list" type="button">
              Outside list
            </button>
            <SessionList
              allSessions={[current]}
              visibleSessions={current.title.includes(search) ? [current] : []}
              workspaceSessionsCount={1}
              search={search}
              onSearchChange={setSearch}
              onClearSearch={() => setSearch("")}
              lang="ru"
              selectedSessionId={current.id}
              launching={null}
              renamingSessionId={null}
              renameValue=""
              deletingSessionId={null}
              tabs={[]}
              platform="linux"
              canLaunch
              onSelectSession={vi.fn()}
              onLaunchSession={vi.fn()}
              onNewSession={vi.fn()}
              onLoadTranscript={vi.fn()}
              onStartRename={vi.fn()}
              onToggleTitlePin={() => setPinned(false)}
              onDeleteSession={vi.fn()}
              onSubmitRename={vi.fn()}
              onRenameValueChange={vi.fn()}
              onRenameKeyDown={vi.fn()}
              onOpenCodex={vi.fn()}
              onImportOmp={vi.fn()}
              onRevealWorkspace={vi.fn()}
              selectedWorkspacePath={current.cwd}
              selectedWorkspaceName="Project"
            />
          </>
        )
      }
      try {
        act(() => root.render(<PinFixture />))
        const pin = container.querySelector<HTMLButtonElement>(".session-pin")!
        const outside = container.querySelector<HTMLButtonElement>(".outside-list")!
        act(() => {
          if (externalFocus) outside.focus()
          else pin.focus()
          pin.click()
        })
        expect(container.querySelector(".session-item")).toBeNull()
        expect(document.activeElement).toBe(
          externalFocus ? outside : container.querySelector(".search-box input"),
        )
      } finally {
        act(() => root.unmount())
        container.remove()
      }
    },
  )
})

// Controlled parent boundary: App normally clears search and selects synchronously.
// These cases also put newer user intent between selection and the next commit.
describe("session search selection continuity", () => {
  let container: HTMLDivElement
  let root: Root
  let props: SessionListProps
  let sessions: SessionSummary[]
  const outside = () => container.querySelector<HTMLButtonElement>(".outside-list")!
  const list = () => container.querySelector<HTMLDivElement>(".session-list")!
  const search = () => container.querySelector<HTMLInputElement>(".search-box input")!
  const target = () => container.querySelector<HTMLElement>('.session-select[aria-label="Target"]')!
  const selected = () =>
    container.querySelector<HTMLElement>(".session-item.is-selected .session-select")
  function render(next: Partial<SessionListProps> = {}) {
    props = { ...props, ...next }
    root.render(
      <>
        <button className="outside-list">Outside</button>
        <SessionList {...props} />
      </>,
    )
  }
  function finishSelection(item: SessionSummary) {
    render({ search: "", visibleSessions: sessions, selectedSessionId: item.id })
  }
  function choose() {
    const row = target()
    row.focus()
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  }
  beforeEach(() => {
    sessions = Array.from({ length: 100 }, (_, index) => ({
      ...session,
      id: `session-${index}`,
      title: index === 99 ? "Target" : `Session ${index}`,
      filePath: `/tmp/session-${index}.jsonl`,
      updatedAt: 100 - index,
    }))
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    props = {
      allSessions: sessions,
      visibleSessions: [sessions[99]],
      workspaceSessionsCount: sessions.length,
      search: "Target",
      onSearchChange: vi.fn(),
      onClearSearch: () => render({ search: "", visibleSessions: sessions }),
      lang: "en",
      selectedSessionId: null,
      launching: null,
      renamingSessionId: null,
      renameValue: "",
      deletingSessionId: null,
      tabs: [],
      platform: "linux",
      canLaunch: true,
      onSelectSession: finishSelection,
      onLaunchSession: vi.fn(),
      onNewSession: vi.fn(),
      onLoadTranscript: vi.fn(),
      onStartRename: vi.fn(),
      onToggleTitlePin: vi.fn(),
      onDeleteSession: vi.fn(),
      onSubmitRename: vi.fn(),
      onRenameValueChange: vi.fn(),
      onRenameKeyDown: vi.fn(),
      onOpenCodex: vi.fn(),
      onImportOmp: vi.fn(),
      onRevealWorkspace: vi.fn(),
      selectedWorkspacePath: session.cwd,
      selectedWorkspaceName: "Project",
    }
    act(() => render())
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it.each([160, 211, 477])(
    "keeps the final row fully visible with production padding in a %ipx viewport",
    async (viewportHeight) => {
      const { readFileSync } = await vi.importActual<{
        readFileSync(path: string, encoding: "utf8"): string
      }>("node:fs")
      const style = document.createElement("style")
      style.textContent = readFileSync("src/App.css", "utf8")
      document.head.append(style)
      Object.defineProperty(list(), "clientHeight", { configurable: true, value: viewportHeight })
      try {
        const paddingTop = Number.parseFloat(getComputedStyle(list()).paddingTop)
        expect(paddingTop).toBe(6)
        act(choose)
        // jsdom does not lay out: model the production 55px card / 57px slot
        // using its real computed list padding, rather than claiming native QA.
        const articleBottom = paddingTop + 99 * 57 + 55
        expect(articleBottom).toBeLessThanOrEqual(list().scrollTop + viewportHeight)
        expect(document.activeElement).toBe(selected())
      } finally {
        style.remove()
      }
    },
  )

  it("does not scroll an already visible result", () => {
    const nearby = { ...sessions[3], title: "Target" }
    sessions = sessions.map((item, index) =>
      index === 3 ? nearby : { ...item, title: `Session ${index}` },
    )
    act(() => render({ allSessions: sessions, visibleSessions: [nearby] }))
    act(choose)
    expect(list().scrollTop).toBe(0)
    expect(document.activeElement).toBe(selected())
  })

  it("reveals an unfocused clicked result without taking focus from search", () => {
    act(() => {
      search().focus()
      target().click()
    })
    expect(list().scrollTop).toBeGreaterThan(0)
    expect(selected()?.textContent).toContain("Target")
    expect(document.activeElement).toBe(search())
  })

  it.each(["focus", "pointer"])(
    "honors newer outside %s intent before selection commits",
    (intent) => {
      act(() =>
        render({
          onSelectSession: (item) => {
            if (intent === "focus") {
              outside().focus()
              outside().blur()
            } else outside().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
            finishSelection(item)
          },
        }),
      )
      act(choose)
      expect(list().scrollTop).toBe(0)
      expect(document.activeElement).toBe(document.body)
      act(() => render({ allSessions: [...sessions] }))
      expect(list().scrollTop).toBe(0)
      expect(document.activeElement).toBe(document.body)
    },
  )

  it("cancels a reveal when the workspace changes before the selection commits", () => {
    act(() =>
      render({
        onSelectSession: (item) => {
          render({
            selectedWorkspacePath: "/tmp/other",
            selectedSessionId: item.id,
            search: "",
            visibleSessions: sessions,
          })
        },
      }),
    )
    act(choose)
    expect(list().scrollTop).toBe(0)
    expect(document.activeElement).toBe(document.body)
  })

  it("does not overwrite a newer selected session", () => {
    act(() => render({ onSelectSession: () => finishSelection(sessions[0]) }))
    act(choose)
    expect(list().scrollTop).toBe(0)
    expect(selected()?.textContent).toContain("Session 0")
    expect(document.activeElement).toBe(document.body)
  })

  it("preserves explicit Clear behavior instead of revealing an old selection", () => {
    act(() => render({ selectedSessionId: sessions[99].id }))
    act(() => container.querySelector<HTMLButtonElement>(".search-box button")!.click())
    expect(search().value).toBe("")
    expect(list().scrollTop).toBe(0)
    expect(document.activeElement).toBe(search())
  })

  it("does not reclaim scrolling or focus on a background refresh", () => {
    act(choose)
    expect(list().scrollTop).toBeGreaterThan(0)
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    act(() => {
      outside().focus()
      list().scrollTop = 1140
      list().dispatchEvent(new Event("scroll"))
      for (const frame of frames.splice(0)) frame(0)
    })
    act(() => render({ allSessions: sessions.map((item) => ({ ...item })) }))
    expect(list().scrollTop).toBe(1140)
    expect(document.activeElement).toBe(outside())
    expect(selected()).toBeNull()
  })

  it("does not reveal offscreen selections from ordinary non-search updates", () => {
    act(() => render({ search: "", visibleSessions: sessions }))
    act(() => render({ selectedSessionId: sessions[99].id }))
    expect(list().scrollTop).toBe(0)
    expect(selected()).toBeNull()
  })

  it("discards a vanished result rather than replaying its reveal when it returns", () => {
    act(() =>
      render({
        onSelectSession: (item) =>
          render({
            allSessions: sessions.slice(0, 99),
            visibleSessions: sessions.slice(0, 99),
            selectedSessionId: item.id,
            search: "",
          }),
      }),
    )
    act(choose)
    act(() => render({ allSessions: sessions, visibleSessions: sessions }))
    expect(list().scrollTop).toBe(0)
    expect(document.activeElement).toBe(document.body)
  })

  it("reopens a collapsed lineage when the same already-selected result is searched again", () => {
    const newest = {
      ...sessions[99],
      id: "newest",
      title: "Newest",
      filePath: "/tmp/newest.jsonl",
      parentSessionPath: sessions[99].filePath,
      updatedAt: 2,
    }
    sessions = [...sessions, newest]
    act(() => render({ allSessions: sessions, visibleSessions: [sessions[99]] }))
    act(choose)
    expect(selected()?.textContent).toContain("Target")
    act(() => container.querySelector<HTMLButtonElement>(".session-group-toggle")!.click())
    expect(selected()).toBeNull()
    act(() => render({ search: "Target", visibleSessions: [sessions[99]] }))
    act(choose)
    expect(selected()?.textContent).toContain("Target")
    expect(document.activeElement).toBe(selected())
  })
})
