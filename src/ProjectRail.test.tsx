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
  function render(
    mode: "expanded" | "collapsed" | "autoHide" = "expanded",
    lang: "ru" | "en" = "en",
    renaming: string | null = null,
    autoOpen = false,
  ) {
    act(() =>
      root.render(
        <ProjectRail
          autoHidePaused={false}
          autoOpen={autoOpen}
          mode={mode}
          modeSaving={false}
          workspaces={projects}
          selectedWorkspace={workspace}
          sessionList={{ ...sessionList(), lang }}
          renamingWorkspaceKey={renaming}
          workspaceNameValue="App"
          workspaceBusyKey={null}
          onAutoOpenChange={vi.fn()}
          onModeChange={vi.fn()}
          onOpenFolder={vi.fn()}
          onSelectWorkspace={select}
          onStartWorkspaceRename={vi.fn()}
          onSubmitWorkspaceRename={vi.fn()}
          onWorkspaceNameChange={vi.fn()}
          onWorkspaceRenameKeyDown={vi.fn()}
          onRemoveWorkspace={vi.fn()}
        />,
      ),
    )
  }
  function type(value: string) {
    act(() => {
      search().focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search(),
        value,
      )
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
    act(() => {
      rows()[0].focus()
      rows()[0].click()
    })
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
  it.each(["ru", "en"] as const)(
    "labels search and empty results in %s and clears with Escape while retaining focus",
    (lang) => {
      render("expanded", lang)
      expect(search().getAttribute("aria-label")).toBe(
        lang === "ru" ? "Найти проект по имени или пути" : "Find project by name or path",
      )
      const liveRegion = container.querySelector(".project-search-count")
      expect(liveRegion?.textContent).toBe("")
      type("missing")
      expect(container.querySelector(".project-search-count")).toBe(liveRegion)
      expect(container.querySelector(".project-search-count")?.textContent).toBe(
        lang === "ru" ? "Показано проектов: 0" : "Projects shown: 0",
      )
      act(() =>
        search().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      )
      expect(rows()).toHaveLength(3)
      expect(document.activeElement).toBe(search())
      expect(select).not.toHaveBeenCalled()
    },
  )
  it("does not clear an IME composition with Escape", () => {
    render()
    type("Archive")
    act(() =>
      search().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }),
      ),
    )
    expect(search().value).toBe("Archive")
  })
  it.each(["collapsed", "autoHide"] as const)(
    "keeps every project reachable when the %s rail hides search",
    (mode) => {
      render()
      type("Archive")
      render(mode)
      expect(search()).toBeNull()
      expect(rows()).toHaveLength(3)
      render(mode === "autoHide" ? "autoHide" : "expanded", "en", null, true)
      expect(search().value).toBe("Archive")
      expect(rows()).toHaveLength(1)
    },
  )
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
        <button className="collapse-for-test" onClick={() => setOpen(false)}>
          Collapse
        </button>
        <ProjectRail
          autoHidePaused={false}
          autoOpen={open}
          mode="autoHide"
          modeSaving={false}
          workspaces={[workspace, target]}
          selectedWorkspace={workspace}
          sessionList={sessionList()}
          renamingWorkspaceKey={null}
          workspaceNameValue=""
          workspaceBusyKey={null}
          onAutoOpenChange={setOpen}
          onModeChange={vi.fn()}
          onOpenFolder={vi.fn()}
          onSelectWorkspace={select}
          onStartWorkspaceRename={vi.fn()}
          onSubmitWorkspaceRename={vi.fn()}
          onWorkspaceNameChange={vi.fn()}
          onWorkspaceRenameKeyDown={vi.fn()}
          onRemoveWorkspace={vi.fn()}
        />
      </>
    )
  }
  const search = () => container.querySelector<HTMLInputElement>('input[type="search"]')!
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>("button.project-item")]
  function type(value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search(),
        value,
      )
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

