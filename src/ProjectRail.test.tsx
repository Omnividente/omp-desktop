/** @vitest-environment jsdom */

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProjectRail } from "./ProjectRail"
import type { SessionListProps } from "./SessionList"
import type { WorkspaceSummary } from "./types"

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const workspace: WorkspaceSummary = {
  key: "d:/projects/app",
  path: "D:/Projects/App",
  name: "App",
  sessionCount: 2,
  lastActive: 1,
  pinned: true,
}

function sessionList(): SessionListProps {
  return {
    allSessions: [],
    canLaunch: true,
    deletingSessionId: null,
    lang: "ru",
    launching: null,
    onClearSearch: vi.fn(),
    onDeleteSession: vi.fn(),
    onImportOmp: vi.fn(),
    onLaunchSession: vi.fn(),
    onLoadTranscript: vi.fn(),
    onNewSession: vi.fn(),
    onOpenCodex: vi.fn(),
    onRenameKeyDown: vi.fn(),
    onRenameValueChange: vi.fn(),
    onRevealWorkspace: vi.fn(),
    onSearchChange: vi.fn(),
    onSelectSession: vi.fn(),
    onStartRename: vi.fn(),
    onSubmitRename: vi.fn(),
    onToggleTitlePin: vi.fn(),
    platform: "windows",
    renameValue: "",
    renamingSessionId: null,
    search: "",
    selectedSessionId: null,
    selectedWorkspaceName: workspace.name,
    selectedWorkspacePath: workspace.path,
    tabs: [],
    visibleSessions: [],
    workspaceSessionsCount: 0,
  }
}

function RemovalFixture({
  remove,
  lastWorkspace = false,
}: {
  remove: () => Promise<boolean>
  lastWorkspace?: boolean
}) {
  const [workspaces, setWorkspaces] = useState(
    lastWorkspace
      ? [workspace]
      : [workspace, { ...workspace, key: "other", name: "Other", path: "D:/Projects/Other" }],
  )
  const [busy, setBusy] = useState<string | null>(null)
  return (
    <>
      <button className="outside-rail">Outside rail</button>
      <ProjectRail
        autoHidePaused={false}
        autoOpen={false}
        mode={lastWorkspace ? "collapsed" : "expanded"}
        modeSaving={false}
        workspaces={workspaces}
        selectedWorkspace={workspaces[0] ?? null}
        sessionList={sessionList()}
        renamingWorkspaceKey={null}
        workspaceNameValue=""
        workspaceBusyKey={busy}
        onAutoOpenChange={() => undefined}
        onModeChange={() => undefined}
        onOpenFolder={() => undefined}
        onSelectWorkspace={() => undefined}
        onStartWorkspaceRename={() => undefined}
        onSubmitWorkspaceRename={() => undefined}
        onWorkspaceNameChange={() => undefined}
        onWorkspaceRenameKeyDown={() => undefined}
        onRemoveWorkspace={async (removed) => {
          setBusy(removed.key)
          if (await remove()) {
            setWorkspaces((current) => current.filter((item) => item.key !== removed.key))
          }
          setBusy(null)
        }}
      />
    </>
  )
}

