/** @vitest-environment jsdom */

import { act } from "react"
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

  it("exposes rename, remove, and inline rename submission", () => {
    const onStartRename = vi.fn()
    const onRemoveWorkspace = vi.fn()
    const onSubmitWorkspaceRename = vi.fn()
    const common = {
      autoOpen: false,
      mode: "expanded" as const,
      modeSaving: false,
      onAutoOpenChange: vi.fn(),
      onModeChange: vi.fn(),
      onOpenFolder: vi.fn(),
      onRemoveWorkspace,
      onSelectWorkspace: vi.fn(),
      onStartWorkspaceRename: onStartRename,
      onSubmitWorkspaceRename,
      onWorkspaceNameChange: vi.fn(),
      onWorkspaceRenameKeyDown: vi.fn(),
      selectedWorkspace: workspace,
      sessionList: sessionList(),
      workspaceBusyKey: null,
      workspaceNameValue: "Renamed App",
      workspaces: [workspace],
    }

    act(() => {
      root.render(<ProjectRail {...common} renamingWorkspaceKey={null} />)
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('button[title="Переименовать проект"]')?.click()
      container.querySelector<HTMLButtonElement>('button[title="Убрать проект из списка"]')?.click()
    })
    expect(onStartRename).toHaveBeenCalledWith(workspace)
    expect(onRemoveWorkspace).toHaveBeenCalledWith(workspace)

    act(() => {
      root.render(<ProjectRail {...common} renamingWorkspaceKey={workspace.key} />)
    })
    const input = container.querySelector<HTMLInputElement>(".project-rename")
    expect(input?.value).toBe("Renamed App")
    act(() => input?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    expect(onSubmitWorkspaceRename).toHaveBeenCalledWith(workspace)
  })
})