describe("ProjectRail project order", () => {
  let container: HTMLDivElement
  let root: Root
  const selectWorkspace = vi.fn()
  const renameWorkspace = vi.fn()
  const projects: WorkspaceSummary[] = [
    { ...workspace, key: "z", name: "Zulu", path: "/projects/z", pinned: true },
    { ...workspace, key: "ten", name: "App 10", path: "/projects/10", pinned: false },
    { ...workspace, key: "two", name: "App 2", path: "/projects/2", pinned: false },
    { ...workspace, key: "a", name: "Alpha", path: "/projects/a", pinned: false },
  ]
  const order = () => container.querySelector<HTMLSelectElement>(".project-order select")!
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>("button.project-item")]
  const names = () => rows().map((row) => row.querySelector("strong")?.textContent)
  function changeOrder(value: string) {
    act(() => {
      order().focus()
      order().value = value
      order().dispatchEvent(new Event("change", { bubbles: true }))
    })
  }
  function render({
    workspaces = projects,
    lang = "en",
    mode = "expanded",
    autoOpen = false,
    renaming = null,
  }: {
    workspaces?: WorkspaceSummary[]
    lang?: "ru" | "en"
    mode?: "expanded" | "collapsed" | "autoHide"
    autoOpen?: boolean
    renaming?: string | null
  } = {}) {
    act(() =>
      root.render(
        <ProjectRail
          autoHidePaused={false}
          autoOpen={autoOpen}
          mode={mode}
          modeSaving={false}
          workspaces={workspaces}
          selectedWorkspace={projects[1]}
          sessionList={{ ...sessionList(), lang }}
          renamingWorkspaceKey={renaming}
          workspaceNameValue="Edited name"
          workspaceBusyKey={null}
          onAutoOpenChange={vi.fn()}
          onModeChange={vi.fn()}
          onOpenFolder={vi.fn()}
          onSelectWorkspace={selectWorkspace}
          onStartWorkspaceRename={renameWorkspace}
          onSubmitWorkspaceRename={vi.fn()}
          onWorkspaceNameChange={vi.fn()}
          onWorkspaceRenameKeyDown={vi.fn()}
          onRemoveWorkspace={vi.fn()}
        />,
      ),
    )
  }
  beforeEach(() => {
    selectWorkspace.mockClear()
    renameWorkspace.mockClear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("offers natural name order without changing the source, selection or keyboard focus", () => {
    const original = projects.map((project) => project.key)
    render()
    expect(order().value).toBe("default")
    expect(names()).toEqual(["Zulu", "App 10", "App 2", "Alpha"])
    const selected = container.querySelector("button.project-item.is-active")
    changeOrder("name")
    expect(names()).toEqual(["Alpha", "App 2", "App 10", "Zulu"])
    expect(projects.map((project) => project.key)).toEqual(original)
    expect(container.querySelector("button.project-item.is-active")).toBe(selected)
    expect(document.activeElement).toBe(order())
    expect(selectWorkspace).not.toHaveBeenCalled()
    expect(renameWorkspace).not.toHaveBeenCalled()
    changeOrder("default")
    expect(names()).toEqual(["Zulu", "App 10", "App 2", "Alpha"])
  })

  it.each(["ru", "en"] as const)(
    "labels the order choices and sorts Unicode names in %s",
    (lang) => {
      const workspaces = [
        { ...workspace, key: "three", name: "Якорь", path: "/c" },
        { ...workspace, key: "two", name: "Берёза", path: "/b" },
        { ...workspace, key: "one", name: "Азбука", path: "/a" },
      ]
      render({ lang, workspaces })
      expect(order().closest("label")?.querySelector("span")?.textContent).toBe(
        lang === "ru" ? "Порядок проектов" : "Project order",
      )
      expect([...order().options].map((option) => option.textContent)).toEqual(
        lang === "ru" ? ["По умолчанию", "По названию"] : ["Default", "Name"],
      )
      changeOrder("name")
      expect(names()).toEqual(["Азбука", "Берёза", "Якорь"])
    },
  )

  it("distinguishes equal names by path, keeps canonical spelling, and selects the exact key", () => {
    const workspaces = [
      { ...workspace, key: "b", name: "Cafe\u0301", path: "/projects/2" },
      { ...workspace, key: "a", name: "Café", path: "/projects/1" },
      { ...workspace, key: "A", name: "Café", path: "/projects/1" },
    ]
    render({ workspaces })
    changeOrder("name")
    expect(names()).toEqual(["Café", "Café", "Cafe\u0301"])
    act(() => rows()[0].click())
    expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith("A")
    selectWorkspace.mockClear()
    act(() => rows()[1].click())
    expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith("a")
    expect(workspaces[0].name).toBe("Cafe\u0301")
  })

  it.each(["collapsed", "autoHide"] as const)(
    "retains the same row order through %s mode and reveal",
    (mode) => {
      render()
      changeOrder("name")
      const ordered = rows()
      render({ mode })
      expect(order()).toBeNull()
      expect(rows()).toEqual(ordered)
      render({ mode: "expanded" })
      expect(order().value).toBe("name")
      expect(rows()).toEqual(ordered)
    },
  )

  it("updates sorted data without mutating it and restores the latest incoming order", () => {
    render()
    changeOrder("name")
    const next = [
      projects[1],
      { ...projects[0], name: "Aardvark" },
      { ...workspace, key: "new", name: "Beta" },
    ]
    render({ workspaces: next })
    expect(names()).toEqual(["Aardvark", "App 10", "Beta"])
    expect(next.map((project) => project.name)).toEqual(["App 10", "Aardvark", "Beta"])
    changeOrder("default")
    expect(names()).toEqual(["App 10", "Aardvark", "Beta"])
  })

  it("keeps a focused project DOM node and exact identity when a refresh changes its position", () => {
    render()
    changeOrder("name")
    const target = rows()[2]
    act(() => target.focus())
    render({
      workspaces: projects.map((item) => (item.key === "ten" ? { ...item, name: "A" } : item)),
    })
    expect(rows()[0]).toBe(target)
    expect(document.activeElement).toBe(target)
    expect(selectWorkspace).not.toHaveBeenCalled()
    act(() => target.click())
    expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith("ten")
  })

  it("preserves a rename editor and locks the order choice until editing finishes", () => {
    render()
    changeOrder("name")
    render({ renaming: "ten" })
    const input = container.querySelector<HTMLInputElement>(".project-rename")!
    expect(order().disabled).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe("Edited name")
    render({ renaming: "ten", workspaces: [...projects] })
    expect(container.querySelector(".project-rename")).toBe(input)
    expect(document.activeElement).toBe(input)
    render()
    expect(order().disabled).toBe(false)
    expect(order().value).toBe("name")
  })

  it("keeps empty and single-project lists usable, with no unnecessary sort choice", () => {
    render({ workspaces: [] })
    expect(rows()).toHaveLength(0)
    expect(order().disabled).toBe(true)
    render({ workspaces: [projects[0]] })
    expect(rows()).toHaveLength(1)
    expect(order().disabled).toBe(true)
    act(() => rows()[0].click())
    expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith("z")
  })
})

describe("ProjectRail superseded hover timers", () => {
  let container: HTMLDivElement
  let root: Root
  const changed = vi.fn()
  const render = (autoOpen: boolean, mode: "autoHide" | "expanded" | "collapsed" = "autoHide") => {
    act(() =>
      root.render(
        <>
          <button className="outside-rail">Outside rail</button>
          <ProjectRail
            autoHidePaused={false}
            autoOpen={autoOpen}
            mode={mode}
            modeSaving={false}
            workspaces={[workspace]}
            selectedWorkspace={workspace}
            sessionList={sessionList()}
            renamingWorkspaceKey={null}
            workspaceNameValue=""
            workspaceBusyKey={null}
            onAutoOpenChange={changed}
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
  const enter = () => {
    act(() =>
      container.querySelector(".project-rail")!.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: null,
        }),
      ),
    )
  }
  const leave = () => {
    act(() =>
      container.querySelector(".project-rail")!.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: container.querySelector(".outside-rail"),
        }),
      ),
    )
  }
  beforeEach(() => {
    vi.useFakeTimers()
    changed.mockClear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("keeps a newer controlled reopen after a pending pointer leave", () => {
    render(true)
    act(() => container.querySelector<HTMLButtonElement>(".outside-rail")!.focus())
    leave()
    render(false)
    render(true)
    act(() => vi.advanceTimersByTime(320))
    expect(changed).not.toHaveBeenCalled()
    expect(container.querySelector(".project-rail")!.classList.contains("is-revealed")).toBe(true)
  })

  it("keeps a newer controlled collapse after a pending pointer enter", () => {
    render(false)
    enter()
    render(true)
    render(false)
    act(() => vi.advanceTimersByTime(220))
    expect(changed).not.toHaveBeenCalled()
    expect(container.querySelector(".project-rail")!.classList.contains("is-compact")).toBe(true)
  })

  it.each(["expanded", "collapsed"] as const)(
    "discards pending pointer enter when mode changes to %s",
    (mode) => {
      render(false)
      enter()
      render(false, mode)
      act(() => vi.advanceTimersByTime(220))
      expect(changed).not.toHaveBeenCalled()
    },
  )

  it.each(["expanded", "collapsed"] as const)(
    "discards pending pointer leave when mode changes to %s",
    (mode) => {
      render(true)
      leave()
      render(true, mode)
      act(() => vi.advanceTimersByTime(320))
      expect(changed).not.toHaveBeenCalled()
    },
  )

  it("preserves ordinary hover delays without newer controlled state", () => {
    render(false)
    enter()
    act(() => vi.advanceTimersByTime(219))
    expect(changed).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(changed).toHaveBeenLastCalledWith(true)
    render(true)
    changed.mockClear()
    leave()
    act(() => vi.advanceTimersByTime(319))
    expect(changed).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(changed).toHaveBeenCalledExactlyOnceWith(false)
  })

  it("invalidates an already queued old callback without cancelling a newer timer", () => {
    const scheduled = vi.spyOn(window, "setTimeout")
    render(true)
    leave()
    const obsolete = scheduled.mock.calls.find(([, delay]) => delay === 320)![0]
    expect(typeof obsolete).toBe("function")
    render(false)
    render(true)
    leave()
    act(() => {
      if (typeof obsolete === "function") obsolete()
    })
    expect(changed).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(320))
    expect(changed).toHaveBeenCalledExactlyOnceWith(false)
  })

  it("clears a pending timer when unmounted", () => {
    render(false)
    enter()
    act(() => root.render(null))
    act(() => vi.advanceTimersByTime(220))
    expect(changed).not.toHaveBeenCalled()
  })
})