describe("ProjectRail workspace actions", () => {
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

  it("restores the edit control after Escape without reclaiming a newer focus", () => {
    let moveFocusOnCancel = false
    const render = (renamingWorkspaceKey: string | null) => {
      root.render(
        <>
          <button className="outside-rail">Outside rail</button>
          <ProjectRail {...common} renamingWorkspaceKey={renamingWorkspaceKey} />
        </>,
      )
    }
    const common = {
      autoHidePaused: false,
      autoOpen: false,
      mode: "expanded" as const,
      modeSaving: false,
      onAutoOpenChange: vi.fn(),
      onModeChange: vi.fn(),
      onOpenFolder: vi.fn(),
      onRemoveWorkspace: vi.fn(),
      onSelectWorkspace: vi.fn(),
      onStartWorkspaceRename: () => render(workspace.key),
      onSubmitWorkspaceRename: vi.fn(),
      onWorkspaceNameChange: vi.fn(),
      onWorkspaceRenameKeyDown: (event: { key: string }) => {
        if (event.key !== "Escape") return
        if (moveFocusOnCancel) {
          container.querySelector<HTMLButtonElement>(".outside-rail")!.focus()
        }
        render(null)
      },
      selectedWorkspace: workspace,
      sessionList: sessionList(),
      workspaceBusyKey: null,
      workspaceNameValue: "Unsaved draft",
      workspaces: [workspace],
    }

    act(() => render(null))
    const edit = () =>
      container.querySelector<HTMLButtonElement>('button[title="Переименовать проект"]')!
    act(() => edit().click())
    const input = container.querySelector<HTMLInputElement>(".project-rename")!
    expect(document.activeElement).toBe(input)
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(document.activeElement).toBe(edit())
    expect(container.querySelector(".project-copy strong")?.textContent).toBe(workspace.name)

    moveFocusOnCancel = true
    act(() => edit().click())
    const nextInput = container.querySelector<HTMLInputElement>(".project-rename")!
    act(() =>
      nextInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    )
    expect(container.querySelector(".project-rename")).toBeNull()
    expect(document.activeElement).toBe(container.querySelector(".outside-rail"))
  })

  it("restores keyboard focus inside the existing rail after asynchronous deletion", async () => {
    let finish!: (removed: boolean) => void
    const removal = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    act(() => root.render(<RemovalFixture remove={() => removal} />))
    const button = container.querySelector<HTMLButtonElement>(".project-remove")!
    act(() => {
      button.focus()
      button.click()
    })
    expect(button.disabled).toBe(true)
    await act(async () => finish(true))
    expect(button.isConnected).toBe(false)
    expect(document.activeElement).toBe(container.querySelector(".rail-open-folder"))
    expect(container.querySelector(".project-item strong")?.textContent).toBe("Other")
  })

  it("keeps a focusable fallback when the final workspace disappears from a collapsed rail", async () => {
    act(() => root.render(<RemovalFixture lastWorkspace remove={async () => true} />))
    const button = container.querySelector<HTMLButtonElement>(".project-remove")!
    await act(async () => {
      button.focus()
      button.click()
    })
    expect(container.querySelector(".project-item")).toBeNull()
    expect(document.activeElement).toBe(container.querySelector(".rail-open-folder"))
  })

  it("does not move focus when deletion leaves the workspace in place", async () => {
    act(() => root.render(<RemovalFixture remove={async () => false} />))
    const button = container.querySelector<HTMLButtonElement>(".project-remove")!
    await act(async () => {
      button.focus()
      button.click()
    })
    expect(button.isConnected).toBe(true)
    expect(document.activeElement).toBe(button)
  })

  it("does not reclaim focus after the user moved away during deletion, even if focus later reaches body", async () => {
    let finish!: (removed: boolean) => void
    const removal = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    act(() => root.render(<RemovalFixture remove={() => removal} />))
    const button = container.querySelector<HTMLButtonElement>(".project-remove")!
    act(() => {
      button.focus()
      button.click()
    })
    const outside = container.querySelector<HTMLButtonElement>(".outside-rail")!
    act(() => outside.focus())
    expect(document.activeElement).toBe(outside)
    act(() => outside.blur())
    await act(async () => finish(true))
    expect(button.isConnected).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it("does not steal focus for a pointer removal that never owned keyboard focus", async () => {
    act(() => root.render(<RemovalFixture remove={async () => true} />))
    const outside = container.querySelector<HTMLButtonElement>(".outside-rail")!
    act(() => outside.focus())
    await act(async () => container.querySelector<HTMLButtonElement>(".project-remove")!.click())
    expect(container.querySelector(".project-item strong")?.textContent).toBe("Other")
    expect(document.activeElement).toBe(outside)
  })
})

describe("ProjectRail Enter rename focus", () => {
  let container: HTMLDivElement
  let root: Root
  const input = () => container.querySelector<HTMLInputElement>(".project-rename")!
  const edit = () => container.querySelector<HTMLButtonElement>(".project-actions button")!

  beforeEach(() => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render({
    renaming = workspace.key as string | null,
    busy = null as string | null,
    value = "Changed",
    mode = "expanded" as "expanded" | "collapsed",
  } = {}) {
    act(() =>
      root.render(
        <>
          <button className="outside-rail">Outside rail</button>
          <ProjectRail
            autoHidePaused={false}
            autoOpen={false}
            mode={mode}
            modeSaving={false}
            workspaces={[workspace]}
            selectedWorkspace={workspace}
            sessionList={sessionList()}
            renamingWorkspaceKey={renaming}
            workspaceNameValue={value}
            workspaceBusyKey={busy}
            onAutoOpenChange={vi.fn()}
            onModeChange={vi.fn()}
            onOpenFolder={vi.fn()}
            onSelectWorkspace={vi.fn()}
            onStartWorkspaceRename={vi.fn()}
            onSubmitWorkspaceRename={vi.fn()}
            onWorkspaceNameChange={vi.fn()}
            onWorkspaceRenameKeyDown={vi.fn()}
            onRemoveWorkspace={vi.fn()}
          />
        </>,
      ),
    )
  }

  function enter() {
    act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
  }

  it.each(["expanded", "collapsed"] as const)(
    "returns editor-owned Enter focus to the %s rail action",
    (mode) => {
      render({ mode })
      expect(document.activeElement).toBe(input())
      enter()
      render({ busy: workspace.key, mode })
      render({ renaming: null, mode })
      expect(document.activeElement).toBe(
        mode === "collapsed" ? container.querySelector("button.project-item") : edit(),
      )
    },
  )

  it.each(["focus", "pointer"] as const)(
    "cancels pending restoration after outside %s intent, even after focus returns to body",
    (intent) => {
      render()
      enter()
      render({ busy: workspace.key })
      const outside = container.querySelector<HTMLButtonElement>(".outside-rail")!
      act(() => {
        if (intent === "focus") outside.focus()
        else outside.dispatchEvent(new Event("pointerdown", { bubbles: true }))
        ;(document.activeElement as HTMLElement).blur()
      })
      render({ renaming: null })
      expect(document.activeElement).toBe(document.body)
    },
  )

  it("does not restore on an ordinary blur submission", () => {
    render()
    act(() => input().blur())
    render({ renaming: null })
    expect(document.activeElement).toBe(document.body)
  })

  it("clears a failed submission's claim before a later blur closes the editor", () => {
    render()
    enter()
    render({ busy: workspace.key })
    render()
    act(() => input().blur())
    render({ renaming: null })
    expect(document.activeElement).toBe(document.body)
  })

  it("clears pending restoration when a new draft is typed", () => {
    render()
    enter()
    render({ busy: workspace.key })
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(),
        "New draft",
      )
      input().dispatchEvent(new Event("input", { bubbles: true }))
    })
    render({ busy: workspace.key, value: "New draft" })
    render({ renaming: null })
    expect(document.activeElement).toBe(document.body)
  })

  it("does not claim focus for a synthetic Enter from an unfocused editor", () => {
    render()
    act(() => input().blur())
    enter()
    render({ renaming: null })
    expect(document.activeElement).toBe(document.body)
  })
})


