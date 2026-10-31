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