describe("ProjectRail project search", () => {
  let container: HTMLDivElement
  let root: Root
  const select = vi.fn()
  const projects = [
    workspace,
    { ...workspace, key: "other", path: "D:/Archive/App", name: "App" },
    { ...workspace, key: "unicode", path: "/projects/café", name: "Кафе" },
  ]
  const search = () => container.querySelector<HTMLInputElement>('input[type="search"]')!
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>("button.project-item")]
  function render(mode: "expanded" | "collapsed" | "autoHide" = "expanded", lang: "ru" | "en" = "en", renaming: string | null = null, autoOpen = false) {
    act(() => root.render(
      <ProjectRail
        autoHidePaused={false} autoOpen={autoOpen} mode={mode} modeSaving={false}
        workspaces={projects} selectedWorkspace={workspace}
        sessionList={{ ...sessionList(), lang }}
        renamingWorkspaceKey={renaming} workspaceNameValue="App" workspaceBusyKey={null}
        onAutoOpenChange={vi.fn()} onModeChange={vi.fn()} onOpenFolder={vi.fn()}
        onSelectWorkspace={select} onStartWorkspaceRename={vi.fn()}
        onSubmitWorkspaceRename={vi.fn()} onWorkspaceNameChange={vi.fn()}
        onWorkspaceRenameKeyDown={vi.fn()} onRemoveWorkspace={vi.fn()}
      />,
    ))
  }
  function type(value: string) {
    act(() => {
      search().focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value)
      search().dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  beforeEach(() => {
    select.mockClear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  it("finds duplicate-named projects by path without switching workspace, then selects the exact key", () => {
    render()
    type("  ARCHIVE  ")
    expect(rows()).toHaveLength(1)
    expect(rows()[0].textContent).toContain("D:/Archive/App")
    expect(select).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(search())
    act(() => { rows()[0].focus(); rows()[0].click() })
    expect(select).toHaveBeenCalledExactlyOnceWith("other")
    expect(search().value).toBe("")
    expect(rows()).toHaveLength(3)
    expect(document.activeElement).toBe(rows()[1])
  })
  it("matches canonical Unicode names and paths literally", () => {
    render()
    type("CAF\u0045\u0301")
    expect(rows()).toHaveLength(1)
    expect(rows()[0].textContent).toContain("Кафе")
    type("кафе")
    expect(rows()).toHaveLength(1)
    type(".*")
    expect(rows()).toHaveLength(0)
  })
  it.each(["ru", "en"] as const)("labels search and empty results in %s and clears with Escape while retaining focus", (lang) => {
    render("expanded", lang)
    expect(search().getAttribute("aria-label")).toBe(lang === "ru" ? "Найти проект по имени или пути" : "Find project by name or path")
    const liveRegion = container.querySelector(".project-search-count")
    expect(liveRegion?.textContent).toBe("")
    type("missing")
    expect(container.querySelector(".project-search-count")).toBe(liveRegion)
    expect(container.querySelector(".project-search-count")?.textContent).toBe(lang === "ru" ? "Показано проектов: 0" : "Projects shown: 0")
    act(() => search().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(rows()).toHaveLength(3)
    expect(document.activeElement).toBe(search())
    expect(select).not.toHaveBeenCalled()
  })
  it("does not clear an IME composition with Escape", () => {
    render()
    type("Archive")
    act(() => search().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true })))
    expect(search().value).toBe("Archive")
  })
  it.each(["collapsed", "autoHide"] as const)("keeps every project reachable when the %s rail hides search", (mode) => {
    render()
    type("Archive")
    render(mode)
    expect(search()).toBeNull()
    expect(rows()).toHaveLength(3)
    render(mode === "autoHide" ? "autoHide" : "expanded", "en", null, true)
    expect(search().value).toBe("Archive")
    expect(rows()).toHaveLength(1)
  })
  it("retains an externally opened rename editor even when its row does not match", () => {
    render()
    type("Archive")
    render("expanded", "en", workspace.key)
    expect(container.querySelector(".project-rename")).not.toBeNull()
    expect(search().disabled).toBe(true)
    expect(rows()).toHaveLength(1)
  })
})

describe("ProjectRail auto-hide search reveal", () => {
  let container: HTMLDivElement
  let root: Root
  const select = vi.fn()
  const target = { ...workspace, key: "archive", path: "D:/Archive/App" }
  function Fixture() {
    const [open, setOpen] = useState(true)
    return (
      <>
        <button className="collapse-for-test" onClick={() => setOpen(false)}>Collapse</button>
        <ProjectRail
          autoHidePaused={false} autoOpen={open} mode="autoHide" modeSaving={false}
          workspaces={[workspace, target]} selectedWorkspace={workspace}
          sessionList={sessionList()} renamingWorkspaceKey={null} workspaceNameValue=""
          workspaceBusyKey={null} onAutoOpenChange={setOpen} onModeChange={vi.fn()}
          onOpenFolder={vi.fn()} onSelectWorkspace={select} onStartWorkspaceRename={vi.fn()}
          onSubmitWorkspaceRename={vi.fn()} onWorkspaceNameChange={vi.fn()}
          onWorkspaceRenameKeyDown={vi.fn()} onRemoveWorkspace={vi.fn()}
        />
      </>
    )
  }
  const search = () => container.querySelector<HTMLInputElement>('input[type="search"]')!
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>("button.project-item")]
  function type(value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value)
      search().dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  beforeEach(() => {
    vi.useFakeTimers()
    select.mockClear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    act(() => root.render(<Fixture />))
    type("Archive")
    expect(rows()).toHaveLength(1)
    act(() => container.querySelector<HTMLButtonElement>(".collapse-for-test")!.click())
    expect(search()).toBeNull()
    expect(rows()).toHaveLength(2)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })
  it("clears the hidden query before focus opens a previously nonmatching compact row", () => {
    const previouslyHidden = rows()[0]
    act(() => previouslyHidden.focus())
    expect(search().value).toBe("")
    expect(rows()).toHaveLength(2)
    expect(previouslyHidden.isConnected).toBe(true)
    expect(document.activeElement).toBe(previouslyHidden)
    expect(select).not.toHaveBeenCalled()
    act(() => previouslyHidden.click())
    expect(select).toHaveBeenCalledExactlyOnceWith(workspace.key)
  })
  it("clears the hidden query before delayed hover reveal, keeping the pointed row selectable", () => {
    const previouslyHidden = rows()[0]
    act(() => previouslyHidden.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })))
    expect(search()).toBeNull()
    act(() => vi.advanceTimersByTime(220))
    expect(search().value).toBe("")
    expect(previouslyHidden.isConnected).toBe(true)
    expect(rows()).toHaveLength(2)
    act(() => previouslyHidden.click())
    expect(select).toHaveBeenCalledExactlyOnceWith(workspace.key)
  })
  it("cancels a pending hover reveal when focus reveals first, preserving a newly typed query", () => {
    act(() => rows()[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })))
    act(() => rows()[0].focus())
    act(() => search().focus())
    type("Archive")
    act(() => vi.advanceTimersByTime(220))
    expect(search().value).toBe("Archive")
    expect(rows()).toHaveLength(1)
    expect(document.activeElement).toBe(search())
    expect(select).not.toHaveBeenCalled()
  })
})
